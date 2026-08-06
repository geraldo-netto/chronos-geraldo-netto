// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const UUID = "chronos@geraldo-netto";
// The shipped locales, tracked rather than discovered. readdir() imposed no
// floor: deleting, renaming or mis-locating every catalog printed "0 catalogs
// valid" and exited 0, leaving the CI packaging job green while the applet
// shipped untranslated -- the one regression this gate exists to catch. Adding
// a translation is a deliberate act, so it is a deliberate edit here too.
const EXPECTED_CATALOGS = [
    "ca.po", "da.po", "de.po", "es.po", "fi.po", "fr.po", "hu.po", "it.po",
    "nl.po", "pt_BR.po", "ru.po", "sv.po", "tr.po", "vi.po", "zh_TW.po"
];
const SOURCE_COPY_ALLOWLIST = new Set([
    "%s — %s",
    "Chronos Calendar",
    "Claus Colloseus (ccprog)",
    "Geraldo Netto",
    "Simon Wiles (simonwiles)"
]);

// PO's escapes are not a subset of JSON's. gettext also writes \a and \v, and
// read-po accepts octal \NNN and hexadecimal \xHH; JSON.parse rejects all four.
// Every fragment used to go through JSON.parse, so a catalog carrying one threw
// a bare SyntaxError out of checkCatalogSourceCopies or catalogReferenceDrift
// and failed `i18n:check` — which `packaging` needs and `release` needs after it
// — with a message naming neither the catalog nor the entry.
const PO_ESCAPES = {
    a: "\u0007", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
    "\"": "\"", "\\": "\\"
};

function poEscapeValue(escape) {
    if (escape.startsWith("x")) {
        return String.fromCharCode(parseInt(escape.slice(1), 16));
    }
    if (/^[0-7]/.test(escape)) {
        return String.fromCharCode(parseInt(escape, 8));
    }
    // read-po warns and keeps the character; a gate is not the place to be
    // stricter about a catalog than the tool that compiles it
    return PO_ESCAPES[escape] ?? escape;
}

function poUnescape(text) {
    return text.replace(/\\(x[0-9A-Fa-f]+|[0-7]{1,3}|[\s\S])/g,
        (unused, escape) => poEscapeValue(escape));
}

// msgfmt -c runs over every catalog before anything here reads one, so a
// fragment this rejects means the gate was handed something that is not a
// catalog. Saying which line that was beats a parser error about a token.
function poStringFragment(fragment) {
    const quoted = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(fragment.trim());
    if (!quoted) {
        throw new Error(`not a PO string: ${fragment.trim()}`);
    }
    return poUnescape(quoted[1]);
}

function poField(block, name) {
    const lines = block.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`${name} "`));
    if (start < 0) {
        return null;
    }

    const fragments = [lines[start].slice(name.length + 1)];
    for (let index = start + 1; index < lines.length && lines[index].startsWith("\""); index++) {
        fragments.push(lines[index]);
    }
    return fragments.map(poStringFragment).join("");
}

function sourceCopies(catalog) {
    const copies = new Set();
    for (const block of catalog.split(/\n{2,}/)) {
        if (/^#,.*\bfuzzy\b/m.test(block)) {
            continue;
        }

        const msgid = poField(block, "msgid");
        const msgstr = poField(block, "msgstr");
        if (msgid && msgstr === msgid) {
            copies.add(msgid);
        }
    }
    return copies;
}

export function unexpectedCommonSourceCopies(catalogs) {
    if (catalogs.length === 0) {
        return [];
    }

    const common = sourceCopies(catalogs[0]);
    for (const catalog of catalogs.slice(1)) {
        const copies = sourceCopies(catalog);
        for (const msgid of common) {
            if (!copies.has(msgid)) {
                common.delete(msgid);
            }
        }
    }

    return Array.from(common)
        .filter((msgid) => !SOURCE_COPY_ALLOWLIST.has(msgid))
        .sort();
}

export async function checkCatalogSourceCopies(catalogPaths, read = readFile) {
    const catalogs = await Promise.all(
        catalogPaths.map((catalogPath) => read(catalogPath, "utf8")));
    const copied = unexpectedCommonSourceCopies(catalogs);
    if (copied.length > 0) {
        throw new Error(
            "every catalog copies these source messages verbatim:\n  " +
            copied.join("\n  "));
    }
}

export function checkCatalogInventory(catalogs, expected = EXPECTED_CATALOGS) {
    const found = new Set(catalogs);
    const missing = expected.filter((name) => !found.has(name));
    const unexpected = catalogs.filter((name) => !expected.includes(name));

    if (missing.length > 0) {
        throw new Error(
            `translation catalogs are missing from po/: ${missing.join(", ")}`);
    }
    if (unexpected.length > 0) {
        throw new Error(
            `po/ carries catalogs the gate does not track: ${unexpected.join(", ")}; ` +
            "add them to EXPECTED_CATALOGS in scripts/check-i18n.mjs");
    }
    return expected.length;
}

