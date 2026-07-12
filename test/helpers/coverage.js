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

const LINES = 98;
const BRANCHES = 90;
const FUNCTIONS = 100;

const APPLET_DIR = path.join(__dirname, "..", "..");

const result = spawnSync("node", [
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=files/chronos@geraldo-netto/*.js",
    "--test-coverage-include=files/chronos@geraldo-netto/5.4/*.js",
    `--test-coverage-lines=${LINES}`,
    `--test-coverage-branches=${BRANCHES}`,
    `--test-coverage-functions=${FUNCTIONS}`,
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=./test/helpers/coverage-reporter.js",
    "--test-reporter-destination=./coverage.json",
    "test/*.test.js"
], { cwd: APPLET_DIR, stdio: "inherit", shell: false });

if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
}

const summary = require(path.join(APPLET_DIR, "coverage.json"));
const failures = [];

for (const file of summary.files) {
    const name = path.relative(APPLET_DIR, file.path);
    const checks = [
        ["lines", file.coveredLinePercent, LINES],
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
}

if (failures.length > 0) {
    console.error("\nper-file coverage below the thresholds the suite claims:\n");
    for (const failure of failures) {
        console.error("  " + failure);
    }
    console.error(
        "\nThe aggregate gate passed. It always will: one file at 50 % disappears " +
        "into the average of 34.\n");
    process.exit(1);
}

console.log(`\nper-file coverage: every file meets ${LINES}/${BRANCHES}/${FUNCTIONS}`);
