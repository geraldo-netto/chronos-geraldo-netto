const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const UUID = "chronos@geraldo-netto";
const execFileAsync = promisify(execFile);
const RELEASE_FILES = [
    "package.json",
    "package-lock.json",
    path.join("files", UUID, "metadata.json"),
    "CHANGELOG.md"
];

async function makeReleaseFixture(t, mutate) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "chronos-release-"));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    await fs.mkdir(path.join(temporary, "files", UUID), { recursive: true });
    for (const relative of ["package.json", "package-lock.json", "CHANGELOG.md"]) {
        await fs.copyFile(path.join(ROOT, relative), path.join(temporary, relative));
    }
    await fs.copyFile(
        path.join(ROOT, "files", UUID, "metadata.json"),
        path.join(temporary, "files", UUID, "metadata.json"));
    if (mutate) {
        await mutate(temporary);
    }
    return temporary;
}

async function editJson(root, relative, edit) {
    const filePath = path.join(root, relative);
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    edit(parsed);
    await fs.writeFile(filePath, JSON.stringify(parsed, null, 2) + "\n");
}

async function editText(root, relative, edit) {
    const filePath = path.join(root, relative);
    await fs.writeFile(filePath, edit(await fs.readFile(filePath, "utf8")));
}

async function releaseSnapshot(root) {
    return Promise.all(RELEASE_FILES.map((relative) =>
        fs.readFile(path.join(root, relative), "utf8")));
}

test("release metadata, changelog, and an optional tag agree", async () => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { checkRelease } = await import(releaseUrl);

    assert.equal(await checkRelease(ROOT), "0.0.1");
    assert.equal(await checkRelease(ROOT, "v0.0.1"), "0.0.1");
    await assert.rejects(checkRelease(ROOT, "v0.0.2"), /does not match version v0\.0\.1/);
});

test("the release bump moves notes and updates every version owner", async (t) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "chronos-release-"));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    await fs.mkdir(path.join(temporary, "files", UUID), { recursive: true });
    for (const relative of ["package.json", "package-lock.json", "CHANGELOG.md"]) {
        await fs.copyFile(path.join(ROOT, relative), path.join(temporary, relative));
    }
    await fs.copyFile(
        path.join(ROOT, "files", UUID, "metadata.json"),
        path.join(temporary, "files", UUID, "metadata.json"));
    const changelogPath = path.join(temporary, "CHANGELOG.md");
    const changelog = await fs.readFile(changelogPath, "utf8");
    await fs.writeFile(changelogPath, changelog.replace(
        "## [Unreleased]\n", "## [Unreleased]\n\n### Fixed\n\n- A release-worthy fix.\n"));

    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { bumpRelease, checkRelease } = await import(releaseUrl);
    await bumpRelease(temporary, "0.0.2", { date: "2026-07-18" });

    const pkg = JSON.parse(await fs.readFile(path.join(temporary, "package.json"), "utf8"));
    const lock = JSON.parse(await fs.readFile(path.join(temporary, "package-lock.json"), "utf8"));
    const metadata = JSON.parse(await fs.readFile(
        path.join(temporary, "files", UUID, "metadata.json"), "utf8"));
    const updatedChangelog = await fs.readFile(changelogPath, "utf8");
    assert.equal(pkg.version, "0.0.2");
    assert.equal(lock.version, "0.0.2");
    assert.equal(lock.packages[""].version, "0.0.2");
    assert.equal(metadata.version, "0.0.2");
    assert.match(updatedChangelog, /## \[Unreleased\]\n\n## \[0\.0\.2\] - 2026-07-18/);
    assert.match(updatedChangelog, /## \[0\.0\.2\][\s\S]*A release-worthy fix/);
    assert.equal(await checkRelease(temporary, "v0.0.2"), "0.0.2");

    await assert.rejects(
        bumpRelease(temporary, "0.0.2", { date: "2026-07-19" }),
        /must be greater than 0\.0\.2/);
});

