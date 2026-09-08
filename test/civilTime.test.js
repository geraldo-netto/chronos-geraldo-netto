const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

let construct;
global.imports = { gi: { GLib: {
    TimeType: { STANDARD: 0, DAYLIGHT: 1 },
    DateTime: { new: (...args) => construct(...args) }
} } };
const { civilDayStart, projectCivilDate } = require("../files/chronos@geraldo-netto/civilTime");

function dateTime(timestamp, offset) {
    return {
        to_unix: () => timestamp,
        get_utc_offset: () => offset * 1000000,
        add_seconds: seconds => dateTime(timestamp + seconds, offset)
    };
}

test("civil boundaries retain GLib gap normalization and invalid-date results", () => {
    const zone = { find_interval: () => -1 };
    const normalized = dateTime(1000, 3600);
    construct = (...args) => {
        assert.deepEqual(args, [zone, 2026, 9, 6, 0, 0, 0]);
        return normalized;
    };
    assert.equal(civilDayStart(2026, 9, 6, zone), normalized);
    construct = () => null;
    assert.equal(civilDayStart(10000, 1, 1, zone), null);
});

test("civil boundaries choose the earliest local interval without losing their timezone", () => {
    const calls = [];
    const zone = {
        find_interval(type, localTime) { calls.push([type, localTime]); return type; },
        get_offset: interval => [21600, 23400][interval]
    };
    const secondMidnight = dateTime(1000, 21600);
    construct = () => secondMidnight;
    assert.equal(civilDayStart(1996, 10, 26, zone).to_unix(), -800);
    assert.deepEqual(calls, [[0, 22600], [1, 22600]],
        "both local intervals are checked, including a non-seasonal half-hour fold");

    zone.get_offset = interval => [23400, 21600][interval];
    assert.equal(civilDayStart(1996, 10, 26, zone).to_unix(), -800,
        "the earlier interval is chosen regardless of its time-type label");
    construct = () => dateTime(-800, 23400);
    assert.equal(civilDayStart(1996, 10, 26, zone).to_unix(), -800,
        "an already-earliest constructor result stays unchanged");
});

test("a civil projection rejects normalized neighboring dates and missing dates", () => {
    const selected = { year: 2011, month: 12, day: 30 };
    const zone = { find_interval: () => -1 };
    const projection = parts => ({ ...dateTime(1000, 0), get_year: () => parts.year,
        get_month: () => parts.month, get_day_of_month: () => parts.day });
    const valid = projection(selected);
    construct = () => valid;
    assert.equal(projectCivilDate(selected, zone), valid);
    for (const changed of [{ year: 2012 }, { month: 11 }, { day: 31 }]) {
        construct = () => projection({ ...selected, ...changed });
        assert.equal(projectCivilDate(selected, zone), null);
    }
    construct = () => null;
    assert.equal(projectCivilDate(selected, zone), null);
});

test("native civil boundaries include seasonal and political midnight folds", (context) => {
    const cases = [
        ["America/Havana", 2026, 11, 1, "2026-11-01T04:00:00Z", -14400],
        ["Asia/Colombo", 1996, 10, 26, "1996-10-25T17:30:00Z", 23400],
        ["Asia/Colombo", 2006, 4, 15, "2006-04-14T18:00:00Z", 21600],
        ["America/Santiago", 2026, 9, 6, "2026-09-06T04:00:00Z", -10800]
    ];
    const result = spawnSync("cjs", [path.join(__dirname, "helpers/civilTimeGlib.js"),
        path.resolve(__dirname, "../files/chronos@geraldo-netto"), JSON.stringify(cases)],
    { encoding: "utf8", timeout: 10000 });
    if (result.error?.code === "ENOENT") {
        context.skip("cjs is not installed; native civil boundaries require GLib");
        return;
    }
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.deepEqual(JSON.parse(result.stdout), cases.map(([zone, year, month, day, utc, offset]) => ({
        zone, year, month, day, unix: Date.parse(utc) / 1000, offset
    })));
});
