const assert = require("node:assert/strict");
const { test } = require("node:test");
const { CalendarPluginLoader, readInstalledPlugin } =
    require("../files/chronos@geraldo-netto/calendarPluginLoader");
const { createCancellable } = require("./helpers/pluginCancellable");

const ID = "example.calendar";
const MANIFEST = { apiVersion: 1, id: ID, name: "Calendar", category: "custom",
    coverage: { from: 2026, through: 2027 }, source: { name: "Fixture" }, events: [] };

function pendingLoader() {
    const reads = [];
    const errors = [];
    const tokens = [];
    const loader = new CalendarPluginLoader({
        createCancellable() {
            const token = createCancellable();
            tokens.push(token);
            return token;
        },
        read(id, cancellable, done) { reads.push({ id, cancellable, done }); },
        report: error => errors.push(error)
    });
    return { loader, reads, errors, tokens };
}

test("each plugin generation owns one token and cancels before stale validation can run", () => {
    const { loader, reads, errors, tokens } = pendingLoader();
    loader.load([ID, "example.second"], () => assert.fail("obsolete callback"));
    assert.equal(reads[0].cancellable, reads[1].cancellable);
    tokens[0].cancel = () => {
        tokens[0].cancelled = true;
        reads[0].done(null);
        reads[1].done(null);
    };
    let result;
    loader.load([ID], rows => { result = rows; });
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0].is_cancelled(), true);
    assert.equal(tokens[1].is_cancelled(), false);
    assert.notEqual(tokens[0], tokens[1]);
    assert.deepEqual(errors, [], "synchronous cancellation callbacks must skip validation");
    reads[2].done(MANIFEST);
    assert.equal(result[0].id, ID);
    loader.destroy();
    assert.equal(tokens[1].is_cancelled(), true);
});

test("empty selections and destruction cancel pending loads without validation or delivery", () => {
    for (const stop of [loader => loader.load([], rows => assert.deepEqual(rows, [])),
        loader => loader.destroy()]) {
        const { loader, reads, errors, tokens } = pendingLoader();
        loader.load([ID], () => assert.fail("obsolete callback"));
        stop(loader);
        reads[0].done(null);
        assert.equal(tokens.length, 1, "an empty selection needs no new I/O token");
        assert.equal(tokens[0].is_cancelled(), true);
        assert.deepEqual(errors, []);
        loader.destroy();
        loader.load([ID], () => assert.fail("destroyed loader resumed"));
        assert.equal(reads.length, 1);
    }
});

test("a reader that retires its generation cannot start siblings or report late failures", () => {
    const errors = [];
    const reads = [];
    const loader = new CalendarPluginLoader({ createCancellable,
        read(id, cancellable, done) {
            reads.push(id);
            loader.destroy();
            done(null);
            throw new Error("Retired read failed");
        }, report: error => errors.push(error) });
    loader.load([ID, "example.second"], () => assert.fail("destroyed callback"));
    assert.deepEqual(reads, [ID]);
    assert.deepEqual(errors, []);
});

test("validation reports can retire a generation without delivering its result", () => {
    for (const stop of [loader => loader.destroy(), loader => loader.load([], () => {})]) {
        const loader = new CalendarPluginLoader({ createCancellable,
            read: (id, cancellable, done) => done(null), report: () => stop(loader) });
        loader.load([ID], () => assert.fail("validation retired this callback"));
    }
});

function schedule(state, phase, source, cancellable, done, value) {
    const result = { phase, cancellable, value };
    state.started.push({ phase, cancellable });
    state.pending.push({ phase, run: () => done(source, result) });
}

function finished(state, result) {
    state.finished.push(result.phase);
    if (state.cancelError && result.cancellable?.is_cancelled()) throw new Error("Operation cancelled");
    return result.value;
}

function stream(state) {
    let offset = 0;
    return {
        read_bytes_async(limit, priority, cancellable, done) {
            const chunk = state.bytes.subarray(offset, offset + limit);
            offset += chunk.length;
            schedule(state, chunk.length ? "chunk" : "eof", this, cancellable, done, {
                get_data() { state.extracted += chunk.length; return chunk; }
            });
        },
        read_bytes_finish: result => finished(state, result),
        close_async(priority, cancellable, done) {
            schedule(state, "close", this, cancellable, done, true);
        },
        close_finish: result => finished(state, result)
    };
}

