const {
    assert, test, path, APPLET_DIR, rootModules,
    AppletModule, CoordinatorModule, PanelStatusModule, Proto, Weather, St
} = require("./helpers/appletFixture");

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
    const stub = Object.assign(Object.create(Proto), {
        _constructed: true,
        instance_id: 7,
        _providerLifecycle: { destroy: () => torn.push(["lifecycle"]) },
        _calendar: { destroy: () => torn.push(["calendar"]) },
        event_list: { destroy: () => torn.push(["list"]) },
        menu: { destroy: () => torn.push(["menu"]) },
        menuManager: { removeMenu: () => torn.push(["unmanage"]) },
        settings: { finalize: () => torn.push(["settings"]) }
    });
    Proto.on_applet_removed_from_panel.call(stub);
    // the menu is parented to Main.uiGroup: nothing else would ever destroy it
    assert.deepEqual(torn, [
        ["lifecycle"], ["calendar"], ["list"], ["unmanage"], ["menu"], ["settings"]
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
        setPlace(...args) { places.push(["place", ...args]); }
    };

    const settings = {
        // "ind" is not one of the countries the combobox offers: an older
        // config could still hold it
        values: { has_region: [], country: "ind" },
        bind() {},
        bindWithObject() {},
        connect() { return 1; },
        getValue(key) { return this.values[key]; },
        setValue(key, value) { this.values[key] = value; }
    };

    const lifecycle = new AppletModule.AppletProviderLifecycle({
        holidaySettings: new rootModules.settingsFacade.HolidaySettings(settings),
        onHolidayPlaceChanged: () => {}
    }, { holidayProvider: () => holidayProvider });
    lifecycle.initHolidayProvider();

    global.logError = originalLogError;

    assert.equal(settings.values.country, "none");
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
        disconnect: (id) => torn.push(["desktop", id])
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

    const Calendar = require(path.join(APPLET_DIR, "5.4", "calendar.js"));
    const HolidayConstants = require(path.join(APPLET_DIR, "holidayConstants.js"));
    const holidayErrors = Object.values(HolidayConstants.HOLIDAY_ERRORS);
    const renderedHolidayErrors = Object.keys(Calendar.HOLIDAY_ERROR_TEXT);
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
    const originalRemove = keybindings.removeHotKey;
    keybindings.removeHotKey = (name) => torn.push(["hotkey", name]);

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
    assert.deepEqual(torn, [["hotkey", "calendar-open-9"], ["lifecycle"], ["settings"]]);

    // removal after a failed construction must not tear down twice
    Proto.on_applet_removed_from_panel.call(stub);
    assert.deepEqual(torn, [["hotkey", "calendar-open-9"], ["lifecycle"], ["settings"]]);

    keybindings.removeHotKey = originalRemove;
});

