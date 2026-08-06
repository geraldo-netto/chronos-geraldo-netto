const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");
const { makeSoup3 } = require("./helpers/soup");

const appletDir = path.join(__dirname, "..", "files", "chronos@geraldo-netto");
const localeTextModulePath = path.join(appletDir, "localeText.js");
const localeQueryModulePath = path.join(appletDir, "localeQuery.js");
const dateFormatsModulePath = path.join(appletDir, "dateFormats.js");
// The locale state machine's caches, timers and consumer count are module-global
// by design, so a reload has to drop all three collaborating modules or a test
// inherits the last one's locale and translated date formats.
const localePartPaths = [
    localeTextModulePath,
    localeQueryModulePath,
    dateFormatsModulePath
];
const ioModulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "ioUtils.js");
const styleModulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "styleUtils.js");
const providerModulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "providerUtils.js");
const textModulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "textUtils.js");
const versionDir = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "6.0");

let originalImports;
let originalLog;
let originalLogError;
let subprocessFixture;

class LocaleCancellable {
    constructor() {
        this.cancelled = false;
        // the query in flight, so a test can check the teardown actually
        // cancels the subprocess
        this.constructor.last = this;
    }

    cancel() {
        this.cancelled = true;
    }
}

class LocaleSubprocess {
    constructor(options) {
        if (typeof subprocessFixture.spawnFails === "function") {
            subprocessFixture.spawnFails();
        }
        this.argv = options.argv;
    }

    init() {}

    force_exit() {
        this.forced = true;
    }

    communicate_utf8_async(_stdin, cancellable, callback) {
        this.constructor.last = this;
        this._cancellable = cancellable;
        // GJS still calls back when the cancellable is cancelled — finish()
        // below is what raises. A test cancels, then settles, to walk the path a
        // real teardown walks.
        this.constructor.settle = () => callback(this, "result");

        // a wedged NSS or nscd lookup: the callback never fires
        if (!subprocessFixture.neverAnswers) {
            callback(this, "result");
        }
    }

    communicate_utf8_finish() {
        if (this._cancellable && this._cancellable.cancelled) {
            throw new Error("Operation was cancelled");
        }
        const [ok, stdout] = subprocessFixture.spawn(this.argv.join(" "));
        if (!ok) {
            return [ok, null];
        }
        // the real communicate_utf8_finish answers with a decoded string, as
        // its name says; returning bytes here hid a TypeError that only ever
        // fired in Cinnamon
        return [ok, Buffer.from(stdout).toString("utf8")];
    }
}

function loadUtils(options = "") {
    for (const part of localePartPaths) {
        delete require.cache[require.resolve(part)];
    }
    delete require.cache[require.resolve(ioModulePath)];
    delete require.cache[require.resolve(styleModulePath)];
    delete require.cache[require.resolve(providerModulePath)];
    delete require.cache[require.resolve(textModulePath)];
    const spawnOutput = typeof options === "string" ? options : (options.spawnOutput || "");
    const spawnFails = typeof options === "object" ? options.spawnFails : null;
    const noSubprocess = typeof options === "object" && options.noSubprocess === true;
    const neverAnswers = typeof options === "object" && options.neverAnswers === true;
    // GJS hands back a string; the old byte-array behaviour is kept for the one
    // test that pins it
    const spawn = typeof options === "object" && options.spawn ?
        options.spawn :
        function(command) {
            assert.equal(command.startsWith("locale -k "), true);
            return [true, new Uint8Array(Buffer.from(spawnOutput)), new Uint8Array(0), 0];
        };
    subprocessFixture = { neverAnswers, spawn, spawnFails };

    global.imports = {
        gi: {
            Cinnamon: {
                get_file_contents_utf8_sync(filePath) {
                    return fs.readFileSync(filePath, "utf8");
                },
                write_string_to_stream(stream, data) {
                    stream.write(data);
                }
            },
            CinnamonDesktop: {
                WallClock: {
                    lctime_format(_domain, format) {
                        return `localized:${format}`;
                    }
                }
            },
            Gio: {
                FileCreateFlags: { NONE: 0, REPLACE_DESTINATION: 2 },
                FileQueryInfoFlags: { NONE: 0 },
                Cancellable: LocaleCancellable,
                BufferedOutputStream: {
                    new_sized(raw) {
                        return raw;
                    }
                },
                SubprocessFlags: { STDOUT_PIPE: 1 },
                // `locale -k` runs asynchronously; the double answers straight
                // away so the tests stay deterministic
                Subprocess: LocaleSubprocess
            },
            Soup: makeSoup3(),
            GLib: {
                get_language_names: () => ["C"],
                SpawnFlags: { SEARCH_PATH: 4 },
                PRIORITY_DEFAULT: 0,
                timeout_add_seconds: () => 1,
                source_remove: () => {}
            }
        },
        byteArray: {
            toString(data) {
                // decode as UTF-8 like GJS ByteArray, not Array.prototype.toString
                return Buffer.from(data).toString("utf8");
            }
        }
    };

    if (noSubprocess) {
        delete global.imports.gi.Gio.Subprocess;
    }

    return Object.assign(
        {},
        require(textModulePath),
        require(localeTextModulePath),
        require(localeQueryModulePath),
        require(dateFormatsModulePath),
        require(ioModulePath),
        require(styleModulePath),
        require(providerModulePath));
}

function randomHttpBytes(rand) {
    const bytes = Buffer.alloc(Math.floor(rand() * 48));
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(rand() * 256);
    }
    return bytes;
}

function truncatedWeatherBody(rand) {
    const whole = JSON.stringify({ current_weather: { temperature: 12 } });
    return Buffer.from(whole.slice(0, 1 + Math.floor(rand() * (whole.length - 1))));
}

function httpFuzzBodies(utils, rand) {
    return [
        () => Buffer.from(JSON.stringify({ ok: true, n: Math.floor(rand() * 1000) })),
        () => Buffer.from(JSON.stringify([1, 2, 3])),
        () => Buffer.from(JSON.stringify(Math.floor(rand() * 100))),
        () => Buffer.from("null"),
        () => Buffer.from('"a string"'),
        () => truncatedWeatherBody(rand),
        () => randomHttpBytes(rand),
        () => Buffer.alloc(0),
        () => Buffer.from('{"x":"' + "y".repeat(utils.MAX_RESPONSE_BYTES) + '"}')
    ];
}

function runHttpFuzzRound(utils, rand, bodies) {
    const body = bodies[Math.floor(rand() * bodies.length)]();
    const status = rand() < 0.25 ? [301, 404, 500, 503][Math.floor(rand() * 4)] : 200;
    const message = { get_status: () => status };
    global.imports.gi.Soup.Message.new = () => message;
    let calls = 0;
    let seen = "unset";

    assert.doesNotThrow(() => {
        const session = new (makeStreamingSoup({ chunks: [body] }).Session)();
        utils.httpGetJson(session, "https://example.test/fuzz?place=Lisbon", (data, msg) => {
            calls++;
            seen = { data, msg };
        });
    }, `body of ${body.length} bytes, status ${status}`);
    assert.equal(calls, 1, "the callback fires exactly once, whatever happened");
    assert.ok(seen.data === null || (typeof seen.data === "object" && seen.data !== null),
        `data must be an object or null, got ${typeof seen.data}`);
    if (status !== 200) {
        assert.equal(seen.data, null, "a failed request has no data");
    }
    if (body.length > utils.MAX_RESPONSE_BYTES) {
        assert.equal(seen.data, null, "an oversized body is never parsed");
    }
    return seen.data !== null;
}

function randomSanitizerUrl(rand, pick, schemes, hosts, paths, secret) {
    const encoded = rand() < 0.5 ? encodeURIComponent(secret) : secret;
    const query = rand() < 0.8 ? `?name=${encoded}&count=1` : "";
    const fragment = rand() < 0.3 ? `#${encoded}` : "";
    return {
        encoded,
        hasSecretSuffix: Boolean(query || fragment),
        url: `${pick(schemes)}://${pick(hosts)}${pick(paths)}${query}${fragment}`
    };
}

