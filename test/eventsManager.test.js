const assert = require("node:assert/strict");
const { beforeEach, test } = require("node:test");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");

const DAY_US = 24 * 3600 * 1000 * 1000;
const DAY_S = 24 * 3600;

class FakeDateTime {
    constructor(usec) {
        this.usec = usec;
    }

    to_unix() {
        return Math.floor(this.usec / 1000000);
    }

    difference(other) {
        return this.usec - other.usec;
    }

    compare(other) {
        return this.usec === other.usec ? 0 : (this.usec < other.usec ? -1 : 1);
    }

    add_seconds(seconds) {
        return new FakeDateTime(this.usec + seconds * 1000000);
    }

    add_days(days) {
        return new FakeDateTime(this.usec + days * DAY_US);
    }

    get_year() {
        return 2000;
    }

    get_month() {
        return 1;
    }

    get_day_of_month() {
        return Math.floor(this.usec / DAY_US);
    }

    get_day_of_week() {
        return (Math.floor(this.usec / DAY_US) % 7) + 1;
    }
}

// controllable Mainloop: timers fire only when the test says so
const timers = { next_id: 1, pending: new Map() };
function fireTimer(id) {
    const cb = timers.pending.get(id);
    timers.pending.delete(id);
    return cb();
}

const gio = { watches: [], unwatched: [] };
const proxy = {
    pendingReadyCb: null,
    pendingCancellable: null,
    finishCalls: [],
    finishError: null,
    startError: null,
    // GJS connect() can throw — a closed bus, a proxy that finished but is
    // already dead — and the code has to survive a proxy that built and then
    // failed halfway through being wired up
    connectError: null,
    instance: null
};

class ProxyInstance {
    constructor() {
        this.status = 2;
        this.g_name_owner = "calendar-owner";
        this.connections = {};
        this.disconnected = [];
        this.next_signal_id = 1;
        this.set_time_range_calls = [];
        this.finished_time_ranges = [];
        this.defer_time_ranges = false;
    }

    connect(name, cb) {
        const failure = typeof proxy.connectError === "function" ?
            proxy.connectError() : proxy.connectError;
        if (failure) {
            throw failure;
        }
        const id = this.next_signal_id++;
        this.connections[id] = { name, cb };
        return id;
    }

    disconnect(id) {
        this.disconnected.push(id);
        delete this.connections[id];
    }

    signal(name, ...args) {
        for (const id in this.connections) {
            if (this.connections[id].name === name) {
                this.connections[id].cb(this, ...args);
            }
        }
    }

    call_set_time_range(start, end, force, cancellable, cb) {
        this.set_time_range_calls.push({ start, end, force, cancellable, cb });
        if (cb && !this.defer_time_ranges) {
            cb(this, "res");
        }
    }

    call_set_time_range_finish(res) {
        this.finished_time_ranges.push(res);
        if (res && res.error) {
            throw res.error;
        }
    }

    complete_time_range(index, res) {
        const call = this.set_time_range_calls[index];
        const cb = call && call.cb;
        assert.equal(typeof cb, "function", `range ${index} has one pending callback`);
        call.cb = null;
        cb(this, res);
    }
}

function makeProxyInstance() {
    return new ProxyInstance();
}

global.log = () => {};
global.imports = {
    gi: {
        Gio: {
            BusType: { SESSION: 2 },
            BusNameWatcherFlags: { NONE: 0 },
            DBusProxyFlags: { DO_NOT_AUTO_START_AT_CONSTRUCTION: 1 },
            // the in-flight month fetch carries one, so a reply that arrives
            // after the applet is gone is cancelled rather than delivered to a
            // torn-down manager
            Cancellable: class {
                constructor() {
                    this.cancelled = false;
                }
                cancel() {
                    this.cancelled = true;
                }
            },
            bus_watch_name(busType, name, flags, foundCb) {
                const id = gio.watches.length + 1;
                gio.watches.push({ id, name, foundCb });
                return id;
            },
            bus_unwatch_name(id) {
                gio.unwatched.push(id);
            }
        },
        GLib: {
            SOURCE_REMOVE: false,
            TIME_SPAN_DAY: DAY_US,
            get_monotonic_time: (() => {
                let t = 0;
                return () => ++t;
            })(),
            get_user_cache_dir: () => "/tmp/cache",
            build_filenamev: (parts) => parts.join("/"),
            DateTime: {
                new_from_unix_local: (unix) => new FakeDateTime(unix * 1000000),
                new_local: (y, m, day) => new FakeDateTime(day * DAY_US),
                new_now_local: () => new FakeDateTime(50 * DAY_US + DAY_US / 2)
            }
        },
        Cinnamon: {
            util_get_week_start: () => 0,
            CalendarServerProxy: {
                new_for_bus(busType, flags, name, objectPath, cancellable, readyCb) {
                    if (proxy.startError) {
                        throw proxy.startError;
                    }
                    proxy.pendingCancellable = cancellable;
                    proxy.pendingReadyCb = readyCb;
                },
                new_for_bus_finish(res) {
                    proxy.finishCalls.push(res);
                    if (proxy.finishError) {
                        throw proxy.finishError;
                    }
                    proxy.instance = makeProxyInstance();
                    return proxy.instance;
                }
            }
        },
        Soup: { MAJOR_VERSION: 3, Session: class {} },
        CinnamonDesktop: {
            WallClock: {
                lctime_format: (domain, format) => format
            }
        }
    },
    byteArray: {},
    mainloop: {
        timeout_add_seconds(seconds, cb) {
            const id = timers.next_id++;
            timers.pending.set(id, cb);
            return id;
        },
        idle_add(cb) {
            const id = timers.next_id++;
            timers.pending.set(id, cb);
            return id;
        },
        source_remove(id) {
            timers.pending.delete(id);
        }
    },
    signals: {
        addSignalMethods(proto) {
            proto.connect = function(name, cb) {
                this._handlers = this._handlers || [];
                this._handlers.push({ name, cb });
                return this._handlers.length;
            };
            proto.emit = function(name, ...args) {
                this._emitted = this._emitted || [];
                this._emitted.push({ name, args });
                (this._handlers || []).filter((h) => h.name === name)
                    .forEach((h) => h.cb(this, ...args));
            };
        }
    }
};

const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "eventsManager.js");
const {
    EventsManager,
    createEventsManager,
    EventIndex,
    EventWindowCoordinator,
    SERVER_RETRY_SECONDS,
    SERVER_RETRY_MAX_SECONDS,
    FETCH_RETRY_MAX_SECONDS,
    FETCH_RETRY_MAX_ATTEMPTS,
    MAX_EVENT_SIGNAL_BYTES,
    MAX_QUEUED_EVENT_RECORDS,
    MAX_QUEUED_EVENT_BYTES,
    MAX_QUEUED_EVENT_MUTATIONS,
    boundedEventVariants
} = require(modulePath);

function emitted(manager, name) {
    return (manager._emitted || []).filter((e) => e.name === name);
}

function makeManager(showEvents = true) {
    return createEventsManager({ showEvents });
}

function readyManager() {
    const manager = makeManager();
    manager.start_events();
    gio.watches.at(-1).foundCb(null, "eds", "owner");
    proxy.pendingReadyCb(null, "res");
    return manager;
}

function eventVariant({ id = "ev1", color = "#abc", summary = "s", allDay = false, startUnix, endUnix, modTime = 1 }) {
    return { deep_unpack: () => [id, color, summary, allDay, startUnix, endUnix, modTime] };
}

function eventArrayVariant(events, bytes = events.length * 128) {
    return {
        get_size: () => bytes,
        n_children: () => events.length,
        get_child_value: (index) => events[index],
        unpack: () => {
            throw new Error("production-shaped variants must not unpack the full array");
        }
    };
}

const { EventData: RealEventData } = require(
    path.join(__dirname, "..", "files", "chronos@geraldo-netto", "eventData.js"));

function makeEventData(spec) {
    return new RealEventData(eventVariant(spec), 0);
}

// registers one event through the EventIndex seam the manager uses
function registerDays(manager, data) {
    return manager._event_index.register(
        data, manager.last_update_timestamp, manager.current_selected_date);
}

function drainEventMutations(manager, limit = 1000) {
    for (let turn = 0; turn < limit && manager._event_batch_ids.length > 0; turn++) {
        fireTimer(manager._event_batch_ids[0]);
    }
    assert.deepEqual(manager._event_batch_ids, [], "the mutation queue must settle");
}

function eventSummaries(manager) {
    const events = manager._event_index.get(new FakeDateTime(10 * DAY_US));
    return new Map(events ?
        events.get_event_list().map((event) => [event.id, event.summary]) : []);
}

beforeEach(() => {
    gio.watches.length = 0;
    gio.unwatched.length = 0;
    timers.pending.clear();
    proxy.pendingReadyCb = null;
    proxy.pendingCancellable = null;
    proxy.finishCalls.length = 0;
    proxy.finishError = null;
    proxy.startError = null;
    proxy.connectError = null;
    proxy.instance = null;
});

test("start_events watches the EDS bus once", () => {
    const manager = makeManager();
    assert.doesNotThrow(() => manager._server_connection.setTimeRange(1, 2, false, null, () => {}));
    assert.throws(() => manager._server_connection.finishSetTimeRange(null, "reply"), /proxy is gone/);
    manager.start_events();
    manager.start_events();
    assert.equal(gio.watches.length, 1);
    assert.equal(gio.watches[0].name, "org.gnome.evolution.dataserver.Calendar8");
});

// the constructor catches its own failure and destroys itself, but it still
// returns an object, so Cinnamon goes on to call on_applet_added_to_panel(),
// which starts the events manager. Destroyed has to be terminal, or the watch
// comes back on an applet that will never be torn down again.
// REGRESSION: destroy() released the timers, the DBus watch and the proxy, and
// kept the event index — a month of EventData, four GLib.DateTime each. Cinnamon's
// Applet has no destroy(), and the applet outlives its removal from the panel
// through AppletContextMenu's sourceActor, so nothing else ever dropped them: ten
// add/remove cycles retained 38 MiB.
test("destroy drops the events it was holding, not just the timers", () => {
    const manager = readyManager();
    const day = 20000 * 24 * 3600;

    for (let i = 0; i < 30; i++) {
        registerDays(manager, makeEventData({
            id: `ev${i}`, startUnix: day + i * 3600, endUnix: day + i * 3600 + 1800
        }));
    }
    assert.ok(Object.keys(manager._event_index.eventsByDate).length > 0);

    manager.destroy();

    assert.deepEqual(manager._event_index.eventsByDate, {},
        "the index the applet outlives its panel with");
});

test("a destroyed connection does not start watching the bus again", () => {
    const manager = makeManager();
    manager.destroy();
    manager.start_events();

    assert.deepEqual(gio.watches, []);
});

test("server connection owns state; the manager keeps only used accessors", () => {
    const manager = makeManager();
    const conn = manager._server_connection;
    const fakeServer = { status: 2, disconnect() {}, call_set_time_range_finish() {} };

    conn._calendar_server = fakeServer;
    assert.equal(conn._calendar_server, fakeServer, "the connection owns the proxy");

    conn._server_retry_attempts = 3;
    assert.equal(conn.retryDelay() >= 8 * SERVER_RETRY_SECONDS, true);

    conn._server_retry_id = global.imports.mainloop.timeout_add_seconds(5, () => {});
    conn.cancelRetry();
    assert.equal(conn._server_retry_id, 0);

    conn._destroyed = true;
    conn.queueRetry();
    assert.equal(conn._server_retry_id, 0);
    conn._destroyed = false;

    conn._bus_watch_id = 77;
    conn._calendar_server = null;
    conn.eds_service_found(null, "eds", "owner");
    assert.equal(gio.unwatched.at(-1), 77);
    conn._calendar_server_ready(null, "res");
    assert.equal(conn._calendar_server, proxy.instance);

    conn._cached_state = 2;
    proxy.instance.status = 1;
    conn._handle_status_notify(proxy.instance, null);
    assert.equal(emitted(manager, "has-calendars-changed").length, 1);

    const inactive = makeManager(false);
    inactive._start_gc_timer();
    assert.equal(inactive._gc_timer_id, 0);

    const watching = makeManager();
    watching.start_events();
    watching.destroy();
    assert.equal(gio.unwatched.at(-1), 1);
});

