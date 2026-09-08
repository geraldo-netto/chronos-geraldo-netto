// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const CalendarDate = require("./calendarDate");
const DateMath = require("./dateMath");

const SMOOTH_SCROLL_NOTCH = 1;
const MAX_SMOOTH_SCROLL_MONTHS = 12;
// January 1 can need leading cells in year 0, and December 9999 can need
// trailing cells in year 10000. GLib.DateTime represents neither, so the
// browsable domain starts and ends one month inside its year limits.
const MIN_BROWSABLE_MONTH_ORDINAL = 1 * 12 + 1;
const MAX_BROWSABLE_MONTH_ORDINAL = 9999 * 12 + 10;
const DAY_KEY_DELTAS = {
    [Clutter.KEY_Left]: -1,
    [Clutter.KEY_Right]: 1,
    [Clutter.KEY_Up]: -7,
    [Clutter.KEY_Down]: 7
};
const MIRRORED_KEYS = new Set([Clutter.KEY_Left, Clutter.KEY_Right]);

const sameDay = CalendarDate.sameDay;

function clampCalendarDate(date) {
    const ordinal = date.getFullYear() * 12 + date.getMonth();
    if (ordinal >= MIN_BROWSABLE_MONTH_ORDINAL &&
            ordinal <= MAX_BROWSABLE_MONTH_ORDINAL) {
        return date;
    }

    const bounded = new Date(date);
    if (ordinal < MIN_BROWSABLE_MONTH_ORDINAL) {
        bounded.setFullYear(1, 1, 1);
    } else {
        bounded.setFullYear(9999, 10, 30);
    }
    return bounded;
}

function browsedDate(oldDate, yearChange, monthChange) {
    const monthIndex = oldDate.getMonth() + monthChange;
    const monthYearChange = Math.floor(monthIndex / 12);
    const newMonth = ((monthIndex % 12) + 12) % 12;

    const newYear = oldDate.getFullYear() + yearChange + monthYearChange;
    const ordinal = newYear * 12 + newMonth;
    if (ordinal < MIN_BROWSABLE_MONTH_ORDINAL ||
            ordinal > MAX_BROWSABLE_MONTH_ORDINAL) {
        return clampCalendarDate(oldDate);
    }

    const monthEnd = DateMath.addCivilDays({ year: newYear, month: newMonth + 2, day: 1 }, -1);
    const day = Math.min(oldDate.getDate(), monthEnd.day);
    return localDateNear({ year: newYear, month: newMonth + 1, day },
        day === monthEnd.day ? -1 : 1) || oldDate;
}

// A local timezone can omit a whole Gregorian date. Keep navigation moving in
// its requested direction instead of normalizing back onto the selected date.
// Two projections bound the work; no event or settings input can cause a scan.
function localDateNear(date, direction) {
    const unix = CalendarDate.localUnixForCivilDate(date);
    const projected = unix === null ? CalendarDate.localUnixForCivilDate(
        DateMath.addCivilDays(date, direction)) : unix;
    return projected === null ? null : new Date(projected * 1000);
}

// Owns selected-date state, input interpretation, focus and coalesced browsing.
// Its port is the small part of the grid/lifecycle it needs to notify.
class CalendarNavigationController {
    constructor(port, selectedDate = new Date()) {
        this.port = port;
        this.selectedDate = clampCalendarDate(selectedDate);
        this.queuedDate = null;
        this.setDateIdleId = 0;
        this.scrollAccumulator = 0;
        this.focusAfterSetDate = false;
    }

    setDate(date, forceReload) {
        this.cancelQueuedDate();
        this.focusAfterSetDate = false;
        const bounded = clampCalendarDate(date);
        const changed = !sameDay(bounded, this.selectedDate);
        if (!changed && !forceReload) {
            return false;
        }

        if (changed) {
            this.selectedDate = bounded;
            this.port.emitSelected(bounded);
        }
        this.port.update();
        return changed;
    }

    cancelQueuedDate() {
        if (this.setDateIdleId > 0) {
            Mainloop.source_remove(this.setDateIdleId);
            this.setDateIdleId = 0;
        }
        this.queuedDate = null;
    }

    // Public: the timeout below drives it, and tests flush a queued browse
    // without waiting out the 25ms coalescing window.
    flushQueuedDate() {
        const date = this.queuedDate;
        const focusAfterSetDate = this.focusAfterSetDate;
        this.queuedDate = null;
        this.setDateIdleId = 0;
        this.focusAfterSetDate = false;
        if (!date) {
            return GLib.SOURCE_REMOVE;
        }
        this.port.setDate(date, false);
        if (focusAfterSetDate) {
            this.focusSelectedDay();
        }
        return GLib.SOURCE_REMOVE;
    }