function assertSanitizedUrl(utils, url, encoded, hasSecretSuffix) {
    const logged = utils.urlForLog(url);
    assert.equal(typeof logged, "string");
    assert.doesNotMatch(logged, /[?#]/, "no query and no fragment survive");
    if (hasSecretSuffix) {
        assert.equal(logged.includes(encoded), false,
            `the location must not reach the log: ${url}`);
    }
    assert.ok(url.startsWith(logged), "what is kept is a prefix of the real URL");
}

function loadLocaleModules(options = "") {
    loadUtils(options);
    return Object.assign(
        {},
        require(localeTextModulePath),
        require(localeQueryModulePath),
        require(dateFormatsModulePath));
}

function loadIoUtils(options = "") {
    loadUtils(options);
    return require(ioModulePath);
}

function loadStyleUtils(options = "") {
    loadUtils(options);
    return require(styleModulePath);
}

function loadProviderUtils(options = "") {
    loadUtils(options);
    return require(providerModulePath);
}

function localeInfo(utils, env) {
    return utils.lazyLocaleValue(env, (info) => info)();
}

// The keys DEFAULT_LOCALE_INFO declares for LC_TIME are the only ones a payload
// can set, so the fuzz drives those two and buries them in everything locale(1)
// might emit around them - including the unquoted-empty values real output
// carries (era=, alt_digits=), which used to parse to NaN.
function randomLocalePayload(seed = 0x10ca1e, count = 20) {
    const lines = [];
    const expected = { abday: "Sun;Mon;Tue;Wed;Thu;Fri;Sat", first_workday: 2 };
    const rand = makeRandom(seed);
    const malformed = [
        "",
        "# comment",
        "missing_equals",
        "prefix abday=999",
        " first_workday=888",
        "key-with-dash=777",
        "era=",
        "alt_digits=",
        "trailing_key=12345"
    ];

    for (let i = 0; i < count; i++) {
        if (rand() < 0.35) {
            lines.push(malformed[Math.floor(rand() * malformed.length)]);
        }

        if (i % 2 === 0) {
            const value = Math.floor(rand() * 7);
            lines.push(`first_workday=${value}`);
            expected.first_workday = value;
        } else {
            const value = `day_${i}_${Math.floor(rand() * 0x1000000).toString(36)}_quote_'`;
            lines.push(`abday="${value}"`);
            expected.abday = value;
        }
    }

    lines.push("# trailing_key=12345");
    return { lines, expected };
}

beforeEach(() => {
    originalImports = global.imports;
    originalLog = global.log;
    originalLogError = global.logError;
    global.log = function() {};
    global.logError = function() {};
});

test("httpGetJson parses Soup 3 and reports HTTP failures", () => {
    const utils = loadIoUtils();
    let parsed = null;

    const okSoup = global.imports.gi.Soup;
    const okSession = new okSoup.Session();
    utils.httpGetJson(okSession, "https://example.test/ok", (data, message) => {
        parsed = { data, message };
    });

    assert.deepEqual(parsed, { data: { ok: true }, message: okSoup.messages[0] });

    let failed = "unset";
    Object.assign(global.imports.gi.Soup, makeSoup3({ data: '{"ok":true}', status: 500 }));
    const failedSoup = global.imports.gi.Soup;
    utils.httpGetJson(new failedSoup.Session(), "https://example.test/fail", (data, message) => {
        failed = { data, message };
    });

    assert.deepEqual(failed, { data: null, message: failedSoup.messages[0] });
});

// T600: Session:timeout is a per-read socket timeout, so an endpoint trickling
// one byte per interval kept a request in flight forever — and with it the
// process-wide Nominatim queue slot or a year's in-flight holiday entry. The
// deadline is the whole-request clock; firing it cancels the request so the
// ordinary failure path settles everyone waiting.
test("a request that trickles past the deadline is cancelled and settled", () => {
    const utils = loadIoUtils();
    let parkedRead = null;
    const soup = makeSoup3({
        onFinish: () => ({
            read_bytes_async(_count, _priority, cancellable, cb) {
                parkedRead = { cancellable, cb };
            }
        })
    });
    Object.assign(global.imports.gi.Soup, soup);

    let deadline = null;
    const removed = [];
    global.imports.gi.GLib.timeout_add_seconds = (_priority, seconds, cb) => {
        deadline = { seconds, cb };
        return 7;
    };
    global.imports.gi.GLib.source_remove = (id) => removed.push(id);

    let answered = "unset";
    utils.httpGetJson(new soup.Session(), "https://example.test/slow?city=Berlin", (data) => {
        answered = data;
    });

    assert.equal(answered, "unset", "the trickle keeps the request in flight");
    assert.equal(deadline.seconds, utils.HTTP_DEADLINE_SECONDS);

    assert.equal(deadline.cb(), false, "the deadline is one-shot");
    assert.equal(parkedRead.cancellable.cancelled, true, "and it cancels the request");

    // Gio completes a cancelled read with an error; the request settles as a failure
    parkedRead.cb({ read_bytes_finish: () => { throw new Error("Operation was cancelled"); } }, {});
    assert.equal(answered, null);
    assert.deepEqual(removed, [], "a fired deadline is spent, not removed again");
});

test("a request that completes disarms its deadline", () => {
    const utils = loadIoUtils();
    const removed = [];
    global.imports.gi.GLib.timeout_add_seconds = () => 9;
    global.imports.gi.GLib.source_remove = (id) => removed.push(id);

    let parsed = "unset";
    const soup = global.imports.gi.Soup;
    utils.httpGetJson(new soup.Session(), "https://example.test/ok", (data) => {
        parsed = data;
    });

    assert.deepEqual(parsed, { ok: true });
    assert.deepEqual(removed, [9], "the settled request released its timer");
});

// REGRESSION: the send was dispatched outside every try. A raise before the
// first byte — the four-argument signature on a libsoup 2.4 host, a session
// Cinnamon disposed mid-reload — left the deadline armed for its full 60 s
// holding the cancellable, and never called back at all, so every caller that
// reads "no answer yet" as "still in flight" waited for an answer that could
// never come.
test("a send that raises before it starts is reported, not left in flight", () => {
    const utils = loadIoUtils();
    const removed = [];
    const logged = [];
    global.imports.gi.GLib.timeout_add_seconds = () => 11;
    global.imports.gi.GLib.source_remove = (id) => removed.push(id);
    global.logError = (error) => logged.push(error);

    const boom = new Error("send_async: too few arguments");
    let settled = "unset";
    let calls = 0;
    utils.httpGetJson({
        send_async() {
            throw boom;
        }
    }, "https://example.test/raises", (data, message) => {
        calls++;
        settled = { data, message };
    });

    assert.equal(calls, 1, "the caller is answered exactly once");
    assert.equal(settled.data, null,
        "through the same null-data port as any other network failure");
    assert.equal(settled.message, global.imports.gi.Soup.messages[0]);
    assert.deepEqual(removed, [11],
        "and the deadline is disarmed rather than left holding the cancellable");
    assert.deepEqual(logged, [boom], "the raise itself is not swallowed");
});

// T580 defense in depth: readJsonFileAsync refuses a cache file past its cap,
// so writing one only parks bytes the next startup throws away — and the
// serialize itself was the amplification the flag bound exists to prevent.
test("a cache payload past the read cap is refused at write time", () => {
    const utils = loadIoUtils();
    const writes = [];
    const file = {
        replace_contents_async(...args) {
            writes.push(args);
        }
    };

    const done = [];
    utils.writeJsonFileAsync(file, { blob: "x".repeat(utils.MAX_CACHE_FILE_BYTES) },
        (stale) => done.push(stale));

    assert.deepEqual(writes, [], "nothing reaches the disk");
    assert.deepEqual(done, [false], "the caller sees a settled, non-stale write");
});

test("no deadline is armed when the platform offers no cancellable", () => {
    const utils = loadIoUtils();
    delete global.imports.gi.Gio.Cancellable;
    let armed = 0;
    global.imports.gi.GLib.timeout_add_seconds = () => {
        armed++;
        return 3;
    };

    let parsed = "unset";
    const soup = global.imports.gi.Soup;
    utils.httpGetJson(new soup.Session(), "https://example.test/ok", (data) => {
        parsed = data;
    });

    assert.deepEqual(parsed, { ok: true });
    assert.equal(armed, 0, "a deadline with nothing to cancel is dead weight");
});

// REGRESSION: communicate_utf8_finish() answers with a decoded string, as its
// name says, and the parser handed that to a TextDecoder — which throws
// "Provided input cannot be converted to ArrayBufferView". The throw was caught,
// so the applet just silently used English day names and a US work week forever.
// The test double had been returning bytes, which is the only reason no test saw
// it: it was a bug that existed exclusively in Cinnamon.
test("the locale output is parsed from communicate_utf8 text", () => {
    // deliberately NOT the English defaults: a parse that silently fails falls
    // back to those, and a test that asserts them cannot tell the difference
    const payload = 'abday="Dom;Seg;Ter;Qua;Qui;Sex;Sáb"\nfirst_workday=1\n';
    const expected = { abday: "Dom;Seg;Ter;Qua;Qui;Sex;Sáb", first_workday: 1 };

    const utils = loadLocaleModules({ spawnOutput: payload });
    assert.deepEqual(localeInfo(utils, "LC_TIME"), expected);
});

test("a locale query that never answers is abandoned instead of hanging", () => {
    const timeouts = [];
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    // `locale` wedges — a hung NSS or nscd lookup does this — so the callback
    // never fires. It is asked once and never retried, so without a deadline
    // the day names stay English for the life of the session.
    loadUtils();
    global.imports.gi.GLib.PRIORITY_DEFAULT = 0;
    global.imports.gi.GLib.timeout_add_seconds = (_priority, seconds, callback) => {
        timeouts.push({ seconds, callback });
        return timeouts.length;
    };
    global.imports.gi.Gio.Cancellable = class {
        constructor() {
            this.cancelled = false;
        }
        cancel() {
            this.cancelled = true;
        }
    };
    const reaped = [];
    global.imports.gi.Gio.Subprocess = class {
        constructor(options) {
            this.argv = options.argv;
        }
        init() {}
        communicate_utf8_async() {
            // no answer, ever
        }
        force_exit() {
            reaped.push(this);
        }
    };

    delete require.cache[require.resolve(localeQueryModulePath)];
    const localeQuery = require(localeQueryModulePath);

    const heard = [];
    localeQuery.onLocaleInfoChanged("LC_TIME", () => heard.push(true));
    localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)();

    assert.deepEqual(heard, [], "the hung query tells nobody anything");
    assert.equal(timeouts.length, 1, "but a deadline is armed");

    timeouts[0].callback();

    assert.equal(reaped.length, 1, "the wedged locale process is killed, not just abandoned");
    assert.match(logged.at(-1), /did not answer/);
    assert.deepEqual(heard, [true], "whatever waits on the locale is finally told");
    assert.equal(localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)(),
        "Sun;Mon;Tue;Wed;Thu;Fri;Sat",
        "and the applet falls back to the defaults rather than waiting forever");

    // ...and the session is not condemned to English day names because `locale`
    // was wedged for five seconds at login. The request flag used to be set
    // before the query and cleared on no failure path at all, so one hung lookup
    // degraded the applet permanently. A retry is armed instead.
    const retry = timeouts.at(-1);
    assert.equal(retry.seconds, 60, "a retry is armed, not just a deadline");

    // this time locale answers
    global.imports.gi.Gio.Subprocess = class {
        constructor(options) {
            this.argv = options.argv;
        }
        init() {}
        communicate_utf8_async(_stdin, _cancellable, callback) {
            callback(this, "result");
        }
        communicate_utf8_finish() {
            return [true, "abday=\"Dom;Seg;Ter;Qua;Qui;Sex;Sáb\"\n"];
        }
    };
    retry.callback();

    assert.equal(localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)(),
        "Dom;Seg;Ter;Qua;Qui;Sex;Sáb",
        "the locale that answers a minute later is the locale the applet uses");
});

// ...and a `locale` that is wedged for good must not be asked forever: storing
// the defaults wakes every memo that reads the locale, and each one asks again
test("a locale that never recovers is retried a few times and then left alone", () => {
    const timeouts = [];
    const spawns = [];
    global.logError = () => {};

    loadUtils();
    global.imports.gi.GLib.PRIORITY_DEFAULT = 0;
    global.imports.gi.GLib.timeout_add_seconds = (_priority, seconds, callback) => {
        timeouts.push({ seconds, callback });
        return timeouts.length;
    };
    global.imports.gi.Gio.Cancellable = class {
        cancel() {}
    };
    global.imports.gi.Gio.Subprocess = class {
        constructor(options) {
            spawns.push(options.argv.join(" "));
        }
        init() {}
        communicate_utf8_async() {
            // wedged, every time
        }
    };

    delete require.cache[require.resolve(localeQueryModulePath)];
    const localeQuery = require(localeQueryModulePath);
    localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)();

    // fire every deadline and every retry the module arms, until it stops arming
    for (let i = 0; i < timeouts.length && i < 20; i++) {
        timeouts[i].callback();
        localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)();
    }

    assert.equal(spawns.length, 3, "three attempts, then it stops asking");
    assert.ok(spawns.every((argv) => argv === "locale -k LC_TIME"));
});

// the guards that keep a failed lookup from spinning: a real answer is final, a
// degraded one waits for the armed retry, and the attempt cap is terminal
// the deadline fired and the subprocess answers anyway: whichever lands first is
// the answer, and the loser must not overwrite it or re-notify everyone
test("a locale answer that arrives after the deadline is dropped", () => {
    const timeouts = [];
    let deferred = null;
    global.logError = () => {};

    loadUtils();
    global.imports.gi.GLib.PRIORITY_DEFAULT = 0;
    global.imports.gi.GLib.timeout_add_seconds = (_priority, seconds, callback) => {
        timeouts.push({ seconds, callback });
        return timeouts.length;
    };
    global.imports.gi.Gio.Cancellable = class {
        cancel() {}
    };
    global.imports.gi.Gio.Subprocess = class {
        constructor(options) {
            this.argv = options.argv;
        }
        init() {}
        communicate_utf8_async(_stdin, _cancellable, callback) {
            deferred = () => callback(this, "result");
        }
        communicate_utf8_finish() {
            return [true, 'abday="Late;Late;Late;Late;Late;Late;Late"\n'];
        }
    };

    delete require.cache[require.resolve(localeQueryModulePath)];
    const localeQuery = require(localeQueryModulePath);

    const heard = [];
    localeQuery.onLocaleInfoChanged("LC_TIME", () => heard.push(true));
    localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)();

    // the deadline fires first: the defaults are stored
    timeouts[0].callback();
    assert.equal(heard.length, 1);

    // ...and the subprocess answers afterwards
    deferred();

    assert.equal(heard.length, 1, "the late answer does not wake everyone a second time");
    assert.equal(localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)(),
        "Sun;Mon;Tue;Wed;Thu;Fri;Sat",
        "and it does not overwrite the answer already given");
});

test("a settled locale query is not asked again", () => {
    const spawns = [];
    const utils = loadUtils({
        spawn(command) {
            spawns.push(command);
            return [true, new Uint8Array(Buffer.from('abday="A;B;C;D;E;F;G"\n')), new Uint8Array(0), 0];
        }
    });

    const abday = () => utils.lazyLocaleValue("LC_TIME", (info) => info.abday)();
    assert.equal(abday(), "A;B;C;D;E;F;G");

    // reading it again must not spawn `locale` a second time
    abday();
    utils.lazyLocaleValue("LC_TIME", (info) => info.first_workday)();
    assert.equal(spawns.length, 1, "a real answer is final");
});

test("a failing locale query falls back to the defaults instead of throwing", () => {
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    // the response cannot be read
    const broken = loadLocaleModules({
        spawn() {
            throw new Error("locale died");
        }
    });
    assert.deepEqual(localeInfo(broken, "LC_ADDRESS"), { country_ab3: "usa", lang_ab: "en" });

    // the subprocess cannot even be spawned
    const unspawnable = loadLocaleModules({
        spawnFails() {
            throw new Error("locale is not installed");
        }
    });
    assert.deepEqual(localeInfo(unspawnable, "LC_TIME"), {
        abday: "Sun;Mon;Tue;Wed;Thu;Fri;Sat",
        first_workday: 2
    });

    assert.equal(logged.length, 2);
});

test("an old Gio without Subprocess still yields the locale defaults", () => {
    const utils = loadLocaleModules({ noSubprocess: true });

    assert.deepEqual(localeInfo(utils, "LC_ADDRESS"), { country_ab3: "usa", lang_ab: "en" });
});

test("a locale query that answers with nothing falls back to the defaults", () => {
    const utils = loadLocaleModules({
        spawn() {
            return [false, null];
        }
    });

    assert.deepEqual(localeInfo(utils, "LC_TIME"), {
        abday: "Sun;Mon;Tue;Wed;Thu;Fri;Sat",
        first_workday: 2
    });
});

test("locale listeners are notified when the query lands, and can unsubscribe", () => {
    const utils = loadLocaleModules('first_workday=3\n');
    let notified = 0;
    const unsubscribe = utils.onLocaleInfoChanged("LC_TIME", () => notified++);

    // the value is picked before the query answers and recomputed after
    const workday = utils.lazyLocaleValue("LC_TIME", (info) => info.first_workday);
    assert.equal(workday(), 3);
    assert.equal(notified, 1);

    unsubscribe();
    loadLocaleModules('first_workday=1\n');
    assert.equal(notified, 1, "an unsubscribed listener stops hearing about it");
});

test("one failing locale listener cannot discard later listeners", () => {
    const localeQuery = loadLocaleModules('first_workday=3\n');
    const calls = [];
    const first = new Error("first locale listener failed");
    const logged = [];
    global.logError = (error) => logged.push(error);
    localeQuery.onLocaleInfoChanged("LC_TIME", () => {
        calls.push("first");
        throw first;
    });
    localeQuery.onLocaleInfoChanged("LC_TIME", () => calls.push("second"));

    assert.throws(() => localeQuery.getInfo("LC_TIME"), (error) => error === first);
    assert.deepEqual(calls, ["first", "second"]);
    assert.deepEqual(logged, [], "a consumer failure is not a locale-query failure");
    assert.equal(localeQuery.getInfo("LC_TIME").first_workday, 3,
        "the successful query remains settled");
});

test("a failing degraded-locale listener cannot prevent retry", () => {
    const localeQuery = loadLocaleModules({
        spawnFails() {
            throw new Error("locale spawn failed");
        }
    });
    const timers = [];
    global.imports.gi.GLib.timeout_add_seconds = (_priority, seconds, callback) => {
        timers.push({ seconds, callback });
        return timers.length;
    };
    const calls = [];
    localeQuery.onLocaleInfoChanged("LC_TIME", () => {
        calls.push("first");
        throw new Error("first locale listener failed");
    });
    localeQuery.onLocaleInfoChanged("LC_TIME", () => calls.push("second"));

    assert.throws(() => localeQuery.getInfo("LC_TIME"), /first locale listener failed/);
    assert.deepEqual(calls, ["first", "second"]);
    assert.equal(timers.at(-1).seconds, 60,
        "retry is secured before degraded listeners are notified");
});

