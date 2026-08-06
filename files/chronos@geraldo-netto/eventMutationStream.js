// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports */
/* eslint camelcase: "off" */

// Owns the ordered stream of calendar-server mutations. It bounds retained
// wire payloads, spreads large additions across idles, preserves signal order,
// and coalesces presentation notifications. Fetch/retry policy reaches it only
// through the explicit resync and fetch-complete callbacks below.
const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const GLib = GjsImports.gi.GLib;
const Mainloop = GjsImports.mainloop;
const APPLET_MODULES = IS_NODE ?
    null : GjsImports.ui.appletManager.applets["chronos@geraldo-netto"];
const CalendarServerModule = IS_NODE ?
    require("./calendarServerConnection") :
    APPLET_MODULES.calendarServerConnection;
const EventDataModule = IS_NODE ?
    require("./eventData") :
    APPLET_MODULES.eventData;

const boundedEventVariants = CalendarServerModule.boundedEventVariants;
const decodeRemovedUids = CalendarServerModule.decodeRemovedUids;

var EVENT_BATCH_CHUNK = 25; // NOSONAR [S3504] -- GJS importer export
var MAX_QUEUED_EVENT_RECORDS = 2000; // NOSONAR [S3504] -- GJS importer export
var MAX_QUEUED_EVENT_BYTES = 8 * 1024 * 1024; // NOSONAR [S3504] -- GJS importer export
var MAX_QUEUED_EVENT_MUTATIONS = 256; // NOSONAR [S3504] -- GJS importer export

