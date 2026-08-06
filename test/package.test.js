const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const UUID = "chronos@geraldo-netto";
const execFileAsync = promisify(execFile);

async function allEntries(root, prefix = "") {
    const entries = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        const relative = path.join(prefix, entry.name);
        entries.push({ relative, entry });
        if (entry.isDirectory()) {
            entries.push(...await allEntries(path.join(root, entry.name), relative));
        }
    }
    return entries;
}

test("the packaging command stages only the Cinnamon Spices applet tree", async (t) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "chronos-spices-"));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const output = path.join(temporary, UUID);
    const junk = path.join(ROOT, "files", UUID, "__pycache__", `package-${process.pid}.pyc`);
    await fs.mkdir(path.dirname(junk), { recursive: true });
    await fs.writeFile(junk, "ignored bytecode");
    t.after(() => fs.rm(junk, { force: true }));
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "package-spices.mjs")).href;
    const { buildSpicesPackage, listTrackedSpicesFiles } = await import(scriptUrl);

    await assert.rejects(
        buildSpicesPackage({ sourceRoot: ROOT, outputRoot: ROOT }),
        /cannot replace the source tree/,
        "a bad output path is rejected before anything is removed"
    );
    await buildSpicesPackage({ sourceRoot: ROOT, outputRoot: output });

    assert.deepEqual((await fs.readdir(output)).sort(),
        ["README.md", "files", "info.json", "screenshot.png"]);
    assert.deepEqual(await fs.readdir(path.join(output, "files")), [UUID]);

    const entries = await allEntries(output);
    assert.ok(entries.length > 4, "the applet sources were copied");
    assert.ok(entries.every(({ entry }) => !entry.isSymbolicLink()),
        "submission output contains real files, not delivery-fragile symlinks");

    const { stdout } = await execFileAsync("git", [
        "-C", ROOT, "ls-files", "-z", "--",
        "README.md", "files", "info.json", "screenshot.png"
    ], { encoding: "buffer" });
    const expectedFiles = stdout.toString("utf8").split("\0").filter(Boolean).sort();
    const actualFiles = entries
        .filter(({ entry }) => entry.isFile())
        .map(({ relative }) => relative.split(path.sep).join("/"))
        .sort();
    assert.deepEqual(actualFiles, expectedFiles,
        "the package is exactly the tracked Spices manifest");
    // Derived from the index rather than hand-listed: a subset drifted to half
    // the tracked 0755 entries once already, and the release job's mode check
    // was written from the same stale trio.
    const tracked = await listTrackedSpicesFiles(ROOT);
    const executables = tracked.filter(({ mode }) => mode === 0o755).map(({ relative }) => relative);
    assert.ok(executables.length >= 3, "the tracked executable set is not empty");
    for (const executable of executables) {
        const mode = (await fs.stat(path.join(output, ...executable.split("/")))).mode & 0o777;
        assert.equal(mode, 0o755, `${executable} keeps its executable index mode`);
    }
    await assert.rejects(fs.access(path.join(output, path.relative(ROOT, junk))),
        "ignored bytecode cannot enter the package");

    for (const developmentOnly of ["package.json", "TODO.md", "test", ".github", "agent-instructions"]) {
        await assert.rejects(fs.access(path.join(output, developmentOnly)));
    }
});

// A miniature Spices repository: the required root files plus one tracked
// applet source, git-initialized so the manifest comes from git ls-files like
// the real build.
async function makeSpicesFixture(t) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "chronos-spices-fixture-"));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const source = path.join(temporary, "source");
    const output = path.join(temporary, "output");
    const applet = path.join(source, "files", UUID);
    await fs.mkdir(path.join(applet, "6.0"), { recursive: true });
    await fs.writeFile(path.join(source, "README.md"), "readme");
    await fs.writeFile(path.join(source, "info.json"), "{}");
    await fs.writeFile(path.join(source, "screenshot.png"), "png");
    await fs.writeFile(path.join(applet, "applet.js"), "tracked applet");
    await execFileAsync("git", ["init", "--quiet", source]);
    await execFileAsync("git", [
        "-C", source, "add", "README.md", "info.json", "screenshot.png",
        "files/" + UUID + "/applet.js"
    ]);
    // The package is an index artifact, so group-writable checkout permissions
    // must not leak into the submission's tracked 0644 mode.
    await fs.chmod(path.join(applet, "applet.js"), 0o664);
    return { temporary, source, output, applet };
}

