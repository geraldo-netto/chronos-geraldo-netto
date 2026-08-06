// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports */
/* eslint camelcase: "off" */

// Owns month-range dispatch, completion generations, retry/backoff, quiet-window
// reconciliation, and selected-window reloads. The mutation stream is an
// explicit port: successful fetches enqueue one ordered completion marker, and
// mutation-flood resyncs request one authoritative reload through this class.
const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const Gio = GjsImports.gi.Gio;
const GLib = GjsImports.gi.GLib;
const Mainloop = GjsImports.mainloop;
const APPLET_MODULES = IS_NODE ?
    null : GjsImports.ui.appletManager.applets["chronos@geraldo-netto"];
const ProviderUtils = IS_NODE ?
    require("./providerUtils") :
    APPLET_MODULES.providerUtils;

var FETCH_RETRY_SECONDS = 5; // NOSONAR [S3504] -- GJS importer export
var FETCH_RETRY_MAX_SECONDS = 120; // NOSONAR [S3504] -- GJS importer export
var FETCH_RETRY_MAX_ATTEMPTS = 5; // NOSONAR [S3504] -- GJS importer export

var EventFetchCoordinator = class EventFetchCoordinator { // NOSONAR [S3504] -- GJS importer export
    constructor(params) {
        this._serverConnection = params.serverConnection;
        this._eventIndex = params.eventIndex;
        this._windowCoordinator = params.windowCoordinator;
        this._isActive = params.isActive;
        this._enqueueMutation = params.enqueueMutation;
        this._mutationsPending = params.mutationsPending;
        this._emit = params.emit;
        this._emitEventIndexChanged = params.emitEventIndexChanged;
        this._random = params.random || Math.random;

        this._destroyed = false;
        this._lastUpdateTimestamp = 0;
        this._gcTimerId = 0;
        this._reloadSelectedId = 0;
        this._fetchRetryId = 0;
        this._fetchRetryAttempts = 0;
        this._refreshFailed = false;
        this._fetchGeneration = 0;
        this._resyncOverflowPending = false;
        this._fetchCancellable = new Gio.Cancellable();
    }

    get lastUpdateTimestamp() { return this._lastUpdateTimestamp; }
    set lastUpdateTimestamp(value) { this._lastUpdateTimestamp = value; }
    set destroyed(value) { this._destroyed = Boolean(value); }
    get gcTimerId() { return this._gcTimerId; }
    get reloadSelectedId() { return this._reloadSelectedId; }
    set reloadSelectedId(value) { this._reloadSelectedId = value; }
    get fetchRetryId() { return this._fetchRetryId; }
    get fetchRetryAttempts() { return this._fetchRetryAttempts; }
    get refreshFailed() { return this._refreshFailed; }
    set refreshFailed(value) { this._refreshFailed = Boolean(value); }
    get resyncOverflowPending() { return this._resyncOverflowPending; }
    set resyncOverflowPending(value) {
        this._resyncOverflowPending = Boolean(value);
    }

    stopGcTimer() {
        if (this._gcTimerId > 0) {
            Mainloop.source_remove(this._gcTimerId);
            this._gcTimerId = 0;
        }
    }

    startGcTimer() {
        this.stopGcTimer();
        if (!this._isActive()) {
            return;
        }

        this._gcTimerId = Mainloop.timeout_add_seconds(
            3, this._performGc.bind(this));
    }

    _performGc() {
        this._gcTimerId = 0;
        if (this._mutationsPending()) {
            this.startGcTimer();
            return GLib.SOURCE_REMOVE;
        }

        if (this._eventIndex.cull(this._lastUpdateTimestamp)) {
            this._emitEventIndexChanged();
        }
        return GLib.SOURCE_REMOVE;
    }

    onMutationApplied() {
        this.startGcTimer();
    }

    onFetchComplete(mutation) {
        if (mutation.generation === this._fetchGeneration) {
            this.startGcTimer();
        }
    }

    requestResync(mutation) {
        this._resyncOverflowPending = true;
        this.queueReloadSelected();
        mutation.recoverySecured = true;
    }

    reloadAfterAmbiguousRemoval() {
        const currentMonth = this._windowCoordinator.current_month_year;
        if (currentMonth) {
            this.fetchMonthEvents(currentMonth, true);
        } else {
            this.queueReloadSelected();
        }
    }

    handleStatusChanged() {
        if (!this._isActive()) {
            this._fetchGeneration++;
            this.cancelFetchRetry();
            this._fetchRetryAttempts = 0;
            this._setRefreshFailed(false);
        }
        this._emit("has-calendars-changed");
    }

    _setRefreshFailed(failed) {
        const next = Boolean(failed);
        if (next === this._refreshFailed) {
            return;
        }
        this._refreshFailed = next;
        this._emit("refresh-error-changed", next);
    }

    fetchMonthEvents(monthYear, force, retry = false) {
        const timestamp = this._windowCoordinator.fetchMonthEvents(
            monthYear,
            force,
            (start, end, forceReload, cancellable, watermark) => this._dispatch(
                retry, start, end, forceReload, cancellable, watermark),
            GLib.get_monotonic_time,
            this._fetchCancellable
        );

        if (timestamp !== null) {
            this._lastUpdateTimestamp = timestamp;
        }
    }

    _dispatch(retry, start, end, force, cancellable, watermark) {
        if (!retry) {
            this.cancelFetchRetry();
            this._fetchRetryAttempts = 0;
        }

        this.stopGcTimer();
        this._lastUpdateTimestamp = watermark;
        const generation = ++this._fetchGeneration;
        let callbackStarted = false;
        try {
            this._serverConnection.setTimeRange(
                start, end, force, cancellable,
                (server, result) => {
                    callbackStarted = true;
                    this.callFinished(generation, watermark, server, result);
                });
        } catch (error) {
            if (callbackStarted) {
                throw error;
            }
            this._settle(generation, watermark, error);
            return;
        }

        if (this._resyncOverflowPending) {
            this._resyncOverflowPending = false;
            this._eventIndex.clearOverflow();
        }
    }

    callFinished(generation, watermark, server, result) {
        let failure = null;
        try {
            this._serverConnection.finishSetTimeRange(server, result);
        } catch (error) {
            failure = error;
        }
        this._settle(generation, watermark, failure);
    }

    _settle(generation, watermark, failure) {
        if (this._destroyed || generation !== this._fetchGeneration) {
            return;
        }

        if (!failure) {
            this._fetchRetryAttempts = 0;
            // This is the explicit fetch → mutation-stream boundary. It keeps
            // reconciliation ordered behind any chunked delivery already queued.
            this._enqueueMutation({
                type: "fetch-complete",
                generation,
                watermark
            });
            this._setRefreshFailed(false);
        } else {
            log(failure);
            this.queueFetchRetry();
            this._setRefreshFailed(true);
        }
    }

    cancelFetchRetry() {
        if (this._fetchRetryId > 0) {
            Mainloop.source_remove(this._fetchRetryId);
            this._fetchRetryId = 0;
        }
    }

    queueFetchRetry() {
        if (this._destroyed || this._fetchRetryId > 0) {
            return;
        }

        if (this._fetchRetryAttempts >= FETCH_RETRY_MAX_ATTEMPTS) {
            log("calendar events: giving up on this month after " +
                FETCH_RETRY_MAX_ATTEMPTS + " attempts; the grid will not " +
                "refresh until the calendar server or the month changes");
            return;
        }

        const delay = ProviderUtils.backoffDelay(this._fetchRetryAttempts, {
            base: FETCH_RETRY_SECONDS,
            cap: FETCH_RETRY_MAX_SECONDS,
            random: this._random
        });
        this._fetchRetryAttempts++;

        this._fetchRetryId = Mainloop.timeout_add_seconds(delay, () => {
            this._fetchRetryId = 0;
            const monthYear = this._windowCoordinator.current_month_year;
            if (this._destroyed || !monthYear) {
                return GLib.SOURCE_REMOVE;
            }
            if (!this._isActive()) {
                this._fetchRetryAttempts = 0;
                return GLib.SOURCE_REMOVE;
            }

            this.fetchMonthEvents(monthYear, true, true);
            return GLib.SOURCE_REMOVE;
        });
    }

    cancelReloadSelected() {
        if (this._reloadSelectedId > 0) {
            Mainloop.source_remove(this._reloadSelectedId);
            this._reloadSelectedId = 0;
        }
    }

    queueReloadSelected() {
        this.cancelReloadSelected();
        try {
            const sourceId = Mainloop.idle_add(
                this.idleDoReloadSelected.bind(this));
            if (!(sourceId > 0)) {
                throw new Error("calendar events could not register a reload idle");
            }
            this._reloadSelectedId = sourceId;
        } catch (error) {
            global.logError(error);
            try {
                this.idleDoReloadSelected();
            } catch (reloadError) {
                global.logError(reloadError);
                this.retireStrandedResyncOverflow();
            }
        }
    }

    idleDoReloadSelected() {
        this._reloadSelectedId = 0;
        this._windowCoordinator.reloadSelected(
            this._isActive,
            (monthYear, force) => this.fetchMonthEvents(monthYear, force),
            this._emit);
        this.retireStrandedResyncOverflow();
        return GLib.SOURCE_REMOVE;
    }

    retireStrandedResyncOverflow() {
        if (!this._resyncOverflowPending) {
            return;
        }

        this._resyncOverflowPending = false;
        if (this._eventIndex.clearOverflow()) {
            this._emitEventIndexChanged();
        }
    }

    selectDate(date, force) {
        this._windowCoordinator.selectDate(
            date,
            force,
            this._isActive,
            (monthYear, fetchForce) => this.fetchMonthEvents(monthYear, fetchForce),
            this._emit
        );
    }

    refreshForTimezoneChange() {
        this._eventIndex.discard();
        this._windowCoordinator.renormalizeSelectedDate();
        this.queueReloadSelected();
    }

    destroy() {
        if (this._fetchCancellable) {
            this._fetchCancellable.cancel();
        }
        this.stopGcTimer();
        this.cancelReloadSelected();
        this.cancelFetchRetry();
        this._resyncOverflowPending = false;
        this._destroyed = true;
    }
};

if (typeof module !== "undefined") {
    module.exports = { EventFetchCoordinator, FETCH_RETRY_SECONDS,
        FETCH_RETRY_MAX_SECONDS, FETCH_RETRY_MAX_ATTEMPTS };
}
