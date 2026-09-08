const {
    assert, test, path, APPLET_DIR, rootModules,
    AppletModule, CoordinatorModule, PanelStatusModule, Proto, Weather, St
} = require("./helpers/appletFixture");

test("T1154: the real menu close handler cancels pending calendar focus", t => {
    class Popup {
        constructor() { this.handlers = {}; }
        connect(name, callback) { this.handlers[name] = callback; }
    }
    const original = global.imports.ui.applet.AppletPopupMenu;
    global.imports.ui.applet.AppletPopupMenu = Popup;
    t.after(() => { global.imports.ui.applet.AppletPopupMenu = original; });
    let cancelled = 0;
    const applet = Object.assign(Object.create(Proto), {
        orientation: St.Side.TOP,
        menuManager: { addMenu() {} },
        _calendar: { cancelPendingFocus() { cancelled++; } }
    });
    applet._initContextMenu();
    applet.menu.handlers["open-state-changed"](applet.menu, false);
    assert.equal(cancelled, 1, "closing retires pending focus before the date timeout");
    applet._calendar = null;
    assert.doesNotThrow(() => applet.menu.handlers["open-state-changed"](applet.menu, false));
});

test("_clockNotify updates once per notify", () => {
    let updates = 0;
    const stub = Object.assign(Object.create(Proto), {
        _updateClockAndDate: () => updates++
    });
    if (typeof Proto._clockNotify === "function") {
        Proto._clockNotify.call(stub);
        assert.equal(updates, 1);
    }
});

test("callback failures recover by source without clearing independent errors", () => {
    const issues = new Map();
    const writes = [];
    const stub = Object.assign(Object.create(Proto), {
        _issueReporter: {
            set(source, message) {
                writes.push([source, message]);
                if (message) {
                    issues.set(source, message);
                } else {
                    issues.delete(source);
                }
            }
        }
    });

    const result = Proto._guarded.call(stub, "clock", () => {
        throw new Error("private diagnostic");
    });
    Proto._guarded.call(stub, "menu-open", () => {
        throw new Error("another private diagnostic");
    });

    assert.equal(result, undefined);
    assert.match(issues.get("runtime:clock"), /system log/);
    assert.match(issues.get("runtime:menu-open"), /system log/);
    assert.doesNotMatch(issues.get("runtime:clock"), /private diagnostic/,
        "raw exception text is diagnostic data, not safe UI");

    assert.equal(Proto._guarded.call(stub, "clock", () => 42), 42);
    assert.equal(issues.has("runtime:clock"), false,
        "a successful retry clears its own failure");
    assert.equal(issues.has("runtime:menu-open"), true,
        "one recovered callback cannot erase another callback's failure");
    assert.deepEqual(writes.at(-1), ["runtime:clock", ""]);
});

test("click failures reach the footer and clear on the next successful click", () => {
    const issues = new Map();
    let fail = true;
    const stub = Object.assign(Object.create(Proto), {
        menu: {
            toggle() {
                if (fail) {
                    fail = false;
                    throw new Error("menu actor is temporarily unavailable");
                }
            }
        },
        _issueReporter: {
            set(source, message) {
                if (message) {
                    issues.set(source, message);
                } else {
                    issues.delete(source);
                }
            }
        }
    });

    assert.doesNotThrow(() => Proto.on_applet_clicked.call(stub));
    assert.match(issues.get("runtime:applet-click"), /system log/);
    Proto.on_applet_clicked.call(stub);
    assert.equal(issues.has("runtime:applet-click"), false);
});

test("teardown of a partially constructed applet is a safe no-op", () => {
    const stub = Object.assign(Object.create(Proto), { instance_id: 3 });
    assert.doesNotThrow(() => Proto.on_applet_removed_from_panel.call(stub));
});

test("on_applet_removed_from_panel tears everything down", () => {
    const torn = [];
    let eventConsumers = 3;
    const stub = Object.assign(Object.create(Proto), {
        _constructed: true,
        instance_id: 7,
        _providerLifecycle: {
            destroy() {
                torn.push(["lifecycle"]);
                assert.equal(eventConsumers, 0,
                    "a terminal producer notification has no live UI subscriber");
                throw new Error("producer teardown failed");
            }
        },
        // the builder constructed the calendar and the event list, so its own
        // teardown detaches every consumer and then destroys both
        _menuBuilder: {
            destroy() {
                eventConsumers -= 3;
                torn.push(["builder"], ["calendar"], ["list"]);
            }
        },
        _calendar: { destroy: () => torn.push(["applet-owned-calendar"]) },
        event_list: { destroy: () => torn.push(["applet-owned-list"]) },
        menu: { destroy: () => torn.push(["menu"]) },
        menuManager: { removeMenu: () => torn.push(["unmanage"]) },
        settings: { finalize: () => torn.push(["settings"]) }
    });
    Proto.on_applet_removed_from_panel.call(stub);
    // the menu is parented to Main.uiGroup: nothing else would ever destroy it
    // T971: the settings are finalized first, so no `changed::` can reach a
    // handler whose collaborators are being destroyed below it
    assert.deepEqual(torn, [
        ["settings"], ["builder"], ["calendar"], ["list"], ["unmanage"],
        ["menu"], ["lifecycle"]
    ]);
});

test("an unsupported configured country falls back to none", () => {
    const logged = [];
    const originalLogError = global.logError;
    global.logError = (message) => logged.push(String(message));

    const places = [];
    // the lifecycle is the composition root: a provider is substituted by
    // handing it one, not by reaching into the module it comes from
    const holidayProvider = {
        clearPlace() { places.push(["clear"]); },
        setPlace(...args) { places.push(["place", ...args]); },
        setPluginIds() {},
        setCountries() {}
    };

    const settings = {
        // "ind" is not one of the countries the combobox offers: an older
        // config could still hold it
        values: { country: "ind" },
        bind() {},
        bindWithObject() {},
        connect() { return 1; },
        getValue(key) { return this.values[key]; },
        setValue(key, value) { this.values[key] = value; }
    };

    const lifecycle = new AppletModule.AppletProviderLifecycle({
        holidaySettings: new rootModules.settingsFacade.HolidaySettings(settings),
        onHolidayDataChanged: () => {}
    }, { holidayProvider: () => holidayProvider });
    lifecycle.initHolidayProvider();

    global.logError = originalLogError;

    assert.equal(settings.values.country, rootModules.settingsFacade.NO_HOLIDAYS);
    assert.deepEqual(places, [["clear"]], "no lookup is attempted for an unsupported country");
    assert.equal(logged.length, 1);
    assert.match(logged[0], /ind/);
});

// Cinnamon calls on_applet_added_to_panel() on whatever the constructor
// returned — and the constructor catches its own failure, tears itself down,
// and still returns an object. Whatever that call re-arms is never taken down
// again, because destroy() has already run.
test("a destroyed applet does not re-arm its once-a-second clock handler", () => {
    const connects = [];
    const clock = {
        connect: (signal, callback) => {
            connects.push([signal, callback]);
            return connects.length;
        },
        disconnect: (id) => connects.splice(id - 1, 1)
    };
    const lifecycle = new AppletModule.AppletProviderLifecycle({ actor: { disconnect() {} } });
    lifecycle.clock = clock;

    lifecycle.destroy();
    lifecycle.connectClockNotify(() => {});

    assert.deepEqual(connects, [],
        "the handler would tick against destroyed actors for the rest of the session");
});

// The panel's clock ticks because the applet connects to WallClock's
// "notify::clock" — and the signal name was asserted nowhere: renaming it to
// anything at all left the suite green, and the panel would simply stop ticking.
// Its sibling actor signals are pinned too, so this was a gap, not a policy.
test("the panel clock connects to the tick signal WallClock actually emits", () => {
    const connects = [];
    const clock = {
        connect: (signal, callback) => {
            connects.push([signal, callback]);
            return connects.length;
        },
        disconnect: () => {}
    };
    const lifecycle = new AppletModule.AppletProviderLifecycle({ actor: { disconnect() {} } });
    lifecycle.clock = clock;

    let ticks = 0;
    lifecycle.connectClockNotify(() => ticks++);

    assert.deepEqual(connects.map(([signal]) => signal), ["notify::clock"],
        "any other name and the clock never updates again");
    assert.ok(lifecycle._clock_notify_id > 0, "and the id is kept, so teardown can release it");

    // the callback that was handed over is the one the signal drives
    connects[0][1]();
    assert.equal(ticks, 1);

    // asked twice, connected once: a second connect would tick the panel twice a
    // second and leak the first handler
    lifecycle.connectClockNotify(() => {});
    assert.equal(connects.length, 1);
});

test("local-day rollover is independent of the rendered clock string", () => {
    const Lifecycle = require(path.join(APPLET_DIR, "6.0", "appletLifecycle.js"));
    const previousTimezone = process.env.TZ;
    process.env.TZ = "Europe/Rome";
    try {
        assert.equal(Lifecycle.millisecondsUntilNextLocalDay(
            new Date(2026, 6, 14, 23, 59, 30)), 30000);
        assert.equal(Lifecycle.millisecondsUntilNextLocalDay(
            new Date(2026, 2, 29, 0, 0, 0)), 23 * 60 * 60 * 1000,
        "the spring DST day schedules its actual next local midnight");

        let now = new Date(2026, 6, 14, 23, 59, 30);
        const scheduled = [];
        const cancelled = [];
        let rollovers = 0;
        const rollover = new Lifecycle.LocalDayRollover({
            now: () => now,
            schedule(delay, callback) {
                scheduled.push({ delay, callback });
                return scheduled.length;
            },
            cancel: (id) => cancelled.push(id)
        });

        rollover.start(() => { rollovers++; });
        assert.equal(scheduled[0].delay, 30000);
        now = new Date(2026, 6, 15, 0, 0, 0);
        assert.equal(scheduled[0].callback(), false);
        assert.equal(rollovers, 1);
        assert.equal(scheduled.length, 2, "the next midnight is recomputed after firing");

        rollover.reschedule();
        assert.deepEqual(cancelled, [2]);
        assert.equal(rollovers, 1, "a time change inside the same day does not fake a rollover");

        now = new Date(2026, 6, 16, 8, 0, 0);
        rollover.reschedule();
        assert.equal(rollovers, 2, "a jump across midnight is noticed immediately");
        rollover.destroy();
        assert.equal(cancelled.at(-1), 4);
        const count = scheduled.length;
        rollover.start(() => { rollovers++; });
        assert.equal(scheduled.length, count, "destroy is terminal");
    } finally {
        if (previousTimezone === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = previousTimezone;
        }
    }
});

// The provider teardown was one unguarded block: a throw in the first step —
// abort() on a Soup session Cinnamon has already disposed during a reload, say —
// left the city-weather provider, the holiday provider and the events manager
// alive, with the desktop-settings and logind signals still connected, for the
// rest of the session. The applet's own _destroy() has isolated its steps all
// along.
test("one failing teardown step does not strand the rest", () => {
    const torn = [];
    const originalLogError = global.logError;
    const errors = [];
    global.logError = (e) => errors.push(String(e));

    const desktopSettings = {
        connectClockFormatChanged: () => [1, 2],
        disconnect: (ids) => [].concat(ids).forEach((id) => torn.push(["desktop", id]))
    };
    const lifecycle = new AppletModule.AppletProviderLifecycle({
        actor: { connect: () => 1, disconnect: () => torn.push(["actor"]) },
        desktopSettings
    });

    lifecycle.clock = { disconnect: () => torn.push(["clock"]) };
    lifecycle._clock_notify_id = 1;
    lifecycle.weatherProvider = {
        destroy() {
            throw new Error("aborting an already-disposed Soup session");
        }
    };
    lifecycle.cityWeatherProvider = { destroy: () => torn.push(["city"]) };
    lifecycle.holidayProvider = { destroy: () => torn.push(["holiday"]) };
    lifecycle.eventsManager = {
        disconnect: () => {},
        destroy: () => torn.push(["events"])
    };
    lifecycle._desktop_settings_signal_ids = [7];

    lifecycle.destroy();
    global.logError = originalLogError;

    const done = torn.map((step) => step[0]);
    for (const step of ["clock", "city", "holiday", "events", "desktop"]) {
        assert.ok(done.includes(step), `${step} was never torn down`);
    }
    assert.equal(errors.length, 1, "and the failure is reported, not swallowed");
});

