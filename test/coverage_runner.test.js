"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { test } = require("node:test");
const path = require("node:path");

const HELPER = path.join(__dirname, "helpers", "coverageReport.js");
const PROBE = `
const fs = require("node:fs");
const { createCoverageReport } = require(${JSON.stringify(HELPER)});
const report = createCoverageReport();
fs.writeFileSync(report.path, String(process.pid));
const value = fs.readFileSync(report.path, "utf8");
report.cleanup();
process.stdout.write(JSON.stringify({
    path: report.path,
    value,
    removed: !fs.existsSync(report.directory)
}));
`;

function runProbe() {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, ["-e", PROBE], (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
            } else {
                resolve(JSON.parse(stdout));
            }
        });
    });
}

test("concurrent coverage runs use private reports and clean them", async () => {
    const reports = await Promise.all(Array.from({ length: 8 }, runProbe));
    assert.equal(new Set(reports.map((report) => report.path)).size, reports.length);
    assert.equal(new Set(reports.map((report) => report.value)).size, reports.length,
        "each worker reads only the process id it wrote");
    assert.equal(reports.every((report) => report.removed), true,
        "every worker removes its private report directory");
});
