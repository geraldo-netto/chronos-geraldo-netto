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

function catalogWith(msgid, msgstr) {
    return 'msgid ""\n' +
        'msgstr ""\n' +
        '"Content-Type: text/plain; charset=UTF-8\\n"\n' +
        "\n" +
        `msgid ${JSON.stringify(msgid)}\n` +
        `msgstr ${JSON.stringify(msgstr)}\n`;
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
        const error = new Error("msgcmp: found 4 fatal errors");
        error.code = 1;
        throw error;
    };

    await assert.rejects(
        checkCatalogCurrent("/catalogs/de.po", "/catalogs/chronos.pot", run),
        /de\.po is not merged with the translation template/
    );
    assert.deepEqual(calls, [["msgcmp", ["/catalogs/de.po", "/catalogs/chronos.pot"]]]);
});

test("the catalog gate reports a missing or crashed msgcmp as a tool failure", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkCatalogCurrent } = await import(scriptUrl);
    const failure = (fields) => async () => {
        throw Object.assign(new Error("spawn failed"), fields);
    };

    await assert.rejects(
        checkCatalogCurrent("/catalogs/de.po", "/catalogs/chronos.pot",
            failure({ code: "ENOENT" })),
        /msgcmp is unavailable: install gettext/
    );
    await assert.rejects(
        checkCatalogCurrent("/catalogs/de.po", "/catalogs/chronos.pot",
            failure({ signal: "SIGSEGV" })),
        /msgcmp crashed with signal SIGSEGV/
    );
    await assert.rejects(
        checkCatalogCurrent("/catalogs/de.po", "/catalogs/chronos.pot",
            failure({ code: "EACCES" })),
        /msgcmp could not run.*spawn failed/
    );
});

test("the catalog gate accepts a catalog msgcmp finds complete", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkCatalogCurrent } = await import(scriptUrl);

    await assert.doesNotReject(
        checkCatalogCurrent("/catalogs/de.po", "/catalogs/chronos.pot", async () => ({})));
});

test("the composed catalog gate rejects a source sentence copied by every locale", async (t) => {
    const root = await makeFixtureProject(t,
        potWith("2026-07-01 00:00+0000"),
        potWith("2026-07-18 00:00+0000"));
    const poDir = path.join(root, "files", UUID, "po");
    const sentence = "This sentence was copied from the source.";
    await Promise.all(["de.po", "fr.po"].map((name) =>
        fs.writeFile(path.join(poDir, name), catalogWith(sentence, sentence))));
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkI18n } = await import(scriptUrl);
    const run = async (command) => command === "msgattrib" ? { stdout: "" } : {};

    await assert.rejects(
        checkI18n(root, run, ["de.po", "fr.po"]),
        /every catalog copies these source messages verbatim.*This sentence/s
    );
});

test("the source-copy gate allows names and locale-specific invariants", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { unexpectedCommonSourceCopies } = await import(scriptUrl);
    const german = catalogWith("Chronos Calendar", "Chronos Calendar") +
        "\n" + catalogWith("Version %s", "Version %s");
    const french = catalogWith("Chronos Calendar", "Chronos Calendar") +
        "\n" + catalogWith("Version %s", "Version %s");
    const italian = catalogWith("Chronos Calendar", "Chronos Calendar") +
        "\n" + catalogWith("Version %s", "Versione %s");

    assert.deepEqual(unexpectedCommonSourceCopies([]), []);
    assert.deepEqual(unexpectedCommonSourceCopies([german, french, italian]), []);
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

    await assert.rejects(checkI18n(root, undefined, []), /translation template is stale/);
});

test("the freshness gate accepts a template differing only in creation date", async (t) => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkI18n } = await import(scriptUrl);
    const root = await makeFixtureProject(t,
        potWith("2026-07-01 00:00+0000"),
        potWith("2026-07-18 00:00+0000"));

    assert.equal(await checkI18n(root, undefined, []), 0);
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

    assert.equal(await checkI18n(root, run, ["de.po"]), 1);

    // An empty po/ used to print "0 catalogs valid" and exit 0: deleting,
    // renaming or mis-locating every catalog left the CI packaging job green
    // while the applet shipped untranslated.
    const emptyRoot = await makeFixtureProject(t,
        potWith("2026-07-01 00:00+0000"),
        potWith("2026-07-18 00:00+0000"));
    await assert.rejects(runI18nCommand(emptyRoot),
        /translation catalogs are missing from po\/: ca\.po, da\.po/);
});

test("the shipped locales are tracked, not discovered", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkCatalogInventory } = await import(scriptUrl);
    const expected = ["de.po", "fr.po"];

    assert.equal(checkCatalogInventory(["de.po", "fr.po"], expected), 2);
    assert.throws(() => checkCatalogInventory([], expected),
        /catalogs are missing from po\/: de\.po, fr\.po/);
    assert.throws(() => checkCatalogInventory(["de.po"], expected),
        /catalogs are missing from po\/: fr\.po/);
    // a new translation is welcome, but it is a deliberate addition to the list
    assert.throws(() => checkCatalogInventory(["de.po", "fr.po", "pl.po"], expected),
        /does not track: pl\.po; add them to EXPECTED_CATALOGS/);
});

test("every catalog in po/ is one the gate tracks", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkCatalogInventory } = await import(scriptUrl);
    const shipped = (await fs.readdir(path.join(ROOT, "files", UUID, "po")))
        .filter((name) => name.endsWith(".po")).sort();

    assert.equal(checkCatalogInventory(shipped), shipped.length);
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
