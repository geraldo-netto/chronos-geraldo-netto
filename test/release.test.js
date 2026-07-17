const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const UUID = "chronos@geraldo-netto";

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
