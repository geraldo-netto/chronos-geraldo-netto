const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");

const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "settingsFacade.js");
const shimPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "6.0", "settingsFacade.js");

function assertHolidayChoiceRound(SettingsFacade, random, currentValues, inferredValues) {
    const initial = currentValues[Math.floor(random() * currentValues.length)];
    const inferred = inferredValues[Math.floor(random() * inferredValues.length)];
    const values = { country: initial };
    const writes = [];
    let resolutions = 0;
    const facade = new SettingsFacade.HolidaySettings({
        getValue: (key) => values[key],
        setValue(key, value) {
            values[key] = value;
            writes.push([key, value]);
        }
    });

    const shouldResolve = initial === null || initial === undefined || initial === "";
    const inferredCountry = inferred || "none";
    const expectedCountry = shouldResolve ? inferredCountry : initial;
    const result = facade.fillInitialCountryFromTimezone(() => {
        resolutions += 1;
        return inferred;
    });

    assert.equal(values.country, expectedCountry);
    assert.equal(result, shouldResolve ? (inferred || "") : "");
    assert.equal(resolutions, shouldResolve ? 1 : 0);
    assert.equal(writes.length, shouldResolve ? 1 : 0);

    const writesAfterFirstCall = writes.length;
    assert.equal(facade.fillInitialCountryFromTimezone(() => {
        resolutions += 1;
        return "jpn";
    }), "");
    assert.equal(values.country, expectedCountry);
    assert.equal(resolutions, shouldResolve ? 1 : 0);
    assert.equal(writes.length, writesAfterFirstCall);
}

test("CalendarSettings exposes intent-named bind methods", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const calls = [];
    const values = { "weekend-length": 2 };
    const settings = {
        bindWithObject(target, key, property, callback) {
            calls.push({ target, key, property, callback });
        },
        getValue: (key) => values[key],
        setValue: (key, value) => { values[key] = value; }
    };
    const facade = new SettingsFacade.CalendarSettings(settings);
    const target = {};
    const callback = function() {};

    facade.bindShowWeekNumbers(target, "show_week_numbers", callback);
    facade.bindWeekendLength(target, "weekend_length", callback);

    assert.deepEqual(calls.map(({ target: boundTarget, key, property }) =>
        ({ target: boundTarget, key, property })), [
        { target, key: SettingsFacade.SHOW_WEEK_NUMBERS_KEY, property: "show_week_numbers" },
        { target, key: SettingsFacade.WEEKEND_LENGTH_KEY, property: "weekend_length" }
    ]);
    assert.equal(calls[0].callback, callback);
    assert.equal(typeof calls[1].callback, "function");
});

test("CalendarSettings recovers invalid weekend lengths at runtime", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const values = { "weekend-length": 3 };
    const writes = [];
    let changed = null;
    const settings = {
        getValue: (key) => values[key],
        setValue(key, value) {
            values[key] = value;
            writes.push([key, value]);
        },
        bindWithObject(target, key, property, callback) {
            Object.defineProperty(target, property, {
                configurable: true,
                get: () => values[key],
                set: (value) => { values[key] = value; }
            });
            changed = () => {
                callback(values[key]);
            };
        }
    };
    const facade = new SettingsFacade.CalendarSettings(settings);
    const target = {};
    const callbacks = [];

    facade.bindWeekendLength(target, "weekend_length", (value) => callbacks.push(value));

    assert.equal(target.weekend_length, SettingsFacade.DEFAULT_WEEKEND_LENGTH);
    assert.deepEqual(writes, [[SettingsFacade.WEEKEND_LENGTH_KEY,
        SettingsFacade.DEFAULT_WEEKEND_LENGTH]]);

    for (const supported of [1, 2]) {
        values[SettingsFacade.WEEKEND_LENGTH_KEY] = supported;
        changed();
        assert.equal(target.weekend_length, supported);
    }

    values[SettingsFacade.WEEKEND_LENGTH_KEY] = 7;
    changed();
    assert.equal(target.weekend_length, SettingsFacade.DEFAULT_WEEKEND_LENGTH);
    assert.deepEqual(writes.at(-1), [SettingsFacade.WEEKEND_LENGTH_KEY,
        SettingsFacade.DEFAULT_WEEKEND_LENGTH]);
    assert.deepEqual(callbacks, [1, 2, SettingsFacade.DEFAULT_WEEKEND_LENGTH]);
});

