"use strict";

const assert = require("node:assert/strict");
const { execFile, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const { test } = require("node:test");
const path = require("node:path");
const { discoverJavaScriptTests } = require("./helpers/coverage");

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

test("the coverage runner discovers and executes nested JavaScript tests", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-js-tests-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const nested = path.join(root, "integration");
    const marker = path.join(root, "nested-executed");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "nested.test.js"), `
        const fs = require("node:fs");
        const { test } = require("node:test");
        test("nested sentinel", () => fs.writeFileSync(${JSON.stringify(marker)}, "yes"));
    `);
    fs.writeFileSync(path.join(nested, "ignored.js"), "throw new Error('ignored');\n");

    const files = discoverJavaScriptTests(root);
    assert.deepEqual(files, [path.join(nested, "nested.test.js")]);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", ...files], {
        encoding: "utf8",
        env,
        shell: false
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(marker, "utf8"), "yes");
});
