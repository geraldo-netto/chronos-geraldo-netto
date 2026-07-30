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
const SOURCE_COPY_ALLOWLIST = new Set([
    "%s — %s",
    "Chronos Calendar",
    "Claus Colloseus (ccprog)",
    "Geraldo Netto",
    "Simon Wiles (simonwiles)"
]);

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
    return fragments.map((fragment) => JSON.parse(fragment)).join("");
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

export function withoutCreationDate(pot) {
    return pot.replace(
        /^"POT-Creation-Date: [^"\\]*(?:\\.[^"\\]*)*\\n"$/m,
        "\"POT-Creation-Date: <generated>\\n\""); // NOSONAR [S7780] -- accepted compatible form
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

export async function checkI18n(projectRoot, run = execFileAsync) {
    const root = path.resolve(projectRoot);
    const applet = path.join(root, "files", UUID);
    const poDir = path.join(applet, "po");
    const potName = `${UUID}.pot`;
    const catalogs = (await readdir(poDir))
        .filter((name) => name.endsWith(".po"))
        .sort();
    const catalogPaths = catalogs.map((name) => path.join(poDir, name));

    await Promise.all(catalogPaths.map((catalogPath) => validateCatalog(catalogPath, run)));
    await Promise.all(catalogPaths.map((catalogPath) =>
        checkCatalogCurrent(catalogPath, path.join(poDir, potName), run)));
    await checkCatalogSourceCopies(catalogPaths);

    const temporary = await mkdtemp(path.join(os.tmpdir(), "chronos-i18n-"));
    try {
        const copiedApplet = path.join(temporary, UUID);
        await cp(applet, copiedApplet, { recursive: true, dereference: false });
        await run("bash", [path.join(copiedApplet, "po", "makepot")], {
            cwd: copiedApplet
        });

        const committed = withoutCreationDate(
            await readFile(path.join(poDir, potName), "utf8"));
        const regenerated = withoutCreationDate(
            await readFile(path.join(copiedApplet, "po", potName), "utf8"));
        if (committed !== regenerated) {
            const committedLines = committed.split("\n");
            const regeneratedLines = regenerated.split("\n");
            const limit = Math.max(committedLines.length, regeneratedLines.length);
            let firstDifference = 0;
            while (firstDifference < limit &&
                   committedLines[firstDifference] === regeneratedLines[firstDifference]) {
                firstDifference++;
            }
            throw new Error(
                `translation template is stale at line ${firstDifference + 1}; ` +
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
