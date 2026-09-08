// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const UUID = "chronos@geraldo-netto";
const RELEASE_BRANCH = "develop";
const RELEASE_BRANCH_REF = `origin/${RELEASE_BRANCH}`;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_FILE = ".chronos-release-lock";
const TRANSACTION_DIR = ".chronos-release-transaction";
const TRANSACTION_MANIFEST = "manifest.json";
// po/makepot bakes metadata.json's version into the template header.
// release:check verifies this version owner even when translations stay unchanged.
const RELEASE_TARGETS = [
    "package.json",
    "package-lock.json",
    `files/${UUID}/metadata.json`,
    `files/${UUID}/po/${UUID}.pot`
];
const TEMPLATE_VERSION_PATTERN = new RegExp(
    String.raw`^"Project-Id-Version: ${UUID} (.*)\\n"$`, "m");

export function parseProcessStartTime(stat) {
    if (typeof stat !== "string") {
        return null;
    }
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
        return null;
    }
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTime = fields[19];
    return typeof startTime === "string" && /^\d+$/.test(startTime) ? startTime : null;
}

export async function readProcessStartTime(pid, readStat = readFile) {
    try {
        const stat = await readStat(`/proc/${pid}/stat`, "utf8");
        const startTime = parseProcessStartTime(stat);
        if (!startTime) {
            throw new Error(`process ${pid} has an unreadable start identity`);
        }
        return startTime;
    } catch (error) {
        if (error?.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

function parseLockOwner(contents) {
    let owner;
    try {
        owner = JSON.parse(contents);
    } catch (error) {
        throw new Error("release lock has an invalid owner", { cause: error });
    }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 ||
        typeof owner.startTime !== "string" || !/^\d+$/.test(owner.startTime) ||
        typeof owner.token !== "string" ||
        !UUID_PATTERN.test(owner.token)) {
        throw new Error("release lock has an invalid owner");
    }
    return owner;
}

async function readLockOwner(lockPath) {
    try {
        return parseLockOwner(await readFile(lockPath, "utf8"));
    } catch (error) {
        if (error?.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

export function lockCandidatePath(lockPath, owner) {
    return `${lockPath}.owner-${owner.pid}-${owner.startTime}-${owner.token}`;
}

function candidateOwner(lockPath, candidate) {
    const prefix = `${lockPath}.owner-`;
    if (!candidate.startsWith(prefix)) {
        return null;
    }
    const match = /^([1-9]\d*)-(\d+)-(.+)$/.exec(candidate.slice(prefix.length));
    const pid = match ? Number(match[1]) : Number.NaN;
    if (!match || !Number.isSafeInteger(pid) || !UUID_PATTERN.test(match[3])) {
        return null;
    }
    return { pid, startTime: match[2], token: match[3] };
}

async function cleanupLockCandidates(lockPath) {
    const directory = path.dirname(lockPath);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        const owner = entry.isFile() ? candidateOwner(lockPath, candidate) : null;
        if (owner && await readProcessStartTime(owner.pid) !== owner.startTime) {
            await rm(candidate, { force: true });
        }
    }
}

export async function writeLockCandidate(candidate, owner,
    write = (handle, contents) => handle.writeFile(contents)) {
    const handle = await open(candidate, "wx");
    try {
        await write(handle, JSON.stringify(owner));
    } catch (error) {
        await rm(candidate, { force: true });
        throw error;
    } finally {
        await handle.close();
    }
}

export function lockClaimPath(candidate, operation, claimant) {
    return `${candidate}.claim-${operation}-${claimant.pid}-${claimant.startTime}-${claimant.token}`;
}

function parseLockClaim(candidate, claimPath) {
    const prefix = `${candidate}.claim-`;
    if (!claimPath.startsWith(prefix)) {
        return null;
    }
    const match = /^(release|stale)-([1-9]\d*)-(\d+)-(.+)$/.exec(
        claimPath.slice(prefix.length));
    const pid = match ? Number(match[2]) : Number.NaN;
    if (!match || !Number.isSafeInteger(pid) || !UUID_PATTERN.test(match[4])) {
        return null;
    }
    return { operation: match[1], pid, startTime: match[3], token: match[4] };
}

function lockCandidateForClaim(lockPath, claimPath) {
    const separator = claimPath.indexOf(".claim-", lockPath.length);
    const candidate = claimPath.slice(0, separator);
    return candidateOwner(lockPath, candidate) && parseLockClaim(candidate, claimPath) ?
        candidate : null;
}

async function listLockClaims(lockPath, candidate = null) {
    const directory = path.dirname(lockPath);
    const entries = await readdir(directory, { withFileTypes: true });
    const claims = [];
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }
        const claimPath = path.join(directory, entry.name);
        const claimedCandidate = lockCandidateForClaim(lockPath, claimPath);
        if (claimedCandidate && (!candidate || claimedCandidate === candidate)) {
            claims.push(claimPath);
        }
    }
    return claims;
}

async function cleanupLockClaims(lockPath) {
    for (const claimPath of await listLockClaims(lockPath)) {
        await rm(claimPath, { force: true });
    }
}

function sameLockOwner(left, right) {
    return Boolean(left && right && left.pid === right.pid &&
        left.startTime === right.startTime && left.token === right.token);
}

async function renameIfPresent(source, target) {
    try {
        await rename(source, target);
        return true;
    } catch (error) {
        if (error?.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

async function lockClaimIsLive(candidate, claimPath) {
    const claimant = parseLockClaim(candidate, claimPath);
    if (!claimant) {
        return false;
    }
    return await readProcessStartTime(claimant.pid) === claimant.startTime;
}

async function claimOwnedLock(lock, operation) {
    const startTime = await readProcessStartTime(process.pid);
    if (!startTime) {
        throw new Error("current process has no start identity");
    }
    const claimed = lockClaimPath(lock.candidate, operation, {
        pid: process.pid,
        startTime,
        token: randomUUID()
    });
    if (await renameIfPresent(lock.candidate, claimed)) {
        return claimed;
    }

    for (const previous of await listLockClaims(lock.lockPath, lock.candidate)) {
        if (await lockClaimIsLive(lock.candidate, previous)) {
            return null;
        }
        if (await renameIfPresent(previous, claimed)) {
            return claimed;
        }
    }
    return null;
}

// The owner-specific hard link is a compare-and-delete claim. Only one stale
// inspector can hold it. A claimant's process identity makes an interrupted
// rename distinguishable from live cleanup, so a later command can atomically
// take over the claim without letting two removers race a replacement lock.
export async function removeOwnedLock(lock, operation) {
    const claimed = await claimOwnedLock(lock, operation);
    if (!claimed) {
        return false;
    }

    try {
        const current = await readLockOwner(lock.lockPath);
        if (!sameLockOwner(current, lock.owner)) {
            return false;
        }
        await rm(lock.lockPath, { force: true });
        return true;
    } finally {
        await rm(claimed, { force: true });
    }
}

export async function retireStaleLock(
    lockPath, processStartTime = readProcessStartTime) {
    const owner = await readLockOwner(lockPath);
    if (!owner) {
        return;
    }
    if (await processStartTime(owner.pid) === owner.startTime) {
        throw new Error(`another release command is running as process ${owner.pid}`);
    }
    await removeOwnedLock({
        lockPath,
        candidate: lockCandidatePath(lockPath, owner),
        owner
    }, "stale");
}

async function acquireReleaseLock(root) {
    const lockPath = path.join(root, LOCK_FILE);
    const token = randomUUID();
    const startTime = await readProcessStartTime(process.pid);
    if (!startTime) {
        throw new Error("current process has no start identity");
    }
    const owner = { pid: process.pid, startTime, token };
    const candidate = lockCandidatePath(lockPath, owner);
    const lock = { lockPath, candidate, owner };
    let acquired = false;
    let created = false;
    try {
        await writeLockCandidate(candidate, owner);
        created = true;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await link(candidate, lockPath);
                acquired = true;
                await cleanupLockClaims(lockPath);
                await cleanupLockCandidates(lockPath);
                return lock;
            } catch (error) {
                if (!error || error.code !== "EEXIST") { // NOSONAR [S6582] -- accepted compatible form
                    throw error;
                }
                await retireStaleLock(lockPath);
            }
        }
        throw new Error("could not acquire the release lock after concurrent recovery");
    } finally {
        if (created && !acquired) {
            await rm(candidate, { force: true });
        }
    }
}

async function cleanupReleaseTemporaries(root) {
    for (const relative of RELEASE_TARGETS) {
        const parts = relative.split("/");
        const targetName = parts.pop();
        const directory = path.join(root, ...parts);
        const prefix = `${targetName}.chronos-release-`;
        const siblings = await readdir(directory, { withFileTypes: true });
        for (const sibling of siblings) {
            if (!sibling.isDirectory() && sibling.name.startsWith(prefix) &&
                sibling.name.endsWith(".tmp")) {
                await rm(path.join(directory, sibling.name), { force: true });
            }
        }
    }
}

async function cleanupReleaseStaging(root) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith(`${TRANSACTION_DIR}-`)) {
            await rm(path.join(root, entry.name), { recursive: true, force: true });
        }
    }
    await cleanupReleaseTemporaries(root);
}

