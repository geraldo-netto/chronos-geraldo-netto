"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TIMEOUT_MS = 30000;
const SUITES = ["calendar", "weather", "settings"];

function integerSetting(value, fallback, minimum, maximum, name) {
    const text = value === undefined ? String(fallback) : value;
    if (!/^\d+$/.test(text)) {
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
    const number = Number(text);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
    return number;
}

function parseConfig(env) {
    return {
        seed: integerSetting(env.FUZZ_SEED, 20260908, 0, 0xffffffff, "FUZZ_SEED"),
        cases: integerSetting(env.FUZZ_CASES, 512, 1, 10000, "FUZZ_CASES")
    };
}

function auditFailure(suite, seed, message) {
    return { checks: 1, failureCount: 1, failures: [
        { target: `${suite}.harness`, seed, case: null, input: null, message }
    ] };
}

function validReport(report) {
    return report && Number.isSafeInteger(report.checks) && report.checks > 0 &&
        Number.isSafeInteger(report.failureCount) && report.failureCount >= 0 &&
        report.failureCount <= report.checks && Array.isArray(report.failures) &&
        report.failures.length <= report.failureCount &&
        Boolean(report.failures.length) === Boolean(report.failureCount);
}

function readReport(result, suite, seed) {
    if (result.error || result.signal) {
        return auditFailure(suite, seed, String(result.error || result.signal));
    }
    try {
        const report = JSON.parse(result.stdout);
        if (!validReport(report)) {
            throw new Error("Invalid or empty fuzz report");
        }
        const expectedStatus = report.failureCount ? 1 : 0;
        if (result.status !== expectedStatus) {
            throw new Error(`Worker exit ${result.status} contradicts its report`);
        }
        return report;
    } catch (error) {
        return auditFailure(suite, seed,
            `${error.message}; stderr: ${String(result.stderr || "").slice(0, 2000)}`);
    }
}

function runAudits(config, invoke = spawnSync) {
    const suites = SUITES.map((suite) => {
        const python = suite === "settings";
        const command = python ? "python3" : process.execPath;
        const args = python ? ["-B", path.join(__dirname, "settings_inputs.py")] :
            [path.join(__dirname, "runner.js"), "--worker", suite];
        const result = invoke(command, args, {
            input: JSON.stringify(config), encoding: "utf8", shell: false,
            cwd: path.resolve(__dirname, "../.."), timeout: TIMEOUT_MS,
            maxBuffer: 2 * 1024 * 1024
        });
        return { suite, ...readReport(result, suite, config.seed) };
    });
    return {
        ...config,
        checks: suites.reduce((total, suite) => total + suite.checks, 0),
        failureCount: suites.reduce((total, suite) => total + suite.failureCount, 0),
        suites
    };
}

function runWorker(suite) {
    if (suite !== "calendar" && suite !== "weather") {
        throw new Error(`Unknown fuzz worker: ${suite}`);
    }
    const raw = JSON.parse(fs.readFileSync(0, "utf8"));
    const config = parseConfig({ FUZZ_SEED: String(raw.seed), FUZZ_CASES: String(raw.cases) });
    if (suite === "calendar") {
        return require("./calendar_inputs").runCalendarInputs(config);
    }
    return require("./weather_inputs").runWeatherInputs(config);
}

function main(args = process.argv.slice(2), env = process.env) {
    try {
        if (args.length !== 0 && (args.length !== 2 || args[0] !== "--worker")) {
            throw new Error("Use FUZZ_SEED and FUZZ_CASES to configure the input audit");
        }
        const report = args.length ? runWorker(args[1]) : runAudits(parseConfig(env));
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        return report.failureCount ? 1 : 0;
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        return 2;
    }
}

if (require.main === module) {
    process.exitCode = main();
}

module.exports = { parseConfig, readReport, runAudits };
