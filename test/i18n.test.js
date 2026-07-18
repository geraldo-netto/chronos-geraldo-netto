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

function potWith(dateStamp, extraEntry = "") {
    return 'msgid ""\n' +
        'msgstr ""\n' +
        `"Project-Id-Version: ${UUID} 0.0.1\\n"\n` +
        `"POT-Creation-Date: ${dateStamp}\\n"\n` +
        '"Content-Type: text/plain; charset=UTF-8\\n"\n' +
        "\n" +
        'msgid "Hello"\n' +
        'msgstr ""\n' +
        extraEntry;
}

// A project tree whose po/makepot is a stub that "regenerates" a fixed pot, so
// the composed copy-regenerate-compare flow runs for real without Cinnamon's
// extraction tooling; no .po catalogs keeps gettext out of it too.
async function makeFixtureProject(t, committedPot, regeneratedPot) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "chronos-i18n-fixture-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const poDir = path.join(root, "files", UUID, "po");
    await fs.mkdir(poDir, { recursive: true });
    await fs.writeFile(path.join(poDir, `${UUID}.pot`), committedPot);
    await fs.writeFile(path.join(poDir, "makepot"),
        "#!/bin/bash\n" +
        `cat > "$(dirname "$0")/${UUID}.pot" <<'POTEOF'\n` +
        regeneratedPot +
        "POTEOF\n");
    return root;
}

test("the catalog gate rejects combined active fuzzy flags", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { validateCatalog } = await import(scriptUrl);
    const calls = [];
    const run = async (command, args) => {
        calls.push([command, args]);
        return command === "msgattrib" ? {
            stdout: '#, fuzzy, javascript-format\nmsgid "%s"\nmsgstr "%s"\n'
        } : {};
    };

    await assert.rejects(
        validateCatalog("/catalogs/de.po", run),
        /de\.po contains active fuzzy translations/
    );
    assert.equal(calls[0][0], "msgfmt", "syntax is checked first");
    assert.deepEqual(calls[1], [
        "msgattrib",
        ["--only-fuzzy", "--no-obsolete", "/catalogs/de.po"]
    ]);
});

test("the catalog gate accepts output with no active fuzzy entries", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { validateCatalog } = await import(scriptUrl);
    const run = async (command) => command === "msgattrib" ? { stdout: "" } : {};

    await assert.doesNotReject(validateCatalog("/catalogs/de.po", run));
});

// T527 regression: the pot was regenerated without msgmerge, so four msgids
// were simply absent from every catalog — msgfmt and the fuzzy check stayed
// green while the settings dialog rendered them in English in every locale.
// msgcmp exits non-zero for a missing, fuzzy or untranslated msgid.
test("the catalog gate rejects a catalog that was never merged with the template", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkCatalogCurrent } = await import(scriptUrl);
    const calls = [];
    const run = async (command, args) => {
        calls.push([command, args]);
        throw new Error("msgcmp: found 4 fatal errors");
    };

    await assert.rejects(
        checkCatalogCurrent("/catalogs/de.po", "/catalogs/chronos.pot", run),
        /de\.po is not merged with the translation template/
    );
    assert.deepEqual(calls, [["msgcmp", ["/catalogs/de.po", "/catalogs/chronos.pot"]]]);
});

test("the catalog gate accepts a catalog msgcmp finds complete", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkCatalogCurrent } = await import(scriptUrl);

    await assert.doesNotReject(
        checkCatalogCurrent("/catalogs/de.po", "/catalogs/chronos.pot", async () => ({})));
});

// The freshness check is the repo's one fail-open gate: a bug that makes the
// committed-vs-regenerated comparison always equal ships a stale template
// forever while CI stays green. These run the composed flow for real.
test("the freshness gate rejects a committed template that trails the source", async (t) => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkI18n } = await import(scriptUrl);
    const root = await makeFixtureProject(t,
        potWith("2026-07-01 00:00+0000"),
        potWith("2026-07-18 00:00+0000", '\nmsgid "New source string"\nmsgstr ""\n'));

    await assert.rejects(checkI18n(root), /translation template is stale/);
});

test("the freshness gate accepts a template differing only in creation date", async (t) => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkI18n } = await import(scriptUrl);
    const root = await makeFixtureProject(t,
        potWith("2026-07-01 00:00+0000"),
        potWith("2026-07-18 00:00+0000"));

    assert.equal(await checkI18n(root), 0);
});

test("withoutCreationDate masks the creation date and nothing else", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { withoutCreationDate } = await import(scriptUrl);
    const july1 = potWith("2026-07-01 00:00+0000");
    const july18 = potWith("2026-07-18 00:00+0000");
    const drifted = potWith("2026-07-01 00:00+0000", '\nmsgid "Drifted"\nmsgstr ""\n');

    assert.match(withoutCreationDate(july1), /"POT-Creation-Date: <generated>\\n"/);
    assert.equal(withoutCreationDate(july1), withoutCreationDate(july18),
        "a regeneration that changes nothing but the stamp is not staleness");
    assert.notEqual(withoutCreationDate(july1), withoutCreationDate(drifted),
        "the normalization must not swallow real content differences");
});

test("the i18n command checks catalogs and reports their count", async (t) => {
    const root = await makeFixtureProject(t,
        potWith("2026-07-01 00:00+0000"),
        potWith("2026-07-18 00:00+0000"));
    const catalog = path.join(root, "files", UUID, "po", "de.po");
    await fs.writeFile(catalog, 'msgid "Hello"\nmsgstr "Hallo"\n');
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkI18n, runI18nCommand } = await import(scriptUrl);
    const run = async (command, args, options) => {
        if (command === "bash") {
            return execFileAsync(command, args, options);
        }
        return command === "msgattrib" ? { stdout: "" } : {};
    };

    assert.equal(await checkI18n(root, run), 1);
    const emptyRoot = await makeFixtureProject(t,
        potWith("2026-07-01 00:00+0000"),
        potWith("2026-07-18 00:00+0000"));
    assert.match(await runI18nCommand(emptyRoot),
        /0 catalogs valid; translation template is current/);
});

test("the i18n CLI dispatches the checked project", async (t) => {
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), "chronos-i18n-bin-"));
    t.after(() => fs.rm(bin, { recursive: true, force: true }));
    for (const command of ["msgfmt", "msgattrib", "msgcmp", "cinnamon-xlet-makepot"]) {
        const executable = path.join(bin, command);
        await fs.writeFile(executable, "#!/bin/sh\nexit 0\n");
        await fs.chmod(executable, 0o755);
    }

    const script = path.join(ROOT, "scripts", "check-i18n.mjs");
    const { stdout } = await execFileAsync(process.execPath, [script], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
    });
    assert.match(stdout, /\d+ catalogs valid; translation template is current/);
});
