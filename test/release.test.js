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
    path.join("files", UUID, "po", `${UUID}.pot`)
];
const STALE_LOCK_TOKEN = "11111111-1111-4111-8111-111111111111";
const LIVE_LOCK_TOKEN = "22222222-2222-4222-8222-222222222222";

async function installReleaseLock(lockPath, owner) {
    const candidate = `${lockPath}.owner-${owner.token}`;
    await fs.writeFile(candidate, JSON.stringify(owner), { flag: "wx" });
    await fs.link(candidate, lockPath);
    return candidate;
}

async function makeReleaseFixture(t, mutate) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "chronos-release-"));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    await fs.mkdir(path.join(temporary, "files", UUID), { recursive: true });
    for (const relative of ["package.json", "package-lock.json"]) {
        await fs.copyFile(path.join(ROOT, relative), path.join(temporary, relative));
    }
    await fs.copyFile(
        path.join(ROOT, "files", UUID, "metadata.json"),
        path.join(temporary, "files", UUID, "metadata.json"));
    await fs.mkdir(path.join(temporary, "files", UUID, "po"), { recursive: true });
    await fs.copyFile(
        path.join(ROOT, "files", UUID, "po", `${UUID}.pot`),
        path.join(temporary, "files", UUID, "po", `${UUID}.pot`));
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

async function releaseSnapshot(root) {
    return Promise.all(RELEASE_FILES.map((relative) =>
        fs.readFile(path.join(root, relative), "utf8")));
}

async function git(root, ...args) {
    return execFileAsync("git", ["-C", root, ...args]);
}

async function initializeReleaseRepository(root) {
    await git(root, "init", "--quiet", "--initial-branch=develop");
    await git(root, "add", ".");
    await git(root, "-c", "user.name=Chronos Test",
        "-c", "user.email=chronos@example.invalid",
        "commit", "--quiet", "-m", "release fixture");
}

async function makeBumpedReleaseFixture(t) {
    const root = await makeReleaseFixture(t);
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { bumpRelease } = await import(releaseUrl);
    await bumpRelease(root, "0.0.2");
    return root;
}

test("release metadata and an optional tag agree", async () => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { checkRelease } = await import(releaseUrl);

    assert.equal(await checkRelease(ROOT), "0.0.1");
    await assert.rejects(checkRelease(ROOT, "v0.0.2"), /does not match version v0\.0\.1/);
});

test("release tags are annotated, checked out, and on the release branch", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { checkRelease } = await import(releaseUrl);

    const accepted = await makeBumpedReleaseFixture(t);
    await initializeReleaseRepository(accepted);
    await git(accepted, "-c", "user.name=Chronos Test",
        "-c", "user.email=chronos@example.invalid",
        "tag", "-a", "v0.0.2", "-m", "Chronos 0.0.2");
    assert.equal(await checkRelease(accepted, "v0.0.2", "develop"), "0.0.2");

    const missing = await makeBumpedReleaseFixture(t);
    await initializeReleaseRepository(missing);
    await assert.rejects(checkRelease(missing, "v0.0.2", "develop"),
        /release tag v0\.0\.2 does not exist/);

    const lightweight = await makeBumpedReleaseFixture(t);
    await initializeReleaseRepository(lightweight);
    await git(lightweight, "tag", "v0.0.2");
    await assert.rejects(checkRelease(lightweight, "v0.0.2", "develop"),
        /release tag v0\.0\.2 must be annotated/);

    const offBranch = await makeBumpedReleaseFixture(t);
    await initializeReleaseRepository(offBranch);
    await git(offBranch, "checkout", "--quiet", "-b", "candidate");
    await fs.writeFile(path.join(offBranch, "candidate.txt"), "not merged\n");
    await git(offBranch, "add", "candidate.txt");
    await git(offBranch, "-c", "user.name=Chronos Test",
        "-c", "user.email=chronos@example.invalid",
        "commit", "--quiet", "-m", "off-branch release");
    await git(offBranch, "-c", "user.name=Chronos Test",
        "-c", "user.email=chronos@example.invalid",
        "tag", "-a", "v0.0.2", "-m", "Chronos 0.0.2");
    await assert.rejects(checkRelease(offBranch, "v0.0.2", "develop"),
        /release tag v0\.0\.2 is not reachable from develop/);
});