// T530 regression: these validators are the tag-gated release integrity check,
// and disabling them by mutation left the suite green — every guard gets its
// denied path.
const DENIED_RELEASE_STATES = [
    ["a drifted package.json version",
        (root) => editJson(root, "package.json", (pkg) => { pkg.version = "9.9.9"; }),
        /package\.json version 9\.9\.9 does not match metadata\.json 0\.0\.1/],
    ["a drifted package-lock.json version",
        (root) => editJson(root, "package-lock.json", (lock) => { lock.version = "9.9.9"; }),
        /package-lock\.json version 9\.9\.9 does not match/],
    ["a drifted package-lock.json root package version",
        (root) => editJson(root, "package-lock.json", (lock) => {
            lock.packages[""].version = "9.9.9";
        }),
        /package-lock\.json root package version 9\.9\.9 does not match/],
    ["a non-SemVer metadata version",
        (root) => editJson(root, path.join("files", UUID, "metadata.json"), (metadata) => {
            metadata.version = "0.0.1-rc1";
        }),
        /version must be strict SemVer/],
    ["a changelog without the dated release heading",
        (root) => editText(root, "CHANGELOG.md",
            (text) => text.replace(/^## \[0\.0\.1\] - \d{4}-\d{2}-\d{2}$/m, "## 0.0.1")),
        /CHANGELOG\.md has no dated 0\.0\.1 release heading/],
    ["a changelog without the Unreleased compare link",
        (root) => editText(root, "CHANGELOG.md",
            (text) => text.replace(/^\[Unreleased\]: .*$/m, "")),
        /CHANGELOG\.md Unreleased link does not start at v0\.0\.1/],
    ["a changelog without the release tag link",
        (root) => editText(root, "CHANGELOG.md",
            (text) => text.replace(/^\[0\.0\.1\]: .*$/m, "")),
        /CHANGELOG\.md has no v0\.0\.1 release link/]
];

test("the release check rejects every inconsistent release surface", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { checkRelease } = await import(releaseUrl);

    for (const [state, mutate, expected] of DENIED_RELEASE_STATES) {
        const root = await makeReleaseFixture(t, mutate);
        await assert.rejects(checkRelease(root), expected, `accepted ${state}`);
    }
});

const DENIED_BUMP_INPUTS = [
    ["a non-SemVer next version", undefined, "1.0", {},
        /version must be strict SemVer/],
    ["a malformed release date", undefined, "0.0.2", { date: "18-07-2026" },
        /release date must be YYYY-MM-DD/],
    ["an empty Unreleased section",
        (root) => editText(root, "CHANGELOG.md", (text) =>
            text.replace(/## \[Unreleased\][\s\S]*?(?=## \[0\.0\.1\])/, "## [Unreleased]\n\n")),
        "0.0.2", { date: "2026-07-18" },
        /Unreleased section needs at least one release-note bullet/],
    ["a changelog with no released version after Unreleased",
        (root) => editText(root, "CHANGELOG.md", (text) =>
            text.replace("## [Unreleased]\n", "") + "\n## [Unreleased]\n"),
        "0.0.2", { date: "2026-07-18" },
        /needs Unreleased followed by a released version/],
    ["an Unreleased compare link with trailing whitespace",
        (root) => editText(root, "CHANGELOG.md", (text) =>
            text.replace(/^(\[Unreleased\]: .*)$/m, "$1  ")),
        "0.0.2", { date: "2026-07-18" },
        /could not rewrite the exact Unreleased compare link/]
];

test("the release bump rejects bad input before touching any file", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { bumpRelease } = await import(releaseUrl);

    for (const [state, mutate, next, options, expected] of DENIED_BUMP_INPUTS) {
        const root = await makeReleaseFixture(t, mutate);
        const before = await releaseSnapshot(root);
        await assert.rejects(bumpRelease(root, next, options), expected, `accepted ${state}`);
        assert.deepEqual(await releaseSnapshot(root), before,
            `a rejected bump must not rewrite release files (${state})`);
    }
});

test("release recovery rejects malformed transaction journals", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { checkRelease } = await import(releaseUrl);

    for (const [name, manifest, expected] of [
        ["wrong target count", JSON.stringify({ version: 1, entries: [] }), /invalid target list/],
        ["wrong target name", JSON.stringify({
            version: 1,
            entries: RELEASE_FILES.map((relative, index) => ({
                target: index === 0 ? "wrong.json" : relative.split(path.sep).join("/"),
                before: "",
                after: ""
            }))
        }),
        /invalid target list/],
        ["invalid JSON", "{", /JSON|property name/]
    ]) {
        const root = await makeReleaseFixture(t);
        const transaction = path.join(root, ".chronos-release-transaction");
        await fs.mkdir(transaction);
        await fs.writeFile(path.join(transaction, "manifest.json"), manifest);
        await assert.rejects(checkRelease(root), expected, `accepted ${name}`);
    }
});

test("a failed transaction publish removes its staging directory", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { bumpRelease } = await import(releaseUrl);
    const root = await makeReleaseFixture(t, (fixture) =>
        editText(fixture, "CHANGELOG.md", (text) =>
            text.replace("## [Unreleased]\n", "## [Unreleased]\n\n- Ready.\n")));
    const transaction = path.join(root, ".chronos-release-transaction");
    await fs.mkdir(transaction);
    await fs.writeFile(path.join(transaction, "incomplete"), "");

    await assert.rejects(
        bumpRelease(root, "0.0.2", { date: "2026-07-18" }),
        (error) => error.code === "EEXIST" || error.code === "ENOTEMPTY");
    assert.deepEqual(
        (await fs.readdir(root)).filter((name) =>
            name.startsWith(".chronos-release-transaction-")),
        []);
});