function consumerLifecycle() {
    return new AppletModule.AppletProviderLifecycle({
        actor: { connect: () => 1, disconnect: () => {} },
        desktopSettings: { connectClockFormatChanged: () => [], disconnect: () => {} },
        holidaySettings: {
            country: "none", religiousIds: [], calendarPlugins: [], extraCountryCalendars: [],
            connectCountryChanged: () => {}, bindRegions: () => {},
            connectReligionsChanged: () => {}, connectCalendarPluginsChanged: () => {},
            connectExtraCountriesChanged: () => {}
        },
        eventsSettings: {},
        onEventsManagerReady: () => {},
        onHasCalendarsChanged: () => {},
        onHolidayDataChanged: () => {}
    }, {
        clock: () => ({}),
        networkState: () => ({ isOnline: () => true, destroy: () => {} }),
        weatherRepository: () => ({ destroy: () => {} }),
        weatherProvider: () => ({ destroy: () => {} }),
        cityWeatherProvider: () => ({ destroy: () => {} }),
        eventsManager: () => ({ connect: () => 1, disconnect: () => {}, destroy: () => {} }),
        holidayProvider: () => ({
            clearPlace: () => {}, setPlace: () => {}, destroy: () => {},
            setEnabledIds: () => {}, setPluginIds: () => {}, setCountries: () => {}
        })
    });
}

// The Nominatim spacing timer is armed inside a module-global queue that every
// applet on the panel shares, so no instance owns it and nothing used to
// release it — the same hazard cancelPendingLocaleQueries() is a teardown step
// for. The composition root is where both ends of the count belong: it builds
// the provider graph and it tears it down.
test("T1155: each composition root registers and releases its consumers once", () => {
    const WorldclockData = rootModules.worldclockData;
    // the module the composition root actually reaches, not the fixture's
    // composed handle: weather.js exports only its own bindings now, so the
    // handle the tests read is a copy and patching it would reach nothing
    const WeatherModule = rootModules.weather;
    const originalRegister = WeatherModule.registerWeatherConsumer;
    const originalCancel = WeatherModule.releaseWeatherConsumer;
    const originalClockRegister = WorldclockData.registerWorldclockConsumer;
    const originalClockRelease = WorldclockData.releaseWorldclockConsumer;
    const calls = [];
    WeatherModule.registerWeatherConsumer = () => calls.push("register");
    WeatherModule.releaseWeatherConsumer = () => calls.push("release");
    // the timezone-to-city memo behind the per-clock weather is module state on
    // the same footing, and it is claimed and given back at the same two points
    WorldclockData.registerWorldclockConsumer = () => calls.push("register:clocks");
    WorldclockData.releaseWorldclockConsumer = () => calls.push("release:clocks");

    try {
        const lifecycle = consumerLifecycle();

        lifecycle.initProviders();
        assert.deepEqual(calls, ["register", "register:clocks"],
            "one instance, one consumer of each shared table");

        lifecycle.destroy();
        assert.deepEqual(calls,
            ["register", "register:clocks", "release", "release:clocks"],
            "and the teardown gives both back");
        lifecycle.destroy();
        assert.deepEqual(calls,
            ["register", "register:clocks", "release", "release:clocks"],
            "repeated teardown cannot release another instance's consumers");
    } finally {
        WeatherModule.registerWeatherConsumer = originalRegister;
        WeatherModule.releaseWeatherConsumer = originalCancel;
        WorldclockData.registerWorldclockConsumer = originalClockRegister;
        WorldclockData.releaseWorldclockConsumer = originalClockRelease;
    }
});

// Three id→text tables live across the pure/UI boundary, and every lookup is
// TABLE[id] || id. The ids *are* English display strings, so a missing entry
// does not blow up or read as broken — it quietly ships an untranslated English
// word to the panel and to the accessible name, and looks entirely normal to a
// reviewer and to CI. Nothing asserted the tables were total.
test("every id the code can produce has a word in the table that renders it", () => {
    const conditions = Object.values(Weather.WEATHER_CONDITIONS);
    const rendered = Object.keys(PanelStatusModule.WEATHER_CONDITION_TEXT);
    for (const condition of conditions) {
        assert.ok(rendered.includes(condition),
            `the weather condition "${condition}" has no translatable word`);
    }

    const weatherErrors = Object.values(Weather.WEATHER_ERRORS);
    const renderedErrors = Object.keys(PanelStatusModule.WEATHER_ERROR_TEXT);
    for (const error of weatherErrors) {
        assert.ok(renderedErrors.includes(error),
            `the weather error "${error}" has no translatable word`);
    }

    const Annotations = require(path.join(APPLET_DIR, "6.0", "calendarAnnotations.js"));
    const HolidayConstants = require(path.join(APPLET_DIR, "holidayConstants.js"));
    const holidayErrors = Object.values(HolidayConstants.HOLIDAY_ERRORS);
    const renderedHolidayErrors = Object.keys(Annotations.HOLIDAY_ERROR_TEXT);
    for (const error of holidayErrors) {
        assert.ok(renderedHolidayErrors.includes(error),
            `the holiday error "${error}" has no translatable word`);
    }

    // and the tables carry nothing the code cannot produce: a stale entry is a
    // msgid translators are still paying for
    for (const rendered_condition of rendered) {
        assert.ok(conditions.includes(rendered_condition),
            `"${rendered_condition}" is no longer a condition the providers report`);
    }
});

// The constructor catches its own failure, tears down what it built, and still
// returns an object — so Cinnamon calls on_applet_added_to_panel() on it. That
// method dereferenced _providerLifecycle, events_manager and _calendar
// unconditionally, so a corrupt settings schema turned into an uncaught
// TypeError inside Cinnamon's own applet-loading loop. _constructed had been set
// and never read since the day it was written; this is the guard it was for.
test("a failed build does not go on to be added to the panel", () => {
    const calls = [];
    const halfBuilt = Object.assign(Object.create(Proto), {
        // _constructed is absent: the constructor threw before reaching it
        _providerLifecycle: null,
        events_manager: null,
        _onSettingsChanged: () => calls.push("settings")
    });

    assert.doesNotThrow(() => Proto.on_applet_added_to_panel.call(halfBuilt));
    assert.deepEqual(calls, [], "a torn-down applet does not start providers");
});

test("a half-built applet still tears down what it managed to build", () => {
    const torn = [];
    const keybindings = global.imports.ui.main.keybindingManager;
    const originalRemove = keybindings.removeXletHotKey;
    keybindings.removeXletHotKey = (applet, name) =>
        torn.push(["hotkey", applet.instance_id, name]);

    const stub = Object.assign(Object.create(Proto), {
        instance_id: 9,
        // the constructor threw after the providers were built but before the
        // UI existed: the providers must still be released
        _providerLifecycle: { destroy: () => torn.push(["lifecycle"]) },
        settings: {
            finalize: () => {
                torn.push(["settings"]);
                throw new Error("finalize blew up too");
            }
        }
    });

    assert.doesNotThrow(() => Proto._destroy.call(stub));
    // the keybinding is bound inside the constructor's try, so a failure after
    // that left a live global hotkey opening a menu that no longer exists
    assert.deepEqual(torn, [
        ["hotkey", 9, "calendar-open"], ["settings"], ["lifecycle"]
    ]);

    // removal after a failed construction must not tear down twice
    Proto.on_applet_removed_from_panel.call(stub);
    assert.deepEqual(torn, [
        ["hotkey", 9, "calendar-open"], ["settings"], ["lifecycle"]
    ]);

    keybindings.removeXletHotKey = originalRemove;
});

test("provider lifecycle tears down provider and system resources", () => {
    const torn = [];
    const context = {
        actor: { disconnect: (id) => torn.push(["actor", id]) },
        desktopSettings: {
            disconnect: (ids) => [].concat(ids).forEach((id) => torn.push(["desk", id]))
        }
    };

    const lifecycle = new AppletModule.AppletProviderLifecycle(context);
    lifecycle.clock = { disconnect: (id) => torn.push(["clock", id]) };
    lifecycle._clock_notify_id = 3;
    lifecycle._actor_signal_ids = [21];
    lifecycle.weatherProvider = { destroy: () => torn.push(["weather"]) };
    lifecycle.holidayProvider = { destroy: () => torn.push(["holiday"]) };
    lifecycle.eventsManager = {
        destroy: () => torn.push(["events"]),
        disconnect: (id) => torn.push(["events-signal", id])
    };
    lifecycle._events_manager_signal_ids = [31];
    lifecycle._desktop_settings_signal_ids = [11, 12];

    lifecycle.destroy();

    assert.deepEqual(torn, [
        ["clock", 3], ["actor", 21], ["weather"], ["holiday"],
        ["events-signal", 31], ["events"],
        ["desk", 11], ["desk", 12]
    ]);
    assert.equal(lifecycle._clock_notify_id, 0);
    assert.deepEqual(lifecycle._desktop_settings_signal_ids, []);
});

test("the default weather graph shares one reading repository", () => {
    const lifecycleModule = require(path.join(APPLET_DIR, "6.0", "appletLifecycle.js"));
    const networkState = lifecycleModule.DEFAULT_FACTORIES.networkState();
    const repository = lifecycleModule.DEFAULT_FACTORIES.weatherRepository();
    const panel = lifecycleModule.DEFAULT_FACTORIES.weatherProvider(repository, networkState);
    const cities = lifecycleModule.DEFAULT_FACTORIES.cityWeatherProvider(repository, networkState);

    assert.equal(panel._reading_repository, repository);
    assert.equal(cities._reading_repository, repository);
    assert.equal(repository._cache_milliseconds, Weather.REFRESH_SECONDS * 1000);
    assert.equal(repository.locationResolver._language,
        rootModules.localeQuery.messageLanguage,
        "the composition root supplies the live session language");

    // ...and one network monitor, which fails open on a host without one
    // (this stub Gio has no NetworkMonitor at all)
    assert.equal(panel._isOnline(), true);
    assert.equal(cities._isOnline(), true);

    panel.destroy();
    cities.destroy();
    assert.equal(repository._destroyed, false,
        "consumer teardown cannot abort the other consumer's shared transport");
    repository.destroy();
    assert.equal(repository._destroyed, true);
});

