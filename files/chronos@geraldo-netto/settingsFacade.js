/* eslint camelcase: "off" */

// The settings boundary: every schema key name lives here, and nothing
// outside this module passes a raw key string to Cinnamon's settings.
//
// That was true only of the applet's own schema. org.cinnamon.desktop.interface
// — which decides whether every clock in this applet is 12- or 24-hour, whether
// it shows seconds, and which day the week starts on — was constructed in two
// places and its raw keys were read in five files. DesktopSettings, below, is
// the same boundary for it.

var SHOW_EVENTS_KEY = "show-events";
var SHOW_WEEK_NUMBERS_KEY = "show-week-numbers";
var WEEKEND_LENGTH_KEY = "weekend-length";
var COUNTRY_KEY = "country";
var HAS_REGION_KEY = "has_region";
var REGION_KEY_PREFIX = "region_";
var WORLDCLOCKS_KEY = "worldclocks";
var SHOW_WORLDCLOCKS_KEY = "show-worldclocks";
var KEY_OPEN_KEY = "keyOpen";
var WEATHER_LOCATION_KEY = "weather-location";

// key -> applet property, grouped by the handler each one triggers
var PANEL_KEYS = [
    [SHOW_EVENTS_KEY, "show_events"],
    ["panel-clocks", "panel_clocks"],
    ["use-custom-format", "use_custom_format"],
    ["custom-format", "custom_format"],
    ["custom-tooltip-format", "custom_tooltip_format"],
    [SHOW_WORLDCLOCKS_KEY, "show_worldclocks"]
];
var WEATHER_KEYS = [
    ["show-weather", "show_weather"],
    ["weather-units", "weather_units"]
];

// Keys the settings dialog draws with a widget of its own, which makes their
// schema type "custom" — and Cinnamon binds only the types in its SETTINGS_TYPES
// table, which "custom" is not in. settings.bind() on one of these logs
// "Invalid setting type 'custom'" and binds nothing, so the applet property stays
// undefined for the life of the process: the location never reaches the geocoder
// and the weather silently never loads. changed::<key> is still emitted for them,
// so they are mirrored onto the applet by hand.
var CUSTOM_WEATHER_KEYS = [
    [WEATHER_LOCATION_KEY, "weather_location"]
];

// Cinnamon's desktop schema, and the three keys this applet reads from it.
var DESKTOP_SCHEMA = "org.cinnamon.desktop.interface";
var CLOCK_USE_24H_KEY = "clock-use-24h";
var CLOCK_SHOW_SECONDS_KEY = "clock-show-seconds";
var FIRST_DAY_OF_WEEK_KEY = "first-day-of-week";
var DESKTOP_KEYS = [CLOCK_USE_24H_KEY, CLOCK_SHOW_SECONDS_KEY, FIRST_DAY_OF_WEEK_KEY];

// Gio.Settings.get_boolean() on a key the schema does not carry answers `false`.
// Not an error, not a warning — false. So if Cinnamon ever renames one of these,
// the panel label, the tooltip and every event row's time all quietly switch to
// 12-hour, seconds disappear, and nothing anywhere says why. The keys are asked
// for once, at construction, and a missing one is reported.
var DesktopSettings = class DesktopSettings {
    constructor(settings) {
        this._settings = settings;
        this._known = null;

        if (typeof settings.list_keys !== "function") {
            return;
        }

        this._known = new Set(settings.list_keys());
        for (const key of DESKTOP_KEYS) {
            if (!this._known.has(key) && global.logError) {
                global.logError(`chronos@geraldo-netto: ${DESKTOP_SCHEMA} has no "${key}"; ` +
                    "falling back to the 24-hour default rather than reading it as off");
            }
        }
    }

    _boolean(key, fallback) {
        if (this._known && !this._known.has(key)) {
            return fallback;
        }

        return this._settings.get_boolean(key);
    }

    // 24-hour is the fallback for a key that is not there: it is the format the
    // rest of the world uses, and reading a missing key as `false` — which is
    // what Gio does — means silently picking 12-hour for everyone
    get use24h() {
        return this._boolean(CLOCK_USE_24H_KEY, true);
    }

    get showSeconds() {
        return this._boolean(CLOCK_SHOW_SECONDS_KEY, false);
    }

    connectClockFormatChanged(callback) {
        return [CLOCK_USE_24H_KEY, CLOCK_SHOW_SECONDS_KEY].map(
            (key) => this._settings.connect("changed::" + key, callback));
    }

    connectFirstDayOfWeekChanged(callback) {
        return this._settings.connect("changed::" + FIRST_DAY_OF_WEEK_KEY, callback);
    }

    disconnect(id) {
        this._settings.disconnect(id);
    }
};