test("a locale read dispatch failure has one settlement and no stale deadline", () => {
    loadUtils();
    const timers = [];
    global.imports.gi.GLib.timeout_add_seconds = (_priority, seconds, callback) => {
        timers.push({ seconds, callback });
        return timers.length;
    };
    let spawns = 0;
    global.imports.gi.Gio.Subprocess = class {
        constructor() { spawns++; }
        init() {}
        communicate_utf8_async() {
            throw new Error("locale read dispatch failed");
        }
    };
    delete require.cache[require.resolve(localeQueryModulePath)];
    const localeQuery = require(localeQueryModulePath);
    let notifications = 0;
    localeQuery.onLocaleInfoChanged("LC_TIME", () => notifications++);

    assert.equal(localeQuery.getInfo("LC_TIME").first_workday, 2);
    assert.deepEqual(timers.map((timer) => timer.seconds), [60],
        "only the retry is live; no deadline can fail the same attempt again");
    assert.equal(notifications, 1);

    global.imports.gi.Gio.Subprocess = class {
        constructor() { spawns++; }
        init() {}
        communicate_utf8_async(_stdin, _cancellable, callback) {
            callback(this, "result");
        }
        communicate_utf8_finish() {
            return [true, "first_workday=4\n"];
        }
    };
    timers[0].callback();

    assert.equal(spawns, 2, "the retry budget advances by one attempt, not two");
    assert.equal(notifications, 2);
    assert.equal(localeQuery.getInfo("LC_TIME").first_workday, 4);
});

test("httpGetJson refuses to parse an oversized response body", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    const huge = "x".repeat(utils.MAX_RESPONSE_BYTES + 1);
    Object.assign(global.imports.gi.Soup, makeSoup3({ data: huge }));
    const soup = global.imports.gi.Soup;

    let received = "unset";
    utils.httpGetJson(new soup.Session(), "https://example.test/huge?token=secret", (data) => {
        received = data;
    });

    assert.equal(received, null, "an oversized body must not be parsed");
    assert.equal(logged.length, 1);
    assert.match(logged[0], /exceeds/);
    assert.doesNotMatch(logged[0], /token=secret/, "the log must not carry the query string");
});

test("httpGetJson refuses a response that declares itself oversized, before reading it", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    // Soup buffers the whole body before handing it over, so a size check that
    // runs afterwards has already paid for the memory. The declared length is
    // what is available before the read.
    let read = false;
    const soupDouble = makeSoup3({
        messageMethods: {
            response_headers: {
                get_content_length: () => utils.MAX_RESPONSE_BYTES + 1,
                get_one: () => null
            }
        }
    });
    Object.assign(global.imports.gi.Soup, soupDouble);
    const soup = global.imports.gi.Soup;
    const realSendFinish = soup.Session.prototype.send_finish;
    soup.Session.prototype.send_finish = function(...args) {
        const stream = realSendFinish.apply(this, args);
        stream.read_bytes_async = () => {
            read = true;
        };
        return stream;
    };

    let received = "unset";
    utils.httpGetJson(new soup.Session(), "https://example.test/huge?city=Berlin", (data) => {
        received = data;
    });

    assert.equal(received, null);
    assert.equal(read, false, "the gigabyte is never pulled into the compositor");
    // T743: send_finish yields the stream that holds the connection, so it is
    // taken and released rather than skipped — skipping it left both the async
    // result and the connection unreclaimed.
    assert.deepEqual(soupDouble.streams.map((stream) => stream.closed), [1]);
    assert.match(logged[0], /declares more than/);
    assert.doesNotMatch(logged[0], /Berlin/, "and the location stays out of the log");
});

// A Soup 3 double that streams: send_async yields an input stream, and the
// stream hands back the chunks one read at a time, then an empty buffer for EOF.
// This is the path a real Soup takes, and the only one that can cap a chunked
// body — one with no Content-Length for _declaredTooLarge to see.
function makeStreamingSoup({ chunks = [], status = 200, contentLength = null,
    onRead = () => {} } = {}) {
    // every stream the double hands out, so a test can ask whether the
    // connection behind it was released
    const streams = [];
    return {
        streams,
        MAJOR_VERSION: 3,
        MessagePriority: { NORMAL: 0 },
        Message: {
            new(method, url) {
                return {
                    method,
                    url,
                    request_headers: { append() {} },
                    response_headers: {
                        get_content_length: () => contentLength,
                        get_one: () => null
                    },
                    get_status() {
                        return status;
                    },
                    connect() {}
                };
            }
        },
        Session: class {
            send_async(_message, _priority, _cancellable, callback) {
                callback(this, {});
            }
            send_finish() {
                let index = 0;
                const stream = {
                    closed: 0,
                    read_bytes_async(_count, _priority, _cancellable, callback) {
                        onRead(_count);
                        callback(this, {});
                    },
                    read_bytes_finish() {
                        const chunk = index < chunks.length ? chunks[index] : Buffer.alloc(0);
                        index++;
                        return { get_data: () => chunk };
                    },
                    close() {
                        stream.closed++;
                    }
                };
                streams.push(stream);
                return stream;
            }
        }
    };
}

test("httpGetJson streams a body in chunks and parses it", () => {
    const utils = loadIoUtils();
    global.logError = () => {};
    const readSizes = [];

    // one JSON payload split across two reads, then EOF
    Object.assign(global.imports.gi.Soup, makeStreamingSoup({
        chunks: [Buffer.from('{"ci'), Buffer.from('ty":"Rome"}')],
        onRead: (size) => readSizes.push(size)
    }));
    const soup = global.imports.gi.Soup;

    let received = "unset";
    utils.httpGetJson(new soup.Session(), "https://example.test/x", (data) => {
        received = data;
    });

    assert.deepEqual(received, { city: "Rome" });
    assert.deepEqual(readSizes, [64 * 1024, 64 * 1024, 64 * 1024],
        "streaming keeps the shipped chunk size instead of degrading to tiny reads");
});

test("httpGetJson aborts a streamed body once it passes the cap", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    let cancelled = false;
    global.imports.gi.Gio.Cancellable = class {
        cancel() {
            cancelled = true;
        }
    };
    // no Content-Length: this is exactly the chunked case _declaredTooLarge
    // cannot see, so the cap has to fire during the read
    Object.assign(global.imports.gi.Soup, makeStreamingSoup({
        chunks: [Buffer.alloc(utils.MAX_RESPONSE_BYTES + 1)]
    }));
    const soup = global.imports.gi.Soup;

    let received = "unset";
    utils.httpGetJson(new soup.Session(), "https://example.test/flood?token=secret", (data) => {
        received = data;
    });

    assert.equal(received, null, "an oversized streamed body must not be parsed");
    assert.equal(cancelled, true, "and the read is aborted, not drained");
    assert.match(logged[0], /exceeds/);
    assert.doesNotMatch(logged[0], /token=secret/);
});

test("httpGetJson refuses a streamed response that declares itself oversized", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    let reads = 0;
    const soupDouble = makeStreamingSoup({
        contentLength: utils.MAX_RESPONSE_BYTES + 1,
        onRead: () => reads++
    });
    Object.assign(global.imports.gi.Soup, soupDouble);
    const soup = global.imports.gi.Soup;

    let received = "unset";
    utils.httpGetJson(new soup.Session(), "https://example.test/huge?city=Berlin", (data) => {
        received = data;
    });

    assert.equal(received, null);
    assert.equal(reads, 0, "the declared length is refused before any read");
    // T743: the refusal used to happen *before* send_finish, so neither the
    // async result nor the connection behind it was ever reclaimed. The stream
    // is taken and immediately released; send_finish does not read the body,
    // so refusing still costs nothing but the headers.
    assert.deepEqual(soupDouble.streams.map((stream) => stream.closed), [1],
        "and the connection it would have used is released, not stranded");
    assert.match(logged[0], /declares more than/);
});

// T743: libsoup holds the connection until the body stream is closed, and GJS
// closes it only on finalization — which a compositor process does not reach
// promptly. Every exit from the capped read releases it: a body that finished,
// one that outgrew the cap, and one that errored mid-read.
test("httpGetJson releases the response stream however the read ends", () => {
    const utils = loadIoUtils();
    global.logError = () => {};

    const finished = makeStreamingSoup({ chunks: [Buffer.from('{"ok":true}')] });
    Object.assign(global.imports.gi.Soup, finished);
    utils.httpGetJson(new global.imports.gi.Soup.Session(),
        "https://example.test/x", () => {});
    assert.deepEqual(finished.streams.map((stream) => stream.closed), [1],
        "a body read to EOF releases its connection");

    const oversized = makeStreamingSoup({
        chunks: [Buffer.alloc(utils.MAX_RESPONSE_BYTES + 1, 0x61)]
    });
    Object.assign(global.imports.gi.Soup, oversized);
    utils.httpGetJson(new global.imports.gi.Soup.Session(),
        "https://example.test/x", () => {});
    assert.deepEqual(oversized.streams.map((stream) => stream.closed), [1],
        "so does one abandoned at the cap");

    const broken = makeStreamingSoup({});
    Object.assign(global.imports.gi.Soup, broken);
    const realSendFinish = broken.Session.prototype.send_finish;
    broken.Session.prototype.send_finish = function(...args) {
        const stream = realSendFinish.apply(this, args);
        stream.read_bytes_finish = () => {
            throw new Error("read reset");
        };
        return stream;
    };
    utils.httpGetJson(new global.imports.gi.Soup.Session(),
        "https://example.test/x", () => {});
    assert.deepEqual(broken.streams.map((stream) => stream.closed), [1],
        "and so does one that errored mid-read");
});

// close() is Gio's, so it can raise; a failure is reported rather than thrown
// back into the read callback, where it would look like a transport error.
test("a response stream that refuses to close is reported, not rethrown", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    const soupDouble = makeStreamingSoup({ chunks: [Buffer.from('{"ok":true}')] });
    const realSendFinish = soupDouble.Session.prototype.send_finish;
    soupDouble.Session.prototype.send_finish = function(...args) {
        const stream = realSendFinish.apply(this, args);
        stream.close = () => {
            throw new Error("stream close failed");
        };
        return stream;
    };
    Object.assign(global.imports.gi.Soup, soupDouble);

    let received = "unset";
    utils.httpGetJson(new global.imports.gi.Soup.Session(),
        "https://example.test/x", (data) => {
            received = data;
        });

    assert.deepEqual(received, { ok: true }, "the body still reaches the caller");
    assert.ok(logged.some((line) => /stream close failed/.test(line)));
});

// a Soup old enough to hand back a stream with no close() must still work
test("a response stream with no close() is not an error", () => {
    const utils = loadIoUtils();
    global.logError = (message) => assert.fail(`unexpected log: ${message}`);

    const soupDouble = makeStreamingSoup({ chunks: [Buffer.from('{"ok":true}')] });
    const realSendFinish = soupDouble.Session.prototype.send_finish;
    soupDouble.Session.prototype.send_finish = function(...args) {
        const stream = realSendFinish.apply(this, args);
        delete stream.close;
        return stream;
    };
    Object.assign(global.imports.gi.Soup, soupDouble);

    let received = "unset";
    utils.httpGetJson(new global.imports.gi.Soup.Session(),
        "https://example.test/x", (data) => {
            received = data;
        });

    assert.deepEqual(received, { ok: true });
});

test("httpGetJson reports a stream that fails to open", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    const soupDouble = makeStreamingSoup({});
    soupDouble.Session.prototype.send_finish = function() {
        throw new Error("connection reset");
    };
    Object.assign(global.imports.gi.Soup, soupDouble);
    const soup = global.imports.gi.Soup;

    let received = "unset";
    utils.httpGetJson(new soup.Session(), "https://example.test/x", (data) => {
        received = data;
    });

    assert.equal(received, null);
    assert.match(logged[0], /connection reset/);
});

test("httpGetJson aborts a stream that fails while reading", () => {
    const utils = loadIoUtils();
    const error = new Error("read reset");
    const logged = [];
    global.logError = (message) => logged.push(message);

    const soupDouble = makeStreamingSoup({});
    soupDouble.Session.prototype.send_finish = function() {
        return {
            read_bytes_async(_count, _priority, _cancellable, callback) {
                callback(this, {});
            },
            read_bytes_finish() {
                throw error;
            }
        };
    };
    Object.assign(global.imports.gi.Soup, soupDouble);

    let received = "unset";
    utils.httpGetJson(new soupDouble.Session(), "https://example.test/x", (data) => {
        received = data;
    });

    assert.equal(received, null);
    assert.equal(global.imports.gi.Gio.Cancellable.last.cancelled, true);
    assert.deepEqual(logged, [error]);
});

test("httpGetJson settles when a streamed read fails to dispatch", () => {
    const utils = loadIoUtils();
    const error = new Error("read dispatch failed");
    const logged = [];
    global.logError = (message) => logged.push(message);

    for (const failAtRead of [1, 2]) {
        let reads = 0;
        let closes = 0;
        const soupDouble = makeStreamingSoup({
            chunks: [Buffer.from('{"ok":true}')]
        });
        soupDouble.Session.prototype.send_finish = function() {
            const stream = {
                read_bytes_async(_count, _priority, _cancellable, callback) {
                    reads++;
                    if (reads === failAtRead) {
                        throw error;
                    }
                    callback(this, {});
                },
                read_bytes_finish() {
                    return { get_data: () => Buffer.from('{"ok":true}') };
                },
                close() {
                    closes++;
                }
            };
            return stream;
        };
        Object.assign(global.imports.gi.Soup, soupDouble);

        let calls = 0;
        utils.httpGetJson(new soupDouble.Session(), "https://example.test/x", (data) => {
            calls++;
            assert.equal(data, null);
        });

        assert.equal(calls, 1, `read ${failAtRead} settles once`);
        assert.equal(closes, 1, `read ${failAtRead} releases the stream`);
        assert.equal(global.imports.gi.Gio.Cancellable.last.cancelled, true,
            `read ${failAtRead} cancels the request`);
    }

    assert.deepEqual(logged, [error, error]);
});