async function importPackager() {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "package-spices.mjs")).href;
    return import(scriptUrl);
}

async function makeArchiveTree(root, timestamp) {
    const applet = path.join(root, "chronos@geraldo-netto", "files", UUID);
    await fs.mkdir(path.join(applet, "6.0"), { recursive: true });
    const regular = path.join(applet, "metadata.json");
    const executable = path.join(applet, "6.0", "settings_widgets.py");
    await fs.writeFile(regular, '{"version":"1.2.3"}\n');
    await fs.writeFile(executable, "#!/usr/bin/python3\n");
    await fs.chmod(regular, 0o644);
    await fs.chmod(executable, 0o755);
    await fs.utimes(regular, timestamp, timestamp);
    await fs.utimes(executable, timestamp, timestamp);
    await fs.utimes(path.dirname(executable), timestamp, timestamp);
    await fs.utimes(path.dirname(regular), timestamp, timestamp);
}

test("packaging rejects malformed and conflicted Git index entries", async () => {
    const { parseTrackedSpicesFiles } = await importPackager();

    assert.throws(() => parseTrackedSpicesFiles(Buffer.from("not an index entry\0")),
        /invalid or conflicted Git index/);
    assert.throws(() => parseTrackedSpicesFiles(
        Buffer.from("100644 deadbeef 2\tREADME.md\0")),
    /invalid or conflicted Git index/);
    assert.throws(() => parseTrackedSpicesFiles(
        Buffer.from(`160000 deadbeef 0\tfiles/${UUID}/submodule\0`)),
    /unsupported Git index entry/);
    assert.deepEqual(parseTrackedSpicesFiles(
        Buffer.from("100755 deadbeef 0\tREADME.md\0")), [{
        relative: "README.md",
        mode: 0o755,
        indexMode: 0o100755,
        objectId: "deadbeef"
    }]);
});

test("packaging reads staged bytes instead of dirty worktree bytes", async (t) => {
    const { source, output, applet } = await makeSpicesFixture(t);
    await fs.writeFile(path.join(source, "README.md"), "unstaged readme");
    await fs.writeFile(path.join(applet, "applet.js"), "unstaged applet");

    const { buildSpicesPackage } = await importPackager();
    await buildSpicesPackage({ sourceRoot: source, outputRoot: output });

    assert.equal(await fs.readFile(path.join(output, "README.md"), "utf8"), "readme");
    assert.equal(await fs.readFile(
        path.join(output, "files", UUID, "applet.js"), "utf8"), "tracked applet");
});

test("the documented release sequence packages the committed bumped version", async (t) => {
    const { source, output, applet } = await makeSpicesFixture(t);
    for (const relative of ["package.json", "package-lock.json"]) {
        await fs.copyFile(path.join(ROOT, relative), path.join(source, relative));
    }
    await fs.copyFile(path.join(ROOT, "files", UUID, "metadata.json"),
        path.join(applet, "metadata.json"));
    await fs.mkdir(path.join(applet, "po"), { recursive: true });
    await fs.copyFile(path.join(ROOT, "files", UUID, "po", `${UUID}.pot`),
        path.join(applet, "po", `${UUID}.pot`));
    await execFileAsync("git", ["-C", source, "add", "."]);

    const releaseUrl = pathToFileURL(path.join(ROOT, "scripts", "release.mjs")).href;
    const { bumpRelease } = await import(releaseUrl);
    await bumpRelease(source, "0.0.2");
    // the same paths the README recipe stages, the template among them
    await execFileAsync("git", ["-C", source, "add",
        "package.json", "package-lock.json",
        `files/${UUID}/metadata.json`,
        `files/${UUID}/po/${UUID}.pot`]);
    await execFileAsync("git", ["-C", source,
        "-c", "user.name=Chronos Test", "-c", "user.email=chronos@example.invalid",
        "commit", "--quiet", "-m", "chore(release): 0.0.2"]);

    const { buildSpicesPackage } = await importPackager();
    await buildSpicesPackage({ sourceRoot: source, outputRoot: output });
    const packagedMetadata = JSON.parse(await fs.readFile(
        path.join(output, "files", UUID, "metadata.json"), "utf8"));
    assert.equal(packagedMetadata.version, "0.0.2");
    const packagedTemplate = await fs.readFile(
        path.join(output, "files", UUID, "po", `${UUID}.pot`), "utf8");
    assert.match(packagedTemplate,
        /^"Project-Id-Version: chronos@geraldo-netto 0\.0\.2\\n"$/m,
        "the submitted template names the version being submitted");
});