var CalendarSettings = class CalendarSettings {
    constructor(settings) {
        this._settings = settings;
    }

    bindShowWeekNumbers(target, property, callback) {
        this._settings.bindWithObject(target, SHOW_WEEK_NUMBERS_KEY, property, callback);
    }

    bindWeekendLength(target, property, callback) {
        this._settings.bindWithObject(target, WEEKEND_LENGTH_KEY, property, callback);
    }
};

var EventsSettings = class EventsSettings {
    constructor(settings) {
        this._settings = settings;
    }

    get showEvents() {
        return this._settings.getValue(SHOW_EVENTS_KEY);
    }
};

var HolidaySettings = class HolidaySettings {
    constructor(settings) {
        this._settings = settings;
    }

    get country() {
        return this._settings.getValue(COUNTRY_KEY);
    }

    set country(value) {
        this._settings.setValue(COUNTRY_KEY, value);
    }

    // countries whose holidays are region-specific; each has its own key
    get regionCountries() {
        return this._settings.getValue(HAS_REGION_KEY);
    }

    // A bind() would also define `country` as a property on the applet, and
    // nothing reads it: every read goes through the accessor above. The bind
    // existed for its change callback alone — a producer with no consumer, and
    // a second way to ask the same question that could disagree with the first.
    // Cinnamon emits changed::<key> for every key whether it is bound or not.
    connectCountryChanged(callback) {
        return this._settings.connect("changed::" + COUNTRY_KEY, callback);
    }

    bindRegions(target, callback) {
        for (let country of this.regionCountries) {
            this._settings.bindWithObject(target, REGION_KEY_PREFIX + country, country, callback);
        }
    }
};

var WorldclockSettings = class WorldclockSettings {
    constructor(settings) {
        this._settings = settings;
    }

    get clocks() {
        return this._settings.getValue(WORLDCLOCKS_KEY);
    }

    connectChanged(callback) {
        return this._settings.connect("changed::" + WORLDCLOCKS_KEY, callback);
    }
};

var PanelSettings = class PanelSettings {
    constructor(settings) {
        this._settings = settings;
    }

    // the panel label reads these straight off the applet, so they are bound
    // as applet properties rather than read through accessors
    // No target: these call settings.bind(), which binds onto the applet that
    // owns the settings object, not bindWithObject. The parameter was passed by
    // every caller and read by neither. (CalendarSettings.bindShowWeekNumbers
    // genuinely does take one — it uses bindWithObject.)
    bindPanelKeys(callback) {
        for (let [key, property] of PANEL_KEYS) {
            this._settings.bind(key, property, callback);
        }
    }

    bindWeatherKeys(target, callback) {
        for (let [key, property] of WEATHER_KEYS) {
            this._settings.bind(key, property, callback);
        }

        for (let [key, property] of CUSTOM_WEATHER_KEYS) {
            target[property] = this._settings.getValue(key);
            this._settings.connect("changed::" + key, () => {
                target[property] = this._settings.getValue(key);
                callback();
            });
        }
    }

    bindKeybinding(callback) {
        this._settings.bind(KEY_OPEN_KEY, KEY_OPEN_KEY, callback);
    }
};

if (typeof module !== "undefined") {
    module.exports = {
        CalendarSettings,
        DesktopSettings,
        EventsSettings,
        HolidaySettings,
        WorldclockSettings,
        PanelSettings,
        DESKTOP_SCHEMA,
        DESKTOP_KEYS,
        CLOCK_USE_24H_KEY,
        CLOCK_SHOW_SECONDS_KEY,
        FIRST_DAY_OF_WEEK_KEY,
        SHOW_EVENTS_KEY,
        SHOW_WEEK_NUMBERS_KEY,
        WEEKEND_LENGTH_KEY,
        COUNTRY_KEY,
        HAS_REGION_KEY,
        REGION_KEY_PREFIX,
        WORLDCLOCKS_KEY,
        SHOW_WORLDCLOCKS_KEY,
        KEY_OPEN_KEY,
        WEATHER_LOCATION_KEY,
        PANEL_KEYS,
        WEATHER_KEYS,
        CUSTOM_WEATHER_KEYS
    };
}