test("release startup removes staging left before journal publication", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { checkRelease } = await import(releaseUrl);
    const root = await makeReleaseFixture(t);
    const staging = path.join(root, ".chronos-release-transaction-abandoned");
    await fs.mkdir(staging);
    await fs.writeFile(path.join(staging, "manifest.json"), "incomplete");
    const orphaned = RELEASE_FILES.map((relative) =>
        path.join(root, `${relative}.chronos-release-dead.tmp`));
    for (const temporary of orphaned) {
        await fs.writeFile(temporary, "incomplete");
    }
    const unrelated = path.join(root, "notes.chronos-release-dead.tmp");
    await fs.writeFile(unrelated, "keep");

    assert.equal(await checkRelease(root), "0.0.1");
    await assert.rejects(fs.access(staging));
    for (const temporary of orphaned) {
        await assert.rejects(fs.access(temporary));
    }
    await fs.access(unrelated);
    assert.match(await fs.readFile(path.join(ROOT, ".gitignore"), "utf8"),
        /^\*\.chronos-release-\*\.tmp$/m);
});

test("release cleanup never crosses a live command lock", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { checkRelease, readProcessStartTime } = await import(releaseUrl);
    const root = await makeReleaseFixture(t);
    const lock = path.join(root, ".chronos-release-lock");
    const staging = path.join(root, ".chronos-release-transaction-active");
    const startTime = await readProcessStartTime(process.pid);
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, startTime }));
    await fs.mkdir(staging);

    await assert.rejects(checkRelease(root),
        new RegExp(`another release command is running as process ${process.pid}`));
    await fs.access(staging);
    await fs.rm(lock);

    assert.equal(await checkRelease(root), "0.0.1");
    await assert.rejects(fs.access(staging));
});

test("release startup retires dead locks and rejects corrupt owners", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { checkRelease } = await import(releaseUrl);
    const root = await makeReleaseFixture(t);
    const lock = path.join(root, ".chronos-release-lock");
    await fs.writeFile(lock, JSON.stringify({ pid: 99_999_999, startTime: "1" }));

    assert.equal(await checkRelease(root), "0.0.1");
    await assert.rejects(fs.access(lock));

    for (const corrupt of [
        JSON.stringify({ pid: "unknown", startTime: "1" }),
        JSON.stringify({ pid: process.pid }),
        JSON.stringify({ pid: process.pid, startTime: "not-a-tick" }),
        "{"
    ]) {
        await fs.writeFile(lock, corrupt);
        await assert.rejects(checkRelease(root), /release lock has an invalid owner/);
        await fs.access(lock);
        await fs.rm(lock);
    }
});

test("release startup distinguishes a reused PID from the lock owner", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { checkRelease, readProcessStartTime } = await import(releaseUrl);
    const root = await makeReleaseFixture(t);
    const lock = path.join(root, ".chronos-release-lock");
    const currentStart = await readProcessStartTime(process.pid);
    const previousStart = (BigInt(currentStart) + 1n).toString();
    await fs.writeFile(lock,
        JSON.stringify({ pid: process.pid, startTime: previousStart }));

    assert.equal(await checkRelease(root), "0.0.1");
    await assert.rejects(fs.access(lock));
});

