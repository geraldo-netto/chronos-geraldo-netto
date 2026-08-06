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

// 1 Tishri of Hebrew year H opens civil year H - 3761. Rosh Hashanah, Yom
// Kippur and Hanukkah fall in that civil year; Purim, Passover and Shavuot come
// after the turn and so fall in the next one.
const YEAR_OFFSET_AUTUMN = 3761;
const YEAR_OFFSET_SPRING = 3760;

// Nisan is month 1 and Tishri month 7, so the month numbers run through the
// year twice over: Tishri opens the civil-year mapping above, and Adar II (13)
// exists only in a leap year.
const NISAN = 1;
const SIVAN = 3;
const TISHRI = 7;
const KISLEV = 9;
const MARHESHVAN = 8;
const ADAR = 12;
const ALWAYS_SHORT_MONTHS = [2, 4, 6, 10, 13];

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
    if (ALWAYS_SHORT_MONTHS.includes(month)) {
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
    const leapCorrection = marchOnward ? (_gregorianLeapYear(year) ? -1 : -2) : 0;

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
    const correction = marchOnward ? (_gregorianLeapYear(year) ? 1 : 2) : 0;
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

function _civilMonthDay(hebrewYear, month, day) {
    const civil = gregorianFromHebrew(hebrewYear, month, day);
    return [civil[1], civil[2]];
}

// The six observances the applet draws, keyed as the catalogue names them.
//
// Purim is 14 Adar, and in a leap year that is Adar II — the later of the two —
// which is what keeps it one month before Passover instead of two. Hanukkah is
// 25 Kislev, the first daytime civil day, not the evening the first candle is
// lit. Each of the six falls exactly once in any civil year: none of their
// civil-date ranges is wide enough to skip a year or land twice in one.
function hebrewObservances(gregorianYear) {
    const autumn = gregorianYear + YEAR_OFFSET_AUTUMN;
    const spring = gregorianYear + YEAR_OFFSET_SPRING;

    return {
        "purim": _civilMonthDay(spring, _lastMonthOfYear(spring), 14),
        "passover-start": _civilMonthDay(spring, NISAN, 15),
        "shavuot": _civilMonthDay(spring, SIVAN, 6),
        "rosh-hashanah": _civilMonthDay(autumn, TISHRI, 1),
        "yom-kippur": _civilMonthDay(autumn, TISHRI, 10),
        "hanukkah-start": _civilMonthDay(autumn, KISLEV, 25)
    };
}

if (typeof module !== "undefined") {
    module.exports = { hebrewLeapYear, gregorianFromHebrew, hebrewObservances };
}