var EventMutationStream = class EventMutationStream { // NOSONAR [S3504] -- GJS importer export
    constructor(params) {
        this._eventIndex = params.eventIndex;
        this._currentSelectedDate = params.currentSelectedDate;
        this._currentWatermark = params.currentWatermark;
        this._onMutationApplied = params.onMutationApplied;
        this._onSelectedDateChanged = params.onSelectedDateChanged;
        this._onEventsUpdated = params.onEventsUpdated;
        this._onEventIndexChanged = params.onEventIndexChanged;
        this._onResync = params.onResync;
        this._onFetchComplete = params.onFetchComplete;
        this._onAmbiguousRemoval = params.onAmbiguousRemoval;
        this._onClientDisappeared = params.onClientDisappeared;

        this._destroyed = false;
        this._eventMutations = [];
        this._eventBatchIds = [];
        this._queuedEventRecords = 0;
        this._queuedEventBytes = 0;
        this._overflowMutationQueued = false;
        this._resyncMutationQueued = false;
        this._pendingEmit = null;
        this._emitIdleId = 0;
    }

    get destroyed() { return this._destroyed; }
    set destroyed(value) { this._destroyed = Boolean(value); }
    get mutations() { return this._eventMutations; }
    get batchIds() { return this._eventBatchIds; }
    set batchIds(value) { this._eventBatchIds = value; }
    get queuedRecords() { return this._queuedEventRecords; }
    get queuedBytes() { return this._queuedEventBytes; }
    get resyncQueued() { return this._resyncMutationQueued; }
    set resyncQueued(value) { this._resyncMutationQueued = Boolean(value); }
    get pendingEmit() { return this._pendingEmit; }
    set pendingEmit(value) { this._pendingEmit = value; }
    get emitIdleId() { return this._emitIdleId; }

    hasPendingMutations() {
        return this._eventMutations.length > 0;
    }

    handleAddedOrUpdated(varray, watermark) {
        if (this._resyncMutationQueued) {
            return;
        }

        const available = Math.max(
            0, MAX_QUEUED_EVENT_RECORDS - this._queuedEventRecords);
        const availableBytes = Math.max(
            0, MAX_QUEUED_EVENT_BYTES - this._queuedEventBytes);
        let decoded;
        try {
            decoded = boundedEventVariants(varray, available, availableBytes);
        } catch (error) {
            if (global.logError) {
                global.logError(error);
            }
            decoded = { events: [], overflowed: true, retainedBytes: 0 };
        }

        if (decoded.events.length > 0) {
            this.enqueue({
                type: "add",
                events: decoded.events,
                index: 0,
                watermark,
                overflowed: decoded.overflowed,
                retainedBytes: decoded.retainedBytes
            });
        } else if (decoded.overflowed) {
            this.enqueue({ type: "overflow" });
        }
    }

    handleRemoved(uidsString) {
        this.enqueue({
            type: "remove",
            uids: decodeRemovedUids(
                uidsString, EventDataModule.MAX_EVENT_UID_LENGTH)
        });
    }

    handleClientDisappeared() {
        this.enqueue({ type: "client-disappeared" });
    }

    enqueue(mutation) {
        if (this._destroyed || this._resyncMutationQueued) {
            return;
        }

        if (this._eventMutations.length >= MAX_QUEUED_EVENT_MUTATIONS) {
            this._collapseToResync();
            return;
        }

        if (mutation.type === "add") {
            this._queuedEventRecords += mutation.events.length - mutation.index;
            this._queuedEventBytes += mutation.retainedBytes;
        } else if (mutation.type === "overflow") {
            if (this._overflowMutationQueued) {
                return;
            }
            this._overflowMutationQueued = true;
        }
        this._eventMutations.push(mutation);
        if (this._eventMutations.length === 1 &&
            this._eventBatchIds.length === 0) {
            this.applyNext();
        }
    }

    _recountPayload() {
        this._queuedEventRecords = 0;
        this._queuedEventBytes = 0;
        for (const mutation of this._eventMutations) {
            if (mutation.type === "add") {
                this._queuedEventRecords += mutation.events.filter(Boolean).length;
                this._queuedEventBytes += mutation.retainedBytes;
            }
        }
    }

    _collapseToResync() {
        const current = this._eventMutations[0];
        this._eventMutations = current ?
            [current, { type: "resync" }] : [{ type: "resync" }];
        this._overflowMutationQueued =
            Boolean(current && current.type === "overflow");
        this._resyncMutationQueued = true;
        this._recountPayload();
    }

    _applyAdd(mutation) {
        const start = mutation.index;
        const end = Math.min(start + EVENT_BATCH_CHUNK, mutation.events.length);
        const last = end >= mutation.events.length;
        this._applyAddedOrUpdated(
            mutation.events.slice(start, end), mutation.watermark,
            last, mutation.overflowed);
        for (let index = start; index < end; index++) {
            mutation.events[index] = null;
        }
        this._queuedEventRecords -= end - start;
        mutation.index = end;
        if (last) {
            this._queuedEventBytes -= mutation.retainedBytes;
        }
        return last;
    }

    _applyMutation(mutation) {
        if (mutation.type === "add") {
            return this._applyAdd(mutation);
        }

        this.flushPendingEmit();
        if (mutation.type === "remove") {
            this._applyRemoved(mutation.uids);
        } else if (mutation.type === "overflow") {
            this.applyOverflow();
        } else if (mutation.type === "resync") {
            this.applyResync(mutation);
        } else if (mutation.type === "fetch-complete") {
            this._onFetchComplete(mutation);
        } else {
            this._applyClientDisappeared();
        }
        return true;
    }

    applyNext() {
        const mutation = this._eventMutations[0];
        if (!mutation || this._destroyed) {
            return;
        }

        let complete;
        try {
            complete = this._applyMutation(mutation);
        } catch (error) {
            this._recoverFailure(mutation);
            throw error;
        }

        if (complete) {
            if (mutation.type === "overflow") {
                this._overflowMutationQueued = false;
            } else if (mutation.type === "resync") {
                this._resyncMutationQueued = false;
            }
            this._eventMutations.shift();
        }

        if (this._eventMutations.length > 0) {
            this.schedule();
        }
    }

    _recoverFailure(mutation, schedule = true) {
        const needsResync = mutation.type !== "resync" ||
            !mutation.recoverySecured;
        this._eventMutations = needsResync ? [{ type: "resync" }] : [];
        this._queuedEventRecords = 0;
        this._queuedEventBytes = 0;
        this._overflowMutationQueued = false;
        this._resyncMutationQueued = needsResync;
        this._pendingEmit = null;
        if (needsResync && schedule) {
            this.schedule();
        }
    }

    schedule() {
        if (this._destroyed || this._eventBatchIds.length > 0) {
            return;
        }

        let sourceId;
        try {
            sourceId = Mainloop.idle_add(() => {
                this._eventBatchIds.shift();
                if (this._destroyed) {
                    this._clearQueue();
                    this.cancelPendingEmit();
                } else {
                    this.applyNext();
                }
                return GLib.SOURCE_REMOVE;
            });
            if (!(sourceId > 0)) {
                throw new Error("calendar events could not register a mutation idle");
            }
        } catch (error) {
            global.logError(error);
            const mutation = this._eventMutations[0];
            if (mutation) {
                this._recoverFailure(mutation, false);
                this.applyNext();
            }
            return;
        }
        this._eventBatchIds.push(sourceId);
    }

    _markOverflow() {
        const changed = this._eventIndex.markOverflow();
        if (changed) {
            log("calendar events: safety limit reached; some events are hidden");
        }
        return changed;
    }

    applyOverflow() {
        if (this._markOverflow()) {
            this._onEventIndexChanged();
        }
    }

    applyResync(mutation = {}) {
        this._eventIndex.discard();
        this._markOverflow();
        // The fetch collaborator must make the replacement independently
        // runnable before a presentation listener is allowed to fail.
        this._onResync(mutation);
        this._onEventIndexChanged();
    }

    _accumulateOverflow(pending, result, flush, inputOverflowed) {
        if (result.overflow_changed) {
            log("calendar events: safety limit reached; some events are hidden");
            pending.overflow_changed = true;
        }
        if (flush && inputOverflowed && this._markOverflow()) {
            pending.overflow_changed = true;
        }
    }

    _applyAddedOrUpdated(events, watermark, flush, inputOverflowed = false) {
        const result = this._eventIndex.addOrUpdate(
            events, watermark, this._currentSelectedDate());
        const pending = this._pendingEmit || {
            selected_date_changed: false,
            events_changed: false,
            overflow_changed: false
        };
        pending.selected_date_changed =
            pending.selected_date_changed || result.selected_date_changed;
        pending.events_changed = pending.events_changed || result.events_changed;
        this._accumulateOverflow(pending, result, flush, inputOverflowed);

        if (watermark === this._currentWatermark()) {
            this._onMutationApplied(watermark);
        }

        this._pendingEmit = pending;
        if (flush) {
            this.queuePendingEmit();
        }
    }

    queuePendingEmit() {
        if (this._destroyed || this._emitIdleId > 0) {
            return;
        }

        this._emitIdleId = Mainloop.idle_add(() => {
            this._emitIdleId = 0;
            this.flushPendingEmit();
            return GLib.SOURCE_REMOVE;
        });
    }

    flushPendingEmit() {
        this.cancelPendingEmit();
        const pending = this._pendingEmit;
        if (!pending) {
            return;
        }
        this._pendingEmit = null;

        if (pending.selected_date_changed || pending.overflow_changed) {
            this._onSelectedDateChanged(false);
        }
        if (pending.events_changed || pending.overflow_changed) {
            this._onEventsUpdated();
        }
    }

    cancelPendingEmit() {
        if (this._emitIdleId > 0) {
            Mainloop.source_remove(this._emitIdleId);
            this._emitIdleId = 0;
        }
    }

    _applyRemoved(uid) {
        const ambiguous = uid === null;
        if (!ambiguous && !this._eventIndex.hasEvent(uid)) {
            return;
        }

        if (ambiguous) {
            this._eventIndex.discard();
        } else {
            this._eventIndex.remove([uid]);
        }

        this._onSelectedDateChanged(false);
        if (ambiguous) {
            this._onAmbiguousRemoval();
        }
        this._onEventsUpdated();
    }

    _applyClientDisappeared() {
        this._eventIndex.discard();
        this._onEventIndexChanged();
        this._onClientDisappeared();
    }

    _clearQueue() {
        this._eventMutations = [];
        this._queuedEventRecords = 0;
        this._queuedEventBytes = 0;
        this._overflowMutationQueued = false;
        this._resyncMutationQueued = false;
        this._pendingEmit = null;
    }

    destroy() {
        for (const id of this._eventBatchIds) {
            Mainloop.source_remove(id);
        }
        this._eventBatchIds = [];
        this.cancelPendingEmit();
        this._clearQueue();
        this._destroyed = true;
    }
};

if (typeof module !== "undefined") {
    module.exports = { EventMutationStream, EVENT_BATCH_CHUNK,
        MAX_QUEUED_EVENT_RECORDS, MAX_QUEUED_EVENT_BYTES,
        MAX_QUEUED_EVENT_MUTATIONS };
}
