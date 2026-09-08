const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const Record = require("../files/chronos@geraldo-netto/holidayRecord");
const { isoDateParts } = require("../files/chronos@geraldo-netto/holidayServiceAdapters");

function translatedDatesInZone(zone) {
    const adapters = path.resolve(__dirname, "../files/chronos@geraldo-netto/holidayServiceAdapters.js");
    const script = `
        const { NagerDateServiceAdapter } = require(${JSON.stringify(adapters)});
        const adapter = new NagerDateServiceAdapter();
        const rows = ["2011-12-30", "1993-08-21"].map((date) => ({
            date, name: "Remote holiday", global: true, types: ["Public"]
        }));
        console.log(JSON.stringify(adapter.translateResponse(rows,
            adapter.params("ita", "global", 2011)).map((row) => row.date)));
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
        env: { ...process.env, TZ: zone }, encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

test("remote Gregorian holidays survive dates skipped in the host timezone", () => {
    const expected = [
        { year: 2011, month: 12, day: 30 },
        { year: 1993, month: 8, day: 21 }
    ];
    for (const zone of ["UTC", "Pacific/Apia", "Pacific/Kwajalein"]) {
        assert.deepEqual(translatedDatesInZone(zone), expected, zone);
    }
});

test("provider date parsing accepts the complete Gregorian range without century remapping", () => {
    for (const text of ["0001-01-01", "0004-02-29", "0099-12-31", "0100-01-01", "9999-12-31"]) {
        const [year, month, day] = text.split("-").map(Number);
        const parts = { year, month, day };
        assert.equal(Record.validDateParts(parts), true, text);
        assert.deepEqual(isoDateParts(text), parts, text);
    }
    for (const year of [-1, 0, 10000, Number.MAX_SAFE_INTEGER]) {
        assert.equal(Record.validDateParts({ year, month: 1, day: 1 }), false);
    }
    for (const text of ["0000-01-01", "0001-02-29", "0100-02-29", "10000-01-01"]) {
        assert.equal(isoDateParts(text), null, text);
    }
});

test("a holiday spanning years 99 and 100 expands into the original civil years", () => {
    const holiday = {
        date: { year: 99, month: 12, day: 31 },
        dateTo: { year: 100, month: 1, day: 2 },
        name: [{ lang: "en", text: "Year boundary" }], flags: ["public_holiday"]
    };
    const record = new Record.HolidayRecordContract();
    assert.equal(record.validResponse([holiday], 99), true);
    assert.equal(record.validResponse([holiday], 100), true);
    assert.equal(Record.holidaySpanDays(holiday.date, holiday.dateTo), 2);
    assert.deepEqual(record.expandHoliday(holiday, "global")
        .map(({ year, month, day }) => [year, month, day]),
    [[99, 12, 31], [100, 1, 1], [100, 1, 2]]);
});