test("the release bump updates every version owner", async (t) => {
    const temporary = await makeReleaseFixture(t);
    const manifestPath = path.join(temporary, "files", UUID, "metadata.json");
    const manifestBefore = await fs.readFile(manifestPath, "utf8");
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { bumpRelease, checkRelease } = await import(releaseUrl);
    await bumpRelease(temporary, "0.0.2");

    // The manifest was re-serialised wholesale, and `JSON.stringify(m, null, 4)`
    // expands `"cinnamon-version": ["6.0"]` to three lines: a one-value change
    // produced a four-line diff in the twelve-line file Cinnamon parses at load,
    // and the documented recipe stages it wholesale.
    const manifestAfter = await fs.readFile(manifestPath, "utf8");
    const changed = manifestBefore.split("\n")
        .map((line, index) => [line, manifestAfter.split("\n")[index]])
        .filter(([before, after]) => before !== after);
    assert.equal(manifestBefore.split("\n").length, manifestAfter.split("\n").length,
        "the bump must not reflow the shipped manifest");
    assert.deepEqual(changed,
        [['    "version": "0.0.1",', '    "version": "0.0.2",']],
        "exactly the version line changes");

    const pkg = JSON.parse(await fs.readFile(path.join(temporary, "package.json"), "utf8"));
    const lock = JSON.parse(await fs.readFile(path.join(temporary, "package-lock.json"), "utf8"));
    const metadata = JSON.parse(await fs.readFile(
        path.join(temporary, "files", UUID, "metadata.json"), "utf8"));
    assert.equal(pkg.version, "0.0.2");
    assert.equal(lock.version, "0.0.2");
    assert.equal(lock.packages[""].version, "0.0.2");
    assert.equal(metadata.version, "0.0.2");
    // po/makepot stamps metadata.json's version into the template header, and
    // the i18n gate regenerates the template and compares it. Left out of the
    // bump, the first release made that gate throw on a line nobody touched.
    const template = await fs.readFile(
        path.join(temporary, "files", UUID, "po", `${UUID}.pot`), "utf8");
    assert.match(template, /^"Project-Id-Version: chronos@geraldo-netto 0\.0\.2\\n"$/m);
    assert.equal(await checkRelease(temporary), "0.0.2");

    await assert.rejects(
        bumpRelease(temporary, "0.0.2"),
        /must be greater than 0\.0\.2/);
});

test("the translation template is a version owner the bump can patch", async () => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { patchTemplateVersion, templateVersion } = await import(releaseUrl);
    const header = 'msgstr ""\n"Project-Id-Version: chronos@geraldo-netto 1.0.0\\n"\n' +
        '"POT-Creation-Date: 2026-01-01\\n"\n';

    assert.equal(templateVersion(header), "1.0.0");
    assert.equal(patchTemplateVersion(header, "1.0.1"),
        header.replace("1.0.0", "1.0.1"));
    assert.equal(templateVersion('"Project-Id-Version: other 1.0.0\\n"'), null,
        "a template for another package is not this one's version owner");

    // silently writing it back unchanged would leave the header behind the
    // other owners and reopen exactly the stale-template failure
    assert.throws(() => patchTemplateVersion('msgstr ""\n', "1.0.1"),
        /could not be replaced in place/);
});

test("release:check rejects a template left behind the other version owners", async (t) => {
    const temporary = await makeReleaseFixture(t, async (root) => {
        const templatePath = path.join(root, "files", UUID, "po", `${UUID}.pot`);
        const template = await fs.readFile(templatePath, "utf8");
        await fs.writeFile(templatePath,
            template.replace(/^"Project-Id-Version: .*$/m,
                '"Project-Id-Version: chronos@geraldo-netto 9.9.9\\n"'));
    });
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { checkRelease } = await import(releaseUrl);

    await assert.rejects(checkRelease(temporary),
        /po\/chronos@geraldo-netto\.pot version 9\.9\.9 does not match metadata\.json 0\.0\.1/);
});

test("an in-place manifest bump refuses a document it cannot patch", async () => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { patchManifestVersion } = await import(releaseUrl);
    assert.equal(patchManifestVersion('{\n    "version": "1.0.0",\n    "a": [1]\n}\n', "1.0.1"),
        '{\n    "version": "1.0.1",\n    "a": [1]\n}\n');
    // no top-level version line to patch: silently writing the document back
    // unchanged would leave the manifest behind the other version owners
    assert.throws(() => patchManifestVersion('{\n    "a": 1\n}\n', "1.0.1"),
        /could not be replaced in place/);
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
        /version must be strict SemVer/]
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
    ["a non-SemVer next version", "1.0", /version must be strict SemVer/]
];

