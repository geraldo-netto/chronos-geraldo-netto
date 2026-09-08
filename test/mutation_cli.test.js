const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeRandom } = require("./helpers/prng");
const cli = import("../scripts/mutation.mjs");

test("manual mutation scopes select existing production files and ordinary tests", async () => {
    const { SCOPES, ROOT, configuration } = await cli;
    for (const [name, scope] of Object.entries(SCOPES)) {
        const config = configuration(name);
        assert.equal(config.mutate.length, 1, "each named scope is one production module");
        assert.match(config.mutate[0], /^files\/chronos@geraldo-netto\/[A-Za-z]+\.js$/);
        assert.ok([...scope.mutate, ...scope.tests].every((file) => fs.existsSync(path.join(ROOT, file))));
        assert.ok(scope.tests.every((file) => /^test\/[a-z_]+\.test\.js$/.test(file)));
        assert.equal(config.commandRunner.command, `node --test ${scope.tests.join(" ")}`);
        assert.equal(config.coverageAnalysis, "off");
        assert.equal(config.concurrency, 1);
        assert.equal(config.inPlace, false);
        assert.equal(config.thresholds.break, null);
        assert.deepEqual(config.reporters, ["clear-text", "html", "json"]);
        assert.match(config.htmlReporter.fileName, new RegExp(`/reports/${name}/`));
    }
});

test("scope parsing rejects unknown names and broadening overrides", async () => {
    const { parseArguments, configuration } = await cli;
    for (const args of [["../files"], ["__proto__"], ["constructor"],
        ["holiday-record", "--mutate", "**/*.js"], ["holiday-record", "--inPlace"],
        ["holiday-record", "--print-config", "extra"], ["--help", "extra"]]) {
        assert.throws(() => parseArguments(args));
    }
    assert.throws(() => configuration(null), /Unknown mutation scope/);
    assert.deepEqual(parseArguments(["holiday-record"]), { action: "run", scope: "holiday-record" });
});

test("fuzz: arbitrary scope names cannot select paths or trigger a campaign", async () => {
    const { main } = await cli;
    const random = makeRandom(938);
    let launches = 0;
    for (let index = 0; index < 200; index++) {
        const scope = `invalid-${index}-${random()}`;
        const status = main([scope], {
            out() {}, error() {}, run() { launches++; }
        });
        assert.equal(status, 2);
    }
    assert.equal(launches, 0);
});

test("help, listing, and configuration previews never launch the optional engine", async () => {
    const { main, SCOPES } = await cli;
    const messages = [];
    const io = {
        out: (message) => messages.push(message),
        error: (message) => assert.fail(message),
        run: () => assert.fail("inspection cannot start Stryker")
    };
    assert.equal(main([], io), 0);
    assert.match(messages.pop(), /maintainer-operated/);
    assert.equal(main(["--help"], io), 0);
    assert.match(messages.pop(), /--print-config/);
    assert.equal(main(["--list"], io), 0);
    assert.ok(Object.keys(SCOPES).every((scope) => messages[0].includes(scope)));
    messages.length = 0;
    assert.equal(main(["holiday-record", "--print-config"], io), 0);
    assert.deepEqual(JSON.parse(messages.pop()).mutate, ["files/chronos@geraldo-netto/holidayRecord.js"]);
});

function launcherIo(result) {
    const calls = [];
    return {
        calls,
        existsSync: () => true,
        mkdirSync: (...args) => calls.push(["mkdir", ...args]),
        rmSync: (...args) => calls.push(["remove", ...args]),
        writeFileSync: (...args) => calls.push(["write", ...args]),
        spawnSync: (...args) => {
            calls.push(["spawn", ...args]);
            return result;
        }
    };
}

