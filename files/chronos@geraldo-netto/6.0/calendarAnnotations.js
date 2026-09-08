// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports */
/* eslint camelcase: "off" */

const Tooltips = imports.ui.tooltips;
const LocaleText = require("./localeText");
const TextUtils = require("./textUtils");
const CalendarDate = require("./calendarDate");
const DateMath = require("./dateMath");
// only the flag and error-id constants are read here; requiring the holidays
// barrel would link the cache repository, every vendor adapter and the HTTP
// session into the month header
const Holidays = require("./holidayConstants");

const _ = LocaleText.translate;
const joinPhrases = LocaleText.joinPhrases;
const formatCivilDate = CalendarDate.formatCivilDate;

const PART_DAY_HOLIDAY = Holidays.PART_DAY_HOLIDAY;
const PUBLIC_HOLIDAY_FLAG = Holidays.PUBLIC_HOLIDAY_FLAG;
const HOLIDAY_ERROR_MARKER = TextUtils.WARNING_MARKER;
const HOLIDAY_PENDING_MARKER = "…";

function compareCodeUnits(left, right) {
    if (left < right) {
        return -1;
    }
    return left > right ? 1 : 0;
}

function calendarDateKey(date) {
    return date ? DateMath.civilDateKey(date) : "";
}

// A month's holiday flags: always an array, possibly empty. Every entry of the
// matched-month map is built by holidayConstants.monthHolidayEntry, which
// substitutes [] for a missing list, so the array test below is about the type
// of a *changed* value, not about an absent field.
function sameHolidayFlags(current, incoming) {
    if (current === incoming) {
        return true;
    }
    if (!Array.isArray(current) || !Array.isArray(incoming) ||
        current.length !== incoming.length) {
        return false;
    }

    return current.every((flag, index) => flag === incoming[index]);
}

// One entry of the matched-month map, as holidayConstants.monthHolidayEntry
// builds it: { name, flags }, with flags an array.
function sameHolidayAnnotation(current, incoming) {
    return Boolean(current) && current.name === incoming.name &&
        sameHolidayFlags(current.flags, incoming.flags);
}

// Cinnamon's Tooltip.set_text() has no equality guard: it calls
// allocate_preferred_size() and queue_relayout() unconditionally, so writing
// byte-identical text still forces a relayout. This applet writes the same text
// over and over — the month tooltip is cleared on every _update() and re-set by
// annotate(), and every holiday cell's tooltip is cleared and re-set on every
// pass — so a month with a dozen holidays paid ~30 forced relayouts per update,
// for text that had not changed.
//
// The grid already diffs rendered_style, dot_key and accessible_name before
// writing them. The tooltips are the ones that were missed.
function setTooltipText(owner, tooltip, text) {
    if (owner.rendered_tooltip === text) {
        return;
    }

    owner.rendered_tooltip = text;
    tooltip.set_text(text);
}

// The 42 day cells are reused for every month, so a tooltip left on a cell
// that no longer carries a holiday accumulates: browse a holiday-heavy country
// and all 42 end up holding one on a month that has two. A Cinnamon Tooltip is
// not free to keep — TooltipBase connects seven signals, one of them on
// global.stage, and Tooltip._init builds its own Gio.Settings for the desktop
// interface schema — so a cell that stops being a holiday gives its one back.
function releaseHolidayTooltip(cell) {
    if (!cell.holidayTooltip) {
        return false;
    }

    cell.holidayTooltip.destroy();
    cell.holidayTooltip = null;
    // A replacement Tooltip starts empty. Leaving the last text written to the
    // old one behind would make setTooltipText believe the new one already says
    // it, and the cell would annotate silently.
    cell.rendered_tooltip = undefined;
    return true;
}

