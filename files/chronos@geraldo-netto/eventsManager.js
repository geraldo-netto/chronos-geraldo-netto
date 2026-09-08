// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports */
/* eslint camelcase: "off" */

// Signal-facing facade for calendar events. The connection owns DBus, the
// mutation stream owns ordered payload application, the fetch coordinator owns
// range/retry/reconciliation state, and the index/window collaborators own data.
const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const Signals = GjsImports.signals;
const APPLET_MODULES = IS_NODE ?
    null : GjsImports.ui.appletManager.applets["chronos@geraldo-netto"];
const CalendarServerModule = IS_NODE ?
    require("./calendarServerConnection") :
    APPLET_MODULES.calendarServerConnection;
const EventIndexModule = IS_NODE ?
    require("./eventIndex") :
    APPLET_MODULES.eventIndex;
const EventWindowModule = IS_NODE ?
    require("./eventWindow") :
    APPLET_MODULES.eventWindow;
const EventMutationStreamModule = IS_NODE ?
    require("./eventMutationStream") :
    APPLET_MODULES.eventMutationStream;
const EventFetchCoordinatorModule = IS_NODE ?
    require("./eventFetchCoordinator") :
    APPLET_MODULES.eventFetchCoordinator;

const CalendarServerConnection = CalendarServerModule.CalendarServerConnection;
const EventIndex = EventIndexModule.EventIndex;
const EventWindowCoordinator = EventWindowModule.EventWindowCoordinator;
const EventMutationStream = EventMutationStreamModule.EventMutationStream;
const EventFetchCoordinator = EventFetchCoordinatorModule.EventFetchCoordinator;

var EDS_BUS_NAME = CalendarServerModule.EDS_BUS_NAME; // NOSONAR [S3504] -- GJS importer export
var SERVER_RETRY_SECONDS = CalendarServerModule.SERVER_RETRY_SECONDS; // NOSONAR [S3504] -- GJS importer export
var SERVER_RETRY_MAX_SECONDS = CalendarServerModule.SERVER_RETRY_MAX_SECONDS; // NOSONAR [S3504] -- GJS importer export
var FETCH_RETRY_SECONDS = EventFetchCoordinatorModule.FETCH_RETRY_SECONDS; // NOSONAR [S3504] -- GJS importer export
var FETCH_RETRY_MAX_SECONDS = EventFetchCoordinatorModule.FETCH_RETRY_MAX_SECONDS; // NOSONAR [S3504] -- GJS importer export
var FETCH_RETRY_MAX_ATTEMPTS = EventFetchCoordinatorModule.FETCH_RETRY_MAX_ATTEMPTS; // NOSONAR [S3504] -- GJS importer export
var MAX_QUEUED_EVENT_RECORDS = EventMutationStreamModule.MAX_QUEUED_EVENT_RECORDS; // NOSONAR [S3504] -- GJS importer export
var MAX_QUEUED_EVENT_BYTES = EventMutationStreamModule.MAX_QUEUED_EVENT_BYTES; // NOSONAR [S3504] -- GJS importer export
var MAX_QUEUED_EVENT_MUTATIONS = EventMutationStreamModule.MAX_QUEUED_EVENT_MUTATIONS; // NOSONAR [S3504] -- GJS importer export
var MAX_EVENT_SIGNAL_BYTES = CalendarServerModule.MAX_EVENT_SIGNAL_BYTES; // NOSONAR [S3504] -- GJS importer export
var boundedEventVariants = CalendarServerModule.boundedEventVariants; // NOSONAR [S3504] -- GJS importer export

