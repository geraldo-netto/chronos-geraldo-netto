const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

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