test("EventsSettings exposes showEvents without leaking schema keys", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const requested = [];
    const facade = new SettingsFacade.EventsSettings({
        getValue(key) {
            requested.push(key);
            return key === SettingsFacade.SHOW_EVENTS_KEY;
        }
    });

    assert.equal(facade.showEvents, true);
    assert.deepEqual(requested, [SettingsFacade.SHOW_EVENTS_KEY]);
});

test("version shim forwards the shared settings facade API", () => {
    const shared = {
        CalendarSettings: class {},
        EventsSettings: class {},
        SHOW_EVENTS_KEY: "show-events",
        SHOW_WEEK_NUMBERS_KEY: "show-week-numbers",
        WEEKEND_LENGTH_KEY: "weekend-length"
    };
    const context = {
        module: { exports: null },
        imports: {
            ui: {
                appletManager: {
                    applets: {
                        "chronos@geraldo-netto": { settingsFacade: shared }
                    }
                }
            }
        }
    };

    vm.createContext(context);
    vm.runInContext(fs.readFileSync(shimPath, "utf8"), context);

    assert.equal(context.module.exports, shared);
});

test("settings tables reuse the facade's canonical key and sentinel values", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);

    assert.deepEqual(SettingsFacade.PANEL_KEYS.slice(1, 3), [
        [SettingsFacade.CUSTOM_FORMAT_KEY, "custom_format", "onPanelFormatChanged"],
        [SettingsFacade.CUSTOM_TOOLTIP_FORMAT_KEY, "custom_tooltip_format",
            "onTooltipFormatChanged"]
    ]);
    assert.equal(SettingsFacade.NO_HOLIDAYS, "none");
    const schema = require(path.join(__dirname, "..", "files", "chronos@geraldo-netto",
        "6.0", "settings-schema.json"));
    assert.equal(SettingsFacade.DEFAULT_WEEKEND_LENGTH, schema["weekend-length"].default);
    assert.deepEqual(SettingsFacade.WEEKEND_LENGTH_VALUES,
        Object.values(schema["weekend-length"].options));
});

test("legacy shipped date formats migrate to the fixed-order defaults once", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const values = {
        "custom-format": "%A, %B %e, %H:%M",
        "custom-tooltip-format": "%A, %B %e, %H:%M",
        "date-format-defaults-migrated": false
    };
    const settings = {
        getValue: (key) => values[key],
        setValue: (key, value) => { values[key] = value; }
    };
    const panel = new SettingsFacade.PanelSettings(settings);

    panel.migrateDateFormatDefaults();

    assert.equal(values["custom-format"], "%d %b %H:%M");
    assert.equal(values["custom-tooltip-format"], "%d %b %H:%M");
    assert.equal(values["date-format-defaults-migrated"], true);

    values["custom-format"] = "%A, %B %e, %H:%M";
    panel.migrateDateFormatDefaults();
    assert.equal(values["custom-format"], "%A, %B %e, %H:%M",
        "after migration, the same text is a deliberate user choice");
});

test("date-format migration preserves values that were already customized", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const values = {
        "custom-format": "%Y-%m-%d %H:%M",
        "custom-tooltip-format": "%A, %B %e, %H:%M",
        "date-format-defaults-migrated": false
    };
    const panel = new SettingsFacade.PanelSettings({
        getValue: (key) => values[key],
        setValue: (key, value) => { values[key] = value; }
    });

    panel.migrateDateFormatDefaults();

    assert.equal(values["custom-format"], "%Y-%m-%d %H:%M");
    assert.equal(values["custom-tooltip-format"], "%d %b %H:%M");
});

// The country used to be bound onto the applet as a property, which nothing read
// — every read goes through the accessor. The bind was there for its change
// callback alone, and a bind that defines an unread property is a second source
// of truth waiting to disagree with the first.
test("the country is watched for changes, not bound onto the applet", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const calls = [];
    const settings = {
        bind(key, property) { calls.push(["bind", key, property]); },
        connect(signal) { calls.push(["connect", signal]); return 7; },
        getValue() { return "ita"; }
    };
    const facade = new SettingsFacade.HolidaySettings(settings);
    const callback = function() {};

    const ids = facade.connectCountryChanged(callback);

    assert.deepEqual(ids, [7]);
    assert.deepEqual(calls, [["connect", "changed::" + SettingsFacade.COUNTRY_KEY]]);
    assert.equal(facade.country, "ita", "and the read still goes through the accessor");
});