function file(state, filePath) {
    const directory = !filePath.endsWith(".json");
    return {
        query_info_async(attributes, flags, priority, cancellable, done) {
            schedule(state, directory ? "directory" : "file", this, cancellable, done, {
                get_is_symlink: () => false, get_file_type: () => directory ? 2 : 1,
                get_size: () => state.bytes.length
            });
        },
        query_info_finish: result => finished(state, result),
        read_async(priority, cancellable, done) {
            schedule(state, "open", this, cancellable, done, null);
        },
        read_finish(result) {
            finished(state, result);
            state.acquired++;
            return stream(state);
        }
    };
}

function replaceGlobal(context, name, value) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    context.after(() => {
        if (previous) Object.defineProperty(globalThis, name, previous);
        else delete globalThis[name];
    });
    globalThis[name] = value;
}

function readFixture(context, cancelError) {
    const state = { cancelError, pending: [], started: [], finished: [], acquired: 0,
        extracted: 0, decodes: 0, errors: [], bytes: Buffer.from(JSON.stringify(MANIFEST)) };
    const Decoder = globalThis.TextDecoder;
    replaceGlobal(context, "TextDecoder", class extends Decoder {
        decode(bytes) { state.decodes++; return super.decode(bytes); }
    });
    replaceGlobal(context, "logError", error => state.errors.push(error));
    replaceGlobal(context, "imports", { gi: {
        GLib: { PRIORITY_DEFAULT: 0, get_user_data_dir: () => "/virtual",
            path_is_absolute: () => true, build_filenamev: parts => parts.join("/") },
        Gio: { FileType: { REGULAR: 1, DIRECTORY: 2 }, FileQueryInfoFlags: { NOFOLLOW_SYMLINKS: 1 },
            file_new_for_path: filePath => file(state, filePath) }
    } });
    return state;
}

function advance(state, phase) {
    assert.equal(state.pending[0]?.phase, phase);
    state.pending.shift().run();
}

function reach(state, phase) {
    for (let steps = 0; state.pending[0]?.phase !== phase && steps < 10; steps++) {
        advance(state, state.pending[0]?.phase);
    }
    assert.equal(state.pending[0]?.phase, phase);
}

function drain(state) {
    for (let steps = 0; state.pending.length && steps < 10; steps++) {
        advance(state, state.pending[0].phase);
    }
    assert.equal(state.pending.length, 0);
}

function assertTransportCleanup(state, token) {
    assert.deepEqual(state.finished, state.started.map(operation => operation.phase));
    const closes = state.started.filter(operation => operation.phase === "close");
    assert.equal(closes.length, state.acquired);
    assert.ok(closes.every(operation => operation.cancellable === null));
    assert.ok(state.started.filter(operation => operation.phase !== "close")
        .every(operation => operation.cancellable === token));
}

for (const phase of ["directory", "file", "open", "chunk", "eof", "close"]) {
    for (const cancelError of [false, true]) {
        test(`cancelled ${phase} callbacks finish and release streams (Gio error=${cancelError})`, context => {
            const state = readFixture(context, cancelError);
            const token = createCancellable();
            const answers = [];
            readInstalledPlugin(ID, token, raw => answers.push(raw));
            reach(state, phase);
            const extracted = state.extracted;
            const decodes = state.decodes;
            token.cancel();
            drain(state);
            assert.deepEqual(answers, [null]);
            assert.equal(state.extracted, extracted, "obsolete bytes are not extracted or decoded");
            assert.equal(state.decodes, decodes);
            assert.deepEqual(state.errors, [], "expected cancellation is silent");
            assertTransportCleanup(state, token);
        });
    }
}

test("a pre-cancelled direct read performs no I/O", context => {
    const state = readFixture(context, true);
    const token = createCancellable();
    token.cancel();
    const answers = [];
    readInstalledPlugin(ID, token, raw => answers.push(raw));
    assert.deepEqual(answers, [null]);
    assert.deepEqual(state.started, []);
});
