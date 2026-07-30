#!/usr/bin/env node
"use strict";

// Node's --test-coverage-* thresholds are *aggregate*: with 34 files in the
// pool, one file can sit at 50 % and the suite still exits 0 on the average.
// That is not hypothetical — three files were already under their own declared
// gate while the headline read 99 % lines / 96 % branches.
//
// This runs the JS suite, then holds every file to the same numbers the
// aggregate claims.

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { createCoverageReport } = require("./coverageReport");

const LINES = 98;
const BRANCHES = 90;
const FUNCTIONS = 100;

// These orchestration files own teardown and stale-callback guards. Their
// historical 98 % slack was exactly those guards, so keep their line paths
// exhaustive while the broader UI files retain the practical project floor.
const LINE_OVERRIDES = new Map([
    ["files/chronos@geraldo-netto/eventsManager.js", 100],
    ["files/chronos@geraldo-netto/holidays.js", 100]
]);

const APPLET_DIR = path.join(__dirname, "..", "..");

// The two directories the include globs above cover. A shipped file that no
// test require()s never appears in the coverage report, so the per-file loop
// below cannot hold it to anything — it is silently exempt from the gate. Glob
// the shipped files from disk and demand each one was actually measured.
const MEASURED_DIRS = [
    [path.join(APPLET_DIR, "files", "chronos@geraldo-netto"), ".js"],
    [path.join(APPLET_DIR, "files", "chronos@geraldo-netto", "5.4"), ".js"],
    [path.join(APPLET_DIR, "scripts"), ".mjs"]
];

function measuredFiles() {
    const files = [];
    for (const [dir, extension] of MEASURED_DIRS) {
        for (const entry of fs.readdirSync(dir)) {
            if (entry.endsWith(extension)) {
                files.push(path.join(dir, entry));
            }
        }
    }
    return files;
}

function discoverJavaScriptTests(root = path.join(APPLET_DIR, "test")) {
    const files = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...discoverJavaScriptTests(entryPath));
        } else if (entry.name.endsWith(".test.js")) {
            files.push(entryPath);
        }
    }
    return files.sort();
}

function runCoverage() {
    const report = createCoverageReport();
    try {
        const result = spawnSync("node", [ // NOSONAR [S4036] -- trusted test runner
            "--test",
            "--experimental-test-coverage",
            "--test-coverage-include=files/chronos@geraldo-netto/*.js",
            "--test-coverage-include=files/chronos@geraldo-netto/5.4/*.js",
            "--test-coverage-include=scripts/*.mjs",
            `--test-coverage-lines=${LINES}`,
            `--test-coverage-branches=${BRANCHES}`,
            `--test-coverage-functions=${FUNCTIONS}`,
            "--test-reporter=spec",
            "--test-reporter-destination=stdout",
            "--test-reporter=./test/helpers/coverage-reporter.js",
            `--test-reporter-destination=${report.path}`,
            ...discoverJavaScriptTests()
        ], { cwd: APPLET_DIR, stdio: "inherit", shell: false });

        if (result.status !== 0) {
            return result.status === null ? 1 : result.status;
        }

        const summary = JSON.parse(fs.readFileSync(report.path, "utf8"));
        return evaluateCoverage(summary);
    } finally {
        report.cleanup();
    }
}

function missingCoverageFailures(summary) {
    const failures = [];
    const measured = new Set(summary.files.map((file) => path.resolve(file.path)));
    for (const file of measuredFiles()) {
        if (!measured.has(path.resolve(file))) {
            failures.push(
                `${path.relative(APPLET_DIR, file)}: no test loads it, so its coverage was never measured`);
        }
    }
    return failures;
}

function thresholdFailures(file) {
    const failures = [];
    const name = path.relative(APPLET_DIR, file.path);
    const lineThreshold = LINE_OVERRIDES.get(name) || LINES;
    const checks = [
        ["lines", file.coveredLinePercent, lineThreshold],
        ["branches", file.coveredBranchPercent, BRANCHES],
        ["functions", file.coveredFunctionPercent, FUNCTIONS]
    ];

    for (const [what, actual, threshold] of checks) {
        // a file with no branches at all reports 100; nothing to hold it to
        if (actual + 1e-9 < threshold) {
            failures.push(
                `${name}: ${what} ${actual.toFixed(2)} % is under the ${threshold} % gate`);
        }
    }
    return failures;
}

function reportCoverageFailures(failures) {
    console.error("\nper-file coverage below the thresholds the suite claims:\n");
    for (const failure of failures) {
        console.error("  " + failure);
    }
    console.error(
        "\nThe aggregate gate passed. It always will: one file at 50 % disappears " +
        "into the average of 34.\n");
}

function evaluateCoverage(summary) {
    const failures = missingCoverageFailures(summary)
        .concat(summary.files.flatMap(thresholdFailures));
    if (failures.length > 0) {
        reportCoverageFailures(failures);
        return 1;
    }

    console.log(`\nper-file coverage: every file meets ${LINES}/${BRANCHES}/${FUNCTIONS}`);
    return 0;
}

if (require.main === module) {
    process.exitCode = runCoverage();
}

module.exports = { discoverJavaScriptTests };
