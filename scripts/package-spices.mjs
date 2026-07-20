// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFile } from "node:child_process";
import {
    chmod, copyFile, lstat, mkdir, readlink, readdir, realpath, rm, writeFile
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const UUID = "chronos@geraldo-netto";
const SPICES_ROOT_ENTRIES = ["README.md", "files", "info.json", "screenshot.png"];
const REQUIRED_FILES = new Set(["README.md", "info.json", "screenshot.png"]);

function isInside(root, target) {
    return target === root || target.startsWith(root + path.sep);
}

function validateManifestPath(relative) {
    if (typeof relative !== "string" || relative.length === 0 || path.isAbsolute(relative)) {
        throw new Error(`invalid package manifest path: ${String(relative)}`);
    }

    const parts = relative.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
        throw new Error(`invalid package manifest path: ${relative}`);
    }

    if (REQUIRED_FILES.has(relative)) {
        return;
    }
    if (parts.length < 3 || parts[0] !== "files" || parts[1] !== UUID) {
        throw new Error(`tracked file is outside the declared Spices layout: ${relative}`);
    }
}

export function parseTrackedSpicesFiles(stdout) {
    return stdout.toString("utf8").split("\0").filter(Boolean).map((entry) => {
        const match = /^([0-7]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(entry);
        if (!match || match[3] !== "0") { // NOSONAR [S6582] -- accepted compatible form
            throw new Error("cannot package an invalid or conflicted Git index");
        }
        const indexMode = Number.parseInt(match[1], 8);
        if (![0o100644, 0o100755, 0o120000].includes(indexMode)) {
            throw new Error("cannot package an unsupported Git index entry");
        }
        return {
            relative: match[4],
            mode: indexMode & 0o777,
            indexMode,
            objectId: match[2]
        };
    }).sort((left, right) => left.relative.localeCompare(right.relative));
}

export async function listTrackedSpicesFiles(sourceRoot) {
    const { stdout } = await execFileAsync("git", [
        "-C", sourceRoot, "ls-files", "--stage", "-z", "--",
        "README.md", "files", "info.json", "screenshot.png"
    ], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });

    return parseTrackedSpicesFiles(stdout);
}

export async function rejectSymlinks(root) {
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

export async function resolveSourceFile(source, sourcePath, relative, manifest) {
    let stats = await lstat(sourcePath);
    if (stats.isDirectory()) {
        throw new Error(`package manifest names a directory, not a file: ${relative}`);
    }
    if (!stats.isSymbolicLink()) {
        return { sourcePath, stats, modeRelative: relative };
    }

    // Inspect the link before copying any bytes. The tracked tree has no links,
    // but a future safe in-tree tracked target can be dereferenced; a link to the
    // host or to ignored source material is never followed.
    const linkTarget = await readlink(sourcePath);
    const lexicalTarget = path.resolve(path.dirname(sourcePath), linkTarget);
    if (!isInside(source, lexicalTarget)) {
        throw new Error(`source symlink points outside the source tree: ${relative}`);
    }

    const resolvedTarget = await realpath(sourcePath);
    if (!isInside(source, resolvedTarget)) {
        throw new Error(`source symlink resolves outside the source tree: ${relative}`);
    }

    const targetRelative = path.relative(source, resolvedTarget).split(path.sep).join("/");
    if (!manifest.has(targetRelative)) {
        throw new Error(`source symlink points to an untracked file: ${relative}`);
    }

    stats = await lstat(resolvedTarget);
    if (!stats.isFile()) {
        throw new Error(`source symlink does not resolve to a regular file: ${relative}`);
    }
    return { sourcePath: resolvedTarget, stats, modeRelative: targetRelative };
}

function validateManifest(files) {
    const manifest = new Set(files);
    if (files.length !== manifest.size) {
        throw new Error("package manifest contains duplicate paths");
    }
    for (const required of REQUIRED_FILES) {
        if (!manifest.has(required)) {
            throw new Error(`package manifest is missing ${required}`);
        }
    }
    for (const relative of files) {
        validateManifestPath(relative);
    }
    return manifest;
}

async function resolveManifestFiles(source, files, manifest) {
    const resolvedFiles = [];
    for (const relative of files) {
        const sourcePath = path.resolve(source, ...relative.split("/"));
        resolvedFiles.push({
            relative,
            ...await resolveSourceFile(source, sourcePath, relative, manifest)
        });
    }
    return resolvedFiles;
}

async function readIndexBlob(source, objectId, cache) {
    if (!cache.has(objectId)) {
        const pending = execFileAsync("git", [
            "-C", source, "cat-file", "blob", objectId
        ], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })
            .then(({ stdout }) => stdout);
        cache.set(objectId, pending);
    }
    return cache.get(objectId);
}