    queueDate(date) {
        this.queuedDate = clampCalendarDate(date);
        if (this.setDateIdleId === 0) {
            this.setDateIdleId = Mainloop.timeout_add(25, this.flushQueuedDate.bind(this));
        }
    }

    focusSelectedDay() {
        const selected = DateMath.localDateParts(this.selectedDate);
        for (const cell of this.port.dayCells()) {
            if (DateMath.sameCivilDate(cell.date, selected) && cell.button.grab_key_focus) {
                cell.button.can_focus = true;
                cell.button.grab_key_focus();
                return true;
            }
        }
        return false;
    }

    dayCellHasFocus() {
        const focused = global.stage && global.stage.get_key_focus ? // NOSONAR [S6582] -- accepted compatible form
            global.stage.get_key_focus() : null;
        return !focused || this.port.dayCells().some((cell) => cell.button === focused);
    }

    rtl() {
        const actor = this.port.actor();
        return Boolean(actor.get_direction && actor.get_direction() === St.TextDirection.RTL);
    }

    onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const days = DAY_KEY_DELTAS[symbol];
        if (days !== undefined) {
            return this._moveSelectionByDays(symbol, days);
        }

        if (!this.dayCellHasFocus()) {
            return Clutter.EVENT_PROPAGATE;
        }
        return this._handleGridCommand(symbol);
    }

    // Held down, this is about thirty selections a second at the usual
    // autorepeat rate, and each one used to run the whole cost of a deliberate
    // pick: a grid update, plus an emitSelected that reaches the applet's
    // _updateClockAndDate(true), reselects the day on the events manager and
    // re-feeds the event column. Every intermediate day was drawn and thrown
    // away.
    //
    // It coalesces on the same 25 ms window as Page Up/Down and the scroll
    // wheel, and composes from the queued date the way applyBrowse does, so a
    // run of repeats resolves to one move. That window is a frame and a half —
    // the two paths that have always used it are the evidence it does not read
    // as lag — and it buys the arrows the one thing they lacked: a held key
    // costs one repaint instead of one per key event.
    _moveSelectionByDays(symbol, days) {
        if (!this.dayCellHasFocus()) {
            return Clutter.EVENT_PROPAGATE;
        }
        const delta = this.rtl() && MIRRORED_KEYS.has(symbol) ? -days : days;
        const target = localDateNear(DateMath.addCivilDays(
            DateMath.localDateParts(this.queuedDate || this.selectedDate), delta), Math.sign(delta));
        if (!target) {
            return Clutter.EVENT_STOP;
        }
        // the focus follows the selection, and flushQueuedDate is what moves it
        this.focusAfterSetDate = true;
        this.port.queueDate(target);
        return Clutter.EVENT_STOP;
    }

    _handleGridCommand(symbol) {
        if (symbol === Clutter.KEY_Page_Up || symbol === Clutter.KEY_Page_Down) {
            this.focusAfterSetDate = true;
            this.applyBrowse(0, symbol === Clutter.KEY_Page_Up ? -1 : 1);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Home) {
            this.setDate(new Date(), false);
            this.focusSelectedDay();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    onScroll(event) {
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            this.applyBrowse(0, -1);
            return Clutter.EVENT_STOP;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            this.applyBrowse(0, 1);
            return Clutter.EVENT_STOP;
        case Clutter.ScrollDirection.SMOOTH:
            return this.onSmoothScroll(event);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    onSmoothScroll(event) {
        const [dx, dy] = event.get_scroll_delta();
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
            return Clutter.EVENT_PROPAGATE;
        }
        const delta = Math.abs(dy) > Math.abs(dx) ? dy : dx;
        if (delta === 0) {
            return Clutter.EVENT_PROPAGATE;
        }
        if (Math.sign(delta) !== Math.sign(this.scrollAccumulator)) {
            this.scrollAccumulator = 0;
        }
        this.scrollAccumulator += delta;
        const notches = Math.trunc(this.scrollAccumulator / SMOOTH_SCROLL_NOTCH);
        this.scrollAccumulator -= notches * SMOOTH_SCROLL_NOTCH;
        if (notches !== 0) {
            const months = Math.max(-MAX_SMOOTH_SCROLL_MONTHS,
                Math.min(MAX_SMOOTH_SCROLL_MONTHS, notches));
            this.applyBrowse(0, months);
        }
        return Clutter.EVENT_STOP;
    }

    applyBrowse(yearChange, monthChange) {
        const oldDate = this.queuedDate || this.selectedDate;
        this.port.queueDate(browsedDate(oldDate, yearChange, monthChange));
        return true;
    }
}

if (typeof module !== "undefined") {
    module.exports = { CalendarNavigationController, browsedDate, clampCalendarDate, sameDay };
}
