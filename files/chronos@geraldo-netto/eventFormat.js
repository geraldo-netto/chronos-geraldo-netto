// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* eslint camelcase: "off" */

// Pure helpers for the event-row label logic in 5.4/eventView.js. No GJS
// imports on purpose: everything operates on the EventData day-comparison
// interface and injected formatting options, so Node tests can drive the
// full matrix of date permutations without Clutter or GLib.

var EVENT_PHASE_PAST = "past"; // NOSONAR [S3504] -- GJS importer export
var EVENT_PHASE_UPCOMING = "upcoming"; // NOSONAR [S3504] -- GJS importer export
var EVENT_PHASE_CURRENT = "current"; // NOSONAR [S3504] -- GJS importer export

function dtEquals(dt1, dt2) {
    return dt1.to_unix() === dt2.to_unix();
}

// Mirrors the branch structure at the top of EventRow.update_variations:
// which phase the event is in relative to now, and the row flags derived
// from it. `today` must be a date-only value.
//
// The state used to carry two more fields — starts_today and selected_is_today
// — and no consumer read either. selected_is_today was the only reason this
// needed to know the selected date at all, so it does not take one any more:
// which day the user is looking at does not change whether an event is over.
function classifyEventDisplayState(event, now, today) {
    const time_until_start = event.start.difference(now);
    const time_until_finish = event.end.difference(now);

    const starts_today = dtEquals(today, event.start_date);

    if (time_until_finish < 0) {
        return {
            phase: EVENT_PHASE_PAST,
            show_countdown: false,
            is_current_or_next: false,
            time_until_start
        };
    }

    if (time_until_start > 0) {
        return {
            phase: EVENT_PHASE_UPCOMING,
            show_countdown: starts_today,
            is_current_or_next: starts_today && !event.all_day,
            time_until_start
        };
    }

    return {
        phase: EVENT_PHASE_CURRENT,
        show_countdown: false,
        is_current_or_next: event.starts_on_date_only(today) && !event.all_day,
        time_until_start
    };
}

function localeCap(str) {
    return str.charAt(0).toLocaleUpperCase() + str.slice(1);
}

// Recent/near dates show a weekday name instead of a full date; the
// original code uses a +/-4 day window around the reference day.
var NEARBY_DAY_WINDOW = 4; // NOSONAR [S3504] -- GJS importer export

function _prefixForTodaySelected(event, selected_date, opts) {
    const _ = opts.translate;
    if (event.starts_on_date_only(selected_date)) {
        return event.all_day ? _("Today") : event.start.format(opts.timeFormat);
    }

    if (event.started_before_date_only(selected_date)) {
        if (event.started_after_date_only(selected_date.add_days(-NEARBY_DAY_WINDOW))) {
            return localeCap(event.start_date.format(opts.dayFormat));
        }
        return event.start_date.format("%x");
    }

    return "";
}

function _prefixForOtherDaySelected(event, selected_date, today, opts) {
    const _ = opts.translate;
    if (event.started_before_date_only(today)) {
        if (event.started_after_date_only(today.add_days(-NEARBY_DAY_WINDOW))) {
            return localeCap(event.start_date.format(opts.dayFormat));
        }
        if (event.starts_on_date_only(selected_date) && !event.all_day) {
            return event.start.format(opts.timeFormat);
        }
        return event.start_date.format("%x");
    }

    if (event.starts_on_date_only(today)) {
        if (event.all_day) {
            return _("Today");
        }
        // one msgid, not a time glued to a word: a translator cannot reorder
        // "14:30 Today" into "Heute 14:30" if the pieces never meet. String
        // .format() is a GJS extension and this module is deliberately free of
        // GJS, so the placeholder is filled by hand.
        return _("%s Today").replace("%s", event.start.format(opts.timeFormat));
    }

    if (event.started_before_date_only(today.add_days(NEARBY_DAY_WINDOW))) {
        return event.start_date.format(opts.dayFormat);
    }
    return event.start_date.format("%x");
}

// The "X → …" half of a multi-day event label. opts carries the applet
// context: timeFormat ("%H:%M" or "%l:%M %p"), dayFormat (weekday format)
// and translate (gettext).
function formatRangePrefix(event, selected_date, today, opts) {
    if (dtEquals(today, selected_date)) {
        return _prefixForTodaySelected(event, selected_date, opts);
    }
    return _prefixForOtherDaySelected(event, selected_date, today, opts);
}

// U+2192 has the Unicode Bidi_Mirrored property, so the compositor flips the
// direction cue with the surrounding event range in an RTL layout.
var ARROW_SEPARATOR = "  →  "; // NOSONAR [S3504] -- GJS importer export

function _suffixForTodaySelected(event, selected_date, opts) {
    const _ = opts.translate;
    if (event.ends_on_date_only(selected_date)) {
        return event.all_day ? _("Today") : event.end.format(opts.timeFormat);
    }

    if (event.ends_after_date_only(selected_date.add_days(NEARBY_DAY_WINDOW))) {
        return event.end_date.format("%x");
    }

    return localeCap(event.end_date.format(opts.dayFormat));
}

function _suffixForOtherDaySelected(event, selected_date, today, opts) {
    const _ = opts.translate;
    if (event.ends_on_date_only(today)) {
        if (event.all_day) {
            return _("Today");
        }
        return _("%s Today").replace("%s", event.end.format(opts.timeFormat));
    }

    if (event.ends_on_date_only(selected_date) && !event.all_day) {
        return event.end.format(opts.timeFormat);
    }

    if (event.ends_after_date_only(today.add_days(NEARBY_DAY_WINDOW))) {
        return event.end_date.format("%x");
    }

    return localeCap(event.end_date.format(opts.dayFormat));
}

// The "… → Y" half of a multi-day event label.
function formatRangeSuffix(event, selected_date, today, opts) {
    if (dtEquals(today, selected_date)) {
        return _suffixForTodaySelected(event, selected_date, opts);
    }
    return _suffixForOtherDaySelected(event, selected_date, today, opts);
}

// Full label text for an event row: single-day, past-multi-day, or the
// composed prefix → suffix range.
function formatEventTimeRange(event, selected_date, today, opts) {
    const _ = opts.translate;
    if (event.starts_on_date_only(selected_date) && !event.multi_day) {
        if (event.all_day) {
            return _("All day");
        }
        return event.start.format(opts.timeFormat) + ARROW_SEPARATOR + event.end.format(opts.timeFormat);
    }

    if (event.multi_day && event.ended_before_date_only(today)) {
        return event.start_date.format("%x") + ARROW_SEPARATOR + event.end_date.format("%x");
    }

    return formatRangePrefix(event, selected_date, today, opts) +
        ARROW_SEPARATOR +
        formatRangeSuffix(event, selected_date, today, opts);
}

if (typeof module !== "undefined") {
    module.exports = {
        EVENT_PHASE_PAST,
        EVENT_PHASE_UPCOMING,
        EVENT_PHASE_CURRENT,
        ARROW_SEPARATOR,
        dtEquals,
        classifyEventDisplayState,
        localeCap,
        formatRangePrefix,
        formatRangeSuffix,
        formatEventTimeRange
    };
}