test("httpGetJson will not follow a redirect down to plain http", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    // the query string carries the user's location, so a downgrade puts it on
    // the wire in cleartext; "restarted" fires before the redirected request
    // goes out
    let restarted = null;
    Object.assign(global.imports.gi.Soup, makeSoup3({
        messageMethods: {
            connect(signal, handler) {
                if (signal === "restarted") {
                    restarted = handler;
                }
            },
            get_uri() {
                return { get_scheme: () => "http" };
            }
        }
    }));
    const soup = global.imports.gi.Soup;

    let cancellable = null;
    const session = new soup.Session();
    session.send_async = function(_message, _priority, cancel, callback) {
        cancellable = cancel;
        restarted();                       // the endpoint redirects us to http
        callback(this, {});
    };

    let received = "unset";
    utils.httpGetJson(session, "https://example.test/geo?city=Berlin", (data) => {
        received = data;
    });

    assert.ok(cancellable && cancellable.cancelled, "the redirected request is cancelled");
    assert.equal(received, null);
    assert.match(logged[0], /plain http/);
    assert.doesNotMatch(logged[0], /Berlin/);
});

test("httpGetJson invokes a throwing callback exactly once", () => {
    const utils = loadIoUtils();
    const failedMessage = {
        get_status() {
            return 500;
        }
    };
    global.imports.gi.Soup.Message.new = function() {
        return failedMessage;
    };

    // a consumer error must escape instead of being logged as a network
    // failure, and must not re-run the callback with data = null
    let calls = 0;
    assert.throws(() => {
        const session = new (makeStreamingSoup({
            chunks: [Buffer.from('{"ok":true}')]
        }).Session)();
        utils.httpGetJson(session, "https://example.test/fail", () => {
            calls++;
            throw new Error("consumer exploded");
        });
    }, /consumer exploded/);

    assert.equal(calls, 1);
});

test("httpGetJson settles when Soup cannot construct a message", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (error) => logged.push(String(error.message || error));
    let sends = 0;

    for (const constructionFailure of [
        () => null,
        () => {
            throw new Error("URI contains Private Place");
        }
    ]) {
        global.imports.gi.Soup.Message.new = constructionFailure;
        let calls = 0;
        utils.httpGetJson({
            send_async() {
                sends++;
            }
        }, "https://example.test/geocode?name=Private%20Place", (data, message) => {
            calls++;
            assert.equal(data, null);
            assert.equal(message, null);
        });
        assert.equal(calls, 1);
    }

    assert.equal(sends, 0);
    assert.equal(logged.length, 2);
    assert.ok(logged.every((message) =>
        message === "could not construct HTTP request for https://example.test/geocode"));

    global.imports.gi.Soup.Message.new = () => null;
    let throwingCalls = 0;
    assert.throws(() => {
        utils.httpGetJson({}, "https://example.test/geocode", () => {
            throwingCalls++;
            throw new Error("consumer exploded during construction failure");
        });
    }, /consumer exploded during construction failure/);
    assert.equal(throwingCalls, 1);
});

test("httpGetJson applies request headers when provided", () => {
    const utils = loadIoUtils();
    const recorded = [];
    global.imports.gi.Soup.Message.new = function() {
        return {
            request_headers: {
                append(header, value) {
                    recorded.push([header, value]);
                }
            },
            get_status() {
                return 200;
            }
        };
    };

    utils.httpGetJson(new (makeStreamingSoup({
        chunks: [Buffer.from("{}")]
    }).Session)(), "https://example.test/ua", () => {}, {
        headers: { "User-Agent": "test-agent" }
    });

    assert.deepEqual(recorded, [["User-Agent", "test-agent"]]);

    // no options: nothing recorded, nothing thrown
    utils.httpGetJson(new (makeStreamingSoup({
        chunks: [Buffer.from("{}")]
    }).Session)(), "https://example.test/plain", () => {});
    assert.equal(recorded.length, 1);

    global.imports.gi.Soup.Message.new = function() {
        return { get_status: () => 200 };
    };
    utils.httpGetJson(new (makeStreamingSoup({
        chunks: [Buffer.from("{}")]
    }).Session)(), "https://example.test/no-headers", () => {}, {
        headers: { "User-Agent": "test-agent" }
    });
    assert.equal(recorded.length, 1);
});

test("httpGetJson reports malformed JSON as null data", () => {
    const utils = loadIoUtils();
    const okMessage = {
        get_status() {
            return 200;
        }
    };
    global.imports.gi.Soup.Message.new = function() {
        return okMessage;
    };

    let malformed = "unset";
    utils.httpGetJson(new (makeStreamingSoup({
        chunks: [Buffer.from("not json")]
    }).Session)(), "https://example.test/malformed", (data, message) => {
        malformed = { data, message };
    });

    assert.equal(malformed.data, null);
    assert.equal(malformed.message, okMessage);
});

// The old version of this appended "{" as the *last* byte of every payload, so
// all 120 rounds were guaranteed-invalid JSON and landed on the identical
// JSON.parse-throws branch: replacing `data = JSON.parse(...)` with `data = null`
// passed it 120/120. It never explored the size cap, a non-200 status, or a body
// that parses to something that is not an object — the paths that actually
// matter here.
test("fuzz: httpGetJson answers with a parsed object or null, and never throws", () => {
    const utils = loadIoUtils();
    const rand = makeRandom(0xdec0de);

    const bodies = httpFuzzBodies(utils, rand);
    let parsedObjects = 0;
    let refused = 0;

    for (let round = 0; round < 240; round++) {
        const parsed = runHttpFuzzRound(utils, rand, bodies);
        parsedObjects += Number(parsed);
        refused += Number(!parsed);
    }

    // a fuzz that only ever explored one branch would satisfy every assertion
    // above and prove nothing
    assert.ok(parsedObjects > 0, "some rounds must have parsed a real payload");
    assert.ok(refused > 0, "and some must have been refused");
});

test("createHttpSession owns Soup session timeout setup", () => {
    const utils = loadIoUtils();
    const session = utils.createHttpSession({ timeout: 30, idleTimeout: 15 });

    assert.equal(session.timeout, 30);
    assert.equal(session.idle_timeout, 15);

    const defaults = utils.createHttpSession();
    assert.equal(defaults.timeout, 0);
    assert.equal(defaults.idle_timeout, 0);

    const timeoutOnly = utils.createHttpSession({ timeout: 5 });
    assert.equal(timeoutOnly.timeout, 5);
    assert.equal(timeoutOnly.idle_timeout, 0);
});

test("aborting a lazy HTTP session releases the transport", () => {
    const utils = loadIoUtils();
    let creations = 0;
    const lazy = new utils.LazyHttpSession(() => ({
        generation: ++creations,
        abort() {
            this.aborted = true;
        }
    }));

    lazy.abort();
    assert.equal(lazy.created, null, "aborting before first use remains free");

    const first = lazy.get();
    lazy.abort();
    assert.equal(first.aborted, true);
    assert.equal(lazy.created, null, "the aborted Soup graph is no longer retained");
    assert.notEqual(lazy.get(), first, "a later owner can lazily create a fresh session");

    const throwing = new utils.LazyHttpSession(() => ({
        abort() {
            throw new Error("abort failed");
        }
    }));
    throwing.get();
    assert.throws(() => throwing.abort(), /abort failed/);
    assert.equal(throwing.created, null, "release precedes a transport abort failure");
});

afterEach(() => {
    global.imports = originalImports;
    global.log = originalLog;
    global.logError = originalLogError;
});

test("lazy locale values parse quoted strings and numeric locale values", () => {
    const utils = loadLocaleModules([
        'abday="Sun;Mon;Tue"',
        "first_workday=2",
        "malformed",
        'country_ab3="USA"'
    ].join("\n"));

    // country_ab3 is LC_ADDRESS's key, not LC_TIME's: it is not in the schema
    // this category declares, so it is not stored under it
    assert.deepEqual(localeInfo(utils, "LC_TIME"), {
        abday: "Sun;Mon;Tue",
        first_workday: 2
    });
});

// T808: whether a key was a string or a number was decided by whether locale(1)
// happened to quote it. Real output carries unquoted-empty values - era= and
// alt_digits= - which parseInt turned into NaN. Nothing consumes those two, but
// the two that ARE consumed had the same unenforced contract in both
// directions: 6.0/calendar.js does info.abday.split(";"), which throws inside a
// lazyLocaleValue memo on the compositor thread, and (info.first_workday + 6) %
// 7, which is NaN - silently marking every day a workday.
test("a locale value that will not parse to its declared type keeps the default", () => {
    const defaults = { abday: "Sun;Mon;Tue;Wed;Thu;Fri;Sat", first_workday: 2 };

    // libc emits the string key unquoted-empty, and the numeric key quoted or
    // as a word: neither replaces what the applet already knows
    assert.deepEqual(localeInfo(loadLocaleModules([
        "abday=",
        "first_workday=",
        "era=",
        "alt_digits="
    ].join("\n")), "LC_TIME"), defaults);
    assert.deepEqual(localeInfo(loadLocaleModules(
        'first_workday="Monday"'), "LC_TIME"), defaults);
    assert.deepEqual(localeInfo(loadLocaleModules(
        "first_workday=1.5"), "LC_TIME"), defaults);

    // ...and the forms that do parse are taken, quoted or not, including zero
    assert.equal(localeInfo(loadLocaleModules("first_workday=0"), "LC_TIME")
        .first_workday, 0);
    assert.equal(localeInfo(loadLocaleModules('first_workday="4"'), "LC_TIME")
        .first_workday, 4);
    assert.equal(localeInfo(loadLocaleModules("abday=Sun;Mon"), "LC_TIME")
        .abday, "Sun;Mon");
});

test("lazy locale values decode locale output through ByteArray when TextDecoder is absent", () => {
    const originalTextDecoder = global.TextDecoder;
    global.TextDecoder = undefined;
    const Utils = loadLocaleModules('abday="Dom;Lun"\nfirst_workday=1\n');
    const info = localeInfo(Utils, "LC_TIME");
    global.TextDecoder = originalTextDecoder;

    assert.equal(info.abday, "Dom;Lun");
    assert.equal(info.first_workday, 1);
});

test("lazy locale values cache locale values by category", () => {
    let calls = 0;
    const utils = loadLocaleModules({
        spawn(command) {
            calls++;
            if (command.endsWith("LC_ADDRESS")) {
                return [true, Buffer.from('country_ab3="ITA"\n'), Buffer.alloc(0), 0];
            }

            return [true, Buffer.from('first_workday=3\n'), Buffer.alloc(0), 0];
        }
    });

    assert.equal(localeInfo(utils, "LC_ADDRESS").country_ab3, "ITA");
    assert.equal(localeInfo(utils, "LC_ADDRESS").country_ab3, "ITA");
    assert.equal(calls, 1);

    assert.equal(localeInfo(utils, "LC_TIME").first_workday, 3);
    assert.equal(calls, 2);
});

test("lazy locale values return defaults for missing keys and spawn failures", () => {
    const partial = loadLocaleModules('country_ab3="FRA"\n');

    assert.deepEqual(localeInfo(partial, "LC_ADDRESS"), {
        country_ab3: "FRA",
        lang_ab: "en"
    });

    const failed = loadLocaleModules({
        spawn() {
            return [false, Buffer.alloc(0), Buffer.from("locale missing"), 1];
        }
    });

    assert.deepEqual(localeInfo(failed, "LC_ADDRESS"), {
        country_ab3: "usa",
        lang_ab: "en"
    });
    assert.deepEqual(localeInfo(failed, "LC_TIME"), {
        abday: "Sun;Mon;Tue;Wed;Thu;Fri;Sat",
        first_workday: 2
    });
});

test("exports localized date format constants", () => {
    const utils = loadLocaleModules();

    assert.equal(utils.DAY_FORMAT, "localized:%A");
    assert.equal(utils.DATE_FORMAT_SHORT, "localized:%B %-e, %Y");
    assert.equal(utils.DATE_FORMAT_FULL, "localized:%A, %B %-e, %Y");
});

test("translatePlural falls back without gettext plural support", () => {
    const utils = loadLocaleModules();

    assert.equal(utils.translatePlural("one", "many", 1), "one");
    assert.equal(utils.translatePlural("one", "many", 2), "many");
});

test("lazy locale values fuzz mixed locale key/value payloads", () => {
    for (let round = 0; round < 20; round++) {
        const payload = randomLocalePayload(0x10ca1e + round * 997, 24);
        const utils = loadLocaleModules(payload.lines.join("\n"));
        const info = localeInfo(utils, "LC_TIME");

        // T808: the declared keys take the last well-typed value, and every
        // other key the payload carries is dropped rather than stored
        assert.deepEqual(info, payload.expected, `round ${round}`);
    }
});

// The network body is capped because it is parsed on the compositor thread. The
// cache file is parsed on the same thread, by the same JSON.parse, and it is
// writable by anything running as the user — and it had no bound at all.
//
// This used to hand readJsonFileAsync a double with no load_contents_async, so
// it took the sync fallback and the cap on the async path — the only path that
// runs in the applet — was asserted by nothing. Dropping the bound from it kept
// the suite green.
// T726: the cap ran inside _parseCacheFile, i.e. after load_contents_async had
// already put the whole file in the compositor's address space — so a
// multi-gigabyte cache file OOM'd or stalled the shell instead of being
// refused. The size is asked for first now, and the parse-time check is the
// backstop for a file that grew between the two calls.
test("an oversized cache file is refused before it is read", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    let loads = 0;
    const file = {
        query_info_async(attributes, _flags, _priority, _cancellable, callback) {
            assert.equal(attributes, "standard::size");
            callback(this, {});
        },
        query_info_finish() {
            return { get_size: () => utils.MAX_CACHE_FILE_BYTES + 1 };
        },
        load_contents_async(_cancellable, callback) {
            loads++;
            callback(this, {});
        },
        load_contents_finish() {
            throw new Error("the file must never be read");
        }
    };

    let received = "unset";
    utils.readJsonFileAsync(file, (data) => {
        received = data;
    });

    assert.deepEqual(received, {}, "a cache file past the cap must not be parsed");
    assert.equal(loads, 0, "and not a byte of it is buffered first");
    assert.ok(logged.some((line) => /past the .* cap/.test(line)),
        "and it says so, rather than silently reading as empty");
});

