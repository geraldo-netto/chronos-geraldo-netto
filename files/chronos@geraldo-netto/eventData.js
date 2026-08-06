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

// Data model for calendar events: date helpers plus EventData and
// EventDataList, shared by 6.0/eventView.js and unit-testable in Node.

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
// Which host is loading this file — and it is asked of the *host*, not of
// require(). It used to test `typeof require === "function"`, on the stated
// assumption that "Cinnamon provides neither require() nor module". That was true
// of 5.4 through 6.4 and is not true of Cinnamon master, which sets
// globalThis.require = xletRequire (js/ui/extension.js). There the test would
// invert: the root modules would take the require() branch, _requireLocal would
// resolve "./localeUtils" against extension.meta.path — which
// findExtensionSubdirectory has already repointed at the 6.0/ directory — and the
// applet would fail to load, because localeUtils.js is not in there.
//
// Node is what this asks about, because Node is the only host that requires these
// files directly. Cinnamon's cjs has no `process`.
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const GLib = GjsImports.gi.GLib;
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;
const StyleUtils = IS_NODE ?
    require("./styleUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].styleUtils;

// EventListRenderer uses equality to distinguish a changing event's countdown
// from a structurally different list that must rebuild its rows. Monotonic time
// is ordered but not unique: two mutations (or two day lists) may receive the
// same microsecond value. A process-wide sequence gives every structural state
// a distinct identity; at one revision per microsecond it would still take
// centuries to approach Number.MAX_SAFE_INTEGER.
let lastEventListRevision = 0;

function nextEventListRevision() {
    lastEventListRevision++;
    return lastEventListRevision;
}


function js_date_to_gdatetime(js_date) {
    let unix = js_date.getTime() / 1000; // getTime returns ms
    return GLib.DateTime.new_from_unix_local(unix);
}

function date_only(gdatetime) {
    let date = GLib.DateTime.new_local(
        gdatetime.get_year(),
        gdatetime.get_month(),
        gdatetime.get_day_of_month(), 0, 0, 0
    );

    return date;
}

function month_year_only(gdatetime) {
    return GLib.DateTime.new_local(
        gdatetime.get_year(),
        gdatetime.get_month(),
        1, 0, 0, 0
    );
}

// GLib.DateTime.equal is broken
function dt_equals(dt1, dt2) {
    return dt1.to_unix() === dt2.to_unix();
}

// GLib.DateTime only spans years 1 to 9999: new_from_unix_local() returns null
// for anything outside that, and every line below would then dereference it —
// inside a DBus signal handler, on the compositor thread. The times come from
// evolution-data-server, which is repeating whatever an ICS or CalDAV feed told
// it, so they are not ours to trust.
var MIN_EVENT_UNIX = -62135596800; // NOSONAR [S3504] -- GJS importer export; 0001-01-01
var MAX_EVENT_UNIX = 253402300799; // NOSONAR [S3504] -- GJS importer export; 9999-12-31

function eventUnixTime(value) {
    const time = typeof value === "number" ? value : Number(value);

    if (!Number.isFinite(time) || time < MIN_EVENT_UNIX || time > MAX_EVENT_UNIX) {
        return null;
    }

    return Math.trunc(time);
}

// The summary is whatever ICS or CalDAV feed the user subscribed to put in
// SUMMARY, relayed by evolution-data-server. It goes into a wrapping,
// non-ellipsizing St.Label and into the row's accessible name, so a feed with a
// half-megabyte summary lays all of it out on the compositor thread. The same
// argument bounds holiday names at the same length (holidayCache.js), and a
// real summary is a few words.
var MAX_EVENT_SUMMARY_LENGTH = 300; // NOSONAR [S3504] -- GJS importer export

function clampEventSummary(summary) {
    return TextUtils.clampText(summary, MAX_EVENT_SUMMARY_LENGTH);
}

// The UID is wire TEXT relayed from whatever feed the user subscribed to, and
// the index retains every accepted one in a set, a map and per-day lists for
// the life of the window — so sequential deliveries of near-cap payloads could
// pin gigabytes of UID bytes inside Cinnamon. One bound serves the whole
// applet: the launch path already keeps UIDs under the kernel's per-argv
// limit, and 2,000 admitted events stay in megabytes even from a hostile feed.
var MAX_EVENT_UID_LENGTH = 4096; // NOSONAR [S3504] -- GJS importer export

function validEventUid(id) {
    return typeof id === "string" && id.length > 0 &&
        id.length <= MAX_EVENT_UID_LENGTH;
}

function inclusiveEventEnd(end, allDay) {
    if (!allDay) {
        return end;
    }

    const inclusiveEnd = end.add_seconds(-1);
    if (!inclusiveEnd) {
        throw new Error("skipping an event with no usable start or end time");
    }
    return inclusiveEnd;
}

var EventData = class EventData { // NOSONAR [S3504] -- GJS importer export
    constructor(data_var, last_update_timestamp) {
        const unpacked = data_var.deep_unpack();
        const [id, color, summary, all_day, start_time, end_time, mod_time] =
            Array.isArray(unpacked) ? unpacked : [];

        const start = eventUnixTime(start_time);
        const end = eventUnixTime(end_time);
        if (start === null || end === null) {
            // The caller turns this into "skip the event", which is the only
            // sane answer: an event with no time cannot be placed on a grid.
            // The UID stays out of the message — it is unbounded wire TEXT
            // with no character guarantees, and the caller logs this verbatim.
            throw new Error("skipping an event with no usable start or end time");
        }

        if (!validEventUid(id)) {
            throw new Error("skipping an event with an unusable id");
        }
        const localStart = GLib.DateTime.new_from_unix_local(start);
        const localEnd = GLib.DateTime.new_from_unix_local(end);
        if (!localStart || !localEnd) {
            throw new Error("skipping an event with no usable start or end time");
        }
        this.id = id;
        this.start = localStart;
        this.end = localEnd;

        this.all_day = all_day;
        // An all-day event can be from 00:00 to 00:00 the next day, which
        // would otherwise cause it to appear for two days.
        this.end = inclusiveEventEnd(this.end, this.all_day);
        if (this.end.compare(this.start) == -1) {
            // An all day event can be a single point in time at 00:00. The previous -1s
            // will cause it to appear all the following days in the current view.
            this.end = this.start;
        }
        this.start_date = date_only(this.start);
        this.end_date = date_only(this.end);
        this.multi_day = !dt_equals(this.start_date, this.end_date);

        // both go straight into St actors; the summary is a label and the
        // colour is filtered again before it reaches an inline style
        this.summary = clampEventSummary(summary);
        this.color = StyleUtils.safeCssColor(color, "");
        // This is the time_t for when event was last modified by e-d-s
        this.modified = mod_time;
        // This is the last monotonic time we contacted our server to update our events. This
        // is used to cull deleted events.
        this.last_update_timestamp = last_update_timestamp;
    }

    // the index and the row formatter both work in date-only values, so a
    // single comparison API is enough
    starts_on_date_only(date) {
        return dt_equals(date, this.start_date);
    }

    ends_on_date_only(date) {
        return dt_equals(date, this.end_date);
    }

    started_before_date_only(date) {
        return date.difference(this.start_date) > 0;
    }

    ended_before_date_only(date) {
        return date.difference(this.end_date) > 0;
    }

    ends_after_date_only(date) {
        return date.difference(this.end_date) < 0;
    }

    started_after_date_only(date) {
        return date.difference(this.start_date) < 0;
    }

    equal(other_event) {
        return this.id === other_event.id &&
            this.modified === other_event.modified &&
            this.all_day === other_event.all_day &&
            this.start.to_unix() === other_event.start.to_unix() &&
            this.end.to_unix() === other_event.end.to_unix() &&
            this.summary === other_event.summary;
    }

    // `modified` is the EDS revision of this component, so it orders two
    // snapshots of the same UID causally — arrival order does not. A payload
    // whose revision fields are not both usable says nothing about ordering.
    // cinnamon-calendar-server emits zero when LAST-MODIFIED and CREATED are
    // both absent, so zero is missing metadata rather than a 1970 revision.
    superseded_by(other_event) {
        return this.modified !== 0 && other_event.modified !== 0 &&
            Number.isFinite(this.modified) &&
            Number.isFinite(other_event.modified) &&
            this.modified < other_event.modified;
    }
};

var EventDataList = class EventDataList { // NOSONAR [S3504] -- GJS importer export
    constructor(gdate_only) {
        // The revision changes whenever events are added, removed or modified.
        // The event list compares it with the revision recorded when it loaded
        // the day's events, prompting a full rebuild of the re-sorted rows.
        //
        // If the revision has not changed, only variable details are refreshed:
        // time until start, style changes, and similar clock-driven state.
        this.timestamp = nextEventListRevision();
        this.gdate_only = gdate_only;
        this.length = 0;
        // Keyed by event UID, which comes off whatever ICS or CalDAV feed the
        // user subscribed to. A plain object inherits from Object.prototype, so
        // an event whose UID is "toString" reads back as a function rather than
        // undefined — the count is then never incremented and drifts out of
        // step with the real entries, which is what decides whether an emptied
        // day is dropped. A UID of "__proto__" is worse: the assignment creates
        // no own property at all and the event vanishes.
        this._events = Object.create(null);
        this._cachedColors = null;
        this._cachedColorsTimestamp = 0;
    }

    _mark_changed() {
        this.timestamp = nextEventListRevision();
        this._cachedColors = null;
        this._cachedColorsTimestamp = 0;
    }

    add_or_update(event_data, last_update_timestamp) {
        let existing = this._events[event_data.id];

        if (existing === undefined) {
            this.length++;
        }

        if (existing !== undefined && event_data.equal(existing)) {
            existing.last_update_timestamp = last_update_timestamp;
            if (existing.color !== event_data.color) {
                // A multi-day event is one object shared by every day bucket.
                // Mutating it here makes only the first bucket observe the
                // recolor; later buckets see the new value already and report
                // no change, including a selected later day. Replace this
                // bucket's reference so every bucket compares independently.
                event_data.last_update_timestamp = last_update_timestamp;
                this._events[event_data.id] = event_data;
                this._mark_changed();
                return true;
            }
            return false;
        }

        this._events[event_data.id] = event_data;
        this._mark_changed();

        return true;
    }

    // A superseded snapshot still proves the event exists upstream, so its
    // liveness is refreshed even though its content is discarded — otherwise
    // the reconciliation cull that follows would delete the newer revision
    // that was kept in its place.
    touch(id, last_update_timestamp) {
        const existing = this._events[id];

        if (existing === undefined) {
            return false;
        }

        existing.last_update_timestamp = last_update_timestamp;
        return true;
    }

    delete(id) {
        let existing = this._events[id];

        if (existing === undefined) {
            return false;
        }

        this.length --;
        delete this._events[id];

        this._mark_changed();
        return true;
    }

    cull_removed_events(last_update_timestamp) {
        let to_remove = [];
        for (let id in this._events) {
            if (this._events[id].last_update_timestamp < last_update_timestamp) {
                to_remove.push(id);
            }
        }

        if (to_remove.length === 0) {
            return false;
        }

        to_remove.forEach((id) => {
            this.delete(id);
        });

        return true;
    }

    get_event_list() {
        let now = GLib.DateTime.new_now_local();

        let events_as_array = [];
        for (let id in this._events) {
            events_as_array.push(this._events[id]);
        }

        // chrono order for non-current day
        events_as_array.sort((a, b) => {
            return a.start.to_unix() - b.start.to_unix();
        });

        if (!dt_equals(date_only(now), this.gdate_only)) {
            return events_as_array;
        }

        return this._orderTodayWithAllDays(events_as_array, now);
    }

    // Membership, without materialising the key array to find out. The index
    // asks this up to twice per registered event, so a delivery of a busy day
    // used to allocate one key array per event and scan it linearly.
    has(id) {
        return Boolean(this._events[id]);
    }

    // The events in storage order, for callers that want the day's contents
    // rather than the day's *reading* order. get_event_list() sorts and builds
    // a GLib.DateTime.new_now_local() plus a date_only() to decide where the
    // all-day events sit relative to the current one — work an index rebuild
    // pays once per bucket and then throws away.
    get_stored_events() {
        return Object.values(this._events);
    }

    // for the current day keep all-day events just above the current or
    // first pending event
    _orderTodayWithAllDays(events_as_array, now) {
        const allDays = events_as_array.filter((event) => event.all_day);
        const timed = events_as_array.filter((event) => !event.all_day);
        const firstCurrent = timed.findIndex((event) => event.end.difference(now) >= 0);

        if (firstCurrent < 0) {
            return timed.concat(allDays);
        }
        return timed.slice(0, firstCurrent)
            .concat(allDays, timed.slice(firstCurrent));
    }

    get_colors() {
        if (this._cachedColors && this._cachedColorsTimestamp === this.timestamp) {
            return this._cachedColors;
        }

        this._cachedColors = this.get_event_list().map((event) => event.color);
        this._cachedColorsTimestamp = this.timestamp;

        return this._cachedColors;
    }
};

if (typeof module !== "undefined") {
    module.exports = {
        js_date_to_gdatetime,
        date_only,
        month_year_only,
        dt_equals,
        clampEventSummary,
        MAX_EVENT_SUMMARY_LENGTH,
        MAX_EVENT_UID_LENGTH,
        validEventUid,
        EventData,
        EventDataList
    };
}
