#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import console from "node:console";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const SCOPES = JSON.parse(readFileSync(new URL("../tools/mutation/scopes.json", import.meta.url)));
const BASE = JSON.parse(readFileSync(new URL("../tools/mutation/stryker.config.json", import.meta.url)));
const CAMPAIGN_IO = { existsSync, mkdirSync, rmSync, writeFileSync, spawnSync };
const HELP = "Manual mutation tooling (maintainer-operated)\n" +
    "  npm run mutation:manual -- --list\n" +
    "  npm run mutation:manual -- <scope> --print-config  (no Stryker execution)\n" +
    "  npm run mutation:manual -- <scope>                (starts a campaign)\n" +
    "Install the optional runner: npm ci --prefix tools/mutation --ignore-scripts\n" +
    "See docs/mutation-testing.md for ownership and report interpretation.";

function scopeFor(name) {
    if (typeof name !== "string" || !Object.hasOwn(SCOPES, name)) {
        throw new Error(`Unknown mutation scope: ${String(name)}. Use --list.`);
    }
    return SCOPES[name];
}

export function configuration(name) {
    const scope = scopeFor(name);
    const reportRoot = `.cache/chronos-mutation/reports/${name}`;
    return {
        ...BASE,
        mutate: [...scope.mutate],
        commandRunner: { command: `node --test ${scope.tests.join(" ")}` },
        htmlReporter: { fileName: `${reportRoot}/index.html` },
        jsonReporter: { fileName: `${reportRoot}/mutation.json` }
    };
}

export function parseArguments(args) {
    if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
        return { action: "help" };
    }
    if (args.length === 1 && args[0] === "--list") {
        return { action: "list" };
    }
    scopeFor(args[0]);
    if (args.length > 2 || (args.length === 2 && args[1] !== "--print-config")) {
        throw new Error("Expected <scope> with only the optional --print-config flag.");
    }
    return { action: args.length === 2 ? "preview" : "run", scope: args[0] };
}

function acquireCampaignLock(lockPath, io) {
    try {
        io.mkdirSync(lockPath);
    } catch (error) {
        if (error.code === "EEXIST") {
            throw new Error("Another mutation campaign owns the campaign lock. " +
                "Wait for it to finish; after a crash, see docs/mutation-testing.md for stale-lock recovery.",
            { cause: error });
        }
        throw error;
    }
}

function launchCampaign(binary, configPath, io) {
    const result = io.spawnSync(process.execPath, [binary, "run", configPath], {
        cwd: ROOT, stdio: "inherit", shell: false
    });
    if (result.error) {
        throw result.error;
    }
    return result.status === null ? 1 : result.status;
}

export function runCampaign(name, io = CAMPAIGN_IO) {
    const config = configuration(name);
    const binary = path.join(ROOT, "tools/mutation/node_modules/@stryker-mutator/core/bin/stryker.js");
    if (!io.existsSync(binary)) {
        throw new Error("Optional runner missing. Run npm ci --prefix tools/mutation --ignore-scripts.");
    }
    const configPath = path.join(ROOT, ".cache/chronos-mutation/config.json");
    const lockPath = path.join(ROOT, ".cache/chronos-mutation/campaign.lock");
    io.mkdirSync(path.dirname(configPath), { recursive: true });
    acquireCampaignLock(lockPath, io);
    try {
        io.writeFileSync(path.join(lockPath, "owner.json"),
            JSON.stringify({ pid: process.pid, scope: name }) + "\n");
        io.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        return launchCampaign(binary, configPath, io);
    } finally {
        io.rmSync(lockPath, { recursive: true, force: true });
    }
}

export function main(args, io = { out: console.log, error: console.error, run: runCampaign }) {
    try {
        const options = parseArguments(args);
        if (options.action === "run") {
            return io.run(options.scope);
        }
        const outputs = {
            help: () => HELP,
            list: () => Object.entries(SCOPES).map(([name, scope]) => `${name}: ${scope.description}`).join("\n"),
            preview: () => JSON.stringify(configuration(options.scope), null, 2)
        };
        io.out(outputs[options.action]());
        return 0;
    } catch (error) {
        io.error(error.message);
        return 2;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    process.exitCode = main(process.argv.slice(2));
}