test("service found connects the proxy and emits ready", () => {
    const manager = readyManager();
    assert.equal(gio.unwatched.length, 1);
    assert.ok(proxy.pendingCancellable, "proxy construction carries an owned cancellable");
    assert.equal(manager._server_connection._proxy_cancellable, null);
    assert.ok(manager._server_connection._inited);
    assert.equal(Object.keys(proxy.instance.connections).length, 5);
    assert.equal(emitted(manager, "events-manager-ready").length, 1);
});

test("calendar-server owner loss invalidates the proxy and reconnects", () => {
    const manager = readyManager();
    const vanished = proxy.instance;
    vanished.g_name_owner = null;

    vanished.signal("notify::g-name-owner", null);

    assert.equal(manager._server_connection._calendar_server, null);
    assert.equal(manager._server_connection._inited, false);
    assert.equal(manager.is_active(), false);
    assert.equal(Object.keys(vanished.connections).length, 0);
    assert.equal(emitted(manager, "has-calendars-changed").length, 1);
    assert.ok(manager._server_connection._server_retry_id > 0);

    fireTimer(manager._server_connection._server_retry_id);
    assert.equal(gio.watches.length, 2, "retry re-arms discovery");
    gio.watches.at(-1).foundCb(null, "eds", "owner");
    proxy.pendingReadyCb(null, "reconnected");

    assert.ok(manager._server_connection._inited);
    assert.ok(manager.is_active());
    assert.equal(emitted(manager, "events-manager-ready").length, 2);
});

// T705: org.cinnamon.CalendarServer is D-Bus activatable and idle-exits without
// clients, so "no owner yet" is the normal first-connection state — the first
// call_set_time_range() is what starts the process. Treating it as an owner
// loss dropped the proxy before anything ever called it: events never worked
// and the reconnect loop spun, with its log line, for the whole session.
test("a proxy built before the activatable server has an owner is published", () => {
    const manager = makeManager();
    manager.start_events();
    gio.watches.at(-1).foundCb(null, "eds", "owner");

    // Make the instance ownerless before CalendarServerConnection inspects it.
    const originalFinish = global.imports.gi.Cinnamon.CalendarServerProxy.new_for_bus_finish;
    global.imports.gi.Cinnamon.CalendarServerProxy.new_for_bus_finish = (res) => {
        const instance = originalFinish(res);
        instance.g_name_owner = null;
        return instance;
    };
    try {
        proxy.pendingReadyCb(null, "ownerless");
    } finally {
        global.imports.gi.Cinnamon.CalendarServerProxy.new_for_bus_finish = originalFinish;
    }

    assert.equal(manager._server_connection._calendar_server, proxy.instance);
    assert.ok(manager._server_connection._inited);
    assert.ok(manager.is_active(), "an ownerless activatable server is usable");
    assert.equal(emitted(manager, "events-manager-ready").length, 1);
    assert.equal(manager._server_connection._server_retry_id, 0,
        "nothing to retry: the first call activates the server");

    // ...and the call that activates the service actually goes out
    manager.select_date(new Date(50 * DAY_S * 1000), true);
    assert.equal(proxy.instance.set_time_range_calls.length, 1);

    // an owner the proxy *did* have going away is still a real disconnect
    proxy.instance.g_name_owner = null;
    proxy.instance.signal("notify::g-name-owner", null);
    assert.equal(manager._server_connection._calendar_server, null);
    assert.ok(manager._server_connection._server_retry_id > 0);
});

test("the calendar support line is logged once, not per reconnect", () => {
    const logged = [];
    const originalLog = global.log;
    global.log = (message) => logged.push(String(message));
    try {
        const manager = readyManager();

        // idle-exit: the owner goes away, the connection retries and reconnects
        proxy.instance.g_name_owner = null;
        proxy.instance.signal("notify::g-name-owner", null);
        fireTimer(manager._server_connection._server_retry_id);
        gio.watches.at(-1).foundCb(null, "eds", "owner");
        proxy.pendingReadyCb(null, "reconnected");

        assert.ok(manager._server_connection._inited, "the reconnect succeeded");
    } finally {
        global.log = originalLog;
    }

    const supportLines = logged.filter((line) => /Calendar events supported/.test(line));
    assert.equal(supportLines.length, 1,
        "a session-long retry cadence must not repeat the support statement");
});

test("proxy ready after destroy connects nothing", () => {
    const manager = makeManager();
    manager.start_events();
    gio.watches.at(-1).foundCb(null, "eds", "owner");
    const cancellable = proxy.pendingCancellable;
    assert.ok(cancellable);
    manager.destroy();
    assert.equal(cancellable.cancelled, true);
    proxy.pendingReadyCb(null, "res");
    assert.deepEqual(proxy.finishCalls, ["res"], "the cancelled async result is still finished");
    assert.equal(Object.keys(proxy.instance.connections).length, 0);
    assert.equal(manager._server_connection._calendar_server, null);
    assert.ok(!manager._server_connection._inited);
});

test("a late proxy cancellation error is drained without logging or retrying", () => {
    const logged = [];
    const originalLog = global.log;
    const manager = makeManager();
    manager.start_events();
    gio.watches.at(-1).foundCb(null, "eds", "owner");
    proxy.finishError = new Error("cancelled");
    manager.destroy();

    global.log = (message) => logged.push(String(message));
    assert.doesNotThrow(() => proxy.pendingReadyCb(null, "late-error"));
    global.log = originalLog;

    assert.deepEqual(proxy.finishCalls, ["late-error"]);
    assert.equal(manager._server_connection._server_retry_id, 0);
    assert.deepEqual(logged, []);
});

test("synchronous proxy construction failure retries cleanly", () => {
    const manager = makeManager();
    manager.start_events();
    proxy.startError = new Error("bus closed");

    assert.doesNotThrow(() => gio.watches.at(-1).foundCb(null, "eds", "owner"));
    assert.equal(manager._server_connection._proxy_cancellable, null);
    assert.ok(manager._server_connection._server_retry_id > 0);
});

test("proxy construction failure schedules a retry that restarts the watch", () => {
    const manager = makeManager();
    manager.start_events();
    gio.watches.at(-1).foundCb(null, "eds", "owner");
    proxy.finishError = new Error("boom");
    proxy.pendingReadyCb(null, "res");
    assert.equal(manager._server_connection._server_retry_id > 0, true);

    proxy.finishError = null;
    fireTimer(manager._server_connection._server_retry_id);
    assert.equal(gio.watches.length, 2, "retry re-watches the bus");
});

// The proxy can be built and still fail to wire up. _calendar_server was then
// left non-null and half-connected, so the retried start() hit the
// "already have a server" guard, built nothing, never reached onReady, never
// set _inited, and never queued another retry: the event column read "Calendar
// events are unavailable" for the rest of the session.
test("a proxy that fails while connecting is torn down, not kept half-built", () => {
    const manager = makeManager();
    manager.start_events();
    gio.watches.at(-1).foundCb(null, "eds", "owner");

    // new_for_bus_finish succeeds; the second connect() throws
    let connects = 0;
    proxy.connectError = () => {
        connects++;
        return connects === 2 ? new Error("dbus closed under us") : null;
    };
    proxy.pendingReadyCb(null, "res");

    assert.equal(manager._server_connection._calendar_server, null,
        "a half-wired proxy must not survive as the live one");
    assert.equal(manager._server_connection._inited, false);
    assert.ok(manager._server_connection._server_retry_id > 0, "and a retry is queued");

    // the retry now gets a clean build, which is what it could never do before
    proxy.connectError = null;
    fireTimer(manager._server_connection._server_retry_id);
    gio.watches.at(-1).foundCb(null, "eds", "owner");
    proxy.pendingReadyCb(null, "res");

    assert.equal(manager._server_connection._inited, true, "the events column comes back");
    assert.ok(manager.is_active());
});

// The month fetch used to pass a null cancellable. destroy() nulls the proxy
// without cancelling, so a reply still in flight landed in call_finished, which
// dereferenced null — a TypeError, caught, and logged as though the month's
// events had failed to arrive. Removing the applet planted that line every time.
test("a month fetch in flight is cancelled when the applet goes away", () => {
    const logged = [];
    const originalLog = global.log;
    const manager = readyManager();
    proxy.instance.defer_time_ranges = true;

    manager.select_date(new Date(50 * DAY_S * 1000), true);
    const call = proxy.instance.set_time_range_calls.at(-1);
    assert.ok(call.cancellable, "the call carries a cancellable, not null");

    global.log = (message) => logged.push(String(message));
    manager.destroy();
    assert.equal(call.cancellable.cancelled, true);

    // and if the reply arrives anyway, it is dropped in silence rather than
    // logged as an EDS failure; Gio still receives its mandatory finish call
    assert.doesNotThrow(() => call.cb(proxy.instance, { id: "late-after-destroy" }));
    assert.equal(proxy.instance.finished_time_ranges.at(-1).id, "late-after-destroy");
    global.log = originalLog;

    assert.equal(logged.length, 0, "a removed applet does not report a fetch failure");
});

test("destroy cancels watch, retry and timers and disconnects proxy signals", () => {
    const manager = readyManager();
    manager._server_connection.queueRetry();
    manager._start_gc_timer();
    manager.queue_reload_selected();
    const server = proxy.instance;
    manager.destroy();

    assert.equal(timers.pending.size, 0);
    assert.equal(server.disconnected.length, 5);
    assert.equal(manager._server_connection._calendar_server, null);
    assert.ok(manager._destroyed);
});

// The grid rebuild is not free: "events-updated" tears the 42 day cells' dots down
// and rebuilds them, and calendar-server re-sends the whole window on every change
// to any calendar in it. Re-delivering the same events must not repaint. This was
// asserted by matching `if (pending.events_changed)` in the source — a regex that
// passes whether or not the flag is ever false, and the shipped behaviour with the
// condition forced true was indistinguishable to the suite.
test("re-delivering the same events does not repaint the grid", () => {
    const manager = readyManager();
    manager._window_coordinator.current_selected_date = new FakeDateTime(11 * DAY_US);
    const events = [eventVariant({
        id: "standup", startUnix: 11 * DAY_S + 3600, endUnix: 11 * DAY_S + 5400
    })];

    proxy.instance.signal("events-added-or-updated", { unpack: () => events });
    assert.equal(emitted(manager, "events-updated").length, 1, "the first delivery paints");

    // the same event, again — the server re-sends its whole window whenever
    // anything in it changes, and nothing in this one did
    proxy.instance.signal("events-added-or-updated", { unpack: () => events });
    assert.equal(emitted(manager, "events-updated").length, 1,
        "an unchanged redelivery must not rebuild the grid");

    // and a real change still gets through. The server stamps an edited event with
    // a new modification time, and that stamp — not the fields — is what says the
    // event is not the one already held.
    proxy.instance.signal("events-added-or-updated", {
        unpack: () => [eventVariant({
            id: "standup", startUnix: 11 * DAY_S + 7200, endUnix: 11 * DAY_S + 9000,
            modTime: 2
        })]
    });
    assert.equal(emitted(manager, "events-updated").length, 2, "a moved event repaints");
});

// T599: rescheduling an event to another day inside the window rewrites its
// buckets, but selected_changed was reported only for the NEW date — so the
// grid dot moved while the open event column kept the stale row for the old
// day until the user reselected it. The out-of-window move and the removal
// path both handled their cases; the in-window move was the gap.
test("an event rescheduled off the selected day refreshes that day's list", () => {
    const manager = readyManager();
    manager._window_coordinator.current_selected_date = new FakeDateTime(11 * DAY_US);

    proxy.instance.signal("events-added-or-updated", {
        unpack: () => [eventVariant({
            id: "standup", startUnix: 11 * DAY_S + 3600, endUnix: 11 * DAY_S + 5400
        })]
    });
    assert.equal(emitted(manager, "selected-date-events-changed").length, 1,
        "the event lands on the selected day");

    // an external edit moves it to the next day, still inside the window
    proxy.instance.signal("events-added-or-updated", {
        unpack: () => [eventVariant({
            id: "standup", startUnix: 12 * DAY_S + 3600, endUnix: 12 * DAY_S + 5400,
            modTime: 2
        })]
    });

    assert.equal(manager._event_index.getByUnixKey(11 * DAY_S), null,
        "the old day's bucket is gone");
    assert.equal(emitted(manager, "selected-date-events-changed").length, 2,
        "and the open column is told the selected day changed");
});

