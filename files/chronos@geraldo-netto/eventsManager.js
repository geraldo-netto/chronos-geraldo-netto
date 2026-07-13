/* global imports */
/* eslint camelcase: "off" */

// EventsManager: DBus I/O and fetch-state for calendar events, shared by
// 5.4/eventView.js. Split from the view so the retry/teardown/GC state
// machine is Node-testable.

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const Gio = GjsImports.gi.Gio;
const GLib = GjsImports.gi.GLib;
const Cinnamon = GjsImports.gi.Cinnamon;
const Mainloop = GjsImports.mainloop;
const Signals = GjsImports.signals;
// the native GJS importer provides neither require() nor module; Node and
// the 5.4 cjs loader provide both
const APPLET_MODULES = typeof require === "undefined" ?
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"] : null;
const Utils = APPLET_MODULES ? APPLET_MODULES.utils : require("./utils");
const EventDataModule = APPLET_MODULES ? APPLET_MODULES.eventData : require("./eventData");
const js_date_to_gdatetime = EventDataModule.js_date_to_gdatetime;
const date_only = EventDataModule.date_only;
const month_year_only = EventDataModule.month_year_only;
const dt_equals = EventDataModule.dt_equals;
const EventData = EventDataModule.EventData;
const EventDataList = EventDataModule.EventDataList;

const UUID = "chronos@geraldo-netto";

const STATUS_UNKNOWN = 0;
const STATUS_NO_CALENDARS = 1;

// days an event is indexed across before the walk gives up: a bugged event whose
// end never arrives would otherwise index days forever
const MAX_SPANNED_DAYS = 50;

var EDS_BUS_NAME = "org.gnome.evolution.dataserver.Calendar8"
var SERVER_RETRY_SECONDS = 5;
var SERVER_RETRY_MAX_SECONDS = 300;
// a month fetch that fails takes the month's events with it; retry it a few
// times with backoff before giving up
var FETCH_RETRY_SECONDS = 5;
var FETCH_RETRY_MAX_SECONDS = 120;
var FETCH_RETRY_MAX_ATTEMPTS = 5;
// events turned into EventData per main-loop turn. A normal delivery is a
// handful and lands in one go; a shared calendar's 42-day window is not.
var EVENT_BATCH_CHUNK = 25;

