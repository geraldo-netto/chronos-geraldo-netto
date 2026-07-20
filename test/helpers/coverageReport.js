"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function createCoverageReport() {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "cinnamon-chronos-coverage-"));
    return {
        directory,
        path: path.join(directory, "coverage.json"),
        cleanup() {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    };
}

module.exports = { createCoverageReport };