test("manual launch builds the selected configuration and uses an argument array", async () => {
    const { ROOT, runCampaign } = await cli;
    const io = launcherIo({ status: 7 });
    assert.equal(runCampaign("holiday-record", io), 7);
    const configPath = path.join(ROOT, ".cache/chronos-mutation/config.json");
    const lockPath = path.join(ROOT, ".cache/chronos-mutation/campaign.lock");
    assert.deepEqual(io.calls[0], ["mkdir", path.dirname(configPath), { recursive: true }]);
    assert.deepEqual(io.calls[1], ["mkdir", lockPath], "lock creation must be exclusive");
    assert.equal(io.calls[2][1], path.join(lockPath, "owner.json"));
    assert.deepEqual(JSON.parse(io.calls[2][2]), { pid: process.pid, scope: "holiday-record" });
    assert.equal(io.calls[3][1], configPath);
    assert.deepEqual(JSON.parse(io.calls[3][2]).mutate, ["files/chronos@geraldo-netto/holidayRecord.js"]);
    assert.deepEqual(io.calls[4], ["spawn", process.execPath, [
        path.join(ROOT, "tools/mutation/node_modules/@stryker-mutator/core/bin/stryker.js"),
        "run", configPath
    ], { cwd: ROOT, stdio: "inherit", shell: false }]);
    assert.deepEqual(io.calls[5], ["remove", lockPath, { recursive: true, force: true }]);
});

test("overlapping launchers cannot overwrite another campaign's configuration", async () => {
    const { ROOT, runCampaign } = await cli;
    const io = launcherIo({ status: 0 });
    const lockPath = path.join(ROOT, ".cache/chronos-mutation/campaign.lock");
    let locked = false;
    io.mkdirSync = (directory, options) => {
        if (directory === lockPath && !options?.recursive) {
            if (locked) {
                throw Object.assign(new Error("exists"), { code: "EEXIST" });
            }
            locked = true;
        }
    };
    io.rmSync = () => { locked = false; };
    io.spawnSync = () => {
        assert.throws(() => runCampaign("religious-dates", io), /Another mutation campaign/);
        return { status: 0 };
    };
    assert.equal(runCampaign("holiday-record", io), 0);
    const writes = io.calls.filter(([operation]) => operation === "write");
    assert.equal(writes.length, 2, "only the owner and original configuration were written");
    assert.deepEqual(JSON.parse(writes[1][2]).mutate, ["files/chronos@geraldo-netto/holidayRecord.js"]);
    assert.equal(locked, false, "the owning campaign releases the lock");
});

test("failed lock acquisition never removes another owner's lock", async () => {
    const { runCampaign } = await cli;
    for (const code of ["EEXIST", "EACCES"]) {
        const io = launcherIo({ status: 0 });
        io.mkdirSync = (_directory, options) => {
            if (!options?.recursive) {
                throw Object.assign(new Error("cannot create lock"), { code });
            }
        };
        assert.throws(() => runCampaign("holiday-record", io));
        assert.deepEqual(io.calls, []);
    }
});

test("configuration and subprocess failures release the acquired campaign lock", async () => {
    const { ROOT, runCampaign } = await cli;
    for (const failingMethod of ["writeFileSync", "spawnSync"]) {
        const io = launcherIo({ status: 0 });
        io[failingMethod] = () => { throw new Error("operation failed"); };
        assert.throws(() => runCampaign("holiday-record", io), /operation failed/);
        assert.deepEqual(io.calls.at(-1), ["remove",
            path.join(ROOT, ".cache/chronos-mutation/campaign.lock"),
            { recursive: true, force: true }]);
    }
});

test("missing optional tools and launch failures are actionable without falling back to downloads", async () => {
    const { runCampaign, main } = await cli;
    const missing = launcherIo({ status: 0 });
    missing.existsSync = () => false;
    assert.throws(() => runCampaign("holiday-record", missing), /npm ci --prefix tools\/mutation/);
    assert.deepEqual(missing.calls, []);
    const failure = new Error("launch failed");
    assert.throws(() => runCampaign("holiday-record", launcherIo({ error: failure })), /launch failed/);
    assert.equal(runCampaign("holiday-record", launcherIo({ status: null })), 1);
    const errors = [];
    assert.equal(main(["holiday-record"], {
        out() {}, error: (message) => errors.push(message), run: () => { throw failure; }
    }), 2);
    assert.deepEqual(errors, ["launch failed"]);
});

test("the CLI entry point exposes only an explicit manual npm command", async () => {
    const { ROOT } = await cli;
    const result = spawnSync(process.execPath, ["scripts/mutation.mjs", "--help"], {
        cwd: ROOT, encoding: "utf8"
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /no Stryker execution/);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json")));
    assert.equal(pkg.scripts["mutation:manual"], "node scripts/mutation.mjs");
    const automatic = Object.entries(pkg.scripts).filter(([name]) => name !== "mutation:manual");
    assert.ok(automatic.every(([, command]) => !/mutation|stryker/i.test(command)));
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"), /mutation:manual|stryker/i);
});