export function withoutCreationDate(pot) {
    return pot.replace(
        /^"POT-Creation-Date: [^"\\]*(?:\\.[^"\\]*)*\\n"$/m,
        "\"POT-Creation-Date: <generated>\\n\""); // NOSONAR [S7780] -- accepted compatible form
}

// The header block, which cinnamon-xlet-makepot writes from a literal dict and
// po/makepot then stamps our own credits into. Everything below it is entries.
export function templateHeader(pot) {
    const [header] = withoutCreationDate(pot).split(/\n{2,}/);
    return header;
}

// Everything a .pot says that is not formatting: which msgids it carries, and
// which places in the tree each one came from.
//
// The comparison used to be byte-exact over the whole file, and its two inputs
// float: `runs-on: ubuntu-latest` and an unversioned `apt-get install cinnamon
// gettext`. The committed template is generated on the maintainer's Cinnamon,
// the runner's is generated on whatever the archive holds that day, and the two
// were held to identical bytes. xgettext decides where to wrap a "#:" run and
// how to fold a long msgid; neither is content, and neither should be able to
// fail packaging - and therefore the tag-to-release chain - on an unchanged
// repository.
function referenceTokens(block) {
    const tokens = new Set();
    for (const line of block.split("\n")) {
        if (line.startsWith("#. ")) {
            tokens.add(line.slice(3).trim());
        } else if (line.startsWith("#: ")) {
            line.slice(3).trim().split(/\s+/).forEach((token) => tokens.add(token));
        }
    }
    return Array.from(tokens).sort();
}

// Every entry of a .po or a .pot, keyed the way gettext tells entries apart,
// with the places it is extracted from as a token list. Both halves of the gate
// measure here, so neither can be failed by where a "#:" run happens to wrap.
function entryReferences(source) {
    const entries = new Map();
    for (const block of source.split(/\n{2,}/)) {
        const msgid = poField(block, "msgid");
        // the header entry is the one with an empty msgid; templateHeader has it
        if (!msgid) {
            continue;
        }
        const key = [poField(block, "msgctxt") || "", msgid,
            poField(block, "msgid_plural") || ""].join("\u0000");
        entries.set(key, referenceTokens(block));
    }
    return entries;
}

export function templateEntries(pot) {
    const entries = new Map();
    for (const [key, references] of entryReferences(pot)) {
        entries.set(key, references.join(" "));
    }
    return entries;
}

function describeEntryDrift(committed, regenerated) {
    const named = (key) => JSON.stringify(key.split("\u0000")[1]);
    for (const [key, references] of regenerated) {
        if (!committed.has(key)) {
            return `${named(key)} is in the source and not in the template`;
        }
        if (committed.get(key) !== references) {
            return `${named(key)} is extracted from ${references || "nowhere"}, ` +
                `and the template says ${committed.get(key) || "nowhere"}`;
        }
    }
    for (const key of committed.keys()) {
        if (!regenerated.has(key)) {
            return `${named(key)} is in the template and no longer in the source`;
        }
    }
    return null;
}

export function templateDrift(committed, regenerated) {
    if (templateHeader(committed) !== templateHeader(regenerated)) {
        return "the template header does not match the one po/makepot writes";
    }
    return describeEntryDrift(templateEntries(committed), templateEntries(regenerated));
}

export async function validateCatalog(catalogPath, run = execFileAsync) {
    await run("msgfmt", ["-c", "-o", os.devNull, catalogPath]);
    const {stdout = ""} = await run("msgattrib", [
        "--only-fuzzy", "--no-obsolete", catalogPath
    ], {encoding: "utf8", maxBuffer: 4 * 1024 * 1024});

    if (stdout.trim()) {
        throw new Error(`${path.basename(catalogPath)} contains active fuzzy translations`);
    }
}

// A catalog can be internally valid and still trail the template: when the pot
// is regenerated without msgmerge, new or reworded msgids simply are not in the
// .po file, so msgfmt and the fuzzy check stay green while the dialog renders
// those strings in English in every locale. msgcmp fails on exactly that — a
// msgid the catalog is missing, is fuzzy on, or has not translated.
function msgcmpToolFailure(error, catalogPath) {
    if (error && error.code === "ENOENT") {
        return new Error("msgcmp is unavailable: install gettext to check translation catalogs",
            { cause: error });
    }
    if (error && error.signal) {
        return new Error(`msgcmp crashed with signal ${error.signal} while checking ` +
            path.basename(catalogPath), { cause: error });
    }
    if (!error || typeof error.code !== "number") {
        const reason = error && error.message ? `: ${error.message}` : "";
        return new Error(`msgcmp could not run while checking ` +
            `${path.basename(catalogPath)}${reason}`, { cause: error });
    }
    return null;
}

export async function checkCatalogCurrent(catalogPath, potPath, run = execFileAsync) {
    try {
        await run("msgcmp", [catalogPath, potPath]);
    } catch (error) {
        const toolFailure = msgcmpToolFailure(error, catalogPath);
        if (toolFailure) {
            throw toolFailure;
        }
        throw new Error(`${path.basename(catalogPath)} is not merged with the translation ` +
            `template: run msgmerge --update against ${path.basename(potPath)} ` +
            "and translate the new entries", { cause: error });
    }
}

// msgcmp compares msgids and nothing else. It never reads the "#." extracted
// comments or the "#:" source references, so all fifteen catalogs went on
// pointing translators at the deleted 5.4/ tree - 313 stale comments each -
// while the gate reported "15 catalogs valid". Those lines are what a
// translator opens the source at to see a string in context, and msgmerge
// rewrites them from the template, so a catalog that carries one the template
// does not is a catalog that was never merged.
const DRIFT_REPORT_LIMIT = 5;

// Per msgid, and in tokens - not whole "#[.:]" lines. A "#:" run holds several
// references and gettext wraps it at 78 columns, so adding or renaming one
// repacks every line after it in that run, and msgmerge and xgettext of
// different vintages pack them differently. Held to raw lines, a catalog whose
// references are all correct could fail this gate - inside `packaging`, which
// `release` needs - on a repository nobody had changed. That is the fragility
// templateDrift above was written to remove, and this half had kept it.
export function catalogReferenceDrift(catalog, pot) {
    const template = entryReferences(pot);
    const drifted = new Set();
    for (const [key, references] of entryReferences(catalog)) {
        const named = new Set(template.get(key) || []);
        references.filter((token) => !named.has(token))
            .forEach((token) => drifted.add(token));
    }
    return Array.from(drifted).sort();
}

export async function checkCatalogReferences(catalogPath, potPath, read = readFile) {
    const [catalog, pot] = await Promise.all([
        read(catalogPath, "utf8"), read(potPath, "utf8")]);
    const drifted = catalogReferenceDrift(catalog, pot);
    if (drifted.length === 0) {
        return;
    }

    const shown = drifted.slice(0, DRIFT_REPORT_LIMIT);
    const rest = drifted.length - shown.length;
    throw new Error(
        `${path.basename(catalogPath)} points translators at source the template ` +
        `does not name (${drifted.length} references); run msgmerge --update against ` +
        `${path.basename(potPath)}:\n  ${shown.join("\n  ")}` +
        (rest > 0 ? `\n  ...and ${rest} more` : ""));
}

export async function checkI18n(projectRoot, run = execFileAsync,
    expected = EXPECTED_CATALOGS) {
    const root = path.resolve(projectRoot);
    const applet = path.join(root, "files", UUID);
    const poDir = path.join(applet, "po");
    const potName = `${UUID}.pot`;
    const catalogs = (await readdir(poDir))
        .filter((name) => name.endsWith(".po"))
        .sort();
    const catalogPaths = catalogs.map((name) => path.join(poDir, name));

    checkCatalogInventory(catalogs, expected);

    await Promise.all(catalogPaths.map((catalogPath) => validateCatalog(catalogPath, run)));
    await Promise.all(catalogPaths.map((catalogPath) =>
        checkCatalogCurrent(catalogPath, path.join(poDir, potName), run)));
    await Promise.all(catalogPaths.map((catalogPath) =>
        checkCatalogReferences(catalogPath, path.join(poDir, potName))));
    await checkCatalogSourceCopies(catalogPaths);

    const temporary = await mkdtemp(path.join(os.tmpdir(), "chronos-i18n-"));
    try {
        const copiedApplet = path.join(temporary, UUID);
        await cp(applet, copiedApplet, { recursive: true, dereference: false });
        await run("bash", [path.join(copiedApplet, "po", "makepot")], {
            cwd: copiedApplet
        });

        const committed = await readFile(path.join(poDir, potName), "utf8");
        const regenerated = await readFile(
            path.join(copiedApplet, "po", potName), "utf8");
        const drift = templateDrift(committed, regenerated);
        if (drift) {
            throw new Error(
                `translation template is stale: ${drift}; ` +
                `run files/${UUID}/po/makepot`);
        }
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }

    return catalogs.length;
}

export async function runI18nCommand(projectRoot) {
    const count = await checkI18n(projectRoot);
    return `${count} catalogs valid; translation template is current\n`;
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === scriptPath) {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    process.stdout.write(await runI18nCommand(projectRoot));
}
