const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../files/chronos@geraldo-netto");

function largePlugin(temporary) {
    const directory = path.join(temporary, "chronos@geraldo-netto/calendars");
    fs.mkdirSync(directory, { recursive: true });
    const bytes = JSON.stringify({ apiVersion: 1, id: "example.large", name: "Large calendar",
        category: "custom", coverage: { from: 2026, through: 2027 }, source: { name: "Fixture" },
        events: Array.from({ length: 4096 }, () => ({ name: "x".repeat(150), month: 1, day: 1 })) });
    fs.writeFileSync(path.join(directory, "example.large.json"), bytes);
    return Buffer.byteLength(bytes);
}

function expectedCounts(mode, size) {
    const active = mode === "active";
    return {
        started: active ? 1 : 3, completed: active ? 1 : 3, delivered: active ? 1 : 0,
        validated: active ? 1 : 0, decodedBytes: active ? size : 0,
        realTokens: true, errors: 0, timedOut: false
    };
}

test("native Gio cancels abandoned large plugin loads without decoding or validating", context => {
    const probe = spawnSync("cjs", ["--version"], { encoding: "utf8", timeout: 10000 });
    if (probe.error?.code === "ENOENT") {
        context.skip("cjs is not installed; native plugin cancellation requires Gio");
        return;
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-plugin-cancel-"));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const size = largePlugin(temporary);
    assert.ok(size > 700000 && size < 1024 * 1024);
    for (const mode of ["active", "destroy", "empty"]) {
        const result = spawnSync("cjs", [path.join(__dirname, "helpers/calendarPluginCancellationGlib.js"), root, mode], {
            encoding: "utf8", timeout: 10000, cwd: temporary,
            env: { ...process.env, HOME: temporary, XDG_DATA_HOME: temporary }
        });
        assert.equal(result.status, 0, result.stderr || String(result.error));
        assert.deepEqual(JSON.parse(result.stdout), expectedCounts(mode, size), mode);
    }
});
