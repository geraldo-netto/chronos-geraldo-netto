const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");

const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto",
    "religiousHolidays.js");
const ReligiousHolidays = require(modulePath);
const coverage = require("../files/chronos@geraldo-netto/religious-coverage.json");

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
    assert.deepEqual(rows[0].flags, ["religious_holiday"],
        "the religion is carried by the display name, not by a second flag");
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
        2027: [[4, 23], [5, 25], [6, 10], [6, 11]],
        2028: [[4, 12], [5, 14], [5, 30], [5, 31]],
        2029: [[4, 1], [5, 3], [5, 19], [5, 20]],
        2030: [[4, 19], [5, 21], [6, 6], [6, 7]]
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
            { name: "Sefirat HaOmer — Day 33 (Judaism)", flags: ["religious_holiday"] },
            `calendar map carries Omer ${year}`);

        for (let index = 1; index < omer.length; index++) {
            assert.equal(civilStamp(year, omer[index]) - civilStamp(year, omer[index - 1]),
                24 * 60 * 60 * 1000, `Omer ${year} day ${index + 1}`);
        }
        assert.equal(civilStamp(year, shavuot) - civilStamp(year, omer[48]),
            24 * 60 * 60 * 1000, `Shavuot follows Omer ${year}`);
    }
});

test("expired calendars stay absent while complete calendars still render", () => {
    const rows = ReligiousHolidays.holidaysForYear(
        2031, ["islam", "judaism", "christianity"]);

    assert.equal(rows.some((row) => row.name.endsWith("(Islam)")), false);
    assert.equal(rows.some((row) => row.name.startsWith("Sefirat HaOmer")), true);
    assert.equal(rows.some((row) => row.name === "Easter Sunday (Christianity)"), true);
});

test("incomplete religions hide fixed dates together with unavailable table dates", () => {
    for (const year of [2024, 2028]) {
        for (const id of ["hinduism", "buddhism"]) {
            assert.deepEqual(ReligiousHolidays.holidaysForYear(year, [id]), [],
                `${id} ${year} must not display an incomplete calendar`);
            assert.deepEqual(ReligiousHolidays.uncoveredReligions(year, [id]), [id]);
            for (let month = 1; month <= 12; month++) {
                assert.equal(ReligiousHolidays.monthMap(year, month, [id]).size, 0);
            }
        }
    }
});

test("hiding an incomplete religion preserves preceding and following calendars", () => {
    const complete = ["christianity", "judaism", "shinto"];
    assert.deepEqual(ReligiousHolidays.holidaysForYear(2028,
        ["christianity", "hinduism", "judaism", "buddhism", "shinto"]),
    ReligiousHolidays.holidaysForYear(2028, complete));
    assert.deepEqual(ReligiousHolidays.monthMap(2028, 12,
        ["christianity", "hinduism", "judaism", "buddhism", "shinto"]),
    ReligiousHolidays.monthMap(2028, 12, complete));
});

// REGRESSION: the table put Naw-Rúz on 20 March in every year and Ridván on
// 21 April in every year — an offset of 32 where the Badí' calendar mandates
// 31, since Ridván day 1 is 13 Jalál and the months are 19 days each. Three of
// the six shipped cells were wrong: Ridván 2025 was a day late, and Naw-Rúz
// 2026 and 2027 a day early. Naw-Rúz is the Tehran sunset-to-sunset day holding
// the March equinox, and the 2027 equinox is 20:25 UTC — hours after sunset
// there. Ridván is derived now, so the offset cannot drift again.
const NAW_RUZ = {
    // the pre-2015 Western convention: the year began at 21 March outright
    1844: [3, 21], 1900: [3, 21], 2014: [3, 21],
    // and from 2015 the Bahá'í World Centre's published astronomical dates
    2015: [3, 21], 2025: [3, 20], 2026: [3, 21], 2027: [3, 21],
    2030: [3, 20], 2031: [3, 21], 2055: [3, 21], 2064: [3, 20]
};
const RIDVAN_OFFSET_DAYS = 31;

function bahaiRow(year, prefix) {
    return ReligiousHolidays.holidaysForYear(year, ["bahai"])
        .find((row) => row.name.startsWith(prefix));
}