test("religious selections are master-gated and every key is watched", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const values = {
        "show-religious-observances": false,
        "religion-christianity": true,
        "religion-islam": true
    };
    const connected = [];
    const settings = {
        getValue: (key) => values[key],
        connect(signal, callback) {
            connected.push([signal, callback]);
            return connected.length;
        }
    };
    const facade = new SettingsFacade.HolidaySettings(settings);
    const callback = function() {};

    assert.deepEqual(facade.religiousIds, [], "disabled means no runtime selection");
    values[SettingsFacade.SHOW_RELIGIOUS_OBSERVANCES_KEY] = true;
    assert.deepEqual(facade.religiousIds, ["christianity", "islam"]);

    assert.deepEqual(facade.connectReligionsChanged(callback),
        Array.from({ length: SettingsFacade.RELIGION_IDS.length + 1 }, (_, index) => index + 1));
    assert.deepEqual(connected.map(([signal]) => signal), [
        "changed::show-religious-observances",
        ...SettingsFacade.RELIGION_IDS.map((id) => `changed::religion-${id}`)
    ]);
    assert.ok(connected.every(([, listener]) => listener === callback));
});

test("the operating-system timezone fills only the initial holiday country", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const values = { country: "" };
    const writes = [];
    const settings = {
        getValue: (key) => values[key],
        setValue(key, value) {
            values[key] = value;
            writes.push([key, value]);
        }
    };
    const facade = new SettingsFacade.HolidaySettings(settings);
    let resolutions = 0;

    assert.equal(facade.fillInitialCountryFromTimezone(() => {
        resolutions++;
        return "ita";
    }), "ita");
    assert.equal(values.country, "ita");
    assert.equal(resolutions, 1);
    assert.deepEqual(writes, [[SettingsFacade.COUNTRY_KEY, "ita"]]);

    values.country = "none";
    assert.equal(facade.fillInitialCountryFromTimezone(() => {
        throw new Error("a completed default must never be resolved again");
    }), "");
    assert.equal(values.country, "none", "an explicit disable survives restart");
});

test("holiday country inference preserves existing choices and disables missing zones", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);

    const existing = { country: "fra" };
    const existingFacade = new SettingsFacade.HolidaySettings({
        getValue: (key) => existing[key],
        setValue: (key, value) => { existing[key] = value; }
    });
    assert.equal(existingFacade.fillInitialCountryFromTimezone(() => {
        throw new Error("an existing user choice must not read tzdata");
    }), "");
    assert.equal(existing.country, "fra");

    const optedOut = { country: "none" };
    const optedOutFacade = new SettingsFacade.HolidaySettings({
        getValue: (key) => optedOut[key],
        setValue: (key, value) => { optedOut[key] = value; }
    });
    assert.equal(optedOutFacade.fillInitialCountryFromTimezone(() => {
        throw new Error("an existing opt-out must not be turned into network traffic");
    }), "");
    assert.equal(optedOut.country, "none",
        "the old default is indistinguishable from an explicit opt-out, so upgrades preserve it");

    const missing = { country: null };
    const missingFacade = new SettingsFacade.HolidaySettings({
        getValue: (key) => missing[key],
        setValue: (key, value) => { missing[key] = value; }
    });
    assert.equal(missingFacade.fillInitialCountryFromTimezone(() => ""), "");
    assert.equal(missing.country, "none");
});

test("fuzz: timezone defaults never overwrite an existing holiday choice", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const random = makeRandom(0x7011da);
    const currentValues = ["", null, undefined, "none", "ita", "fra", "jpn"];
    const inferredValues = ["", null, "ita", "fra", "jpn"];

    for (let round = 0; round < 500; round++) {
        assertHolidayChoiceRound(SettingsFacade, random, currentValues, inferredValues);
    }
});