test("the release bump rejects bad input before touching any file", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { bumpRelease } = await import(releaseUrl);

    for (const [state, next, expected] of DENIED_BUMP_INPUTS) {
        const root = await makeReleaseFixture(t);
        const before = await releaseSnapshot(root);
        await assert.rejects(bumpRelease(root, next), expected, `accepted ${state}`);
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
    const root = await makeReleaseFixture(t);
    const transaction = path.join(root, ".chronos-release-transaction");
    await fs.mkdir(transaction);
    await fs.writeFile(path.join(transaction, "incomplete"), "");

    await assert.rejects(
        bumpRelease(root, "0.0.2"),
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
    await fs.writeFile(lock, JSON.stringify({
        pid: process.pid, startTime, token: LIVE_LOCK_TOKEN
    }));
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
    await installReleaseLock(lock, {
        pid: 99_999_999, startTime: "1", token: STALE_LOCK_TOKEN
    });

    assert.equal(await checkRelease(root), "0.0.1");
    await assert.rejects(fs.access(lock));

    for (const corrupt of [
        JSON.stringify({ pid: "unknown", startTime: "1", token: LIVE_LOCK_TOKEN }),
        JSON.stringify({ pid: process.pid, token: LIVE_LOCK_TOKEN }),
        JSON.stringify({ pid: process.pid, startTime: "not-a-tick", token: LIVE_LOCK_TOKEN }),
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
    await installReleaseLock(lock, {
        pid: process.pid, startTime: previousStart, token: STALE_LOCK_TOKEN
    });

    assert.equal(await checkRelease(root), "0.0.1");
    await assert.rejects(fs.access(lock));
});

test("concurrent stale-lock retirement is idempotent", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { retireStaleLock } = await import(releaseUrl);
    const root = await makeReleaseFixture(t);
    const lock = path.join(root, ".chronos-release-lock");
    await installReleaseLock(lock, {
        pid: 99_999_999, startTime: "1", token: STALE_LOCK_TOKEN
    });

    await Promise.all(Array.from({ length: 8 }, () => retireStaleLock(lock)));
    await assert.rejects(fs.access(lock));
    await retireStaleLock(lock);
    assert.deepEqual(
        (await fs.readdir(root)).filter((name) =>
            name.startsWith(".chronos-release-lock")),
        []);

    const unreadable = path.join(root, ".chronos-release-lock-directory");
    await fs.mkdir(unreadable);
    await assert.rejects(retireStaleLock(unreadable),
        (error) => error.code === "EISDIR");
});

test("release lock claims recover at both removal crash points", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { checkRelease, lockClaimPath } = await import(releaseUrl);
    const owner = { pid: 99_999_999, startTime: "1", token: STALE_LOCK_TOKEN };
    const claimant = { pid: 99_999_998, startTime: "1", token: LIVE_LOCK_TOKEN };
    const artifacts = async (root) => (await fs.readdir(root))
        .filter((name) => name.startsWith(".chronos-release-lock"));

    const beforeUnlink = await makeReleaseFixture(t);
    const beforeLock = path.join(beforeUnlink, ".chronos-release-lock");
    const beforeCandidate = await installReleaseLock(beforeLock, owner);
    const beforeClaim = lockClaimPath(beforeCandidate, "stale", claimant);
    await fs.rename(beforeCandidate, beforeClaim);

    assert.equal(await checkRelease(beforeUnlink), "0.0.1");
    assert.deepEqual(await artifacts(beforeUnlink), [],
        "a claim left before lock unlink is resumed and removed");

    const afterUnlink = await makeReleaseFixture(t);
    const afterLock = path.join(afterUnlink, ".chronos-release-lock");
    const afterCandidate = await installReleaseLock(afterLock, owner);
    const afterClaim = lockClaimPath(afterCandidate, "stale", claimant);
    await fs.rename(afterCandidate, afterClaim);
    await fs.rm(afterLock);
    const malformedClaim = `${afterCandidate}.claim-broken`;
    await fs.writeFile(malformedClaim, "not a claim");

    assert.equal(await checkRelease(afterUnlink), "0.0.1");
    assert.deepEqual(await artifacts(afterUnlink), [path.basename(malformedClaim)],
        "the next owner collects only a well-formed orphaned claim");
    await fs.rm(malformedClaim);

    const legacy = await makeReleaseFixture(t);
    const legacyLock = path.join(legacy, ".chronos-release-lock");
    const legacyCandidate = await installReleaseLock(legacyLock, owner);
    await fs.rename(legacyCandidate, `${legacyCandidate}.stale-${LIVE_LOCK_TOKEN}`);

    assert.equal(await checkRelease(legacy), "0.0.1");
    assert.deepEqual(await artifacts(legacy), [],
        "claims from the previous release protocol remain recoverable");
});

test("a live release-lock claimant cannot be stolen", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { lockClaimPath, readProcessStartTime, retireStaleLock } = await import(releaseUrl);
    const root = await makeReleaseFixture(t);
    const lock = path.join(root, ".chronos-release-lock");
    const owner = { pid: 99_999_999, startTime: "1", token: STALE_LOCK_TOKEN };
    const candidate = await installReleaseLock(lock, owner);
    const claimant = {
        pid: process.pid,
        startTime: await readProcessStartTime(process.pid),
        token: LIVE_LOCK_TOKEN
    };
    const claim = lockClaimPath(candidate, "stale", claimant);
    await fs.rename(candidate, claim);

    await retireStaleLock(lock);

    await assert.doesNotReject(() => fs.access(lock));
    await assert.doesNotReject(() => fs.access(claim));
});