test("Bahá'í dates match the published Naw-Rúz and derive Ridván from it", () => {
    for (const [key, expected] of Object.entries(NAW_RUZ)) {
        const year = Number(key);
        const nawRuz = bahaiRow(year, "Naw-Rúz");
        const ridvan = bahaiRow(year, "Ridván");

        assert.deepEqual([nawRuz.month, nawRuz.day], expected, `Naw-Rúz ${year}`);
        assert.equal(
            (civilStamp(year, ridvan) - civilStamp(year, nawRuz)) /
                (24 * 60 * 60 * 1000),
            RIDVAN_OFFSET_DAYS, `Ridván ${year} is not 13 Jalál`);
    }
});

// The final World Centre row is Naw-Rúz 221 BE in March 2064. Its February
// 2065 dates describe Ayyám-i-Há, not the following Naw-Rúz.
test("Bahá'í observances stop at both ends of what is published", () => {
    assert.equal(bahaiRow(1843, "Naw-Rúz"), undefined, "before the Bahá'í era");
    assert.ok(bahaiRow(1844, "Naw-Rúz"), "the first year of the era");
    assert.ok(bahaiRow(2064, "Naw-Rúz"), "the last published year");
    assert.equal(bahaiRow(2065, "Naw-Rúz"), undefined, "past the published table");
    assert.equal(bahaiRow(2065, "Ridván"), undefined, "its anchor is unavailable");
    assert.deepEqual(ReligiousHolidays.uncoveredReligions(2065, ["bahai"]), ["bahai"],
        "the hidden calendar remains diagnosable");
});

// One flag order for every producer: 6.0/calendarAnnotations.js diffs a cell's
// flags positionally, so the cache's code-unit sort is what the religious join
// uses too.
test("same-day observances merge names and unique flags deterministically", () => {
    const map = ReligiousHolidays.monthMap(2025, 3,
        ["islam", "hinduism", "judaism"]);

    assert.deepEqual(map.get("3/14"), { name: "Holi (Hinduism)\nPurim (Judaism)", flags: ["religious_holiday"] });
});

test("map merging preserves inputs and orders public names first", () => {
    const base = new Map([["12/25", { name: "Public Christmas", flags: ["public_holiday"] }]]);
    const extra = ReligiousHolidays.monthMap(2026, 12, ["christianity"]);
    const merged = ReligiousHolidays.mergeMonthMaps(base, extra);

    assert.deepEqual(merged.get("12/25"), { name: "Public Christmas\nChristmas Day (Christianity)", flags: ["public_holiday", "religious_holiday"] });
    assert.deepEqual(base.get("12/25"), { name: "Public Christmas", flags: ["public_holiday"] });
    assert.notEqual(merged, base);
});

