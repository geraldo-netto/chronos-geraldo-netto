// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const UUID = "chronos@geraldo-netto";
const SPICES_ROOT_ENTRIES = ["README.md", "files", "info.json", "screenshot.png"];

async function rejectSymlinks(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const target = path.join(root, entry.name);
        const stats = await lstat(target);
        if (stats.isSymbolicLink()) {
            throw new Error(`packaged output contains a symlink: ${target}`);
        }
        if (stats.isDirectory()) {
            await rejectSymlinks(target);
        }
    }
}

export async function buildSpicesPackage({ sourceRoot, outputRoot }) {
    const source = path.resolve(sourceRoot);
    const output = path.resolve(outputRoot);

    if (output === source || source.startsWith(output + path.sep)) {
        throw new Error("package output cannot replace the source tree or one of its parents");
    }

    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });

    for (const entry of SPICES_ROOT_ENTRIES) {
        await cp(path.join(source, entry), path.join(output, entry), {
            recursive: true,
            dereference: true
        });
    }

    const packagedEntries = (await readdir(output)).sort();
    if (JSON.stringify(packagedEntries) !== JSON.stringify(SPICES_ROOT_ENTRIES)) {
        throw new Error(`unexpected Spices package layout: ${packagedEntries.join(", ")}`);
    }

    const filesEntries = (await readdir(path.join(output, "files"))).sort();
    if (filesEntries.length !== 1 || filesEntries[0] !== UUID) {
        throw new Error(`files/ must contain only ${UUID}`);
    }

    await rejectSymlinks(output);
    return output;
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === scriptPath) {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const outputRoot = path.join(sourceRoot, "dist", UUID);
    await buildSpicesPackage({ sourceRoot, outputRoot });
    process.stdout.write(`Spices package staged at ${outputRoot}\n`);
}