// holiday providers report canonical error ids; translate at display time.
const HOLIDAY_ERROR_TEXT = {
    [Holidays.HOLIDAY_ERRORS.SERVICE_UNAVAILABLE]: _("Holiday service unavailable"),
    [Holidays.HOLIDAY_ERRORS.INVALID_RESPONSE]: _("Holiday data unavailable"),
    [Holidays.HOLIDAY_ERRORS.RELIGIOUS_DATES_UNAVAILABLE]:
        _("Religious dates unavailable for this year")
};

// The passthrough fallback is what let a provider's raw JSON sentence become UI
// text. The providers hand up the applet's own error identifiers now, and anything
// else is a bug in this file rather than a string to show the user in whatever
// language a vendor happened to write it.
function translateHolidayError(error) {
    if (!error) {
        return "";
    }

    return HOLIDAY_ERROR_TEXT[error] || HOLIDAY_ERROR_TEXT[Holidays.HOLIDAY_ERRORS.INVALID_RESPONSE];
}
// The month label and everything written on it: the month's name, the pending
// and failure markers, the status tooltip, the accessible name.
//
// The annotator used to write all of this straight onto the calendar —
// _monthLabel.text, _holidayTooltip, _holiday_status_text — and _buildHeader
// owned and reset the same three fields. Two owners for one piece of state.
// The label is built by the header and handed here, and this is the only thing
// that writes it.
class CalendarMonthLabel {
    constructor(label, reasonLabel = null) {
        this.label = label;
        // the reason a month is marked ⚠, as a real actor rather than a hover
        this.reasonLabel = reasonLabel;
        this.tooltip = null;
        this.statusText = "";
    }

    setText(text) {
        // St.Label compares by pointer, so writing a byte-identical string still
        // queues a relayout; the month name changes once a month and _update()
        // runs on every menu open, settings change and event delivery
        if (this.label.text !== text) {
            this.label.text = text;
        }
    }

    // `text` is the whole status, for the mouse tooltip and the accessible name.
    // `reason` is set only when something is actually wrong, and it is what a
    // user with neither a mouse nor a screen reader reads off the popup.
    //
    // The reason used to live in the tooltip alone, shown from a key-focus-in
    // handler — which cannot work. Cinnamon's Tooltip.show() opens with
    //
    //     if (this._tooltip.get_text() == "" || !this.mousePosition) return;
    //
    // and mousePosition is only ever set from enter-event and motion-event; a
    // keyboard sets it never. TooltipBase also connects global.stage's
    // notify::key-focus straight to its own _hide, so moving focus onto the label
    // hides the very tooltip the focus handler is trying to open. It shipped, and
    // it never once worked: the keyboard-only user saw "July ⚠" and had no way to
    // find out why.
    setStatus(text, reason = "") {
        this.statusText = text;
        this._setTooltip(text);

        if (!this.reasonLabel) {
            return;
        }

        // no space is taken when there is nothing wrong, so the ordinary month
        // looks exactly as it did
        this.reasonLabel.visible = Boolean(reason);
        if (reason && this.reasonLabel.text !== reason) {
            this.reasonLabel.text = reason;
        }
    }

    _setTooltip(text) {
        if (!text && !this.tooltip) {
            return;
        }

        if (!this.tooltip) {
            this.tooltip = new Tooltips.Tooltip(this.label);
        }
        setTooltipText(this, this.tooltip, text);
    }

    setAccessibleName(name) {
        if (this.label.set_accessible_name) {
            this.label.set_accessible_name(name);
        }
        this.label.accessible_name = name;
    }
}

class CalendarHolidayAnnotator {
    constructor(host) {
        this.host = host;
        this._month_name_key = "";
        this._month_name = "";
        // the status of the holiday lookup is this collaborator's own: it is
        // what produces it, and it was writing it back into the calendar's
        // private fields for nobody else to read
        this.error = "";
        this.provider = "";
        this.monthLabel = null;
        // whether any cell currently carries a holiday mark, so the grid knows
        // whether it still has to hand us the cells when holidays are switched off
        this.annotated = false;
        this._dates = new Map();
        // months of the current pass still waiting on the network: only the
        // last outstanding answer may replace the pending marker with a final
        // status, or a slow January looks like a month with no holidays
        this._awaited = 0;
        // every provider that answered this pass without an error. The grid can
        // span two calendar years, each with its own cached status, so the
        // months on screen may legitimately come from different services.
        this._pass_providers = new Set();
    }