test("equal staged trees produce byte-identical normalized archives", async (t) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "chronos-archives-"));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const first = path.join(temporary, "first");
    const second = path.join(temporary, "second");
    await makeArchiveTree(first, new Date("2020-01-02T03:04:05Z"));
    await makeArchiveTree(second, new Date("2030-09-08T07:06:05Z"));

    const archiver = path.join(ROOT, "scripts", "archive-spices.sh");
    await execFileAsync(archiver, [first]);
    await execFileAsync(archiver, [second]);
    assert.deepEqual(
        await fs.readFile(path.join(first, "chronos-spices.tar")),
        await fs.readFile(path.join(second, "chronos-spices.tar")));

    const extracted = path.join(temporary, "extracted");
    await fs.mkdir(extracted);
    await execFileAsync("tar", ["-xf", path.join(first, "chronos-spices.tar"),
        "-C", extracted]);
    assert.equal((await fs.stat(path.join(extracted, "chronos@geraldo-netto", "files",
        UUID, "metadata.json"))).mode & 0o777, 0o644);
    assert.equal((await fs.stat(path.join(extracted, "chronos@geraldo-netto", "files",
        UUID, "6.0", "settings_widgets.py"))).mode & 0o777, 0o755);
});

test("the explicit manifest seam copies validated worktree files", async (t) => {
    const { source, output } = await makeSpicesFixture(t);
    const trackedFiles = [
        "README.md",
        `files/${UUID}/applet.js`,
        "info.json",
        "screenshot.png"
    ];

    const { buildSpicesPackage } = await importPackager();
    await buildSpicesPackage({ sourceRoot: source, outputRoot: output, trackedFiles });

    assert.equal(await fs.readFile(path.join(output, "README.md"), "utf8"), "readme");
    assert.equal(await fs.readFile(
        path.join(output, "files", UUID, "applet.js"), "utf8"), "tracked applet");
});

test("packaging rejects a tracked symlink that escapes the source tree", async (t) => {
    const { temporary, source, output, applet } = await makeSpicesFixture(t);
    await fs.writeFile(path.join(applet, "icon.png"), "tracked icon");
    await fs.symlink("../icon.png", path.join(applet, "6.0", "icon.png"));
    await fs.writeFile(path.join(applet, "ignored.pyc"), "ignored");
    await execFileAsync("git", [
        "-C", source, "add",
        "files/" + UUID + "/icon.png", "files/" + UUID + "/6.0/icon.png"
    ]);

    const { buildSpicesPackage } = await importPackager();
    await buildSpicesPackage({ sourceRoot: source, outputRoot: output });
    assert.equal(await fs.readFile(path.join(output, "files", UUID, "6.0", "icon.png"), "utf8"),
        "tracked icon");
    await assert.rejects(fs.access(path.join(output, "files", UUID, "ignored.pyc")));

    const secret = path.join(temporary, "host-secret");
    const leak = path.join(applet, "leak.txt");
    await fs.writeFile(secret, "must not ship");
    await fs.symlink(path.relative(path.dirname(leak), secret), leak);
    await execFileAsync("git", ["-C", source, "add", "files/" + UUID + "/leak.txt"]);

    await assert.rejects(
        buildSpicesPackage({ sourceRoot: source, outputRoot: output }),
        /symlink points outside the source tree/);
    assert.equal(await fs.readFile(path.join(output, "README.md"), "utf8"), "readme",
        "a rejected input leaves the last good package intact");
});

