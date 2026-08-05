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
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const Gio = GjsImports.gi.Gio;
const GLib = GjsImports.gi.GLib;
const Mainloop = GjsImports.mainloop;
const Signals = GjsImports.signals;
const APPLET_MODULES = IS_NODE ?
    null : GjsImports.ui.appletManager.applets["chronos@geraldo-netto"];
const ProviderUtils = APPLET_MODULES ? APPLET_MODULES.providerUtils : require("./providerUtils");
const CalendarServerModule = APPLET_MODULES ? APPLET_MODULES.calendarServerConnection : require("./calendarServerConnection");
const EventDataModule = APPLET_MODULES ? APPLET_MODULES.eventData : require("./eventData");
const EventIndexModule = APPLET_MODULES ? APPLET_MODULES.eventIndex : require("./eventIndex");
const EventWindowModule = APPLET_MODULES ? APPLET_MODULES.eventWindow : require("./eventWindow");

const CalendarServerConnection = CalendarServerModule.CalendarServerConnection;
const EventIndex = EventIndexModule.EventIndex;
const EventWindowCoordinator = EventWindowModule.EventWindowCoordinator;
var EDS_BUS_NAME = CalendarServerModule.EDS_BUS_NAME; // NOSONAR [S3504] -- GJS importer export
var SERVER_RETRY_SECONDS = CalendarServerModule.SERVER_RETRY_SECONDS; // NOSONAR [S3504] -- GJS importer export
var SERVER_RETRY_MAX_SECONDS = CalendarServerModule.SERVER_RETRY_MAX_SECONDS; // NOSONAR [S3504] -- GJS importer export

// A month fetch that fails takes the month's events with it; retry it a few
// times with backoff before giving up.
var FETCH_RETRY_SECONDS = 5; // NOSONAR [S3504] -- GJS importer export
var FETCH_RETRY_MAX_SECONDS = 120; // NOSONAR [S3504] -- GJS importer export
var FETCH_RETRY_MAX_ATTEMPTS = 5; // NOSONAR [S3504] -- GJS importer export
var EVENT_BATCH_CHUNK = 25; // NOSONAR [S3504] -- GJS importer export
// The DBus daemon has a much larger message ceiling. Chronos needs a lower
// product limit because this payload lands inside the desktop compositor.
var MAX_EVENT_SIGNAL_BYTES = 4 * 1024 * 1024; // NOSONAR [S3504] -- GJS importer export
var MAX_QUEUED_EVENT_RECORDS = 2000; // NOSONAR [S3504] -- GJS importer export
var MAX_QUEUED_EVENT_BYTES = 8 * 1024 * 1024; // NOSONAR [S3504] -- GJS importer export
var MAX_QUEUED_EVENT_MUTATIONS = 256; // NOSONAR [S3504] -- GJS importer export

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