test("a cache file that grows past the cap after the stat is still refused", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    const oversized = JSON.stringify({ padding: "x".repeat(utils.MAX_CACHE_FILE_BYTES) });
    const file = {
        query_info_async(_attributes, _flags, _priority, _cancellable, callback) {
            callback(this, {});
        },
        // small when asked, oversized when read
        query_info_finish() {
            return { get_size: () => 12 };
        },
        load_contents_async(_cancellable, callback) {
            callback(this, {});
        },
        load_contents_finish() {
            return [true, Buffer.from(oversized, "utf8"), "etag-1"];
        }
    };

    let received = "unset";
    utils.readJsonFileAsync(file, (data) => {
        received = data;
    });

    assert.deepEqual(received, {}, "the parse-time backstop still refuses it");
    assert.ok(logged.some((line) => /past the .* cap/.test(line)));
});

test("a cache file whose size cannot be read is refused rather than guessed", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    let loads = 0;
    const file = {
        query_info_async(_attributes, _flags, _priority, _cancellable, callback) {
            callback(this, {});
        },
        query_info_finish() {
            throw new Error("stat failed");
        },
        load_contents_async(_cancellable, callback) {
            loads++;
            callback(this, {});
        },
        load_contents_finish() {
            return [true, Buffer.from("{}", "utf8"), null];
        }
    };

    let received = "unset";
    utils.readJsonFileAsync(file, (data) => {
        received = data;
    });

    assert.deepEqual(received, {}, "an unknown size is not an implicit permission");
    assert.equal(loads, 0);
    assert.ok(logged.some((line) => /stat failed/.test(line)));
});

test("a cache file with no async stat at all is refused, not read", () => {
    const utils = loadIoUtils();
    global.logError = () => {};
    let received = "unset";

    utils.readJsonFileAsync({}, (data) => {
        received = data;
    });

    assert.deepEqual(received, {});
});

// T744: the async stat T726 added was preceded by a blocking query_exists(null)
// — a synchronous stat on the compositor thread, in the function whose own
// header says the read is asynchronous so the shell stays responsive. The async
// stat already answers "is it there", so nothing needs the sync one; what it
// was actually load-bearing for was keeping the ordinary first run, where no
// cache has ever been written, off the error log.
test("the cache read never stats the file synchronously", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    let loads = 0;
    let received = "unset";
    utils.readJsonFileAsync({
        query_exists() {
            throw new Error("readJsonFileAsync must not block the compositor on a stat");
        },
        query_info_async(_attributes, _flags, _priority, _cancellable, callback) {
            callback(this, {});
        },
        query_info_finish() {
            // what Gio raises for a cache that has never been written
            throw new Error("Error opening file /cache/holidays.json: No such file or directory");
        },
        load_contents_async(_cancellable, callback) {
            loads++;
            callback(this, {});
        }
    }, (data) => {
        received = data;
    });

    assert.deepEqual(received, {}, "a missing cache reads as no cache");
    assert.equal(loads, 0, "and is never opened");
    assert.deepEqual(logged, [],
        "a cache that has never been written is not a fault worth logging");
});

// ...but a stat that fails for any other reason still is: reading it as "no
// cache" silently is fine, doing so with nothing in the log is not.
test("a cache file whose stat fails for another reason is still reported", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    utils.readJsonFileAsync({
        query_info_async(_attributes, _flags, _priority, _cancellable, callback) {
            callback(this, {});
        },
        query_info_finish() {
            throw new Error("Error opening file: Permission denied");
        }
    }, () => {});

    assert.ok(logged.some((line) => /Permission denied/.test(line)));
});

// urlForLog is the applet's only privacy control on the logging path: the
// user's city and country ride in the query string of every geocode and holiday
// request. Four examples are not a property.
test("fuzz: the log sanitizer never lets a query or fragment through", () => {
    const utils = loadIoUtils();
    const rand = makeRandom(0x109);
    const pick = (pool) => pool[Math.floor(rand() * pool.length)];

    const schemes = ["https", "http", "HTTPS", "ftp", "weird+scheme-1.0"];
    const hosts = ["api.open-meteo.com", "user:pw@nominatim.openstreetmap.org", "127.0.0.1:8080", "[::1]"];
    const paths = ["", "/", "/v1/search", "/a/b/c.json", "/path with spaces"];
    // the secret is whatever the user typed: a city, a country, a clock's name
    const secrets = ["São Paulo", "Mom's place", "usa", "Kraków", "12 Elm Street"];

    for (let round = 0; round < 500; round++) {
        const secret = pick(secrets);
        const fuzzed = randomSanitizerUrl(rand, pick, schemes, hosts, paths, secret);
        assertSanitizedUrl(utils, fuzzed.url, fuzzed.encoded, fuzzed.hasSecretSuffix);
    }

    // and anything that is not a URL at all is still answered with a string
    for (const junk of [null, undefined, 42, {}, [], "", "not a url", "//protocol-relative/x?y=1"]) {
        const logged = utils.urlForLog(junk);
        assert.equal(typeof logged, "string");
        assert.doesNotMatch(logged, /[?#]/);
    }
});

test("readJsonFileAsync reads off the main loop and never throws at the caller", () => {
    const utils = loadIoUtils();
    const asyncFile = (contents, options = {}) => ({
        query_info_async(_attributes, _flags, _priority, _cancellable, callback) {
            callback(this, {});
        },
        query_info_finish() {
            if (options.missing) {
                throw new Error("Error opening file /cache/holidays.json: No such file or directory");
            }
            return { get_size: () => Buffer.byteLength(contents || "") };
        },
        load_contents_async(_cancellable, callback) {
            if (options.throwOnCall) {
                throw new Error("no reader");
            }
            callback(this, { contents });
        },
        load_contents_finish(result) {
            if (options.throwOnFinish) {
                throw new Error("read failed");
            }
            return [true, Buffer.from(result.contents, "utf8")];
        }
    });
    const read = (file) => {
        let got = "unset";
        utils.readJsonFileAsync(file, (data) => {
            got = data;
        });
        return got;
    };

    assert.deepEqual(read(asyncFile('{"usa":{"holidays":[]}}')), { usa: { holidays: [] } });
    assert.deepEqual(read(asyncFile("{ not json")), {}, "a corrupt file reads as empty");
    assert.deepEqual(read(asyncFile("null")), {}, "a file that parses to a scalar reads as empty");
    assert.deepEqual(read(asyncFile("[]")), {}, "an array cannot hold country-keyed cache data");
    assert.deepEqual(read(asyncFile("{}", { missing: true })), {}, "a missing file is not read at all");
    assert.deepEqual(read(asyncFile("{}", { throwOnFinish: true })), {});
    assert.deepEqual(read(asyncFile("{}", { throwOnCall: true })), {});
});

// Without REPLACE_DESTINATION a symlink planted at the cache path is followed
// and its target overwritten. The flag was documented at length and asserted by
// nothing: changing it to NONE kept the whole suite green.
test("the cache write replaces a planted symlink instead of following it", () => {
    const utils = loadIoUtils();
    const Gio = global.imports.gi.Gio;
    let flags = null;

    utils.writeJsonFileAsync({
        replace_contents_async(bytes, etag, backup, givenFlags, cancellable, callback) {
            flags = givenFlags;
            callback({ replace_contents_finish() {} }, {});
        }
    }, { a: 1 });

    assert.equal(flags, Gio.FileCreateFlags.REPLACE_DESTINATION);
    assert.notEqual(Gio.FileCreateFlags.REPLACE_DESTINATION, Gio.FileCreateFlags.NONE);
});

test("the translations are looked for where the applet is installed", () => {
    const bind = (appletPath) => {
        loadUtils();
        const domains = [];
        global.imports.gettext = {
            bindtextdomain: (domain, localeDir) => domains.push(localeDir),
            dgettext: (_domain, str) => str
        };
        global.imports.gi.GLib.get_home_dir = () => "/home/test";
        global.imports.ui = {
            appletManager: {
                appletMeta: { "chronos@geraldo-netto": { path: appletPath } }
            }
        };
        for (const part of localePartPaths) {
            delete require.cache[require.resolve(part)];
        }
        require(localeTextModulePath);
        return domains[0];
    };

    assert.equal(bind("/home/test/.local/share/cinnamon/applets/chronos@geraldo-netto"),
        "/home/test/.local/share/locale");
    assert.equal(bind("/usr/share/cinnamon/applets/chronos@geraldo-netto"),
        "/usr/share/locale");
});

test("date formats prefer the applet's own gettext domain", () => {
    loadUtils();
    const domains = [];
    global.imports.gettext = {
        bindtextdomain(domain, localeDir) {
            domains.push({ domain, localeDir });
        },
        dgettext(domain, str) {
            if (domain === "chronos@geraldo-netto" && str === "%B %-e, %Y") {
                return "%-e. %B %Y"; // translated in the UUID domain
            }
            return domain === "cinnamon" ? `cinnamon:${str}` : str;
        }
    };
    global.imports.gi.GLib.get_home_dir = () => "/home/test";
    for (const part of localePartPaths) {
        delete require.cache[require.resolve(part)];
    }

    const localeText = require(localeTextModulePath);
    const dateFormats = require(dateFormatsModulePath);

    assert.deepEqual(domains, [{
        domain: "chronos@geraldo-netto",
        localeDir: "/home/test/.local/share/locale"
    }]);
    // translated in the UUID domain
    assert.equal(dateFormats.DATE_FORMAT_SHORT, "localized:%-e. %B %Y");
    // Untranslated in our domain stays English — it never asks Cinnamon's.
    // That lookup matches on the English word rather than the meaning: "Fair"
    // is untranslated in all 15 of our catalogs, and Cinnamon's translates it
    // as a quality rating (de "Ausreichend", fr "Moyen", es "Normal"), so a
    // German user with weather on was told the sky was adequate.
    assert.equal(dateFormats.DATE_FORMAT_FULL, "localized:%A, %B %-e, %Y");
    assert.equal(localeText.translate("Fair"), "Fair");
    assert.equal(localeText.translatePlural("%d event", "%d events", 2), "%d events");
});

test("month window offset reaches week start for every day and locale", () => {
    const utils = loadLocaleModules();

    // exhaustive: ISO day of month's first day (1=Mon..7=Sun) x locale
    // week start (0=Sun..6=Sat)
    for (let isoWeekDay = 1; isoWeekDay <= 7; isoWeekDay++) {
        for (let weekStart = 0; weekStart <= 6; weekStart++) {
            const offset = utils.monthWindowStartOffset(isoWeekDay, weekStart);

            assert.ok(offset >= 0 && offset <= 6,
                `offset ${offset} out of range for iso ${isoWeekDay}, start ${weekStart}`);

            // stepping back `offset` days must land exactly on the week start
            const gridStartDay = ((isoWeekDay % 7) - offset + 7) % 7;
            assert.equal(gridStartDay, weekStart,
                `iso ${isoWeekDay} - ${offset} days lands on ${gridStartDay}, not ${weekStart}`);
        }
    }

    // the reported regression: month starting on Sunday, Sunday-week-start
    // locale — the old code backed up 7 days and missed the grid's last week
    assert.equal(utils.monthWindowStartOffset(7, 0), 0);
    // and the common cases stay put
    assert.equal(utils.monthWindowStartOffset(1, 1), 0);
    assert.equal(utils.monthWindowStartOffset(7, 1), 6);
});

test("date-format boundaries count code points and clamp rendered stamps", () => {
    const formats = loadUtils();
    const maxFormat = formats.MAX_DATE_FORMAT_LENGTH;
    const maxStamp = formats.MAX_CLOCK_STAMP_LENGTH;

    assert.equal(formats.dateFormatWithinLimit("x".repeat(maxFormat)), true);
    assert.equal(formats.dateFormatWithinLimit("x".repeat(maxFormat + 1)), false);
    assert.equal(formats.dateFormatWithinLimit("🎉".repeat(maxFormat)), true);
    assert.equal(formats.dateFormatWithinLimit("🎉".repeat(maxFormat + 1)), false);
    assert.equal(formats.dateFormatOrDefault("x".repeat(maxFormat + 1), "%H:%M"),
        "%H:%M");

    const requested = [];
    assert.equal(formats.formatDateWithFallback((format) => {
        requested.push(format);
        return format === "bad" ? null : "safe date";
    }, "bad", "known-good"), "safe date");
    assert.deepEqual(requested, ["bad", "known-good"]);
    let duplicateAttempts = 0;
    assert.equal(formats.formatDateWithFallback(() => {
        duplicateAttempts++;
        return null;
    }, "bad", "bad"), "");
    assert.equal(duplicateAttempts, 2);
    assert.equal(Array.from(formats.formatDateWithFallback(
        () => "x".repeat(200000), "valid")).length, maxStamp);

    const stamp = formats.clampClockStamp("x".repeat(200000));
    assert.equal(Array.from(stamp).length, maxStamp);
    assert.ok(stamp.endsWith(formats.TEXT_ELLIPSIS));
});

// A shim only earns its place if a 6.0 module requires it: the root modules
// reach their siblings through the applet importer, never through 6.0/.
test("every version shim is required by a 6.0 module", () => {
    const files = fs.readdirSync(versionDir).filter((name) => name.endsWith(".js"));
    const sources = files.map((name) => fs.readFileSync(path.join(versionDir, name), "utf8"));

    for (const name of files) {
        const source = fs.readFileSync(path.join(versionDir, name), "utf8");
        const isShim = /applets\["chronos@geraldo-netto"\]\.\w+;/.test(source) && source.split("\n").length < 20;
        if (!isShim) {
            continue;
        }

        const moduleName = name.replace(/\.js$/, "");
        const required = sources.some((other) => other.includes(`require("./${moduleName}")`));
        assert.equal(required, true, `6.0/${name} is a shim with no 6.0 consumer`);
    }
});

test("safeCssColor allows plain color syntax and blocks style injection", () => {
    const StyleUtils = loadStyleUtils();
    const max = StyleUtils.MAX_CSS_COLOR_LENGTH;
    assert.equal(StyleUtils.safeCssColor("#abc"), "#abc");
    assert.equal(StyleUtils.safeCssColor("#AABBCCDD"), "#AABBCCDD");
    assert.equal(StyleUtils.safeCssColor("rgb(1, 2, 3)"), "rgb(1, 2, 3)");
    assert.equal(StyleUtils.safeCssColor("rgba(1,2,3,.5)"), "rgba(1,2,3,.5)");
    assert.equal(StyleUtils.safeCssColor(" red "), "red");
    assert.equal(StyleUtils.safeCssColor("red; background-image: url(http://x)"), "transparent");
    assert.equal(StyleUtils.safeCssColor("url(javascript:x)"), "transparent");
    assert.equal(StyleUtils.safeCssColor(null), "transparent");
    assert.equal(StyleUtils.safeCssColor("#abc", "#000"), "#abc");
    assert.equal(StyleUtils.safeCssColor("}; *{color:red}", "#000"), "#000");
    assert.equal(StyleUtils.safeCssColor("a".repeat(max)), "a".repeat(max));
    assert.equal(StyleUtils.safeCssColor("a".repeat(max + 1), "#000"), "#000");
    assert.equal(StyleUtils.safeCssColor(" ".repeat(200000) + "red", "#000"), "#000");
});

test("fuzz: safeCssColor output never carries declaration separators", () => {
    const StyleUtils = loadStyleUtils();
    const rand = makeRandom(20260709);
    const alphabet = "#;:(){}abcdef0123456789 rgbaurl-%.,";
    for (let i = 0; i < 500; i++) {
        let candidate = "";
        const len = Math.floor(rand() * 24);
        for (let j = 0; j < len; j++) {
            candidate += alphabet[Math.floor(rand() * alphabet.length)];
        }
        const result = StyleUtils.safeCssColor(candidate);
        assert.ok(!result.includes(";") && !result.includes("}"),
            `unsafe output for input "${candidate}": "${result}"`);
    }
});

// Exponential backoff with a ceiling and jitter was written four times — panel
// weather, city weather, EDS reconnect, month fetch — and two of the four had
// no jitter at all. This is the one copy.
test("backoffDelay doubles, caps, and spreads", () => {
    const ProviderUtils = require(providerModulePath);
    const delay = (attempt, random) =>
        ProviderUtils.backoffDelay(attempt, { base: 5, cap: 40, random: () => random });

    // it doubles from the base
    assert.equal(delay(0, 0), 5);
    assert.equal(delay(1, 0), 10);
    assert.equal(delay(2, 0), 20);
    // and stops at the ceiling
    assert.equal(delay(3, 0), 40);
    assert.equal(delay(30, 0), 40);

    // the jitter is drawn from [0, base) and lands on top of the backoff, so a
    // saturated backoff still spreads: capping the total would put every
    // instance on the network back at exactly the ceiling, together
    assert.equal(delay(1, 0.5), 12);
    assert.equal(delay(30, 0.99), 44);
    assert.notEqual(delay(30, 0), delay(30, 0.99));

    // a negative attempt count is still the base, not a fraction of a second
    assert.equal(delay(-3, 0), 5);
});

// a nameless provider is logged by its URL, and a geocode URL carries the place
// the user typed — which is what urlForLog exists to strip
test("a provider with no name is logged by a stripped URL, or not at all", () => {
    const providerUtils = loadProviderUtils();
    const logged = [];
    global.log = (message) => logged.push(String(message));

    // fails, so the chain logs the failover and moves on
    providerUtils.tryProvidersInOrder(
        [
            { url: "https://geocoding-api.open-meteo.com/v1/search?name=Lisbon" },
            {},
            { name: "Nominatim" }
        ],
        (provider, onResult) => onResult(null),
        (result) => Boolean(result),
        () => {},
        () => {}
    );

    assert.ok(logged.some((line) => line.includes("geocoding-api.open-meteo.com")),
        "a nameless provider is named by its URL");
    assert.ok(logged.every((line) => !line.includes("Lisbon")),
        "and the place the user typed is stripped out of it");
    assert.ok(logged.some((line) => line.includes("unknown provider")),
        "a provider with neither a name nor a URL is still logged");

    // ...and a provider slot that holds nothing at all
    assert.equal(providerUtils.providerName(null), "unknown provider");
    assert.equal(providerUtils.providerName({ name: "Enrico" }), "Enrico");
});

test("joinPhrases drops the parts that are not there", () => {
    const localeText = loadLocaleModules();

    assert.equal(localeText.joinPhrases(), "");
    assert.equal(localeText.joinPhrases("", null, undefined), "",
        "an accessible name with nothing in it is not a separator on its own");
    assert.equal(localeText.joinPhrases("Tokyo"), "Tokyo");
    assert.equal(localeText.joinPhrases("Tokyo", "", "07:51"), "Tokyo — 07:51");
    // 0 is a value, not an absence
    assert.equal(localeText.joinPhrases(0, "events"), "0 — events");
});

test("orderProvidersByLastSuccess prefers the last successful provider", () => {
    const ProviderUtils = loadProviderUtils();
    const providers = [{ name: "a" }, { name: "b" }, { name: "c" }];
    assert.equal(ProviderUtils.orderProvidersByLastSuccess(providers, ""), providers);
    assert.deepEqual(ProviderUtils.orderProvidersByLastSuccess(providers, "b").map((p) => p.name),
        ["b", "a", "c"]);
    assert.deepEqual(providers.map((p) => p.name), ["a", "b", "c"], "input not mutated");
    assert.deepEqual(ProviderUtils.orderProvidersByLastSuccess(providers, "zzz").map((p) => p.name),
        ["a", "b", "c"]);
});

test("notifyAll delivers every callback before rethrowing the first failure", () => {
    const ProviderUtils = loadProviderUtils();
    const calls = [];
    const first = new Error("first listener failed");

    assert.throws(() => ProviderUtils.notifyAll([
        () => { calls.push("first"); throw first; },
        () => { calls.push("second"); throw new Error("second listener failed"); },
        () => calls.push("third")
    ]), (error) => error === first);

    assert.deepEqual(calls, ["first", "second", "third"]);
    assert.doesNotThrow(() => ProviderUtils.notifyAll([]));
});

test("a failing provider is never logged with the location in its URL", () => {
    const ProviderUtils = loadProviderUtils();
    const logs = [];
    global.log = (message) => logs.push(message);

    // the geocode providers are the ones whose URL carries the user's typed
    // location; if one is ever left nameless, the log must still not carry it
    ProviderUtils.tryProvidersInOrder(
        [
            { url: "https://geocoding-api.open-meteo.com/v1/search?name=Sao%20Paulo&count=1" },
            { name: "Nominatim" }
        ],
        (provider, onResult) => onResult(provider.name ? "found" : null),
        (result) => Boolean(result),
        () => {},
        () => { throw new Error("should not exhaust"); }
    );

    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0], /Sao|%20|\?|name=/,
        "the query string is what carries the place, and it never reaches the log");
    assert.match(logs[0], /geocoding-api\.open-meteo\.com/,
        "the host still names the provider that failed");
});