    // the header builds the label and gives it to us; nothing else writes it
    attachLabel(label, reasonLabel = null) {
        this.monthLabel = new CalendarMonthLabel(label, reasonLabel);
        return this.monthLabel;
    }

    // three sites want the month's name and all three ran a fresh GLib.DateTime
    // and a format to get it, on every update; it changes once a month
    _monthName() {
        const date = this.host.selectedDate;
        const key = `${date.year}/${date.month}`;

        if (this._month_name_key !== key) {
            this._month_name_key = key;
            this._month_name = formatCivilDate(date, '%OB').capitalize();
        }

        return this._month_name;
    }

    // A new pass over the grid: last pass's error belongs to last pass, and the
    // month name may have changed.
    //
    // This used to be a full setStatus(""), which wrote an empty status to the
    // tooltip that annotate() then immediately overwrote with the real one — two
    // forced relayouts per update, for a status that had not changed. Cinnamon's
    // Tooltip.set_text() has no equality guard, so both of them cost a relayout.
    beginUpdate() {
        this.error = "";
        this.provider = "";

        if (this.monthLabel) {
            this.monthLabel.setText(this._monthName());
        }
    }

    // a slow or hanging holiday service must not look the same as a month
    // with no holidays; weather has the same pending marker
    setPending() {
        // One visible month can span three provider months. A cached failure
        // from one remains a current issue while another is still in flight;
        // "loading" must not erase the error already known.
        if (this.error) {
            return;
        }
        this.host.reportIssue("holidays", "");
        if (!this.monthLabel) {
            return;
        }

        this.monthLabel.setText(this._monthName() + " " + HOLIDAY_PENDING_MARKER);
        // a lookup in flight is not a failure: the ellipsis on the label says it,
        // and a line of text that appears and vanishes a second later says less
        this._report(_("Holiday data: loading…"));
    }

    setStatus(error, providerName = "") {
        this.error = error || "";
        this.provider = providerName || "";
        const status = this._statusText();
        this.host.reportIssue("holidays", this.error ? status : "");

        if (!this.monthLabel) {
            return;
        }

        this.monthLabel.setText(this._monthName() +
            (this.error ? " " + HOLIDAY_ERROR_MARKER : ""));

        // Whole sentences, not fragments glued together. "Holiday data: %s" with a
        // standalone "loading…" dropped into it asks a translator to build a
        // sentence out of two msgids they see separately and cannot reorder, and
        // the parentheses around the provider name never reached a translator at
        // all. joinPhrases and "%s Last known reading" are single msgids for this
        // exact reason.
        // the reason is shown as text only when something is wrong; the provider
        // credit on a good month belongs in the tooltip and the accessible name,
        // not as a permanent line under the month
        this._report(status, this.error ? status : "");
    }

    // The failure text is already a whole sentence — "Holiday service unavailable"
    // — so the provider's name is joined to it with joinPhrases, whose separator is
    // itself a msgid. It used to be glued on with literal ASCII parentheses, which
    // no translator ever saw.
    //
    // The provider's name is a proper noun (Enrico, Nager.Date), so the carrier
    // sentence around it is the only translatable part of the good-month line.
    _statusText() {
        if (this.error) {
            const reason = translateHolidayError(this.error);
            return this.provider ? joinPhrases(reason, this.provider) : reason;
        }

        return this.provider ?
            TextUtils.fillTemplate(_("Holiday data: %s"), [this.provider]) : "";
    }