test("stale retirement cannot remove a replacement live lock", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { retireStaleLock, readProcessStartTime } = await import(releaseUrl);
    const root = await makeReleaseFixture(t);
    const lock = path.join(root, ".chronos-release-lock");
    await installReleaseLock(lock, {
        pid: 99_999_999, startTime: "1", token: STALE_LOCK_TOKEN
    });

    let inspected;
    const inspectedPromise = new Promise((resolve) => { inspected = resolve; });
    let continueRetirement;
    const continuePromise = new Promise((resolve) => { continueRetirement = resolve; });
    const delayed = retireStaleLock(lock, async () => {
        inspected();
        await continuePromise;
        return null;
    });
    await inspectedPromise;

    await retireStaleLock(lock);
    const startTime = await readProcessStartTime(process.pid);
    const liveOwner = { pid: process.pid, startTime, token: LIVE_LOCK_TOKEN };
    const liveCandidate = await installReleaseLock(lock, liveOwner);
    continueRetirement();
    await delayed;

    assert.deepEqual(JSON.parse(await fs.readFile(lock, "utf8")), liveOwner);
    await fs.access(liveCandidate);
    await fs.rm(lock);
    await fs.rm(liveCandidate);
});

test("release cleanup removes only its own lock identity", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { removeOwnedLock } = await import(releaseUrl);
    const root = await makeReleaseFixture(t);
    const lockPath = path.join(root, ".chronos-release-lock");
    const oldOwner = { pid: 99_999_999, startTime: "1", token: STALE_LOCK_TOKEN };
    const oldCandidate = `${lockPath}.owner-${oldOwner.token}`;
    await fs.writeFile(oldCandidate, JSON.stringify(oldOwner));

    const liveOwner = { pid: process.pid, startTime: "1", token: LIVE_LOCK_TOKEN };
    const liveCandidate = await installReleaseLock(lockPath, liveOwner);
    assert.equal(await removeOwnedLock({
        lockPath, candidate: oldCandidate, owner: oldOwner
    }, "release"), false);
    assert.deepEqual(JSON.parse(await fs.readFile(lockPath, "utf8")), liveOwner);

    await fs.rm(lockPath);
    await fs.rm(liveCandidate);
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
    await bumpRelease(completed, "0.0.2");

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

    assert.equal(await checkRelease(interrupted), "0.0.2");
    await assert.rejects(fs.access(transaction), "the completed transaction is removed");
});

test("release recovery preserves files edited after interruption", async (t) => {
    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { bumpRelease, checkRelease } = await import(releaseUrl);
    const interrupted = await makeReleaseFixture(t);
    const completed = await makeReleaseFixture(t);
    await bumpRelease(completed, "0.0.2");
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