test("bindSystemSignals refetches on logind resume and unsubscribes on destroy", () => {
    const resumed = [];
    const rescheduled = [];
    const timezoneChanges = [];
    const captured = {};
    const unsubscribed = [];
    const restored = [];
    const context = {
        onResume: () => resumed.push(true),
        onNetworkRestored: () => restored.push(true),
        onTimezoneChanged: () => timezoneChanges.push(true),
        desktopSettings: { connectClockFormatChanged: () => [1, 2] }
    };
    global.imports.gi.Gio.DBus = {
        system: {
            signal_subscribe: (sender, iface, member, path, arg0, flags, cb) => {
                captured[member] = { member, path, cb };
                return member === "PrepareForSleep" ? 55 : 56;
            },
            signal_unsubscribe: (id) => {
                unsubscribed.push(id);
            }
        }
    };
    global.imports.gi.Gio.DBusSignalFlags = { NONE: 0 };

    try {
        const lifecycle = new AppletModule.AppletProviderLifecycle(context);
        lifecycle._dayRollover = {
            reschedule: () => rescheduled.push(true),
            destroy() {}
        };
        // T708: the network monitor's flip is the retry the offline weather
        // short-circuit deferred; only the online edge refetches
        let networkFlip = null;
        lifecycle.networkState = {
            destroyed: 0,
            onChanged(callback) { networkFlip = callback; },
            destroy() { this.destroyed++; }
        };
        lifecycle.bindSystemSignals();

        assert.equal(typeof networkFlip, "function",
            "bindSystemSignals subscribes to availability flips");
        networkFlip(false);
        assert.deepEqual(restored, [], "going offline refetches nothing");
        networkFlip(true);
        assert.deepEqual(restored, [true], "coming back online refetches the weather");

        assert.equal(captured.PrepareForSleep.member, "PrepareForSleep");
        assert.equal(lifecycle._logind_sleep_signal_id, 55);
        assert.equal(lifecycle._timedate_signal_id, 56);

        // true = going into sleep -> no refetch; false = resumed -> refetch
        const emit = (sleeping) => captured.PrepareForSleep.cb(
            null, null, captured.PrepareForSleep.path,
            "org.freedesktop.login1.Manager", "PrepareForSleep", { deep_unpack: () => [sleeping] });
        emit(true);
        assert.deepEqual(resumed, [], "nothing is refetched on the way into sleep");
        emit(false);
        assert.deepEqual(resumed, [true], "the weather is refetched on wake");
        assert.deepEqual(rescheduled, [true], "resume also corrects the local-day source");
        const changed = (properties) => ({
            deep_unpack: () => ["org.freedesktop.timedate1", properties, []]
        });
        captured.PropertiesChanged.cb(null, null, null, null, null,
            changed({ NTP: true }));
        assert.deepEqual(timezoneChanges, [],
            "unrelated timedate properties do not rebuild world clocks");
        captured.PropertiesChanged.cb(null, null, null, null, null,
            changed({ Timezone: "Europe/Rome" }));
        assert.deepEqual(rescheduled, [true, true, true],
            "timezone and system-clock changes recompute the next midnight");
        assert.deepEqual(timezoneChanges, [true],
            "timezone changes reach the applet composition root");

        lifecycle.destroy();
        assert.deepEqual(unsubscribed, [55, 56], "system-bus subscriptions are released");
        assert.equal(lifecycle._logind_sleep_signal_id, 0);
        assert.equal(lifecycle._timedate_signal_id, 0);
        assert.equal(lifecycle.networkState.destroyed, 1,
            "the network monitor subscription is released with the rest");
    } finally {
        delete global.imports.gi.Gio.DBus;
        delete global.imports.gi.Gio.DBusSignalFlags;
    }
});

// T943: the popup measures the work area when it opens and never again, so a
// monitor hotplug or a resolution change left the previous shape
// on screen until the menu was closed and reopened — on a shrinking work area,
// a month grid pushed off the bottom.
test("bindSystemSignals reflows the open popup on monitors-changed", () => {
    const reflows = [];
    const connected = [];
    const disconnected = [];
    let handler = null;
    const layoutManager = {
        connect: (name, callback) => {
            connected.push(name);
            handler = callback;
            return 91;
        },
        disconnect: (id) => disconnected.push(id)
    };
    const context = {
        desktopSettings: { connectClockFormatChanged: () => [] },
        layoutManager,
        onGeometryChanged: () => reflows.push(true)
    };
    const lifecycle = new AppletModule.AppletProviderLifecycle(context);
    lifecycle._dayRollover = { destroy() {} };

    lifecycle.bindSystemSignals();
    assert.deepEqual(connected, ["monitors-changed"]);
    assert.equal(lifecycle._monitors_signal_id, 91);

    handler();
    assert.deepEqual(reflows, [true], "a geometry change re-decides the layout");

    lifecycle.destroy();
    assert.deepEqual(disconnected, [91],
        "the layout manager outlives the applet, so its handler must go with it");
    assert.equal(lifecycle._monitors_signal_id, 0);
});

// A Cinnamon without the signal source, or one mid-teardown, must not take the
// applet down with it: binding is optional and teardown stays a no-op.
test("bindSystemSignals tolerates a layout manager it cannot connect to", () => {
    for (const layoutManager of [null, undefined, {}, { connect: 7 }]) {
        const lifecycle = new AppletModule.AppletProviderLifecycle({
            desktopSettings: { connectClockFormatChanged: () => [] },
            layoutManager,
            onGeometryChanged: () => assert.fail("nothing is connected")
        });
        lifecycle._dayRollover = { destroy() {} };
        lifecycle.bindSystemSignals();
        assert.equal(lifecycle._monitors_signal_id, 0);
        lifecycle.destroy();
    }
});

test("work-area changes coalesce after panel geometry settles and release all resources", (t) => {
    const pending = new Map();
    const disconnected = [];
    let sequence = 0;
    t.mock.method(global.imports.mainloop, "idle_add", callback => {
        pending.set(++sequence, callback);
        return sequence;
    });
    t.mock.method(global.imports.mainloop, "source_remove", id => pending.delete(id));
    let handler;
    let height = 728;
    const reflows = [];
    const lifecycle = new AppletModule.AppletProviderLifecycle({
        desktopSettings: { connectClockFormatChanged: () => [] },
        display: {
            connect(name, callback) {
                assert.equal(name, "workareas-changed");
                handler = callback;
                return 92;
            },
            disconnect: id => disconnected.push(id)
        },
        onGeometryChanged: () => reflows.push(height)
    });
    lifecycle.bindSystemSignals();
    assert.equal(lifecycle._workareas_signal_id, 92);
    handler();
    height = 688;
    handler();
    height = 648;
    assert.equal(pending.size, 1, "several strut updates share one reflow");
    assert.deepEqual(reflows, [], "do not measure geometry in the middle of panel updates");
    const run = () => {
        const id = lifecycle._workarea_reflow_idle_id;
        const callback = pending.get(id);
        pending.delete(id);
        callback();
    };
    run();
    assert.deepEqual(reflows, [648]);
    height = 728;
    handler();
    run();
    assert.deepEqual(reflows, [648, 728], "expansion restores the larger viewport too");

    handler();
    const abandoned = pending.get(lifecycle._workarea_reflow_idle_id);
    lifecycle.destroy();
    assert.equal(pending.size, 0);
    assert.deepEqual(disconnected, [92]);
    assert.equal(lifecycle._workareas_signal_id, 0);
    assert.equal(lifecycle._workarea_reflow_idle_id, 0);
    abandoned();
    handler();
    assert.equal(pending.size, 0, "a late signal cannot rearm a destroyed lifecycle");
    assert.deepEqual(reflows, [648, 728], "a dispatched callback cannot touch destroyed actors");
});

test("settings binding wires schema keys and creates settings facades", () => {
    const binds = [];
    const callbacks = {};
    const values = { "weather-units": "si" };
    let keybindingChanged = null;
    const original = global.imports.ui.settings.AppletSettings;
    global.imports.ui.settings.AppletSettings = class {
        constructor(owner, uuid, instanceId) {
            binds.push(["ctor", uuid, instanceId]);
        }
        bind(key, prop, cb) {
            binds.push(["bind", key, prop, typeof cb]);
            callbacks[key] = cb;
            if (key === "keyOpen") {
                keybindingChanged = cb;
            }
        }
        connect(signal, callback) {
            callbacks[signal.replace("changed::", "")] = callback;
        }
        getValue(key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : []; }
        setValue(key, value) { binds.push(["setValue", key, value]); }
    };

    const stub = Object.assign(Object.create(Proto), {
        instance_id: 42,
        _setKeybinding: () => binds.push(["hotkey"]),
        _onShowEventsChanged: () => binds.push(["effect", "events"]),
        _onPanelFormatChanged: () => binds.push(["effect", "panel-format"]),
        _onTooltipFormatChanged: () => binds.push(["effect", "tooltip-format"]),
        _onShowWorldclocksChanged: () => binds.push(["effect", "worldclocks"]),
        _onShowAstronomyChanged: () => binds.push(["effect", "astronomy"]),
        _onWeatherSettingsChanged: () => binds.push(["effect", "weather-request"]),
        _onWeatherUnitsChanged: () => binds.push(["effect", "weather-units"])
    });
    Proto._bindSettings.call(stub);
    callbacks["show-events"]();
    callbacks["custom-format"]();
    callbacks["custom-tooltip-format"]();
    callbacks["show-worldclocks"]();
    callbacks["show-astronomy"]();
    callbacks["show-weather"]();
    callbacks["weather-units"]();
    keybindingChanged();
    global.imports.ui.settings.AppletSettings = original;

    assert.ok(stub.calendar_settings);
    assert.ok(stub.events_settings);
    assert.deepEqual(binds[0], ["ctor", "chronos@geraldo-netto", 42]);
    assert.ok(binds.some((row) => row[1] === "show-events"));
    assert.ok(binds.some((row) => row[1] === "custom-format"));
    assert.ok(binds.some((row) => row[1] === "custom-tooltip-format"));
    assert.ok(!binds.some((row) => row[1] === "use-custom-format"));
    assert.deepEqual(binds.filter((row) => row[0] === "effect"), [
        ["effect", "events"],
        ["effect", "panel-format"],
        ["effect", "tooltip-format"],
        ["effect", "worldclocks"],
        ["effect", "astronomy"],
        ["effect", "weather-request"],
        ["effect", "weather-units"]
    ]);
    assert.equal(binds.filter((row) => row[0] === "hotkey").length, 2,
        "initial binding and a changed accelerator both install the hotkey");

    // REGRESSION: weather-location is drawn by a custom widget, and Cinnamon
    // binds only the types in its SETTINGS_TYPES table — "custom" is not one.
    // It was bound anyway: the bind failed with "Invalid setting type", the
    // applet property stayed undefined for the life of the process, and the
    // weather silently never loaded for anyone. It is mirrored by hand instead.
    assert.ok(!binds.some((row) => row[0] === "bind" && row[1] === "weather-location"),
        "a custom-widget key cannot be bound; Cinnamon refuses it");
    assert.ok(!binds.some((row) => row[0] === "bind" && row[1] === "weather-units"),
        "the custom units widget must use the same explicit mirror");
    // the mirror reads the key and writes the applet property itself: this
    // double answers [] for every getValue, and that is what lands on it
    assert.deepEqual(stub.weather_location, [],
        "the location reaches the applet through the mirror, not through bind()");
    assert.equal(stub.weather_units, "si");
});

test("settings binding preserves empty weather and explicit date formats across reloads", () => {
    const originalSettings = global.imports.ui.settings.AppletSettings;
    const values = {
        "custom-format": "%A, %B %e, %H:%M",
        "custom-tooltip-format": "%Y-%m-%d %H:%M",
        "weather-location": "",
        "weather-units": "si",
        country: "none"
    };
    const writes = [];
    global.imports.ui.settings.AppletSettings = class {
        bind() {}
        connect() { return 1; }
        getValue(key) { return values[key]; }
        setValue(key, value) { writes.push([key, value]); }
    };
    try {
        for (let load = 0; load < 2; load++) {
            const stub = Object.assign(Object.create(Proto), {
                instance_id: 42,
                _setKeybinding() {}
            });
            Proto._bindSettings.call(stub);
            assert.equal(stub.weather_location, "");
            assert.equal(values["weather-location"], "");
            stub._settingsBinder.destroy();
        }
        assert.deepEqual(writes, [], "opening and reloading preserve the saved location and formats");
    } finally {
        global.imports.ui.settings.AppletSettings = originalSettings;
    }
});

