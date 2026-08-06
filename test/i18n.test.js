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

// T788: msgcmp compares msgids and nothing else, so all fifteen catalogs went
// on carrying 313 "#. 5.4->settings-schema.json->..." comments each — pointing
// translators at a tree deleted from the repository — while the gate printed
// "15 catalogs valid; translation template is current" and CI stayed green.
test("the catalog gate rejects source references the template no longer names", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { catalogReferenceDrift, checkCatalogReferences } = await import(scriptUrl);
    const pot = [
        "#. 6.0->settings-schema.json->show-week-numbers->description",
        "#: 6.0/calendar.js:348",
        "msgid \"Week numbers\"",
        "msgstr \"\""
    ].join("\n");
    const stale = [
        "#. 5.4->settings-schema.json->show-week-numbers->description",
        "#: 6.0/calendar.js:347",
        "msgid \"Week numbers\"",
        "msgstr \"Wochennummern\""
    ].join("\n");

    // the dead tree and the drifted line number are both drift, and the same
    // stale reference repeated across entries is reported once
    assert.deepEqual(catalogReferenceDrift(stale + "\n\n" + stale, pot), [
        "5.4->settings-schema.json->show-week-numbers->description",
        "6.0/calendar.js:347"
    ]);
    assert.deepEqual(catalogReferenceDrift(pot, pot), [],
        "a merged catalog carries the template's own references");
    // a translator comment is not a source reference, and neither is an
    // obsolete entry msgmerge parked at the end of the file
    assert.deepEqual(catalogReferenceDrift("# Übersetzt von jemandem\n#~ msgid \"gone\"", pot), []);

    const read = async (target) => (target.endsWith(".pot") ? pot : stale);
    await assert.rejects(
        checkCatalogReferences("/catalogs/de.po", "/catalogs/chronos.pot", read),
        /de\.po points translators at source the template does not name \(2 references\)/);
    await assert.doesNotReject(checkCatalogReferences(
        "/catalogs/de.po", "/catalogs/chronos.pot", async () => pot));
});

// T836: a "#:" run holds several references and gettext wraps it at 78 columns,
// so adding or renaming one repacks every line after it — and msgmerge and
// xgettext of different vintages pack them differently. Compared as raw lines,
// this gate could fail `packaging`, and therefore the tag-to-release chain, on a
// catalog whose references were all correct. templateDrift already compared
// tokens for that reason; this half had not.
test("the catalog gate is not failed by where a reference run wraps", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { catalogReferenceDrift } = await import(scriptUrl);
    const pot = ["#: a.js:1 b.js:2 c.js:3", "#: d.js:4",
        "msgid \"Week numbers\"", "msgstr \"\""].join("\n");
    const repacked = ["#: d.js:4 a.js:1", "#: b.js:2", "#: c.js:3",
        "msgid \"Week numbers\"", "msgstr \"Wochennummern\""].join("\n");

    assert.deepEqual(catalogReferenceDrift(repacked, pot), [],
        "same msgid, same places, a different pack");
    assert.deepEqual(
        catalogReferenceDrift(repacked.replace("c.js:3", "c.js:9"), pot), ["c.js:9"],
        "and a place the template does not name is still drift");
    // the reference belongs to the msgid it sits under: the same line under a
    // different entry is not the template naming it
    assert.deepEqual(
        catalogReferenceDrift(repacked.replace("Week numbers", "Weeks"), pot),
        ["a.js:1", "b.js:2", "c.js:3", "d.js:4"]);
});

