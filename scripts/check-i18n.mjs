// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
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

function compareCodeUnits(left, right) {
    if (left < right) {
        return -1;
    }
    return left > right ? 1 : 0;
}

// PO's escapes are not a subset of JSON's. gettext also writes \a and \v, and
// read-po accepts octal \NNN and hexadecimal \xHH; JSON.parse rejects all four.
// Every fragment used to go through JSON.parse, so a catalog carrying one threw
// a bare SyntaxError out of checkCatalogSourceCopies
// and failed `i18n:check` — which `packaging` needs and `release` needs after it
// — with a message naming neither the catalog nor the entry.
const PO_ESCAPES = {
    a: "\u0007", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
    "\"": "\"", "\\": "\\"
};

function poEscapeValue(escape) {
    if (escape.startsWith("x")) {
        // PO escapes are 16-bit code units; fromCodePoint rejects values this decoder truncates.
        return String.fromCharCode(Number.parseInt(escape.slice(1), 16)); // NOSONAR [S7758]
    }
    if (/^[0-7]/.test(escape)) {
        return String.fromCharCode(Number.parseInt(escape, 8)); // NOSONAR [S7758] -- preserve PO code-unit decoding
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
        .sort(compareCodeUnits);
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

export async function validateCatalog(catalogPath, run = execFileAsync) {
    await run("msgfmt", ["-c", "-o", os.devNull, catalogPath]);
    const {stdout = ""} = await run("msgattrib", [
        "--only-fuzzy", "--no-obsolete", catalogPath
    ], {encoding: "utf8", maxBuffer: 4 * 1024 * 1024});

    if (stdout.trim()) {
        throw new Error(`${path.basename(catalogPath)} contains active fuzzy translations`);
    }
}

export async function checkI18n(projectRoot, run = execFileAsync,
    expected = EXPECTED_CATALOGS) {
    const root = path.resolve(projectRoot);
    const applet = path.join(root, "files", UUID);
    const poDir = path.join(applet, "po");
    const catalogs = (await readdir(poDir))
        .filter((name) => name.endsWith(".po"))
        .sort(compareCodeUnits);
    const catalogPaths = catalogs.map((name) => path.join(poDir, name));

    checkCatalogInventory(catalogs, expected);

    await Promise.all(catalogPaths.map((catalogPath) => validateCatalog(catalogPath, run)));
    await checkCatalogSourceCopies(catalogPaths);

    // Missing entries and stale extraction references are translation maintenance,
    // not catalog corruption. gettext displays the source English for missing entries.
    return catalogs.length;
}

export async function runI18nCommand(projectRoot) {
    const count = await checkI18n(projectRoot);
    return `${count} catalogs valid; untranslated messages use English\n`;
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === scriptPath) {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    process.stdout.write(await runI18nCommand(projectRoot));
}