var EventsManager = class EventsManager { // NOSONAR [S3504] -- GJS importer export
    constructor(settings, params = {}) {
        if (!params.serverConnection || !params.eventIndex || !params.windowCoordinator) {
            throw new Error("EventsManager requires its connection, index, and window collaborators");
        }

        this.settings = settings;
        this._server_connection = params.serverConnection;
        this._event_index = params.eventIndex;
        this._window_coordinator = params.windowCoordinator;

        this._mutation_stream = params.mutationStream || new EventMutationStream({
            eventIndex: this._event_index,
            currentSelectedDate: () => this.current_selected_date,
            currentWatermark: () => this.last_update_timestamp,
            onMutationApplied: () => this._fetch_coordinator.onMutationApplied(),
            onSelectedDateChanged: (delay) =>
                this._emit_selected_date_events_changed(delay),
            onEventsUpdated: () => this.emit("events-updated"),
            onEventIndexChanged: () => this._emit_event_index_changed(),
            onResync: (mutation) => this._fetch_coordinator.requestResync(mutation),
            onFetchComplete: (mutation) =>
                this._fetch_coordinator.onFetchComplete(mutation),
            onAmbiguousRemoval: () =>
                this._fetch_coordinator.reloadAfterAmbiguousRemoval(),
            onClientDisappeared: () => this.queue_reload_selected()
        });

        this._fetch_coordinator = params.fetchCoordinator || new EventFetchCoordinator({
            serverConnection: this._server_connection,
            eventIndex: this._event_index,
            windowCoordinator: this._window_coordinator,
            isActive: () => this.is_active(),
            enqueueMutation: (mutation) => this._enqueue_event_mutation(mutation),
            mutationsPending: () => this._mutation_stream.hasPendingMutations(),
            resetMutations: () => this._mutation_stream.reset(),
            emit: (name, ...args) => this.emit(name, ...args),
            emitEventIndexChanged: () => this._emit_event_index_changed(),
            random: params.random || Math.random
        });
    }

    get current_selected_date() {
        return this._window_coordinator.current_selected_date;
    }

    get last_update_timestamp() {
        return this._fetch_coordinator.lastUpdateTimestamp;
    }
    set last_update_timestamp(value) {
        this._fetch_coordinator.lastUpdateTimestamp = value;
    }

    start_events() {
        this._server_connection.start();
    }

    _handle_added_or_updated_events(server, varray) {
        if (!this.is_active()) {
            return;
        }
        this._mutation_stream.handleAddedOrUpdated(
            varray, this.last_update_timestamp);
    }

    _handle_removed_events(server, uidsString) {
        if (!this.is_active()) {
            return;
        }
        this._mutation_stream.handleRemoved(uidsString);
    }

    _handle_client_disappeared(server, uid) {
        if (!this.is_active()) {
            return;
        }
        this._mutation_stream.handleClientDisappeared();
    }

    _handle_status_changed() {
        if (!this.is_active()) {
            this._quiesce_event_pipeline();
        }
        this._fetch_coordinator.handleStatusChanged();
    }

    _quiesce_event_pipeline() {
        try {
            this._fetch_coordinator.quiesce();
        } finally {
            this._mutation_stream.reset();
            this._event_index.discard();
        }
    }

    // Named for the half it implements. It was `set_enabled(enabled)`, which
    // promises both halves of the transition and delivers one: the enable path
    // did nothing at all, and `AppletEventListCoordinator.apply` compensated
    // with a forced `select_date` the manager appeared to have made
    // unnecessary. The enable half stays with the coordinator because the date
    // to re-select is the calendar's selection, which this class does not own -
    // its own `current_selected_date` is the last window it fetched, not the
    // day the user is looking at.
    disableIfOff(enabled) {
        if (!enabled) {
            this._quiesce_event_pipeline();
        }
    }

    _emit_selected_date_events_changed(delayNoEventsBox) {
        this.emit("selected-date-events-changed",
            this._event_index.get(this.current_selected_date),
            delayNoEventsBox,
            Boolean(this._event_index.overflowed));
    }

    _emit_event_index_changed() {
        this._emit_selected_date_events_changed(false);
        this.emit("events-updated");
    }

    _enqueue_event_mutation(mutation) {
        this._mutation_stream.enqueue(mutation);
    }

    fetch_month_events(monthYear, force, retry = false) {
        this._fetch_coordinator.fetchMonthEvents(monthYear, force, retry);
    }

    queue_reload_selected() {
        this._fetch_coordinator.queueReloadSelected();
    }

    refresh_for_timezone_change() {
        this._fetch_coordinator.refreshForTimezoneChange();
    }

    select_date(date, force) {
        this._fetch_coordinator.selectDate(date, force);
    }

    get_colors_for_unix_key(dateUnixKey) {
        return this._event_index.getColorsByUnixKey(dateUnixKey);
    }

    is_active() {
        return this._server_connection.isActive(this.settings.showEvents);
    }

    destroy() {
        this._fetch_coordinator.destroy();
        this._mutation_stream.destroy();
        this._server_connection.destroy();
        this._event_index.discard();
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
        mutationStream: params.mutationStream,
        fetchCoordinator: params.fetchCoordinator,
        random
    });
    return manager;
}

Signals.addSignalMethods(EventsManager.prototype);

if (typeof module !== "undefined") {
    module.exports = { EventsManager, createEventsManager, CalendarServerConnection,
        EventIndex, EventWindowCoordinator, EventMutationStream,
        EventFetchCoordinator, SERVER_RETRY_SECONDS, SERVER_RETRY_MAX_SECONDS,
        FETCH_RETRY_SECONDS, FETCH_RETRY_MAX_SECONDS, FETCH_RETRY_MAX_ATTEMPTS,
        EDS_BUS_NAME, MAX_EVENT_SIGNAL_BYTES, MAX_QUEUED_EVENT_RECORDS,
        MAX_QUEUED_EVENT_BYTES, MAX_QUEUED_EVENT_MUTATIONS,
        boundedEventVariants };
}
