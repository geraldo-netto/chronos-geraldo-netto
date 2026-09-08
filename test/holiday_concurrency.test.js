const { assert, test, fs, cachePath, loadHolidays } = require("./helpers/holidayFixture");

const NOW = Date.parse("2026-09-08T12:00:00Z");
const PROVIDER_DATE = "Thu, 01 Jan 2026 00:00:00 GMT";

function row(year, day, region = "global") {
    return { year, month: 1, day, region, name: `Observance ${day}`, flags: [] };
}

function cachePair(initial = [row(2026, 1)]) {
    const { HolidayCacheRepository, HolidayCache } = loadHolidays();
    const create = () => {
        const repository = new HolidayCacheRepository("/holidays.json", { now: () => NOW });
        const cache = new HolidayCache((country, done) => repository.loadAsync(country, done),
            (country, data) => repository.save(country, data));
        cache.setPlace("usa", "global");
        return cache;
    };
    const first = create();
    first.recordFetch(2026, "global", PROVIDER_DATE, initial,
        new Date(NOW - 3600000).toISOString());
    first.persist(new Date(NOW));
    return [first, create()];
}

function persistFetch(cache, year, region, rows, received = NOW) {
    cache.recordFetch(year, region, PROVIDER_DATE, rows, new Date(received).toISOString());
    cache.persist(new Date(NOW));
}

function stored() {
    return JSON.parse(fs.readFileSync(cachePath("holidays.json"), "utf8")).usa;
}

test("an independent year update preserves another instance's corrected dates", () => {
    const [first, second] = cachePair();
    persistFetch(second, 2026, "global", [row(2026, 2)], NOW - 1000);
    persistFetch(first, 2027, "global", [row(2027, 3)]);
    assert.deepEqual(stored().holidays, [row(2026, 2), row(2027, 3)]);
});

test("independent regions remain complete when their instances save stale country views", () => {
    const [first, second] = cachePair();
    persistFetch(second, 2026, "ny", [row(2026, 2, "ny")], NOW - 1000);
    persistFetch(first, 2026, "ca", [row(2026, 3, "ca")]);
    assert.deepEqual(stored().holidays, [row(2026, 1), row(2026, 2, "ny"), row(2026, 3, "ca")]);
});

test("an explicitly empty corrected snapshot remains empty after an unrelated save", () => {
    const [first, second] = cachePair();
    persistFetch(second, 2026, "global", [], NOW - 1000);
    persistFetch(first, 2027, "global", [row(2027, 3)]);
    assert.deepEqual(stored().holidays, [row(2027, 3)]);
    assert.equal(stored().years[2026].global, PROVIDER_DATE,
        "an empty complete snapshot retains its independent freshness");
});

test("a late write cannot replace a snapshot received more recently", () => {
    const [first, second] = cachePair();
    persistFetch(second, 2026, "global", [row(2026, 2)], NOW - 1000);
    persistFetch(first, 2026, "global", [row(2026, 3)], NOW - 2000);
    assert.deepEqual(stored().holidays, [row(2026, 2)]);
});

test("invalid update descriptors cannot overwrite a healthy snapshot", () => {
    cachePair();
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json", { now: () => NOW });
    const update = { year: 2026, region: "global", received: new Date(NOW).toISOString() };
    const invalid = [null, { ...update, year: 0 }, { ...update, region: 3 },
        { ...update, region: "__proto__" }, { ...update, received: "invalid" },
        { ...update, received: new Date(NOW + 1).toISOString() }];
    repository.save("usa", { years: {}, holidays: [row(2026, 3)], updates: invalid });
    assert.deepEqual(stored().holidays, [row(2026, 1)]);
    assert.throws(() => repository.save("usa", { years: {}, holidays: [] }),
        /explicit snapshot updates/);
});

test("equal receipt times use write order and cleared caches forget pending updates", () => {
    const [first, second] = cachePair();
    persistFetch(second, 2026, "global", [row(2026, 2)]);
    persistFetch(first, 2026, "global", [row(2026, 3)]);
    assert.deepEqual(stored().holidays, [row(2026, 3)]);
    first.recordFetch(2026, "ny", PROVIDER_DATE, [row(2026, 4, "ny")]);
    first.clearPlace();
    first.setPlace("usa", "global");
    first.persist(new Date(NOW));
    assert.deepEqual(stored().holidays, [row(2026, 3)], "clearing a place drops unsaved descriptors");
});
