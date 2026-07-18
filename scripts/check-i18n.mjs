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

export function withoutCreationDate(pot) {
    return pot.replace(
        /^"POT-Creation-Date: [^"\\]*(?:\\.[^"\\]*)*\\n"$/m,
        "\"POT-Creation-Date: <generated>\\n\"");
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
export async function checkCatalogCurrent(catalogPath, potPath, run = execFileAsync) {
    try {
        await run("msgcmp", [catalogPath, potPath]);
    } catch {
        throw new Error(`${path.basename(catalogPath)} is not merged with the translation ` +
            `template: run msgmerge --update against ${path.basename(potPath)} ` +
            "and translate the new entries");
    }
}

export async function checkI18n(projectRoot) {
    const root = path.resolve(projectRoot);
    const applet = path.join(root, "files", UUID);
    const poDir = path.join(applet, "po");
    const potName = `${UUID}.pot`;
    const catalogs = (await readdir(poDir))
        .filter((name) => name.endsWith(".po"))
        .sort();

    await Promise.all(catalogs.map((name) => validateCatalog(path.join(poDir, name))));
    await Promise.all(catalogs.map((name) =>
        checkCatalogCurrent(path.join(poDir, name), path.join(poDir, potName))));

    const temporary = await mkdtemp(path.join(os.tmpdir(), "chronos-i18n-"));
    try {
        const copiedApplet = path.join(temporary, UUID);
        await cp(applet, copiedApplet, { recursive: true, dereference: false });
        await execFileAsync("bash", [path.join(copiedApplet, "po", "makepot")], {
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

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === scriptPath) {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const count = await checkI18n(projectRoot);
    process.stdout.write(`${count} catalogs valid; translation template is current\n`);
}
