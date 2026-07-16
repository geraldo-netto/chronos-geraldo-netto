// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports */
/* eslint camelcase: "off" */

// Signal/timer orchestration for calendar events. Boundary adapters, indexing,
// and date-window policy are constructor dependencies assembled by the factory.
const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node);
const Gio = GjsImports.gi.Gio;
const GLib = GjsImports.gi.GLib;
const Mainloop = GjsImports.mainloop;
const Signals = GjsImports.signals;
const APPLET_MODULES = IS_NODE ?
    null : GjsImports.ui.appletManager.applets["chronos@geraldo-netto"];
const ProviderUtils = APPLET_MODULES ? APPLET_MODULES.providerUtils : require("./providerUtils");
const CalendarServerModule = APPLET_MODULES ? APPLET_MODULES.calendarServerConnection : require("./calendarServerConnection");
const EventIndexModule = APPLET_MODULES ? APPLET_MODULES.eventIndex : require("./eventIndex");
const EventWindowModule = APPLET_MODULES ? APPLET_MODULES.eventWindow : require("./eventWindow");

const CalendarServerConnection = CalendarServerModule.CalendarServerConnection;
const EventIndex = EventIndexModule.EventIndex;
const EventWindowCoordinator = EventWindowModule.EventWindowCoordinator;
var EDS_BUS_NAME = CalendarServerModule.EDS_BUS_NAME;
var SERVER_RETRY_SECONDS = CalendarServerModule.SERVER_RETRY_SECONDS;
var SERVER_RETRY_MAX_SECONDS = CalendarServerModule.SERVER_RETRY_MAX_SECONDS;

// A month fetch that fails takes the month's events with it; retry it a few
// times with backoff before giving up.
var FETCH_RETRY_SECONDS = 5;
var FETCH_RETRY_MAX_SECONDS = 120;
var FETCH_RETRY_MAX_ATTEMPTS = 5;
var EVENT_BATCH_CHUNK = 25;