var CalendarServerConnection = class CalendarServerConnection {
    constructor(callbacks, params = {}) {
        this.callbacks = callbacks;
        this._bus_watch_id = 0;
        this._calendar_server = null;
        this._calendar_server_signal_ids = [];
        this._server_retry_id = 0;
        this._server_retry_attempts = 0;
        this._cached_state = STATUS_UNKNOWN;
        this._inited = false;
        this._destroyed = false;
        // injectable so the retry jitter is a fixed number under test, as the
        // weather scheduler's already is
        this._random = params.random || Math.random;
    }

    start() {
        // Destroyed is terminal. The constructor catches its own failure and
        // tears itself down, but it still returns an object, so Cinnamon goes
        // on to call on_applet_added_to_panel() — which lands here. Guarding
        // only on the watch id would re-arm the watch on a dead applet, and
        // destroy() has already run and will not run again.
        if (this._destroyed || this._bus_watch_id > 0) {
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
            log(UUID + ": Calendar events supported.")

            Cinnamon.CalendarServerProxy.new_for_bus(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION,
                "org.cinnamon.CalendarServer",
                "/org/cinnamon/CalendarServer",
                null,
                this._calendar_server_ready.bind(this)
            );
        }
    }

    _calendar_server_ready(obj, res) {
        // the proxy construction may finish after the applet was removed
        // from the panel; connecting signals then would leak them forever
        if (this._destroyed) {
            return;
        }

        try {
            this._calendar_server = Cinnamon.CalendarServerProxy.new_for_bus_finish(res);

            this._calendar_server_signal_ids.push(this._calendar_server.connect(
                "events-added-or-updated",
                this.callbacks.onAddedOrUpdated
            ));

            this._calendar_server_signal_ids.push(this._calendar_server.connect(
                "events-removed",
                this.callbacks.onRemoved
            ));

            this._calendar_server_signal_ids.push(this._calendar_server.connect(
                "client-disappeared",
                this.callbacks.onClientDisappeared
            ));

            this._calendar_server_signal_ids.push(this._calendar_server.connect(
                "notify::status",
                this._handle_status_notify.bind(this)
            ));

            this._inited = true;
            this._server_retry_attempts = 0;

            this.callbacks.onReady();
        } catch (e) {
            log("could not connect to calendar server process: " + e);
            // The proxy can be built and still fail to wire up: if one of the
            // connect() calls above throws, _calendar_server is left non-null
            // and half-connected. The retried start() then walks into the
            // "if (this._calendar_server == null)" guard in eds_service_found,
            // builds nothing, never reaches onReady, never sets _inited — and
            // never queues another retry either. The event column read
            // "Calendar events are unavailable" for the rest of the session.
            //
            // Undo the half-built proxy so the retry starts from nothing.
            this._disconnectServer();
            this._calendar_server = null;
            this._inited = false;
            this.queueRetry();
            return;
        }
    }

    cancelRetry() {
        if (this._server_retry_id > 0) {
            Mainloop.source_remove(this._server_retry_id);
            this._server_retry_id = 0;
        }
    }

    retryDelay() {
        return Utils.backoffDelay(this._server_retry_attempts, {
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
        this._server_retry_id = Mainloop.timeout_add_seconds(
            delay,
            () => {
                this._server_retry_id = 0;
                this.start();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _handle_status_notify() {
        if (this._calendar_server.status === this._cached_state) {
            return;
        }

        // Never reload when the new status is STATUS_UNKNOWN - this
        // means the server name-owner disappeared, it doesn't mean
        // there are no calendars.
        if (this._calendar_server.status === STATUS_UNKNOWN) {
            return;
        }

        this._cached_state = this._calendar_server.status;
        this.callbacks.onStatusChanged();
    }

    // whatever handlers made it onto the proxy come back off it; a half-wired
    // proxy has some of them, a live one has all four
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
        this._disconnectServer();

        this._calendar_server = null;
        this._inited = false;
        this._destroyed = true;
    }

    // The proxy is this object's to own: it builds it, connects its signals and
    // nulls it in destroy(), so it is the only place that should dereference it.
    // These two methods are what EventsManager and the window coordinator used to
    // reach through _calendar_server to call — the ownership is no longer split.
    setTimeRange(start, end, force, cancellable, callFinished) {
        if (this._calendar_server === null) {
            return;
        }

        this._calendar_server.call_set_time_range(start, end, force, cancellable, callFinished);
    }

    finishSetTimeRange(res) {
        // no proxy means no reply to finish; let the caller's catch treat it as a
        // failed fetch and retry, exactly as a thrown finish() did before
        if (this._calendar_server === null) {
            throw new Error("calendar server proxy is gone");
        }

        this._calendar_server.call_set_time_range_finish(res);
    }

    isActive(showEvents) {
        return this._inited &&
               showEvents &&
               this._calendar_server !== null &&
               // Not blocking STATUS_UNKNOWN allows our calendar to remain
               // populated while the server is 'unowned' (sleeping), since
               // its cached property is set to 0 when its current owner exits.
               this._calendar_server.status !== STATUS_NO_CALENDARS;
    }
};

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

    // an emptied day is "no events", not "a list of nothing": the renderer
    // builds zero rows for the latter and leaves a blank panel behind
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

        // don't loop endlessly in case of a bugged event: the bound is the loop's
        // own condition, not a counter checked inside a `while (true)`
        let date_iter = date_only(data.start);
        for (let escape = 0; escape <= MAX_SPANNED_DAYS; escape++) {
            let hash = date_iter.to_unix();

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

        for (let n = 0; n < events.length; n++) {
            let data;
            try {
                data = new EventData(events[n], timestamp);
            } catch (e) {
                // This runs inside a DBus signal handler on the compositor
                // thread: one unusable event out of a feed must cost that
                // event, not the whole month — and not the shell.
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
            let event_data_list = this.eventsByDate[hash];

            for (let uid of uids) {
                event_data_list.delete(uid);
            }
        }
    }

    cull(timestamp) {
        let any_removed = false;
        for (let date in this.eventsByDate) {
            if (this.eventsByDate[date].cull_removed_events(timestamp)) {
                any_removed = true;
            }

            // an emptied bucket would otherwise be kept forever
            if (this.eventsByDate[date].length === 0) {
                delete this.eventsByDate[date];
            }
        }

        return any_removed;
    }
};

var EventWindowCoordinator = class EventWindowCoordinator {
    constructor(index) {
        this.index = index;
        this.current_month_year = null;
        this.current_selected_date = GLib.DateTime.new_from_unix_local(0);
        this.current_selected_signature = null;
    }

    fetchMonthEvents(month_year, force, setTimeRange, callFinished, timestampNow, cancellable = null) {
        let changed_month = this.current_month_year === null || !dt_equals(month_year, this.current_month_year);

        if (!changed_month && !force) {
            return null;
        }
        this.current_month_year = month_year;

        if (changed_month) {
            this.index.clear();
        }

        // get first day of month
        let day_one = month_year_only(month_year);

        // back up to the start of the week containing day 1
        let start = day_one.add_days( -Utils.monthWindowStartOffset(
            day_one.get_day_of_week(), Cinnamon.util_get_week_start()) );
        // The calendar has 42 boxes
        let end = start.add_days(42).add_seconds(-1);

        // The reply lands in call_finished. Removing the applet mid-call used to
        // throw a TypeError there, caught and logged as though the month's events
        // had failed; the connection now guards its own proxy, and the HTTP paths
        // in this codebase already pass a cancellable for the same reason.
        setTimeRange(start.to_unix(), end.to_unix(), force, cancellable, callFinished);

        return timestampNow();
    }

    selectDate(date, force, isActive, fetchMonthEvents, emit) {
        if (!isActive()) {
            return;
        }

        const selectedSignature = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        if (!force && selectedSignature === this.current_selected_signature) {
            return;
        }

        // date is a js Date(). Eventually the calendar side should use
        // GDateTime, but for now we'll convert it here - it's a bit more
        // useful for dealing with events.
        let gdate = js_date_to_gdatetime(date);

        let gdate_only = date_only(gdate);
        if (!force && dt_equals(gdate_only, this.current_selected_date)) {
            this.current_selected_signature = selectedSignature;
            return;
        }

        let month_year = month_year_only(gdate_only);
        fetchMonthEvents(month_year, force);
        emit("selected-date-changed", gdate_only);

        // current_selected_date starts at the unix epoch, never null
        let delay_no_events_box = !dt_equals(month_year_only(this.current_selected_date),
                                             month_year_only(gdate_only));

        this.current_selected_date = gdate_only;
        this.current_selected_signature = selectedSignature;

        let existing_event_list = this.index.get(gdate_only);
        if (existing_event_list !== null) {
            // log("---------------cache hit");
            emit("selected-date-events-changed", existing_event_list, delay_no_events_box);
        } else {
            emit("selected-date-events-changed", null, delay_no_events_box);
        }
    }
};

var EventsManager = class EventsManager {
    constructor(settings, params = {}) {
        this.settings = settings;
        // one RNG for both retry chains in this file, injectable under test
        this._random = params.random || Math.random;
        this._server_connection = new CalendarServerConnection({
            onReady: () => this.emit("events-manager-ready"),
            onAddedOrUpdated: this._handle_added_or_updated_events.bind(this),
            onRemoved: this._handle_removed_events.bind(this),
            onClientDisappeared: this._handle_client_disappeared.bind(this),
            onStatusChanged: this._handle_status_changed.bind(this)
        }, { random: this._random });
        this.last_update_timestamp = 0;
        this._event_index = new EventIndex();
        this._window_coordinator = new EventWindowCoordinator(this._event_index);

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

        const delay = Utils.backoffDelay(this._fetch_retry_attempts, {
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

Signals.addSignalMethods(EventsManager.prototype);

if (typeof module !== "undefined") {
    module.exports = { EventsManager, CalendarServerConnection, EventIndex, EventWindowCoordinator, SERVER_RETRY_SECONDS, SERVER_RETRY_MAX_SECONDS, FETCH_RETRY_SECONDS, FETCH_RETRY_MAX_SECONDS, FETCH_RETRY_MAX_ATTEMPTS, EDS_BUS_NAME };
}