test("added events spread across days and emit updates", () => {
    const manager = readyManager();
    manager._window_coordinator.current_selected_date = new FakeDateTime(11 * DAY_US);
    const varray = {
        unpack: () => [
            eventVariant({ id: "multi", startUnix: 10 * DAY_S + 3600, endUnix: 12 * DAY_S + 3600 })
        ]
    };
    proxy.instance.signal("events-added-or-updated", varray);

    assert.deepEqual(
        Object.keys(manager._event_index.eventsByDate).map(Number).sort((a, b) => a - b),
        [10 * DAY_S, 11 * DAY_S, 12 * DAY_S]);
    assert.equal(emitted(manager, "events-updated").length, 1);
    assert.equal(emitted(manager, "selected-date-events-changed").length, 1);
});

// The handler runs inside a DBus signal callback on the compositor thread:
// unpack() materialises the whole array, each EventData does a deep_unpack plus
// several GLib.DateTime constructions, and register() walks up to 50 day buckets
// per multi-day event. A shared calendar's initial 42-day window arrived as one
// unbounded synchronous burst on the thread that draws every window.
test("a huge event delivery is spread across turns", () => {
    const manager = readyManager();
    const events = Array.from({ length: 60 }, (_unused, index) => eventVariant({
        id: "ev" + index,
        startUnix: 10 * DAY_S + index * 60,
        endUnix: 10 * DAY_S + index * 60 + 30
    }));

    proxy.instance.signal("events-added-or-updated", { unpack: () => events });

    const built = () => manager._event_index.get(new FakeDateTime(10 * DAY_US)).length;
    assert.ok(built() > 0, "the first chunk lands immediately");
    assert.ok(built() < events.length, "the rest does not land in the same turn");

    // drain the idles the batch queued
    for (let guard = 0; guard < 10 && manager._event_batch_ids.length > 0; guard++) {
        fireTimer(manager._event_batch_ids[0]);
    }

    assert.equal(built(), events.length, "every event arrives");
    assert.deepEqual(manager._event_batch_ids, [], "and nothing is left armed");
});

test("queued event chunks retain the delivery watermark across a newer fetch", () => {
    const manager = readyManager();
    const month = new FakeDateTime(10 * DAY_US);
    manager._window_coordinator.current_selected_date = month;
    manager.fetch_month_events(month, true);
    const deliveryWatermark = manager.last_update_timestamp;
    const events = Array.from({ length: 26 }, (_unused, index) => eventVariant({
        id: "old-fetch-" + index,
        startUnix: 10 * DAY_S + index * 60,
        endUnix: 10 * DAY_S + index * 60 + 30
    }));

    proxy.instance.signal("events-added-or-updated", eventArrayVariant(events));
    assert.equal(manager._queued_event_records, 1, "one old-fetch event waits for an idle");

    manager.fetch_month_events(month, true);
    const replacementWatermark = manager.last_update_timestamp;
    assert.ok(replacementWatermark > deliveryWatermark);
    fireTimer(manager._event_batch_ids[0]);
    const indexed = manager._event_index.get(month);
    assert.equal(indexed._events["old-fetch-25"].last_update_timestamp,
        deliveryWatermark, "later chunks keep the signal's ingress watermark");
    drainEventMutations(manager);
    fireTimer(manager._gc_timer_id);
    assert.equal(manager._event_index.get(month), null,
        "successful replacement completion culls once the stream settles");
});

test("a successful empty range fetch clears stale events and reports the empty state", () => {
    const manager = readyManager();
    const month = new FakeDateTime(10 * DAY_US);
    manager._window_coordinator.current_selected_date = month;
    manager.fetch_month_events(month, true);
    registerDays(manager, makeEventData({
        id: "deleted-upstream",
        startUnix: 10 * DAY_S,
        endUnix: 10 * DAY_S + 60
    }));
    assert.ok(manager._event_index.get(month));
    const updatesBefore = emitted(manager, "events-updated").length;

    manager.fetch_month_events(month, true);

    // T699: the acknowledgement only says the request was accepted — the
    // server has merely *started* each calendar's asynchronous view — so the
    // stale rows stay up until the signal stream settles, rather than the
    // calendar flashing empty on every forced refresh
    assert.ok(manager._event_index.get(month),
        "the last known events survive the acknowledgement");
    assert.ok(manager._gc_timer_id > 0, "and the quiet window is armed instead");

    // no events follow: the range really is empty, and the window says so
    fireTimer(manager._gc_timer_id);

    assert.equal(manager._event_index.get(month), null);
    assert.equal(emitted(manager, "events-updated").length, updatesBefore + 1);
    assert.equal(emitted(manager, "selected-date-events-changed").at(-1).args[0], null);
});

// T699: cinnamon-calendar-server completes SetTimeRange as soon as it has
// *started* each calendar's asynchronous get_view(); the view is finished,
// connected and started later, and its initial objects-added signals later
// still. Treating the acknowledgement as delivery erased the month before its
// snapshot arrived.
test("a delayed non-empty snapshot is not erased by its own acknowledgement", () => {
    const manager = readyManager();
    const server = proxy.instance;
    const month = new FakeDateTime(10 * DAY_US);
    manager._window_coordinator.current_selected_date = month;
    manager.fetch_month_events(month, true);
    registerDays(manager, makeEventData({
        id: "already-on-screen",
        startUnix: 10 * DAY_S,
        endUnix: 10 * DAY_S + 60
    }));

    // the forced refresh is acknowledged before the server's views deliver
    manager.fetch_month_events(month, true);
    drainEventMutations(manager);
    assert.ok(manager._event_index.get(month),
        "the calendar does not flash empty while the snapshot is in flight");

    // ...and the snapshot lands during the quiet window
    server.signal("events-added-or-updated", eventArrayVariant([eventVariant({
        id: "delivered-late",
        startUnix: 10 * DAY_S + 120,
        endUnix: 10 * DAY_S + 180
    })]));
    drainEventMutations(manager);
    fireTimer(manager._gc_timer_id);

    const indexed = manager._event_index.get(month);
    assert.ok(indexed, "the delivered snapshot is what survives");
    assert.ok(indexed._events["delivered-late"], "the new event is indexed");
    assert.equal(indexed._events["already-on-screen"], undefined,
        "and the superseded one is culled, once the stream has settled");
});

// The server reports a view that fails to open only on its own stdout, so a
// failed view and a month with no events look identical from here. What must
// not happen is the pair being told apart *wrongly* — erasing on the
// acknowledgement made every failure look like a confirmed empty month.
test("a view that never delivers keeps the last events until the window closes", () => {
    const manager = readyManager();
    const month = new FakeDateTime(10 * DAY_US);
    manager._window_coordinator.current_selected_date = month;
    manager.fetch_month_events(month, true);
    registerDays(manager, makeEventData({
        id: "last-known",
        startUnix: 10 * DAY_S,
        endUnix: 10 * DAY_S + 60
    }));

    manager.fetch_month_events(month, true);
    drainEventMutations(manager);

    // the view failed server-side: no signal will ever arrive for this range
    assert.ok(manager._event_index.get(month)._events["last-known"],
        "the acknowledgement alone is not evidence the month is empty");
    assert.ok(manager._gc_timer_id > 0);

    // a mutation still draining defers the window rather than culling mid-stream
    manager._event_mutations.push({ type: "resync" });
    assert.equal(fireTimer(manager._gc_timer_id), false);
    assert.ok(manager._event_index.get(month), "an undrained queue defers the cull");
    assert.ok(manager._gc_timer_id > 0, "and re-arms the window");
    manager._event_mutations.length = 0;

    fireTimer(manager._gc_timer_id);
    assert.equal(manager._event_index.get(month), null);
});

test("a queued stale fetch completion cannot reconcile a newer generation", () => {
    const manager = readyManager();
    const server = proxy.instance;
    const month = new FakeDateTime(10 * DAY_US);
    manager._window_coordinator.current_selected_date = month;
    server.defer_time_ranges = true;

    manager.fetch_month_events(month, true);
    const events = Array.from({ length: 26 }, (_unused, index) => eventVariant({
        id: `stale-fetch-${index}`,
        startUnix: 10 * DAY_S + index * 60,
        endUnix: 10 * DAY_S + index * 60 + 30
    }));
    server.signal("events-added-or-updated", eventArrayVariant(events));
    server.complete_time_range(0, { id: "older-success" });
    assert.deepEqual(manager._event_mutations.map((mutation) => mutation.type),
        ["add", "fetch-complete"]);

    manager.fetch_month_events(month, true);
    drainEventMutations(manager);
    assert.equal(manager._event_index.get(month).length, events.length,
        "the old marker becomes inert once a newer fetch starts");

    server.complete_time_range(1, { id: "current-empty-success" });
    drainEventMutations(manager);
    // the current generation owns reconciliation — but it reconciles when the
    // signal stream settles (T699), not on the acknowledgement itself
    assert.equal(manager._event_index.get(month).length, events.length,
        "the acknowledgement alone erases nothing");
    fireTimer(manager._gc_timer_id);
    assert.equal(manager._event_index.get(month), null,
        "the current generation still owns authoritative reconciliation");
});

test("an oversized event message is rejected before any child is materialized", () => {
    const manager = readyManager();
    let childReads = 0;
    const logged = [];
    const originalLog = global.log;
    global.log = (message) => logged.push(String(message));

    proxy.instance.signal("events-added-or-updated", {
        get_size: () => MAX_EVENT_SIGNAL_BYTES + 1,
        n_children: () => 100000,
        get_child_value: () => {
            childReads++;
            return null;
        }
    });

    global.log = originalLog;
    assert.equal(childReads, 0, "the byte ceiling is checked before children");
    assert.equal(manager._event_index.overflowed, true);
    assert.equal(manager._queued_event_records, 0);
    assert.equal(manager._queued_event_bytes, 0);
    assert.equal(emitted(manager, "selected-date-events-changed").at(-1).args[2],
        true, "the UI receives an explicit overflow state");
    assert.ok(logged.some((line) => /safety limit/.test(line)));
});

test("a large signal retains and indexes only the bounded prefix", () => {
    const manager = readyManager();
    manager._window_coordinator.current_selected_date =
        new FakeDateTime(10 * DAY_US);
    const events = Array.from(
        { length: MAX_QUEUED_EVENT_RECORDS + 100 },
        (_unused, index) => eventVariant({
            id: `bounded-${index}`,
            startUnix: 10 * DAY_S + index,
            endUnix: 10 * DAY_S + index + 1
        }));

    proxy.instance.signal(
        "events-added-or-updated", eventArrayVariant(events, 1024 * 1024));

    const retained = manager._event_mutations
        .filter((mutation) => mutation.type === "add")
        .reduce((count, mutation) =>
            count + mutation.events.filter(Boolean).length, 0);
    assert.equal(retained, MAX_QUEUED_EVENT_RECORDS - 25);
    assert.equal(manager._queued_event_records, retained);
    assert.equal(manager._queued_event_bytes, 1024 * 1024);

    drainEventMutations(manager);
    const day = manager._event_index.get(new FakeDateTime(10 * DAY_US));
    assert.equal(day.length, MAX_QUEUED_EVENT_RECORDS);
    assert.equal(manager._event_index.overflowed, true);
    assert.equal(manager._queued_event_records, 0);
    assert.equal(manager._queued_event_bytes, 0);
});

