// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// The Hebrew calendar, as arithmetic.
//
// Unlike the observational calendars beside it, this one stopped depending on
// sighting when the rule-based calendar was fixed: the molad of Tishri is an
// arithmetic progression, and the four postponements (dehiyyot) that move Rosh
// Hashanah off it are deterministic. There is nothing to observe and nothing to
// wait for a publisher to print, so these dates need no table and cannot fall
// out of one — the civil dates below are the ones Hebcal prints, for any year.
//
// Follows Dershowitz & Reingold, "Calendrical Calculations", through fixed
// ("Rata Die") day numbers, where RD 1 is 1 January 1 CE in the proleptic
// Gregorian calendar. It is all integer arithmetic: no floating point, no Date,
// no host timezone, and therefore the same answer everywhere.

// RD of 1 Tishri, year 1 of the Hebrew era — equivalently 7 October 3761 BCE in
// the proleptic Julian calendar.
const HEBREW_EPOCH = -1373427;

// Tishri (month 7) opens the Hebrew year, whose month numbers wrap to Nisan
// (month 1) in spring. Adar II (month 13) exists only in a leap year.
const NISAN = 1;
const SIVAN = 3;
const TISHRI = 7;
const KISLEV = 9;
const MARHESHVAN = 8;
const ADAR = 12;
const ALWAYS_SHORT_MONTHS = new Set([2, 4, 6, 10, 13]);
const OBSERVANCE_DATES = {
    "purim": [ADAR, 14],
    "passover-start": [NISAN, 15],
    "shavuot": [SIVAN, 6],
    "rosh-hashanah": [TISHRI, 1],
    "yom-kippur": [TISHRI, 10],
    "hanukkah-start": [KISLEV, 25]
};

function _mod(value, modulus) {
    return ((value % modulus) + modulus) % modulus;
}

// Seven leap years in every nineteen, on the Metonic cycle.
function hebrewLeapYear(year) {
    return _mod(7 * year + 1, 19) < 7;
}

function _lastMonthOfYear(year) {
    return hebrewLeapYear(year) ? 13 : ADAR;
}

// Days from the epoch to the molad of Tishri, already carrying the dehiyyah
// that keeps 1 Tishri off Sunday, Wednesday and Friday.
function _elapsedDays(year) {
    const monthsElapsed = Math.floor((235 * year - 234) / 19);
    const partsElapsed = 12084 + 13753 * monthsElapsed;
    const day = 29 * monthsElapsed + Math.floor(partsElapsed / 25920);

    return _mod(3 * (day + 1), 7) < 3 ? day + 1 : day;
}

// The two remaining postponements, which are easier to state as a correction to
// the year's start than as a rule about the molad.
function _lengthCorrection(year) {
    const current = _elapsedDays(year);

    if (_elapsedDays(year + 1) - current === 356) {
        return 2;
    }
    return current - _elapsedDays(year - 1) === 382 ? 1 : 0;
}

function _newYear(year) {
    return HEBREW_EPOCH + _elapsedDays(year) + _lengthCorrection(year);
}

function _daysInYear(year) {
    return _newYear(year + 1) - _newYear(year);
}

// A Hebrew year is 353, 354 or 355 days (383, 384 or 385 when it is a leap
// year). Marheshvan and Kislev are the two months that absorb the difference:
// the deficient year shortens Kislev, the complete year lengthens Marheshvan.
function _longMarheshvan(year) {
    const length = _daysInYear(year);
    return length === 355 || length === 385;
}

function _shortKislev(year) {
    const length = _daysInYear(year);
    return length === 353 || length === 383;
}

// The three months whose length depends on the year: Adar is full only when it
// is Adar I of a leap year (Adar II is month 13), and Marheshvan and Kislev are
// where the year's 353/354/355 length is absorbed.
function _isFullMonth(year, month) {
    if (month === ADAR) {
        return hebrewLeapYear(year);
    }
    if (month === MARHESHVAN) {
        return _longMarheshvan(year);
    }
    if (month === KISLEV) {
        return !_shortKislev(year);
    }

    return true;
}

function _lastDayOfMonth(year, month) {
    if (ALWAYS_SHORT_MONTHS.has(month)) {
        return 29;
    }

    return _isFullMonth(year, month) ? 30 : 29;
}

// The months of a Hebrew year in the order they are lived through: Tishri opens
// it, so 7..last come before 1..6.
function _monthsBefore(year, month) {
    const order = [];
    for (let m = TISHRI; m <= _lastMonthOfYear(year); m++) {
        order.push(m);
    }
    for (let m = NISAN; m < TISHRI; m++) {
        order.push(m);
    }

    return order.slice(0, order.indexOf(month));
}