test("holiday-country inference yields startup and preserves later choices", () => {
    const originalSettings = global.imports.ui.settings.AppletSettings;
    const originalCountryCode = rootModules.worldclockData.localCountryCode;
    const originalIdleAdd = global.imports.mainloop.idle_add;
    const originalSourceRemove = global.imports.mainloop.source_remove;
    const idles = [];
    const removed = [];
    const values = {
        "weather-location": "Rome",
        country: ""
    };
    let timezoneReads = 0;

    global.imports.ui.settings.AppletSettings = class {
        bind() {}
        connect() { return 1; }
        getValue(key) { return values[key]; }
        setValue(key, value) { values[key] = value; }
    };
    rootModules.worldclockData.localCountryCode = () => {
        timezoneReads++;
        return timezoneReads === 1 ? "IT" : "FR";
    };
    global.imports.mainloop.idle_add = (callback) => {
        idles.push(callback);
        return 8 + idles.length;
    };
    global.imports.mainloop.source_remove = (id) => removed.push(id);

    const stub = Object.assign(Object.create(Proto), {
        instance_id: 42,
        _setKeybinding() {}
    });

    try {
        const applied = [];
        Proto._bindSettings.call(stub);
        assert.equal(timezoneReads, 0, "construction performs no tzdata I/O");
        assert.equal(values.country, "");
        stub._settingsBinder.deferInitialHolidayCountry(
            (country) => applied.push(country));
        assert.equal(idles.length, 1, "inference waits on the main-loop idle");
        assert.equal(idles[0](), false);
        assert.equal(values.country, "ita");
        // T720: the write emits no changed::country — Cinnamon runs its bind
        // callbacks from _checkSettings, which only remoteUpdate reaches — so
        // the inferred country has to be applied in band or the provider stays
        // on the cleared place initHolidayProvider left it in.
        assert.deepEqual(applied, ["ita"]);

        values.country = "none";
        Proto._bindSettings.call(stub);
        stub._settingsBinder.deferInitialHolidayCountry(
            (country) => applied.push(country));
        assert.equal(idles.length, 1, "an explicit choice schedules no read");

        values.country = "";
        Proto._bindSettings.call(stub);
        stub._settingsBinder.deferInitialHolidayCountry(
            (country) => applied.push(country));
        assert.deepEqual(applied, ["ita"], "only a resolved country is applied");
        stub._settingsBinder.destroy();
    } finally {
        global.imports.ui.settings.AppletSettings = originalSettings;
        rootModules.worldclockData.localCountryCode = originalCountryCode;
        global.imports.mainloop.idle_add = originalIdleAdd;
        global.imports.mainloop.source_remove = originalSourceRemove;
    }

    assert.equal(timezoneReads, 1, "tzdata is read only for the initial default");
    assert.deepEqual(removed, [10], "teardown cancels an inference that never ran");
});

// T720: the inferred country is applied in band because Cinnamon's own write
// notifies nobody. An unresolvable timezone must not fire that path — the
// facade has already written "none" and the provider is already cleared — and a
// caller that wants no callback must still get the write.
test("holiday-country inference applies nothing when the timezone maps nowhere", () => {
    const originalSettings = global.imports.ui.settings.AppletSettings;
    const originalCountryCode = rootModules.worldclockData.localCountryCode;
    const originalIdleAdd = global.imports.mainloop.idle_add;
    const idles = [];
    const applied = [];
    const values = {
        "weather-location": "Rome",
        country: ""
    };

    global.imports.ui.settings.AppletSettings = class {
        bind() {}
        connect() { return 1; }
        getValue(key) { return values[key]; }
        setValue(key, value) { values[key] = value; }
    };
    // a zone with no ISO-3166 country the applet supports
    rootModules.worldclockData.localCountryCode = () => "";
    global.imports.mainloop.idle_add = (callback) => idles.push(callback);

    const stub = Object.assign(Object.create(Proto), {
        instance_id: 7,
        _setKeybinding() {}
    });

    try {
        Proto._bindSettings.call(stub);
        stub._settingsBinder.deferInitialHolidayCountry((country) => applied.push(country));
        idles[0]();
        assert.equal(values.country, "none", "the empty sentinel is still resolved");
        assert.deepEqual(applied, [], "nothing to re-place: the provider is already clear");

        // the write itself must not depend on a caller wanting a callback
        values.country = "";
        rootModules.worldclockData.localCountryCode = () => "IT";
        Proto._bindSettings.call(stub);
        stub._settingsBinder.deferInitialHolidayCountry();
        idles[1]();
        assert.equal(values.country, "ita");
    } finally {
        global.imports.ui.settings.AppletSettings = originalSettings;
        rootModules.worldclockData.localCountryCode = originalCountryCode;
        global.imports.mainloop.idle_add = originalIdleAdd;
    }
});

// T653: AppletSettings registers itself with Cinnamon's settings manager at
// construction. A bind step that throws — the corrupt-schema case the
// constructor catch documents — used to strand that registration: the applet
// stores the instance only after bind() returns, so finalizeIfPresent found
// nothing and the bind closures pinned the whole applet for the session.
test("a bind step that throws releases the settings registration", () => {
    const originalSettings = global.imports.ui.settings.AppletSettings;
    const finalized = [];
    global.imports.ui.settings.AppletSettings = class {
        bind() {}
        connect() { return 1; }
        getValue() { throw new Error("corrupt schema"); }
        setValue() {}
        finalize() { finalized.push("settings"); }
    };
    const stub = Object.assign(Object.create(Proto), {
        instance_id: 42,
        _setKeybinding() {}
    });

    try {
        assert.throws(() => Proto._bindSettings.call(stub), /corrupt schema/);
    } finally {
        global.imports.ui.settings.AppletSettings = originalSettings;
    }

    assert.deepEqual(finalized, ["settings"],
        "the orphaned registration is finalized exactly once");
});

test("a finalize that also throws still reports the original bind failure", () => {
    const originalSettings = global.imports.ui.settings.AppletSettings;
    const originalLogError = global.logError;
    const logged = [];
    global.imports.ui.settings.AppletSettings = class {
        bind() {}
        connect() { return 1; }
        getValue() { throw new Error("corrupt schema"); }
        setValue() {}
        finalize() { throw new Error("already torn down"); }
    };
    global.logError = (e) => logged.push(e.message);
    const stub = Object.assign(Object.create(Proto), {
        instance_id: 42,
        _setKeybinding() {}
    });

    try {
        assert.throws(() => Proto._bindSettings.call(stub), /corrupt schema/,
            "the bind failure wins; the finalize failure is only logged");
    } finally {
        global.imports.ui.settings.AppletSettings = originalSettings;
        global.logError = originalLogError;
    }

    assert.deepEqual(logged, ["already torn down"]);
});

test("settings binding preserves a pre-existing holiday opt-out on upgrade", () => {
    const originalSettings = global.imports.ui.settings.AppletSettings;
    const originalCountryCode = rootModules.worldclockData.localCountryCode;
    const values = {
        "weather-location": "Rome",
        country: "none"
    };

    global.imports.ui.settings.AppletSettings = class {
        bind() {}
        connect() { return 1; }
        getValue(key) { return values[key]; }
        setValue(key, value) { values[key] = value; }
    };
    rootModules.worldclockData.localCountryCode = () => {
        throw new Error("an upgrade must not reinterpret an old explicit disable");
    };

    const stub = Object.assign(Object.create(Proto), {
        instance_id: 42,
        _setKeybinding() {}
    });

    try {
        Proto._bindSettings.call(stub);
    } finally {
        global.imports.ui.settings.AppletSettings = originalSettings;
        rootModules.worldclockData.localCountryCode = originalCountryCode;
    }

    assert.equal(values.country, "none");
});

test("regression: an unsupported OS timezone country leaves holidays disabled", () => {
    const originalSettings = global.imports.ui.settings.AppletSettings;
    const originalCountryCode = rootModules.worldclockData.localCountryCode;
    const originalIdleAdd = global.imports.mainloop.idle_add;
    let infer = null;
    const values = {
        "weather-location": "San Marino",
        country: ""
    };

    global.imports.ui.settings.AppletSettings = class {
        bind() {}
        connect() { return 1; }
        getValue(key) { return values[key]; }
        setValue(key, value) { values[key] = value; }
    };
    rootModules.worldclockData.localCountryCode = () => "SM";
    global.imports.mainloop.idle_add = (callback) => {
        infer = callback;
        return 1;
    };

    const stub = Object.assign(Object.create(Proto), {
        instance_id: 42,
        _setKeybinding() {}
    });

    try {
        Proto._bindSettings.call(stub);
        stub._settingsBinder.deferInitialHolidayCountry();
        infer();
    } finally {
        global.imports.ui.settings.AppletSettings = originalSettings;
        rootModules.worldclockData.localCountryCode = originalCountryCode;
        global.imports.mainloop.idle_add = originalIdleAdd;
    }

    assert.equal(values.country, "none",
        "San Marino must not silently inherit Italy from its canonical timezone file");
});

// REGRESSION: the handlers went to the binder as bare methods, and the receiver
// they got depended on which of Cinnamon's two paths the key took. The bound keys
// worked — settings.bind() wraps the callback in Lang.bind(applet, …). The
// mirrored one did not: the facade calls it through settings.connect(), with no
// receiver, so `this` was undefined in a class-body method and `this._guarded`
// threw TypeError. GJS's signal emission swallows the throw, so the only symptom
// was that the city the user typed never took effect — the panel kept the old one
// for the rest of the session.
//
// The stub is Object.create(Proto): the handler under test is the real method, and
// FakeSettings is Cinnamon's two call paths, one calling with a receiver and one
// without. A test that passes an arrow or an explicit .call() cannot see this.
test("a changed weather location refetches the weather", () => {
    const calls = [];
    const listeners = {};
    const values = { "weather-location": "Genoa" };
    const original = global.imports.ui.settings.AppletSettings;

    global.imports.ui.settings.AppletSettings = class {
        constructor(owner) { this._owner = owner; }
        // settings.js:322 — the callback is Lang.bind()ed to the owning applet
        bind(key, property, callback) { this[`_cb_${key}`] = callback.bind(this._owner); }
        // GJS signals.js — the callback is applied with no receiver at all
        connect(signal, callback) { listeners[signal] = callback; }
        getValue(key) { return values[key]; }
        setValue(key, value) { values[key] = value; }
    };

    const stub = Object.assign(Object.create(Proto), {
        instance_id: 1,
        _setKeybinding: () => {},
        _updateClockAndDate: () => calls.push("clock"),
        _queueWeatherRefresh: () => calls.push("weather")
    });

    try {
        Proto._bindSettings.call(stub);
        values["weather-location"] = "Lisbon";
        listeners["changed::weather-location"]();
    } finally {
        global.imports.ui.settings.AppletSettings = original;
    }

    assert.equal(stub.weather_location, "Lisbon");
    assert.deepEqual(calls, ["clock", "weather"],
        "the handler runs with the applet as its receiver, whichever path calls it");
});

