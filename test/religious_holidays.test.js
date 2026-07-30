const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");

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

// written against surviving mutants: the century terms (b, d, f, g) only
// differ across centuries, and the /451 correction (m) fires in 2076 -- three
// same-century anchors left every one of those constants free to drift.
// 151, 1700 and 3165 are the witness years a whole-domain search found for
// the month/451/25 constants: proleptic or future, they pin the published
// algorithm, not a documented observance.
test("Gregorian computus matches documented dates across five centuries", () => {
    const anchors = {
        151: [4, 18], 1583: [4, 10], 1700: [4, 11], 1818: [3, 22],
        1886: [4, 25], 1943: [4, 25], 2000: [4, 23], 2016: [3, 27],
        2024: [3, 31], 2025: [4, 20], 2038: [4, 25], 2076: [4, 19],
        2100: [3, 28], 2200: [4, 6], 3165: [4, 18]
    };
    for (const [year, [month, day]] of Object.entries(anchors)) {
        assert.deepEqual(ReligiousHolidays.gregorianEaster(Number(year)),
            { month, day }, `Easter ${year}`);
    }
});

// written against surviving mutants: both window edges were only ever tested
// from the outside, so >= could tighten to > without a test noticing
test("the supported year window is inclusive at both ends", () => {
    assert.ok(ReligiousHolidays.holidaysForYear(1).length > 0);
    assert.ok(ReligiousHolidays.holidaysForYear(9999).length > 0);
    assert.deepEqual(ReligiousHolidays.holidaysForYear(10000), []);
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

test("religion and observance names pass through the applet translator", () => {
    const rows = ReligiousHolidays.holidaysForYear(
        2026, ["christianity"], (text) => `translated:${text}`);

    assert.equal(rows.find((row) => row.month === 12 && row.day === 25).name,
        "translated:Christmas Day (translated:Christianity)");

    const omer = ReligiousHolidays.holidaysForYear(
        2026, ["judaism"], (text) => `translated:${text}`);
    assert.equal(omer.find((row) => row.month === 4 && row.day === 3).name,
        "translated:Sefirat HaOmer — Day 1 (translated:Judaism)");
});

function civilStamp(year, row) {
    return Date.UTC(year, row.month - 1, row.day);
}

// Chabad fixes the count at 16 Nisan through 5 Sivan; Hebcal's published civil
// anchors independently pin day 1, Lag BaOmer (day 33), day 49 and Shavuot for
// every year in the catalogue's supported table window.
test("Sefirat HaOmer is exactly 49 consecutive days before Shavuot", () => {
    const anchors = {
        2025: [[4, 14], [5, 16], [6, 1], [6, 2]],
        2026: [[4, 3], [5, 5], [5, 21], [5, 22]],
        2027: [[4, 23], [5, 25], [6, 10], [6, 11]]
    };

    for (const [yearText, [first, thirtyThird, last, shavuotDate]] of
        Object.entries(anchors)) {
        const year = Number(yearText);
        const rows = ReligiousHolidays.holidaysForYear(year, ["judaism"]);
        const omer = rows.filter((row) => row.name.startsWith("Sefirat HaOmer"));
        const shavuot = rows.find((row) => row.name === "Shavuot (Judaism)");

        assert.equal(omer.length, 49, `Omer ${year}`);
        assert.deepEqual([omer[0].month, omer[0].day], first);
        assert.deepEqual([omer[32].month, omer[32].day], thirtyThird);
        assert.deepEqual([omer[48].month, omer[48].day], last);
        assert.deepEqual([shavuot.month, shavuot.day], shavuotDate);
        assert.equal(omer[0].name, "Sefirat HaOmer — Day 1 (Judaism)");
        assert.equal(omer[32].name, "Sefirat HaOmer — Day 33 (Judaism)");
        assert.equal(omer[48].name, "Sefirat HaOmer — Day 49 (Judaism)");
        assert.deepEqual(
            ReligiousHolidays.monthMap(year, thirtyThird[0], ["judaism"])
                .get(`${thirtyThird[0]}/${thirtyThird[1]}`),
            ["Sefirat HaOmer — Day 33 (Judaism)", ["religious_holiday", "judaism"]],
            `calendar map carries Omer ${year}`);

        for (let index = 1; index < omer.length; index++) {
            assert.equal(civilStamp(year, omer[index]) - civilStamp(year, omer[index - 1]),
                24 * 60 * 60 * 1000, `Omer ${year} day ${index + 1}`);
        }
        assert.equal(civilStamp(year, shavuot) - civilStamp(year, omer[48]),
            24 * 60 * 60 * 1000, `Shavuot follows Omer ${year}`);
    }
});

test("table dates stay absent outside their documented window", () => {
    const rows = ReligiousHolidays.holidaysForYear(
        2030, ["islam", "judaism", "christianity"]);

    assert.equal(rows.some((row) => row.flags.includes("islam")), false);
    assert.equal(rows.some((row) => row.name.startsWith("Sefirat HaOmer")), false);
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

test("merging explicitly marks public rows even when a provider supplies no flags", () => {
    const base = new Map([
        ["1/1", ["Public only", []]],
        ["12/25", ["Public Christmas", []]]
    ]);
    const extra = ReligiousHolidays.monthMap(2026, 12, ["christianity"]);
    const merged = ReligiousHolidays.mergeMonthMaps(base, extra);

    assert.deepEqual(merged.get("1/1"), ["Public only", ["public_holiday"]]);
    assert.deepEqual(merged.get("12/25"), [
        "Public Christmas\nChristmas Day (Christianity)",
        ["public_holiday", "religious_holiday", "christianity"]
    ]);
    assert.deepEqual(base.get("1/1"), ["Public only", []], "the provider map stays untouched");
});

test("invalid years, months and religion selections fail closed", () => {
    for (const year of [0, -1, 1.5, NaN, Infinity, "2026", null]) {
        assert.deepEqual(ReligiousHolidays.holidaysForYear(year), []);
    }
    for (const month of [0, 13, 1.5, NaN, Infinity, "nope", true, [1], null]) {
        assert.equal(ReligiousHolidays.monthMap(2026, month).size, 0);
    }
    assert.equal(ReligiousHolidays.monthMap(true, 1).size, 0);
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
    assert.match(source, /chabad\.org\/library\/article_cdo\/aid\/130631/);
    assert.match(source, /hebcal\.com\/holidays\/days-of-the-omer/);
    assert.doesNotMatch(source, /__TABLES__/);
});

test("unknown and duplicate ids are filtered in request order", () => {
    assert.deepEqual(
        ReligiousHolidays.enabledReligionIds(["islam", "unknown", "islam", "shinto"]),
        ["islam", "shinto"]);
    assert.deepEqual(ReligiousHolidays.enabledReligionIds("christianity"), []);
});

// the values a hostile or corrupted settings store could hand the module:
// wrong types, out-of-range numbers, and lookup keys that walk the prototype
const HOSTILE_VALUES = [0, -1, 1.5, NaN, Infinity, -Infinity, "2026", "abc", "",
    null, undefined, true, {}, [], () => {}, "__proto__", "constructor",
    "hasOwnProperty", Number.MAX_SAFE_INTEGER, -2026, 10000];

function pick(rand, pool) {
    return pool[Math.floor(rand() * pool.length)];
}

function randomIds(rand) {
    const pool = HOSTILE_VALUES.concat(ReligiousHolidays.religionIds());
    return Array.from({ length: Math.floor(rand() * 6) }, () => pick(rand, pool));
}

function pickYear(rand) {
    return rand() < 0.5 ? pick(rand, HOSTILE_VALUES) : 1 + Math.floor(rand() * 9999);
}

function assertWellFormedRow(row) {
    assert.ok(Number.isInteger(row.month) && row.month >= 1 && row.month <= 12);
    assert.ok(Number.isInteger(row.day) && row.day >= 1 && row.day <= 31);
    assert.ok(typeof row.name === "string" && row.name.length > 0);
    assert.equal(row.flags[0], ReligiousHolidays.RELIGIOUS_HOLIDAY_FLAG);
}

function validYear(year) {
    return Number.isInteger(year) && year >= 1 && year <= 9999;
}

test("fuzz: hostile years, months and selections never throw and fail closed", () => {
    const rand = makeRandom(0x9e11);
    for (let i = 0; i < 500; i++) {
        const year = pickYear(rand);
        const rows = ReligiousHolidays.holidaysForYear(year, randomIds(rand));
        rows.forEach(assertWellFormedRow);
        if (!validYear(year)) {
            assert.equal(rows.length, 0, `year ${String(year)} must fail closed`);
        }

        const map = ReligiousHolidays.monthMap(year, pick(rand, HOSTILE_VALUES),
            randomIds(rand));
        assert.ok(map instanceof Map);
        assert.equal(map.size, 0, "hostile months must fail closed");
    }
});

test("fuzz: id sanitizing is idempotent and only ever admits catalogue ids", () => {
    const rand = makeRandom(0x1d5);
    const known = ReligiousHolidays.religionIds();
    for (let i = 0; i < 300; i++) {
        const ids = ReligiousHolidays.enabledReligionIds(randomIds(rand));
        assert.deepEqual(ReligiousHolidays.enabledReligionIds(ids), ids);
        ids.forEach((id) => assert.ok(known.includes(id), `admitted ${id}`));
        assert.equal(new Set(ids).size, ids.length, "no duplicates survive");
    }
});

test("property: Easter stays inside the canonical March 22 - April 25 window", () => {
    const rand = makeRandom(0xea57e4);
    for (let i = 0; i < 400; i++) {
        const year = 1 + Math.floor(rand() * 9999);
        const { month, day } = ReligiousHolidays.gregorianEaster(year);
        const inWindow = (month === 3 && day >= 22 && day <= 31) ||
            (month === 4 && day >= 1 && day <= 25);
        assert.ok(inWindow, `${year} computed ${month}/${day}`);
    }
});

function joinedNameCount(year) {
    let joined = 0;
    for (let month = 1; month <= 12; month++) {
        for (const [key, [name, flags]] of ReligiousHolidays.monthMap(year, month)) {
            assert.ok(key.startsWith(`${month}/`), `${key} in month ${month}`);
            assert.equal(flags[0], ReligiousHolidays.RELIGIOUS_HOLIDAY_FLAG);
            joined += name.split("\n").length;
        }
    }
    return joined;
}

test("property: rows land on real dates and the month maps conserve them", () => {
    const rand = makeRandom(0xca1);
    for (let i = 0; i < 40; i++) {
        const year = 1 + Math.floor(rand() * 9999);
        const rows = ReligiousHolidays.holidaysForYear(year);
        for (const row of rows) {
            const date = new Date(row.year, row.month - 1, row.day, 12);
            assert.equal(date.getMonth() + 1, row.month, `${row.name} ${row.year}`);
            assert.equal(date.getDate(), row.day, `${row.name} ${row.year}`);
        }
        assert.equal(joinedNameCount(year), rows.length,
            `a row of ${year} was lost or invented by the month maps`);
    }
});

function randomBaseMap(rand) {
    const map = new Map();
    for (let i = Math.floor(rand() * 4); i > 0; i--) {
        const key = `${1 + Math.floor(rand() * 12)}/${1 + Math.floor(rand() * 31)}`;
        map.set(key, [`Public ${Math.floor(rand() * 100)}`, ["public_holiday"]]);
    }
    return map;
}

test("adversarial: the catalogue cannot be tampered with", () => {
    assert.ok(Object.isFrozen(ReligiousHolidays.RELIGIONS));
    assert.ok(Object.isFrozen(ReligiousHolidays.RELIGIONS[0]));
    assert.throws(() => ReligiousHolidays.RELIGIONS.push({ id: "x", label: "X" }),
        TypeError);

    const before = ReligiousHolidays.holidaysForYear(2026)[0].name;
    ReligiousHolidays.RELIGIONS[0].label = "tampered";
    assert.equal(ReligiousHolidays.holidaysForYear(2026)[0].name, before);
});

// the calendar splits its "year/month" keys and hands the pieces over as
// strings: the string path must be the number path, byte for byte
test("adversarial: split string keys reach the same map as numbers", () => {
    const numeric = ReligiousHolidays.monthMap(2026, 12);
    assert.ok(numeric.size > 0);
    assert.deepEqual([...ReligiousHolidays.monthMap("2026", "12")], [...numeric]);
});

test("adversarial: an oversized selection cannot amplify the output", () => {
    const ids = Array.from({ length: 50000 },
        (_, i) => (i % 2 ? "islam" : `bogus-${i}`));
    assert.deepEqual(ReligiousHolidays.holidaysForYear(2026, ids),
        ReligiousHolidays.holidaysForYear(2026, ["islam"]));
});

test("fuzz: merging keeps base names first and mutates neither input", () => {
    const rand = makeRandom(0x3e6e);
    for (let i = 0; i < 200; i++) {
        const base = randomBaseMap(rand);
        const extra = ReligiousHolidays.monthMap(
            2025 + Math.floor(rand() * 3), 1 + Math.floor(rand() * 12));
        const baseSnapshot = JSON.stringify([...base]);
        const extraSnapshot = JSON.stringify([...extra]);

        const merged = ReligiousHolidays.mergeMonthMaps(base, extra);

        assert.equal(JSON.stringify([...base]), baseSnapshot);
        assert.equal(JSON.stringify([...extra]), extraSnapshot);
        for (const [key, [name]] of base) {
            assert.ok(merged.get(key)[0].startsWith(name), `${key} lost its base name`);
        }
        for (const key of extra.keys()) {
            assert.ok(merged.has(key), `${key} dropped in the merge`);
        }
    }
});
