// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// Dependency-free calendar arithmetic shared by domain and presentation code.
var MSECS_IN_DAY = 24 * 60 * 60 * 1000; // NOSONAR [S3504] -- GJS importer export

// Days to step back from a month's first day to reach the start of the
// calendar grid. isoWeekDay is GLib's 1=Mon..7=Sun; weekStart is
// Cinnamon.util_get_week_start()'s 0=Sun..6=Sat.
function monthWindowStartOffset(isoWeekDay, weekStart) {
    return ((isoWeekDay % 7) - weekStart + 7) % 7;
}

// Plain Gregorian dates are not instants. UTC is only an arithmetic workspace:
// local timezone jumps must never remove or duplicate a grid cell. setUTCFullYear
// also preserves years 1..99, unlike the multi-argument Date constructor.
function localDateParts(date) {
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

function civilDayNumber(date) {
    const utc = new Date(0);
    utc.setUTCFullYear(date.year, date.month - 1, date.day);
    return utc.getTime() / MSECS_IN_DAY;
}

function addCivilDays(date, days) {
    const utc = new Date((civilDayNumber(date) + days) * MSECS_IN_DAY);
    return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function civilWeekday(date) {
    return ((civilDayNumber(date) + 4) % 7 + 7) % 7;
}

function sameCivilDate(left, right) {
    return Boolean(left && right) && left.year === right.year &&
        left.month === right.month && left.day === right.day;
}

function civilDateKey(date) {
    return `${date.year}/${date.month}/${date.day}`;
}

function monthWindowStart(year, month, weekStart) {
    const first = { year, month, day: 1 };
    return addCivilDays(first, -monthWindowStartOffset(civilWeekday(first) || 7, weekStart));
}

// GLib.DateTime.equal is broken, so identity is compared through the epoch
// seconds instead. It lives here because both the domain model (eventData, which
// pulls GLib at module scope) and the presentation formatter (eventFormat, which
// deliberately pulls neither GLib nor Clutter) need it, and this module is the
// only one both can load.
function dtEquals(dt1, dt2) {
    return dt1.to_unix() === dt2.to_unix();
}

if (typeof module !== "undefined") {
    module.exports = { MSECS_IN_DAY, monthWindowStartOffset, dtEquals,
        localDateParts, civilDayNumber, addCivilDays, civilWeekday, sameCivilDate,
        civilDateKey, monthWindowStart };
}