// Gio.Settings.get_boolean() on a key the schema does not carry answers false —
// not an error. So a Cinnamon key rename would have flipped the panel format,
// the tooltip format and every event row's time to 12-hour, dropped seconds, and
// said nothing anywhere. Five files read these keys as raw strings; now one does.
test("a desktop key that is gone is reported, not read as off", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const logged = [];
    const originalLogError = global.logError;
    global.logError = (message) => logged.push(String(message));

    try {
        const renamed = new SettingsFacade.DesktopSettings({
            list_keys: () => ["first-day-of-week"],
            get_boolean: () => false
        });

        assert.equal(logged.length, 2, "both missing keys are named");
        assert.ok(logged.every((line) => /has no "clock-/.test(line)));
        // 24-hour is the fallback: reading a missing key as `false` is what
        // silently picks 12-hour for the whole world
        assert.equal(renamed.use24h, true);
        assert.equal(renamed.showSeconds, false);
    } finally {
        global.logError = originalLogError;
    }
});

test("the desktop settings read the keys the schema does carry", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const asked = [];
    const connected = [];
    const desktop = new SettingsFacade.DesktopSettings({
        list_keys: () => SettingsFacade.DESKTOP_KEYS,
        get_boolean(key) {
            asked.push(key);
            return key === SettingsFacade.CLOCK_USE_24H_KEY;
        },
        connect(signal) {
            connected.push(signal);
            return connected.length;
        },
        disconnect(id) { connected.push(["disconnect", id]); }
    });

    assert.equal(desktop.use24h, true);
    assert.equal(desktop.showSeconds, false);
    assert.deepEqual(asked, ["clock-use-24h", "clock-show-seconds"]);

    assert.deepEqual(desktop.connectClockFormatChanged(() => {}), [1, 2]);
    assert.deepEqual(desktop.connectFirstDayOfWeekChanged(() => {}), [3]);
    assert.deepEqual(connected.slice(0, 3), [
        "changed::clock-use-24h",
        "changed::clock-show-seconds",
        "changed::first-day-of-week"
    ]);

    desktop.disconnect(2);
    assert.deepEqual(connected.at(-1), ["disconnect", 2]);
});

// REGRESSION: these are drawn by widgets of the applet's own, which makes their
// schema type "custom" — and Cinnamon binds only the types in its SETTINGS_TYPES
// table. bind() on one logs "Invalid setting type 'custom'" and binds nothing.
test("custom weather settings reach the applet without Cinnamon bindings", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);

    const bound = [];
    const listeners = {};
    const values = { "weather-location": "Genoa", "weather-units": "imperial" };
    const settings = {
        bind(key, property, callback) {
            assert.equal(key, "show-weather", "custom keys must never reach bind()");
            bound.push([key, property, callback]);
        },
        connect: (signal, callback) => { listeners[signal] = callback; },
        getValue: (key) => values[key],
        setValue: (key, value) => { values[key] = value; }
    };
    const applet = {};
    let refreshes = 0;
    let repaints = 0;

    new SettingsFacade.PanelSettings(settings).bindWeatherKeys(
        applet, () => refreshes++, () => repaints++);

    assert.deepEqual(bound.map(([key]) => key), ["show-weather"],
        "neither custom-widget key is among the bound ones");
    assert.equal(applet.weather_location, "Genoa",
        "and it still reaches the applet, through the mirror");
    assert.equal(applet.weather_units, "imperial",
        "the saved unit reaches weather rendering on first construction");

    values["weather-units"] = "si";
    listeners["changed::weather-units"]();
    assert.equal(applet.weather_units, "si");
    assert.equal(repaints, 1, "units repaint retained readings");
    assert.equal(refreshes, 0, "units do not enter the request path");

    // a changed:: signal is emitted for every key, bound or not
    values["weather-location"] = "Lisbon";
    listeners["changed::weather-location"]();
    assert.equal(applet.weather_location, "Lisbon");
    assert.equal(refreshes, 1, "and the change refetches the weather, once");
});