var EventsManager = class EventsManager {
    constructor(settings, params = {}) {
        if (!params.serverConnection || !params.eventIndex || !params.windowCoordinator) {
            throw new Error("EventsManager requires its connection, index, and window collaborators");
        }

        this.settings = settings;
        this._random = params.random || Math.random;
        this._server_connection = params.serverConnection;
        this.last_update_timestamp = 0;
        this._event_index = params.eventIndex;
        this._window_coordinator = params.windowCoordinator;

        this._destroyed = false;

        this._gc_timer_id = 0;

        this._reload_today_id = 0;

        this._fetch_retry_id = 0;
        this._fetch_retry_attempts = 0;
        // idles still to run for a batch that is being applied in chunks
        this._event_batch_ids = [];
        this._pending_emit = null;
        // handed to every call_set_time_range so a reply that is still in
        // flight when the applet goes away is cancelled rather than delivered
        // to a torn-down manager
        this._fetch_cancellable = new Gio.Cancellable();

        this._force_reload_pending = false;
    }

    // read-only views of collaborator state, for the callers inside this
    // class; everything else reaches through _server_connection /
    // _event_index / _window_coordinator directly
    get current_selected_date() {
        return this._window_coordinator.current_selected_date;
    }

    start_events() {
        this._server_connection.start();
    }

    _stop_gc_timer() {
        if (this._gc_timer_id > 0) {
            Mainloop.source_remove(this._gc_timer_id);
            this._gc_timer_id = 0;
        }
    }

    _start_gc_timer() {
        this._stop_gc_timer();

        if (!this.is_active()) {
            return;
        }

        this._gc_timer_id = Mainloop.timeout_add_seconds(
            3, this._perform_gc.bind(this)
        );
    }

    _perform_gc() {
        let any_removed = this._event_index.cull(this.last_update_timestamp);

        if (any_removed) {
            this.emit("selected-date-events-changed",
                this._event_index.get(this.current_selected_date),
                false);
            this.emit("events-updated");
        }

        this._gc_timer_id = 0;
        return GLib.SOURCE_REMOVE;
    }

    // This runs inside a DBus signal handler, on the compositor thread. unpack()
    // materialises the whole array, and each EventData does a deep_unpack plus
    // several GLib.DateTime constructions, and register() walks up to 50 day
    // buckets per multi-day event — so a busy shared calendar's initial 42-day
    // window arrived as one unbounded synchronous burst on the thread that draws
    // every window on the desktop.
    //
    // The batch is chunked across idles. Order is preserved, and the index is
    // the same at the end; only the time it is allowed to take in one turn
    // changes.
    //
    // What must NOT be chunked is the signals. Every consumer of "events-updated"
    // rebuilds the whole 42-cell grid, and every consumer of
    // "selected-date-events-changed" tears down and rebuilds the event column —
    // so emitting per chunk made a 200-event delivery pay eight full grid
    // rebuilds and eight column rebuilds where one would do. The chunking traded
    // one long stall for eight shorter ones plus eight times the downstream work,
    // which is not the trade it was written to make.
    //
    // What changed is accumulated across the chunks and said once, at the end.
    _handle_added_or_updated_events(server, varray) {
        const events = varray.unpack();

        if (events.length <= EVENT_BATCH_CHUNK) {
            this._apply_added_or_updated(events, true);
            return;
        }

        this._queue_event_batch(events, 0);
    }

    _queue_event_batch(events, index) {
        const end = Math.min(index + EVENT_BATCH_CHUNK, events.length);
        const last = end >= events.length;
        this._apply_added_or_updated(events.slice(index, end), last);

        if (last || this._destroyed) {
            return;
        }

        this._event_batch_ids.push(Mainloop.idle_add(() => {
            this._event_batch_ids.shift();
            if (this._destroyed) {
                // the applet is going away mid-batch: there is nothing left to
                // repaint, and nobody to tell
                this._pending_emit = null;
            } else {
                this._queue_event_batch(events, end);
            }
            return GLib.SOURCE_REMOVE;
        }));
    }

    // `flush` is true on the last chunk of a batch
    _apply_added_or_updated(events, flush) {
        const result = this._event_index.addOrUpdate(
            events, this.last_update_timestamp, this.current_selected_date);

        const pending = this._pending_emit ||
            { selected_date_changed: false, events_changed: false };
        pending.selected_date_changed =
            pending.selected_date_changed || result.selected_date_changed;
        pending.events_changed = pending.events_changed || result.events_changed;

        this._start_gc_timer();

        if (!flush) {
            this._pending_emit = pending;
            return;
        }

        this._pending_emit = null;

        if (pending.selected_date_changed) {
            this.emit("selected-date-events-changed",
                this._event_index.get(this.current_selected_date),
                false);
        }

        if (pending.events_changed) {
            this.emit("events-updated");
        }
    }

    _handle_removed_events(server, uids_string) {
        let uids = uids_string.split("::");
        this._event_index.remove(uids);

        // the reload below re-selects today, but selectDate early-returns on an
        // unchanged date, so the removed event's row would stay on screen until
        // the user picked another day: re-feed the open list here
        this.emit("selected-date-events-changed",
            this._event_index.get(this.current_selected_date),
            false);

        this.queue_reload_today(false);

        this.emit("events-updated");
    }

    _handle_client_disappeared(server, uid) {
        // A calendar was removed/disabled. Instead of picking
        // specific matching events to remove, just rebuild the
        // entire list.
        this._event_index.clear();
        this.queue_reload_today(true);
    }

    _handle_status_changed() {
        this.queue_reload_today(true);
        this.emit("has-calendars-changed");
    }

    fetch_month_events(month_year, force) {
        const timestamp = this._window_coordinator.fetchMonthEvents(
            month_year,
            force,
            this._server_connection.setTimeRange.bind(this._server_connection),
            this.call_finished.bind(this),
            GLib.get_monotonic_time,
            this._fetch_cancellable
        );

        if (timestamp !== null) {
            this.last_update_timestamp = timestamp;
        }
    }

    call_finished(server, res) {
        // the applet was removed while this call was in flight: the proxy is
        // gone, and there is nobody left to hand events to
        if (this._destroyed) {
            return;
        }

        try {
            this._server_connection.finishSetTimeRange(res);
            this._fetch_retry_attempts = 0;
        } catch (e) {
            // the month's events never arrived. Without a retry the grid keeps
            // the previous month's events and shows nothing for this one, and
            // no other path ever asks again.
            log(e);
            this._queue_fetch_retry();
        }
    }

    _cancel_fetch_retry() {
        if (this._fetch_retry_id > 0) {
            Mainloop.source_remove(this._fetch_retry_id);
            this._fetch_retry_id = 0;
        }
    }

    _queue_fetch_retry() {
        if (this._destroyed || this._fetch_retry_id > 0) {
            return;
        }

        // A retry chain that gives up says so, once. The month's events are
        // gone until something unrelated asks again, and the only trace used to
        // be the per-attempt failure lines — indistinguishable from an outage
        // that is still being retried.
        if (this._fetch_retry_attempts >= FETCH_RETRY_MAX_ATTEMPTS) {
            log("calendar events: giving up on this month after " +
                FETCH_RETRY_MAX_ATTEMPTS + " attempts; the grid will not " +
                "refresh until the calendar server or the month changes");
            return;
        }

        const delay = ProviderUtils.backoffDelay(this._fetch_retry_attempts, {
            base: FETCH_RETRY_SECONDS,
            cap: FETCH_RETRY_MAX_SECONDS,
            random: this._random
        });
        this._fetch_retry_attempts++;

        this._fetch_retry_id = Mainloop.timeout_add_seconds(delay, () => {
            this._fetch_retry_id = 0;

            const month_year = this._window_coordinator.current_month_year;
            if (this._destroyed || !month_year) {
                return GLib.SOURCE_REMOVE;
            }

            // Every other caller reaches fetch_month_events through is_active(),
            // which is what proves there is a calendar server to call. This one
            // did not: if EDS died while the retry was queued, the proxy is null
            // and call_set_time_range throws inside a GLib callback — and the
            // retry id is already cleared, so the chain dies there, silently.
            //
            // Re-queueing here used to burn an attempt for a fetch that was
            // never made. Restart evolution-data-server with the menu open and
            // the five-attempt budget was spent in 155 seconds without a single
            // request leaving the applet — the chain then died, nothing logged
            // it, and the grid kept showing the previous month's events.
            //
            // There is nothing to poll for. Every route back to life —
            // the EDS name reappearing, a status change, the user switching
            // events back on — ends in a forced fetch of its own, so the right
            // move is to stand down with a full budget for whoever gets there.
            if (!this.is_active()) {
                this._fetch_retry_attempts = 0;
                return GLib.SOURCE_REMOVE;
            }

            this.fetch_month_events(month_year, true);

            return GLib.SOURCE_REMOVE;
        });
    }

    _cancel_reload_today() {
        if (this._reload_today_id > 0) {
            Mainloop.source_remove(this._reload_today_id);
            this._reload_today_id = 0;
        }
    }

    destroy() {
        // before the proxy is dropped: an in-flight call whose reply lands
        // after this would dereference it
        if (this._fetch_cancellable) {
            this._fetch_cancellable.cancel();
        }

        for (const id of this._event_batch_ids) {
            Mainloop.source_remove(id);
        }
        this._event_batch_ids = [];

        this._server_connection.destroy();
        this._stop_gc_timer();
        this._cancel_reload_today();
        this._cancel_fetch_retry();

        // A month of EventData, four GLib.DateTime each, and the applet that owns
        // this outlives its removal from the panel — Cinnamon's Applet has no
        // destroy(), and AppletContextMenu holds the actor, which holds _delegate.
        // Releasing the timers and the signals but keeping the data is how ten
        // add/remove cycles retained 38 MiB.
        this._event_index.clear();

        this._destroyed = true;
    }

    queue_reload_today(force) {
        this._cancel_reload_today();

        if (force) {
            this._force_reload_pending = true;
        }

        this._reload_today_id = Mainloop.idle_add(this._idle_do_reload_today.bind(this));
    }

    _idle_do_reload_today() {
        this._reload_today_id = 0;

        this.select_date(new Date(), this._force_reload_pending);
        this._force_reload_pending = false;

        return GLib.SOURCE_REMOVE;
    }

    select_date(date, force) {
        this._window_coordinator.selectDate(
            date,
            force,
            () => this.is_active(),
            (month_year, fetchForce) => this.fetch_month_events(month_year, fetchForce),
            (name, ...args) => this.emit(name, ...args)
        );
    }

    get_colors_for_unix_key(dateUnixKey) {
        return this._event_index.getColorsByUnixKey(dateUnixKey);
    }

    is_active() {
        return this._server_connection.isActive(this.settings.showEvents);
    }
};



