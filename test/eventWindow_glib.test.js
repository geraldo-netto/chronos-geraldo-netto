const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("native event windows normalize first and exclusive final civil days independently", (context) => {
    const cases = [
        ["America/Asuncion", 2023, 10, 1, "2023-09-25 00:00:00", "2023-11-05 23:59:59"],
        ["America/Asuncion", 2023, 10, 0, "2023-10-01 01:00:00", "2023-11-11 23:59:59"],
        ["America/Santiago", 2024, 8, 0, "2024-07-28 00:00:00", "2024-09-07 23:59:59"],
        ["Europe/Rome", 2026, 10, 1, "2026-09-28 00:00:00", "2026-11-08 23:59:59"]
    ];
    for (const [zone, year, month, weekStart, start, end] of cases) {
        const result = spawnSync("cjs", [path.join(__dirname, "helpers/eventWindowGlib.js"),
            path.resolve(__dirname, "../files/chronos@geraldo-netto"), year, month, weekStart],
        { encoding: "utf8", timeout: 10000, env: { ...process.env, TZ: zone } });
        if (result.error?.code === "ENOENT") {
            context.skip("cjs is not installed; native civil-day regressions require GLib");
            return;
        }
        assert.equal(result.status, 0, result.stderr || String(result.error));
        assert.deepEqual(JSON.parse(result.stdout), { start, end }, zone + " week start " + weekStart);
    }
});