test("fuzz: queued signal bursts stay within record and byte budgets", () => {
    const manager = readyManager();
    const random = makeRandom(0x570);
    let sequence = 0;

    for (let round = 0; round < 60; round++) {
        const count = 1 + Math.floor(random() * 300);
        const bytes = 1024 + Math.floor(random() * 512 * 1024);
        const events = Array.from({ length: count }, () => eventVariant({
            id: `burst-${sequence++}`,
            startUnix: 10 * DAY_S + sequence,
            endUnix: 10 * DAY_S + sequence + 1
        }));
        proxy.instance.signal(
            "events-added-or-updated", eventArrayVariant(events, bytes));

        const retained = manager._event_mutations
            .filter((mutation) => mutation.type === "add")
            .reduce((total, mutation) =>
                total + mutation.events.filter(Boolean).length, 0);
        assert.ok(retained <= MAX_QUEUED_EVENT_RECORDS);
        assert.equal(retained, manager._queued_event_records);
        assert.ok(manager._queued_event_bytes <= MAX_QUEUED_EVENT_BYTES);
        assert.ok(manager._event_mutations
            .filter((mutation) => mutation.type === "overflow").length <= 1);
    }

    drainEventMutations(manager);
    const day = manager._event_index.get(new FakeDateTime(10 * DAY_US));
    assert.ok(day.length <= MAX_QUEUED_EVENT_RECORDS);
    assert.equal(manager._event_index.overflowed, true);
    assert.equal(manager._queued_event_records, 0);
    assert.equal(manager._queued_event_bytes, 0);
});

test("a mutation flood collapses to one bounded authoritative resync", () => {
    const manager = readyManager();
    const browsed = new FakeDateTime(20 * DAY_US);
    manager._window_coordinator.current_selected_date = browsed;
    manager._window_coordinator.current_selected_signature = "2000-1-20";
    const events = Array.from({ length: 60 }, (_unused, index) => eventVariant({
        id: `before-resync-${index}`,
        startUnix: 10 * DAY_S + index,
        endUnix: 10 * DAY_S + index + 1
    }));
    proxy.instance.signal(
        "events-added-or-updated", eventArrayVariant(events));

    for (let index = 0; index < MAX_QUEUED_EVENT_MUTATIONS + 20; index++) {
        proxy.instance.signal("events-removed", `removed-${index}`);
    }

    assert.deepEqual(manager._event_mutations.map((mutation) => mutation.type),
        ["add", "resync"]);
    assert.equal(manager._queued_event_records, 35);
    assert.equal(manager._resync_mutation_queued, true);

    let inspected = false;
    proxy.instance.signal("events-added-or-updated", {
        get_size: () => {
            inspected = true;
            return 1;
        }
    });
    assert.equal(inspected, false,
        "signals behind an authoritative resync are not materialized");

    drainEventMutations(manager);
    assert.equal(manager._event_index.get(new FakeDateTime(10 * DAY_US)), null);
    assert.equal(manager._event_index.overflowed, true);
    assert.ok(manager._reload_selected_id > 0);
    assert.equal(manager._resync_overflow_pending, true);
    assert.equal(manager._queued_event_records, 0);
    assert.equal(manager._resync_mutation_queued, false);

    fireTimer(manager._reload_selected_id);
    assert.equal(manager.current_selected_date.to_unix(), browsed.to_unix(),
        "the resync reloads the browsed date instead of navigating to today");
    assert.equal(manager._resync_overflow_pending, false);
    assert.equal(manager._event_index.overflowed, false);
    assert.equal(emitted(manager, "selected-date-events-changed").at(-1).args[2],
        false, "the replacement range starts with a clean warning state");

    proxy.instance.signal("events-added-or-updated", {
        get_size: () => MAX_EVENT_SIGNAL_BYTES + 1,
        n_children: () => 1,
        get_child_value: () => {
            throw new Error("an oversized payload must not be read");
        }
    });
    assert.equal(manager._event_index.overflowed, true,
        "a replacement payload can raise its own independent warning");
});

test("bounded event decoding rejects malformed adapters", () => {
    assert.throws(() => boundedEventVariants(null, 1), /invalid/);
    assert.throws(() => boundedEventVariants({}, 1), /cannot be unpacked/);
    assert.throws(() => boundedEventVariants({ unpack: () => null }, 1),
        /not an array/);
    assert.throws(() => boundedEventVariants({
        get_size: () => NaN,
        unpack: () => []
    }, 1), /byte size/);
    assert.throws(() => boundedEventVariants({
        n_children: () => -1,
        get_child_value: () => null
    }, 1), /child count/);
});

test("a malformed event-array adapter is reported and becomes overflow", () => {
    const manager = readyManager();
    const errors = [];
    const originalLogError = global.logError;
    global.logError = (error) => errors.push(String(error));

    proxy.instance.signal("events-added-or-updated", {});

    global.logError = originalLogError;
    assert.ok(errors.some((line) => /cannot be unpacked/.test(line)));
    assert.equal(manager._event_index.overflowed, true);
    assert.equal(manager._event_mutations.length, 0);
});

// The chunking is there to keep the compositor responsive. Emitting per chunk
// undid it: every "events-updated" rebuilds the whole 42-cell grid and every
// "selected-date-events-changed" tears down and rebuilds the event column, so a
// 200-event delivery paid eight of each where one would do. It traded one long
// stall for eight shorter ones plus eight times the downstream work.
test("a chunked delivery repaints once, not once per chunk", () => {
    const manager = readyManager();
    manager._window_coordinator.current_selected_date = new FakeDateTime(10 * DAY_US);
    const events = Array.from({ length: 200 }, (_unused, index) => eventVariant({
        id: "ev" + index,
        startUnix: 10 * DAY_S + index * 60,
        endUnix: 10 * DAY_S + index * 60 + 30
    }));

    proxy.instance.signal("events-added-or-updated", { unpack: () => events });

    assert.equal(emitted(manager, "events-updated").length, 0,
        "nothing is repainted while the batch is still arriving");

    for (let guard = 0; guard < 20 && manager._event_batch_ids.length > 0; guard++) {
        fireTimer(manager._event_batch_ids[0]);
    }

    assert.equal(manager._event_index.get(new FakeDateTime(10 * DAY_US)).length, 200);
    assert.equal(emitted(manager, "events-updated").length, 1,
        "one grid rebuild for the whole delivery, not eight");
    assert.equal(emitted(manager, "selected-date-events-changed").length, 1,
        "and one event-column rebuild");
});

test("a newer update waits for the older chunked delivery", () => {
    const manager = readyManager();
    const fillers = Array.from({ length: 25 }, (_unused, index) => eventVariant({
        id: `filler-${index}`,
        startUnix: 10 * DAY_S,
        endUnix: 10 * DAY_S + 60
    }));
    const older = eventVariant({
        id: "same", summary: "old", modTime: 1,
        startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60
    });
    const newer = eventVariant({
        id: "same", summary: "new", modTime: 2,
        startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60
    });

    proxy.instance.signal("events-added-or-updated", {
        unpack: () => fillers.concat(older)
    });
    proxy.instance.signal("events-added-or-updated", { unpack: () => [newer] });
    drainEventMutations(manager);

    assert.equal(eventSummaries(manager).get("same"), "new");
});

test("a removal waits for an event in a deferred batch tail", () => {
    const manager = readyManager();
    const fillers = Array.from({ length: 25 }, (_unused, index) => eventVariant({
        id: `filler-${index}`,
        startUnix: 10 * DAY_S,
        endUnix: 10 * DAY_S + 60
    }));
    const doomed = eventVariant({
        id: "doomed", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60
    });

    proxy.instance.signal("events-added-or-updated", {
        unpack: () => fillers.concat(doomed)
    });
    proxy.instance.signal("events-removed", "doomed");
    drainEventMutations(manager);

    assert.equal(eventSummaries(manager).has("doomed"), false);
});

function randomAddMutation(random, sequence, minimum = 1) {
    const count = minimum + Math.floor(random() * 10);
    const events = [];
    const summaries = [];
    for (let index = 0; index < count; index++) {
        const id = `random-${Math.floor(random() * 12)}`;
        const summary = `value-${sequence.value}`;
        events.push(eventVariant({
            id, summary, modTime: sequence.value++,
            startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60
        }));
        summaries.push([id, summary]);
    }
    return { type: "add", events, summaries };
}

function randomMutation(random, sequence) {
    const roll = random();
    if (roll < 0.65) {
        return randomAddMutation(random, sequence);
    }
    if (roll < 0.9) {
        return { type: "remove", id: `random-${Math.floor(random() * 12)}` };
    }
    return { type: "clear" };
}

function applyMutationSignal(instance, reference, mutation) {
    if (mutation.type === "add") {
        instance.signal("events-added-or-updated", { unpack: () => mutation.events });
        mutation.summaries.forEach(([id, summary]) => reference.set(id, summary));
        return;
    }
    if (mutation.type === "remove") {
        instance.signal("events-removed", mutation.id);
        reference.delete(mutation.id);
        return;
    }
    instance.signal("client-disappeared", "calendar");
    reference.clear();
}

test("fuzz: queued calendar mutations match synchronous FIFO application", () => {
    const manager = readyManager();
    const random = makeRandom(0x565);
    const sequence = { value: 1 };
    const reference = new Map();

    for (let round = 0; round < 50; round++) {
        const burst = [randomAddMutation(random, sequence, 26)];
        const tail = Array.from(
            { length: 1 + Math.floor(random() * 7) },
            () => randomMutation(random, sequence));

        burst.concat(tail).forEach((mutation) =>
            applyMutationSignal(proxy.instance, reference, mutation));
        drainEventMutations(manager);

        assert.deepEqual(eventSummaries(manager), reference, `FIFO burst ${round}`);
    }
});

// ...and a batch abandoned half-way through must not repaint a menu that is gone
test("a delivery cut short by teardown repaints nothing", () => {
    const manager = readyManager();
    const events = Array.from({ length: 60 }, (_unused, index) => eventVariant({
        id: "ev" + index,
        startUnix: 10 * DAY_S + index * 60,
        endUnix: 10 * DAY_S + index * 60 + 30
    }));

    proxy.instance.signal("events-added-or-updated", { unpack: () => events });
    const queued = manager._event_batch_ids.slice();
    manager._destroyed = true;
    queued.forEach((id) => timers.pending.has(id) && fireTimer(id));

    assert.equal(emitted(manager, "events-updated").length, 0);
    assert.equal(manager._pending_emit, null);
});

test("a chunked delivery still in flight is cancelled on teardown", () => {
    const manager = readyManager();
    const events = Array.from({ length: 60 }, (_unused, index) => eventVariant({
        id: "ev" + index,
        startUnix: 10 * DAY_S + index * 60,
        endUnix: 10 * DAY_S + index * 60 + 30
    }));

    proxy.instance.signal("events-added-or-updated", { unpack: () => events });
    assert.ok(manager._event_batch_ids.length > 0, "chunks are still queued");
    const queued = manager._event_batch_ids.slice();

    manager.destroy();

    assert.deepEqual(manager._event_batch_ids, []);
    for (const id of queued) {
        assert.equal(timers.pending.has(id), false, "the queued chunk was removed");
    }
});

test("the mutation queue arms once and becomes terminal on teardown", () => {
    const manager = readyManager();
    manager._apply_next_event_mutation();
    assert.deepEqual(manager._event_batch_ids, [], "an empty queue arms nothing");

    manager._event_batch_ids.push(999);
    manager._schedule_event_mutation();
    assert.deepEqual(manager._event_batch_ids, [999], "an armed queue gets no duplicate idle");
    manager._event_batch_ids = [];

    manager.destroy();
    manager._enqueue_event_mutation({ type: "client-disappeared" });
    manager._schedule_event_mutation();
    assert.deepEqual(manager._event_mutations, []);
    assert.deepEqual(manager._event_batch_ids, []);
});