test("the provider lifecycle binds regions, defaults country, and refreshes the calendar", () => {
    const calls = [];
    const listeners = {};
    const holidayProvider = {
        clearPlace: () => calls.push(["clear"]),
        setPlace: (...args) => calls.push(["place", ...args]),
        setEnabledIds: (ids) => calls.push(["religions", ids]),
        setPluginIds() {},
        setCountries() {},
        destroy() {}
    };
    const settings = {
        values: {
            country: null,
            "religion-islam": true,
            ...Object.fromEntries(rootModules.holidayConstants.REGION_COUNTRIES.map(
                (country) => [`region_${country}`, country === "usa" ? "ny" : "global"]))
        },
        bind(key, prop, cb) { calls.push(["bind", key, prop]); },
        connect(signal, callback) {
            calls.push(["connect", signal]);
            listeners[signal] = callback;
            return Object.keys(listeners).length;
        },
        bindWithObject(obj, key, prop, cb) {
            throw new Error(`custom region ${key}/${prop} cannot be bound`);
        },
        getValue(key) { return this.values[key]; },
        setValue(key, value) {
            calls.push(["setValue", key, value]);
            this.values[key] = value;
        }
    };
    const lifecycle = new AppletModule.AppletProviderLifecycle({
        holidaySettings: new rootModules.settingsFacade.HolidaySettings(settings),
        onHolidayDataChanged: () => calls.push(["refresh"])
    }, {
        holidayProvider: (religiousIds) => {
            calls.push(["factory-religions", religiousIds]);
            return holidayProvider;
        }
    });
    lifecycle.initHolidayProvider();
    assert.ok(lifecycle.holidayProvider);
    assert.deepEqual(calls.find((row) => row[0] === "factory-religions"),
        ["factory-religions", ["islam"]]);
    // Every region-capable country is bound, and the set comes from the shared
    // catalogue rather than a `has_region` array stored in the instance file:
    // Cinnamon keeps a generic key's stored value across an upgrade, so a
    // release that added a country used to render its combobox and discard
    // every choice made in it.
    assert.equal(calls.some((row) => row[0] === "bindWithObject"), false);
    assert.equal(lifecycle.holidayRegions.usa, "ny",
        "the initial custom value is available before the provider is configured");
    assert.equal(settings.values.has_region, undefined,
        "the region-capable list is never read out of the instance file");
    // the country is watched for changes, not bound onto the applet as a
    // property: every read goes through the settings accessor
    assert.deepEqual(calls.filter((row) => row[0] === "connect").map((row) => row[1]), [
        "changed::country",
        ...rootModules.holidayConstants.REGION_COUNTRIES.map(
            (country) => `changed::region_${country}`),
        ...rootModules.settingsFacade.RELIGION_IDS.map((id) => `changed::religion-${id}`),
        "changed::calendar-plugins",
        "changed::calendar-plugins-revision",
        "changed::extra-country-calendars"
    ]);
    assert.equal(calls.some((row) => row[0] === "bind" && row[1] === "country"), false);
    // A direct lifecycle with a missing legacy value still resolves to none.
    // Normal construction resolves the timezone default in the binder first.
    assert.ok(calls.some((row) => row[0] === "setValue" && row[1] === "country" && row[2] === "none"));
    assert.ok(calls.some((row) => row[0] === "clear"));
    assert.ok(!calls.some((row) => row[0] === "place"));
    assert.ok(calls.some((row) => row[0] === "refresh"));

    settings.values.country = "none";
    lifecycle.onHolidayPlaceChanged();
    assert.ok(calls.some((row) => row[0] === "clear"));

    settings.values.country = "usa";
    lifecycle.onHolidayPlaceChanged();
    const place = calls.find((row) => row[0] === "place" && row[1] === "usa" && row[2] === "ny");
    assert.ok(place);

    settings.values.region_usa = "ca";
    listeners["changed::region_usa"]();
    assert.ok(calls.some(
        (row) => row[0] === "place" && row[1] === "usa" && row[2] === "ca"),
    "a remote custom-widget change reaches the provider in the same signal turn");

    const activePlaceCalls = calls.filter((row) => row[0] === "place").length;
    settings.values.region_can = "on";
    listeners["changed::region_can"]();
    assert.equal(calls.filter((row) => row[0] === "place").length, activePlaceCalls,
        "an inactive country's region cannot restart the selected place");

    // the third argument repaints when the fetch for the new place lands
    const onUpdated = place[3];
    const before = calls.filter((row) => row[0] === "refresh").length;
    onUpdated();
    assert.equal(calls.filter((row) => row[0] === "refresh").length, before + 1);

    settings.values["religion-christianity"] = true;
    listeners["changed::religion-christianity"]();
    assert.deepEqual(calls.filter((row) => row[0] === "religions").at(-1),
        ["religions", ["christianity", "islam"]]);
    assert.equal(calls.filter((row) => row[0] === "refresh").length, before + 2,
        "changing a religion repaints without restarting the applet");

    settings.values["religion-christianity"] = false;
    settings.values["religion-islam"] = false;
    listeners["changed::religion-islam"]();
    assert.deepEqual(calls.filter((row) => row[0] === "religions").at(-1), ["religions", []]);
    assert.equal(calls.filter((row) => row[0] === "refresh").length, before + 3,
        "clearing the last selection removes observances immediately");
});

function calendarSelectionLifecycle() {
    const calls = [];
    const listeners = new Map();
    const updates = {};
    const settings = {
        values: {
            country: "none",
            "calendar-plugins": ["sample-calendar"],
            "extra-country-calendars": [{ country: "fra", region: "global" }]
        },
        getValue(key) { return this.values[key]; },
        connect(signal, callback) {
            listeners.set(signal, callback);
            return listeners.size;
        },
        finalize() {
            listeners.clear();
            calls.push(["finalize"]);
        }
    };
    const provider = {
        clearPlace() { calls.push(["clear"]); },
        setPluginIds(ids, onUpdated) {
            calls.push(["plugins", ids]);
            updates.plugins = onUpdated;
        },
        setCountries(rows, onUpdated) {
            calls.push(["countries", rows]);
            updates.countries = onUpdated;
        },
        destroy() { calls.push(["destroy", listeners.size]); }
    };
    const lifecycle = new AppletModule.AppletProviderLifecycle({
        holidaySettings: new rootModules.settingsFacade.HolidaySettings(settings),
        onHolidayDataChanged: () => calls.push(["refresh"])
    }, { holidayProvider: () => provider });
    lifecycle.initHolidayProvider();
    return { calls, listeners, updates, settings, lifecycle };
}

test("initial plugin and additional-country selections reach the holiday provider", () => {
    const { calls } = calendarSelectionLifecycle();
    assert.deepEqual(calls, [
        ["clear"], ["refresh"],
        ["plugins", ["sample-calendar"]], ["refresh"],
        ["countries", [{ country: "fra", region: "global" }]], ["refresh"]
    ], "optional calendars remain active when the primary country and religions are off");
});

test("plugin selections and reload signals repaint immediately and when data arrives", () => {
    const { calls, listeners, updates, settings } = calendarSelectionLifecycle();
    calls.length = 0;
    settings.values["calendar-plugins"] = ["another-calendar"];

    listeners.get("changed::calendar-plugins")();
    assert.deepEqual(calls, [["plugins", ["another-calendar"]], ["refresh"]]);
    updates.plugins();
    assert.deepEqual(calls.at(-1), ["refresh"]);
    assert.equal(calls.length, 3);

    calls.length = 0;
    listeners.get("changed::calendar-plugins-revision")();
    assert.deepEqual(calls, [["plugins", ["another-calendar"]], ["refresh"]],
        "reloading a changed manifest reapplies the existing selection");
    updates.plugins();
    assert.deepEqual(calls, [["plugins", ["another-calendar"]], ["refresh"], ["refresh"]]);

    calls.length = 0;
    settings.values["calendar-plugins"] = [];
    listeners.get("changed::calendar-plugins")();
    assert.deepEqual(calls, [["plugins", []], ["refresh"]]);
});

test("additional-country changes reach the provider with a data-arrival repaint", () => {
    const { calls, listeners, updates, settings } = calendarSelectionLifecycle();
    calls.length = 0;
    settings.values["extra-country-calendars"] = [
        { country: "fra", region: "global" }, { country: "deu", region: "be" }
    ];

    listeners.get("changed::extra-country-calendars")();
    assert.deepEqual(calls, [["countries", [
        { country: "fra", region: "global" }, { country: "deu", region: "be" }
    ]], ["refresh"]]);
    updates.countries();
    assert.deepEqual(calls.at(-1), ["refresh"]);
    assert.equal(calls.length, 3);

    calls.length = 0;
    settings.values["extra-country-calendars"] = [];
    listeners.get("changed::extra-country-calendars")();
    assert.deepEqual(calls, [["countries", []], ["refresh"]]);
});

test("applet teardown disconnects calendar selection signals before releasing their provider", () => {
    const { calls, listeners, settings, lifecycle } = calendarSelectionLifecycle();
    const applet = Object.assign(Object.create(Proto), {
        instance_id: 42, settings, _providerLifecycle: lifecycle
    });
    const signals = [
        "changed::calendar-plugins", "changed::calendar-plugins-revision",
        "changed::extra-country-calendars"
    ];
    assert.ok(signals.every((signal) => listeners.has(signal)));
    calls.length = 0;

    Proto.on_applet_removed_from_panel.call(applet);
    assert.deepEqual(calls, [["finalize"], ["destroy", 0]]);
    for (const signal of signals) {
        listeners.get(signal)?.();
    }
    Proto.on_applet_removed_from_panel.call(applet);
    assert.deepEqual(calls, [["finalize"], ["destroy", 0]],
        "late settings signals and repeated removal cannot repaint or reconfigure the provider");
});

// A "Reset to defaults" writes the schema's empty value back on a running
// applet, and the one-time timezone inference only ran at add-to-panel. The key
// stayed empty for the rest of the session — holidays off with no reason given,
// and the Country field blank with only its placeholder, which is what a widget
// that failed to load also looks like.
test("a country reset to the schema default is inferred again, not left blank", () => {
    const unresolved = [];
    const settings = {
        values: { country: "usa" },
        connect: () => 1,
        bindWithObject(obj, key, prop) { obj[prop] = ""; },
        getValue(key) { return this.values[key]; },
        setValue(key, value) { this.values[key] = value; }
    };
    const lifecycle = new AppletModule.AppletProviderLifecycle({
        holidaySettings: new rootModules.settingsFacade.HolidaySettings(settings),
        onHolidayDataChanged: () => {},
        onHolidayCountryUnresolved: () => unresolved.push(true)
    }, {
        holidayProvider: () => ({
            setPlace() {}, clearPlace() {}, setEnabledIds() {},
            setPluginIds() {}, setCountries() {}
        })
    });
    lifecycle.initHolidayProvider();
    assert.deepEqual(unresolved, [], "a resolved country asks for nothing");

    settings.values.country = "";
    lifecycle.onHolidayPlaceChanged();
    assert.deepEqual(unresolved, [true], "the empty sentinel is resolved again");

    // an explicit opt-out is a choice, not an unresolved key
    settings.values.country = "none";
    lifecycle.onHolidayPlaceChanged();
    assert.deepEqual(unresolved, [true]);
});

test("applet wrappers open menus, launch settings, and refresh on resume", (t) => {
    const calls = [];
    let hotkeyCallback = null;
    const keybindings = global.imports.ui.main.keybindingManager;
    const originalAddHotKey = keybindings.addXletHotKey;
    keybindings.addXletHotKey = (applet, name, accelerator, callback) => {
        calls.push(["hotkey", applet.instance_id, name, accelerator]);
        hotkeyCallback = callback;
    };
    t.after(() => {
        keybindings.addXletHotKey = originalAddHotKey;
    });
    const stub = Object.assign(Object.create(Proto), {
        instance_id: 5,
        keyOpen: "Ctrl Space",
        menu: {
            toggled: 0,
            closed: 0,
            toggle() { this.toggled++; },
            close() { this.closed++; },
            setOrientation(o) { calls.push(["orientation", o]); }
        },
        _updateClockAndDate: () => calls.push(["clock"]),
        _scheduleWeatherRefresh: () => calls.push(["weather"]),
        _onSettingsChanged: () => calls.push(["settings"])
    });

    Proto._setKeybinding.call(stub);
    hotkeyCallback();
    Proto.on_applet_clicked.call(stub);
    Proto._openMenu.call(stub);
    Proto._onResume.call(stub);
    Proto._onLaunchSettings.call(stub);
    Proto.on_custom_format_button_pressed.call(stub);
    Proto.on_orientation_changed.call(stub, St.Side.BOTTOM);

    assert.equal(stub.menu.toggled, 3);
    assert.equal(stub.menu.closed, 1);
    assert.ok(calls.some((row) => row[0] === "clock"));
    assert.ok(calls.some((row) => row[0] === "weather"));
    assert.ok(calls.some((row) => row[0] === "orientation" && row[1] === St.Side.BOTTOM));
});

test("clearing the configured shortcut removes the active applet hotkey", (t) => {
    const active = new Map();
    const keybindings = global.imports.ui.main.keybindingManager;
    const originalAddHotKey = keybindings.addXletHotKey;
    keybindings.addXletHotKey = (applet, name, accelerator, callback) => {
        const key = `${applet.instance_id}:${name}`;
        active.delete(key);
        if (!accelerator) {
            return false;
        }
        active.set(key, callback);
        return true;
    };
    t.after(() => {
        keybindings.addXletHotKey = originalAddHotKey;
    });

    const stub = Object.assign(Object.create(Proto), {
        instance_id: 5,
        keyOpen: "Ctrl Space",
        _openMenu() {}
    });

    Proto._setKeybinding.call(stub);
    assert.equal(active.size, 1);

    stub.keyOpen = "";
    Proto._setKeybinding.call(stub);
    assert.equal(active.size, 0);
});

