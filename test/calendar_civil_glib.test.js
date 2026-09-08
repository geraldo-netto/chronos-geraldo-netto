const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

function ordinal({ year, month, day }) {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getTime() / 86400000;
}

function isSkippedDate(zone, date) {
    const key = `${zone}/${date.year}/${date.month}/${date.day}`;
    return ["Pacific/Apia/2011/12/30", "Pacific/Kiritimati/1994/12/31"].includes(key);
}

function assertGrid(actual, input, zone) {
    const label = `${zone} ${JSON.stringify(input)}`;
    assert.equal(actual.days.length, 42, label);
    assert.equal(new Set(actual.days.map(day => JSON.stringify(day))).size, 42, label);
    const first = ordinal({ ...input, day: 1 });
    const offset = ((first + 4 - input.weekStart) % 7 + 7) % 7;
    const headings = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    assert.equal(actual.headings.length, 7, label);
    for (const heading of actual.headings) {
        assert.equal(heading.text, headings[(heading.column + input.weekStart) % 7], label);
    }
    for (let index = 0; index < 42; index++) {
        const day = actual.days[index];
        const cell = actual.cells[index];
        assert.equal(ordinal(day), first - offset + index, label);
        assert.equal(cell.label, String(day.day), label);
        assert.equal(cell.column, index % 7, label);
        assert.equal(cell.weekday, (index + input.weekStart) % 7, label);
        assert.match(cell.name, new RegExp(`${day.year}`), label);
        assert.equal(cell.holiday, day.day === 30 ? "Civil-date observance" : "", label);
        const skipped = isSkippedDate(zone, day);
        assert.equal(actual.keys[index] === null, skipped, label);
        assert.equal(cell.events, skipped ? 0 : 1, label);
        if (skipped) {
            assert.ok(!actual.clicked.some(clicked => ordinal(clicked) === ordinal(day)), label);
        }
    }
    assert.deepEqual(actual.lookupKeys, actual.keys.filter(key => key !== null),
        `${label}: a skipped date never borrows a neighboring event bucket`);
    assert.deepEqual(actual.clicked, actual.days.filter((day, index) => actual.keys[index] !== null), label);
}

test("native production grids retain every Gregorian cell across timezone discontinuities", (context) => {
    const groups = [
        ["Pacific/Apia", [{ year: 2011, month: 12, weekStart: 0, selectedDay: 29 },
            { year: 2012, month: 1, weekStart: 5 }]],
        ["Pacific/Kwajalein", [{ year: 1969, month: 9, weekStart: 0 },
            { year: 1969, month: 9, weekStart: 1 }]],
        ["Pacific/Kiritimati", [{ year: 1994, month: 11, weekStart: 0, selectedDay: 30 }]],
        ["Europe/Rome", [{ year: 2026, month: 3, weekStart: 1 },
            { year: 2026, month: 10, weekStart: 0 }, { year: 2024, month: 2, weekStart: 1 },
            { year: 1900, month: 2, weekStart: 0 }, { year: 2000, month: 2, weekStart: 1 },
            { year: 1, month: 2, weekStart: 0 }, { year: 4, month: 2, weekStart: 1 },
            { year: 99, month: 12, weekStart: 6 }, { year: 9999, month: 11, weekStart: 0 }]]
    ];
    for (const [zone, inputs] of groups) {
        const result = spawnSync("cjs", [path.join(__dirname, "helpers/calendarGridGlib.js"),
            path.resolve(__dirname, "../files/chronos@geraldo-netto"), JSON.stringify(inputs)],
        { encoding: "utf8", timeout: 10000, env: { ...process.env, TZ: zone, LC_ALL: "C.UTF-8" } });
        if (result.error?.code === "ENOENT") {
            context.skip("cjs is not installed; native Gregorian grid checks require GLib");
            return;
        }
        assert.equal(result.status, 0, result.stderr || String(result.error));
        const grids = JSON.parse(result.stdout);
        grids.forEach((grid, index) => assertGrid(grid, inputs[index], zone));
        if (zone === "Pacific/Apia") {
            assert.deepEqual(grids[0].steps, [{ year: 2011, month: 12, day: 31 },
                { year: 2011, month: 12, day: 29 }]);
            assert.deepEqual(grids[0].weeks, ["48", "49", "50", "51", "52", "01"]);
            assert.equal(grids[0].cells.find(cell => cell.name.startsWith("Friday, December 30")).events, 0);
        }
        if (zone === "Pacific/Kwajalein") {
            assert.deepEqual(grids[0].weeks, ["36", "37", "38", "39", "40", "41"]);
        }
        if (zone === "Pacific/Kiritimati") {
            assert.deepEqual(grids[0].browsed, { year: 1994, month: 12, day: 30 },
                "a skipped last date must not make December appear to have one day");
        }
    }
});