var EventsManager = class EventsManager { // NOSONAR [S3504] -- GJS importer export
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

        this._reload_selected_id = 0;

        this._fetch_retry_id = 0;
        this._fetch_retry_attempts = 0;
        this._refresh_failed = false;
        this._fetch_generation = 0;
        // Calendar-server signals are one ordered mutation stream. A large
        // add/update occupies several idle turns, so later updates, removals
        // and client disappearance must wait behind its tail.
        this._event_mutations = [];
        // At most one idle advances that stream.
        this._event_batch_ids = [];
        this._queued_event_records = 0;
        this._queued_event_bytes = 0;
        this._overflow_mutation_queued = false;
        this._resync_mutation_queued = false;
        this._pending_emit = null;
        // A mutation-flood resync uses overflow as a temporary warning until
        // its authoritative replacement request has actually been dispatched.
        // Payload limits reached after that boundary are independent warnings.
        this._resync_overflow_pending = false;
        // handed to every call_set_time_range so a reply that is still in
        // flight when the applet goes away is cancelled rather than delivered
        // to a torn-down manager
        this._fetch_cancellable = new Gio.Cancellable();

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
        this._gc_timer_id = 0;
        // A large authoritative delivery spans several idle turns. Culling in
        // its middle mistakes the unprocessed tail for deleted events.
        if (this._event_mutations.length > 0) {
            this._start_gc_timer();
            return GLib.SOURCE_REMOVE;
        }

        let any_removed = this._event_index.cull(this.last_update_timestamp);

        if (any_removed) {
            this._emit_event_index_changed();
        }

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
        if (this._resync_mutation_queued) {
            return;
        }

        const available = Math.max(
            0, MAX_QUEUED_EVENT_RECORDS - this._queued_event_records);
        const availableBytes = Math.max(
            0, MAX_QUEUED_EVENT_BYTES - this._queued_event_bytes);
        let decoded;
        try {
            decoded = boundedEventVariants(varray, available, availableBytes);
        } catch (e) {
            if (global.logError) {
                global.logError(e);
            }
            decoded = { events: [], overflowed: true, retainedBytes: 0 };
        }

        if (decoded.events.length > 0) {
            this._enqueue_event_mutation({
                type: "add",
                events: decoded.events,
                index: 0,
                watermark: this.last_update_timestamp,
                overflowed: decoded.overflowed,
                retainedBytes: decoded.retainedBytes
            });
        } else if (decoded.overflowed) {
            this._enqueue_event_mutation({ type: "overflow" });
        }
    }

    _enqueue_event_mutation(mutation) {
        if (this._destroyed || this._resync_mutation_queued) {
            return;
        }

        if (this._event_mutations.length >= MAX_QUEUED_EVENT_MUTATIONS) {
            this._collapse_event_mutations_to_resync();
            return;
        }

        if (mutation.type === "add") {
            this._queued_event_records += mutation.events.length - mutation.index;
            this._queued_event_bytes += mutation.retainedBytes;
        } else if (mutation.type === "overflow") {
            if (this._overflow_mutation_queued) {
                return;
            }
            this._overflow_mutation_queued = true;
        }
        this._event_mutations.push(mutation);
        if (this._event_mutations.length === 1 &&
            this._event_batch_ids.length === 0) {
            this._apply_next_event_mutation();
        }
    }

    _recount_queued_event_payload() {
        this._queued_event_records = 0;
        this._queued_event_bytes = 0;
        for (const mutation of this._event_mutations) {
            if (mutation.type === "add") {
                this._queued_event_records += mutation.events.filter(Boolean).length;
                this._queued_event_bytes += mutation.retainedBytes;
            }
        }
    }

    _collapse_event_mutations_to_resync() {
        // Keep only the mutation already being applied. Everything behind it
        // can be replaced by one authoritative reload, releasing all retained
        // variants and preserving eventual server state.
        const current = this._event_mutations[0];
        this._event_mutations = current ?
            [current, { type: "resync" }] : [{ type: "resync" }];
        this._overflow_mutation_queued =
            Boolean(current && current.type === "overflow");
        this._resync_mutation_queued = true;
        this._recount_queued_event_payload();
    }

    _apply_add_mutation(mutation) {
        const start = mutation.index;
        const end = Math.min(
            start + EVENT_BATCH_CHUNK, mutation.events.length);
        const last = end >= mutation.events.length;
        this._apply_added_or_updated(
            mutation.events.slice(start, end), mutation.watermark,
            last, mutation.overflowed);
        // Release processed child variants while the rest of this signal waits.
        // Otherwise the array itself keeps the already-indexed payload alive.
        for (let index = start; index < end; index++) {
            mutation.events[index] = null;
        }
        this._queued_event_records -= end - start;
        mutation.index = end;
        if (last) {
            this._queued_event_bytes -= mutation.retainedBytes;
        }
        return last;
    }

    _apply_event_mutation(mutation) {
        if (mutation.type === "add") {
            return this._apply_add_mutation(mutation);
        }
        if (mutation.type === "remove") {
            this._apply_removed_events(mutation.uids);
            return true;
        }
        if (mutation.type === "overflow") {
            this._apply_event_overflow();
            return true;
        }
        if (mutation.type === "resync") {
            this._apply_event_resync();
            return true;
        }
        if (mutation.type === "fetch-complete") {
            this._apply_fetch_complete(mutation);
            return true;
        }
        this._apply_client_disappeared();
        return true;
    }

    _apply_next_event_mutation() {
        const mutation = this._event_mutations[0];
        if (!mutation || this._destroyed) {
            return;
        }

        if (this._apply_event_mutation(mutation)) {
            if (mutation.type === "overflow") {
                this._overflow_mutation_queued = false;
            } else if (mutation.type === "resync") {
                this._resync_mutation_queued = false;
            }
            this._event_mutations.shift();
        }

        if (this._event_mutations.length > 0) {
            this._schedule_event_mutation();
        }
    }

    _schedule_event_mutation() {
        if (this._destroyed || this._event_batch_ids.length > 0) {
            return;
        }

        this._event_batch_ids.push(Mainloop.idle_add(() => {
            this._event_batch_ids.shift();
            if (this._destroyed) {
                this._event_mutations = [];
                this._queued_event_records = 0;
                this._queued_event_bytes = 0;
                this._overflow_mutation_queued = false;
                this._resync_mutation_queued = false;
                this._pending_emit = null;
            } else {
                this._apply_next_event_mutation();
            }
            return GLib.SOURCE_REMOVE;
        }));
    }

    // `flush` is true on the last chunk of a batch
    _mark_event_overflow() {
        const changed = this._event_index.markOverflow();
        if (changed) {
            log("calendar events: safety limit reached; some events are hidden");
        }
        return changed;
    }

    _apply_event_overflow() {
        if (!this._mark_event_overflow()) {
            return;
        }
        this._emit_event_index_changed();
    }

    _apply_event_resync() {
        this._event_index.clear();
        this._resync_overflow_pending = true;
        this._mark_event_overflow();
        this._emit_event_index_changed();
        this.queue_reload_selected();
    }

    _accumulate_event_overflow(pending, result, flush, inputOverflowed) {
        if (result.overflow_changed) {
            log("calendar events: safety limit reached; some events are hidden");
            pending.overflow_changed = true;
        }
        if (flush && inputOverflowed && this._mark_event_overflow()) {
            pending.overflow_changed = true;
        }
    }

    _apply_added_or_updated(events, watermark, flush, inputOverflowed = false) {
        const result = this._event_index.addOrUpdate(
            events, watermark, this.current_selected_date);

        const pending = this._pending_emit ||
            {
                selected_date_changed: false,
                events_changed: false,
                overflow_changed: false
            };
        pending.selected_date_changed =
            pending.selected_date_changed || result.selected_date_changed;
        pending.events_changed = pending.events_changed || result.events_changed;
        this._accumulate_event_overflow(
            pending, result, flush, inputOverflowed);

        // A later fetch may have superseded a chunk that was already queued.
        // Its completion marker owns reconciliation; the old delivery must not
        // arm a timer that culls against the newer watermark.
        if (watermark === this.last_update_timestamp) {
            this._start_gc_timer();
        }

        if (!flush) {
            this._pending_emit = pending;
            return;
        }

        this._pending_emit = null;

        if (pending.selected_date_changed || pending.overflow_changed) {
            this._emit_selected_date_events_changed(false);
        }

        if (pending.events_changed || pending.overflow_changed) {
            this.emit("events-updated");
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

    // The acknowledgement means the request was accepted, not that its events
    // have been delivered. cinnamon-calendar-server completes the D-Bus method
    // as soon as it has *started* each calendar's asynchronous get_view();
    // the view is finished, connected and started later, and the initial
    // objects-added signals later still — or never, because a view that fails
    // to open is reported only to the server's own stdout.
    //
    // Culling here therefore erased the month's rows and dots before its
    // snapshot could arrive: every forced refresh flashed an empty calendar,
    // and a failed view was indistinguishable from a month with no events.
    // Reconciliation belongs to the quiet-window timer, which re-arms while
    // mutations are still draining and culls once the signal stream has
    // actually settled. Until it does, the last known events stay on screen.
    _apply_fetch_complete(mutation) {
        if (mutation.generation !== this._fetch_generation) {
            return;
        }

        this._start_gc_timer();
    }

    _handle_removed_events(server, uids_string) {
        // The payload is unbounded TEXT off the wire, and it would sit whole
        // in the mutation queue until the idle drains it. Anything longer
        // than one in-contract UID cannot name an indexed event, and the
        // multi-UID batch path resyncs anyway — so an oversized payload
        // collapses to the same authoritative resync without keeping the
        // bytes. null is that resync signal.
        const bounded = typeof uids_string === "string" &&
            uids_string.length <= EventDataModule.MAX_EVENT_UID_LENGTH ?
            uids_string : null;
        this._enqueue_event_mutation({ type: "remove", uids: bounded });
    }

    _apply_removed_events(uids_string) {
        // cinnamon-calendar-server batches IDs with "::", but an iCalendar
        // component UID is TEXT and may contain that exact sequence. A string
        // with the delimiter therefore cannot be decoded losslessly: clear the
        // window and ask the authoritative source again. A delimiter-free
        // single ID is unambiguous and keeps the fast targeted path. null is
        // the ingress bound's oversized-payload marker: same resync.
        const ambiguous = uids_string === null || uids_string.indexOf("::") !== -1;
        if (ambiguous) {
            this._event_index.clear();
        } else {
            this._event_index.remove([uids_string]);
        }

        // Re-feed the open list here: a targeted removal does not need an
        // authoritative reload, but its row must disappear immediately.
        this._emit_selected_date_events_changed(false);

        const currentMonth = this._window_coordinator.current_month_year;
        if (ambiguous && currentMonth) {
            this.fetch_month_events(currentMonth, true);
        } else if (ambiguous) {
            this.queue_reload_selected();
        }

        this.emit("events-updated");
    }

    _handle_client_disappeared(server, uid) {
        this._enqueue_event_mutation({ type: "client-disappeared" });
    }

    _apply_client_disappeared() {
        // A calendar was removed/disabled. Instead of picking
        // specific matching events to remove, just rebuild the
        // entire list.
        this._event_index.clear();
        this._emit_event_index_changed();
        this.queue_reload_selected();
    }

    _handle_status_changed() {
        if (!this.is_active()) {
            // No request remains authoritative once the service has no usable
            // calendars. A late cancellation/failure must not resurrect the
            // footer warning after this state transition cleared it.
            this._fetch_generation++;
            this._cancel_fetch_retry();
            this._fetch_retry_attempts = 0;
            this._setRefreshFailed(false);
        }
        this.emit("has-calendars-changed");
    }

    _setRefreshFailed(failed) {
        const next = Boolean(failed);
        if (next === this._refresh_failed) {
            return;
        }
        this._refresh_failed = next;
        this.emit("refresh-error-changed", next);
    }

    fetch_month_events(month_year, force, retry = false) {
        const timestamp = this._window_coordinator.fetchMonthEvents(
            month_year,
            force,
            (start, end, forceReload, cancellable, watermark) => this._dispatchMonthFetch(
                retry, start, end, forceReload, cancellable, watermark),
            GLib.get_monotonic_time,
            this._fetch_cancellable
        );

        if (timestamp !== null) {
            this.last_update_timestamp = timestamp;
        }
    }

    _dispatchMonthFetch(retry, start, end, force, cancellable, watermark) {
        if (!retry) {
            // A fresh user/server-driven request supersedes the old retry chain.
            // Do this only after EventWindowCoordinator decides to dispatch:
            // selecting another day in the same month can legitimately skip a
            // fetch and must not cancel the retry that month still needs.
            this._cancel_fetch_retry();
            this._fetch_retry_attempts = 0;
        }

        this._stop_gc_timer();
        this.last_update_timestamp = watermark;
        const generation = ++this._fetch_generation;
        this._server_connection.setTimeRange(
            start, end, force, cancellable,
            (server, res) => this.call_finished(generation, watermark, server, res));

        // Keep the warning if dispatch itself throws. Once a range call has
        // started, however, the old mutation-flood marker no longer describes
        // the replacement payload. selectDate emits the newly cleared state
        // immediately after this synchronous dispatch boundary.
        if (this._resync_overflow_pending) {
            this._resync_overflow_pending = false;
            this._event_index.clearOverflow();
        }
    }

    call_finished(generation, watermark, server, res) {
        let failure = null;
        try {
            // Gio requires every result to be finished, including stale and
            // cancelled ones. The connection uses the originating callback
            // proxy so a reconnect cannot finish an old result on a new proxy.
            this._server_connection.finishSetTimeRange(server, res);
        } catch (e) {
            failure = e;
        }

        // Only the latest dispatched range owns current UI/retry state. The
        // result above is already drained, so ignoring its state effects leaks
        // neither Gio resources nor an obsolete failure into the active month.
        if (this._destroyed || generation !== this._fetch_generation) {
            return;
        }

        if (!failure) {
            this._fetch_retry_attempts = 0;
            this._setRefreshFailed(false);
            // Signals emitted for SetTimeRange are ordered ahead of its reply,
            // but their bounded decoding may still be draining across idles.
            // Queue reconciliation behind that stream, including when the
            // successful response emitted no event signal at all.
            this._enqueue_event_mutation({
                type: "fetch-complete",
                generation,
                watermark
            });
        } else {
            // the month's events never arrived. Without a retry the grid keeps
            // the previous month's events and shows nothing for this one, and
            // no other path ever asks again.
            log(failure);
            this._setRefreshFailed(true);
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

            this.fetch_month_events(month_year, true, true);

            return GLib.SOURCE_REMOVE;
        });
    }

    _cancel_reload_selected() {
        if (this._reload_selected_id > 0) {
            Mainloop.source_remove(this._reload_selected_id);
            this._reload_selected_id = 0;
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
        this._event_mutations = [];
        this._queued_event_records = 0;
        this._queued_event_bytes = 0;
        this._overflow_mutation_queued = false;
        this._resync_mutation_queued = false;
        this._pending_emit = null;
        this._resync_overflow_pending = false;

        this._server_connection.destroy();
        this._stop_gc_timer();
        this._cancel_reload_selected();
        this._cancel_fetch_retry();

        // A month of EventData, four GLib.DateTime each, and the applet that owns
        // this outlives its removal from the panel — Cinnamon's Applet has no
        // destroy(), and AppletContextMenu holds the actor, which holds _delegate.
        // Releasing the timers and the signals but keeping the data is how ten
        // add/remove cycles retained 38 MiB.
        this._event_index.clear();

        this._destroyed = true;
    }

    queue_reload_selected() {
        this._cancel_reload_selected();
        this._reload_selected_id = Mainloop.idle_add(
            this._idle_do_reload_selected.bind(this));
    }

    _idle_do_reload_selected() {
        this._reload_selected_id = 0;
        this._window_coordinator.reloadSelected(
            () => this.is_active(),
            (month_year, force) => this.fetch_month_events(month_year, force),
            (name, ...args) => this.emit(name, ...args));

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
        FETCH_RETRY_MAX_ATTEMPTS, EDS_BUS_NAME, MAX_EVENT_SIGNAL_BYTES,
        MAX_QUEUED_EVENT_RECORDS, MAX_QUEUED_EVENT_BYTES,
        MAX_QUEUED_EVENT_MUTATIONS, boundedEventVariants };
}