// one unusable event out of a feed costs that event, not the whole month — and
// not the shell: this runs inside a DBus signal handler on the compositor thread
test("an event with no usable times is skipped, not fatal", () => {
    const manager = readyManager();
    const logged = [];
    const originalLogError = global.logError;
    global.logError = (e) => logged.push(String(e));

    proxy.instance.signal("events-added-or-updated", {
        unpack: () => [
            eventVariant({ id: "good", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 }),
            // GLib.DateTime spans years 1 to 9999; this is outside it
            eventVariant({ id: "broken", startUnix: 1e18, endUnix: 1e18 })
        ]
    });
    global.logError = originalLogError;

    const day = manager._event_index.get(new FakeDateTime(10 * DAY_US));
    assert.deepEqual(day.get_event_list().map((event) => event.id), ["good"]);
    assert.ok(logged.some((line) => /usable start or end time/.test(line)),
        "and the one that was dropped says why");
});

// T579: the UID is unbounded wire TEXT, and the index retains every accepted
// one in a set, a map and per-day lists for the life of the window — so
// sequential near-cap deliveries could pin gigabytes inside Cinnamon, and the
// invalid-time skip echoed the raw UID (CR/LF and all) into the shell log.
test("an event with an unusable id is refused and never echoed to the log", () => {
    const manager = readyManager();
    manager._window_coordinator.current_selected_date = new FakeDateTime(11 * DAY_US);
    const logged = [];
    const originalLogError = global.logError;
    global.logError = (e) => logged.push(String(e));

    proxy.instance.signal("events-added-or-updated", {
        unpack: () => [
            eventVariant({
                id: "x".repeat(5000), startUnix: 11 * DAY_S, endUnix: 11 * DAY_S + 60
            }),
            eventVariant({
                id: "cr\r\nlf-uid", startUnix: 1e18, endUnix: 1e18
            })
        ]
    });
    global.logError = originalLogError;

    assert.deepEqual(manager._event_index.eventsByDate, {}, "nothing is indexed");
    assert.ok(logged.some((line) => /unusable id/.test(line)), "the skip is reported");
    assert.ok(!logged.some((line) => line.includes("xxxxxxxx")),
        "the oversized UID never reaches the log");
    assert.ok(!logged.some((line) => line.includes("lf-uid")),
        "and neither does the CR/LF one");
});

test("an oversized removal payload resyncs without retaining the bytes", () => {
    const manager = readyManager();
    manager._window_coordinator.current_month_year = new FakeDateTime(10 * DAY_US);
    proxy.instance.signal("events-added-or-updated", {
        unpack: () => [eventVariant({
            id: "keep", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60
        })]
    });

    proxy.instance.signal("events-removed", "y".repeat(5000));

    assert.deepEqual(manager._event_index.eventsByDate, {}, "the window is cleared");
    assert.equal(proxy.instance.set_time_range_calls.at(-1).force, true,
        "and repopulated from the authoritative server");
    assert.ok(!JSON.stringify(manager._event_mutations).includes("yyyyyyyy"),
        "the payload is not parked in the mutation queue");
});

test("ambiguous removed-event IDs clear and force-refetch the window", () => {
    const manager = readyManager();
    const browsed = new FakeDateTime(20 * DAY_US);
    manager._window_coordinator.current_selected_date = browsed;
    manager._window_coordinator.current_selected_signature = "2000-1-20";
    const ambiguousUid = "calendar-source:meeting::2026";
    manager._window_coordinator.current_month_year = new FakeDateTime(10 * DAY_US);
    const varray = {
        unpack: () => [eventVariant({
            id: ambiguousUid,
            startUnix: 10 * DAY_S,
            endUnix: 10 * DAY_S + 60
        })]
    };
    proxy.instance.signal("events-added-or-updated", varray);
    proxy.instance.signal("events-removed", ambiguousUid);

    assert.deepEqual(manager._event_index.eventsByDate, {},
        "a lossy delimiter payload cannot leave the intended event behind");
    assert.equal(proxy.instance.set_time_range_calls.at(-1).force, true,
        "the currently browsed window is repopulated from the calendar server");
    assert.equal(manager._reload_selected_id, 0,
        "the direct current-window fetch needs no second queued reload");
    assert.equal(manager.current_selected_date.to_unix(), browsed.to_unix(),
        "the removal does not own navigation");
    assert.ok(emitted(manager, "events-updated").length >= 2);
});

test("ambiguous removals defer reload until a selected window exists", () => {
    const manager = readyManager();

    proxy.instance.signal("events-removed", "calendar-source:meeting::2026");

    assert.ok(manager._reload_selected_id > 0,
        "startup races retain one bounded reload instead of inventing a month");
});

test("client disappearance rebuilds the event map via a forced reload", () => {
    const manager = readyManager();
    const browsed = new FakeDateTime(20 * DAY_US);
    manager._window_coordinator.current_selected_date = browsed;
    manager._window_coordinator.current_selected_signature = "2000-1-20";
    manager._event_index.eventsByDate[123] = {};
    const gridUpdates = emitted(manager, "events-updated").length;
    const agendaUpdates = emitted(manager, "selected-date-events-changed").length;
    proxy.instance.signal("client-disappeared", "uid");
    assert.deepEqual(manager._event_index.eventsByDate, {});
    assert.ok(manager._reload_selected_id > 0);
    assert.equal(emitted(manager, "events-updated").length, gridUpdates + 1,
        "the grid clears dots even when the replacement fetch is empty");
    assert.equal(emitted(manager, "selected-date-events-changed").length,
        agendaUpdates + 1, "the open agenda sees the same invalidation");
    fireTimer(manager._reload_selected_id);
    assert.equal(manager.current_selected_date.to_unix(), browsed.to_unix(),
        "client disappearance refetches without changing the browsed date");
});

test("status notifications reload only on real, known transitions", () => {
    const manager = readyManager();
    manager._server_connection._cached_state = 2;

    proxy.instance.status = 2;
    proxy.instance.signal("notify::status", null);
    assert.equal(emitted(manager, "has-calendars-changed").length, 0);

    proxy.instance.status = 0; // STATUS_UNKNOWN: owner vanished, not "no calendars"
    proxy.instance.signal("notify::status", null);
    assert.equal(emitted(manager, "has-calendars-changed").length, 0);

    proxy.instance.status = 1;
    proxy.instance.signal("notify::status", null);
    assert.equal(emitted(manager, "has-calendars-changed").length, 1);
    assert.equal(manager._reload_selected_id, 0,
        "status leaves the reload target to the calendar-aware composition root");
});

test("fetch_month_events requests the 42-cell window and resets on month change", () => {
    const manager = readyManager();
    manager.fetch_month_events(new FakeDateTime(40 * DAY_US), false);
    const call = proxy.instance.set_time_range_calls.at(-1);
    assert.equal(call.end - call.start, 42 * DAY_S - 1);

    manager._event_index.eventsByDate[999] = {};
    manager.fetch_month_events(new FakeDateTime(40 * DAY_US), false);
    assert.equal(proxy.instance.set_time_range_calls.length, 1, "same month, no force: skipped");

    manager.fetch_month_events(new FakeDateTime(80 * DAY_US), false);
    assert.deepEqual(manager._event_index.eventsByDate, {});
});

test("select_date is gated on is_active and skips unchanged dates", () => {
    const inactive = makeManager(false);
    inactive.select_date(new Date(0), false);
    assert.equal(emitted(inactive, "selected-date-changed").length, 0);

    const manager = readyManager();
    manager.select_date(new Date(50 * DAY_S * 1000), false);
    assert.equal(emitted(manager, "selected-date-changed").length, 1);
    manager.select_date(new Date(50 * DAY_S * 1000 + 3600 * 1000), false);
    assert.equal(emitted(manager, "selected-date-changed").length, 1, "same day skipped");
});

test("select_date skips unchanged dates before GLib conversion", () => {
    const manager = readyManager();
    manager.select_date(new Date(50 * DAY_S * 1000), false);

    const originalNewLocal = global.imports.gi.GLib.DateTime.new_local;
    let conversions = 0;
    global.imports.gi.GLib.DateTime.new_local = (year, month, day) => {
        conversions++;
        return originalNewLocal(year, month, day);
    };

    try {
        manager.select_date(new Date(50 * DAY_S * 1000 + 3600 * 1000), false);
        manager.select_date(new Date(50 * DAY_S * 1000 + 7200 * 1000), false);
    } finally {
        global.imports.gi.GLib.DateTime.new_local = originalNewLocal;
    }

    assert.equal(conversions, 0);
    assert.equal(emitted(manager, "selected-date-changed").length, 1);
});

test("gc timer culls stale events and reports", () => {
    const manager = readyManager();
    proxy.instance.signal("events-added-or-updated", {
        unpack: () => [eventVariant({ id: "old", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 })]
    });
    manager.last_update_timestamp = 10 ** 9;
    // the ingest above emits too; this round's emits are the ones being asserted
    const before = emitted(manager, "events-updated").length;
    manager._start_gc_timer();
    fireTimer(manager._gc_timer_id);
    // the emptied day is dropped, so the day reads as "no events" instead of
    // rendering an empty list
    assert.equal(manager._event_index.eventsByDate[10 * DAY_S], undefined);
    assert.equal(manager._event_index.getByUnixKey(10 * DAY_S), null);

    // ...and it says so. The test was called "and reports" and asserted only the
    // index: renaming the signal to anything at all left the suite green, and
    // 5.4/calendar.js is its only subscriber — so the grid kept the event dots of
    // events the GC had just deleted, until something else happened to repaint it.
    assert.equal(emitted(manager, "events-updated").length, before + 1,
        "the grid is told to repaint, and by that name");
});

// nothing culled means nothing to repaint: an emit here would rebuild the grid's
// dots every gc period for no reason
test("a gc round that culls nothing tells nobody", () => {
    const manager = readyManager();
    proxy.instance.signal("events-added-or-updated", {
        unpack: () => [eventVariant({ id: "live", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 })]
    });
    manager.last_update_timestamp = 0;
    const before = emitted(manager, "events-updated").length;
    manager._start_gc_timer();
    fireTimer(manager._gc_timer_id);

    assert.equal(emitted(manager, "events-updated").length, before,
        "nothing was culled, so nothing was said");
});

test("gc defers until a chunked event mutation stream has drained", () => {
    const manager = readyManager();
    const day = new FakeDateTime(10 * DAY_US);
    registerDays(manager, makeEventData({
        id: "stale-before-delivery",
        startUnix: 10 * DAY_S,
        endUnix: 10 * DAY_S + 30
    }));
    manager.last_update_timestamp = 100;
    const events = Array.from({ length: 26 }, (_unused, index) => eventVariant({
        id: `fresh-${index}`,
        startUnix: 10 * DAY_S + 60 + index * 60,
        endUnix: 10 * DAY_S + 90 + index * 60
    }));

    proxy.instance.signal("events-added-or-updated", eventArrayVariant(events));
    const firstGc = manager._gc_timer_id;
    assert.ok(manager._event_mutations.length > 0);
    fireTimer(firstGc);

    assert.ok(manager._gc_timer_id > 0);
    assert.notEqual(manager._gc_timer_id, firstGc);
    assert.ok(manager._event_index.get(day).get_ids().includes("stale-before-delivery"),
        "the incomplete stream is not reconciled early");

    drainEventMutations(manager);
    fireTimer(manager._gc_timer_id);
    assert.ok(!manager._event_index.get(day).get_ids().includes("stale-before-delivery"));
});

test("a failed month fetch is retried with backoff", () => {
    const manager = readyManager();
    const server = proxy.instance;
    let failures = 2;
    server.call_set_time_range_finish = () => {
        if (failures > 0) {
            failures--;
            throw new Error("dbus went away");
        }
    };

    manager.select_date(new Date(50 * DAY_S * 1000), true);
    const initialCalls = server.set_time_range_calls.length;
    assert.ok(initialCalls > 0);
    assert.ok(manager._fetch_retry_id > 0, "a failed fetch schedules a retry");
    assert.deepEqual(
        emitted(manager, "refresh-error-changed").map((signal) => signal.args[0]),
        [true], "the footer is told as soon as the refresh fails");

    fireTimer(manager._fetch_retry_id);
    assert.equal(server.set_time_range_calls.length, initialCalls + 1, "the month is refetched");
    assert.equal(server.set_time_range_calls.at(-1).force, true);

    // the second retry succeeds and the attempt counter resets
    fireTimer(manager._fetch_retry_id);
    assert.equal(manager._fetch_retry_attempts, 0);
    assert.equal(manager._fetch_retry_id, 0);
    assert.deepEqual(
        emitted(manager, "refresh-error-changed").map((signal) => signal.args[0]),
        [true, false], "a successful retry clears the footer issue");
});

