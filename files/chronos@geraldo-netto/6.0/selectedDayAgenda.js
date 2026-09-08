// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* global imports */
/* eslint camelcase: "off" */

// What the event column is asked to draw for one day, and the words for "how
// soon". No St, no Clutter, no Atk, no Gtk: a value type, the policy that
// composes it, and two pure string rules — which is why they are not in
// eventView.js, where the actor tree, the accessibility, the issue reporting
// and the overflow state machine live.

const GLib = imports.gi.GLib;
const LocaleText = require("./localeText");
const EventDataModule = require("./eventData");
const HolidayConstants = require("./holidayConstants");

const _ = LocaleText.translate;
const ngettext = LocaleText.translatePlural;

function holidayAgendaType(flags = []) {
    const publicHoliday = flags.includes(HolidayConstants.PUBLIC_HOLIDAY_FLAG);
    const religiousHoliday = flags.includes(HolidayConstants.RELIGIOUS_HOLIDAY_FLAG);
    if (publicHoliday && religiousHoliday) {
        return _("Public holiday and religious observance");
    }
    if (publicHoliday) {
        return _("Public holiday");
    }
    if (religiousHoliday) {
        return _("Religious observance");
    }
    if (flags.includes("calendar_observance")) {
        return "Calendar observance";
    }
    return _("Holiday");
}

// What the event column renders for one day: the calendar server's events, the
// day's holiday, or both.
//
// composeSelectedDayAgenda used to answer this class on a day with a holiday
// and the raw EventDataList otherwise — two unrelated types chosen by data,
// with the surface enforced by nothing but the call sites that existed. This
// one duck-types that one on exactly the three members the renderer reads
// today; EventDataList additionally carries gdate_only, has(), add_or_update,
// touch and _mark_changed, and this has none of them. So a renderer change
// reading any of those would have worked every day of the year except on
// holidays, in countries that have them — the least likely case a test or a
// manual check hits.
class SelectedDayAgenda {
    constructor(eventDataList, holiday) {
        this._eventDataList = eventDataList || null;
        this._holiday = holiday || null;
        this.hasHolidays = Boolean(this._holiday);
        const eventTimestamp = this._eventDataList ? this._eventDataList.timestamp : 0;
        this.timestamp = `agenda:${eventTimestamp}:${JSON.stringify(this._holiday)}`;
        this.length = (this._eventDataList ? this._eventDataList.length : 0) +
            (this.hasHolidays ? 1 : 0);
    }

    get_event_list() {
        const events = this._eventDataList ? this._eventDataList.get_event_list() : [];
        if (!this._holiday) {
            return events;
        }
        return [{
            id: null,
            is_holiday: true,
            summary: EventDataModule.clampEventSummary(this._holiday.name),
            flags: this._holiday.flags || [],
            color: "transparent"
        }].concat(events);
    }

    holidaysOnly() {
        return new SelectedDayAgenda(null, this._holiday);
    }
}

// One shape whenever there is a shape at all. null keeps its existing meaning —
// nothing to draw, which is what puts the "no events" box up — so the renderer
// still branches on presence, never on which of two classes it was handed.
function composeSelectedDayAgenda(eventDataList, holiday) {
    if (!eventDataList && !holiday) {
        return null;
    }
    return new SelectedDayAgenda(eventDataList, holiday);
}

function format_timespan(timespan) {
    let minutes = Math.floor(timespan / GLib.TIME_SPAN_MINUTE);

    if (minutes < 10) {
        return ["imminent", _("Starting in a few minutes")];
    }

    if (minutes < 60) {
        // Russian declares three plural forms, and 21, 22 and 25 minutes each
        // take a different one. The line below already uses ngettext for hours;
        // this one just never did.
        return ["soon", ngettext("Starting in %d minute", "Starting in %d minutes", minutes).format(minutes)];
    }

    let hours = Math.floor(minutes / 60);

    if (hours > 6) {
        let now = GLib.DateTime.new_now_local();
        let later = now.add_hours(hours);

        if (later.get_hour() > 18) {
            return ["", _("This evening")];
        }

        return ["", _("Starting later today")];
    }

    return ["", ngettext("In %d hour", "In %d hours", hours).format(hours)];
}

if (typeof module !== "undefined") {
    module.exports = {
        SelectedDayAgenda, composeSelectedDayAgenda, holidayAgendaType, format_timespan
    };
}