    // the warning glyph is decorative: on its own it reads as an unnamed
    // symbol, and the explanation only existed in a hover tooltip
    //
    // The tolerance for a calendar that was never given a label lives here
    // rather than at each call site. Its two callers below guard first because
    // they also write the label's text, but annotate()'s holidays-off branch
    // reports without writing and so guarded nothing — one call out of three,
    // in a class whose release() states that a label-less calendar is a
    // contemplated state. A guard that has to be repeated is a guard that drifts.
    _report(status, reason = "") {
        if (!this.monthLabel) {
            return;
        }

        this.monthLabel.setStatus(status, reason);

        const month = this._monthName();
        this.monthLabel.setAccessibleName(status ? joinPhrases(month, status) : month);
    }

    // an answer for a country the user has since changed away from owns nothing
    // on this grid
    _isCurrent(holiday_generation) {
        return holiday_generation === this.host.holidayGeneration;
    }

    _reportMonths(months) {
        const results = Array.from(months.values()).filter(Boolean);
        const failed = results.find((result) => result.error);
        if (failed) {
            this.setStatus(failed.error, failed.provider);
            return;
        }

        this._pass_providers = new Set(results.map((result) => result.provider).filter(Boolean));

        if (this._awaited > 0) {
            const recovering = Boolean(this.error);
            this.error = "";
            this.provider = "";
            if (recovering) this.setPending();
            return;
        }

        this.setStatus("", this._passProviderCredit());
    }

    // Holidays from two calendar years both appear on the grid, so both sources
    // are owed the credit. The last callback to arrive used to supply it alone,
    // which meant completion timing chose which service was named. Sorted, so
    // the same set of answers always reads the same way.
    _passProviderCredit() {
        return Array.from(this._pass_providers).sort(compareCodeUnits).join(", ");
    }

    _reconcileCells(dates, cells) {
        this.annotated = false;
        const selectedDates = new Map();

        for (const [date, cell] of cells.entries()) {
            this._resetHolidayStyle(cell);
            const holiday = dates.get(date);
            if (holiday) {
                this._annotateCell(cell, holiday.name, holiday.flags);
                selectedDates.set(DateMath.civilDateKey(cell.date), holiday);
            } else {
                this._clearCell(cell);
            }
        }
        this._setDates(selectedDates);
    }

    _resetHolidayStyle(cell) {
        if (cell.holiday_styled && typeof cell.rendered_style === "string") {
            cell.button.style_class = cell.rendered_style;
            cell.holiday_styled = false;
        }
    }

    // The map this holds is already the previous pass's answer, so it is the
    // comparison — serialising both sides to compare them built two strings and
    // an entries array on every pass, and _update() drives one on every menu
    // open, settings change and coalesced event delivery.
    _sameDates(dates) {
        if (dates.size !== this._dates.size) {
            return false;
        }

        for (const [date, holiday] of dates.entries()) {
            if (!sameHolidayAnnotation(this._dates.get(date), holiday)) {
                return false;
            }
        }

        return true;
    }

    _setDates(dates) {
        if (this._sameDates(dates)) {
            return;
        }
        this._dates = new Map(dates);
        this.host.holidaysChanged();
    }

    holidayForDate(date) {
        return this._dates.get(calendarDateKey(date)) || null;
    }

    // The applet outlives its removal from the panel — Cinnamon's Applet has no
    // destroy(), and AppletContextMenu holds the actor, which holds _delegate —
    // so a month of matched holidays and the strings memoised beside them stay
    // reachable for the rest of the login session unless they are dropped here.
    // The label is not: it belongs to the header, dies with the menu's actors,
    // and the guards that tolerate a missing one exist for a calendar that was
    // never given one, not for a torn-down one that still gets called.
    release() {
        this._dates = new Map();
        this._month_name_key = "";
        this._month_name = "";
        this._pass_providers = new Set();
        this.annotated = false;
    }

    _receiveMonth(dates, error, providerName, pass, month) {
        if (!this._isCurrent(pass.generation)) {
            return;
        }

        if (pass.months.get(month) === null) {
            this._awaited--;
        }
        pass.months.set(month, { dates: new Map(dates), error, provider: providerName });
        this._reportMonths(pass.months);
        if (this._awaited === 0) {
            this._reconcileMonths(pass);
        }
    }