// T532 regression: only the lexical escape guard was exercised — the realpath
// guard is the one that catches a chain whose first hop stays in-tree, and it
// could be deleted with the suite green.
test("packaging rejects a link chain that resolves outside through an in-tree hop", async (t) => {
    const { temporary, source, output, applet } = await makeSpicesFixture(t);
    const secret = path.join(temporary, "host-secret");
    await fs.writeFile(secret, "must not ship");
    const hop = path.join(applet, "hop");
    await fs.symlink(secret, hop);
    await fs.symlink("hop", path.join(applet, "chained.txt"));
    await execFileAsync("git", [
        "-C", source, "add",
        "files/" + UUID + "/chained.txt", "files/" + UUID + "/hop"
    ]);

    const { buildSpicesPackage } = await importPackager();
    await assert.rejects(
        buildSpicesPackage({ sourceRoot: source, outputRoot: output }),
        /symlink points outside the source tree/);
});

test("packaging rejects a tracked symlink to an in-tree untracked file", async (t) => {
    const { source, output, applet } = await makeSpicesFixture(t);
    await fs.writeFile(path.join(applet, "untracked-notes.txt"), "not in the manifest");
    await fs.symlink("untracked-notes.txt", path.join(applet, "leaky.txt"));
    await execFileAsync("git", ["-C", source, "add", "files/" + UUID + "/leaky.txt"]);

    const { buildSpicesPackage } = await importPackager();
    await assert.rejects(
        buildSpicesPackage({ sourceRoot: source, outputRoot: output }),
        /symlink points to an untracked file/);
});

test("packaging rejects tracked symlink cycles", async (t) => {
    const { source, output, applet } = await makeSpicesFixture(t);
    await fs.symlink("cycle-b", path.join(applet, "cycle-a"));
    await fs.symlink("cycle-a", path.join(applet, "cycle-b"));
    await execFileAsync("git", [
        "-C", source, "add",
        "files/" + UUID + "/cycle-a", "files/" + UUID + "/cycle-b"
    ]);

    const { buildSpicesPackage } = await importPackager();
    await assert.rejects(
        buildSpicesPackage({ sourceRoot: source, outputRoot: output }),
        /source symlink cycle in Git index/);
});

test("packaging rejects invalid output shapes and symlink targets", async (t) => {
    const { temporary, source } = await makeSpicesFixture(t);
    const {
        rejectSymlinks, resolveSourceFile, validatePackageLayout
    } = await importPackager();
    const directory = path.join(source, "directory");
    const link = path.join(source, "directory-link");
    await fs.mkdir(directory);
    await fs.symlink("directory", link);

    await assert.rejects(
        resolveSourceFile(source, link, "directory-link", new Set(["directory"])),
        /does not resolve to a regular file/);

    const output = path.join(temporary, "invalid-output");
    await fs.mkdir(output);
    await fs.symlink(directory, path.join(output, "link"));
    await assert.rejects(rejectSymlinks(output), /packaged output contains a symlink/);
    await assert.rejects(validatePackageLayout(output), /unexpected Spices package layout/);

    for (const name of ["README.md", "info.json", "screenshot.png", "files"]) {
        await fs.rm(path.join(output, name), { recursive: true, force: true });
        await fs.mkdir(path.join(output, name));
    }
    await fs.rm(path.join(output, "link"));
    await assert.rejects(validatePackageLayout(output), /files\/ must contain only/);
});

