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
    await assert.rejects(fs.access(path.join(output, path.relative(ROOT, junk))),
        "ignored bytecode cannot enter the package");

    const dereferencedIcon = await fs.lstat(path.join(output, "files", UUID, "5.4", "icon.png"));
    assert.equal(dereferencedIcon.isFile(), true,
        "the legacy in-tree icon link is delivered as a real file");

    for (const developmentOnly of ["package.json", "TODO.md", "test", ".github", "agent-instructions"]) {
        await assert.rejects(fs.access(path.join(output, developmentOnly)));
    }
});

test("packaging rejects a tracked symlink that escapes the source tree", async (t) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "chronos-spices-fixture-"));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const source = path.join(temporary, "source");
    const output = path.join(temporary, "output");
    const applet = path.join(source, "files", UUID);
    await fs.mkdir(path.join(applet, "5.4"), { recursive: true });
    await fs.writeFile(path.join(source, "README.md"), "readme");
    await fs.writeFile(path.join(source, "info.json"), "{}");
    await fs.writeFile(path.join(source, "screenshot.png"), "png");
    await fs.writeFile(path.join(applet, "icon.png"), "tracked icon");
    await fs.writeFile(path.join(applet, "applet.js"), "tracked applet");
    await fs.symlink("../icon.png", path.join(applet, "5.4", "icon.png"));
    await fs.writeFile(path.join(applet, "ignored.pyc"), "ignored");

    await execFileAsync("git", ["init", "--quiet", source]);
    await execFileAsync("git", [
        "-C", source, "add", "README.md", "info.json", "screenshot.png",
        "files/" + UUID + "/icon.png", "files/" + UUID + "/applet.js",
        "files/" + UUID + "/5.4/icon.png"
    ]);

    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "package-spices.mjs")).href;
    const { buildSpicesPackage } = await import(scriptUrl);
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

test("the catalogue screenshot is the current Chronos popup capture", async () => {
    const png = await fs.readFile(path.join(ROOT, "screenshot.png"));

    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10],
        "the catalogue asset is a PNG");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [650, 595],
        "the inherited 640×420 calendar@ccprog capture is gone");
    assert.ok(png.length > 30000, "the capture contains the rendered popup, not an empty frame");
});
