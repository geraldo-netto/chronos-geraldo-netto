const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const UUID = "chronos@geraldo-netto";

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

    for (const developmentOnly of ["package.json", "TODO.md", "test", ".github", "agent-instructions"]) {
        await assert.rejects(fs.access(path.join(output, developmentOnly)));
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
