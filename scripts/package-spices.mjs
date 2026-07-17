// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readlink, readdir, realpath, rm } from "node:fs/promises";
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

export async function listTrackedSpicesFiles(sourceRoot) {
    const { stdout } = await execFileAsync("git", [
        "-C", sourceRoot, "ls-files", "-z", "--",
        "README.md", "files", "info.json", "screenshot.png"
    ], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });

    return stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

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

async function resolveSourceFile(source, sourcePath, relative, manifest) {
    let stats = await lstat(sourcePath);
    if (stats.isDirectory()) {
        throw new Error(`package manifest names a directory, not a file: ${relative}`);
    }
    if (!stats.isSymbolicLink()) {
        return { sourcePath, stats };
    }

    // Inspect the link before copying any bytes. A safe in-tree tracked target
    // is dereferenced because the repository still contains one legacy icon
    // link; a link to the host or to ignored source material is never followed.
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
    return { sourcePath: resolvedTarget, stats };
}

export async function buildSpicesPackage({ sourceRoot, outputRoot, trackedFiles }) {
    const source = await realpath(path.resolve(sourceRoot));
    const output = path.resolve(outputRoot);

    if (output === source || source.startsWith(output + path.sep)) {
        throw new Error("package output cannot replace the source tree or one of its parents");
    }

    const files = trackedFiles ? [...trackedFiles].sort() : await listTrackedSpicesFiles(source);
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

    // Validate every input, including symlink confinement, before replacing an
    // existing package. A bad source must not destroy the last good artifact.
    const resolvedFiles = [];
    for (const relative of files) {
        const sourcePath = path.resolve(source, ...relative.split("/"));
        if (!isInside(source, sourcePath)) {
            throw new Error(`package manifest escapes the source tree: ${relative}`);
        }
        resolvedFiles.push({
            relative,
            ...await resolveSourceFile(source, sourcePath, relative, manifest)
        });
    }

    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });

    for (const file of resolvedFiles) {
        const destination = path.join(output, ...file.relative.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(file.sourcePath, destination);
        await chmod(destination, file.stats.mode & 0o777);
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