test("About launches the shared GTK page without a shell", () => {
    const launches = [];
    const gio = global.imports.gi.Gio;
    const originalSubprocess = gio.Subprocess;
    const originalFlags = gio.SubprocessFlags;
    gio.SubprocessFlags = { NONE: 0 };
    gio.Subprocess = class {
        constructor(options) {
            launches.push(["construct", options]);
        }

        init(cancellable) {
            launches.push(["init", cancellable]);
        }
    };

    try {
        Proto.openAbout.call(Object.assign(Object.create(Proto), {
            _meta: { path: "/home/user/Chronos App;safe/6.0" }
        }));
    } finally {
        gio.Subprocess = originalSubprocess;
        gio.SubprocessFlags = originalFlags;
    }

    assert.deepEqual(launches, [
        ["construct", {
            argv: [
                "python3",
                "/home/user/Chronos App;safe/6.0/settings_about.py"
            ],
            flags: 0
        }],
        ["init", null]
    ]);
});

test("_updateFormatString always applies the configured format and handles invalid input", () => {
    const builds = [];
    const viewFormats = [];
    const errors = [];
    const originalLogError = global.logError;
    global.logError = (message) => errors.push(message);
    const stub = Object.assign(Object.create(Proto), {
        orientation: St.Side.TOP,
        custom_format: "%H:%M",
        worldclocks: [{ label: "Rome", timezone: "Europe/Rome" }],
        clock: {
            formats: [],
            set_format_string(fmt) {
                this.formats.push(fmt);
                return fmt !== "bad";
            }
        },
        desktop_settings: {
            value: true,
            get use24h() { return this.value; },
            showSeconds: false
        },
        _worldclocks: {
            buildClocks: (clocks) => builds.push(["build", clocks.length]),
            setFormat: (format) => viewFormats.push(format),
            setVisible: (visible) => builds.push(["visible", visible])
        }
    });

    Proto._updateFormatString.call(stub);
    assert.deepEqual(stub.clock.formats, ["%H:%M"]);
    assert.equal(viewFormats.at(-1), "%H:%M");

    stub.custom_format = "bad";
    Proto._updateFormatString.call(stub);
    assert.ok(errors.length > 0);
    // T824: the panel keeps the explanation joined to a safe clock; the
    // world-clock cells are a column of times and take the clock alone
    assert.equal(viewFormats.at(-1), "%H:%M");
    assert.equal(stub.clock.formats.at(-1),
        "Invalid time format; edit it in Settings • %H:%M");
    assert.deepEqual(stub.clock.formats.slice(1), ["bad", stub.clock.formats.at(-1)]);

    const overlong = "x".repeat(rootModules.dateFormats.MAX_DATE_FORMAT_LENGTH + 1);
    const beforeOverlong = stub.clock.formats.length;
    stub.custom_format = overlong;
    Proto._updateFormatString.call(stub);
    assert.deepEqual(stub.clock.formats.slice(beforeOverlong), [stub.clock.formats.at(-1)],
        "an overlong setting never reaches CinnamonDesktop.WallClock");
    assert.equal(viewFormats.at(-1), "%H:%M");
    assert.equal(Object.prototype.hasOwnProperty.call(stub, "worldclock_format"), false);
    assert.equal(viewFormats.length, 3, "each settings pass updates the view-owned format");
    assert.equal(builds.length, 3, "each settings pass reapplies clock visibility only");
    global.logError = originalLogError;
});

test("settings and weather changes update dependent views", () => {
    const calls = [];
    const stub = Object.assign(Object.create(Proto), {
        orientation: St.Side.TOP,
        custom_format: "%H:%M",
        show_events: true,
        desktop_settings: { use24h: false, showSeconds: false },
        _updateFormatString: () => calls.push(["format"]),
        _updateClockAndDate: () => calls.push(["clock"]),
        _queueWeatherRefresh: () => calls.push(["weather"]),
        event_list: {
            actor: { visible: false },
            set_reporting_enabled: () => {},
            set_unavailable: () => {},
            refresh_time_format: () => {}
        },
        events_manager: {
            is_active: () => true,
            disableIfOff: (enabled) => calls.push(["events-enabled", enabled]),
            select_date: (date, force) => calls.push(["select", force])
        },
        _calendar: { getSelectedDate: () => ({ year: 2026, month: 7, day: 9 }) }
    });
    stub._eventListCoordinator = new CoordinatorModule.AppletEventListCoordinator({
        manager: stub.events_manager,
        eventList: () => stub.event_list,
        selectedDate: () => stub._calendar.getSelectedDate(),
        guard: (source, fn) => fn()
    });
    Proto._onSettingsChanged.call(stub);
    Proto._onWeatherSettingsChanged.call(stub);
    Proto._onWeatherUnitsChanged.call(stub);
    assert.equal(stub.event_list.actor.visible, true);
    assert.ok(calls.some((row) => row[0] === "select" && row[1] === true));
    assert.ok(calls.some((row) => row[0] === "weather"));
    assert.equal(calls.filter((row) => row[0] === "weather").length, 1,
        "unit changes repaint without queueing a request");
});

test("panel settings dispatch only their dependent workflows", () => {
    const calls = [];
    const stub = Object.assign(Object.create(Proto), {
        show_events: true,
        _guarded: (source, fn) => fn(),
        _applyFormatSettings: () => calls.push("format"),
        _updateClockAndDate: () => calls.push("clock"),
        _updateAstronomy: () => calls.push("astronomy"),
        _eventListCoordinator: { apply: () => calls.push("events") },
        _weatherCoordinator: {
            applyShowWorldclocks: () => calls.push("cities"),
            queue: () => calls.push("weather")
        }
    });

    const invoke = (method) => {
        calls.length = 0;
        Proto[method].call(stub);
        return calls.slice();
    };

    assert.deepEqual(invoke("_onShowEventsChanged"), ["events"]);
    assert.deepEqual(invoke("_onPanelFormatChanged"), ["format", "clock"]);
    assert.deepEqual(invoke("_onTooltipFormatChanged"), ["clock"]);
    assert.deepEqual(invoke("_onShowWorldclocksChanged"),
        ["format", "clock", "cities"]);
    assert.deepEqual(invoke("_onShowAstronomyChanged"), ["astronomy"]);
    assert.deepEqual(invoke("_onWeatherSettingsChanged"), ["clock", "weather"]);
    assert.deepEqual(invoke("_onWeatherUnitsChanged"), ["clock"]);
});

test("provider initialization wires hover and event manager signals", (t) => {
    const calls = [];
    const previousDisplay = global.display;
    global.display = { marker: "native display" };
    t.after(() => { global.display = previousDisplay; });
    const originalWeatherProvider = rootModules.weather.WeatherProvider;
    const originalCreateEventsManager = rootModules.eventsManager.createEventsManager;
    // the applet's default factories assemble the real graph; this test is about
    // the signal wiring around it, so the holiday root is the thing to replace
    const originalCreateHolidayProvider = rootModules.holidays.createHolidayProvider;
    rootModules.holidays.createHolidayProvider = () => ({
        setPlace() {},
        clearPlace() {},
        setPluginIds() {},
        setCountries() {}
    });
    rootModules.weather.WeatherProvider = class {
        constructor() { calls.push(["weather"]); }
    };
    rootModules.eventsManager.createEventsManager = (settings) => ({
        settings,
        connect(name, cb) {
            calls.push(["connect", name]);
            return calls.length;
        }
    });

    const stub = Object.assign(Object.create(Proto), {
        actor: {
            handlers: {},
            connect(name, cb) {
                this.handlers[name] = cb;
                calls.push(["actor", name]);
                return calls.length;
            }
        },
        events_settings: { showEvents: true },
        holiday_settings: {
            country: "usa",
            regionCountries: [],
            religiousIds: [],
            calendarPlugins: [],
            extraCountryCalendars: [],
            connectCountryChanged() { calls.push(["holiday-init"]); return 1; },
            connectReligionsChanged() { return []; },
            connectCalendarPluginsChanged() { return []; },
            connectExtraCountriesChanged() { return []; },
            bindRegions() {}
        },
        _calendar: null,
        _updateClockAndDate: () => calls.push(["clock"]),
        _onTimezoneChanged: () => calls.push(["timezone"]),
        _settingsBinder: {
            deferInitialHolidayCountry: () => calls.push(["infer-country"])
        }
    });
    Proto._initProviders.call(stub);
    stub._providerLifecycle.context.onTimezoneChanged();
    // the lifecycle fires this when the country key holds the schema's empty
    // sentinel; only the applet knows the binder that owns the inference
    stub._providerLifecycle.context.onHolidayCountryUnresolved();
    // large text changes how much room the popup's columns need, and only the
    // applet holds the menu builder that can be told to reflow
    stub._menuLayout = { reflow: () => calls.push(["reflow"]) };
    stub._providerLifecycle.context.onTextScaleChanged();
    assert.ok(calls.some((row) => row[0] === "reflow"),
        "a desktop text scale change reaches the popup's layout");
    // T943: the same reflow, from the other direction — the applet is the only
    // place that knows which layout manager the geometry comes from
    assert.equal(stub._providerLifecycle.context.layoutManager,
        global.imports.ui.main.layoutManager,
        "the lifecycle is handed the desktop's own layout manager to watch");
    assert.equal(stub._providerLifecycle.context.display, global.display,
        "panel work-area changes come from the native display");
    const beforeMonitors = calls.length;
    stub._providerLifecycle.context.onGeometryChanged();
    assert.deepEqual(calls.slice(beforeMonitors), [["reflow"]],
        "a monitor or resolution change reaches the popup's layout too");
    assert.ok(calls.some((row) => row[0] === "infer-country"),
        "an unresolved country reaches the binder's one-time inference");
    stub.show_weather = true;
    stub.show_worldclocks = true;
    stub.weather_location = "Rome";
    stub.weather_units = "si";
    stub.worldclock_settings = { clocks: [] };
    assert.equal(stub._weatherCoordinator.settings().location, "Rome");
    assert.deepEqual(stub._weatherCoordinator.worldclocks(), []);
    stub._weatherCoordinator.onChanged();
    stub._weatherCoordinator.guard(
        "weather-test", () => calls.push(["weather-guard"]));
    assert.equal(stub._eventListCoordinator.eventList(), undefined);
    stub._calendar = {
        getSelectedDate: () => "selected",
        refreshEventDataAvailability: () => calls.push(["event-data-availability"])
    };
    assert.equal(stub._eventListCoordinator.selectedDate(), "selected");
    stub._eventListCoordinator.guard(
        "events-test", () => calls.push(["events-guard"]));
    stub._eventListCoordinator.onEnabledChanged();
    assert.ok(calls.some((row) => row[0] === "event-data-availability"),
        "a show-events flip reaches the calendar grid through the applet");
    // _panel_hovered gates the expensive path: a tooltip-sized entry list every
    // second. A fresh applet must not think the pointer is already on it.
    assert.equal(stub._panel_hovered, false, "no hover before an enter-event");

    stub.actor.handlers["enter-event"]();
    assert.equal(stub._panel_hovered, true, "an enter-event is what turns it on");

    stub.actor.handlers["leave-event"]();

    rootModules.weather.WeatherProvider = originalWeatherProvider;
    rootModules.eventsManager.createEventsManager = originalCreateEventsManager;
    rootModules.holidays.createHolidayProvider = originalCreateHolidayProvider;

    assert.equal(stub._panel_hovered, false);
    assert.ok(calls.some((row) => row[0] === "weather"));
    assert.ok(calls.some((row) => row[0] === "connect" && row[1] === "events-manager-ready"));
    assert.ok(calls.some((row) => row[0] === "clock"));
    assert.ok(calls.some((row) => row[0] === "timezone"));
    // the holiday provider initializes with its provider siblings
    assert.ok(calls.some((row) => row[0] === "holiday-init"));
    assert.ok(stub.holiday_provider);
});