test("tryProvidersInOrder falls back and retains the first failure", () => {
    const ProviderUtils = loadProviderUtils();
    const results = { a: null, b: "good" };
    const attempts = [];
    const logs = [];
    global.log = (message) => logs.push(message);
    let success = null;
    ProviderUtils.tryProvidersInOrder(
        [{ name: "a" }, { name: "b" }],
        (provider, onResult) => {
            attempts.push(provider.name);
            onResult(results[provider.name]);
        },
        (result) => Boolean(result),
        (provider, result) => { success = { provider: provider.name, result }; },
        () => { throw new Error("should not exhaust"); }
    );
    assert.deepEqual(attempts, ["a", "b"]);
    assert.deepEqual(success, { provider: "b", result: "good" });
    assert.deepEqual(logs, ["provider a failed; trying next provider"]);

    let exhausted = null;
    ProviderUtils.tryProvidersInOrder(
        [{ name: "a" }, { name: "b" }],
        (provider, onResult) => onResult({ error: provider.name }),
        () => false,
        () => { throw new Error("should not succeed"); },
        (failure) => { exhausted = failure; }
    );
    assert.deepEqual(exhausted, { error: "a" }, "first failure reported, not last");
});

// REGRESSION: attempt() was called bare, so a provider that raised rather than
// answering unwound the chain — neither onSuccess nor onExhausted ever ran, and
// failing over is the one thing this machinery exists to do.
test("a provider that raises fails over instead of unwinding the chain", () => {
    const ProviderUtils = loadProviderUtils();
    const logged = [];
    global.log = () => {};
    global.logError = (error) => logged.push(error);

    const boom = new Error("provider exploded");
    let success = null;
    ProviderUtils.tryProvidersInOrder(
        [{ name: "a" }, { name: "b" }],
        (provider, onResult) => {
            if (provider.name === "a") {
                throw boom;
            }
            onResult("good");
        },
        (result) => Boolean(result),
        (provider, result) => { success = { provider: provider.name, result }; },
        () => { throw new Error("should not exhaust"); }
    );

    assert.deepEqual(success, { provider: "b", result: "good" },
        "the raise is one provider's failure, not the chain's");
    assert.deepEqual(logged, [boom], "and it is reported rather than swallowed");
});

// the other half: a throw travelling back out through an attempt that already
// answered belongs to onSuccess, and must not be retried against the next
// provider as though the first one had failed
test("a throw out of onSuccess is not mistaken for a provider failure", () => {
    const ProviderUtils = loadProviderUtils();
    const attempts = [];
    global.log = () => {};

    assert.throws(() => ProviderUtils.tryProvidersInOrder(
        [{ name: "a" }, { name: "b" }],
        (provider, onResult) => {
            attempts.push(provider.name);
            onResult("good");
        },
        () => true,
        () => { throw new Error("consumer exploded"); },
        () => { throw new Error("should not exhaust"); }
    ), /consumer exploded/);

    assert.deepEqual(attempts, ["a"], "the chain does not advance past it");
});

test("fuzz: tryProvidersInOrder always terminates with success or exhaustion", () => {
    const ProviderUtils = loadProviderUtils();
    const rand = makeRandom(77);
    for (let i = 0; i < 300; i++) {
        const count = 1 + Math.floor(rand() * 5);
        const okIndex = rand() < 0.5 ? Math.floor(rand() * count) : -1;
        const providers = Array.from({ length: count }, (_, n) => ({ name: `p${n}` }));
        let outcome = null;
        ProviderUtils.tryProvidersInOrder(
            providers,
            (provider, onResult) => onResult(provider.name === `p${okIndex}` ? "ok" : null),
            (r) => r === "ok",
            (provider) => { outcome = "success:" + provider.name; },
            () => { outcome = "exhausted"; }
        );
        assert.equal(outcome, okIndex >= 0 ? `success:p${okIndex}` : "exhausted");
    }
});

test("lazyLocaleValue defers getInfo until first use and memoizes", () => {
    const Utils = loadLocaleModules();
    let calls = 0;
    // exercise through a wrapped pick to observe evaluation timing
    const lazy = Utils.lazyLocaleValue("LC_TIME", (info) => {
        calls++;
        return info.abday;
    });
    assert.equal(calls, 0, "nothing evaluated at creation");
    const first = lazy();
    assert.equal(calls, 1);
    const second = lazy();
    assert.equal(calls, 1, "memoized");
    assert.equal(first, second);
});

test("httpGetJson logs sanitized non-200 responses before reporting null", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(message);

    let reads = 0;
    const soup = makeStreamingSoup({
        status: 503,
        chunks: [Buffer.alloc(utils.MAX_RESPONSE_BYTES)],
        onRead: () => reads++
    });
    Object.assign(global.imports.gi.Soup, soup);

    let reported = "unset";
    utils.httpGetJson(new soup.Session(),
        "https://x.test/y?name=Private%20Place#top", (data) => { reported = data; });
    assert.equal(reported, null);
    assert.equal(reads, 0, "the known error status costs no body reads");
    assert.deepEqual(soup.streams.map((stream) => stream.closed), [1],
        "the unread error stream still releases its connection");
    const message = String(logged[0]);
    assert.match(message, /503/);
    assert.match(message, /https:\/\/x\.test\/y/);
    assert.doesNotMatch(message, /Private/);
    assert.doesNotMatch(message, /name=/);
});

test("urlForLog strips query strings and fragments", () => {
    const utils = loadIoUtils();
    assert.equal(utils.urlForLog("https://x.test/y?name=Private%20Place#top"), "https://x.test/y");
    assert.equal(utils.urlForLog("/relative/path?token=secret"), "/relative/path");
    assert.equal(utils.urlForLog(null), "");
});

test("httpGetJson reports Soup 3 read failures through the callback", () => {
    const utils = loadIoUtils();
    const error = new Error("read failed");
    const logged = [];
    global.logError = (message) => logged.push(message);

    const session = new (makeStreamingSoup().Session)();
    session.send_finish = () => {
        throw error;
    };
    global.imports.gi.Soup.Message = {
        new: (method, url) => ({ method, url, get_status: () => 200 })
    };

    let reported = "unset";
    utils.httpGetJson(session, "https://x.test/y", (data) => { reported = data; });
    assert.equal(reported, null);
    assert.deepEqual(logged, [error]);
});

