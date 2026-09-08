const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("native event windows normalize first and exclusive final civil days independently", (context) => {
    const cases = [
        ["America/Asuncion", 2023, 10, 1, "2023-09-25 00:00:00", "2023-11-05 23:59:59"],
        ["America/Asuncion", 2023, 10, 0, "2023-10-01 01:00:00", "2023-11-11 23:59:59"],
        ["America/Santiago", 2024, 8, 0, "2024-07-28 00:00:00", "2024-09-07 23:59:59"],
        ["Pacific/Apia", 2012, 1, 5, "2011-12-31 00:00:00", "2012-02-09 23:59:59"],
        ["Pacific/Kwajalein", 1969, 9, 0, "1969-08-31 00:00:00", "1969-10-11 23:59:59"],
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
        const actual = JSON.parse(result.stdout);
        assert.deepEqual({ start: actual.start, end: actual.end }, { start, end },
            zone + " week start " + weekStart);
    }
});

test("native Havana event windows include the first folded hour and exclude the next civil day", (context) => {
    const cases = [
        [2026, 11, "2026-11-01T04:00:00Z", "2026-12-13T04:59:59Z", -14400, -18000,
            ["2026-11-01T04:15:00Z", "2026-11-01T05:15:00Z"]],
        [2021, 10, "2021-09-26T04:00:00Z", "2021-11-07T03:59:59Z", -14400, -14400, []]
    ];
    for (const [year, month, start, end, startOffset, endOffset, events] of cases) {
        const eventTimes = events.map(utc => Date.parse(utc) / 1000);
        const result = spawnSync("cjs", [path.join(__dirname, "helpers/eventWindowGlib.js"),
            path.resolve(__dirname, "../files/chronos@geraldo-netto"), year, month, 0,
            JSON.stringify(eventTimes)],
        { encoding: "utf8", timeout: 10000, env: { ...process.env, TZ: "America/Havana" } });
        if (result.error?.code === "ENOENT") {
            context.skip("cjs is not installed; native event-window folds require GLib");
            return;
        }
        assert.equal(result.status, 0, result.stderr || String(result.error));
        const actual = JSON.parse(result.stdout);
        assert.equal(actual.startUnix, Date.parse(start) / 1000);
        assert.equal(actual.endUnix, Date.parse(end) / 1000);
        assert.equal(actual.startOffset, startOffset);
        assert.equal(actual.endOffset, endOffset);
        assert.deepEqual(actual.eventDays, eventTimes.map(() => actual.startUnix),
            "both copies of the first quarter-hour share the requested day's index key");
        for (const unix of eventTimes) {
            assert.ok(unix >= actual.startUnix && unix <= actual.endUnix,
                "the calendar server is asked for events in both copies of the folded hour");
        }
    }
});