test("provider lifecycle tears down provider and system resources", () => {
    const torn = [];
    const context = {
        actor: { disconnect: (id) => torn.push(["actor", id]) },
        desktopSettings: { disconnect: (id) => torn.push(["desk", id]) }
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

test("bindSystemSignals refetches on logind resume and unsubscribes on destroy", () => {
    const resumed = [];
    let captured = null;
    let unsubscribed = null;
    const context = {
        onResume: () => resumed.push(true),
        desktopSettings: { connectClockFormatChanged: () => [1, 2] }
    };
    global.imports.gi.Gio.DBus = {
        system: {
            signal_subscribe: (sender, iface, member, path, arg0, flags, cb) => {
                captured = { member, path, cb };
                return 55;
            },
            signal_unsubscribe: (id) => {
                unsubscribed = id;
            }
        }
    };
    global.imports.gi.Gio.DBusSignalFlags = { NONE: 0 };

    try {
        const lifecycle = new AppletModule.AppletProviderLifecycle(context);
        lifecycle.bindSystemSignals();

        assert.equal(captured.member, "PrepareForSleep");
        assert.equal(lifecycle._logind_sleep_signal_id, 55);

        // true = going into sleep -> no refetch; false = resumed -> refetch
        const emit = (sleeping) => captured.cb(null, null, captured.path,
            "org.freedesktop.login1.Manager", "PrepareForSleep", { deep_unpack: () => [sleeping] });
        emit(true);
        assert.deepEqual(resumed, [], "nothing is refetched on the way into sleep");
        emit(false);
        assert.deepEqual(resumed, [true], "the weather is refetched on wake");

        lifecycle.destroy();
        assert.equal(unsubscribed, 55, "the system-bus subscription is released");
        assert.equal(lifecycle._logind_sleep_signal_id, 0);
    } finally {
        delete global.imports.gi.Gio.DBus;
        delete global.imports.gi.Gio.DBusSignalFlags;
    }
});

test("settings binding wires schema keys and creates settings facades", () => {
    const binds = [];
    let keybindingChanged = null;
    const original = global.imports.ui.settings.AppletSettings;
    global.imports.ui.settings.AppletSettings = class {
        constructor(owner, uuid, instanceId) {
            binds.push(["ctor", uuid, instanceId]);
        }
        bind(key, prop, cb) {
            binds.push(["bind", key, prop, typeof cb]);
            if (key === "keyOpen") {
                keybindingChanged = cb;
            }
        }
        connect() {}
        getValue() { return []; }
        setValue(key, value) { binds.push(["setValue", key, value]); }
    };

    const stub = Object.assign(Object.create(Proto), {
        instance_id: 42,
        _setKeybinding: () => binds.push(["hotkey"])
    });
    Proto._bindSettings.call(stub);
    keybindingChanged();
    global.imports.ui.settings.AppletSettings = original;

    assert.ok(stub.calendar_settings);
    assert.ok(stub.events_settings);
    assert.deepEqual(binds[0], ["ctor", "chronos@geraldo-netto", 42]);
    assert.ok(binds.some((row) => row[1] === "show-events"));
    assert.ok(binds.some((row) => row[1] === "custom-format"));
    assert.ok(binds.some((row) => row[1] === "custom-tooltip-format"));
    assert.ok(!binds.some((row) => row[1] === "use-custom-format"));
    assert.equal(binds.filter((row) => row[0] === "hotkey").length, 2,
        "initial binding and a changed accelerator both install the hotkey");

    // REGRESSION: weather-location is drawn by a custom widget, and Cinnamon
    // binds only the types in its SETTINGS_TYPES table — "custom" is not one.
    // It was bound anyway: the bind failed with "Invalid setting type", the
    // applet property stayed undefined for the life of the process, and the
    // weather silently never loaded for anyone. It is mirrored by hand instead.
    assert.ok(!binds.some((row) => row[0] === "bind" && row[1] === "weather-location"),
        "a custom-widget key cannot be bound; Cinnamon refuses it");
    // the mirror reads the key and writes the applet property itself: this
    // double answers [] for every getValue, and that is what lands on it
    assert.deepEqual(stub.weather_location, [],
        "the location reaches the applet through the mirror, not through bind()");
});

test("holiday-country inference yields startup and preserves later choices", () => {
    const originalSettings = global.imports.ui.settings.AppletSettings;
    const originalCountryCode = rootModules.worldclockData.localCountryCode;
    const originalIdleAdd = global.imports.mainloop.idle_add;
    const originalSourceRemove = global.imports.mainloop.source_remove;
    const idles = [];
    const removed = [];
    const values = {
        "date-format-defaults-migrated": true,
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
        Proto._bindSettings.call(stub);
        assert.equal(timezoneReads, 0, "construction performs no tzdata I/O");
        assert.equal(values.country, "");
        stub._settingsBinder.deferInitialHolidayCountry();
        assert.equal(idles.length, 1, "inference waits on the main-loop idle");
        assert.equal(idles[0](), false);
        assert.equal(values.country, "ita");

        values.country = "none";
        Proto._bindSettings.call(stub);
        stub._settingsBinder.deferInitialHolidayCountry();
        assert.equal(idles.length, 1, "an explicit choice schedules no read");

        values.country = "";
        Proto._bindSettings.call(stub);
        stub._settingsBinder.deferInitialHolidayCountry();
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

test("settings binding preserves a pre-existing holiday opt-out on upgrade", () => {
    const originalSettings = global.imports.ui.settings.AppletSettings;
    const originalCountryCode = rootModules.worldclockData.localCountryCode;
    const values = {
        "date-format-defaults-migrated": true,
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
        "date-format-defaults-migrated": true,
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
        destroy() {}
    };
    const settings = {
        values: {
            has_region: ["usa"],
            country: null,
            "show-religious-observances": true,
            "religion-islam": true
        },
        bind(key, prop, cb) { calls.push(["bind", key, prop]); },
        connect(signal, callback) {
            calls.push(["connect", signal]);
            listeners[signal] = callback;
            return Object.keys(listeners).length;
        },
        bindWithObject(obj, key, prop, cb) {
            calls.push(["bindWithObject", key, prop]);
            obj[prop] = "ny";
        },
        getValue(key) { return this.values[key]; },
        setValue(key, value) {
            calls.push(["setValue", key, value]);
            this.values[key] = value;
        }
    };
    const lifecycle = new AppletModule.AppletProviderLifecycle({
        holidaySettings: new rootModules.settingsFacade.HolidaySettings(settings),
        onHolidayPlaceChanged: () => calls.push(["refresh"])
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
    assert.deepEqual(calls.filter((row) => row[0] === "bindWithObject"), [
        ["bindWithObject", "region_usa", "usa"]
    ]);
    // the country is watched for changes, not bound onto the applet as a
    // property: every read goes through the settings accessor
    assert.deepEqual(calls.filter((row) => row[0] === "connect").map((row) => row[1]), [
        "changed::country",
        "changed::show-religious-observances",
        ...rootModules.settingsFacade.RELIGION_IDS.map((id) => `changed::religion-${id}`)
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
});

test("applet wrappers open menus, launch settings, and refresh on resume", (t) => {
    const calls = [];
    let hotkeyCallback = null;
    const keybindings = global.imports.ui.main.keybindingManager;
    const originalAddHotKey = keybindings.addHotKey;
    keybindings.addHotKey = (name, accelerator, callback) => {
        calls.push(["hotkey", name, accelerator]);
        hotkeyCallback = callback;
    };
    t.after(() => {
        keybindings.addHotKey = originalAddHotKey;
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
    Proto.on_openstreetmap_attribution_pressed.call(stub);
    Proto.on_orientation_changed.call(stub, St.Side.BOTTOM);

    assert.equal(stub.menu.toggled, 3);
    assert.equal(stub.menu.closed, 1);
    assert.ok(calls.some((row) => row[0] === "clock"));
    assert.ok(calls.some((row) => row[0] === "weather"));
    assert.ok(calls.some((row) => row[0] === "orientation" && row[1] === St.Side.BOTTOM));
});

test("weather attribution opens the OpenStreetMap copyright page", () => {
    const commands = [];
    const util = global.imports.misc.util;
    const original = util.spawnCommandLine;
    util.spawnCommandLine = (command) => commands.push(command);
    try {
        Proto.on_openstreetmap_attribution_pressed.call(Object.create(Proto));
    } finally {
        util.spawnCommandLine = original;
    }

    assert.deepEqual(commands,
        ["xdg-open https://www.openstreetmap.org/copyright"]);
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
            _meta: { path: "/home/user/Chronos App;safe/5.4" }
        }));
    } finally {
        gio.Subprocess = originalSubprocess;
        gio.SubprocessFlags = originalFlags;
    }

    assert.deepEqual(launches, [
        ["construct", {
            argv: [
                "python3",
                "/home/user/Chronos App;safe/5.4/settings_about.py"
            ],
            flags: 0
        }],
        ["init", null]
    ]);
});

test("_updateFormatString always applies the configured format and handles invalid input", () => {
    const builds = [];
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
            buildClocks: (clocks, format) => builds.push(["build", clocks.length, format]),
            setFormat: (format) => builds.push(["format", format]),
            setVisible: (visible) => builds.push(["visible", visible])
        }
    });

    Proto._updateFormatString.call(stub);
    assert.equal(stub.clock.formats.at(-1), "%H:%M");
    assert.equal(stub.worldclock_format, "%H:%M");

    stub.custom_format = "bad";
    Proto._updateFormatString.call(stub);
    assert.ok(errors.length > 0);
    assert.ok(stub.worldclock_format.includes("Invalid time format"));

    const overlong = "x".repeat(rootModules.dateFormats.MAX_DATE_FORMAT_LENGTH + 1);
    stub.custom_format = overlong;
    Proto._updateFormatString.call(stub);
    assert.ok(!stub.clock.formats.includes(overlong),
        "an overlong setting never reaches CinnamonDesktop.WallClock");
    assert.ok(stub.worldclock_format.includes("Invalid time format"));
    assert.ok(builds.length >= 4);
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
            select_date: (date, force) => calls.push(["select", force])
        },
        _calendar: { getSelectedDate: () => new Date(2026, 6, 9) }
    });
    stub._eventListCoordinator = new CoordinatorModule.AppletEventListCoordinator({
        manager: stub.events_manager,
        eventList: () => stub.event_list,
        selectedDate: () => stub._calendar.getSelectedDate(),
        guard: (source, fn) => fn()
    });
    Proto._onSettingsChanged.call(stub);
    Proto._onWeatherSettingsChanged.call(stub);
    assert.equal(stub.event_list.actor.visible, true);
    assert.ok(calls.some((row) => row[0] === "select" && row[1] === true));
    assert.ok(calls.some((row) => row[0] === "weather"));
});

test("an unrelated settings keystroke costs no refetch and no clock rebuild", () => {
    const calls = [];
    const stub = Object.assign(Object.create(Proto), {
        orientation: St.Side.TOP,
        custom_format: "%H:%M",
        custom_tooltip_format: "%A",
        show_events: true,
        desktop_settings: { use24h: false, showSeconds: false },
        _updateFormatString: () => calls.push(["format"]),
        _updateClockAndDate: () => calls.push(["clock"]),
        event_list: {
            actor: { visible: false },
            set_reporting_enabled: () => {},
            set_unavailable: () => {},
            refresh_time_format: () => {}
        },
        events_manager: {
            is_active: () => true,
            select_date: (date, force) => calls.push(["select", force])
        },
        _calendar: { getSelectedDate: () => new Date(2026, 6, 9) }
    });
    stub._eventListCoordinator = new CoordinatorModule.AppletEventListCoordinator({
        manager: stub.events_manager,
        eventList: () => stub.event_list,
        selectedDate: () => stub._calendar.getSelectedDate(),
        guard: (source, fn) => fn()
    });

    Proto._onSettingsChanged.call(stub);
    const afterFirst = calls.length;

    // typing in the tooltip-format entry fires the handler per keystroke; the
    // panel format did not change, and neither did show-events
    stub.custom_tooltip_format = "%A, %B";
    Proto._onSettingsChanged.call(stub);
    stub.custom_tooltip_format = "%A, %B %e";
    Proto._onSettingsChanged.call(stub);

    const extra = calls.slice(afterFirst);
    assert.deepEqual(extra, [["clock"], ["clock"]],
        "no forced month refetch and no world-clock rebuild for unrelated keys");

    // a real format change still rebuilds
    stub.custom_format = "%H:%M:%S";
    Proto._onSettingsChanged.call(stub);
    assert.ok(calls.slice(-2).some((row) => row[0] === "format"));
});

test("provider initialization wires hover and event manager signals", () => {
    const calls = [];
    const originalWeatherProvider = rootModules.weather.WeatherProvider;
    const originalCreateEventsManager = rootModules.eventsManager.createEventsManager;
    // the applet's default factories assemble the real graph; this test is about
    // the signal wiring around it, so the holiday root is the thing to replace
    const originalCreateHolidayProvider = rootModules.holidays.createHolidayProvider;
    rootModules.holidays.createHolidayProvider = () => ({
        setPlace() {},
        clearPlace() {}
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
            connectCountryChanged() { calls.push(["holiday-init"]); return 1; },
            connectReligionsChanged() { return []; },
            bindRegions() {}
        },
        _calendar: null,
        _updateClockAndDate: () => calls.push(["clock"])
    });
    Proto._initProviders.call(stub);
    stub.show_weather = true;
    stub.show_worldclocks = true;
    stub.weather_location = "Rome";
    stub.weather_units = "si";
    stub.worldclocks = [];
    assert.equal(stub._weatherCoordinator.settings().location, "Rome");
    assert.deepEqual(stub._weatherCoordinator.worldclocks(), []);
    stub._weatherCoordinator.onChanged();
    stub._weatherCoordinator.guard(
        "weather-test", () => calls.push(["weather-guard"]));
    assert.equal(stub._eventListCoordinator.eventList(), undefined);
    stub._calendar = {
        getSelectedDate: () => "selected",
        refreshEventsEnabled: () => calls.push(["events-enabled"])
    };
    assert.equal(stub._eventListCoordinator.selectedDate(), "selected");
    stub._eventListCoordinator.guard(
        "events-test", () => calls.push(["events-guard"]));
    stub._eventListCoordinator.onEnabledChanged();
    assert.ok(calls.some((row) => row[0] === "events-enabled"),
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
    // the holiday provider initializes with its provider siblings
    assert.ok(calls.some((row) => row[0] === "holiday-init"));
    assert.ok(stub.holiday_provider);
});

test("UI build wires calendar, event list, menu items, and world clocks", () => {
    const calls = [];
    const Calendar52 = require(path.join(APPLET_DIR, "5.4", "calendar.js"));
    const EventView52 = require(path.join(APPLET_DIR, "5.4", "eventView.js"));
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
            calls.push(["calendar-set-date", date instanceof Date, force]);
        }
        refreshHolidays() {}
    };
    EventView52.EventList = class {
        constructor(settings) {
            calls.push(["event-list", settings]);
            this.actor = {};
            this.handlers = {};
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
        constructor(box) { calls.push(["worldclocks", !!box]); }
    };
    global.imports.ui.popupMenu.PopupMenuItem = class {
        constructor(label) { calls.push(["item", label]); this.handlers = {}; }
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

    Proto._buildUi.call(stub);
    stub._calendar.handlers["selected-date-changed"]();
    stub.events_manager.handlers["selected-date-changed"](null, "gdate");
    stub.events_manager.handlers["selected-date-events-changed"](
        null, "events", true, true);
    stub.events_manager.handlers["refresh-error-changed"](null, true);
    assert.deepEqual(calls.find(([name]) => name === "event-list-set-events"),
        ["event-list-set-events", "events", true, true]);
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
    assert.equal(footerActors.length, 1, "only the popup menu owns the footer label");
    assert.equal(footerActors[0][1], stub._issueReporter.label);

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

    const added = Object.assign(Object.create(Proto), {
        // the constructor sets this last: a build that threw does not have it,
        // and Cinnamon calls on_applet_added_to_panel() anyway
        _constructed: true,
        _settingsBinder: {
            deferInitialHolidayCountry: () => calls.push(["country-inference"])
        },
        _providerLifecycle: {
            connectClockNotify: (cb) => {
                calls.push(["clock-connect"]);
                calls.clockCallback = cb;
            }
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
    assert.ok(calls.some((row) => row[0] === "country-inference"));
    assert.ok(calls.some((row) => row[0] === "clock-notify"));

    const reset = Object.assign(Object.create(Proto), {
        _calendar: { setDate: (date, force) => calls.push(["set-date", date instanceof Date, force]) }
    });
    Proto._resetCalendar.call(reset);
    assert.ok(calls.some((row) => row[0] === "set-date" && row[1] && row[2] === true));

    assert.equal(typeof AppletModule.main({}, St.Side.TOP, 20, 1), "object");
});

test("constructor registers desktop and lifecycle callbacks", () => {
    const calls = [];
    const Calendar52 = require(path.join(APPLET_DIR, "5.4", "calendar.js"));
    const EventView52 = require(path.join(APPLET_DIR, "5.4", "eventView.js"));
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
            this.values = { has_region: [], country: "none", worldclocks: [] };
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
        set_format_string() { return true; }
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
        constructor() { this.actor = {}; }
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
        getSelectedDate() { return new Date(); }
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
    applet._onSettingsChanged = () => calls.push(["settings"]);
    applet.desktop_settings._settings.callbacks["changed::clock-use-24h"]();
    applet.desktop_settings._settings.callbacks["changed::clock-show-seconds"]();
    assert.deepEqual(calls, [["settings"], ["settings"]]);

    // the collaborators only reach the applet through the context they were
    // given: drive each callback once
    const context = applet._providerLifecycle.context;
    applet._events_manager_ready = () => calls.push(["events-ready"]);
    applet._has_calendars_changed = () => calls.push(["calendars"]);
    applet._updateClockAndDate = () => calls.push(["tick"]);
    applet._scheduleWeatherRefresh = () => calls.push(["weather"]);
    applet._onLaunchSettings = () => calls.push(["launch-settings"]);
    applet._calendar.refreshHolidays = () => calls.push(["holidays"]);

    context.onEventsManagerReady();
    context.onHasCalendarsChanged();
    context.onResume();
    context.onHolidayPlaceChanged();
    context.onPanelHover(true);
    context.onPanelHover(false);
    assert.equal(applet._panel_hovered, false);

    const menuContext = applet._menuBuilder.context;
    menuContext.onLaunchSettings();

    // the clock notify handler is connected once and re-entrant
    applet._providerLifecycle.connectClockNotify(() => calls.push(["clock-notify"]));
    applet._providerLifecycle.connectClockNotify(() => calls.push(["clock-notify"]));

    assert.deepEqual(calls.filter((row) => row[0] !== "settings" && row[0] !== "tick"), [
        ["events-ready"], ["calendars"], ["weather"], ["holidays"], ["launch-settings"]
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
