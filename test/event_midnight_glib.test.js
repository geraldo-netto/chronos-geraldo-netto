const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const CASES = [
    ["UTC", "2026-09-08T23:30:00Z", "2026-09-09T00:00:00Z", ["2026-09-08"]],
    ["UTC", "2026-09-09T00:00:00Z", "2026-09-09T00:00:00Z", ["2026-09-09"]],
    ["Europe/Rome", "2026-03-28T22:30:00Z", "2026-03-29T22:00:00Z", ["2026-03-28", "2026-03-29"]],
    ["Europe/Rome", "2026-10-24T21:30:00Z", "2026-10-25T23:00:00Z", ["2026-10-24", "2026-10-25"]],
    ["America/Havana", "2026-11-01T03:30:00Z", "2026-11-01T04:00:00Z", ["2026-10-31"]],
    ["America/Havana", "2026-11-01T04:30:00Z", "2026-11-01T05:00:00Z", ["2026-11-01"]],
    ["America/Santiago", "2026-09-06T03:30:00Z", "2026-09-06T04:00:00Z", ["2026-09-05"]]
];

test("T1159 native event occupancy handles ordinary, repeated and skipped midnights", (context) => {
    for (const [zone, start, end, days] of CASES) {
        const result = spawnSync("cjs", [path.join(__dirname, "helpers/eventMidnightGlib.js"),
            path.resolve(__dirname, "../files/chronos@geraldo-netto"), JSON.stringify([{ start, end }])],
        { encoding: "utf8", timeout: 10000, env: { ...process.env, TZ: zone } });
        if (result.error?.code === "ENOENT") {
            context.skip("cjs unavailable; portable agenda/dot occupancy regressions remain active");
            return;
        }
        assert.equal(result.status, 0, result.stderr || String(result.error));
        assert.deepEqual(JSON.parse(result.stdout), [{ end: Date.parse(end) / 1000, days }], zone);
    }
});