// Root modules bridge the two module systems the applet lives in: GJS has
// `imports` and no require(), Node has require() and no `imports`. Only one
// arm of every ternary can run per host, so the module is compiled once and run
// against both hosts; a re-export that works under Node but resolves to
// undefined under the GJS importer is exactly how the applet breaks on a real
// desktop while the suite stays green.
function runInBothHosts(file) {
    const script = new vm.Script(fs.readFileSync(file, "utf8"), { filename: file });

    const gjsContext = { imports: gjsImportsMock() };
    script.runInNewContext(gjsContext);

    const nodeContext = {
        require: (request) => require(path.join(path.dirname(file), request)),
        module: { exports: {} },
        // what the module actually asks about: Cinnamon's cjs has no `process`,
        // and Cinnamon master *does* have require(), so require() cannot be the
        // question
        process: { versions: { node: process.versions.node } }
    };
    // Node's module scope has no `imports` binding — the GJS globals are reached
    // through globalThis, which is how a module under Node still gets at gi
    nodeContext.globalThis = { imports: gjsImportsMock() };
    nodeContext.globalThis.globalThis = nodeContext.globalThis;
    script.runInNewContext(nodeContext);

    return { gjs: gjsContext, node: nodeContext.module.exports };
}

// the doubles the GJS importer would hand back for the sibling modules
function gjsImportsMock() {
    const stub = {
        MSECS_IN_DAY: 86400000,
        DAY_FORMAT: "%A",
        DATE_FORMAT_SHORT: "%B %-e, %Y",
        DATE_FORMAT_FULL: "%A, %B %-e, %Y",
        translate: (str) => str,
        translatePlural: (s, p, n) => (n === 1 ? s : p),
        monthWindowStartOffset(isoWeekDay, weekStart) {
            return ((isoWeekDay % 7) - weekStart + 7) % 7;
        },
        lazyLocaleValue() {},
        onLocaleInfoChanged() {},
        cancelPendingLocaleQueries() {},
        registerLocaleConsumer() {},
        readJsonFileAsync() {},
        writeJsonFileAsync() {},
        createHttpSession() {},
        LazyHttpSession: class {},
        HTTP_TIMEOUT_SECONDS: 30,
        httpGetJson() {},
        urlForLog() {},
        safeCssColor() {},
        clampText() {},
        textWithinLimit(text, max) { return Array.from(String(text)).length <= max; },
        normalizeBoundedText(text) { return String(text).trim(); },
        TEXT_ELLIPSIS: "…",
        joinPhrases(...parts) { return parts.join(" — "); },
        getInfo() { return {}; },
        localeDirectory() { return "/tmp"; },
        backoffDelay() {},
        orderProvidersByLastSuccess() {},
        tryProvidersInOrder() {}
    };

    return {
        gi: {
            GLib: {},
            Gio: {},
            Cinnamon: {},
            Soup: {},
            // dateFormats builds its strftime constants through the WallClock
            CinnamonDesktop: {
                WallClock: { lctime_format: (_domain, format) => format }
            }
        },
        ui: {
            appletManager: {
                applets: {
                    "chronos@geraldo-netto": {
                        localeText: stub,
                        localeQuery: stub,
                        dateMath: stub,
                        dateFormats: stub,
                        ioUtils: stub,
                        styleUtils: stub,
                        providerUtils: stub,
                        textUtils: stub
                    }
                }
            }
        }
    };
}

// Each locale module bridges the GJS importer and Node directly. Run both arms
// so a symbol that is exported under Node but not declared at top level for GJS
// cannot break only on a real desktop.
test("the locale modules expose their APIs under the GJS importer and Node", () => {
    loadUtils();
    for (const [name, modulePath] of [
        ["localeText", localeTextModulePath],
        ["localeQuery", localeQueryModulePath],
        ["dateFormats", dateFormatsModulePath]
    ]) {
        const hosts = runInBothHosts(modulePath);
        for (const symbol of Object.keys(hosts.node)) {
            assert.notEqual(hosts.gjs[symbol], undefined,
                `${name}.${symbol} is missing through the GJS importer`);
        }
    }

    // dateFormats reaches the
    // translator through the importer under Cinnamon and through require() here,
    // and the formats it builds are what every date in the applet is rendered with
    const dates = runInBothHosts(dateFormatsModulePath);
    assert.equal(dates.gjs.MSECS_IN_DAY, 86400000);
    assert.equal(dates.gjs.monthWindowStartOffset(7, 0), 0, "Sunday, week starting Sunday");
    assert.equal(dates.node.monthWindowStartOffset(1, 0), 1, "Monday, week starting Sunday");
});

test("httpGetJson tolerates a Soup message that exposes no request headers", () => {
    const utils = loadIoUtils();
    let parsed = "unset";

    const session = new (makeStreamingSoup({
        chunks: [Buffer.from('{"ok":true}')]
    }).Session)();
    // A malformed double with no request_headers must not cost the caller its
    // response when there is simply nowhere to append an optional header.
    global.imports.gi.Soup.Message = {
        new: (method, url) => ({ method, url, get_status: () => 200 })
    };

    utils.httpGetJson(session, "https://x.test/y", (data) => { parsed = data; },
        { headers: { "User-Agent": "calendar" } });
    assert.deepEqual(parsed, { ok: true });
});

test("urlForLog keeps a bare origin with no path", () => {
    const utils = loadIoUtils();
    // the geocoder is reached at the origin itself; there is no path to keep
    assert.equal(utils.urlForLog("https://api.test"), "https://api.test");
    assert.equal(utils.urlForLog("https://api.test?q=Private"), "https://api.test");
});

test("writeJsonFileAsync logs async failures on both the call and the completion", () => {
    const utils = loadIoUtils();
    const errors = [];
    global.logError = (error) => errors.push(error);

    const finishError = new Error("disk full");
    utils.writeJsonFileAsync({
        replace_contents_async(bytes, etag, backup, flags, cancellable, callback) {
            callback({
                replace_contents_finish() { throw finishError; }
            }, {});
        }
    }, { a: 1 });

    assert.deepEqual(errors, [finishError], "a failed write completion is reported, not swallowed");

    const callError = new Error("no such directory");
    assert.doesNotThrow(() => utils.writeJsonFileAsync({
        replace_contents_async() { throw callError; }
    }, { a: 1 }));
    assert.deepEqual(errors, [finishError, callError]);
});

// The parts joined here are an event summary from an ICS feed, a holiday name
// from a third-party service, and a provider's own error string. They were passed
// as the replacement argument of String.replace, where $&, $`, $' and $1 are
// expanded as replacement patterns — and the two substitutions were chained, so
// the second scanned the string the first had built.
test("fuzz: a hostile phrase cannot corrupt the phrase it is joined to", () => {
    const utils = loadUtils();
    const rand = makeRandom(0x5eed);

    // every replacement pattern String.replace understands, plus the format
    // specifier the template itself uses
    const nasty = ["$&", "$`", "$'", "$1", "$$", "%s", "%d", "$<name>"];
    const words = ["Team sync", "50%sale", "Lunch", "Réunion", "会議", ""];
    const pick = (pool) => pool[Math.floor(rand() * pool.length)];

    for (let round = 0; round < 500; round++) {
        const left = pick(words) + pick(nasty) + pick(words);
        const right = pick(words) + pick(nasty) + pick(words);

        const joined = utils.joinPhrases(left, right);

        // whatever the parts contain, they arrive whole and in order
        if (left && right) {
            assert.ok(joined.includes(left), `left part mangled: ${JSON.stringify(joined)}`);
            assert.ok(joined.includes(right), `right part mangled: ${JSON.stringify(joined)}`);
            assert.equal(joined, left + " — " + right);
        }
        // the template's own placeholder is never left behind unfilled
        assert.equal(joined.includes("%s — %s"), false);
    }
});

test("a %s inside a phrase is text, not a placeholder", () => {
    const utils = loadUtils();

    // the bug, exactly: the second substitution scanned what the first had built,
    // so this announced "10:00 — 50In progressale — %s"
    assert.equal(utils.joinPhrases("10:00", "50%sale", "In progress"),
        "10:00 — 50%sale — In progress");

    // and the replacement patterns arrive as themselves
    assert.equal(utils.joinPhrases("a$&b", "c$`d"), "a$&b — c$`d");
});

// Every listener used to be told whenever *any* env answered. The calendar's
// listener responds by rebuilding its header — destroy_all_children(), which
// drops all 42 day cells and every per-cell holiday tooltip, and makes the next
// update reconstruct 42 Cinnamon.Stacks, 42 St.Buttons, 42 GenericContainers and
// 84 signal connections. An unrelated category such as LC_ADDRESS used to tear
// the whole grid down when its answer arrived.
test("a locale listener hears about its own env and no other", () => {
    const localeQuery = loadLocaleModules("abday=\"Sun;Mon;Tue;Wed;Thu;Fri;Sat\"");
    const heard = { LC_TIME: 0, LC_ADDRESS: 0 };

    localeQuery.onLocaleInfoChanged("LC_TIME", () => heard.LC_TIME++);
    localeQuery.onLocaleInfoChanged("LC_ADDRESS", () => heard.LC_ADDRESS++);

    // an unrelated regional query answers
    localeQuery.lazyLocaleValue("LC_ADDRESS", (info) => info.lang_ab)();

    assert.equal(heard.LC_ADDRESS, 1, "the listener that asked about it is told");
    assert.equal(heard.LC_TIME, 0,
        "and the grid is not rebuilt for an env nothing in it depends on");

    // ...and the one the header does depend on still lands
    localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)();
    assert.equal(heard.LC_TIME, 1);
});

// The locale query's 5-second deadline and its 60-second retry are module-level
// GLib timers with no owner: nothing anywhere removed them. Remove the applet a
// second after login, while `locale` is wedged on a hung NSS lookup, and the
// retry still spawns a subprocess up to two minutes after the applet is gone.
test("the locale query's timers can be reaped when the applet goes away", () => {
    const removed = [];
    const armed = [];
    const localeQuery = loadLocaleModules({
        spawn: () => [false, new Uint8Array(0), new Uint8Array(0), 1]
    });
    global.imports.gi.GLib.timeout_add_seconds = (priority, seconds, callback) => {
        armed.push({ seconds, callback });
        return armed.length;
    };
    global.imports.gi.GLib.source_remove = (id) => removed.push(id);

    // asking for the locale arms the deadline; the query fails and arms the retry
    localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)();
    assert.ok(armed.length > 0, "the deadline is armed");

    localeQuery.cancelPendingLocaleQueries();

    assert.deepEqual(removed, armed.map((_unused, index) => index + 1),
        "every timer the locale query armed is removed");

    // ...and a second teardown is not an error
    assert.doesNotThrow(() => localeQuery.cancelPendingLocaleQueries());
});

// A timer that has already fired is not there to remove, and Cinnamon may have
// disposed the source under us on a reload: the teardown reports it and carries
// on rather than stranding the timers behind it.
test("a timer that will not be removed does not strand the ones behind it", () => {
    const errors = [];
    global.logError = (error) => errors.push(error);

    const removed = [];
    const localeQuery = loadLocaleModules({
        spawn: () => [false, new Uint8Array(0), new Uint8Array(0), 1]
    });
    let armed = 0;
    global.imports.gi.GLib.timeout_add_seconds = () => ++armed;
    global.imports.gi.GLib.source_remove = (id) => {
        if (id === 1) {
            throw new Error("no such source");
        }
        removed.push(id);
    };

    localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)();
    // The synchronous failure above needs only a retry. Keep a second locale
    // query genuinely in flight so teardown also owns a live deadline.
    global.imports.gi.Gio.Subprocess = class {
        init() {}
        communicate_utf8_async() {}
        force_exit() {}
    };
    localeQuery.lazyLocaleValue("LC_ADDRESS", (info) => info.lang_ab)();
    assert.equal(armed, 2, "one retry and one live deadline are armed");

    localeQuery.cancelPendingLocaleQueries();

    assert.equal(errors.length, 1, "the one that would not go is reported");
    assert.deepEqual(removed, [2], "and the rest are still removed");
});

// The subprocess itself is still running when the applet goes away: the deadline
// that would have cancelled it is gone too, so the teardown cancels it directly.
test("the teardown cancels the locale subprocess still in flight", () => {
    const localeQuery = loadLocaleModules({ neverAnswers: true });
    localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)();

    const cancellable = global.imports.gi.Gio.Cancellable.last;
    assert.ok(cancellable, "a query is in flight");
    assert.equal(cancellable.cancelled, false);

    localeQuery.cancelPendingLocaleQueries();

    assert.equal(cancellable.cancelled, true,
        "the subprocess is not left running after the applet is gone");
});

// T584: a failed env is degraded and only its armed retry may re-ask — but the
// last consumer's teardown cancels that retry with the other timers. An applet
// added later then stayed on the English defaults for the process lifetime
// despite unused attempts. The fail-remove-re-add sequence is the first
// seconds of login, which is exactly when `locale` fails.
test("a degraded locale query restarts when an applet returns", () => {
    global.logError = () => {};
    let failures = 0;
    const localeQuery = loadLocaleModules({
        spawnFails: () => {
            if (failures++ === 0) {
                throw new Error("fork failed");
            }
        },
        spawnOutput: 'abday="Dom;Seg;Ter;Qua;Qui;Sex;Sáb"\n'
    });

    // first applet: the spawn fails, the env degrades, a retry is armed
    localeQuery.registerLocaleConsumer();
    assert.equal(localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)(),
        "Sun;Mon;Tue;Wed;Thu;Fri;Sat", "the failure leaves the defaults");

    // ...and the applet is removed, which cancels the armed retry
    localeQuery.cancelPendingLocaleQueries();

    // a new applet is added: the degraded query restarts and recovers
    localeQuery.registerLocaleConsumer();
    assert.equal(localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)(),
        "Dom;Seg;Ter;Qua;Qui;Sex;Sáb",
        "the returning applet is not condemned by the departed one's failure");
});

// T610: the teardown removed the armed deadline first — the only other holder
// of the process handle, and the only code that called force_exit() — then
// cancelled just the read. A `locale` genuinely wedged on a hung NSS lookup
// (the exact case the deadline documents) was left running for the rest of the
// session with nothing left that could kill it.
test("the teardown kills a wedged locale child, not just the read", () => {
    const localeQuery = loadLocaleModules({ neverAnswers: true });
    localeQuery.registerLocaleConsumer();
    localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)();

    const child = global.imports.gi.Gio.Subprocess.last;
    assert.ok(child, "a query is in flight");
    assert.ok(!child.forced, "and its child is running");

    localeQuery.cancelPendingLocaleQueries();

    assert.equal(child.forced, true,
        "the wedged child is killed, not abandoned to the session");
});

