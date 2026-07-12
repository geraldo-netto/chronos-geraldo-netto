const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "settingsFacade.js");
const shimPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "settingsFacade.js");

test("CalendarSettings exposes intent-named bind methods", () => {
    delete require.cache[require.resolve(modulePath)];
    const SettingsFacade = require(modulePath);
    const calls = [];
    const settings = {
        bindWithObject(target, key, property, callback) {
            calls.push({ target, key, property, callback });
        }
    };
    const facade = new SettingsFacade.CalendarSettings(settings);
    const target = {};
    const callback = function() {};

    facade.bindShowWeekNumbers(target, "show_week_numbers", callback);
    facade.bindWeekendLength(target, "weekend_length", callback);

    assert.deepEqual(calls, [
        {
            target,
            key: SettingsFacade.SHOW_WEEK_NUMBERS_KEY,
            property: "show_week_numbers",
            callback
        },
        {
            target,
            key: SettingsFacade.WEEKEND_LENGTH_KEY,
            property: "weekend_length",
            callback
        }
    ]);
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

    const id = facade.connectCountryChanged(callback);

    assert.equal(id, 7);
    assert.deepEqual(calls, [["connect", "changed::" + SettingsFacade.COUNTRY_KEY]]);
    assert.equal(facade.country, "ita", "and the read still goes through the accessor");
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
    assert.equal(desktop.connectFirstDayOfWeekChanged(() => {}), 3);
    assert.deepEqual(connected.slice(0, 3), [
        "changed::clock-use-24h",
        "changed::clock-show-seconds",
        "changed::first-day-of-week"
    ]);

    desktop.disconnect(2);
    assert.deepEqual(connected.at(-1), ["disconnect", 2]);
});