test("custom holiday regions are mirrored before their callback runs", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const values = {};
    const listeners = {};
    const regionValues = Object.fromEntries(
        require(path.join(__dirname, "..", "files", "chronos@geraldo-netto",
            "holidayConstants.js")).REGION_COUNTRIES
            .map((country) => [`region_${country}`, country === "usa" ? "ny" : "global"]));
    Object.assign(values, regionValues);
    const settings = {
        bindWithObject() {
            throw new Error("Cinnamon cannot bind a custom region widget");
        },
        getValue: (key) => values[key],
        connect(signal, callback) {
            listeners[signal] = callback;
            return Object.keys(listeners).length;
        }
    };
    const target = {};
    const callbacks = [];
    const regions = new SettingsFacade.HolidaySettings(settings);

    regions.bindRegions(target, () => callbacks.push(target.usa));

    assert.equal(target.usa, "ny");
    assert.equal(Object.keys(listeners).length, regions.regionCountries.length);
    assert.ok(regions.regionCountries.every(
        (country) => `changed::region_${country}` in listeners));

    values.region_usa = "ca";
    listeners["changed::region_usa"]();
    assert.equal(target.usa, "ca");
    assert.deepEqual(callbacks, ["ca"], "the observer sees the newly mirrored value");
});

test("an empty weather location is filled with the city the timezone names", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);

    const values = { "weather-location": "" };
    const settings = {
        bind: () => {},
        connect: () => {},
        getValue: (key) => values[key],
        setValue: (key, value) => { values[key] = value; }
    };
    const applet = {};
    const panel = new SettingsFacade.PanelSettings(settings);

    assert.equal(panel.fillEmptyWeatherLocation(applet, "Rome"), "Rome");
    assert.equal(values["weather-location"], "Rome",
        "it is written into the field, not just used: the user has to be able to correct it");
    assert.equal(applet.weather_location, "Rome");

    // a location the user chose is never overwritten
    assert.equal(panel.fillEmptyWeatherLocation(applet, "Lisbon"), "");
    assert.equal(values["weather-location"], "Rome");

    // ...and a machine whose timezone names no city (UTC, an offset-only zone)
    // is left alone: the panel already says "Set a weather location"
    values["weather-location"] = "";
    assert.equal(panel.fillEmptyWeatherLocation(applet, ""), "");
    assert.equal(values["weather-location"], "");
});

// T935: the popup's layout depends on how big the desktop's text is, and the
// factor comes from the same schema the clock keys do. Gio answers 0.0 for a
// double the schema does not carry, and 0 is not "no scaling" — it is text
// that takes no room, which would tell the layout rule the columns always fit.
test("accessibility text scaling is read, and a missing factor is 1.0", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);

    const scaled = new SettingsFacade.DesktopSettings({
        list_keys: () => SettingsFacade.DESKTOP_KEYS,
        get_double: (key) => (key === SettingsFacade.TEXT_SCALING_FACTOR_KEY ? 1.25 : 0)
    });
    assert.equal(scaled.textScale, 1.25);

    // a schema without the key, and a Gio that answers 0 for it
    const missing = new SettingsFacade.DesktopSettings({
        list_keys: () => [SettingsFacade.CLOCK_USE_24H_KEY,
            SettingsFacade.CLOCK_SHOW_SECONDS_KEY, SettingsFacade.FIRST_DAY_OF_WEEK_KEY],
        get_double: () => 0
    });
    assert.equal(missing.textScale, SettingsFacade.DEFAULT_TEXT_SCALE);

    const zero = new SettingsFacade.DesktopSettings({
        list_keys: () => SettingsFacade.DESKTOP_KEYS,
        get_double: () => 0
    });
    assert.equal(zero.textScale, SettingsFacade.DEFAULT_TEXT_SCALE);

    // an older Gio binding with no double accessor at all
    const bare = new SettingsFacade.DesktopSettings({ get_boolean: () => true });
    assert.equal(bare.textScale, SettingsFacade.DEFAULT_TEXT_SCALE);
});

test("a text scale change is a signal on the same settings object", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const connected = [];
    const desktop = new SettingsFacade.DesktopSettings({
        list_keys: () => SettingsFacade.DESKTOP_KEYS,
        connect(name) {
            connected.push(name);
            return connected.length;
        }
    });

    assert.deepEqual(desktop.connectTextScaleChanged(() => {}), [1]);
    assert.deepEqual(connected, ["changed::text-scaling-factor"]);
});
