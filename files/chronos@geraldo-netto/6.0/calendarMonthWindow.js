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
const EventDataModule = require("./eventData");
const CalendarNavigation = require("./calendarNavigation");
const CalendarDate = require("./calendarDate");

const clampCalendarDate = CalendarNavigation.clampCalendarDate;
const _formatJsDate = CalendarDate.formatJsDate;
const date_only = EventDataModule.date_only;
const js_date_to_gdatetime = EventDataModule.js_date_to_gdatetime;
const MSECS_IN_DAY = DateFormats.MSECS_IN_DAY;
// weekday, day, month and year: what a sighted user reads off the grid.
// The visible full date is locale-ordered through the shared format, so a
// hardcoded day-month order here meant an en_US user saw "Saturday, July 12,
// 2026" while their screen reader said "Saturday, 12 July 2026". Same date,
// same applet, two different orders.
const ACCESSIBLE_DATE_FORMAT = DateFormats.DATE_FORMAT_FULL;
const ACCESSIBLE_DATE_FORMAT_FALLBACK = DateFormats.DATE_FORMAT_FULL_FALLBACK;

// The window depends only on the displayed month and the week start, but
// _update() runs on every menu open, settings change and event update, and
// rebuilding it costs 42 Dates plus 84 GLib.DateTimes every time.
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

    // The key is year/month/weekStart, but dateUnixKeys and accessibleDates are
    // absolute values derived from the process timezone the window was built
    // in. A zone change leaves the key identical and every value inside wrong,
    // so it has to be dropped from outside. Releasing the window rather than
    // clearing the key is what frees the 42 Dates and 84 GLib.DateTimes it
    // holds; get() rebuilds on either, and the key is rewritten there anyway.
    invalidate() {
        this._window = null;
    }
}

class CalendarMonthWindow {
    constructor(selectedDate, weekStart) {
        this.selectedDate = clampCalendarDate(selectedDate);
        this.weekStart = weekStart;
        this.beginDate = this._beginDate();
        this.days = this._buildDays();
        this.dateUnixKeys = this.days.map((day) => {
            const gdate = js_date_to_gdatetime(day);
            return gdate ? date_only(gdate).to_unix() : null;
        });
        // one GLib.DateTime plus a format per cell, and _update() runs on every
        // menu open, month change, settings change and coalesced event update:
        // the name depends only on the date in the slot, so it belongs here
        // with the rest of the per-month work
        this.accessibleDates = this.days.map((day) =>
            _formatJsDate(day, ACCESSIBLE_DATE_FORMAT, ACCESSIBLE_DATE_FORMAT_FALLBACK));
        this.months = new Set();

        for (const day of this.days) {
            this.months.add(`${day.getFullYear()}/${day.getMonth() + 1}`);
        }
    }

    _beginDate() {
        let beginDate = new Date(this.selectedDate);
        beginDate.setDate(1);
        beginDate.setSeconds(0);
        beginDate.setHours(12);
        // monthWindowStartOffset speaks GLib's ISO weekday (1=Mon..7=Sun);
        // Date.getDay() reports Sunday as 0
        const daysToWeekStart = DateFormats.monthWindowStartOffset(
            beginDate.getDay() || 7, this.weekStart);
        beginDate.setTime(beginDate.getTime() - daysToWeekStart * MSECS_IN_DAY);
        return beginDate;
    }

    _buildDays() {
        const days = [];
        let iter = new Date(this.beginDate);
        for (let i = 0; i < 42; i++) {
            days.push(new Date(iter));
            iter.setTime(iter.getTime() + MSECS_IN_DAY);
        }
        return days;
    }

    weekLabelForRow(rowIndex) {
        const thursday = this.days[rowIndex * 7 + ((4 - this.weekStart + 7) % 7)];
        return _formatJsDate(thursday, '%V');
    }
}

if (typeof module !== "undefined") {
    module.exports = { CalendarMonthWindow, CalendarMonthWindowCache };
}
