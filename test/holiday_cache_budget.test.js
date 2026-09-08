const { assert, test, fs, cachePath, loadHolidays } = require("./helpers/holidayFixture");

const NOW = Date.parse("2026-09-08T12:00:00Z");
const LIMIT = 4 * 1024 * 1024;

function multilingualRows(year, count = 365) {
    return Array.from({ length: count }, (_, index) => {
        const date = new Date(Date.UTC(year, 0, 1 + index % 365));
        return { year, month: date.getUTCMonth() + 1, day: date.getUTCDate(),
            region: `region${Math.floor(index / 365)}`, name: "日".repeat(300),
            flags: Array.from({ length: 8 }, (_unused, flag) => String(flag).repeat(64)) };
    });
}

function snapshot(years, received, count = 365) {
    const holidays = years.flatMap((year) => multilingualRows(year, count));
    const updates = Array.from(new Set(holidays.map((row) => `${row.year}/${row.region}`)))
        .map((key) => {
            const [year, region] = key.split("/");
            return { year: Number(year), region, received: new Date(received).toISOString() };
        });
    const stamps = {};
    for (const update of updates) {
        stamps[update.year] ||= {};
        stamps[update.year][update.region] = new Date(received).toUTCString();
    }
    return { years: stamps, holidays, updates };
}

function assertCompleteYears(country) {
    for (const year of Object.keys(country.years)) {
        assert.equal(country.holidays.filter((row) => row.year === Number(year)).length, 365);
        assert.ok(country.updates.some((update) => update.year === Number(year)));
    }
    assert.equal(country.holidays.length, Object.keys(country.years).length * 365,
        "eviction keeps rows and freshness together");
}

test("the aggregate cache fits the UTF-8 budget and retains the newest complete years", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json", { now: () => NOW });
    const countries = ["usa", "ita", "fra", "can"];
    const unbounded = Object.fromEntries(countries.map((country, index) =>
        [country, snapshot([2025, 2026, 2027], NOW - 4000 + index * 1000)]));
    assert.ok(Buffer.byteLength(JSON.stringify(unbounded)) > LIMIT,
        "valid bounded multilingual data exceeds the I/O budget before eviction");
    for (const country of countries) {
        repository.save(country, unbounded[country]);
        const bytes = fs.readFileSync(cachePath("holidays.json"));
        assert.ok(bytes.length <= LIMIT);
        const written = JSON.parse(bytes);
        assert.equal(written[country].holidays.length, 1095,
            "the latest country is really written rather than silently discarded");
        Object.values(written).forEach(assertCompleteYears);
    }
    assert.deepEqual(repository._pending, {});
});

test("an individually oversized year is omitted with all freshness and receipt metadata", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json", { now: () => NOW });
    const data = snapshot([2026], NOW, 3900);
    assert.ok(Buffer.byteLength(JSON.stringify(data)) > LIMIT);
    repository.save("usa", data);
    const written = JSON.parse(fs.readFileSync(cachePath("holidays.json"), "utf8"));
    assert.deepEqual(written, {}, "no partial year can masquerade as a complete fetched snapshot");
});