function createEventsManager(settings, params = {}) {
    const random = params.random || Math.random;
    const eventIndex = params.eventIndex || new EventIndex();
    const windowCoordinator = params.windowCoordinator ||
        new EventWindowCoordinator(eventIndex);
    let manager = null;
    const serverConnection = params.serverConnection || new CalendarServerConnection({
        onReady: () => manager.emit("events-manager-ready"),
        onAddedOrUpdated: (...args) => manager._handle_added_or_updated_events(...args),
        onRemoved: (...args) => manager._handle_removed_events(...args),
        onClientDisappeared: (...args) => manager._handle_client_disappeared(...args),
        onStatusChanged: () => manager._handle_status_changed()
    }, { random });

    manager = new EventsManager(settings, {
        serverConnection,
        eventIndex,
        windowCoordinator,
        random
    });
    return manager;
}

Signals.addSignalMethods(EventsManager.prototype);

if (typeof module !== "undefined") {
    module.exports = { EventsManager, createEventsManager, CalendarServerConnection,
        EventIndex, EventWindowCoordinator, SERVER_RETRY_SECONDS,
        SERVER_RETRY_MAX_SECONDS, FETCH_RETRY_SECONDS, FETCH_RETRY_MAX_SECONDS,
        FETCH_RETRY_MAX_ATTEMPTS, EDS_BUS_NAME };
}
