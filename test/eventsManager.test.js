const assert = require("node:assert/strict");
const { beforeEach, test } = require("node:test");
const path = require("node:path");

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
    finishError: null,
    // GJS connect() can throw — a closed bus, a proxy that finished but is
    // already dead — and the code has to survive a proxy that built and then
    // failed halfway through being wired up
    connectError: null,
    instance: null
};

function makeProxyInstance() {
    return {
        status: 2,
        connections: {},
        disconnected: [],
        next_signal_id: 1,
        set_time_range_calls: [],
        connect(name, cb) {
            const failure = typeof proxy.connectError === "function" ?
                proxy.connectError() : proxy.connectError;
            if (failure) {
                throw failure;
            }
            const id = this.next_signal_id++;
            this.connections[id] = { name, cb };
            return id;
        },
        disconnect(id) {
            this.disconnected.push(id);
            delete this.connections[id];
        },
        signal(name, ...args) {
            for (const id in this.connections) {
                if (this.connections[id].name === name) {
                    this.connections[id].cb(this, ...args);
                }
            }
        },
        call_set_time_range(start, end, force, cancellable, cb) {
            this.set_time_range_calls.push({ start, end, force, cancellable });
            if (cb) {
                cb(this, "res");
            }
        },
        call_set_time_range_finish(res) {}
    };
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
                    proxy.pendingReadyCb = readyCb;
                },
                new_for_bus_finish(res) {
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
const { EventsManager, EventIndex, EventWindowCoordinator, SERVER_RETRY_SECONDS } = require(modulePath);

function emitted(manager, name) {
    return (manager._emitted || []).filter((e) => e.name === name);
}

function makeManager(showEvents = true) {
    return new EventsManager({ showEvents });
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

beforeEach(() => {
    gio.watches.length = 0;
    gio.unwatched.length = 0;
    timers.pending.clear();
    proxy.pendingReadyCb = null;
    proxy.finishError = null;
    proxy.connectError = null;
    proxy.instance = null;
});

test("start_events watches the EDS bus once", () => {
    const manager = makeManager();
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
    assert.ok(manager._server_connection._inited);
    assert.equal(Object.keys(proxy.instance.connections).length, 4);
    assert.equal(emitted(manager, "events-manager-ready").length, 1);
});

test("proxy ready after destroy connects nothing", () => {
    const manager = makeManager();
    manager.start_events();
    gio.watches.at(-1).foundCb(null, "eds", "owner");
    manager.destroy();
    proxy.pendingReadyCb(null, "res");
    assert.equal(manager._server_connection._calendar_server, null);
    assert.ok(!manager._server_connection._inited);
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

    manager.select_date(new Date(50 * DAY_S * 1000), true);
    const call = proxy.instance.set_time_range_calls.at(-1);
    assert.ok(call.cancellable, "the call carries a cancellable, not null");

    global.log = (message) => logged.push(String(message));
    manager.destroy();
    assert.equal(call.cancellable.cancelled, true);

    // and if the reply arrives anyway, it is dropped in silence rather than
    // logged as an EDS failure
    assert.doesNotThrow(() => manager.call_finished(proxy.instance, "res"));
    global.log = originalLog;

    assert.equal(logged.length, 0, "a removed applet does not report a fetch failure");
});

test("destroy cancels watch, retry and timers and disconnects proxy signals", () => {
    const manager = readyManager();
    manager._server_connection.queueRetry();
    manager._start_gc_timer();
    manager.queue_reload_today(false);
    const server = proxy.instance;
    manager.destroy();

    assert.equal(timers.pending.size, 0);
    assert.equal(server.disconnected.length, 4);
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

test("removed events delete uids everywhere and emit", () => {
    const manager = readyManager();
    const varray = {
        unpack: () => [eventVariant({ id: "a", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 })]
    };
    proxy.instance.signal("events-added-or-updated", varray);
    proxy.instance.signal("events-removed", "a::b");
    assert.equal(manager._event_index.eventsByDate[10 * DAY_S].length, 0);
    assert.ok(emitted(manager, "events-updated").length >= 2);
});

test("client disappearance rebuilds the event map via a forced reload", () => {
    const manager = readyManager();
    manager._event_index.eventsByDate[123] = {};
    proxy.instance.signal("client-disappeared", "uid");
    assert.deepEqual(manager._event_index.eventsByDate, {});
    assert.ok(manager._force_reload_pending);
    assert.ok(manager._reload_today_id > 0);
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
    manager._start_gc_timer();
    fireTimer(manager._gc_timer_id);
    // the emptied day is dropped, so the day reads as "no events" instead of
    // rendering an empty list
    assert.equal(manager._event_index.eventsByDate[10 * DAY_S], undefined);
    assert.equal(manager._event_index.getByUnixKey(10 * DAY_S), null);
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

    fireTimer(manager._fetch_retry_id);
    assert.equal(server.set_time_range_calls.length, initialCalls + 1, "the month is refetched");
    assert.equal(server.set_time_range_calls.at(-1).force, true);

    // the second retry succeeds and the attempt counter resets
    fireTimer(manager._fetch_retry_id);
    assert.equal(manager._fetch_retry_attempts, 0);
    assert.equal(manager._fetch_retry_id, 0);
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
    assert.equal(index.eventsByDate[10 * DAY_S].length, 0);
    assert.equal(index.cull(10 ** 9), true);
    index.clear();
    assert.deepEqual(index.eventsByDate, {});
    assert.equal(index.get(selected), null);
    assert.equal(index.getColorsByUnixKey(11 * DAY_S), null);
});

test("EventWindowCoordinator owns fetch-window and selected-date coordination", () => {
    const index = new EventIndex();
    const coordinator = new EventWindowCoordinator(index);
    const calls = [];
    const emittedEvents = [];
    // the coordinator is handed a setTimeRange function now, not the proxy: the
    // connection owns the proxy and exposes this bound method
    const setTimeRange = (start, end, force, cancellable, cb) => {
        calls.push({ start, end, force });
        cb(null, "res");
    };
    let timestamp = 40;
    const month = new FakeDateTime(40 * DAY_US);

    assert.equal(coordinator.fetchMonthEvents(
        month, false, setTimeRange, () => emittedEvents.push(["finished"]), () => ++timestamp), 41);
    assert.equal(calls[0].end - calls[0].start, 42 * DAY_S - 1);
    assert.equal(coordinator.fetchMonthEvents(
        month, false, setTimeRange, () => {}, () => ++timestamp), null);
    assert.equal(coordinator.fetchMonthEvents(
        month, true, setTimeRange, () => {}, () => ++timestamp), 42);
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

test("day registration: bugged 1000-day span stops at the 50-day escape", () => {
    const manager = readyManager();
    registerDays(manager,
        makeEventData({ startUnix: 10 * DAY_S, endUnix: 1010 * DAY_S }));
    assert.equal(Object.keys(manager._event_index.eventsByDate).length, 51);
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
    const manager = new EventsManager({ showEvents: true },
        { random: () => draws[draw++ % draws.length] });

    for (let i = 0; i < 10; i++) {
        manager._server_connection.queueRetry();
    }
    global.imports.mainloop.timeout_add_seconds = originalTimeout;

    const { SERVER_RETRY_SECONDS, SERVER_RETRY_MAX_SECONDS } =
        require(modulePath);

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

    // success resets the ladder
    manager._server_connection._server_retry_attempts = 5;
    manager.start_events();
    gio.watches.at(-1).foundCb(null, "eds", "owner");
    proxy.pendingReadyCb(null, "res");
    assert.equal(manager._server_connection._server_retry_attempts, 0);
});

test("idle reload today consumes the force flag and selects today", () => {
    const manager = makeManager();
    const calls = [];
    manager._reload_today_id = 9;
    manager._force_reload_pending = true;
    manager.select_date = (date, force) => calls.push([date instanceof Date, force]);

    assert.equal(manager._idle_do_reload_today(), false);
    assert.equal(manager._reload_today_id, 0);
    assert.equal(manager._force_reload_pending, false);
    assert.deepEqual(calls, [[true, true]]);
});
