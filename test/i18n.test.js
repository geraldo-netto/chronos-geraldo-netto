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

// T843: every msgid and msgstr fragment went through JSON.parse, and PO's
// escapes are not a subset of JSON's — gettext writes \a and \v, and read-po
// accepts octal \NNN and hexadecimal \xHH. A catalog carrying one threw a bare
// SyntaxError out of this gate and failed `i18n:check`, which `packaging` needs
// and `release` needs after it, naming neither the catalog nor the entry.
test("the catalog gate reads the PO escapes JSON cannot", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { unexpectedCommonSourceCopies } =
        await import(scriptUrl);
    // \a and \v are gettext's and not JSON's; \101 and \x41 are both "A"; \q is
    // no escape at all, which read-po warns about and keeps as the character
    const escaped = "\"bell:\\a vtab:\\v octal:\\101 hex:\\x41 kept:\\q " +
        "json:\\n\\t\\\"\\\\\"";
    const entry = (id, str) => `#: a.js:1\nmsgid ${id}\nmsgstr ${str}`;

    assert.deepEqual(unexpectedCommonSourceCopies([entry(escaped, escaped)]),
        ["bell:\u0007 vtab:\v octal:A hex:A kept:q json:\n\t\"\\"],
        "decoded once, and the same both sides, so it reads as a verbatim copy");

    // a folded msgid is one string, and every fragment of it is decoded
    assert.deepEqual(
        unexpectedCommonSourceCopies(["msgid \"\"\n\"one\\a\"\n\"two\"\n" +
            "msgstr \"one\\atwo\""]),
        ["one\u0007two"]);

    // msgfmt -c fronts this in the real pipeline, so a fragment that is not a
    // PO string means the gate was handed something that is not a catalog
    assert.throws(
        () => unexpectedCommonSourceCopies(["msgid \"unterminated\nmsgstr \"\""]),
        /not a PO string: "unterminated/);
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

test("untranslated entries and stale references leave catalogs unchanged", async (t) => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkI18n } = await import(scriptUrl);
    const root = await makeFixtureProject(t,
        potWith("2026-07-01 00:00+0000", '\nmsgid "New calendar"\nmsgstr ""\n'),
        potWith("2026-07-18 00:00+0000"));
    const catalog = path.join(root, "files", UUID, "po", "de.po");
    const original = '#: removed.js:1\n' + catalogWith("Hello", "Hallo") +
        '\nmsgid "Untranslated"\nmsgstr ""\n';
    await fs.writeFile(catalog, original);
    const calls = [];
    const run = async (command) => {
        calls.push(command);
        return {};
    };
    assert.equal(await checkI18n(root, run, ["de.po"]), 1);
    assert.deepEqual(calls, ["msgfmt", "msgattrib"]);
    assert.equal(await fs.readFile(catalog, "utf8"), original);
});

test("catalog compilation failures stop the composed gate", async (t) => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkI18n } = await import(scriptUrl);
    const root = await makeFixtureProject(t, potWith("unused"), potWith("unused"));
    await fs.writeFile(path.join(root, "files", UUID, "po", "de.po"), "malformed");
    const failure = new Error("invalid catalog syntax");
    await assert.rejects(checkI18n(root, async () => { throw failure; }, ["de.po"]),
        (error) => error === failure);
});

test("the i18n command checks catalogs and reports their count", async (t) => {
    const root = await makeFixtureProject(t,
        potWith("2026-07-01 00:00+0000"),
        potWith("2026-07-18 00:00+0000"));
    const catalog = path.join(root, "files", UUID, "po", "de.po");
    await fs.writeFile(catalog, 'msgid "Hello"\nmsgstr "Hallo"\n');
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkI18n, runI18nCommand } = await import(scriptUrl);
    const run = async (command) => command === "msgattrib" ? { stdout: "" } : {};

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
    for (const command of [
        "msgfmt", "msgattrib"
    ]) {
        const executable = path.join(bin, command);
        await fs.writeFile(executable, "#!/bin/sh\nexit 0\n");
        await fs.chmod(executable, 0o755);
    }

    const script = path.join(ROOT, "scripts", "check-i18n.mjs");
    const { stdout } = await execFileAsync(process.execPath, [script], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
    });
    assert.match(stdout, /\d+ catalogs valid; untranslated messages use English/);
});
