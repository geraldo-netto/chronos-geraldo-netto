const assert = require("node:assert/strict");
const { test } = require("node:test");
const Dates = require("../files/chronos@geraldo-netto/dateMath");
const { makeRandom } = require("./helpers/prng");

function monthLength(year, month) {
    if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function following(date) {
    const next = { ...date, day: date.day + 1 };
    if (next.day > monthLength(next.year, next.month)) {
        next.day = 1;
        next.month++;
    }
    if (next.month === 13) {
        next.month = 1;
        next.year++;
    }
    return next;
}

test("Gregorian parts preserve small years, leap rules, and weekday anchors", () => {
    assert.equal(Dates.civilWeekday({ year: 1, month: 1, day: 1 }), 1);
    assert.equal(Dates.civilWeekday({ year: 2000, month: 1, day: 1 }), 6);
    for (const year of [1, 4, 99, 100, 400, 1900, 2000, 2024, 9999]) {
        const february = { year, month: 2, day: monthLength(year, 2) };
        assert.deepEqual(Dates.addCivilDays(february, 1), { year, month: 3, day: 1 });
        const local = new Date(0);
        local.setFullYear(year, 1, february.day);
        assert.deepEqual(Dates.localDateParts(local), february);
    }
    assert.equal(Dates.sameCivilDate(null, { year: 1, month: 1, day: 1 }), false);
    assert.equal(Dates.sameCivilDate({ year: 1, month: 1, day: 1 }, null), false);
    assert.equal(Dates.civilDateKey({ year: 99, month: 12, day: 31 }), "99/12/31");
});

test("seeded Gregorian windows have 42 distinct sequential dates for every week start", () => {
    const seed = 0x1138;
    const random = makeRandom(seed);
    for (let round = 0; round < 1000; round++) {
        const year = 1 + Math.floor(random() * 9999);
        const month = 1 + Math.floor(random() * 12);
        const weekStart = Math.floor(random() * 7);
        const first = Dates.monthWindowStart(year, month, weekStart);
        const message = `seed=${seed} round=${round} input=${year}/${month}/${weekStart}`;
        assert.equal(Dates.civilWeekday(first), weekStart, message);
        const keys = new Set();
        let expected = first;
        let containsFirst = false;
        for (let index = 0; index < 42; index++) {
            const actual = Dates.addCivilDays(first, index);
            assert.deepEqual(actual, expected, message);
            assert.equal(Dates.civilWeekday(actual), (weekStart + index) % 7, message);
            assert.ok(actual.month >= 1 && actual.month <= 12, message);
            assert.ok(actual.day >= 1 && actual.day <= monthLength(actual.year, actual.month), message);
            assert.ok(Dates.sameCivilDate(Dates.addCivilDays(actual, -index), first), message);
            if (index < 7 && actual.year === year && actual.month === month && actual.day === 1) containsFirst = true;
            keys.add(Dates.civilDateKey(actual));
            expected = following(expected);
        }
        assert.equal(keys.size, 42, message);
        assert.ok(containsFirst, message);
    }
});
