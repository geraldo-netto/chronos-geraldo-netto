const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const cases = [
    ["America/Santiago", "2026-09-06T12:00:00Z", "2026-09-06T04:00:00Z", "2026-09-07T03:00:00Z"],
    ["America/Santiago", "2026-09-07T03:30:00Z", "2026-09-07T03:00:00Z", "2026-09-08T03:00:00Z"],
    ["America/Havana", "2026-03-08T12:00:00Z", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
    ["Europe/Rome", "2026-10-25T12:00:00Z", "2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z"],
    ["Pacific/Apia", "2011-12-29T12:00:00Z", "2011-12-29T10:00:00Z", "2011-12-30T10:00:00Z"],
    ["UTC", "2026-12-31T12:00:00Z", "2026-12-31T00:00:00Z", "2027-01-01T00:00:00Z"]
];

test("actual GLib keeps astronomy within each civil date across timezone transitions", (context) => {
    const root = path.resolve(__dirname, "../files/chronos@geraldo-netto");
    const input = cases.map(([zone, now]) => ({ zone, now }));
    const result = spawnSync("cjs", [path.join(__dirname, "helpers/astronomyGlib.js"),
        root, JSON.stringify(input)], { encoding: "utf8", timeout: 10000 });
    if (result.error?.code === "ENOENT") {
        context.skip("cjs is not installed; the portable unit suite still checks boundary construction");
        return;
    }
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const bounds = JSON.parse(result.stdout);
    const expected = cases.map(([, , start, end]) => ({
        startMs: Date.parse(start), endMs: Date.parse(end)
    }));
    assert.deepEqual(bounds, expected);
});
