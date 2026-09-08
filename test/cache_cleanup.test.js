const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cleanup = import("../scripts/cleanup-calendar-cache.mjs");

function fixture(context) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-cleanup-test-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cacheDir = path.join(root, "cache");
    const settingsDir = path.join(root, "settings");
    fs.mkdirSync(cacheDir);
    fs.mkdirSync(settingsDir);
    return { root, cacheDir, settingsDir };
}

function profile(dirs, id, country, extras = []) {
    fs.writeFileSync(path.join(dirs.settingsDir, `${id}.json`), JSON.stringify({
        country: { value: country }, "extra-country-calendars": { value: extras }
    }));
}

function cache(dirs, name, content = "{}") {
    fs.writeFileSync(path.join(dirs.cacheDir, name), content);
}

test("cleanup preserves every profile selection and previews only canonical inactive pair files", async (context) => {
    const { inspectCleanup, applyCleanup } = await cleanup;
    const dirs = fixture(context);
    profile(dirs, 1, "ita", [{ country: "usa", region: " NY " }]);
    profile(dirs, 2, "cze", [{ country: "can", region: "on", enabled: false }]);
    fs.writeFileSync(path.join(dirs.settingsDir, "3.json"), JSON.stringify({
        country: { value: "usa" }, region_usa: { value: "ca" }
    }));
    const kept = ["holidays.json", "enrico.json", "calendar-ita-global.json",
        "calendar-usa-ny.json", "calendar-usa-ca.json", "calendar-cze-global.json", "calendar-can-on.json",
        "calendar-usa-unknown.json", "calendar-xxx-global.json"];
    kept.forEach((name) => cache(dirs, name));
    cache(dirs, "calendar-fra-global.json");
    fs.symlinkSync("holidays.json", path.join(dirs.cacheDir, "calendar-deu-global.json"));
    const plan = inspectCleanup(dirs);
    assert.deepEqual(plan.candidates.map((file) => path.basename(file.path)), ["calendar-fra-global.json"]);
    assert.ok(fs.existsSync(plan.candidates[0].path), "preview does not delete anything");
    assert.deepEqual(applyCleanup(plan, () => false), [path.join(dirs.cacheDir, "calendar-fra-global.json")]);
    kept.forEach((name) => assert.ok(fs.existsSync(path.join(dirs.cacheDir, name))));
    assert.ok(fs.lstatSync(path.join(dirs.cacheDir, "calendar-deu-global.json")).isSymbolicLink());
});

test("locale-inferred profiles conservatively protect every scoped cache", async (context) => {
    const { inspectCleanup } = await cleanup;
    const dirs = fixture(context);
    cache(dirs, "calendar-fra-global.json");
    profile(dirs, 1, "");
    assert.deepEqual(inspectCleanup(dirs).candidates, []);
    fs.writeFileSync(path.join(dirs.settingsDir, "1.json"), "{}");
    assert.deepEqual(inspectCleanup(dirs).candidates, []);
});

test("running Cinnamon, changed profiles, and replaced cache files stop deletion", async (context) => {
    const { inspectCleanup, applyCleanup } = await cleanup;
    const dirs = fixture(context);
    profile(dirs, 1, "none");
    cache(dirs, "calendar-fra-global.json");
    const plan = inspectCleanup(dirs);
    assert.throws(() => applyCleanup(plan, () => true), /Log out of Cinnamon/);
    profile(dirs, 1, "fra");
    assert.throws(() => applyCleanup(plan, () => false), /profiles changed/);
    profile(dirs, 1, "none");
    cache(dirs, "calendar-fra-global.json", "changed");
    assert.throws(() => applyCleanup(plan, () => false), /candidate cache changed/);
    assert.ok(fs.existsSync(plan.candidates[0].path));
});

test("corrupt or unreadable profiles abort cleanup instead of assuming no selections", async (context) => {
    const { inspectCleanup } = await cleanup;
    const dirs = fixture(context);
    const file = path.join(dirs.settingsDir, "1.json");
    const malformed = ["not json", "null", "[]", '{"country":{}}',
        '{"country":{"value":null}}', '{"country":{"value":"unknown"}}',
        '{"country":{"value":"none"},"extra-country-calendars":{"value":{}}}',
        " ".repeat(1024 * 1024 + 1)];
    for (const contents of malformed) {
        fs.writeFileSync(file, contents);
        assert.throws(() => inspectCleanup(dirs));
    }
    fs.unlinkSync(file);
    fs.symlinkSync("missing", file);
    assert.throws(() => inspectCleanup(dirs), /Unsafe/);
});

test("missing folders are empty and non-directory paths fail closed", async (context) => {
    const { inspectCleanup } = await cleanup;
    const dirs = fixture(context);
    fs.rmdirSync(dirs.cacheDir);
    fs.rmdirSync(dirs.settingsDir);
    assert.deepEqual(inspectCleanup(dirs).candidates, []);
    fs.writeFileSync(dirs.settingsDir, "file");
    assert.throws(() => inspectCleanup(dirs), /Not a directory/);
});

test("process checks cover other instances, owners, exiting processes, and inaccessible metadata", async (context) => {
    const { cinnamonRunning } = await cleanup;
    const { root } = fixture(context);
    const processDir = path.join(root, "123");
    fs.mkdirSync(processDir);
    assert.equal(cinnamonRunning(root), false, "a process exiting before comm can be read is harmless");
    fs.writeFileSync(path.join(processDir, "comm"), "cinnamon\n");
    assert.equal(cinnamonRunning(root), true);
    assert.equal(cinnamonRunning(root, process.getuid() + 1), false);
    fs.writeFileSync(path.join(processDir, "comm"), "cinnamon-session\n");
    assert.equal(cinnamonRunning(root), true);
    fs.writeFileSync(path.join(processDir, "comm"), "node\n");
    assert.equal(cinnamonRunning(root), false);
    fs.unlinkSync(path.join(processDir, "comm"));
    fs.mkdirSync(path.join(processDir, "comm"));
    assert.throws(() => cinnamonRunning(root), /EISDIR/);
    assert.throws(() => cinnamonRunning(path.join(root, "missing")), /ENOENT/);
    assert.equal(typeof cinnamonRunning(), "boolean", "the real process check is read-only");
});

test("the command defaults to preview and exposes explicit paths and help", async (context) => {
    const { run, defaultDirectories } = await cleanup;
    const dirs = fixture(context);
    const output = [];
    run(["--help"], (line) => output.push(line));
    assert.match(output.pop(), /Preview.*--cache-dir/s);
    const args = ["--cache-dir", dirs.cacheDir, "--settings-dir", dirs.settingsDir];
    cache(dirs, "calendar-fra-global.json");
    run(args, (line) => output.push(line));
    assert.match(output[0], /Would remove 1/);
    assert.ok(fs.existsSync(path.join(dirs.cacheDir, "calendar-fra-global.json")));
    profile(dirs, 1, "fra");
    run([...args, "--apply"], (line) => output.push(line));
    assert.match(output.at(-1), /Removed 0/);
    assert.throws(() => run(["--unknown"]), /Unknown option/);
    assert.ok(defaultDirectories({}).cacheDir.endsWith(".cache/chronos@geraldo-netto"));
    assert.equal(defaultDirectories({ XDG_CACHE_HOME: "/tmp/cache", XDG_CONFIG_HOME: "/tmp/config" }).settingsDir,
        "/tmp/config/cinnamon/spices/chronos@geraldo-netto");
});
