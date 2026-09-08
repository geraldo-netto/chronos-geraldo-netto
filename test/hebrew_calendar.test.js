"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const HebrewCalendar = require(path.join(__dirname, "..", "files",
    "chronos@geraldo-netto", "hebrewCalendar.js"));
const { judaism: coverage } = require("../files/chronos@geraldo-netto/religious-coverage.json");

const FIRST_YEAR = 1800;
const LAST_YEAR = 2100;
const OMER_TO_SHAVUOT = 50;
const ROSH_HASHANAH_TO_YOM_KIPPUR = 9;
const MSECS_IN_DAY = 24 * 60 * 60 * 1000;

// the six keys the observance catalogue asks for, in civil-date order
const KEYS = ["purim", "passover-start", "shavuot", "rosh-hashanah",
    "yom-kippur", "hanukkah-start"];

function civilDay([year, month, day]) {
    return Date.UTC(year, month - 1, day) / MSECS_IN_DAY;
}

function eachYear(visit) {
    for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
        visit(year, HebrewCalendar.hebrewObservances(year));
    }
}

// These are the rows that used to be TABLES in religiousHolidays.js — the
// published dates from case.edu and xavier.edu for 2025-2027, and Hebcal for
// 2028-2030. Deleting the table did not delete the evidence for it: the
// arithmetic has to keep reproducing every value that was ever shipped.
const PUBLISHED = {
    "purim": { 2025: [3, 14], 2026: [3, 3], 2027: [3, 23], 2028: [3, 12], 2029: [3, 1], 2030: [3, 19] },
    "passover-start": { 2025: [4, 13], 2026: [4, 2], 2027: [4, 22], 2028: [4, 11], 2029: [3, 31], 2030: [4, 18] },
    "shavuot": { 2025: [6, 2], 2026: [5, 22], 2027: [6, 11], 2028: [5, 31], 2029: [5, 20], 2030: [6, 7] },
    "rosh-hashanah": { 2025: [9, 23], 2026: [9, 12], 2027: [10, 2], 2028: [9, 21], 2029: [9, 10], 2030: [9, 28] },
    "yom-kippur": { 2025: [10, 2], 2026: [9, 21], 2027: [10, 11], 2028: [9, 30], 2029: [9, 19], 2030: [10, 7] },
    "hanukkah-start": { 2025: [12, 15], 2026: [12, 5], 2027: [12, 25], 2028: [12, 13], 2029: [12, 2], 2030: [12, 21] }
};

test("the arithmetic reproduces every date the tables used to publish", () => {
    for (const key of KEYS) {
        for (const [year, expected] of Object.entries(PUBLISHED[key])) {
            assert.deepEqual(HebrewCalendar.hebrewObservances(Number(year))[key],
                [[Number(year), ...expected]], `${key} ${year}`);
        }
    }
});

// Fetched from hebcal.com's converter, which is an independent implementation
// of the same rules, and spread across the range rather than clustered at the
// near end — a constant offset in the epoch reproduces nothing here.
test("dates agree with Hebcal from 1800 to 2100", () => {
    const cases = [
        ["passover-start", 1800, [4, 10]],
        ["rosh-hashanah", 1849, [9, 17]],
        ["hanukkah-start", 1899, [11, 27]],
        ["shavuot", 1950, [5, 22]],
        ["purim", 2000, [3, 21]],
        ["rosh-hashanah", 2099, [9, 15]],
        ["passover-start", 2100, [4, 24]]
    ];

    for (const [key, year, expected] of cases) {
        assert.deepEqual(HebrewCalendar.hebrewObservances(year)[key], [[year, ...expected]],
            `${key} ${year}`);
    }
});

// This is the invariant religiousHolidays._omerDates used to check at runtime
// against two hand-typed rows. It is a consequence of the month lengths now —
// Nisan is always 30 days and Iyyar always 29 — so it belongs here, asserted
// over three centuries, where an error in _lastDayOfMonth would surface.
test("Shavuot is always the fiftieth day of the omer", () => {
    eachYear((year, dates) => {
        assert.equal(
            civilDay(dates.shavuot[0]) - civilDay(dates["passover-start"][0]),
            OMER_TO_SHAVUOT, `omer count in ${year}`);
    });
});

test("Yom Kippur is always nine days after Rosh Hashanah", () => {
    eachYear((year, dates) => {
        assert.equal(
            civilDay(dates["yom-kippur"][0]) - civilDay(dates["rosh-hashanah"][0]),
            ROSH_HASHANAH_TO_YOM_KIPPUR, `ten days of repentance in ${year}`);
    });
});

const HEBREW_DATES = {
    "purim": [null, 14],
    "passover-start": [1, 15],
    "shavuot": [3, 6],
    "rosh-hashanah": [7, 1],
    "yom-kippur": [7, 10],
    "hanukkah-start": [9, 25]
};

function expectedCivilDate(hebrewYear, month, day) {
    const adar = HebrewCalendar.hebrewLeapYear(hebrewYear) ? 13 : 12;
    return HebrewCalendar.gregorianFromHebrew(hebrewYear, month ?? adar, day);
}

// Walk Hebrew years from the epoch, independent of the implementation's
// Gregorian-to-Hebrew year search, and bucket complete dates by their actual year.
function expectedObservances() {
    const expected = new Map();
    for (let year = coverage.from; year <= coverage.through; year++) {
        expected.set(year, Object.fromEntries(KEYS.map((key) => [key, []])));
    }
    for (let year = 1; HebrewCalendar.gregorianFromHebrew(year, 7, 1)[0] <= coverage.through; year++) {
        for (const [key, [month, day]] of Object.entries(HEBREW_DATES)) {
            const civil = expectedCivilDate(year, month, day);
            expected.get(civil[0])?.[key].push(civil);
        }
    }
    return expected;
}