test("only the latest month completion owns refresh and retry state", () => {
    const manager = readyManager();
    const server = proxy.instance;
    server.defer_time_ranges = true;

    manager.fetch_month_events(new FakeDateTime(40 * DAY_US), true);
    manager.fetch_month_events(new FakeDateTime(80 * DAY_US), true);
    server.complete_time_range(1, { id: "new-failure", error: new Error("new failed") });
    const retryId = manager._fetch_retry_id;
    assert.equal(manager._refresh_failed, true);
    assert.ok(retryId > 0);
    assert.equal(manager._fetch_retry_attempts, 1);

    server.complete_time_range(0, { id: "old-success" });
    assert.equal(manager._refresh_failed, true,
        "an older success cannot hide the current failure");
    assert.equal(manager._fetch_retry_id, retryId,
        "an older success cannot cancel the current retry");
    assert.equal(manager._fetch_retry_attempts, 1);

    manager.fetch_month_events(new FakeDateTime(120 * DAY_US), true);
    assert.equal(manager._fetch_retry_id, 0,
        "a fresh request replaces the previous month's retry");
    manager.fetch_month_events(new FakeDateTime(160 * DAY_US), true);
    server.complete_time_range(3, { id: "new-success" });
    server.complete_time_range(2, { id: "old-failure", error: new Error("old failed") });
    assert.equal(manager._refresh_failed, false,
        "an older failure cannot replace the current success");
    assert.equal(manager._fetch_retry_id, 0);
    assert.equal(manager._fetch_retry_attempts, 0);
    assert.deepEqual(
        server.finished_time_ranges.map((result) => result.id),
        ["new-failure", "old-success", "new-success", "old-failure"],
        "every Gio result is finished even when its state effects are stale");
});

function shuffledIndices(length, random) {
    const remaining = Array.from({ length }, (_, index) => index);
    const result = [];
    while (remaining.length > 0) {
        result.push(remaining.splice(
            Math.floor(random() * remaining.length), 1)[0]);
    }
    return result;
}

function dispatchFuzzRanges(manager, count) {
    for (let request = 0; request < count; request++) {
        manager.fetch_month_events(
            new FakeDateTime((40 + request * 40) * DAY_US), true);
    }
}

function completeFuzzRanges(manager, server, failures, order, round) {
    let expectedFailure = false;
    for (const completed of order) {
        server.complete_time_range(completed, {
            id: `${round}:${completed}`,
            error: failures[completed] ? new Error("range failed") : null
        });
        if (completed === failures.length - 1) {
            expectedFailure = failures[completed];
        }
        assert.equal(manager._refresh_failed, expectedFailure);
        assert.equal(manager._fetch_retry_id > 0, expectedFailure);
        assert.equal(manager._fetch_retry_attempts, expectedFailure ? 1 : 0);
    }
}

function fuzzRangeCompletionRound(round, random) {
    const manager = readyManager();
    const server = proxy.instance;
    server.defer_time_ranges = true;
    const count = 2 + Math.floor(random() * 6);
    const failures = Array.from({ length: count }, () => random() < 0.5);

    dispatchFuzzRanges(manager, count);
    completeFuzzRanges(
        manager, server, failures, shuffledIndices(count, random), round);

    assert.equal(server.finished_time_ranges.length, count);
    manager.destroy();
}

test("fuzz: range completion permutations follow the latest request", () => {
    const random = makeRandom(0x572);

    for (let round = 0; round < 80; round++) {
        fuzzRangeCompletionRound(round, random);
    }
});

test("destroy cancels one queued fetch retry and duplicate queues are ignored", () => {
    const manager = readyManager();

    manager._queue_fetch_retry();
    const retryId = manager._fetch_retry_id;
    assert.ok(timers.pending.has(retryId));

    manager._queue_fetch_retry();
    assert.equal(manager._fetch_retry_id, retryId,
        "one failure chain owns one retry timer");

    manager.destroy();
    assert.equal(manager._fetch_retry_id, 0);
    assert.equal(timers.pending.has(retryId), false,
        "destroy removes the queued callback from the main loop");
});

test("a dispatched fetch retry becomes a no-op after teardown", () => {
    const manager = readyManager();
    manager.select_date(new Date(50 * DAY_S * 1000), true);
    const callsBefore = proxy.instance.set_time_range_calls.length;

    manager._queue_fetch_retry();
    const retryId = manager._fetch_retry_id;
    // Model the narrow race where GLib has dispatched the callback just before
    // destroy can remove its source.
    manager._destroyed = true;

    assert.equal(fireTimer(retryId), false);
    assert.equal(manager._fetch_retry_id, 0);
    assert.equal(proxy.instance.set_time_range_calls.length, callsBefore,
        "a late callback cannot touch the calendar server");
});

// the retry was the one caller that reached fetch_month_events without asking
// is_active() first — so if EDS died while it sat queued, it dereferenced a
// null proxy inside a GLib callback and the retry chain died there, silently
// A retry that fires while EDS is gone can make no request. Re-queueing there
// burned an attempt for a fetch that never happened, so restarting
// evolution-data-server with the menu open spent the whole five-attempt budget
// in 155 seconds without a single request leaving the applet — and then the
// chain was dead, with nothing logged and the previous month still on the grid.
test("a retry that fires after the calendar server died stands down with a full budget", () => {
    const manager = readyManager();
    const server = proxy.instance;
    server.call_set_time_range_finish = () => {
        throw new Error("dbus went away");
    };

    manager.select_date(new Date(50 * DAY_S * 1000), true);
    assert.ok(manager._fetch_retry_id > 0, "a failed fetch schedules a retry");
    assert.equal(manager._fetch_retry_attempts, 1);

    // EDS disappears entirely while the retry is queued
    manager._server_connection._calendar_server = null;
    const callsBefore = server.set_time_range_calls.length;

    assert.doesNotThrow(() => fireTimer(manager._fetch_retry_id));

    assert.equal(server.set_time_range_calls.length, callsBefore, "nothing is called on a dead proxy");
    assert.equal(manager._fetch_retry_attempts, 0,
        "an attempt that made no request costs nothing");
    // there is nothing to poll for: the name reappearing, a status change and
    // the user re-enabling events all end in a forced fetch of their own
    assert.equal(manager._fetch_retry_id, 0, "and no pointless polling is left armed");
});

test("a fetch that keeps failing gives up out loud", () => {
    const logged = [];
    const originalLog = global.log;
    global.log = (message) => logged.push(String(message));

    const manager = readyManager();
    proxy.instance.call_set_time_range_finish = () => {
        throw new Error("dbus is broken");
    };

    manager.select_date(new Date(50 * DAY_S * 1000), true);
    // each retry fires, fails, and queues the next one until the budget is out
    for (let attempt = 0; attempt < 10 && manager._fetch_retry_id > 0; attempt++) {
        fireTimer(manager._fetch_retry_id);
    }
    global.log = originalLog;

    assert.equal(manager._fetch_retry_id, 0, "the chain ends");
    assert.equal(manager._fetch_retry_attempts, 5,
        "the fifth retry exhausts the budget; a sixth is never armed");
    assert.equal(proxy.instance.set_time_range_calls.length, 6,
        "one initial fetch plus exactly five retries reach EDS");
    assert.ok(logged.some((line) => /giving up on this month/.test(line)),
        "an exhausted retry chain that says nothing cannot be told from an outage");
});

test("removing an event refreshes the open list right away", () => {
    const manager = readyManager();
    const selected = new FakeDateTime(10 * DAY_US);
    manager._window_coordinator.current_selected_date = selected;

    proxy.instance.signal("events-added-or-updated", {
        unpack: () => [
            eventVariant({ id: "keep", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 }),
            eventVariant({ id: "drop", startUnix: 10 * DAY_S + 120, endUnix: 10 * DAY_S + 180 })
        ]
    });

    const emitted = [];
    manager.connect("selected-date-events-changed", (em, list) => emitted.push(list));

    proxy.instance.signal("events-removed", "drop");

    assert.equal(emitted.length, 1, "the selected day is re-fed without waiting for a reselect");
    assert.equal(emitted[0].length, 1);
    assert.equal(emitted[0]._events["drop"], undefined);
});

test("culling the selected day's last event reports no events, not an empty list", () => {
    const manager = readyManager();
    const selected = new FakeDateTime(10 * DAY_US);
    manager._window_coordinator.current_selected_date = selected;

    proxy.instance.signal("events-added-or-updated", {
        unpack: () => [eventVariant({ id: "only", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 })]
    });

    const emitted = [];
    manager.connect("selected-date-events-changed", (em, list) => emitted.push(list));

    // the event is deleted in the calendar app: the next fetch omits it, and
    // the gc culls it
    manager.last_update_timestamp = 10 ** 9;
    manager._start_gc_timer();
    fireTimer(manager._gc_timer_id);

    assert.deepEqual(emitted, [null], "the event list must fall back to the No Events placeholder");
});

test("get_colors_for_unix_key returns null without data and colors with", () => {
    const manager = readyManager();
    assert.equal(manager.get_colors_for_unix_key(10 * DAY_S), null);
    proxy.instance.signal("events-added-or-updated", {
        unpack: () => [eventVariant({ id: "a", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 })]
    });
    assert.deepEqual(manager.get_colors_for_unix_key(10 * DAY_S), ["#abc"]);
});

test("EventIndex owns event bucket mutation, removal, culling, and colors", () => {
    const index = new EventIndex();
    const selected = new FakeDateTime(11 * DAY_US);
    const event = makeEventData({
        id: "index",
        color: "#def",
        startUnix: 10 * DAY_S + 3600,
        endUnix: 11 * DAY_S + 7200
    });

    const first = index.register(event, 1, selected);
    assert.deepEqual(first, { changed: true, selected_changed: true });
    assert.deepEqual(Object.keys(index.eventsByDate).map(Number).sort((a, b) => a - b), [10 * DAY_S, 11 * DAY_S]);
    assert.deepEqual(index.getColorsByUnixKey(11 * DAY_S), ["#def"]);
    assert.equal(index.get(selected), index.eventsByDate[11 * DAY_S]);
    assert.equal(index.getByUnixKey(11 * DAY_S), index.eventsByDate[11 * DAY_S]);
    assert.equal(index.register(event, 1, selected).changed, false);

    const update = index.addOrUpdate([
        eventVariant({ id: "other", startUnix: 12 * DAY_S, endUnix: 12 * DAY_S + 60 })
    ], 2, selected);
    assert.deepEqual(update, { events_changed: true, selected_date_changed: false });

    index.remove(["index"]);
    assert.equal(index.getByUnixKey(10 * DAY_S), null);
    assert.equal(index.cull(10 ** 9), true);
    index.clear();
    assert.deepEqual(index.eventsByDate, {});
    assert.equal(index.get(selected), null);
    assert.equal(index.getColorsByUnixKey(11 * DAY_S), null);
});

// The quiet-window timer arms cull() after every fetch, and the delivery that
// armed it has usually just re-reported everything the index holds — so the
// common case removes nothing. Rebuilding the id state there is work with no
// result: nothing can desynchronise it from the buckets unless a row was
// dropped. Counting the rebuilds is the only way to pin that, because a
// redundant rebuild produces exactly the state the skipped one would have.
test("EventIndex rebuilds its id state only when a cull actually drops a row", () => {
    const index = new EventIndex();
    const selected = new FakeDateTime(10 * DAY_US);
    index.addOrUpdate([
        eventVariant({ id: "kept", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 })
    ], 5, selected);

    let rebuilds = 0;
    const realRebuild = index._rebuildEventState.bind(index);
    index._rebuildEventState = () => {
        rebuilds++;
        realRebuild();
    };

    assert.equal(index.cull(5), false, "nothing is older than the watermark");
    assert.equal(rebuilds, 0, "a cull that removes nothing rebuilds nothing");
    assert.equal(index.get(selected).has("kept"), true, "and the day still holds it");

    assert.equal(index.cull(6), true, "now the event is behind the watermark");
    assert.equal(rebuilds, 1, "the removal is what earns the rebuild");
    // the id state has to follow the buckets, or the ceiling never frees up and
    // a re-delivery of the same UID is refused as a duplicate
    assert.equal(index._eventIds.has("kept"), false);
    assert.equal(index._eventsById.has("kept"), false);
    assert.equal(index.addOrUpdate([
        eventVariant({ id: "kept", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 })
    ], 7, selected).events_changed, true, "the culled UID can come back");
});

