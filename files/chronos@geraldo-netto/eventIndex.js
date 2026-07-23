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

    _rebuildEventState() {
        this._eventIds.clear();
        this._eventsById.clear();
        for (const eventList of Object.values(this.eventsByDate)) {
            for (const event of eventList.get_event_list()) {
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

    register(data, timestamp, currentSelectedDate) {
        const bounds = this._registrationBounds(data);
        if (bounds === null) {
            const selected = this.get(currentSelectedDate);
            const selected_changed = Boolean(selected &&
                selected.get_ids().includes(data.id));
            const changed = this._eventsById.has(data.id);
            this.remove([data.id]);
            return { changed, selected_changed };
        }

        const refused = this._prepareEvent(data);
        if (refused) {
            return refused;
        }

        let changed = false;
        let selected_changed = false;
        let date_iter = bounds.start;

        for (let escape = 0; escape <= MAX_SPANNED_DAYS; escape++) {
            const result = this._registerOnDate(
                data, timestamp, date_iter, currentSelectedDate);
            changed = changed || result.changed;
            selected_changed = selected_changed || result.selected_changed;

            if (dt_equals(bounds.end, date_iter)) {
                break;
            }
            date_iter = date_iter.add_days(1);
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

    remove(uids) {
        this._removeFromBuckets(uids);
        uids.forEach((uid) => {
            this._eventIds.delete(uid);
            this._eventsById.delete(uid);
        });
    }

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
        this._rebuildEventState();
        return any_removed;
    }
};

if (typeof module !== "undefined") {
    module.exports = { EventIndex, MAX_SPANNED_DAYS, MAX_INDEXED_EVENTS };
}