test("the reference gate reports a bounded sample of a wholly stale catalog", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { checkCatalogReferences } = await import(scriptUrl);
    const stale = Array.from({ length: 9 }, (unused, index) =>
        `#: 5.4/calendar.js:${index}\nmsgid "String ${index}"\nmsgstr ""`).join("\n\n");
    const read = async (target) => (target.endsWith(".pot") ? "" : stale);

    await assert.rejects(
        checkCatalogReferences("/catalogs/de.po", "/catalogs/chronos.pot", read),
        /\(9 references\)[\s\S]*\.\.\.and 4 more/);
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

// T843: every msgid and msgstr fragment went through JSON.parse, and PO's
// escapes are not a subset of JSON's — gettext writes \a and \v, and read-po
// accepts octal \NNN and hexadecimal \xHH. A catalog carrying one threw a bare
// SyntaxError out of this gate and failed `i18n:check`, which `packaging` needs
// and `release` needs after it, naming neither the catalog nor the entry.
test("the catalog gate reads the PO escapes JSON cannot", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { unexpectedCommonSourceCopies, catalogReferenceDrift } =
        await import(scriptUrl);
    // \a and \v are gettext's and not JSON's; \101 and \x41 are both "A"; \q is
    // no escape at all, which read-po warns about and keeps as the character
    const escaped = "\"bell:\\a vtab:\\v octal:\\101 hex:\\x41 kept:\\q " +
        "json:\\n\\t\\\"\\\\\"";
    const entry = (id, str) => `#: a.js:1\nmsgid ${id}\nmsgstr ${str}`;

    assert.deepEqual(unexpectedCommonSourceCopies([entry(escaped, escaped)]),
        ["bell:\u0007 vtab:\v octal:A hex:A kept:q json:\n\t\"\\"],
        "decoded once, and the same both sides, so it reads as a verbatim copy");

    // ...and the same string is one entry key, so a merged catalog does not
    // look drifted because its msgid happens to carry an escape
    assert.deepEqual(
        catalogReferenceDrift(entry(escaped, escaped), entry(escaped, "\"\"")), []);

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

// T790: the comparison was byte-exact and both its inputs floated —
// `runs-on: ubuntu-latest` and an unversioned `apt-get install cinnamon
// gettext`. The committed template is generated on the maintainer's Cinnamon
// 6.6.9; the runner installs whatever the archive holds. xgettext decides where
// to wrap a "#:" run and how to fold a long msgid, and neither is content, so a
// generator swap could fail packaging — and the tag-to-release chain — on an
// unchanged repository.
test("the freshness gate compares extracted content, not xgettext's wrapping", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { templateDrift } = await import(scriptUrl);
    const header = 'msgid ""\nmsgstr ""\n"POT-Creation-Date: 2026-07-01 00:00+0000\\n"\n';
    const wrapped = header + "\n" +
        "#. 6.0->settings-schema.json->show-week-numbers->description\n" +
        "#: 6.0/calendar.js:348 6.0/eventView.js:45\n" +
        '#: worldclockData.js:20\nmsgid "Week numbers"\nmsgstr ""\n';
    const rewrapped = header.replace("07-01", "07-18") + "\n" +
        "#: worldclockData.js:20 6.0/calendar.js:348\n" +
        "#: 6.0/eventView.js:45\n" +
        "#. 6.0->settings-schema.json->show-week-numbers->description\n" +
        'msgid "Week numbers"\nmsgstr ""\n';

    assert.equal(templateDrift(wrapped, rewrapped), null,
        "same msgid, same places, different wrapping and order");

    // ...and everything that is content still fails
    assert.match(
        templateDrift(wrapped, rewrapped.replace("Week numbers", "Week no.")),
        /"Week no\." is in the source and not in the template/);
    assert.match(
        templateDrift(wrapped + '\n#: gone.js:1\nmsgid "Deleted"\nmsgstr ""\n', rewrapped),
        /"Deleted" is in the template and no longer in the source/);
    assert.match(
        templateDrift(wrapped, rewrapped.replace("calendar.js:348", "calendar.js:349")),
        /"Week numbers" is extracted from .*calendar\.js:349.*template says .*calendar\.js:348/);
    assert.match(
        templateDrift(wrapped, rewrapped.replace('"POT-Creation', '"Language: de\\n"\n"POT-Creation')),
        /header does not match/);
});

test("the freshness gate distinguishes a plural and a context from their base", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { templateEntries } = await import(scriptUrl);
    const pot = 'msgid ""\nmsgstr ""\n\n' +
        '#: a.js:1\nmsgid "Day"\nmsgid_plural "Days"\nmsgstr[0] ""\n\n' +
        '#: b.js:2\nmsgctxt "column"\nmsgid "Day"\nmsgstr ""\n\n' +
        '#: c.js:3\nmsgid "Day"\nmsgstr ""\n';

    const entries = templateEntries(pot);
    assert.equal(entries.size, 3, "the header is not an entry, and the three Days differ");
    assert.deepEqual([...entries.values()].sort(), ["a.js:1", "b.js:2", "c.js:3"]);
});

test("an entry extracted from nowhere is still compared", async () => {
    const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "check-i18n.mjs")).href;
    const { templateDrift } = await import(scriptUrl);
    const header = 'msgid ""\nmsgstr ""\n';
    const placed = header + '\n#: a.js:1\nmsgid "Loose"\nmsgstr ""\n';
    const loose = header + '\nmsgid "Loose"\nmsgstr ""\n';

    assert.match(templateDrift(placed, loose),
        /extracted from nowhere, and the template says a\.js:1/);
    assert.match(templateDrift(loose, placed),
        /extracted from a\.js:1, and the template says nowhere/);
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
    for (const command of [
        "msgfmt", "msgattrib", "msgcmp", "msgmerge", "cinnamon-xlet-makepot"
    ]) {
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