async function resolveIndexFile(source, entry, entries, cache, seen = new Set()) {
    if (entry.indexMode !== 0o120000) {
        return {
            contents: await readIndexBlob(source, entry.objectId, cache),
            modeRelative: entry.relative
        };
    }
    if (seen.has(entry.relative)) {
        throw new Error(`source symlink cycle in Git index: ${entry.relative}`);
    }

    const linkTarget = (await readIndexBlob(source, entry.objectId, cache)).toString("utf8");
    const targetRelative = path.posix.normalize(
        path.posix.join(path.posix.dirname(entry.relative), linkTarget));
    if (path.posix.isAbsolute(linkTarget) ||
        targetRelative === ".." ||
        targetRelative.startsWith("../")) {
        throw new Error(`source symlink points outside the source tree: ${entry.relative}`);
    }

    const target = entries.get(targetRelative);
    if (!target) {
        throw new Error(`source symlink points to an untracked file: ${entry.relative}`);
    }
    const nextSeen = new Set(seen);
    nextSeen.add(entry.relative);
    return resolveIndexFile(source, target, entries, cache, nextSeen);
}

async function resolveIndexFiles(source, trackedEntries) {
    const entries = new Map(trackedEntries.map((entry) => [entry.relative, entry]));
    const cache = new Map();
    const resolvedFiles = [];
    for (const entry of trackedEntries) {
        resolvedFiles.push({
            relative: entry.relative,
            ...await resolveIndexFile(source, entry, entries, cache)
        });
    }
    return resolvedFiles;
}

export async function validatePackageLayout(output) {
    const packagedEntries = (await readdir(output)).sort();
    if (JSON.stringify(packagedEntries) !== JSON.stringify(SPICES_ROOT_ENTRIES)) {
        throw new Error(`unexpected Spices package layout: ${packagedEntries.join(", ")}`);
    }

    const filesEntries = (await readdir(path.join(output, "files"))).sort();
    if (filesEntries.length !== 1 || filesEntries[0] !== UUID) {
        throw new Error(`files/ must contain only ${UUID}`);
    }

    await rejectSymlinks(output);
}

export async function buildSpicesPackage({ sourceRoot, outputRoot, trackedFiles }) {
    const source = await realpath(path.resolve(sourceRoot));
    const output = path.resolve(outputRoot);

    if (output === source || source.startsWith(output + path.sep)) {
        throw new Error("package output cannot replace the source tree or one of its parents");
    }

    const trackedEntries = trackedFiles ?
        [...trackedFiles].sort().map((relative) => ({ relative, mode: null })) : // NOSONAR [S2871] -- lexicographic paths required
        await listTrackedSpicesFiles(source);
    const files = trackedEntries.map(({ relative }) => relative);
    const indexedModes = new Map(trackedEntries.map(({ relative, mode }) => [relative, mode]));
    const manifest = validateManifest(files);

    // Validate every input, including symlink confinement, before replacing an
    // existing package. A bad source must not destroy the last good artifact.
    const resolvedFiles = trackedFiles ?
        await resolveManifestFiles(source, files, manifest) :
        await resolveIndexFiles(source, trackedEntries);

    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });

    for (const file of resolvedFiles) {
        const destination = path.join(output, ...file.relative.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        if (file.contents) {
            await writeFile(destination, file.contents);
        } else {
            await copyFile(file.sourcePath, destination);
        }
        await chmod(destination,
            indexedModes.get(file.modeRelative) ?? (file.stats.mode & 0o777));
    }

    await validatePackageLayout(output);
    return output;
}

export async function runPackageCommand(sourceRoot) {
    const outputRoot = path.join(sourceRoot, "dist", UUID);
    await buildSpicesPackage({ sourceRoot, outputRoot });
    return `Spices package staged at ${outputRoot}\n`;
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === scriptPath) {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    process.stdout.write(await runPackageCommand(sourceRoot));
}
