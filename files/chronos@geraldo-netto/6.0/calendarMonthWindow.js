// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// The 42 days a month grid shows, and the memo in front of them.
//
// Pure month arithmetic: no St, no Clutter, no Cinnamon, no Pango and no gtk30
// gettext domain. It sat in calendar.js with all five, so the date maths could
// not be loaded — let alone tested — without a toolkit stub, though nothing in
// it draws anything.

const DateFormats = require("./dateFormats");
const DateMath = require("./dateMath");
const CalendarNavigation = require("./calendarNavigation");
const CalendarDate = require("./calendarDate");

const clampCalendarDate = CalendarNavigation.clampCalendarDate;
const formatCivilDate = CalendarDate.formatCivilDate;
// weekday, day, month and year: what a sighted user reads off the grid.
// The visible full date is locale-ordered through the shared format, so a
// hardcoded day-month order here meant an en_US user saw "Saturday, July 12,
// 2026" while their screen reader said "Saturday, 12 July 2026". Same date,
// same applet, two different orders.
const ACCESSIBLE_DATE_FORMAT = DateFormats.DATE_FORMAT_FULL;
const ACCESSIBLE_DATE_FORMAT_FALLBACK = DateFormats.DATE_FORMAT_FULL_FALLBACK;

// The window depends only on the displayed month and the week start, but
// _update() runs on every menu open, settings change and event update, and
// rebuilding it costs 42 date records plus 84 GLib.DateTimes every time.
class CalendarMonthWindowCache {
    constructor() {
        this._key = ""; // NOSONAR [S7757] -- accepted compatible form
        this._window = null;
    }

    get(selectedDate, weekStart) {
        const bounded = clampCalendarDate(selectedDate);
        const key = `${bounded.getFullYear()}/${bounded.getMonth()}/${weekStart}`;
        if (this._key !== key || !this._window) {
            this._key = key;
            this._window = new CalendarMonthWindow(bounded, weekStart);
        }

        return this._window;
    }

    // The key is year/month/weekStart, but dateUnixKeys contains local event
    // projections derived from the process timezone. A zone change
    // leaves the key identical, so the owner drops the window from outside.
    invalidate() {
        this._window = null;
    }
}

class CalendarMonthWindow {
    constructor(selectedDate, weekStart) {
        this.selectedDate = clampCalendarDate(selectedDate);
        this.weekStart = weekStart;
        this.beginDate = DateMath.monthWindowStart(
            this.selectedDate.getFullYear(), this.selectedDate.getMonth() + 1, weekStart);
        this.days = this._buildDays();
        this.dateUnixKeys = this.days.map(CalendarDate.localUnixForCivilDate);
        // one GLib.DateTime plus a format per cell, and _update() runs on every
        // menu open, month change, settings change and coalesced event update:
        // the name depends only on the date in the slot, so it belongs here
        // with the rest of the per-month work
        this.accessibleDates = this.days.map((day) =>
            formatCivilDate(day, ACCESSIBLE_DATE_FORMAT, ACCESSIBLE_DATE_FORMAT_FALLBACK));
        this.months = new Set();

        for (const day of this.days) {
            this.months.add(`${day.year}/${day.month}`);
        }
    }

    _buildDays() {
        const days = [];
        for (let i = 0; i < 42; i++) {
            days.push(DateMath.addCivilDays(this.beginDate, i));
        }
        return days;
    }

    weekLabelForRow(rowIndex) {
        const thursday = this.days[rowIndex * 7 + ((4 - this.weekStart + 7) % 7)];
        return formatCivilDate(thursday, '%V');
    }
}

if (typeof module !== "undefined") {
    module.exports = { CalendarMonthWindow, CalendarMonthWindowCache };
}
