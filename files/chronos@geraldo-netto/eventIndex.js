// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports */
/* eslint camelcase: "off" */

// Pure event-bucket ownership. Wire adapters and UI orchestration depend on
// this index; it depends only on the event data contract.
const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const APPLET_MODULES = IS_NODE ?
    null : GjsImports.ui.appletManager.applets["chronos@geraldo-netto"];
const EventDataModule = APPLET_MODULES ? APPLET_MODULES.eventData : require("./eventData");
const date_only = EventDataModule.date_only;
const dt_equals = EventDataModule.dt_equals;
const EventData = EventDataModule.EventData;
const EventDataList = EventDataModule.EventDataList;

const MAX_SPANNED_DAYS = 50;
// A fetched window normally contains tens of events. Two thousand still leaves
// ample headroom for large shared calendars while bounding the EventData
// objects and the per-day references retained inside Cinnamon.
var MAX_INDEXED_EVENTS = 2000; // NOSONAR [S3504] -- GJS importer export

var EventIndex = class EventIndex { // NOSONAR [S3504] -- GJS importer export
    constructor(eventsByDate = {}, maxEvents = MAX_INDEXED_EVENTS) {
        this.eventsByDate = eventsByDate;
        this._maxEvents = maxEvents;
        this._eventIds = new Set();
        this._eventsById = new Map();
        this._overflowed = false;
        this._windowStart = null;
        this._windowEnd = null;
        this._rebuildEventState();
    }

    setWindow(start, end) {
        this._windowStart = date_only(start);
        this._windowEnd = date_only(end);
    }

    clear() {
        this.eventsByDate = {};
        this._eventIds.clear();
        this._eventsById.clear();
        this._overflowed = false;
    }

    get overflowed() {
        return this._overflowed;
    }

    markOverflow() {
        if (this._overflowed) {
            return false;
        }
        this._overflowed = true;
        return true;
    }

    clearOverflow() {
        if (!this._overflowed) {
            return false;
        }
        this._overflowed = false;
        return true;
    }

    _rebuildEventState() {
        this._eventIds.clear();
        this._eventsById.clear();
        for (const eventList of Object.values(this.eventsByDate)) {
            for (const event of eventList.get_stored_events()) {
                this._eventIds.add(event.id);
                this._eventsById.set(event.id, event);
            }
        }
    }

    get(date) {
        return this.getByUnixKey(date.to_unix());
    }

    getByUnixKey(dateUnixKey) {
        const event_data_list = this.eventsByDate[dateUnixKey];
        return event_data_list && event_data_list.length > 0 ? event_data_list : null;
    }

    getColorsByUnixKey(dateUnixKey) {
        const event_data_list = this.eventsByDate[dateUnixKey];
        return event_data_list !== undefined ? event_data_list.get_colors() : null;
    }

    _admitEvent(id) {
        if (this._eventIds.has(id)) {
            return null;
        }
        if (this._eventIds.size >= this._maxEvents) {
            return {
                changed: false,
                selected_changed: false,
                overflow_changed: this.markOverflow()
            };
        }

        this._eventIds.add(id);
        return null;
    }

    _removeFromBuckets(uids) {
        for (const [hash, eventList] of Object.entries(this.eventsByDate)) {
            for (const uid of uids) {
                eventList.delete(uid);
            }
            if (eventList.length === 0) {
                delete this.eventsByDate[hash];
            }
        }
    }

    _prepareEvent(data) {
        const existing = this._eventsById.get(data.id);
        const refused = this._admitEvent(data.id);
        if (refused) {
            return refused;
        }
        if (existing && !data.equal(existing)) {
            this._removeFromBuckets([data.id]);
        }
        this._eventsById.set(data.id, data);
        return null;
    }

    _registerOnDate(data, timestamp, date, currentSelectedDate) {
        const hash = date.to_unix();
        if (this.eventsByDate[hash] === undefined) {
            this.eventsByDate[hash] = new EventDataList(date);
        }

        const changed = this.eventsByDate[hash].add_or_update(data, timestamp);
        return {
            changed,
            selected_changed: changed && dt_equals(date, currentSelectedDate)
        };
    }

    _registrationBounds(data) {
        let start = date_only(data.start);
        let end = data.end_date;

        if (this._windowStart && start.compare(this._windowStart) < 0) {
            start = this._windowStart;
        }
        if (this._windowEnd && end.compare(this._windowEnd) > 0) {
            end = this._windowEnd;
        }

        return start.compare(end) <= 0 ? { start, end } : null;
    }

    // A bare add_days() preserves h:m:s, and date_only() cannot always return
    // midnight: where the DST jump lands on midnight — Africa/Cairo on
    // 2023-04-28 — local 00:00 does not exist and GLib resolves it to 01:00.
    // Stepping from there carries that hour into every later bucket, while the
    // grid and the event column look days up by date_only().to_unix(), so none
    // of them would ever be found. Re-normalising each step keeps the key the
    // identity both sides share, and lets the span end on a date comparison
    // rather than an instant equality that in that zone can never match.
    _spannedDays(bounds) {
        const days = [];
        const last = date_only(bounds.end);
        let date_iter = date_only(bounds.start);

        while (days.length <= MAX_SPANNED_DAYS) {
            days.push(date_iter);
            if (date_iter.compare(last) >= 0) {
                return days;
            }
            date_iter = date_only(date_iter.add_days(1));
        }

        this._reportClippedSpan();
        return days;
    }

    // No UID and no summary: both are unbounded wire TEXT from whatever feed
    // the user subscribed to, and this goes to the session log verbatim.
    _reportClippedSpan() {
        if (!global.logError) {
            return;
        }
        global.logError(new Error(
            "chronos: an event covers more than " + (MAX_SPANNED_DAYS + 1) +
            " days of the fetched window; the later days are not indexed"));
    }

    _selectedDayHas(id, currentSelectedDate) {
        const selected = this.get(currentSelectedDate);
        return Boolean(selected && selected.has(id));
    }

    // The server can overlap views during a rapid range change: it cancels and
    // replaces the shared view_cancellable, but the old asynchronous callback
    // tests that shared *current* field rather than the cancellable it started
    // with, so a superseded view can still start and deliver last. Its UIDs
    // then overwrote the newer revision — reverting a reschedule, and
    // inheriting the current watermark so the reconciliation cull could not
    // undo it. Revision order decides, because arrival order does not.
    _isSupersededRevision(data) {
        const existing = this._eventsById.get(data.id);
        return Boolean(existing) && data.superseded_by(existing);
    }

    // the stale delivery is still evidence that the event is live upstream
    _refreshLiveness(id, timestamp) {
        for (const eventList of Object.values(this.eventsByDate)) {
            eventList.touch(id, timestamp);
        }
    }

    register(data, timestamp, currentSelectedDate) {
        // Before the bounds: a stale revision carries the pre-reschedule dates,
        // so letting it through here could drop a live event as out-of-window
        // on the strength of a snapshot that has already been superseded.
        if (this._isSupersededRevision(data)) {
            this._refreshLiveness(data.id, timestamp);
            return { changed: false, selected_changed: false };
        }

        const bounds = this._registrationBounds(data);
        if (bounds === null) {
            const selected_changed = this._selectedDayHas(data.id, currentSelectedDate);
            const changed = this._eventsById.has(data.id);
            this.remove([data.id]);
            return { changed, selected_changed };
        }

        // A reschedule rewrites the buckets below, and _registerOnDate reports
        // only the dates the event now covers — so a move OFF the selected day
        // shrank its list with nothing saying so, and the open event column
        // kept the stale row. The out-of-window branch above already honors
        // this contract; note the departure so the in-window move does too.
        const wasOnSelectedDay = this._selectedDayHas(data.id, currentSelectedDate);

        const refused = this._prepareEvent(data);
        if (refused) {
            return refused;
        }

        let changed = false;
        let selected_changed = false;

        for (const date_iter of this._spannedDays(bounds)) {
            const result = this._registerOnDate(
                data, timestamp, date_iter, currentSelectedDate);
            changed = changed || result.changed;
            selected_changed = selected_changed || result.selected_changed;
        }

        if (wasOnSelectedDay && !selected_changed) {
            selected_changed = !this._selectedDayHas(data.id, currentSelectedDate);
        }

        return { changed, selected_changed };
    }

    addOrUpdate(events, timestamp, currentSelectedDate) {
        let events_changed = false;
        let selected_date_changed = false;
        let overflow_changed = false;

        for (let event of events) {
            let data;
            try {
                data = new EventData(event, timestamp);
            } catch (e) {
                if (global.logError) {
                    global.logError(e);
                }
                continue;
            }

            const result = this.register(data, timestamp, currentSelectedDate);
            events_changed = events_changed || result.changed;
            selected_date_changed = selected_date_changed || result.selected_changed;
            overflow_changed = overflow_changed || Boolean(result.overflow_changed);
        }

        const result = { events_changed, selected_date_changed };
        if (overflow_changed) {
            result.overflow_changed = true;
        }
        return result;
    }

    // The flag means "a delivery was refused because the ceiling was full", so
    // it stops describing the window the moment the window shrinks back under
    // it: the refusals belonged to a payload this removal has already revised,
    // and the event column would go on telling the user rows are hidden on a
    // day that now holds three. Nothing but a shrink clears it, and the next
    // delivery that hits the ceiling arms it again.
    _resyncOverflow() {
        if (this._eventIds.size >= this._maxEvents) {
            return false;
        }
        return this.clearOverflow();
    }

    remove(uids) {
        this._removeFromBuckets(uids);
        uids.forEach((uid) => {
            this._eventIds.delete(uid);
            this._eventsById.delete(uid);
        });
        return this._resyncOverflow();
    }

    // The quiet-window timer arms this after every fetch, so it runs on every
    // month change and every forced refresh — usually finding nothing to cull,
    // because the delivery that armed it re-reported the events it holds. The
    // rebuild is what makes the id state match the buckets again, and nothing
    // can have desynchronised them unless a row was actually dropped.
    cull(timestamp) {
        let any_removed = false;
        for (let date in this.eventsByDate) {
            if (this.eventsByDate[date].cull_removed_events(timestamp)) {
                any_removed = true;
            }
            if (this.eventsByDate[date].length === 0) {
                delete this.eventsByDate[date];
            }
        }
        if (any_removed) {
            this._rebuildEventState();
        }
        this._resyncOverflow();
        return any_removed;
    }
};

if (typeof module !== "undefined") {
    module.exports = { EventIndex, MAX_SPANNED_DAYS, MAX_INDEXED_EVENTS };
}