    _reconcileMonths(pass) {
        const dates = new Map();
        for (const result of pass.months.values()) {
            for (const [date, annotation] of result.dates) {
                dates.set(date, annotation);
            }
        }
        this._reconcileCells(dates, pass.cells);
    }

    annotate(months, cells, holiday_generation) {
        if (!this.host.holidaysActive()) {
            // holidays were switched off, or the country was cleared: the marks
            // on the grid belong to a country the user is no longer asking about
            this.clearAnnotations(cells);
            this.host.reportIssue("holidays", "");
            this._report("");
            return;
        }

        // Count every sibling before dispatch: cached months answer inline, and
        // the first one must not reconcile before the later months have even
        // been requested. Only the complete pass owns the visible annotations.
        const monthList = Array.from(new Set(months));
        const pass = {
            generation: holiday_generation,
            months: new Map(monthList.map((month) => [month, null])),
            cells
        };
        this._awaited = monthList.length;
        // pass state, like _awaited: a cached month answers inside the dispatch
        // loop below, so this has to be empty before the first one does
        this._pass_providers = new Set();
        for (let month of monthList) {
            const [y, m] = month.split('/');
            this.host.requestHolidays(y, m, (dates, error, providerName) => {
                this._receiveMonth(dates, error, providerName, pass, month);
            });
        }

        // a cached month answers inside getHolidays; anything still awaited is
        // a real network round-trip the user should see
        if (this._awaited > 0) {
            this.setPending();
        }
    }

    clearAnnotations(cells) {
        this.annotated = false;

        for (const cell of cells.values()) {
            this._clearCell(cell);
        }
        this._setDates(new Map());
    }

    _clearCell(cell) {
        if (!cell.holiday_name && !cell.holiday_tooltip_set) {
            return;
        }

        cell.holiday_name = "";
        releaseHolidayTooltip(cell);
        cell.holiday_tooltip_set = false;
        this.host.nameCell(cell);
    }

    _annotateCell(cell, name, flags) {
        if (!cell.holidayTooltip) {
            cell.holidayTooltip = new Tooltips.Tooltip(cell.button);
        }
        setTooltipText(cell, cell.holidayTooltip, name);
        cell.holiday_tooltip_set = true;

        // the tooltip is the only place the holiday's name appears, and a
        // keyboard never opens one
        cell.holiday_name = name;
        this.annotated = true;
        this.host.nameCell(cell);

        const partDay = flags.indexOf(PART_DAY_HOLIDAY) >= 0; // NOSONAR [S7765] -- accepted compatible form
        const observanceOnly = !flags.includes(PUBLIC_HOLIDAY_FLAG);
        if (observanceOnly) {
            // An observance is visible and named, but is not automatically a
            // day off. A same-date public holiday carries the explicit public
            // flag supplied by its provider and follows the non-work path below.
            cell.button.add_style_class_name("calendar-holiday-day");
            cell.holiday_styled = true;
            return;
        }
        if (this.host.weekendLength === 1 && partDay) return;

        cell.button.remove_style_class_name("calendar-work-day");
        cell.button.add_style_class_name("calendar-nonwork-day");
        // ...which is the class a Saturday already carries, so on its own it
        // made a public holiday pixel-identical to a weekend: the feature the
        // user turned holidays on for was invisible unless they hovered every
        // bold cell in the month. This is the mark that says "holiday".
        cell.button.add_style_class_name("calendar-holiday-day");
        cell.holiday_styled = true;
    }
}


if (typeof module !== "undefined") {
    module.exports = {
        CalendarMonthLabel,
        CalendarHolidayAnnotator,
        HOLIDAY_ERROR_TEXT,
        translateHolidayError,
        setTooltipText,
        releaseHolidayTooltip,
        calendarDateKey
    };
}
