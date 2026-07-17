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

function withoutCreationDate(pot) {
    return pot.replace(
        /^"POT-Creation-Date: [^"\\]*(?:\\.[^"\\]*)*\\n"$/m,
        "\"POT-Creation-Date: <generated>\\n\"");
}

export async function checkI18n(projectRoot) {
    const root = path.resolve(projectRoot);
    const applet = path.join(root, "files", UUID);
    const poDir = path.join(applet, "po");
    const catalogs = (await readdir(poDir))
        .filter((name) => name.endsWith(".po"))
        .sort();

    await Promise.all(catalogs.map((name) => execFileAsync("msgfmt", [
        "-c", "-o", os.devNull, path.join(poDir, name)
    ])));

    const temporary = await mkdtemp(path.join(os.tmpdir(), "chronos-i18n-"));
    try {
        const copiedApplet = path.join(temporary, UUID);
        await cp(applet, copiedApplet, { recursive: true, dereference: false });
        await execFileAsync("bash", [path.join(copiedApplet, "po", "makepot")], {
            cwd: copiedApplet
        });

        const potName = `${UUID}.pot`;
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