function _fixedFromHebrew(year, month, day) {
    const elapsed = _monthsBefore(year, month).reduce(
        (total, m) => total + _lastDayOfMonth(year, m), 0);

    return _newYear(year) + elapsed + day - 1;
}

function _gregorianLeapYear(year) {
    const century = _mod(year, 400);
    return _mod(year, 4) === 0 && century !== 100 && century !== 200 &&
        century !== 300;
}

function _fixedFromGregorian(year, month, day) {
    const priorYear = year - 1;
    const marchOnward = month > 2;
    let leapCorrection = 0;
    if (marchOnward) {
        leapCorrection = _gregorianLeapYear(year) ? -1 : -2;
    }

    return 365 * priorYear + Math.floor(priorYear / 4) -
        Math.floor(priorYear / 100) + Math.floor(priorYear / 400) +
        Math.floor((367 * month - 362) / 12) + leapCorrection + day;
}

function _gregorianYearFromFixed(fixed) {
    const priorDays = fixed - 1;
    const n400 = Math.floor(priorDays / 146097);
    const within400 = _mod(priorDays, 146097);
    const n100 = Math.floor(within400 / 36524);
    const within100 = _mod(within400, 36524);
    const n4 = Math.floor(within100 / 1461);
    const n1 = Math.floor(_mod(within100, 1461) / 365);
    const years = 400 * n400 + 100 * n100 + 4 * n4 + n1;

    // the last day of a leap year and of a 400-year cycle both land one year
    // past their own quotient
    return n100 === 4 || n1 === 4 ? years : years + 1;
}

function _gregorianFromFixed(fixed) {
    const year = _gregorianYearFromFixed(fixed);
    const priorDays = fixed - _fixedFromGregorian(year, 1, 1);
    const marchOnward = fixed >= _fixedFromGregorian(year, 3, 1);
    let correction = 0;
    if (marchOnward) {
        correction = _gregorianLeapYear(year) ? 1 : 2;
    }
    const month = Math.floor((12 * (priorDays + correction) + 373) / 367);

    return [year, month, fixed - _fixedFromGregorian(year, month, 1) + 1];
}

// [year, month, day] of the civil date a Hebrew date falls on. A Hebrew day
// begins at the preceding sunset; this is the daytime civil date, which is the
// convention the observance catalogue publishes. The civil year comes back with
// it because which year a Hebrew date lands in is a fact about the date, not
// something the caller may assume.
function gregorianFromHebrew(year, month, day) {
    return _gregorianFromFixed(_fixedFromHebrew(year, month, day));
}

function _hebrewYearContaining(fixed) {
    let lower = 1;
    // Every Hebrew year has at least 353 days, so this is strictly after fixed.
    let upper = Math.floor((fixed - HEBREW_EPOCH) / 353) + 2;
    while (lower + 1 < upper) {
        const middle = Math.floor((lower + upper) / 2);
        if (_newYear(middle) <= fixed) {
            lower = middle;
        } else {
            upper = middle;
        }
    }
    return lower;
}

function _civilObservance(hebrewYear, month, day) {
    // Purim uses the final Adar: Adar II in a leap year.
    const resolvedMonth = month === ADAR ? _lastMonthOfYear(hebrewYear) : month;
    return gregorianFromHebrew(hebrewYear, resolvedMonth, day);
}

// Each key holds all [year, month, day] occurrences in chronological order.
// Hebrew dates drift through Gregorian seasons: Hanukkah first crosses into
// January in 3032, leaving 3031 with none and 3032 with two starts. Enumerating
// the Hebrew years that intersect the requested civil year preserves both.
function hebrewObservances(gregorianYear) {
    if (!Number.isInteger(gregorianYear) || gregorianYear < 1 || gregorianYear > 9999) {
        return {};
    }
    const observances = Object.fromEntries(Object.keys(OBSERVANCE_DATES).map((key) => [key, []]));
    const firstYear = _hebrewYearContaining(_fixedFromGregorian(gregorianYear, 1, 1));
    const finalDay = _fixedFromGregorian(gregorianYear, 12, 31);
    for (let year = firstYear; _newYear(year) <= finalDay; year++) {
        for (const [key, [month, day]] of Object.entries(OBSERVANCE_DATES)) {
            const civil = _civilObservance(year, month, day);
            if (civil[0] === gregorianYear) {
                observances[key].push(civil);
            }
        }
    }
    return observances;
}

if (typeof module !== "undefined") {
    module.exports = { hebrewLeapYear, gregorianFromHebrew, hebrewObservances };
}