test("UI build wires calendar, event list, menu items, and world clocks", () => {
    const calls = [];
    const Calendar52 = require(path.join(APPLET_DIR, "6.0", "calendar.js"));
    const EventView52 = require(path.join(APPLET_DIR, "6.0", "eventView.js"));
    const originals = {
        Calendar: Calendar52.Calendar,
        EventList: EventView52.EventList,
        Worldclocks: rootModules.worldclocks.Worldclocks,
        PopupMenuItem: global.imports.ui.popupMenu.PopupMenuItem,
        BoxLayout: global.imports.gi.St.BoxLayout
    };
    class Actor {
        constructor(options = {}) {
            this.handlers = {};
            this.children = [];
            this.pseudo = new Set();
            // St puts these on the actor, and the go-home button reads its own
            // reactive flag to decide whether Enter should do anything
            this.reactive = options.reactive;
            this.can_focus = options.can_focus;
        }
        connect(name, cb) {
            this.handlers[name] = cb;
            return 1;
        }
        set_accessible_name(name) {
            this.accessible_name = name;
        }
        add_actor(child) {
            this.children.push(child);
        }
        add_style_pseudo_class(name) {
            this.pseudo.add(name);
        }
        remove_style_pseudo_class(name) {
            this.pseudo.delete(name);
        }
    }
    global.imports.gi.St.BoxLayout = Actor;
    Calendar52.Calendar = class {
        constructor(settings, manager, holiday) {
            calls.push(["calendar", settings, manager, holiday]);
            this.actor = {};
            this.handlers = {};
        }
        connect(name, cb) {
            calls.push(["calendar-connect", name]);
            this.handlers[name] = cb;
            return 1;
        }
        setDate(date, force) {
            calls.push(["calendar-set-date", Number.isInteger(date.year), force]);
        }
        holidayForDate(date) {
            calls.push(["holiday-for-date", date]);
            return date.day === 2 ? { name: "Republic Day", flags: ["public_holiday"] } : null;
        }
        getSelectedDate() { return null; }
        refreshHolidays() {}
    };
    EventView52.EventList = class {
        constructor(settings) {
            calls.push(["event-list", settings]);
            this.actor = {};
            this.handlers = {};
            this.selectedDate = null;
        }
        connect(name, cb) {
            calls.push(["event-list-connect", name]);
            this.handlers[name] = cb;
            return 1;
        }
        set_date() {}
        set_events(...args) { calls.push(["event-list-set-events", ...args]); }
        set_refresh_failed(failed) { calls.push(["event-list-refresh-failed", failed]); }
    };
    rootModules.worldclocks.Worldclocks = class {
        constructor(box, params) {
            calls.push(["worldclocks", !!box]);
            this.timezoneChanged = params.onTimezoneChanged;
        }
    };
    global.imports.ui.popupMenu.PopupMenuItem = class {
        constructor(label) {
            calls.push(["item", label]);
            this.handlers = {};
            this.label = new global.imports.gi.St.Label();
        }
        connect(name, cb) {
            calls.push(["item-connect", name]);
            this.handlers[name] = cb;
        }
        addActor(actor) { calls.push(["item-actor", actor]); }
    };

    const menuItems = [];
    const stub = Object.assign(Object.create(Proto), {
        menu: {
            addActor: (actor) => calls.push(["menu-actor", !!actor]),
            addMenuItem: (item) => menuItems.push(["menu", item]),
            toggle: () => calls.push(["toggle"])
        },
        _applet_context_menu: {
            addMenuItem: (item) => menuItems.push(["context", item])
        },
        desktop_settings: {},
        events_manager: {
            handlers: {},
            connect(name, cb) {
                calls.push(["manager-connect", name]);
                this.handlers[name] = cb;
                return 1;
            }
        },
        calendar_settings: {},
        events_settings: {},
        holiday_provider: {},
        _initHolidayProvider: () => calls.push(["holiday-init"]),
        _updateClockAndDate: () => {}
    });

    stub._resetCalendar = () => calls.push(["reset"]);
    stub._onLaunchSettings = () => calls.push(["launch-settings"]);
    stub._onTimezoneChanged = () => calls.push(["timezone"]);

    Proto._buildUi.call(stub);
    stub._worldclocks.timezoneChanged();
    assert.ok(calls.some(([name]) => name === "timezone"));
    stub._calendar.handlers["selected-date-changed"]();
    stub.events_manager.handlers["selected-date-changed"](null, { year: 2026, month: 6, day: 2 }, "gdate");
    const calendarEvents = {
        timestamp: 1,
        length: 1,
        get_event_list: () => ["calendar-event"]
    };
    stub.events_manager.handlers["selected-date-events-changed"](
        null, calendarEvents, true, true);
    stub._calendar.handlers["holidays-changed"]();
    stub.events_manager.handlers["refresh-error-changed"](null, true);
    const agendaCall = calls.filter(([name]) => name === "event-list-set-events").at(-1);
    assert.equal(agendaCall[1].hasHolidays, true);
    assert.deepEqual(agendaCall[1].get_event_list().map((event) =>
        event.summary || event), ["Republic Day", "calendar-event"]);
    assert.deepEqual(agendaCall.slice(2), [true, true]);
    assert.deepEqual(calls.find(([name]) => name === "event-list-refresh-failed"),
        ["event-list-refresh-failed", true]);
    stub.event_list.handlers["launched-calendar"]();
    stub.event_list.handlers["start-pass-events"]();
    stub.event_list.handlers["stop-pass-events"]();
    // The body is a section in the menu's item list, and a separator fences the
    // settings entry off from it — the grouping every other Cinnamon menu has.
    const PopupMenuSection = global.imports.ui.popupMenu.PopupMenuSection;
    const PopupSeparatorMenuItem = global.imports.ui.popupMenu.PopupSeparatorMenuItem;
    const mainMenuItems = menuItems.filter(([where]) => where === "menu").map(([, item]) => item);
    assert.ok(mainMenuItems[0] instanceof PopupMenuSection,
              "the calendar body is one section, not a loose actor beside the item list");
    assert.equal(mainMenuItems[0].children.length, 1);
    assert.ok(mainMenuItems[1] instanceof PopupSeparatorMenuItem);
    const footerActors = calls.filter(([name]) => name === "item-actor");
    assert.equal(footerActors.length, 0, "warning text never widens the settings item's columns");
    assert.equal(mainMenuItems[0].children[0].content.children[1], stub._issueReporter.label,
        "the popup's scrollable body owns the separate status row");

    // both menus get their own settings item, and activating one launches the settings
    const settingsItems = menuItems
        .map(([, item]) => item)
        .filter((item) => item.handlers && item.handlers["activate"]);
    assert.equal(settingsItems.length, 2);
    settingsItems.forEach((item) => item.handlers["activate"]());
    stub.go_home_button.handlers["enter-event"](stub.go_home_button, {});
    stub.go_home_button.handlers["leave-event"](stub.go_home_button, {});
    assert.equal(
        stub.go_home_button.handlers["button-press-event"](stub.go_home_button, { get_button: () => 1 }),
        true
    );
    assert.equal(
        stub.go_home_button.handlers["button-release-event"](stub.go_home_button, { get_button: () => 1 }),
        true
    );
    assert.equal(
        stub.go_home_button.handlers["button-press-event"](stub.go_home_button, { get_button: () => 3 }),
        undefined,
        "a secondary click is left for Cinnamon to handle"
    );
    assert.equal(
        stub.go_home_button.handlers["button-release-event"](stub.go_home_button, { get_button: () => 3 }),
        undefined,
        "releasing a secondary click does not go home"
    );
    assert.equal(
        stub.go_home_button.handlers["key-press-event"](stub.go_home_button, { get_key_symbol: () => 65293 }),
        true
    );
    assert.equal(
        stub.go_home_button.handlers["key-press-event"](stub.go_home_button, { get_key_symbol: () => 999 }),
        false
    );

    // it is focusable and Enter-activatable, so it has to say what it is: the
    // two labels inside it are today's date, not what pressing it does
    assert.equal(stub.go_home_button.accessible_name, "Go to today");
    assert.equal(stub.go_home_button.accessible_role, global.imports.gi.Atk.Role.PUSH_BUTTON);

    // and when today is already selected there is nowhere to go: the style said
    // disabled, the behaviour did not
    stub.go_home_button.reactive = false;
    assert.equal(
        stub.go_home_button.handlers["key-press-event"](stub.go_home_button, { get_key_symbol: () => 65293 }),
        false,
        "a disabled button does nothing on Enter"
    );

    Calendar52.Calendar = originals.Calendar;
    EventView52.EventList = originals.EventList;
    rootModules.worldclocks.Worldclocks = originals.Worldclocks;
    global.imports.ui.popupMenu.PopupMenuItem = originals.PopupMenuItem;
    global.imports.gi.St.BoxLayout = originals.BoxLayout;

    // the menu build consumes the provider, it no longer creates it
    assert.ok(!calls.some((row) => row[0] === "holiday-init"));
    assert.ok(calls.some((row) => row[0] === "toggle"), "launching the calendar closes the menu");
    assert.equal(calls.filter((row) => row[0] === "launch-settings").length, 2);
    assert.ok(calls.some((row) => row[0] === "calendar-connect"));
    assert.ok(calls.some((row) => row[0] === "worldclocks"));
    // body section, separator, then the settings entry on each menu
    assert.deepEqual(menuItems.map((row) => row[0]), ["menu", "menu", "context", "menu"]);
    assert.equal(stub.menu.passEvents, false);
});

test("context menu, add-to-panel, reset, and main entrypoint are covered", () => {
    const calls = [];
    const issues = new Map();
    global.imports.ui.applet.AppletPopupMenu = class {
        constructor(owner, orientation) {
            calls.push(["popup", orientation]);
            this.handlers = {};
        }
        connect(name, cb) {
            this.handlers[name] = cb;
            return 1;
        }
        setCustomStyleClass() {}
        addActor() {}
        addMenuItem() {}
        toggle() { calls.push(["toggle"]); }
    };
    const manager = { addMenu: (menu) => calls.push(["add-menu", !!menu]) };
    const stub = Object.assign(Object.create(Proto), {
        orientation: St.Side.TOP,
        menuManager: manager,
        _calendar: { focusSelectedDay: () => calls.push(["focus-day"]) },
        _resetCalendar: () => {
            calls.push(["reset"]);
            if (!issues.has("tried-open")) {
                issues.set("tried-open", true);
                throw new Error("calendar actor is temporarily unavailable");
            }
            return false;
        },
        _updateClockAndDate: (force) => calls.push(["clock", force]),
        _issueReporter: {
            set(source, message) {
                if (message) {
                    issues.set(source, message);
                } else {
                    issues.delete(source);
                }
            }
        }
    });
    Proto._initContextMenu.call(stub);
    stub.menu.handlers["open-state-changed"](stub.menu, true);
    assert.match(issues.get("runtime:menu-open"), /system log/,
        "menu signal failures reach the shared footer");
    stub.menu.handlers["open-state-changed"](stub.menu, true);
    assert.equal(issues.has("runtime:menu-open"), false,
        "the next successful menu open clears only its source");
    assert.ok(calls.some((row) => row[0] === "reset"));
    assert.ok(calls.some((row) => row[0] === "clock" && row[1] === true));
    // Cinnamon focuses the menu actor on open, and the day grid is a descendant
    // of it: unless the menu hands focus down to a day cell, no key event ever
    // reaches the calendar's handler and the whole keyboard surface is dead
    assert.ok(calls.some((row) => row[0] === "focus-day"),
        "opening the menu must move key focus into the day grid");

    const clocksBeforeChangedReset = calls.filter((row) => row[0] === "clock").length;
    stub._resetCalendar = () => {
        calls.push(["reset-changed"]);
        // Calendar emits selected-date-changed synchronously from setDate().
        stub._updateClockAndDate(true);
        return true;
    };
    stub.menu.handlers["open-state-changed"](stub.menu, true);
    assert.equal(calls.filter((row) => row[0] === "clock").length,
        clocksBeforeChangedReset + 1, "a changed selection is not refreshed twice");

    const added = Object.assign(Object.create(Proto), {
        // the constructor sets this last: a build that threw does not have it,
        // and Cinnamon calls on_applet_added_to_panel() anyway
        _constructed: true,
        _settingsBinder: {
            // running the callback is the point: the inference's write emits no
            // changed::country, so this is the only path that re-places the
            // holiday provider in the session that inferred the country
            deferInitialHolidayCountry: (apply) => {
                calls.push(["country-inference"]);
                apply("ita");
            }
        },
        _providerLifecycle: {
            connectClockNotify: (cb) => {
                calls.push(["clock-connect"]);
                calls.clockCallback = cb;
            },
            startDayRollover: () => calls.push(["day-rollover-start"]),
            onHolidayPlaceChanged: () => calls.push(["holiday-place-applied"])
        },
        _onSettingsChanged: () => calls.push(["settings"]),
        _updateClockAndDate: () => calls.push(["clock-notify"]),
        _scheduleWeatherRefresh: () => calls.push(["weather"]),
        events_manager: { start_events: () => calls.push(["start-events"]) },
        _resetCalendar: () => calls.push(["reset-added"])
    });
    Proto.on_applet_added_to_panel.call(added);
    calls.clockCallback();
    assert.ok(calls.some((row) => row[0] === "clock-connect"));
    assert.ok(calls.some((row) => row[0] === "day-rollover-start"));
    assert.ok(calls.some((row) => row[0] === "country-inference"));
    assert.ok(calls.some((row) => row[0] === "holiday-place-applied"),
        "the inferred country reaches the holiday provider in the same session");
    assert.ok(calls.some((row) => row[0] === "clock-notify"));

    const reset = Object.assign(Object.create(Proto), {
        _calendar: {
            setDate: (date, force) => {
                calls.push(["set-date", Number.isInteger(date.year), force]);
                return true;
            }
        }
    });
    assert.equal(Proto._resetCalendar.call(reset), true);
    assert.ok(calls.some((row) => row[0] === "set-date" && row[1] && row[2] === true));

    assert.equal(typeof AppletModule.main({}, St.Side.TOP, 20, 1), "object");
});