test("the explicit manifest seam confines and dereferences source symlinks", async (t) => {
    const { temporary, source, applet } = await makeSpicesFixture(t);
    const { resolveSourceFile } = await importPackager();
    const targetRelative = `files/${UUID}/target.txt`;
    const target = path.join(applet, "target.txt");
    const safeLink = path.join(applet, "safe-link.txt");
    await fs.writeFile(target, "safe");
    await fs.symlink("target.txt", safeLink);

    const resolved = await resolveSourceFile(
        source, safeLink, `files/${UUID}/safe-link.txt`, new Set([targetRelative]));
    assert.equal(resolved.sourcePath, target);
    assert.equal(resolved.modeRelative, targetRelative);

    const secret = path.join(temporary, "host-secret");
    const outsideLink = path.join(applet, "outside-link.txt");
    await fs.writeFile(secret, "secret");
    await fs.symlink(secret, outsideLink);
    await assert.rejects(
        resolveSourceFile(source, outsideLink, "outside-link.txt", new Set()),
        /symlink points outside the source tree/);

    const hop = path.join(applet, "hop");
    const chained = path.join(applet, "chained");
    await fs.symlink(secret, hop);
    await fs.symlink("hop", chained);
    await assert.rejects(
        resolveSourceFile(source, chained, "chained", new Set(["hop"])),
        /symlink resolves outside the source tree/);

    const untracked = path.join(applet, "untracked.txt");
    const untrackedLink = path.join(applet, "untracked-link.txt");
    await fs.writeFile(untracked, "untracked");
    await fs.symlink("untracked.txt", untrackedLink);
    await assert.rejects(
        resolveSourceFile(source, untrackedLink, "untracked-link.txt", new Set()),
        /symlink points to an untracked file/);
});

const REQUIRED = ["README.md", "info.json", "screenshot.png"];
const INVALID_MANIFESTS = [
    ["a parent-traversal segment", [...REQUIRED, `files/${UUID}/../escape.js`],
        /invalid package manifest path/],
    ["a current-directory segment", [...REQUIRED, `files/${UUID}/./sneaky.js`],
        /invalid package manifest path/],
    ["an empty segment", [...REQUIRED, `files/${UUID}//sneaky.js`],
        /invalid package manifest path/],
    ["an empty path", [...REQUIRED, ""],
        /invalid package manifest path/],
    ["an absolute path", [...REQUIRED, "/etc/passwd"],
        /invalid package manifest path/],
    ["a path outside the Spices layout", [...REQUIRED, "files/other@applet/code.js"],
        /outside the declared Spices layout/],
    ["a duplicate entry", [...REQUIRED, "info.json"],
        /duplicate paths/],
    ["a missing required file", ["README.md", "info.json"],
        /missing screenshot\.png/],
    ["a directory entry", [...REQUIRED, `files/${UUID}/6.0`],
        /names a directory, not a file/]
];

test("packaging validates the manifest before touching the output", async (t) => {
    const { source, output } = await makeSpicesFixture(t);
    const { buildSpicesPackage } = await importPackager();

    for (const [shape, trackedFiles, expected] of INVALID_MANIFESTS) {
        await assert.rejects(
            buildSpicesPackage({ sourceRoot: source, outputRoot: output, trackedFiles }),
            expected, `accepted ${shape}`);
        await assert.rejects(fs.access(output),
            `a rejected manifest must not create output (${shape})`);
    }
});

test("the catalogue screenshot is the current Chronos popup capture", async () => {
    const png = await fs.readFile(path.join(ROOT, "screenshot.png"));

    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10],
        "the catalogue asset is a PNG");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [650, 595],
        "the inherited 640×420 calendar@ccprog capture is gone");
    assert.ok(png.length > 30000, "the capture contains the rendered popup, not an empty frame");
});

test("the packaging command builds and reports its artifact", async (t) => {
    const { source } = await makeSpicesFixture(t);
    const { runPackageCommand } = await importPackager();

    assert.match(await runPackageCommand(source), /Spices package staged at/);
    assert.equal(await fs.readFile(
        path.join(source, "dist", UUID, "files", UUID, "applet.js"), "utf8"),
    "tracked applet");
    assert.equal((await fs.stat(
        path.join(source, "dist", UUID, "files", UUID, "applet.js"))).mode & 0o777, 0o644);
});
