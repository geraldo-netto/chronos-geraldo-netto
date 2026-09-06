const {
    assert, test, makeRandom, STAMP, loadHolidays, holiday, holidayRecordPath
} = require("./helpers/holidayFixture");

function row(year, region, day, name, flags = []) {
    return { year, month: 1, day, region, name, flags };
}

function makeCache(initial = { years: {}, holidays: [] }) {
    const { HolidayCache } = loadHolidays();
    let saved = initial;
    const cache = new HolidayCache((_country, done) => done(saved), (_country, data) => {
        saved = JSON.parse(JSON.stringify(data));
    });
    cache.setPlace("ita", "global");
    return { cache, reload() {
        const reloaded = new HolidayCache((_country, done) => done(saved), () => {});
        reloaded.setPlace("ita", "global");
        return reloaded;
    } };
}

test("holiday snapshots replace old names, flags and dates through persistence", () => {
    const { cache, reload } = makeCache({
        years: { 2026: { global: STAMP, north: STAMP }, 2027: { global: STAMP } },
        holidays: [row(2026, "global", 1, "Old", ["public_holiday"]),
            row(2026, "global", 2, "Removed"), row(2026, "north", 1, "Regional"),
            row(2027, "global", 1, "Neighbor")]
    });
    assert.equal(cache.matchMonth(2026, 1).size, 2);
    cache.recordAttempt(2025, "global");
    cache.matchMonth(2027, 1);

    cache.recordFetch(2026, null, STAMP, [row(2026, null, 1, "Corrected")]);
    const corrected = [["1/1", { name: "Corrected", flags: [] }]];
    assert.deepEqual([...cache.matchMonth(2026, 1)], corrected);
    assert.deepEqual([...cache._yearUse.keys()], [2025, 2027, 2026],
        "replacement preserves recency of sibling years and failed attempts");
    cache.persist();
    assert.deepEqual([...reload().matchMonth(2026, 1)], corrected);

    cache.recordFetch(2026, "global", STAMP, []);
    assert.equal(cache.matchMonth(2026, 1).size, 0, "a warm month memo loses removed rows");
    cache.persist();
    const reloaded = reload();
    assert.equal(reloaded.matchMonth(2026, 1).size, 0);
    assert.equal(reloaded.stale(2026, "global"), false, "empty snapshots remain fresh");
    assert.equal(reloaded.matchMonth(2026, 1, "north").get("1/1").name, "Regional");
    assert.equal(reloaded.matchMonth(2027, 1).get("1/1").name, "Neighbor");
    assert.equal(reloaded.years[2026].north, STAMP);
    assert.equal(reloaded.years[2027].global, STAMP);
});

test("holiday snapshots still merge coincident holidays within the new response", () => {
    const { cache } = makeCache();
    cache.recordFetch(2026, "global", STAMP, [row(2026, "global", 1, "Obsolete")]);
    for (let repeat = 0; repeat < 2; repeat++) {
        cache.recordFetch(2026, "global", STAMP, [
            row(2026, "global", 1, "First"),
            row(2026, "global", 1, "Second", ["public_holiday"])
        ]);
        assert.deepEqual(cache.matchMonth(2026, 1).get("1/1"),
            { name: "First\nSecond", flags: ["public_holiday"] });
        assert.equal(cache.data.length, 1);
    }
});

test("year-spanning holiday snapshots cannot overwrite or resurrect adjacent years", () => {
    for (const order of [[2026, 2027], [2027, 2026]]) {
        const { cache } = makeCache();
        const { HolidayRecordContract } = require(holidayRecordPath);
        const record = new HolidayRecordContract();
        const span = Object.assign(holiday("Year end", 2026, 12, 31),
            { dateTo: { year: 2027, month: 1, day: 2 } });
        const fetch = (year) => cache.recordFetch(year, "global", STAMP,
            record.expandHoliday(span, "global"));
        fetch(order[0]);
        assert.deepEqual([...new Set(cache.data.map((single) => single.year))], [order[0]]);
        fetch(order[1]);
        assert.equal(cache.matchMonth(2026, 12).size, 1);
        assert.equal(cache.matchMonth(2027, 1).size, 2);

        cache.recordFetch(order[0], "global", STAMP, []);
        fetch(order[1]);
        assert.equal(cache.data.some((single) => single.year === order[0]), false);
        assert.equal(cache.matchMonth(order[0], order[0] === 2026 ? 12 : 1).size, 0);
        assert.equal(cache.stale(order[0], "global"), false);
    }
});

test("seeded holiday refreshes retain only the latest snapshot per year and region", () => {
    const { cache } = makeCache();
    const random = makeRandom(1044);
    const expected = new Map();
    for (let turn = 0; turn < 100; turn++) {
        const year = 2026 + Math.floor(random() * 2);
        const region = ["global", "north"][Math.floor(random() * 2)];
        const rows = Array.from({ length: Math.floor(random() * 5) }, (_unused, index) =>
            row(year, region, index + 1, `Snapshot ${turn} day ${index + 1}`));
        cache.matchMonth(year, 1, region);
        cache.recordFetch(year, region, STAMP,
            [...rows, row(year + 1, region, 20, "Spillover")]);
        expected.set(`${year}/${region}`, rows.map((single) => [
            `1/${single.day}`, { name: single.name, flags: [] }
        ]));
        for (const [key, entries] of expected) {
            const [cachedYear, cachedRegion] = key.split("/");
            assert.deepEqual([...cache.matchMonth(Number(cachedYear), 1, cachedRegion)], entries);
        }
        assert.equal(cache.data.length, [...expected.values()].reduce((sum, rows) => sum + rows.length, 0));
    }
});

test("the holiday service saves accepted replacements and retains data after rejected responses", () => {
    const { cache, reload } = makeCache();
    const { HolidayService } = loadHolidays();
    const service = new HolidayService({ fetchYear() {} }, cache);
    const requested = { year: 2026, region: "global" };
    const params = Object.assign({ providerName: "Test" }, requested);
    service.addData([holiday("Old", 2026, 1, 1)], params, STAMP, requested);
    cache.matchMonth(2026, 1);
    service.addData([holiday("New", 2026, 1, 2)], params, STAMP, requested);
    assert.deepEqual([...reload().matchMonth(2026, 1)],
        [["1/2", { name: "New", flags: ["public_holiday"] }]]);

    service.addData([{}], params, STAMP, requested);
    assert.equal(cache.matchMonth(2026, 1).get("1/2").name, "New");
    assert.equal(reload().matchMonth(2026, 1).get("1/2").name, "New");
    service.addData([], params, STAMP, requested);
    assert.equal(reload().matchMonth(2026, 1).size, 0);
});