// A query that has answered is holding nothing, and the teardown must find
// nothing to cancel. The handles used to be released only on the abandoned
// branch, so a finished Gio.Subprocess and its cancellable stayed in the module
// maps for the life of the compositor and "is a query in flight?" was
// answerable two ways — the requested flag and the handles — that had to agree.
// force_exit() on a reaped child is what disagreeing would cost.
test("a settled locale query leaves the teardown nothing to kill", () => {
    const localeQuery = loadLocaleModules(
        'abday="Dom;Seg;Ter;Qua;Qui;Sex;Sáb"\nfirst_workday=1\n');
    localeQuery.registerLocaleConsumer();

    assert.equal(localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)(),
        "Dom;Seg;Ter;Qua;Qui;Sex;Sáb", "the query answered");
    const child = global.imports.gi.Gio.Subprocess.last;
    const cancellable = global.imports.gi.Gio.Cancellable.last;
    assert.ok(child && cancellable);

    localeQuery.cancelPendingLocaleQueries();

    assert.ok(!child.forced,
        "a child that already exited is not force_exit()ed on the way out");
    assert.equal(cancellable.cancelled, false,
        "and its cancellable is not cancelled after the fact");

    // ...and the env is not marked abandoned by that teardown, which would make
    // the next applet resume a query that has already answered
    localeQuery.registerLocaleConsumer();
    assert.equal(global.imports.gi.Gio.Subprocess.last, child,
        "no second `locale` is spawned for an env that is already known");
});

// The applet is multi-instance, the locale query is process-wide, and the
// teardown that cancelled it was neither: removing one of two calendar applets
// cancelled the query the *other* one was still waiting on.
test("removing one applet does not cancel the locale query another is waiting on", () => {
    const localeQuery = loadLocaleModules({ neverAnswers: true });

    // two calendar applets on the panel
    localeQuery.registerLocaleConsumer();
    localeQuery.registerLocaleConsumer();

    localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)();
    const cancellable = global.imports.gi.Gio.Cancellable.last;
    assert.equal(cancellable.cancelled, false, "a query is in flight");

    // the user removes one of them
    localeQuery.cancelPendingLocaleQueries();
    assert.equal(cancellable.cancelled, false,
        "the applet that stayed is still waiting on this answer");

    // ...and when the last one goes, the query goes with it
    localeQuery.cancelPendingLocaleQueries();
    assert.equal(cancellable.cancelled, true);
});

// A cancel we asked for is not a locale that failed. Landing it in _degrade()
// spent one of three attempts and marked the env degraded, so three add/removes
// during the first seconds of login — while `locale` is genuinely still in
// flight — left every instance in the process pinned to the English defaults and
// the US work week for the rest of the session, with the retry ladder used up.
test("a locale query we cancelled ourselves does not spend a retry attempt", () => {
    global.logError = () => {};
    const localeQuery = loadLocaleModules({ neverAnswers: true });
    const Subprocess = global.imports.gi.Gio.Subprocess;

    localeQuery.registerLocaleConsumer();
    localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)();

    const first = global.imports.gi.Gio.Cancellable.last;
    localeQuery.cancelPendingLocaleQueries();
    assert.equal(first.cancelled, true);

    // GJS calls back on the cancelled query; finish() raises, and that used to be
    // read as "the locale is broken" rather than "we hung up"
    Subprocess.settle();

    // the next applet asks, and gets a fresh query rather than the defaults
    localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday)();

    assert.notEqual(global.imports.gi.Gio.Cancellable.last, first,
        "the question is asked again, not written off as answered");
});

test("re-adding an applet restarts a cancellation still settling", () => {
    const localeQuery = loadLocaleModules({
        neverAnswers: true,
        spawnOutput: 'abday="Dom;Seg;Ter;Qua;Qui;Sex;Sáb"\nfirst_workday=1\n'
    });
    const Subprocess = global.imports.gi.Gio.Subprocess;
    const heard = [];

    localeQuery.registerLocaleConsumer();
    localeQuery.onLocaleInfoChanged("LC_TIME", () => heard.push(true));
    const value = localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday);
    assert.equal(value(), "Sun;Mon;Tue;Wed;Thu;Fri;Sat");

    const cancelled = global.imports.gi.Gio.Cancellable.last;
    localeQuery.cancelPendingLocaleQueries();
    localeQuery.registerLocaleConsumer();
    assert.equal(value(), "Sun;Mon;Tue;Wed;Thu;Fri;Sat");
    assert.equal(global.imports.gi.Gio.Cancellable.last, cancelled,
        "the cancelled request still owns the env until its callback settles");

    Subprocess.settle();
    const replacement = global.imports.gi.Gio.Cancellable.last;
    assert.notEqual(replacement, cancelled, "the replacement consumer gets a fresh query");
    assert.deepEqual(heard, [], "cancellation itself does not publish defaults");

    Subprocess.settle();
    assert.deepEqual(heard, [true], "the replacement query wakes its listener");
    assert.equal(value(), "Dom;Seg;Ter;Qua;Qui;Sex;Sáb");

    localeQuery.cancelPendingLocaleQueries();
});

// T741: T584 covers an env whose retry the teardown cancelled *before* it went
// out, and T727 covers a never-failed env cancelled mid-flight. The gap was the
// intersection — a degraded env whose armed retry was already in flight when
// the last consumer left. `degraded` is only cleared by a success, so the
// replacement consumer's forced resume was refused (the request is still in
// flight), and the abandoned branch's own resume then forgot the flag and was
// refused too. Nothing recorded the env as unfinished either, so it was never
// asked again: the process stayed on the English defaults for the session with
// two of three attempts unspent. Remove-and-re-add is what a reload does.
test("a degraded query cancelled mid-retry is resumed by the replacement applet", () => {
    global.logError = () => {};
    const localeQuery = loadLocaleModules({
        neverAnswers: true,
        spawnOutput: 'abday="Dom;Seg;Ter;Qua;Qui;Sex;Sáb"\nfirst_workday=1\n'
    });
    const Subprocess = global.imports.gi.Gio.Subprocess;
    const Cancellable = global.imports.gi.Gio.Cancellable;
    const timers = [];
    global.imports.gi.GLib.timeout_add_seconds = (_priority, seconds, callback) => {
        timers.push({ seconds, callback });
        return timers.length;
    };
    const fire = (seconds) => {
        const index = timers.findIndex((timer) => timer.seconds === seconds);
        assert.notEqual(index, -1, `a ${seconds}s timer is armed`);
        timers.splice(index, 1)[0].callback();
    };
    const abday = localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday);

    // first applet: the query wedges, its deadline fires, the env degrades and
    // arms the 60 s retry with two attempts left
    localeQuery.registerLocaleConsumer();
    assert.equal(abday(), "Sun;Mon;Tue;Wed;Thu;Fri;Sat");
    fire(5);
    assert.equal(abday(), "Sun;Mon;Tue;Wed;Thu;Fri;Sat", "the defaults stand in");

    // the retry goes out and is still in flight when the applet is removed
    fire(60);
    const retried = Cancellable.last;
    localeQuery.cancelPendingLocaleQueries();
    assert.equal(retried.cancelled, true);

    // the replacement applet arrives before Gio delivers the cancellation, so
    // its own resume cannot restart a request that is still marked in flight
    localeQuery.registerLocaleConsumer();
    assert.equal(Cancellable.last, retried,
        "the cancelled request still owns the env until its callback settles");

    // ...and settling it is what has to pick the query back up
    Subprocess.settle();
    assert.notEqual(Cancellable.last, retried,
        "a degraded env is resumed, not written off with attempts to spare");

    Subprocess.settle();
    assert.equal(abday(), "Dom;Seg;Ter;Qua;Qui;Sex;Sáb",
        "and the answer reaches the memo that was holding the defaults");

    localeQuery.cancelPendingLocaleQueries();
});

// T727: the test above re-adds the applet *before* Gio delivers the
// cancellation, which is the case the `_consumers > 0` branch covers. Settle
// first and nothing resumed the query: the abandoned branch deliberately skips
// `_storeInfo`, so `degraded` — the only set registerLocaleConsumer resumed
// from — stayed clear, `localeGeneration` never moved, and every memo answered
// from its cached English default without calling getInfo() again. The header
// kept "Sun;Mon;Tue;..." and the US work week for the rest of the session, with
// `locale` sitting there ready to answer instantly.
test("a query abandoned before any consumer returns is resumed by the next one", () => {
    const localeQuery = loadLocaleModules({
        neverAnswers: true,
        spawnOutput: 'abday="Dom;Seg;Ter;Qua;Qui;Sex;Sáb"\nfirst_workday=1\n'
    });
    const Subprocess = global.imports.gi.Gio.Subprocess;

    localeQuery.registerLocaleConsumer();
    const value = localeQuery.lazyLocaleValue("LC_TIME", (info) => info.abday);
    assert.equal(value(), "Sun;Mon;Tue;Wed;Thu;Fri;Sat");

    const cancelled = global.imports.gi.Gio.Cancellable.last;
    localeQuery.cancelPendingLocaleQueries();
    // the cancellation lands while nobody is on the panel
    Subprocess.settle();
    assert.equal(global.imports.gi.Gio.Cancellable.last, cancelled,
        "with no consumer there is nothing to resume it for, yet");

    // the applet is added back
    localeQuery.registerLocaleConsumer();
    const replacement = global.imports.gi.Gio.Cancellable.last;
    assert.notEqual(replacement, cancelled,
        "the new consumer re-asks a question that was never answered");

    Subprocess.settle();
    assert.equal(value(), "Dom;Seg;Ter;Qua;Qui;Sex;Sáb",
        "and the memo picks the real locale up");

    // asking twice must not spawn twice
    localeQuery.registerLocaleConsumer();
    assert.equal(global.imports.gi.Gio.Cancellable.last, replacement);

    localeQuery.cancelPendingLocaleQueries();
});

// T791: hostMessageLocale used to fall back to process.env behind
// g_get_language_names(). Both halves were dead in Cinnamon — the GLib call is
// documented always to include the default locale, so it never returns an empty
// list, and cjs has no `process` to read anyway. Only the harness took the
// fallback, because its GLib stub had no get_language_names: the branch with a
// test was the one production cannot run, and the branch production always runs
// had none. That is the shape worldclockData.js:88-92 condemns.
test("the message language comes from GLib, in the order the C library defines", () => {
    const localeQuery = loadLocaleModules();
    const GLib = global.imports.gi.GLib;
    const saved = GLib.get_language_names;

    try {
        // g_get_language_names has already resolved LC_ALL over LC_MESSAGES over
        // LANG over LANGUAGE; the applet does not re-derive that precedence
        GLib.get_language_names = () => ["pt_BR.UTF-8", "pt", "C"];
        assert.equal(localeQuery.messageLanguage(), "pt");

        // "C" is what the list holds when the session sets no locale at all,
        // and it names no language a provider knows
        GLib.get_language_names = () => ["C"];
        assert.equal(localeQuery.messageLanguage(), "en");

        // an explicit locale still wins over the session's
        assert.equal(localeQuery.messageLanguage("de_DE.UTF-8"), "de");

        // process.env is not consulted, whatever it says: cjs has no `process`
        const savedLang = process.env.LANG;
        process.env.LANG = "ja_JP.UTF-8";
        try {
            assert.equal(localeQuery.messageLanguage(), "en",
                "the environment is the C library's business, not the applet's");
        } finally {
            if (savedLang === undefined) {
                delete process.env.LANG;
            } else {
                process.env.LANG = savedLang;
            }
        }
    } finally {
        GLib.get_language_names = saved;
    }
});

// T809: worldclockData carried its own synchronous file reader - GLib
// .file_get_contents behind two byte caps of its own - so the two paths that
// read /etc/timezone and /usr/share/zoneinfo/zone.tab were a second I/O regime
// that no hardening applied to the shared adapter could reach. The two also
// disagreed on failure: ioUtils logs an oversized file, worldclockData answered
// "" without a word.
test("the capped text read is the shared adapter's, and says when it refuses", () => {
    const utils = loadIoUtils();
    const logged = [];
    global.logError = (message) => logged.push(String(message));
    const GLib = global.imports.gi.GLib;
    const original = GLib.file_get_contents;

    GLib.file_get_contents = () => [true, Buffer.from("Europe/Rome\n")];
    assert.equal(utils.readTextFileCapped("/etc/timezone", 1024), "Europe/Rome\n");
    assert.deepEqual(logged, []);

    // past the caller's cap: nothing is returned, and the operator is told
    assert.equal(utils.readTextFileCapped("/etc/timezone", 4), "");
    assert.equal(logged.length, 1);
    assert.match(logged[0], /\/etc\/timezone is 12 bytes, past the 4-byte cap/);

    // a missing file, an unreadable one and a throwing GLib are all "no file"
    GLib.file_get_contents = () => [false, null];
    assert.equal(utils.readTextFileCapped("/etc/timezone", 1024), "");
    GLib.file_get_contents = () => [true, undefined];
    assert.equal(utils.readTextFileCapped("/etc/timezone", 1024), "");
    GLib.file_get_contents = () => { throw new Error("EACCES"); };
    assert.equal(utils.readTextFileCapped("/etc/timezone", 1024), "");
    assert.equal(logged.length, 1, "and none of those is an oversize report");

    // a GLib that hands back a string rather than bytes is read as it is
    GLib.file_get_contents = () => [true, "Asia/Tokyo\n"];
    assert.equal(utils.readTextFileCapped("/etc/timezone", 1024), "Asia/Tokyo\n");

    GLib.file_get_contents = original;
});
