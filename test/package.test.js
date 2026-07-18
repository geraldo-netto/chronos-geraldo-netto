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
    const { buildSpicesPackage } = await import(scriptUrl);

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
    for (const executable of [
        "files/chronos@geraldo-netto/5.4/settings_widgets.py",
        "files/chronos@geraldo-netto/settings_widgets_common.py",
        "files/chronos@geraldo-netto/po/makepot"
    ]) {
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
    await fs.mkdir(path.join(applet, "5.4"), { recursive: true });
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

test("packaging rejects malformed and conflicted Git index entries", async () => {
    const { parseTrackedSpicesFiles } = await importPackager();

    assert.throws(() => parseTrackedSpicesFiles(Buffer.from("not an index entry\0")),
        /invalid or conflicted Git index/);
    assert.throws(() => parseTrackedSpicesFiles(
        Buffer.from("100644 deadbeef 2\tREADME.md\0")),
    /invalid or conflicted Git index/);
});

test("packaging rejects a tracked symlink that escapes the source tree", async (t) => {
    const { temporary, source, output, applet } = await makeSpicesFixture(t);
    await fs.writeFile(path.join(applet, "icon.png"), "tracked icon");
    await fs.symlink("../icon.png", path.join(applet, "5.4", "icon.png"));
    await fs.writeFile(path.join(applet, "ignored.pyc"), "ignored");
    await execFileAsync("git", [
        "-C", source, "add",
        "files/" + UUID + "/icon.png", "files/" + UUID + "/5.4/icon.png"
    ]);

    const { buildSpicesPackage } = await importPackager();
    await buildSpicesPackage({ sourceRoot: source, outputRoot: output });
    assert.equal(await fs.readFile(path.join(output, "files", UUID, "5.4", "icon.png"), "utf8"),
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
    await fs.symlink(path.relative(path.dirname(hop), secret), hop);
    await fs.symlink("hop", path.join(applet, "chained.txt"));
    await execFileAsync("git", ["-C", source, "add", "files/" + UUID + "/chained.txt"]);

    const { buildSpicesPackage } = await importPackager();
    await assert.rejects(
        buildSpicesPackage({ sourceRoot: source, outputRoot: output }),
        /symlink resolves outside the source tree/);
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
    ["a directory entry", [...REQUIRED, `files/${UUID}/5.4`],
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
