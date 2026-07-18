// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from "node:crypto";
import { link, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const UUID = "chronos@geraldo-netto";
const REPOSITORY = "https://github.com/geraldo-netto/cinnamon-chronos";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LOCK_FILE = ".chronos-release-lock";
const TRANSACTION_DIR = ".chronos-release-transaction";
const TRANSACTION_MANIFEST = "manifest.json";
const RELEASE_TARGETS = [
    "package.json",
    "package-lock.json",
    `files/${UUID}/metadata.json`,
    "CHANGELOG.md"
];

function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !error || error.code !== "ESRCH";
    }
}

async function retireStaleLock(lockPath) {
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
        throw new Error("release lock has an invalid owner");
    }
    if (processIsAlive(owner.pid)) {
        throw new Error(`another release command is running as process ${owner.pid}`);
    }

    const retired = `${lockPath}.stale-${randomUUID()}`;
    try {
        await rename(lockPath, retired);
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return;
        }
        throw error;
    }
    await rm(retired, { force: true });
}

async function acquireReleaseLock(root) {
    const lockPath = path.join(root, LOCK_FILE);
    const candidate = path.join(root, `${LOCK_FILE}-${process.pid}-${randomUUID()}`);
    await writeFile(candidate, JSON.stringify({ pid: process.pid }), { flag: "wx" });
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await link(candidate, lockPath);
                return lockPath;
            } catch (error) {
                if (!error || error.code !== "EEXIST") {
                    throw error;
                }
                await retireStaleLock(lockPath);
            }
        }
        throw new Error("could not acquire the release lock after concurrent recovery");
    } finally {
        await rm(candidate, { force: true });
    }
}

async function cleanupReleaseStaging(root) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith(`${TRANSACTION_DIR}-`)) {
            await rm(path.join(root, entry.name), { recursive: true, force: true });
        }
    }
}

async function withReleaseLock(root, action) {
    const lockPath = await acquireReleaseLock(root);
    try {
        await cleanupReleaseStaging(root);
        return await action();
    } finally {
        await rm(lockPath, { force: true });
    }
}

function parseVersion(version) {
    const match = VERSION_PATTERN.exec(version);
    if (!match) {
        throw new Error(`version must be strict SemVer (major.minor.patch): ${version}`);
    }
    return match.slice(1).map(Number);
}

function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) {
            return a[index] - b[index];
        }
    }
    return 0;
}

async function readReleaseFiles(root) {
    await recoverReleaseTransaction(root);
    const packagePath = path.join(root, "package.json");
    const lockPath = path.join(root, "package-lock.json");
    const metadataPath = path.join(root, "files", UUID, "metadata.json");
    const changelogPath = path.join(root, "CHANGELOG.md");
    const original = await Promise.all([
        readFile(packagePath, "utf8"),
        readFile(lockPath, "utf8"),
        readFile(metadataPath, "utf8"),
        readFile(changelogPath, "utf8")
    ]);
    return {
        packagePath,
        lockPath,
        metadataPath,
        changelogPath,
        original,
        pkg: JSON.parse(original[0]),
        lock: JSON.parse(original[1]),
        metadata: JSON.parse(original[2]),
        changelog: original[3]
    };
}

function validateTransaction(transaction) {
    const entries = transaction && transaction.version === 1 ? transaction.entries : null;
    if (!Array.isArray(entries) || entries.length !== RELEASE_TARGETS.length) {
        throw new Error("release transaction has an invalid target list");
    }
    for (let index = 0; index < RELEASE_TARGETS.length; index++) {
        const entry = entries[index];
        if (!entry || entry.target !== RELEASE_TARGETS[index] ||
            typeof entry.before !== "string" || typeof entry.after !== "string") {
            throw new Error("release transaction has an invalid target list");
        }
    }
    return entries;
}

async function replaceReleaseTarget(root, relative, content) {
    const target = path.join(root, ...relative.split("/"));
    const temporary = `${target}.chronos-release-${process.pid}.tmp`;
    try {
        await writeFile(temporary, content);
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}

async function applyReleaseTransaction(root, transaction) {
    for (const entry of validateTransaction(transaction)) {
        await replaceReleaseTarget(root, entry.target, entry.after);
    }
}

async function divergentReleaseTargets(root, transaction) {
    const divergent = [];
    for (const entry of validateTransaction(transaction)) {
        const current = await readFile(path.join(root, ...entry.target.split("/")), "utf8");
        if (current !== entry.before && current !== entry.after) {
            divergent.push(entry.target);
        }
    }
    return divergent;
}

async function recoverReleaseTransaction(root) {
    const transaction = path.join(root, TRANSACTION_DIR);
    let manifest;
    try {
        manifest = JSON.parse(await readFile(path.join(transaction, TRANSACTION_MANIFEST), "utf8"));
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return;
        }
        throw error;
    }
    const divergent = await divergentReleaseTargets(root, manifest);
    if (divergent.length > 0) {
        throw new Error(`release transaction conflicts with modified files: ${divergent.join(", ")}`);
    }
    await applyReleaseTransaction(root, manifest);
    await rm(transaction, { recursive: true });
}