test("constructor registers desktop and lifecycle callbacks", () => {
    const calls = [];
    let formatWrites = 0;
    const Calendar52 = require(path.join(APPLET_DIR, "6.0", "calendar.js"));
    const EventView52 = require(path.join(APPLET_DIR, "6.0", "eventView.js"));
    const originals = {
        TextActor: global.imports.ui.applet.TextApplet.prototype.actor,
        TextMenu: global.imports.ui.applet.TextApplet.prototype._applet_context_menu,
        TextInstance: global.imports.ui.applet.TextApplet.prototype.instance_id,
        PopupMenuManager: global.imports.ui.popupMenu.PopupMenuManager,
        AppletPopupMenu: global.imports.ui.applet.AppletPopupMenu,
        AppletSettings: global.imports.ui.settings.AppletSettings,
        GioSettings: global.imports.gi.Gio.Settings,
        WallClock: global.imports.gi.CinnamonDesktop.WallClock,
        WeatherProvider: rootModules.weather.WeatherProvider,
        HolidayProviderFacade: rootModules.holidays.HolidayProviderFacade,
        Calendar: Calendar52.Calendar,
        EventList: EventView52.EventList,
        createEventsManager: rootModules.eventsManager.createEventsManager,
        Worldclocks: rootModules.worldclocks.Worldclocks
    };

    global.imports.ui.applet.TextApplet.prototype.actor = { connect: () => 1 };
    global.imports.ui.applet.TextApplet.prototype._applet_context_menu = { addMenuItem: () => {} };
    global.imports.ui.applet.TextApplet.prototype.instance_id = 99;
    global.imports.ui.popupMenu.PopupMenuManager = class {
        addMenu() {}
    };
    global.imports.ui.applet.AppletPopupMenu = class {
        constructor() { this.handlers = {}; }
        addActor() {}
        addMenuItem() {}
        setCustomStyleClass() {}
        setOrientation() {}
        toggle() {}
        close() {}
        connect(name, cb) {
            this.handlers[name] = cb;
            return 1;
        }
    };
    global.imports.ui.settings.AppletSettings = class {
        constructor() {
            this.values = { country: "none", worldclocks: [] };
        }
        bind(key, prop) {
            this[prop] = this.values[key] || false;
        }
        bindWithObject() {}
        connect() { return 1; }
        getValue(key) { return this.values[key]; }
        setValue(key, value) { this.values[key] = value; }
        finalize() {}
    };
    global.imports.gi.Gio.Settings = class {
        constructor() { this.callbacks = {}; }
        connect(name, cb) {
            this.callbacks[name] = cb;
            return Object.keys(this.callbacks).length;
        }
        disconnect() {}
        get_boolean() { return false; }
        list_keys() {
            return ["clock-use-24h", "clock-show-seconds", "first-day-of-week"];
        }
    };
    global.imports.gi.CinnamonDesktop.WallClock = class {
        connect() { return 1; }
        disconnect() {}
        get_clock() { return "10:00"; }
        get_clock_for_format(fmt) { return fmt; }
        set_format_string() { formatWrites++; return true; }
    };
    rootModules.weather.WeatherProvider = class {
        schedule() {}
        queue() {}
        destroy() {}
    };
    rootModules.holidays.HolidayProviderFacade = class {
        clearPlace() {}
        setPlace() {}
        destroy() {}
    };
    rootModules.eventsManager.createEventsManager = () => ({
        connect() { return 1; },
        is_active() { return true; },
        select_date() {},
        start_events() {},
        destroy() {}
    });
    EventView52.EventList = class {
        constructor() { this.actor = {}; this.selectedDate = null; }
        connect() { return 1; }
        destroy() {}
        set_date() {}
        set_events() {}
        set_reporting_enabled() {}
        set_unavailable() {}
        refresh_time_format() {}
    };
    Calendar52.Calendar = class {
        constructor() { this.actor = {}; }
        connect() { return 1; }
        getSelectedDate() { return rootModules.dateMath.localDateParts(new Date()); }
        holidayForDate() { return null; }
        todaySelected() { return true; }
        refreshHolidays() {}
        setDate() {}
        destroy() {}
    };
    rootModules.worldclocks.Worldclocks = class {
        buildClocks() {}
        setFormat() {}
        updateClocks() {}
        setVisible() {}
        setWeatherSource() {}
        getClockEntries() { return []; }
    };

    const applet = new AppletModule.CinnamonCalendarApplet(St.Side.TOP, 20, 99);
    assert.equal(applet._constructed, true);
    assert.equal(formatWrites, 1, "construction owns the initial format write");
    Proto.on_applet_added_to_panel.call(applet);
    assert.equal(formatWrites, 1, "added-to-panel does not repeat the initial format");
    applet._onSettingsChanged = () => calls.push(["settings"]);
    applet.desktop_settings._settings.callbacks["changed::clock-use-24h"]();
    applet.desktop_settings._settings.callbacks["changed::clock-show-seconds"]();
    assert.deepEqual(calls, [["settings"], ["settings"]]);

    // the collaborators only reach the applet through the context they were
    // given: drive each callback once
    const context = applet._providerLifecycle.context;
    applet._events_manager_ready = () => calls.push(["events-ready"]);
    applet._has_calendars_changed = () => calls.push(["calendars"]);
    applet._updateClockAndDate = (force) => calls.push(["tick", force]);
    applet._scheduleWeatherRefresh = () => calls.push(["weather"]);
    applet._onLaunchSettings = () => calls.push(["launch-settings"]);
    applet._calendar.refreshHolidays = () => calls.push(["holidays"]);
    applet._calendar.refreshToday = () => calls.push(["today"]);

    context.onEventsManagerReady();
    context.onHasCalendarsChanged();
    context.onResume();
    context.onNetworkRestored();
    context.onDayChanged();
    context.onHolidayDataChanged();
    context.onPanelHover(true);
    context.onPanelHover(false);
    assert.equal(applet._panel_hovered, false);
    assert.ok(calls.some((row) => row[0] === "tick" && row[1] === true),
        "midnight forces the menu model even when the panel label is unchanged");

    const menuContext = applet._menuBuilder.context;
    menuContext.onLaunchSettings();

    // the clock notify handler is connected once and re-entrant
    applet._providerLifecycle.connectClockNotify(() => calls.push(["clock-notify"]));
    applet._providerLifecycle.connectClockNotify(() => calls.push(["clock-notify"]));

    assert.deepEqual(calls.filter((row) => row[0] !== "settings" && row[0] !== "tick"), [
        ["events-ready"], ["calendars"], ["weather"], ["weather"], ["today"],
        ["holidays"], ["launch-settings"]
    ]);

    global.imports.ui.applet.TextApplet.prototype.actor = originals.TextActor;
    global.imports.ui.applet.TextApplet.prototype._applet_context_menu = originals.TextMenu;
    global.imports.ui.applet.TextApplet.prototype.instance_id = originals.TextInstance;
    global.imports.ui.popupMenu.PopupMenuManager = originals.PopupMenuManager;
    global.imports.ui.applet.AppletPopupMenu = originals.AppletPopupMenu;
    global.imports.ui.settings.AppletSettings = originals.AppletSettings;
    global.imports.gi.Gio.Settings = originals.GioSettings;
    global.imports.gi.CinnamonDesktop.WallClock = originals.WallClock;
    rootModules.weather.WeatherProvider = originals.WeatherProvider;
    rootModules.holidays.HolidayProviderFacade = originals.HolidayProviderFacade;
    Calendar52.Calendar = originals.Calendar;
    EventView52.EventList = originals.EventList;
    rootModules.eventsManager.createEventsManager = originals.createEventsManager;
    rootModules.worldclocks.Worldclocks = originals.Worldclocks;
});

// themes centre tooltip text; a centred block staggers every row of the clock
// table, so the applet's own style class has to reach the tooltip actor

// T935: large text changes how much room the popup's two columns need, and the
// key lives in the same desktop schema the clock keys do. It joins the same
// teardown list, so nothing new has to be released.
test("a text scale change is bound beside the clock keys and released with them", () => {
    const released = [];
    const reflows = [];
    const desktopSettings = {
        connectClockFormatChanged: () => [1, 2],
        connectTextScaleChanged: (callback) => {
            desktopSettings.textScaleCallback = callback;
            return [3];
        },
        disconnect: (ids) => released.push(...[].concat(ids))
    };
    const lifecycle = new AppletModule.AppletProviderLifecycle({
        desktopSettings,
        onSettingsChanged: () => {},
        onTextScaleChanged: () => reflows.push(true)
    });

    lifecycle.bindSystemSignals();
    assert.deepEqual(lifecycle._desktop_settings_signal_ids, [1, 2, 3]);

    desktopSettings.textScaleCallback();
    assert.deepEqual(reflows, [true]);

    lifecycle._releaseDesktopSettings();
    assert.deepEqual(released, [1, 2, 3], "the new handler is released with the old ones");

    // a Cinnamon whose facade predates the accessor binds the clock keys alone
    const older = { connectClockFormatChanged: () => [7] };
    const legacy = new AppletModule.AppletProviderLifecycle(
        { desktopSettings: older, onSettingsChanged: () => {} });
    legacy.bindSystemSignals();
    assert.deepEqual(legacy._desktop_settings_signal_ids, [7]);
});

// T1047: the module exists so that "every step runs even if an earlier one
// throws". Its own reporter was the one step with no guard: `global.logError`
// is dereferenced straight out of the catch, so a host that does not carry it —
// or one whose logger raises — ends the loop at the first failing step and
// leaves every teardown behind it undone.
test("a teardown finishes even when its own error reporter cannot", () => {
    const AppletTeardown = require(path.join(APPLET_DIR, "6.0", "appletTeardown.js"));
    const original = global.logError;
    const ran = [];

    try {
        delete global.logError;
        AppletTeardown.runTeardownSteps([
            () => ran.push("first"),
            () => { throw new Error("a signal could not be disconnected"); },
            () => ran.push("third")
        ]);
        assert.deepEqual(ran, ["first", "third"],
            "a host with no logError must not lose the steps behind the failure");

        ran.length = 0;
        global.logError = () => { throw new Error("the log itself is gone"); };
        AppletTeardown.runTeardownSteps([
            () => { throw new Error("a timer could not be removed"); },
            () => ran.push("second")
        ]);
        assert.deepEqual(ran, ["second"],
            "a logger that raises is not allowed to end the teardown either");
    } finally {
        global.logError = original;
    }
});