test("EventIndex bounds distinct window events and recovers capacity", () => {
    const index = new EventIndex({}, 3);
    const selected = new FakeDateTime(10 * DAY_US);
    const events = Array.from({ length: 5 }, (_unused, id) => eventVariant({
        id: `cap-${id}`,
        startUnix: 10 * DAY_S + id,
        endUnix: 10 * DAY_S + id + 1
    }));

    const first = index.addOrUpdate(events, 1, selected);
    assert.deepEqual(first, {
        events_changed: true,
        selected_date_changed: true,
        overflow_changed: true
    });
    assert.equal(index.get(selected).length, 3);
    assert.equal(index.overflowed, true);
    assert.equal(index.clearOverflow(), true);
    assert.equal(index.clearOverflow(), false);
    assert.equal(index.markOverflow(), true);

    index.remove(["cap-0"]);
    assert.equal(index.addOrUpdate([eventVariant({
        id: "replacement",
        startUnix: 10 * DAY_S + 10,
        endUnix: 10 * DAY_S + 11
    })], 2, selected).events_changed, true);
    assert.deepEqual(index.get(selected).get_ids().sort(),
        ["cap-1", "cap-2", "replacement"]);

    index.clear();
    assert.equal(index.overflowed, false);
    assert.equal(index.get(selected), null);
});

// Africa/Cairo moves its clocks forward at midnight: on 2023-04-28 there is no
// local 00:00, so date_only() resolves to 01:00. add_days() preserves h:m:s, so
// every later day of a multi-day event used to be keyed an hour off the value
// the grid and the event column look up — the event vanished from day two on,
// and the span never terminated, leaving ~50 phantom buckets behind.
test("a multi-day event keeps canonical day keys across a midnight DST jump", () => {
    const HOUR_US = 3600 * 1000000;
    const JUMP_DAY = 10;
    const clock = global.imports.gi.GLib.DateTime;
    const originalNewLocal = clock.new_local;
    clock.new_local = (year, month, day) => new FakeDateTime(
        day * DAY_US + (day === JUMP_DAY ? HOUR_US : 0));

    try {
        const index = new EventIndex();
        const selected = new FakeDateTime(12 * DAY_US);
        const result = index.register(makeEventData({
            id: "spanning",
            startUnix: JUMP_DAY * DAY_S + 4 * 3600,
            endUnix: 12 * DAY_S + 4 * 3600
        }), 1, selected);

        assert.deepEqual(
            Object.keys(index.eventsByDate).map(Number).sort((a, b) => a - b),
            [JUMP_DAY * DAY_S + 3600, 11 * DAY_S, 12 * DAY_S],
            "one bucket per covered day, each at the key that day resolves to");
        assert.ok(index.get(new FakeDateTime(11 * DAY_US)),
            "the day after the transition is reachable at its canonical key");
        assert.equal(result.selected_changed, true,
            "and the selected day is recognised as covered");
    } finally {
        clock.new_local = originalNewLocal;
    }
});

// Every bucket key is an absolute second derived from the zone the event was
// indexed in. After a zone change the grid looks days up in the new one, so
// retaining them means dots that never match again.
test("an OS timezone change discards the indexed buckets and refetches", () => {
    const manager = readyManager();
    const month = new FakeDateTime(10 * DAY_US);
    manager._window_coordinator.current_selected_date = month;
    manager.select_date(new Date(10 * DAY_S * 1000), true);
    proxy.instance.signal("events-added-or-updated", eventArrayVariant([eventVariant({
        id: "before-the-change",
        startUnix: 10 * DAY_S,
        endUnix: 10 * DAY_S + 60
    })]));
    drainEventMutations(manager);
    assert.ok(Object.keys(manager._event_index.eventsByDate).length > 0);

    manager.refresh_for_timezone_change();

    assert.deepEqual(manager._event_index.eventsByDate, {},
        "old-zone buckets can never match a new-zone lookup");
    assert.ok(manager._reload_selected_id > 0, "and the window is asked for again");

    const before = proxy.instance.set_time_range_calls.length;
    fireTimer(manager._reload_selected_id);
    assert.equal(proxy.instance.set_time_range_calls.length, before + 1);
});

// Only clear() and the full-range resync used to retire the flag, so garbage
// collecting a flood back down to a handful left the event column still
// telling the user rows were hidden on a day now holding three.
test("shrinking the index back under the ceiling retires the overflow notice", () => {
    const index = new EventIndex({}, 3);
    const selected = new FakeDateTime(10 * DAY_US);
    const flood = Array.from({ length: 5 }, (_unused, id) => eventVariant({
        id: `flood-${id}`,
        startUnix: 10 * DAY_S + id,
        endUnix: 10 * DAY_S + id + 1
    }));

    index.addOrUpdate(flood, 1, selected);
    assert.equal(index.overflowed, true);

    assert.equal(index.remove([]), false, "a removal that frees nothing changes nothing");
    assert.equal(index.overflowed, true);

    assert.equal(index.remove(["flood-0"]), true, "freeing a slot reports the change");
    assert.equal(index.overflowed, false);

    index.addOrUpdate([eventVariant({
        id: "late", startUnix: 10 * DAY_S + 9, endUnix: 10 * DAY_S + 10
    })], 2, selected);
    assert.equal(index.overflowed, false, "the freed slot admits the next event");

    index.addOrUpdate([eventVariant({
        id: "later", startUnix: 10 * DAY_S + 11, endUnix: 10 * DAY_S + 12
    })], 3, selected);
    assert.equal(index.overflowed, true, "and the next refusal arms it again");

    assert.equal(index.cull(4), true);
    assert.equal(index.overflowed, false, "a cull retires it on the same rule");
});

// _spannedDays owns the day identities the whole index is keyed by, so it
// normalises its own bounds rather than trusting the caller to have done it.
test("a span covers whole days and terminates however its bounds are given", () => {
    const index = new EventIndex();
    const midDay = (day, hours) => new FakeDateTime(day * DAY_US + hours * 3600 * 1000000);
    const covered = (bounds) => index._spannedDays(bounds).map((day) => day.to_unix());

    assert.deepEqual(covered({ start: midDay(10, 9), end: midDay(11, 5) }),
        [10 * DAY_S, 11 * DAY_S], "an end mid-day closes the span on that day");
    assert.deepEqual(covered({ start: midDay(11, 0), end: midDay(10, 0) }),
        [11 * DAY_S], "an end before the start stops rather than running to the ceiling");
});

test("an event covering more of the window than the ceiling allows is reported", () => {
    const logged = [];
    const originalLogError = global.logError;
    global.logError = (e) => logged.push(String(e));

    try {
        const index = new EventIndex();
        index.register(makeEventData({
            id: "endless",
            startUnix: 10 * DAY_S,
            endUnix: 200 * DAY_S
        }), 1, new FakeDateTime(10 * DAY_US));

        assert.equal(Object.keys(index.eventsByDate).length, 51,
            "the ceiling still bounds the retained buckets");
        assert.deepEqual(logged.length, 1, "and the clipping is not silent");
        assert.match(logged[0], /more than 51 days/);
    } finally {
        global.logError = originalLogError;
    }
});

test("fuzz: moving one event cannot accumulate stale day buckets", () => {
    const index = new EventIndex({}, 1);
    const random = makeRandom(0x5701);
    let finalDay = 0;

    for (let revision = 1; revision <= 300; revision++) {
        finalDay = 10 + Math.floor(random() * 3000);
        const event = makeEventData({
            id: "moving",
            modTime: revision,
            startUnix: finalDay * DAY_S,
            endUnix: finalDay * DAY_S + 60
        });
        assert.equal(index.register(
            event, revision, new FakeDateTime(finalDay * DAY_US)).changed, true);
        assert.ok(Object.keys(index.eventsByDate).length <= 1,
            "replaced locations are released immediately");
        assert.equal(index._eventIds.size, 1);
    }

    assert.deepEqual(Object.keys(index.eventsByDate).map(Number),
        [finalDay * DAY_S]);
    assert.equal(index.overflowed, false);
});

test("EventWindowCoordinator owns fetch-window and selected-date coordination", () => {
    const index = new EventIndex();
    const coordinator = new EventWindowCoordinator(index);
    const calls = [];
    const emittedEvents = [];
    // the coordinator is handed a setTimeRange function now, not the proxy: the
    // connection owns the proxy and exposes this bound method
    const setTimeRange = (start, end, force, cancellable, watermark) => {
        calls.push({ start, end, force, cancellable, watermark });
    };
    let timestamp = 40;
    const month = new FakeDateTime(40 * DAY_US);

    assert.equal(coordinator.fetchMonthEvents(
        month, false, setTimeRange, () => ++timestamp), 41);
    assert.equal(calls[0].end - calls[0].start, 42 * DAY_S - 1);
    assert.equal(calls[0].watermark, 41);
    assert.equal(index._windowStart.to_unix(), calls[0].start);
    assert.equal(index._windowEnd.to_unix(), calls[0].end - (DAY_S - 1));
    assert.equal(coordinator.fetchMonthEvents(
        month, false, setTimeRange, () => ++timestamp), null);
    assert.equal(coordinator.fetchMonthEvents(
        month, true, setTimeRange, () => ++timestamp), 42);
    assert.equal(calls[1].watermark, 42);
    assert.equal(calls.length, 2);

    const selected = new FakeDateTime(50 * DAY_US);
    index.eventsByDate[selected.to_unix()] = { marker: "cached", length: 1 };
    coordinator.selectDate(
        new Date(50 * DAY_S * 1000),
        false,
        () => false,
        () => { throw new Error("inactive selection should not fetch"); },
        () => { throw new Error("inactive selection should not emit"); }
    );
    coordinator.selectDate(
        new Date(50 * DAY_S * 1000),
        false,
        () => true,
        (monthYear, force) => emittedEvents.push(["fetch", force, monthYear.to_unix()]),
        (name, ...args) => emittedEvents.push([name, ...args])
    );

    assert.equal(coordinator.current_selected_date.to_unix(), selected.to_unix());
    assert.equal(emittedEvents.some((event) => event[0] === "selected-date-changed"), true);
    assert.equal(emittedEvents.at(-1)[0], "selected-date-events-changed");
    assert.equal(emittedEvents.at(-1)[1], index.eventsByDate[selected.to_unix()]);

    coordinator.current_selected_signature = null;
    coordinator.selectDate(
        new Date(50 * DAY_S * 1000),
        false,
        () => true,
        () => { throw new Error("an unchanged GDate must not fetch"); },
        () => { throw new Error("an unchanged GDate must not emit"); }
    );
    assert.notEqual(coordinator.current_selected_signature, null);
});

test("day registration: single-day event touches exactly one bucket", () => {
    const manager = readyManager();
    const data = makeEventData({ startUnix: 10 * DAY_S + 3600, endUnix: 10 * DAY_S + 7200 });
    const result = registerDays(manager, data);
    assert.equal(result.changed, true);
    assert.deepEqual(Object.keys(manager._event_index.eventsByDate), [String(10 * DAY_S)]);
});

test("day registration: multi-day event fills every day it spans", () => {
    const manager = readyManager();
    const data = makeEventData({ startUnix: 10 * DAY_S, endUnix: 13 * DAY_S + 60 });
    registerDays(manager, data);
    assert.equal(Object.keys(manager._event_index.eventsByDate).length, 4);
});