async function writeReleaseTransaction(root, transaction) {
    validateTransaction(transaction);
    const staging = await mkdtemp(path.join(root, `${TRANSACTION_DIR}-`));
    const published = path.join(root, TRANSACTION_DIR);
    try {
        await writeFile(path.join(staging, TRANSACTION_MANIFEST), JSON.stringify(transaction));
        await rename(staging, published);
    } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
    }

    await applyReleaseTransaction(root, transaction);
    await rm(published, { recursive: true });
}

function validateReleaseFiles(files, tag) {
    const version = files.metadata.version;
    parseVersion(version);
    const versions = [
        ["package.json", files.pkg.version],
        ["package-lock.json", files.lock.version],
        ["package-lock.json root package", files.lock.packages?.[""]?.version]
    ];
    for (const [source, candidate] of versions) {
        if (candidate !== version) {
            throw new Error(`${source} version ${candidate} does not match metadata.json ${version}`);
        }
    }

    if (!new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m")
        .test(files.changelog)) {
        throw new Error(`CHANGELOG.md has no dated ${version} release heading`);
    }
    if (!files.changelog.includes(
        `[Unreleased]: ${REPOSITORY}/compare/v${version}...HEAD`)) {
        throw new Error(`CHANGELOG.md Unreleased link does not start at v${version}`);
    }
    if (!files.changelog.includes(
        `[${version}]: ${REPOSITORY}/releases/tag/v${version}`)) {
        throw new Error(`CHANGELOG.md has no v${version} release link`);
    }

    if (tag !== undefined && tag !== null && tag !== "") {
        if (tag !== `v${version}`) {
            throw new Error(`release tag ${tag} does not match version v${version}`);
        }
    }
    return version;
}

export async function checkRelease(projectRoot, tag) {
    const root = path.resolve(projectRoot);
    return withReleaseLock(root, async () => {
        const files = await readReleaseFiles(root);
        return validateReleaseFiles(files, tag);
    });
}

async function bumpReleaseLocked(root, nextVersion, options) {
    const files = await readReleaseFiles(root);
    const currentVersion = validateReleaseFiles(files);
    if (compareVersions(nextVersion, currentVersion) <= 0) {
        throw new Error(`next version ${nextVersion} must be greater than ${currentVersion}`);
    }

    const unreleasedHeading = "## [Unreleased]";
    const headingStart = files.changelog.indexOf(unreleasedHeading);
    const notesStart = headingStart + unreleasedHeading.length;
    const nextHeading = files.changelog.indexOf("\n## [", notesStart);
    if (headingStart < 0 || nextHeading < 0) {
        throw new Error("CHANGELOG.md needs Unreleased followed by a released version");
    }
    const notes = files.changelog.slice(notesStart, nextHeading).trim();
    if (!/^[-*] .+/m.test(notes)) {
        throw new Error("CHANGELOG.md Unreleased section needs at least one release-note bullet");
    }

    const date = options.date || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`release date must be YYYY-MM-DD: ${date}`);
    }

    files.pkg.version = nextVersion;
    files.lock.version = nextVersion;
    files.lock.packages[""].version = nextVersion;
    files.metadata.version = nextVersion;

    let changelog = files.changelog.slice(0, notesStart) +
        `\n\n## [${nextVersion}] - ${date}\n\n${notes}\n` +
        files.changelog.slice(nextHeading);
    const linkedChangelog = changelog.replace(
        new RegExp(`^\\[Unreleased\\]: ${REPOSITORY.replaceAll(".", "\\.")}\\/compare\\/v` +
            `${currentVersion.replaceAll(".", "\\.")}\\.\\.\\.HEAD$`, "m"),
        `[Unreleased]: ${REPOSITORY}/compare/v${nextVersion}...HEAD\n` +
        `[${nextVersion}]: ${REPOSITORY}/releases/tag/v${nextVersion}`);
    if (linkedChangelog === changelog) {
        throw new Error("CHANGELOG.md could not rewrite the exact Unreleased compare link");
    }
    files.changelog = linkedChangelog;
    validateReleaseFiles(files);

    const after = [
        JSON.stringify(files.pkg, null, 2) + "\n",
        JSON.stringify(files.lock, null, 2) + "\n",
        JSON.stringify(files.metadata, null, 4) + "\n",
        files.changelog
    ];
    await writeReleaseTransaction(root, {
        version: 1,
        entries: RELEASE_TARGETS.map((target, index) => ({
            target,
            before: files.original[index],
            after: after[index]
        }))
    });

    return nextVersion;
}

export async function bumpRelease(projectRoot, nextVersion, options = {}) {
    parseVersion(nextVersion);
    const root = path.resolve(projectRoot);
    return withReleaseLock(root, () => bumpReleaseLocked(root, nextVersion, options));
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === scriptPath) {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const command = process.argv[2] || "check";
    if (command === "check") {
        const version = await checkRelease(projectRoot, process.argv[3]);
        process.stdout.write(`release metadata is consistent at v${version}\n`);
    } else if (command === "bump") {
        if (!process.argv[3]) {
            throw new Error("usage: npm run release:bump -- <major.minor.patch>");
        }
        const version = await bumpRelease(projectRoot, process.argv[3]);
        process.stdout.write(`release files bumped to v${version}; review and commit them\n`);
    } else {
        throw new Error(`unknown release command: ${command}`);
    }
}
