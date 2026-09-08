#!/usr/bin/env node
import { createHash } from "node:crypto";
import console from "node:console";
import { lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import Calendars from "../files/chronos@geraldo-netto/calendarSourceAdapters.js";

const UUID = "chronos@geraldo-netto";
const MAX_PROFILE_BYTES = 1024 * 1024;

function entries(directory) {
    try {
        if (!lstatSync(directory).isDirectory()) throw new Error(`Not a directory: ${directory}`);
        return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
}

function setting(profile, key) {
    if (!Object.hasOwn(profile, key)) return undefined;
    const entry = profile[key];
    if (!entry || !Object.hasOwn(entry, "value")) throw new Error(`Invalid setting: ${key}`);
    return entry.value;
}

function selectionName(row) {
    const [selected] = Calendars.countrySelections([{ ...row, enabled: true }]);
    if (!selected) throw new Error("Invalid configured country or region; cleanup stopped");
    return `calendar-${selected.country}-${selected.region}.json`;
}

function profileSelections(profile) {
    if (!profile || Array.isArray(profile) || typeof profile !== "object") {
        throw new Error("Invalid applet profile; cleanup stopped");
    }
    const country = setting(profile, "country");
    const inferCountry = country === undefined || country === "";
    const names = [];
    if (!inferCountry && country !== "none") {
        const region = setting(profile, `region_${country}`);
        names.push(selectionName(region === undefined ? { country } : { country, region }));
    }
    const extras = setting(profile, "extra-country-calendars") ?? [];
    if (!Array.isArray(extras)) throw new Error("Invalid additional calendar list; cleanup stopped");
    return { inferCountry, names: names.concat(extras.map(selectionName)) };
}

function profiles(directory) {
    const digest = createHash("sha256");
    const names = new Set();
    let inferCountry = false;
    for (const entry of entries(directory).filter((file) => file.name.endsWith(".json"))) {
        const path = join(directory, entry.name);
        if (!entry.isFile() || lstatSync(path).size > MAX_PROFILE_BYTES) {
            throw new Error(`Unsafe or oversized applet profile: ${path}`);
        }
        const text = readFileSync(path, "utf8");
        digest.update(entry.name).update("\0").update(text).update("\0");
        const selected = profileSelections(JSON.parse(text));
        inferCountry ||= selected.inferCountry;
        selected.names.forEach((name) => names.add(name));
    }
    return { names, inferCountry, signature: digest.digest("hex") };
}

function cacheFile(entry) {
    if (!entry.isFile()) return false;
    const match = /^calendar-([a-z]{3})-([a-z0-9-]+)\.json$/.exec(entry.name);
    if (!match) return false;
    try {
        return entry.name === selectionName({ country: match[1], region: match[2] });
    } catch {
        return false;
    }
}

function fileIdentity(path) {
    const stat = lstatSync(path);
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

export function defaultDirectories(env = process.env) {
    return {
        cacheDir: join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), UUID),
        settingsDir: join(env.XDG_CONFIG_HOME || join(homedir(), ".config"),
            "cinnamon", "spices", UUID)
    };
}

export function inspectCleanup({ cacheDir, settingsDir }) {
    const protectedFiles = profiles(settingsDir);
    const candidates = entries(cacheDir).filter(cacheFile)
        .filter((entry) => !protectedFiles.inferCountry && !protectedFiles.names.has(entry.name))
        .map((entry) => {
            const path = join(cacheDir, entry.name);
            return { path, identity: fileIdentity(path) };
        });
    return { cacheDir, settingsDir, candidates, signature: protectedFiles.signature };
}

function cinnamonProcess(path, uid) {
    try {
        if (lstatSync(path).uid !== uid) return false;
        return /^cinnamon(?:-|$)/.test(readFileSync(join(path, "comm"), "utf8").trim());
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return false;
    }
}

export function cinnamonRunning(procDir = "/proc", uid = process.getuid()) {
    if (!lstatSync(procDir).isDirectory()) throw new Error("Process directory is unavailable");
    return entries(procDir).filter((file) => /^[0-9]+$/.test(file.name))
        .some((entry) => cinnamonProcess(join(procDir, entry.name), uid));
}

export function applyCleanup(plan, isRunning = cinnamonRunning) {
    const removed = [];
    for (const candidate of plan.candidates) {
        if (isRunning()) throw new Error("Log out of Cinnamon before applying cache cleanup");
        const current = inspectCleanup(plan);
        if (current.signature !== plan.signature) throw new Error("Applet profiles changed; rerun the preview");
        if (!current.candidates.some((file) => file.path === candidate.path && file.identity === candidate.identity)) {
            throw new Error("A candidate cache changed; rerun the preview");
        }
        unlinkSync(candidate.path);
        removed.push(candidate.path);
    }
    return removed;
}

export function run(argv = process.argv.slice(2), output = console.log) {
    const { values } = parseArgs({ args: argv, options: {
        apply: { type: "boolean" }, help: { type: "boolean" },
        "cache-dir": { type: "string" }, "settings-dir": { type: "string" }
    } });
    if (values.help) {
        output("Preview: node scripts/cleanup-calendar-cache.mjs [--cache-dir PATH] [--settings-dir PATH]\n" +
            "Apply after logging out of Cinnamon: add --apply. Configured calendars are preserved.");
        return;
    }
    const directories = defaultDirectories();
    const plan = inspectCleanup({
        cacheDir: resolve(values["cache-dir"] || directories.cacheDir),
        settingsDir: resolve(values["settings-dir"] || directories.settingsDir)
    });
    const paths = values.apply ? applyCleanup(plan) : plan.candidates.map((file) => file.path);
    output(`${values.apply ? "Removed" : "Would remove"} ${paths.length} inactive calendar cache files.`);
    paths.forEach((path) => output(path));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        run();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
