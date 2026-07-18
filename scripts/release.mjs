// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const UUID = "chronos@geraldo-netto";
const REPOSITORY = "https://github.com/geraldo-netto/cinnamon-chronos";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TRANSACTION_DIR = ".chronos-release-transaction";
const TRANSACTION_MANIFEST = "manifest.json";
const RELEASE_TARGETS = [
    "package.json",
    "package-lock.json",
    `files/${UUID}/metadata.json`,
    "CHANGELOG.md"
];

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
    return {
        packagePath,
        lockPath,
        metadataPath,
        changelogPath,
        pkg: JSON.parse(await readFile(packagePath, "utf8")),
        lock: JSON.parse(await readFile(lockPath, "utf8")),
        metadata: JSON.parse(await readFile(metadataPath, "utf8")),
        changelog: await readFile(changelogPath, "utf8")
    };
}

function validateTransaction(entries) {
    if (!Array.isArray(entries) || entries.length !== RELEASE_TARGETS.length) {
        throw new Error("release transaction has an invalid target list");
    }
    for (let index = 0; index < RELEASE_TARGETS.length; index++) {
        const entry = entries[index];
        if (!Array.isArray(entry) || entry.length !== 2 ||
            entry[0] !== RELEASE_TARGETS[index] || typeof entry[1] !== "string") {
            throw new Error("release transaction has an invalid target list");
        }
    }
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

async function applyReleaseTransaction(root, entries) {
    validateTransaction(entries);
    for (const [relative, content] of entries) {
        await replaceReleaseTarget(root, relative, content);
    }
}

async function recoverReleaseTransaction(root) {
    const transaction = path.join(root, TRANSACTION_DIR);
    let entries;
    try {
        entries = JSON.parse(await readFile(path.join(transaction, TRANSACTION_MANIFEST), "utf8"));
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return;
        }
        throw error;
    }
    await applyReleaseTransaction(root, entries);
    await rm(transaction, { recursive: true });
}

async function writeReleaseTransaction(root, entries) {
    validateTransaction(entries);
    const staging = await mkdtemp(path.join(root, `${TRANSACTION_DIR}-`));
    const transaction = path.join(root, TRANSACTION_DIR);
    try {
        await writeFile(path.join(staging, TRANSACTION_MANIFEST), JSON.stringify(entries));
        await rename(staging, transaction);
    } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
    }

    await applyReleaseTransaction(root, entries);
    await rm(transaction, { recursive: true });
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
    const files = await readReleaseFiles(path.resolve(projectRoot));
    return validateReleaseFiles(files, tag);
}

export async function bumpRelease(projectRoot, nextVersion, options = {}) {
    parseVersion(nextVersion);
    const root = path.resolve(projectRoot);
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

    await writeReleaseTransaction(root, [
        ["package.json", JSON.stringify(files.pkg, null, 2) + "\n"],
        ["package-lock.json", JSON.stringify(files.lock, null, 2) + "\n"],
        [`files/${UUID}/metadata.json`, JSON.stringify(files.metadata, null, 4) + "\n"],
        ["CHANGELOG.md", files.changelog]
    ]);

    return nextVersion;
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