test("merging explicitly marks public rows even when a provider supplies no flags", () => {
    const base = new Map([
        ["1/1", { name: "Public only", flags: [] }],
        ["12/25", { name: "Public Christmas", flags: [] }]
    ]);
    const extra = ReligiousHolidays.monthMap(2026, 12, ["christianity"]);
    const merged = ReligiousHolidays.mergeMonthMaps(base, extra);

    assert.deepEqual(merged.get("1/1"), { name: "Public only", flags: ["public_holiday"] });
    assert.deepEqual(merged.get("12/25"), { name: "Public Christmas\nChristmas Day (Christianity)", flags: ["public_holiday", "religious_holiday"] });
    assert.deepEqual(base.get("1/1"), { name: "Public only", flags: [] }, "the provider map stays untouched");
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

test("calendar availability validates inputs and preserves enabled selection order", () => {
    for (const year of [0, -1, 1.5, NaN, Infinity, "2026", null, undefined, 10000]) {
        assert.deepEqual(ReligiousHolidays.availableReligionIds(year), []);
    }
    const requested = ["shinto", "hinduism", "unknown", "christianity", "shinto"];
    assert.deepEqual(ReligiousHolidays.availableReligionIds(2028, requested),
        ["shinto", "christianity"]);
    assert.deepEqual(ReligiousHolidays.availableReligionIds(2026, requested),
        ["shinto", "hinduism", "christianity"]);
    assert.deepEqual(requested, ["shinto", "hinduism", "unknown", "christianity", "shinto"]);
    assert.deepEqual(ReligiousHolidays.availableReligionIds(2026, null), []);
    assert.deepEqual(ReligiousHolidays.availableReligionIds(2026, []), []);
    const available = ReligiousHolidays.availableReligionIds(2028);
    available.push("islam");
    assert.equal(ReligiousHolidays.availableReligionIds(2028).includes("islam"), false);
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
    assert.ok(Number.isInteger(row.month));
    assert.ok(row.month >= 1);
    assert.ok(row.month <= 12);
    assert.ok(Number.isInteger(row.day));
    assert.ok(row.day >= 1);
    assert.ok(row.day <= 31);
    assert.equal(typeof row.name, "string");
    assert.ok(row.name.length > 0);
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

test("fuzz: calendar availability rejects hostile inputs and matches published coverage", () => {
    const rand = makeRandom(0xc0be);
    for (let i = 0; i < 300; i++) {
        const year = pickYear(rand);
        const requested = randomIds(rand);
        const enabled = ReligiousHolidays.enabledReligionIds(requested);
        const expected = validYear(year) ? enabled.filter((id) =>
            year >= coverage[id].from && year <= coverage[id].through) : [];
        assert.deepEqual(ReligiousHolidays.availableReligionIds(year, requested), expected);
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
        for (const [key, { name, flags }] of ReligiousHolidays.monthMap(year, month)) {
            assert.ok(key.startsWith(`${month}/`), `${key} in month ${month}`);
            assert.ok(flags.includes(ReligiousHolidays.RELIGIOUS_HOLIDAY_FLAG));
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
        map.set(key, { name: `Public ${Math.floor(rand() * 100)}`, flags: ["public_holiday"] });
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
        for (const [key, { name }] of base) {
            assert.ok(merged.get(key).name.startsWith(name), `${key} lost its base name`);
        }
        for (const key of extra.keys()) {
            assert.ok(merged.has(key), `${key} dropped in the merge`);
        }
    }
});

function assertCoverageParity(year) {
    const available = Object.entries(coverage)
        .filter(([, { from, through }]) => year >= from && year <= through)
        .map(([id]) => id);
    const hidden = ReligiousHolidays.religionIds().filter((id) => !available.includes(id));
    assert.deepEqual(ReligiousHolidays.availableReligionIds(year), available,
        `settings coverage matches engine availability in ${year}`);
    assert.deepEqual(ReligiousHolidays.uncoveredReligions(year), hidden);
    assert.deepEqual(ReligiousHolidays.holidaysForYear(year, hidden), []);
    for (const id of available) {
        assert.ok(ReligiousHolidays.holidaysForYear(year, [id]).length > 0,
            `${id} has dates in ${year}`);
    }
}

test("shared settings coverage agrees with actual observances throughout the supported domain", () => {
    assert.deepEqual(Object.keys(coverage), ReligiousHolidays.religionIds());
    for (let year = 1; year <= 9999; year++) {
        assertCoverageParity(year);
    }
});

test("published tables expiring hides affected calendars and retains a diagnostic", (t) => {
    for (const year of [2027, 2028, 2064, 2065, 9999]) {
        assertCoverageParity(year);
        t.diagnostic(`Calendars hidden in ${year}: ` +
            ReligiousHolidays.uncoveredReligions(year).join(", "));
    }
    assert.equal(ReligiousHolidays.TABLE_COVERAGE_END, 2027);
});

test("a year past the tables hides expired calendars and reports the gap", () => {
    const beyond = ReligiousHolidays.TABLE_COVERAGE_END + 1;
    const covered = ReligiousHolidays.TABLE_COVERAGE_END;

    // Christianity is fixed dates and the computus: it never runs out, so it
    // must not raise the notice for any year.
    assert.deepEqual(ReligiousHolidays.uncoveredReligions(beyond, ["christianity"]), []);
    assert.ok(ReligiousHolidays.holidaysForYear(beyond, ["christianity"]).length > 0);

    // Islam is entirely table-backed, so past the window it has nothing to draw
    assert.deepEqual(ReligiousHolidays.holidaysForYear(beyond, ["islam"]), []);
    assert.deepEqual(ReligiousHolidays.uncoveredReligions(beyond, ["islam"]), ["islam"]);
    assert.deepEqual(ReligiousHolidays.uncoveredReligions(covered, ["islam"]), []);

    // Judaism is computed from the Hebrew calendar, not tabulated, so it has no
    // horizon to run past: it answers for every year the applet accepts, and
    // must never raise the notice.
    assert.deepEqual(ReligiousHolidays.uncoveredReligions(2031, ["judaism"]), []);
    assert.deepEqual(ReligiousHolidays.uncoveredReligions(9999, ["judaism"]), []);
    assert.ok(ReligiousHolidays.holidaysForYear(9999, ["judaism"]).length > 0);

    // mixed selection names only the religions that actually lost dates, so a
    // religion whose dates still reach the year is not swept up with the rest
    assert.deepEqual(
        ReligiousHolidays.uncoveredReligions(beyond, ["christianity", "islam", "judaism"]),
        ["islam"]);
    assert.deepEqual(
        ReligiousHolidays.uncoveredReligions(2031, ["christianity", "islam", "judaism"]),
        ["islam"]);

    // an unusable year is not a coverage gap; it is a rejected input
    assert.deepEqual(ReligiousHolidays.uncoveredReligions("nope", ["islam"]), []);
    assert.deepEqual(ReligiousHolidays.uncoveredReligions(beyond, []), []);
});

// T993: the year expansion is memoized in one slot, so a repaint of the
// 42-day grid stops expanding every enabled religion (and all 49 omer rows)
// once per month key and again for the coverage report. The memo must key on
// the enabled ids and must not cache the *names*, which are language-dependent
// while the dates are not.
// T994: the memos are module scope, so they are shared by every applet instance
// and nothing else would ever drop them. Releasing is safe at any moment: they
// are pure memos, so an early release costs one recomputation and no answer.
test("releasing the catalogue memos changes no answer", () => {
    const before = ReligiousHolidays.holidaysForYear(2026, ["judaism", "bahai"]);
    const uncoveredBefore = ReligiousHolidays.uncoveredReligions(2066, ["bahai"]);

    ReligiousHolidays.releaseMemos();

    assert.deepEqual(
        ReligiousHolidays.holidaysForYear(2026, ["judaism", "bahai"]), before,
        "a cold expansion answers exactly what the warm one did");
    assert.deepEqual(ReligiousHolidays.uncoveredReligions(2066, ["bahai"]),
        uncoveredBefore);

    // and a release between two identical asks is not observable either
    ReligiousHolidays.releaseMemos();
    ReligiousHolidays.releaseMemos();
    assert.deepEqual(
        ReligiousHolidays.holidaysForYear(2026, ["judaism", "bahai"]), before);
});

test("the memoized year expansion still tracks ids, language and coverage", () => {
    const english = ReligiousHolidays.holidaysForYear(2026, ["judaism"]);
    // uppercased word by word, so the "%s" the omer template fills stays intact
    const shouted = ReligiousHolidays.holidaysForYear(2026, ["judaism"],
        (text) => text.replace(/[a-z]+/g, (word) => word.toUpperCase()));
    assert.ok(english.length > 0);
    assert.deepEqual(shouted.map((row) => [row.month, row.day]),
        english.map((row) => [row.month, row.day]),
        "same dates whatever the display language");
    assert.ok(shouted.every((row) => row.name.includes("(JUDAISM)")),
        "names are formatted per call, never served from the memo");
    assert.ok(english.every((row) => row.name.includes("(Judaism)")),
        "and the untranslated call is unaffected by the translated one");

    const islam = ReligiousHolidays.holidaysForYear(2026, ["islam"]);
    assert.notDeepEqual(islam.map((row) => row.name), english.map((row) => row.name),
        "a different id set is a different expansion");
    assert.deepEqual(ReligiousHolidays.holidaysForYear(2026, ["judaism"])
        .map((row) => row.name), english.map((row) => row.name),
        "and the first id set is unaffected by the second");

    // coverage comes off the same walk, interleaved with row requests
    assert.deepEqual(ReligiousHolidays.uncoveredReligions(2066, ["bahai"]), ["bahai"]);
    assert.deepEqual(ReligiousHolidays.uncoveredReligions(2026, ["bahai"]), []);
    assert.ok(ReligiousHolidays.holidaysForYear(2026, ["bahai"]).length > 0);
    assert.deepEqual(ReligiousHolidays.uncoveredReligions(2066, ["bahai"]), ["bahai"]);

    // the answer is a copy: a caller mutating it must not poison the memo
    const uncovered = ReligiousHolidays.uncoveredReligions(2066, ["bahai"]);
    uncovered.push("islam");
    assert.deepEqual(ReligiousHolidays.uncoveredReligions(2066, ["bahai"]), ["bahai"]);
});
