// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* eslint camelcase: "off" */

// Pure helpers for the event-row label logic in 6.0/eventView.js. No toolkit
// on purpose: everything operates on the EventData day-comparison interface
// and injected formatting options, so Node tests can drive the full matrix of
// date permutations without Clutter or GLib. Its two imports, textUtils and
// dateMath, reach for neither either.

/* global imports */
const TextUtils = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node) ? // NOSONAR [S6582] -- accepted compatible form
    require("./textUtils") :
    imports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;
const DateMath = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node) ? // NOSONAR [S6582] -- accepted compatible form
    require("./dateMath") :
    imports.ui.appletManager.applets["chronos@geraldo-netto"].dateMath;
const fillTemplate = TextUtils.fillTemplate;
var dtEquals = DateMath.dtEquals; // NOSONAR [S3504] -- GJS importer export

var EVENT_PHASE_PAST = "past"; // NOSONAR [S3504] -- GJS importer export
var EVENT_PHASE_UPCOMING = "upcoming"; // NOSONAR [S3504] -- GJS importer export
var EVENT_PHASE_CURRENT = "current"; // NOSONAR [S3504] -- GJS importer export

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

function formatTodayEndpoint(time, allDay, selectedIsToday, opts) {
    const _ = opts.translate;
    if (allDay) {
        return _("Today");
    }
    const stamp = time.format(opts.timeFormat);
    // Keep time and Today in one translatable phrase so their order can vary.
    return selectedIsToday ? stamp : fillTemplate(_("%s Today"), [stamp]);
}

function formatPastPrefix(event, selected_date, today, opts) {
    // A recent weekday takes priority even when the event starts on the
    // selected date. At exactly four days ago, the selected time can take over.
    if (event.started_after_date_only(today.add_days(-NEARBY_DAY_WINDOW))) {
        return localeCap(event.start_date.format(opts.dayFormat));
    }
    if (event.starts_on_date_only(selected_date) && !event.all_day) {
        return event.start.format(opts.timeFormat);
    }
    return event.start_date.format("%x");
}

// The "X → …" half of a multi-day event label. opts carries the applet
// context: timeFormat ("%H:%M" or "%l:%M %p"), dayFormat (weekday format)
// and translate (gettext).
function formatRangePrefix(event, selected_date, today, opts) {
    const selectedIsToday = dtEquals(today, selected_date);
    if (event.starts_on_date_only(today)) {
        return formatTodayEndpoint(event.start, event.all_day, selectedIsToday, opts);
    }
    if (event.started_before_date_only(today)) {
        return formatPastPrefix(event, selected_date, today, opts);
    }
    if (selectedIsToday) {
        return "";
    }
    const nearby = event.started_before_date_only(today.add_days(NEARBY_DAY_WINDOW));
    return event.start_date.format(nearby ? opts.dayFormat : "%x");
}

// U+2192 has the Unicode Bidi_Mirrored property, so the compositor flips the
// direction cue with the surrounding event range in an RTL layout.
var ARROW_SEPARATOR = "  →  "; // NOSONAR [S3504] -- GJS importer export

// The "… → Y" half of a multi-day event label. Unlike a future prefix, the
// suffix still uses a capitalized weekday at exactly four days ahead.
function formatRangeSuffix(event, selected_date, today, opts) {
    const selectedIsToday = dtEquals(today, selected_date);
    if (event.ends_on_date_only(today)) {
        return formatTodayEndpoint(event.end, event.all_day, selectedIsToday, opts);
    }

    if (!selectedIsToday && event.ends_on_date_only(selected_date) && !event.all_day) {
        return event.end.format(opts.timeFormat);
    }

    if (event.ends_after_date_only(today.add_days(NEARBY_DAY_WINDOW))) {
        return event.end_date.format("%x");
    }

    return localeCap(event.end_date.format(opts.dayFormat));
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