test("concurrent stale-lock retirement is idempotent", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { retireStaleLock } = await import(releaseUrl);
    const root = await makeReleaseFixture(t);
    const lock = path.join(root, ".chronos-release-lock");
    await fs.writeFile(lock, JSON.stringify({ pid: 99_999_999, startTime: "1" }));

    await Promise.all(Array.from({ length: 8 }, () => retireStaleLock(lock)));
    await assert.rejects(fs.access(lock));
    await retireStaleLock(lock);
    assert.deepEqual(
        (await fs.readdir(root)).filter((name) => name.startsWith(
            ".chronos-release-lock.stale-")),
        []);

    const unreadable = path.join(root, ".chronos-release-lock-directory");
    await fs.mkdir(unreadable);
    await assert.rejects(retireStaleLock(unreadable),
        (error) => error.code === "EISDIR");
});

test("process start identities parse the comm field safely", async () => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { parseProcessStartTime, readProcessStartTime } = await import(releaseUrl);
    const prefix = Array.from({ length: 19 }, (_unused, index) =>
        index === 0 ? "S" : String(index)).join(" ");

    assert.equal(parseProcessStartTime(`7 (a command) ${prefix} 4242 0`), "4242");
    assert.equal(parseProcessStartTime("missing command terminator"), null);
    assert.equal(parseProcessStartTime(null), null);
    assert.equal(parseProcessStartTime("7 (short) S 1"), null);
    assert.equal(await readProcessStartTime(7, async () =>
        `7 (a command) ${prefix} 4242 0`), "4242");
    await assert.rejects(readProcessStartTime(7, async () => "broken"),
        /unreadable start identity/);
    assert.equal(await readProcessStartTime(7, async () => {
        const error = new Error("gone");
        error.code = "ENOENT";
        throw error;
    }), null);
    await assert.rejects(readProcessStartTime(7, async () => {
        throw new Error("permission denied");
    }), /permission denied/);
});

test("an interrupted release transaction is completed before the next check", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { bumpRelease, checkRelease } = await import(releaseUrl);
    const interrupted = await makeReleaseFixture(t);
    const completed = await makeReleaseFixture(t);
    await bumpRelease(completed, "0.0.2", { date: "2026-07-18" });

    const before = await releaseSnapshot(interrupted);
    const after = await releaseSnapshot(completed);
    const entries = RELEASE_FILES.map((relative, index) => ({
        target: relative.split(path.sep).join("/"),
        before: before[index],
        after: after[index]
    }));
    const transaction = path.join(interrupted, ".chronos-release-transaction");
    await fs.mkdir(transaction);
    await fs.writeFile(path.join(transaction, "manifest.json"),
        JSON.stringify({ version: 1, entries }));
    await fs.writeFile(path.join(interrupted, RELEASE_FILES[0]), entries[0].after);

    assert.equal(await checkRelease(interrupted, "v0.0.2"), "0.0.2");
    await assert.rejects(fs.access(transaction), "the completed transaction is removed");
});

test("release recovery preserves files edited after interruption", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { bumpRelease, checkRelease } = await import(releaseUrl);
    const interrupted = await makeReleaseFixture(t);
    const completed = await makeReleaseFixture(t);
    await bumpRelease(completed, "0.0.2", { date: "2026-07-18" });
    const before = await releaseSnapshot(interrupted);
    const after = await releaseSnapshot(completed);
    const entries = RELEASE_FILES.map((relative, index) => ({
        target: relative.split(path.sep).join("/"),
        before: before[index],
        after: after[index]
    }));
    const transaction = path.join(interrupted, ".chronos-release-transaction");
    await fs.mkdir(transaction);
    await fs.writeFile(path.join(transaction, "manifest.json"),
        JSON.stringify({ version: 1, entries }));
    await editJson(interrupted, "package.json", (pkg) => {
        pkg.description = "manual edit made after interruption";
    });
    const edited = await fs.readFile(path.join(interrupted, "package.json"), "utf8");

    await assert.rejects(checkRelease(interrupted),
        /conflicts with modified files: package\.json/);
    assert.equal(await fs.readFile(path.join(interrupted, "package.json"), "utf8"), edited);
    await fs.access(transaction);
});

test("the release CLI dispatch rejects unknown commands and missing versions", async () => {
    const script = path.join(ROOT, "scripts", "release.mjs");
    const run = (args) => execFileAsync(process.execPath, [script, ...args]);

    const { stdout } = await run(["check"]);
    assert.match(stdout, /release metadata is consistent at v0\.0\.1/);
    await assert.rejects(run(["frobnicate"]),
        (error) => /unknown release command: frobnicate/.test(error.stderr));
    await assert.rejects(run(["bump"]),
        (error) => /usage: npm run release:bump/.test(error.stderr));
});
