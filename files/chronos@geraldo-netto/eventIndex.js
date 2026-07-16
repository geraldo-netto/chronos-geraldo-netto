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
    Boolean(process.versions && process.versions.node);
const APPLET_MODULES = IS_NODE ?
    null : GjsImports.ui.appletManager.applets["chronos@geraldo-netto"];
const EventDataModule = APPLET_MODULES ? APPLET_MODULES.eventData : require("./eventData");
const date_only = EventDataModule.date_only;
const dt_equals = EventDataModule.dt_equals;
const EventData = EventDataModule.EventData;
const EventDataList = EventDataModule.EventDataList;

const MAX_SPANNED_DAYS = 50;

var EventIndex = class EventIndex {
    constructor(eventsByDate = {}) {
        this.eventsByDate = eventsByDate;
    }

    clear() {
        this.eventsByDate = {};
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

    register(data, timestamp, currentSelectedDate) {
        let changed = false;
        let selected_changed = false;
        let date_iter = date_only(data.start);

        for (let escape = 0; escape <= MAX_SPANNED_DAYS; escape++) {
            const hash = date_iter.to_unix();
            if (this.eventsByDate[hash] === undefined) {
                this.eventsByDate[hash] = new EventDataList(date_iter);
            }

            if (this.eventsByDate[hash].add_or_update(data, timestamp)) {
                changed = true;
                if (dt_equals(date_iter, currentSelectedDate)) {
                    selected_changed = true;
                }
            }

            if (data.ends_on_date_only(date_iter)) {
                break;
            }
            date_iter = date_iter.add_days(1);
        }

        return { changed, selected_changed };
    }

    addOrUpdate(events, timestamp, currentSelectedDate) {
        let events_changed = false;
        let selected_date_changed = false;

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
        }

        return { events_changed, selected_date_changed };
    }

    remove(uids) {
        for (let hash in this.eventsByDate) {
            for (let uid of uids) {
                this.eventsByDate[hash].delete(uid);
            }
        }
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
        return any_removed;
    }
};

if (typeof module !== "undefined") {
    module.exports = { EventIndex, MAX_SPANNED_DAYS };
}
