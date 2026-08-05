// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports */

// Cinnamon/DBus adapter for the calendar-server port. Event indexing and
// selection policy live outside this module.
const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const Gio = GjsImports.gi.Gio;
const GLib = GjsImports.gi.GLib;
const Cinnamon = GjsImports.gi.Cinnamon;
const Mainloop = GjsImports.mainloop;
const APPLET_MODULES = IS_NODE ?
    null : GjsImports.ui.appletManager.applets["chronos@geraldo-netto"];
const ProviderUtils = APPLET_MODULES ? APPLET_MODULES.providerUtils : require("./providerUtils");

const UUID = "chronos@geraldo-netto";
const STATUS_UNKNOWN = 0;
const STATUS_NO_CALENDARS = 1;

var EDS_BUS_NAME = "org.gnome.evolution.dataserver.Calendar8"; // NOSONAR [S3504] -- GJS importer export
var SERVER_RETRY_SECONDS = 5; // NOSONAR [S3504] -- GJS importer export
var SERVER_RETRY_MAX_SECONDS = 300; // NOSONAR [S3504] -- GJS importer export

var CalendarServerConnection = class CalendarServerConnection { // NOSONAR [S3504] -- GJS importer export
    constructor(callbacks, params = {}) {
        this.callbacks = callbacks;
        this._bus_watch_id = 0;
        this._calendar_server = null;
        this._calendar_server_signal_ids = [];
        this._proxy_cancellable = null;
        this._server_retry_id = 0;
        this._server_retry_attempts = 0;
        this._cached_state = STATUS_UNKNOWN;
        this._inited = false;
        this._destroyed = false;
        this._random = params.random || Math.random;
    }

    start() {
        if (this._destroyed || this._bus_watch_id > 0 || this._proxy_cancellable !== null) {
            return;
        }

        this.cancelRetry();
        this._bus_watch_id = Gio.bus_watch_name(Gio.BusType.SESSION,
                                                EDS_BUS_NAME,
                                                Gio.BusNameWatcherFlags.NONE,
                                                this.eds_service_found.bind(this),
                                                null);
    }

    eds_service_found(connection, name, name_owner) {
        Gio.bus_unwatch_name(this._bus_watch_id);
        this._bus_watch_id = 0;

        if (this._calendar_server == null) {
            log(UUID + ": Calendar events supported.");

            this._proxy_cancellable = new Gio.Cancellable();
            try {
                Cinnamon.CalendarServerProxy.new_for_bus(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION,
                    "org.cinnamon.CalendarServer",
                    "/org/cinnamon/CalendarServer",
                    this._proxy_cancellable,
                    this._calendar_server_ready.bind(this)
                );
            } catch (e) {
                this._proxy_cancellable = null;
                log("could not start calendar server connection: " + e);
                this.queueRetry();
            }
        }
    }

    _calendar_server_ready(obj, res) {
        try {
            // Gio requires every async result to be finished, including one
            // whose cancellable was cancelled during teardown. Keep the new
            // proxy local until the connection is still allowed to own it.
            const calendarServer = Cinnamon.CalendarServerProxy.new_for_bus_finish(res);
            this._proxy_cancellable = null;
            if (this._destroyed) {
                return;
            }
            this._calendar_server = calendarServer;

            this._calendar_server_signal_ids.push(this._calendar_server.connect(
                "events-added-or-updated", this.callbacks.onAddedOrUpdated));
            this._calendar_server_signal_ids.push(this._calendar_server.connect( // NOSONAR [S7778] -- accepted compatible form
                "events-removed", this.callbacks.onRemoved));
            this._calendar_server_signal_ids.push(this._calendar_server.connect( // NOSONAR [S7778] -- accepted compatible form
                "client-disappeared", this.callbacks.onClientDisappeared));
            this._calendar_server_signal_ids.push(this._calendar_server.connect( // NOSONAR [S7778] -- accepted compatible form
                "notify::status", this._handle_status_notify.bind(this)));

            this._inited = true;
            this._server_retry_attempts = 0;
            this.callbacks.onReady();
        } catch (e) {
            this._proxy_cancellable = null;
            // Cancellation is expected after destroy. The result was drained
            // above; a removed applet must neither log nor arm a retry.
            if (this._destroyed) {
                return;
            }
            log("could not connect to calendar server process: " + e);
            this._disconnectServer();
            this._calendar_server = null;
            this._inited = false;
            this.queueRetry();
        }
    }

    cancelRetry() {
        if (this._server_retry_id > 0) {
            Mainloop.source_remove(this._server_retry_id);
            this._server_retry_id = 0;
        }
    }

    retryDelay() {
        return ProviderUtils.backoffDelay(this._server_retry_attempts, {
            base: SERVER_RETRY_SECONDS,
            cap: SERVER_RETRY_MAX_SECONDS,
            random: this._random
        });
    }

    queueRetry() {
        if (this._destroyed) {
            return;
        }

        this.cancelRetry();
        const delay = this.retryDelay();
        this._server_retry_attempts = Math.min(this._server_retry_attempts + 1, 8);
        this._server_retry_id = Mainloop.timeout_add_seconds(delay, () => {
            this._server_retry_id = 0;
            this.start();
            return GLib.SOURCE_REMOVE;
        });
    }

    _handle_status_notify() {
        if (this._calendar_server.status === this._cached_state ||
            this._calendar_server.status === STATUS_UNKNOWN) {
            return;
        }

        this._cached_state = this._calendar_server.status;
        this.callbacks.onStatusChanged();
    }

    _disconnectServer() {
        if (this._calendar_server !== null) {
            for (let id of this._calendar_server_signal_ids) {
                this._calendar_server.disconnect(id);
            }
        }
        this._calendar_server_signal_ids = [];
    }

    destroy() {
        if (this._bus_watch_id > 0) {
            Gio.bus_unwatch_name(this._bus_watch_id);
            this._bus_watch_id = 0;
        }

        this.cancelRetry();
        if (this._proxy_cancellable !== null) {
            const cancellable = this._proxy_cancellable;
            this._proxy_cancellable = null;
            cancellable.cancel();
        }
        this._disconnectServer();
        this._calendar_server = null;
        this._inited = false;
        this._destroyed = true;
    }

    setTimeRange(start, end, force, cancellable, callFinished) {
        if (this._calendar_server === null) {
            return;
        }
        this._calendar_server.call_set_time_range(start, end, force, cancellable, callFinished);
    }

    finishSetTimeRange(server, res) {
        // Finish on the proxy that produced the result, not whichever proxy is
        // current now. A reconnect can replace _calendar_server while an older
        // D-Bus call is still completing, and Gio requires every result to be
        // finished by its originating object.
        if (!server || typeof server.call_set_time_range_finish !== "function") {
            throw new Error("calendar server callback proxy is gone");
        }
        server.call_set_time_range_finish(res);
    }

    isActive(showEvents) {
        return this._inited && showEvents && this._calendar_server !== null &&
            this._calendar_server.status !== STATUS_NO_CALENDARS;
    }
};

if (typeof module !== "undefined") {
    module.exports = { CalendarServerConnection, SERVER_RETRY_SECONDS,
        SERVER_RETRY_MAX_SECONDS, EDS_BUS_NAME };
}