test("every advertised civil year contains all and only its computed observances", () => {
    for (const [year, expected] of expectedObservances()) {
        assert.deepEqual(HebrewCalendar.hebrewObservances(year), expected, `civil year ${year}`);
    }
});

test("Hanukkah preserves the first civil-year rollover and the upper coverage boundary", () => {
    assert.deepEqual(HebrewCalendar.hebrewObservances(3031)["hanukkah-start"], []);
    assert.deepEqual(HebrewCalendar.hebrewObservances(3032)["hanukkah-start"],
        [[3032, 1, 1], [3032, 12, 19]]);
    assert.deepEqual(HebrewCalendar.hebrewObservances(9999)["hanukkah-start"], [[9999, 1, 7]]);
});

test("civil-year observance requests reject values outside the declared numeric range", () => {
    for (const year of [null, undefined, true, "2026", NaN, Infinity, 0, -1, 1.5, 10000]) {
        assert.deepEqual(HebrewCalendar.hebrewObservances(year), {});
    }
});

test("the six observances keep their order within every civil year", () => {
    eachYear((year, dates) => {
        const days = KEYS.map((key) => civilDay(dates[key][0]));
        for (let i = 1; i < days.length; i++) {
            assert.ok(days[i] > days[i - 1],
                `${KEYS[i]} does not follow ${KEYS[i - 1]} in ${year}`);
        }
    });
});

test("the civil year of a Hebrew date is reported, not assumed", () => {
    // 1 Tishri 5786 opens civil 2025; 15 Nisan 5786 falls in the next one
    assert.deepEqual(HebrewCalendar.gregorianFromHebrew(5786, 7, 1), [2025, 9, 23]);
    assert.deepEqual(HebrewCalendar.gregorianFromHebrew(5786, 1, 15), [2026, 4, 2]);
    // Adar II exists only in a leap year: 5784 is one, 5785 is not
    assert.deepEqual(HebrewCalendar.gregorianFromHebrew(5784, 13, 14), [2024, 3, 24]);
    assert.deepEqual(HebrewCalendar.gregorianFromHebrew(5785, 12, 14), [2025, 3, 14]);
});

// Walking every day of three centuries is what actually exercises the month
// lengths, the leap months and both calendars' year boundaries: a wrong length
// anywhere makes two civil dates that should be consecutive not be.
function walkHebrewDays(firstYear, lastYear, visit) {
    for (let hebrewYear = firstYear; hebrewYear <= lastYear; hebrewYear++) {
        const lastMonth = HebrewCalendar.hebrewLeapYear(hebrewYear) ? 13 : 12;
        for (let month = 1; month <= lastMonth; month++) {
            for (let day = 1; day <= 30; day++) {
                visit(hebrewYear, month, day);
            }
        }
    }
}

test("consecutive Hebrew days are consecutive civil days", () => {
    let previous = null;
    let daysWalked = 0;

    walkHebrewDays(5560, 5861, (hebrewYear, month, day) => {
        const civil = HebrewCalendar.gregorianFromHebrew(hebrewYear, month, day);
        const fixed = Date.UTC(civil[0], civil[1] - 1, civil[2]) / MSECS_IN_DAY;
        // day 1 follows the previous month's last day, which is 29 or 30, so
        // only the within-month steps are guaranteed to be one apart
        if (previous !== null && day !== 1) {
            assert.equal(fixed - previous, 1,
                `${hebrewYear}-${month}-${day} does not follow day ${day - 1}`);
        }
        previous = fixed;
        daysWalked++;
    });

    assert.ok(daysWalked > 100000, `walked ${daysWalked} days`);
});

test("leap years follow the Metonic cycle, seven in nineteen", () => {
    const leapPositions = [0, 3, 6, 8, 11, 14, 17];

    for (let cycle = 0; cycle < 4; cycle++) {
        const base = 5776 + cycle * 19;
        const leaps = [];
        for (let offset = 0; offset < 19; offset++) {
            if (HebrewCalendar.hebrewLeapYear(base + offset)) {
                leaps.push(offset);
            }
        }
        assert.deepEqual(leaps, leapPositions, `cycle starting ${base}`);
    }
});

// 353/354/355, and 383/384/385 in a leap year: any other length means a
// postponement rule is wrong, and every date after it in that year is wrong too.
test("year lengths are only the six the rules permit", () => {
    const seen = new Set();

    for (let hebrewYear = 5560; hebrewYear <= 5860; hebrewYear++) {
        const start = HebrewCalendar.gregorianFromHebrew(hebrewYear, 7, 1);
        const next = HebrewCalendar.gregorianFromHebrew(hebrewYear + 1, 7, 1);
        const length = (Date.UTC(next[0], next[1] - 1, next[2]) -
            Date.UTC(start[0], start[1] - 1, start[2])) / MSECS_IN_DAY;
        seen.add(length);
        assert.ok(HebrewCalendar.hebrewLeapYear(hebrewYear) ?
            length >= 383 && length <= 385 : length >= 353 && length <= 355,
        `year ${hebrewYear} is ${length} days`);
    }

    assert.deepEqual([...seen].sort((a, b) => a - b),
        [353, 354, 355, 383, 384, 385], "all six lengths occur in three centuries");
});