test("day registration: selected-date flag fires only when that day changes", () => {
    const manager = readyManager();
    manager._window_coordinator.current_selected_date = new FakeDateTime(12 * DAY_US);
    const inside = registerDays(manager,
        makeEventData({ startUnix: 10 * DAY_S, endUnix: 13 * DAY_S }));
    assert.equal(inside.selected_changed, true);

    manager._window_coordinator.current_selected_date = new FakeDateTime(20 * DAY_US);
    const outside = registerDays(manager,
        makeEventData({ id: "other", startUnix: 10 * DAY_S, endUnix: 13 * DAY_S }));
    assert.equal(outside.selected_changed, false);
});

test("day registration intersects a long event with each active fetch window", () => {
    const index = new EventIndex();
    const event = makeEventData({ startUnix: 10 * DAY_S, endUnix: 1010 * DAY_S });
    const selected = new FakeDateTime(65 * DAY_US);

    // The old start-relative escape ended at event offset 50 (day 60), so
    // offsets 51 and 55 disappeared even when the server returned the event
    // for this later window.
    index.setWindow(new FakeDateTime(60 * DAY_US), new FakeDateTime(101 * DAY_US));
    assert.equal(index.register(event, 1, selected).selected_changed, true);
    assert.equal(Object.keys(index.eventsByDate).length, 42);
    assert.ok(index.getByUnixKey(60 * DAY_S));
    assert.ok(index.getByUnixKey(61 * DAY_S));
    assert.ok(index.getByUnixKey(65 * DAY_S));
    assert.ok(index.getByUnixKey(101 * DAY_S));
    assert.equal(index.getByUnixKey(59 * DAY_S), null);
    assert.equal(index.getByUnixKey(102 * DAY_S), null);

    // Browsing farther into the same event gets a fresh bounded intersection,
    // not buckets tied to the event's original start.
    index.clear();
    index.setWindow(new FakeDateTime(200 * DAY_US), new FakeDateTime(241 * DAY_US));
    index.register(event, 2, new FakeDateTime(220 * DAY_US));
    assert.equal(Object.keys(index.eventsByDate).length, 42);
    assert.ok(index.getByUnixKey(200 * DAY_S));
    assert.ok(index.getByUnixKey(241 * DAY_S));
});

test("an EventIndex without a fetch window retains a bounded safety escape", () => {
    const index = new EventIndex();
    index.register(
        makeEventData({ startUnix: 10 * DAY_S, endUnix: 1010 * DAY_S }),
        1,
        new FakeDateTime(10 * DAY_US));
    assert.equal(Object.keys(index.eventsByDate).length, 51);
});

test("an event updated outside the active window releases its old buckets", () => {
    const index = new EventIndex();
    const selected = new FakeDateTime(12 * DAY_US);
    index.setWindow(new FakeDateTime(10 * DAY_US), new FakeDateTime(20 * DAY_US));
    index.register(makeEventData({
        id: "moved", startUnix: 12 * DAY_S, endUnix: 12 * DAY_S + 60
    }), 1, selected);

    const result = index.register(makeEventData({
        id: "moved", modTime: 2, startUnix: 30 * DAY_S, endUnix: 30 * DAY_S + 60
    }), 2, selected);
    assert.deepEqual(result, { changed: true, selected_changed: true });
    assert.equal(index.get(selected), null);
    assert.equal(index._eventIds.size, 0);

    assert.deepEqual(index.register(makeEventData({
        id: "never-seen", startUnix: 40 * DAY_S, endUnix: 40 * DAY_S + 60
    }), 3, selected), { changed: false, selected_changed: false });
});

test("day registration: re-registering the same event reports no change", () => {
    const manager = readyManager();
    const data = makeEventData({ startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 });
    assert.equal(registerDays(manager, data).changed, true);
    assert.equal(registerDays(manager, data).changed, false);
});

test("server retries back off exponentially with jitter up to the ceiling", () => {
    const delays = [];
    const originalTimeout = global.imports.mainloop.timeout_add_seconds;
    global.imports.mainloop.timeout_add_seconds = (seconds, cb) => {
        delays.push(seconds);
        return originalTimeout(seconds, cb);
    };

    // The RNG is injected, so the jitter is *observed* rather than bounded. The
    // old assertions were one-sided inequalities that a jitter-free backoff
    // satisfies exactly: deleting the jitter outright left all 29 tests passing.
    const draws = [0, 0.5, 0.999];
    let draw = 0;
    const manager = createEventsManager({ showEvents: true },
        { random: () => draws[draw++ % draws.length] });

    for (let i = 0; i < 10; i++) {
        manager._server_connection.queueRetry();
    }
    global.imports.mainloop.timeout_add_seconds = originalTimeout;

    // exact: base 5 + 0, base 10 + 2, base 20 + 4, base 40 + 0 …
    assert.equal(delays[0], SERVER_RETRY_SECONDS,
        "no jitter drawn means exactly the base delay");
    assert.equal(delays[1], 2 * SERVER_RETRY_SECONDS + Math.floor(0.5 * SERVER_RETRY_SECONDS),
        "half a jitter draw lands on top of the doubled backoff");
    assert.equal(delays[2], 4 * SERVER_RETRY_SECONDS + Math.floor(0.999 * SERVER_RETRY_SECONDS));

    // and the jitter is what makes two instances differ: a jitter-free backoff
    // would repeat the same three delays forever at the ceiling
    const atCeiling = delays.slice(-3);
    assert.ok(new Set(atCeiling).size > 1,
        `a saturated backoff still spreads the retries out: ${atCeiling}`);

    for (const d of delays) {
        assert.ok(d <= SERVER_RETRY_MAX_SECONDS + SERVER_RETRY_SECONDS, `ceiling holds: ${d}`);
    }
    assert.equal(manager._server_connection._server_retry_attempts, 8,
        "the retry exponent stops growing after eight failures");

    // success resets the ladder
    manager._server_connection._server_retry_attempts = 5;
    manager.start_events();
    gio.watches.at(-1).foundCb(null, "eds", "owner");
    proxy.pendingReadyCb(null, "res");
    assert.equal(manager._server_connection._server_retry_attempts, 0);
});

test("EDS retry ceilings stay within the shipped outage budget", () => {
    // These are policy limits, not values for a test to derive from production:
    // pinning the literals is what catches an accidental 100x increase.
    assert.equal(SERVER_RETRY_MAX_SECONDS, 300);
    assert.equal(FETCH_RETRY_MAX_SECONDS, 120);
    assert.equal(FETCH_RETRY_MAX_ATTEMPTS, 5);
    assert.equal(MAX_EVENT_SIGNAL_BYTES, 4 * 1024 * 1024);
    assert.equal(MAX_QUEUED_EVENT_RECORDS, 2000);
    assert.equal(MAX_QUEUED_EVENT_BYTES, 8 * 1024 * 1024);
    assert.equal(MAX_QUEUED_EVENT_MUTATIONS, 256);

    const manager = createEventsManager({ showEvents: true }, { random: () => 0 });
    manager._server_connection._server_retry_attempts = 8;
    assert.equal(manager._server_connection.retryDelay(), 300,
        "a saturated server retry arms five minutes, not hours");
});

test("EventsManager receives its boundary collaborators", () => {
    const serverConnection = { isActive: () => false };
    const eventIndex = { getColorsByUnixKey: () => ["injected"] };
    const windowCoordinator = { current_selected_date: "selected" };
    const manager = new EventsManager({ showEvents: true }, {
        serverConnection,
        eventIndex,
        windowCoordinator,
        random: () => 0
    });

    assert.equal(manager._server_connection, serverConnection);
    assert.equal(manager._event_index, eventIndex);
    assert.equal(manager._window_coordinator, windowCoordinator);
    assert.equal(manager.current_selected_date, "selected");
    assert.deepEqual(manager.get_colors_for_unix_key(1), ["injected"]);
    assert.throws(() => new EventsManager({ showEvents: true }), /requires its connection/);
});

test("idle background reload refetches the selected date without navigating", () => {
    const manager = readyManager();
    const selected = new FakeDateTime(20 * DAY_US);
    manager._window_coordinator.current_selected_date = selected;
    manager._window_coordinator.current_selected_signature = "2000-1-20";
    manager._reload_selected_id = 9;

    assert.equal(manager._idle_do_reload_selected(), false);
    assert.equal(manager._reload_selected_id, 0);
    assert.equal(manager.current_selected_date, selected);
    assert.equal(proxy.instance.set_time_range_calls.at(-1).force, true);
    assert.equal(emitted(manager, "selected-date-changed").at(-1).args[0], selected);
});

// T700: cinnamon-calendar-server can overlap views during a rapid range
// change. It cancels and replaces the shared view_cancellable, but the old
// asynchronous callback tests that shared *current* field rather than the
// cancellable it started with, so a superseded view still starts and can
// deliver last. Arrival order therefore does not order revisions — `modified`
// does, and it was compared only for equality, never for precedence.
test("a superseded revision cannot overwrite a newer one", () => {
    const manager = readyManager();
    const month = new FakeDateTime(10 * DAY_US);
    manager._window_coordinator.current_selected_date = month;
    manager.fetch_month_events(month, true);

    // the user moved the event to day 11 and renamed it; EDS bumped modTime
    const current = makeEventData({
        id: "moved-event", summary: "Standup (moved)", modTime: 200,
        startUnix: 11 * DAY_S, endUnix: 11 * DAY_S + 1800
    });
    registerDays(manager, current);
    assert.ok(manager._event_index.get(new FakeDateTime(11 * DAY_US)),
        "the newer revision sits on day 11");

    // the losing view finally delivers the pre-move snapshot
    const stale = makeEventData({
        id: "moved-event", summary: "Standup", modTime: 100,
        startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 1800
    });
    const result = manager._event_index.register(stale, 77, month);

    assert.deepEqual(result, { changed: false, selected_changed: false },
        "a superseded delivery changes nothing");
    assert.equal(manager._event_index.get(month), null,
        "and cannot resurrect the event on the day it was moved off");
    const day11 = manager._event_index.get(new FakeDateTime(11 * DAY_US));
    assert.equal(day11.get_event_list()[0].summary, "Standup (moved)",
        "the newer revision is intact");

    // ...and the stale delivery still counted as proof the event is live, so
    // the reconciliation cull that follows does not delete what it kept
    assert.equal(day11.get_event_list()[0].last_update_timestamp, 77);
    assert.equal(manager._event_index.cull(77), false,
        "the kept revision survives a cull at the stale delivery's watermark");
    assert.ok(manager._event_index.get(new FakeDateTime(11 * DAY_US)));
});

test("an equal or newer revision still applies, and unordered ones fall through", () => {
    const manager = readyManager();
    const month = new FakeDateTime(10 * DAY_US);
    manager._window_coordinator.current_selected_date = month;
    manager.fetch_month_events(month, true);

    registerDays(manager, makeEventData({
        id: "ev", summary: "first", modTime: 100,
        startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 600
    }));

    // a newer revision wins
    registerDays(manager, makeEventData({
        id: "ev", summary: "second", modTime: 101,
        startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 600
    }));
    assert.equal(eventSummaries(manager).get("ev"), "second");

    // the same revision redelivered is not superseded — it is the same event,
    // and the colour-only update path still has to reach it
    registerDays(manager, makeEventData({
        id: "ev", summary: "second", modTime: 101,
        startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 600
    }));
    assert.equal(eventSummaries(manager).get("ev"), "second");

    // an older revision loses, whatever order it turns up in
    registerDays(manager, makeEventData({
        id: "ev", summary: "older", modTime: 100,
        startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 600
    }));
    assert.equal(eventSummaries(manager).get("ev"), "second");

    // a payload whose revision is not a usable number says nothing about
    // ordering, so it keeps the previous last-writer-wins behaviour rather
    // than being silently dropped
    registerDays(manager, makeEventData({
        id: "ev", summary: "unordered", modTime: NaN,
        startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 600
    }));
    assert.equal(eventSummaries(manager).get("ev"), "unordered");
});
