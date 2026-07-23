const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto",
    "religiousHolidays.js");
const ReligiousHolidays = require(modulePath);

test("catalogue exposes ten stable religion ids in adherent order", () => {
    assert.deepEqual(ReligiousHolidays.religionIds(), [
        "christianity", "islam", "hinduism", "buddhism", "sikhism",
        "judaism", "bahai", "jainism", "shinto", "taoism"
    ]);
    assert.equal(new Set(ReligiousHolidays.religionIds()).size, 10);
});

test("Gregorian computus covers known early and late Easter dates", () => {
    assert.deepEqual(ReligiousHolidays.gregorianEaster(2024), { month: 3, day: 31 });
    assert.deepEqual(ReligiousHolidays.gregorianEaster(2025), { month: 4, day: 20 });
    assert.deepEqual(ReligiousHolidays.gregorianEaster(2038), { month: 4, day: 25 });
});

test("fixed, Easter-relative and table-backed observances expand", () => {
    const rows = ReligiousHolidays.holidaysForYear(2026,
        ["christianity", "islam", "hinduism"]);
    const byName = new Map(rows.map((row) => [row.name, [row.month, row.day]]));

    assert.deepEqual(byName.get("Christmas Day (Christianity)"), [12, 25]);
    assert.deepEqual(byName.get("Good Friday (Christianity)"), [4, 3]);
    assert.deepEqual(byName.get("Ramadan begins (Islam)"), [2, 18]);
    assert.deepEqual(byName.get("Diwali (Hinduism)"), [11, 8]);
    assert.deepEqual(rows[0].flags, ["religious_holiday", "christianity"]);
});

test("table dates stay absent outside their documented window", () => {
    const rows = ReligiousHolidays.holidaysForYear(2030, ["islam", "christianity"]);

    assert.equal(rows.some((row) => row.flags.includes("islam")), false);
    assert.equal(rows.some((row) => row.name === "Easter Sunday (Christianity)"), true);
});

test("same-day observances merge names and unique flags deterministically", () => {
    const map = ReligiousHolidays.monthMap(2025, 3,
        ["islam", "hinduism", "judaism"]);

    assert.deepEqual(map.get("3/14"), [
        "Holi (Hinduism)\nPurim (Judaism)",
        ["religious_holiday", "hinduism", "judaism"]
    ]);
});

test("map merging preserves inputs and orders public names first", () => {
    const base = new Map([["12/25", ["Public Christmas", ["public_holiday"]]]]);
    const extra = ReligiousHolidays.monthMap(2026, 12, ["christianity"]);
    const merged = ReligiousHolidays.mergeMonthMaps(base, extra);

    assert.deepEqual(merged.get("12/25"), [
        "Public Christmas\nChristmas Day (Christianity)",
        ["public_holiday", "religious_holiday", "christianity"]
    ]);
    assert.deepEqual(base.get("12/25"), ["Public Christmas", ["public_holiday"]]);
    assert.notEqual(merged, base);
});

test("invalid years, months and religion selections fail closed", () => {
    for (const year of [0, -1, 1.5, NaN, Infinity, "2026", null]) {
        assert.deepEqual(ReligiousHolidays.holidaysForYear(year), []);
    }
    for (const month of [0, 13, 1.5, NaN, Infinity, "nope"]) {
        assert.equal(ReligiousHolidays.monthMap(2026, month).size, 0);
    }
    assert.deepEqual(ReligiousHolidays.holidaysForYear(2026, null), []);
    assert.deepEqual(ReligiousHolidays.holidaysForYear(
        2026, ["unknown", "christianity", "christianity"]).map((row) => row.name),
    ReligiousHolidays.holidaysForYear(2026, ["christianity"]).map((row) => row.name));
});

test("catalogue keeps provenance anchors beside the bounded tables", () => {
    const source = require("node:fs").readFileSync(modulePath, "utf8");

    assert.match(source, /case\.edu\/studentlife\/dean/);
    assert.match(source, /xavier\.edu\/jesuitresource/);
    assert.match(source, /hebcal\.com\/holidays/);
    assert.doesNotMatch(source, /__TABLES__/);
});

function baseProvider(country = "") {
    return {
        country,
        destroyed: false,
        _provider: { service: "underlying service" },
        clearPlace() { this.country = ""; },
        destroy() { this.destroyed = true; },
        setPlace(nextCountry, _region, onUpdated) {
            this.country = nextCountry;
            if (onUpdated) {
                onUpdated();
            }
        },
        getHolidays(_year, _month, callback) {
            callback(new Map([["12/25", ["Public Christmas", ["public_holiday"]]]]),
                "provider warning", "Public Provider");
        }
    };
}

test("provider serves local observances while public holidays are disabled", () => {
    const base = baseProvider();
    const provider = new ReligiousHolidays.ReligiousHolidayProvider(
        base, ["christianity", "unknown"]);
    let answer;

    provider.getHolidays(2026, 12, (...args) => { answer = args; });

    assert.equal(provider.country, "religious");
    assert.deepEqual(answer[0].get("12/25"),
        ["Christmas Day (Christianity)", ["religious_holiday", "christianity"]]);
    assert.deepEqual(answer.slice(1), ["", ""]);
    assert.equal(provider._provider.service, "underlying service");
});

test("provider merges public results and preserves provider status", () => {
    const base = baseProvider("ita");
    const provider = new ReligiousHolidays.ReligiousHolidayProvider(
        base, ["christianity"]);
    let answer;

    provider.getHolidays(2026, 12, (...args) => { answer = args; });

    assert.deepEqual(answer[0].get("12/25"), [
        "Public Christmas\nChristmas Day (Christianity)",
        ["public_holiday", "religious_holiday", "christianity"]
    ]);
    assert.deepEqual(answer.slice(1), ["provider warning", "Public Provider"]);
});

test("provider forwards lifecycle and accepts changed selections", () => {
    const base = baseProvider();
    const provider = new ReligiousHolidays.ReligiousHolidayProvider(base);
    let updated = false;

    assert.equal(provider.country, "");
    provider.setEnabledIds(["shinto"]);
    provider.setPlace("jpn", "global", () => { updated = true; });
    assert.equal(updated, true);
    assert.equal(provider.country, "jpn");
    provider.clearPlace();
    assert.equal(provider.country, "religious");
    provider.destroy();
    assert.equal(base.destroyed, true);
});
