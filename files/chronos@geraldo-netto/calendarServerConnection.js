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

var MAX_EVENT_SIGNAL_BYTES = 4 * 1024 * 1024; // NOSONAR [S3504] -- GJS importer export

function validateEventVariantLimits(varray, recordLimit, byteLimit) {
    if (!varray || !Number.isInteger(recordLimit) || recordLimit < 0 ||
        !Number.isInteger(byteLimit) || byteLimit < 0) {
        throw new Error("calendar event array or limit is invalid");
    }
}

function eventVariantBytes(varray, byteLimit) {
    if (typeof varray.get_size !== "function") {
        return { retainedBytes: 0, overflowed: false };
    }

    const retainedBytes = varray.get_size();
    if (!Number.isFinite(retainedBytes) || retainedBytes < 0) {
        throw new Error("calendar event array has an invalid byte size");
    }
    return {
        retainedBytes,
        overflowed: retainedBytes > MAX_EVENT_SIGNAL_BYTES ||
            retainedBytes > byteLimit
    };
}

function boundedVariantChildren(varray, recordLimit, retainedBytes) {
    const count = varray.n_children();
    if (!Number.isInteger(count) || count < 0) {
        throw new Error("calendar event array has an invalid child count");
    }

    const accepted = Math.min(count, recordLimit);
    const events = [];
    for (let index = 0; index < accepted; index++) {
        events.push(varray.get_child_value(index));
    }
    return { events, overflowed: count > accepted, retainedBytes };
}

function boundedUnpackedEvents(varray, recordLimit, retainedBytes) {
    // Test doubles and older proxy wrappers expose only unpack(). The retained
    // prefix is still bounded even though those non-production adapters have
    // already materialized their array.
    if (typeof varray.unpack !== "function") {
        throw new Error("calendar event array cannot be unpacked");
    }
    const unpacked = varray.unpack();
    if (!Array.isArray(unpacked)) {
        throw new Error("calendar event payload is not an array");
    }
    return {
        events: unpacked.slice(0, recordLimit),
        overflowed: unpacked.length > recordLimit,
        retainedBytes
    };
}

function boundedEventVariants(varray, recordLimit, byteLimit = MAX_EVENT_SIGNAL_BYTES) {
    validateEventVariantLimits(varray, recordLimit, byteLimit);
    const bytes = eventVariantBytes(varray, byteLimit);
    if (bytes.overflowed) {
        return { events: [], overflowed: true, retainedBytes: 0 };
    }

    // Production receives a GLib.Variant. Inspect and copy only the prefix that
    // fits instead of unpacking an attacker-sized array in one compositor turn.
    if (typeof varray.n_children === "function" &&
        typeof varray.get_child_value === "function") {
        return boundedVariantChildren(
            varray, recordLimit, bytes.retainedBytes);
    }
    return boundedUnpackedEvents(varray, recordLimit, bytes.retainedBytes);
}

// cinnamon-calendar-server batches IDs with "::", but an iCalendar component UID
// is TEXT and may contain that exact sequence — so a string carrying the
// delimiter cannot be decoded losslessly to one UID. And the payload is
// unbounded TEXT off the wire, which would sit whole in the caller's queue:
// anything longer than one in-contract UID cannot name an indexed event either.
//
// Both cases answer null, which is the caller's signal to drop the window and
// ask the authoritative source again. A delimiter-free UID within the bound
// decodes to itself and keeps the fast targeted path.
function decodeRemovedUids(uids_string, maxUidLength) {
    if (typeof uids_string !== "string" || uids_string.length > maxUidLength) {
        return null;
    }
    return uids_string.indexOf("::") === -1 ? uids_string : null; // NOSONAR [S7765] -- accepted compatible form
}

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
        this._support_logged = false;
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
            // once per connection lifetime: reconnects after an owner loss go
            // through here again, and a session-long retry cadence must not
            // repeat a support statement that cannot have changed
            if (!this._support_logged) {
                this._support_logged = true;
                log(UUID + ": Calendar events supported.");
            }

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
            this._calendar_server_signal_ids.push(this._calendar_server.connect( // NOSONAR [S7778] -- accepted compatible form
                "notify::g-name-owner", this._handle_name_owner_notify.bind(this)));

            // No owner is the normal first-connection state, not a dead
            // server: org.cinnamon.CalendarServer is D-Bus activatable and
            // idle-exits without clients, and DO_NOT_AUTO_START_AT_CONSTRUCTION
            // only suppresses activation while the proxy is built — the first
            // call_set_time_range() is what starts the process. Treating "no
            // owner yet" as an owner loss dropped the proxy before anything
            // ever called it: events never worked and the reconnect loop spun
            // for the whole session. Losing an owner the proxy did have stays
            // an owner loss, and notify::g-name-owner handles it above.
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

    _handle_name_owner_notify(server) {
        if (server !== this._calendar_server || server.g_name_owner) {
            return;
        }

        this._disconnectServer();
        this._calendar_server = null;
        this._inited = false;
        this._cached_state = STATUS_UNKNOWN;
        this.callbacks.onStatusChanged();
        this.queueRetry();
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
        SERVER_RETRY_MAX_SECONDS, EDS_BUS_NAME, MAX_EVENT_SIGNAL_BYTES,
        boundedEventVariants, decodeRemovedUids };
}