// `recover` is what separates a reporting command from a mutating one: only a
// command that is allowed to finish an interrupted release sweeps the staging
// directories and applies the journal. `release:check` runs in CI, so it holds
// the same lock but touches nothing -- see `refusePendingTransaction`.
async function withReleaseLock(root, action, { recover = true } = {}) {
    const lock = await acquireReleaseLock(root);
    let result;
    let actionError = null;
    try {
        if (recover) {
            await cleanupReleaseStaging(root);
        }
        result = await action();
    } catch (error) {
        actionError = error;
    }
    const released = await removeOwnedLock(lock, "release");
    if (actionError) {
        throw actionError;
    }
    if (!released) {
        throw new Error("release lock ownership changed before release");
    }
    return result;
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

async function readReleaseFiles(root, { recover = true } = {}) {
    if (recover) {
        await recoverReleaseTransaction(root);
    } else {
        await refusePendingTransaction(root);
    }
    const original = await Promise.all(RELEASE_TARGETS.map((relative) =>
        readFile(path.join(root, ...relative.split("/")), "utf8")));
    return {
        original,
        pkg: JSON.parse(original[0]),
        lock: JSON.parse(original[1]),
        metadata: JSON.parse(original[2]),
        template: original[3]
    };
}

function validateTransaction(transaction) {
    const entries = transaction && transaction.version === 1 ? transaction.entries : null; // NOSONAR [S6582] -- accepted compatible form
    if (!Array.isArray(entries) || entries.length !== RELEASE_TARGETS.length) {
        throw new Error("release transaction has an invalid target list");
    }
    for (let index = 0; index < RELEASE_TARGETS.length; index++) {
        const entry = entries[index];
        if (!entry || entry.target !== RELEASE_TARGETS[index] || // NOSONAR [S6582] -- accepted compatible form
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

async function readTransactionManifest(root) {
    try {
        return JSON.parse(await readFile(
            path.join(root, TRANSACTION_DIR, TRANSACTION_MANIFEST), "utf8"));
    } catch (error) {
        if (error?.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

// A read-only command must not decide for the operator that a half-applied
// release is what the tree should hold. It says so and stops instead, so a CI
// run cannot report "consistent" about files it has just rewritten itself.
async function refusePendingTransaction(root) {
    if (await readTransactionManifest(root)) {
        throw new Error(
            "a pending release transaction exists; run npm run release:recover");
    }
}

async function recoverReleaseTransaction(root) {
    const transaction = path.join(root, TRANSACTION_DIR);
    const manifest = await readTransactionManifest(root);
    if (!manifest) {
        return;
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

export function templateVersion(template) {
    const match = TEMPLATE_VERSION_PATTERN.exec(String(template || ""));
    return match ? match[1] : null;
}

// The header line only, rewritten exactly as po/makepot would stamp it. The
// alternative -- running makepot from the release transaction -- would put
// xgettext and cinnamon-xlet-makepot on the critical path of every bump, and
// would rewrite POT-Creation-Date and every source line reference as unrelated
// churn in the release commit.
export function patchTemplateVersion(original, nextVersion) {
    const patched = String(original).replace(TEMPLATE_VERSION_PATTERN,
        String.raw`"Project-Id-Version: ${UUID} ${nextVersion}\n"`);
    if (templateVersion(patched) !== nextVersion) {
        throw new Error("the translation template version could not be replaced in place");
    }
    return patched;
}

function validateVersionOwners(files) {
    const version = files.metadata.version;
    parseVersion(version);
    const versions = [
        ["package.json", files.pkg.version],
        ["package-lock.json", files.lock.version],
        ["package-lock.json root package", files.lock.packages?.[""]?.version],
        [`po/${UUID}.pot`, templateVersion(files.template)]
    ];
    for (const [source, candidate] of versions) {
        if (candidate !== version) {
            throw new Error(`${source} version ${candidate} does not match metadata.json ${version}`);
        }
    }
    return version;
}

function validateReleaseFiles(files, tag) {
    const version = validateVersionOwners(files);
    const suppliedTag = tag !== undefined && tag !== null && tag !== "";
    if (suppliedTag && tag !== `v${version}`) {
        throw new Error(`release tag ${tag} does not match version v${version}`);
    }
    return version;
}

function gitResult(root, args) {
    return spawnSync("git", ["-C", root, ...args], { // NOSONAR [S4036] -- fixed executable and argv
        encoding: "utf8",
        shell: false
    });
}

export function validateReleaseTag(projectRoot, tag, releaseBranch = RELEASE_BRANCH_REF) {
    const root = path.resolve(projectRoot);
    const tagRef = `refs/tags/${tag}`;
    const object = gitResult(root, ["cat-file", "-t", tagRef]);
    if (object.status !== 0) {
        throw new Error(`release tag ${tag} does not exist`);
    }
    if (object.stdout.trim() !== "tag") {
        throw new Error(`release tag ${tag} must be annotated`);
    }

    const taggedCommit = gitResult(root, ["rev-parse", `${tagRef}^{commit}`]);
    const head = gitResult(root, ["rev-parse", "HEAD"]);
    if (taggedCommit.status !== 0 || head.status !== 0 ||
        taggedCommit.stdout.trim() !== head.stdout.trim()) {
        throw new Error(`release tag ${tag} does not point at HEAD`);
    }

    const ancestor = gitResult(root, [
        "merge-base", "--is-ancestor", taggedCommit.stdout.trim(), releaseBranch
    ]);
    if (ancestor.status !== 0) {
        throw new Error(`release tag ${tag} is not reachable from ${releaseBranch}`);
    }
}

export async function checkRelease(projectRoot, tag, releaseBranch = RELEASE_BRANCH_REF) {
    const root = path.resolve(projectRoot);
    return withReleaseLock(root, async () => {
        const files = await readReleaseFiles(root, { recover: false });
        const version = validateReleaseFiles(files, tag);
        if (tag !== undefined && tag !== null && tag !== "") {
            validateReleaseTag(root, tag, releaseBranch);
        }
        return version;
    }, { recover: false });
}

// The mutating half of what `check` used to do implicitly: finish an
// interrupted bump and clear its staging leftovers, then report the version the
// tree now holds.
export async function recoverRelease(projectRoot) {
    const root = path.resolve(projectRoot);
    return withReleaseLock(root, async () => validateReleaseFiles(await readReleaseFiles(root)));
}

// The bump used to re-serialise every target, and `JSON.stringify(metadata,
// null, 4)` is not byte-preserving for the shipped manifest: `"cinnamon-version":
// ["6.0"]` expands to three lines, so changing one value emitted a four-line diff
// in the twelve-line file Cinnamon parses at load. The documented recipe stages
// that file wholesale, handing the reviewer unrelated churn. `package.json` and
// `package-lock.json` do round-trip identically at indent 2, so only the manifest
// needs its own writer.
export function patchManifestVersion(original, nextVersion) {
    const patched = original.replace(/^([ \t]*"version"[ \t]*:[ \t]*)"[^"\r\n]*"/m,
        (match, prefix) => prefix + JSON.stringify(nextVersion));
    const expected = { ...JSON.parse(original), version: nextVersion };
    if (JSON.stringify(JSON.parse(patched)) !== JSON.stringify(expected)) {
        throw new Error("metadata.json version could not be replaced in place");
    }
    return patched;
}

async function bumpReleaseLocked(root, nextVersion) {
    const files = await readReleaseFiles(root);
    const currentVersion = validateReleaseFiles(files);
    if (compareVersions(nextVersion, currentVersion) <= 0) {
        throw new Error(`next version ${nextVersion} must be greater than ${currentVersion}`);
    }

    files.pkg.version = nextVersion;
    files.lock.version = nextVersion;
    files.lock.packages[""].version = nextVersion;
    files.metadata.version = nextVersion;
    files.template = patchTemplateVersion(files.original[3], nextVersion);

    validateReleaseFiles(files);

    const after = [
        JSON.stringify(files.pkg, null, 2) + "\n",
        JSON.stringify(files.lock, null, 2) + "\n",
        patchManifestVersion(files.original[2], nextVersion),
        files.template
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

export async function bumpRelease(projectRoot, nextVersion) {
    parseVersion(nextVersion);
    const root = path.resolve(projectRoot);
    return withReleaseLock(root, () => bumpReleaseLocked(root, nextVersion));
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === scriptPath) {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const command = process.argv[2] || "check";
    if (command === "check") {
        const version = await checkRelease(projectRoot, process.argv[3], process.argv[4]);
        process.stdout.write(`release metadata is consistent at v${version}\n`);
    } else if (command === "recover") {
        const version = await recoverRelease(projectRoot);
        process.stdout.write(`release metadata recovered at v${version}\n`);
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
