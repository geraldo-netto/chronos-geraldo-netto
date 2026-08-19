// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* eslint camelcase: "off" */

/* global imports */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const ReligiousCatalog = IS_NODE ?
    require("./religiousCatalog") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].religiousCatalog;
const HolidayConstants = IS_NODE ?
    require("./holidayConstants") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayConstants;

// The settings boundary: every schema key name lives here, and nothing
// outside this module passes a raw key string to Cinnamon's settings.
//
// That was true only of the applet's own schema. org.cinnamon.desktop.interface
// — which decides whether every clock in this applet is 12- or 24-hour, whether
// it shows seconds, and which day the week starts on — was constructed in two
// places and its raw keys were read in five files. DesktopSettings, below, is
// the same boundary for it.

var SHOW_EVENTS_KEY = "show-events"; // NOSONAR [S3504] -- GJS importer export
var SHOW_WEEK_NUMBERS_KEY = "show-week-numbers"; // NOSONAR [S3504] -- GJS importer export
var WEEKEND_LENGTH_KEY = "weekend-length"; // NOSONAR [S3504] -- GJS importer export
var WEEKEND_LENGTH_VALUES = [1, 2]; // NOSONAR [S3504] -- GJS importer export
var DEFAULT_WEEKEND_LENGTH = 2; // NOSONAR [S3504] -- GJS importer export
var COUNTRY_KEY = "country"; // NOSONAR [S3504] -- GJS importer export
var REGION_KEY_PREFIX = "region_"; // NOSONAR [S3504] -- GJS importer export
var SHOW_RELIGIOUS_OBSERVANCES_KEY = "show-religious-observances"; // NOSONAR [S3504] -- GJS importer export
var RELIGION_KEY_PREFIX = "religion-"; // NOSONAR [S3504] -- GJS importer export
// The schema is a static Cinnamon artifact; this shared runtime catalogue is
// authoritative, and a parity test holds the artifact to it.
var RELIGION_IDS = ReligiousCatalog.RELIGION_IDS; // NOSONAR [S3504] -- GJS importer export
var WORLDCLOCKS_KEY = "worldclocks"; // NOSONAR [S3504] -- GJS importer export
var SHOW_WORLDCLOCKS_KEY = "show-worldclocks"; // NOSONAR [S3504] -- GJS importer export
var SHOW_ASTRONOMY_KEY = "show-astronomy"; // NOSONAR [S3504] -- GJS importer export
var KEY_OPEN_KEY = "keyOpen"; // NOSONAR [S3504] -- GJS importer export
var WEATHER_LOCATION_KEY = "weather-location"; // NOSONAR [S3504] -- GJS importer export
var CUSTOM_FORMAT_KEY = "custom-format"; // NOSONAR [S3504] -- GJS importer export
var CUSTOM_TOOLTIP_FORMAT_KEY = "custom-tooltip-format"; // NOSONAR [S3504] -- GJS importer export
var PANEL_FONT_SCALE_KEY = "panel-font-scale"; // NOSONAR [S3504] -- GJS importer export
var DATE_FORMAT_DEFAULTS_MIGRATED_KEY = "date-format-defaults-migrated"; // NOSONAR [S3504] -- GJS importer export
var LEGACY_DATE_TIME_FORMAT = "%A, %B %e, %H:%M"; // NOSONAR [S3504] -- GJS importer export
var DEFAULT_DATE_TIME_FORMAT = "%d %b %H:%M"; // NOSONAR [S3504] -- GJS importer export
var NO_HOLIDAYS = "none"; // NOSONAR [S3504] -- GJS importer export

// key -> applet property -> semantic handler. The schema keys and their effect
// routing live together, so adding a setting cannot silently join the generic
// repaint path.
var PANEL_KEYS = [ // NOSONAR [S3504] -- GJS importer export
    [SHOW_EVENTS_KEY, "show_events", "onShowEventsChanged"],
    [CUSTOM_FORMAT_KEY, "custom_format", "onPanelFormatChanged"],
    [CUSTOM_TOOLTIP_FORMAT_KEY, "custom_tooltip_format", "onTooltipFormatChanged"],
    [PANEL_FONT_SCALE_KEY, "panel_font_scale", "onPanelFontScaleChanged"],
    [SHOW_WORLDCLOCKS_KEY, "show_worldclocks", "onShowWorldclocksChanged"],
    [SHOW_ASTRONOMY_KEY, "show_astronomy", "onShowAstronomyChanged"]
];
var WEATHER_KEYS = [ // NOSONAR [S3504] -- GJS importer export
    ["show-weather", "show_weather"]
];
// Keys the settings dialog draws with a widget of its own, which makes their
// schema type "custom" — and Cinnamon binds only the types in its SETTINGS_TYPES
// table, which "custom" is not in: bindWithObject returns false and logs
// invalid_setting_type_error. changed::<key> is still emitted for them, so every
// custom runtime value goes through the explicit mirror below instead.
//
// Both of these are "custom" in 6.0/settings-schema.json — units as much as
// location. They were two tables, and the comment sat over only the second, so
// folding weather-units into WEATHER_KEYS above read as safe and would have left
// temperatures in the wrong unit for the rest of the session. One table, one
// explanation; the third column is only which callback the change fires, because
// a presentation key redraws the reading and a request key refetches it.
var MIRRORED_WEATHER_KEYS = [ // NOSONAR [S3504] -- GJS importer export
    ["weather-units", "weather_units", "presentation"],
    [WEATHER_LOCATION_KEY, "weather_location", "request"]
];

function mirrorSetting(settings, target, key, property, callback) {
    target[property] = settings.getValue(key);
    return settings.connect("changed::" + key, () => {
        target[property] = settings.getValue(key);
        callback();
    });
}

// Cinnamon's desktop schema, and the keys this applet reads from it.
var DESKTOP_SCHEMA = "org.cinnamon.desktop.interface"; // NOSONAR [S3504] -- GJS importer export
var CLOCK_USE_24H_KEY = "clock-use-24h"; // NOSONAR [S3504] -- GJS importer export
var CLOCK_SHOW_SECONDS_KEY = "clock-show-seconds"; // NOSONAR [S3504] -- GJS importer export
var FIRST_DAY_OF_WEEK_KEY = "first-day-of-week"; // NOSONAR [S3504] -- GJS importer export
// Accessibility large text. It scales every label in the popup, so it changes
// how much room the month grid and the agenda column need beside each other.
var TEXT_SCALING_FACTOR_KEY = "text-scaling-factor"; // NOSONAR [S3504] -- GJS importer export
var DEFAULT_TEXT_SCALE = 1; // NOSONAR [S3504] -- GJS importer export
var DESKTOP_KEYS = [CLOCK_USE_24H_KEY, CLOCK_SHOW_SECONDS_KEY, FIRST_DAY_OF_WEEK_KEY, TEXT_SCALING_FACTOR_KEY]; // NOSONAR [S3504] -- GJS importer export
// The subset whose absence is worth a log line. Gio reads a missing boolean as
// `false`, which is how a renamed clock key would silently switch the whole
// applet to 12-hour; a missing text factor is 1.0, which is the factor it would
// have had anyway.
var DESKTOP_REPORTED_KEYS = [CLOCK_USE_24H_KEY, CLOCK_SHOW_SECONDS_KEY, FIRST_DAY_OF_WEEK_KEY]; // NOSONAR [S3504] -- GJS importer export

// Gio.Settings.get_boolean() on a key the schema does not carry answers `false`.
// Not an error, not a warning — false. So if Cinnamon ever renames one of these,
// the panel label, the tooltip and every event row's time all quietly switch to
// 12-hour, seconds disappear, and nothing anywhere says why. The keys are asked
// for once, at construction, and a missing one is reported.
var DesktopSettings = class DesktopSettings { // NOSONAR [S3504] -- GJS importer export
    constructor(settings) {
        this._settings = settings;
        this._known = null;

        if (typeof settings.list_keys !== "function") {
            return;
        }

        this._known = new Set(settings.list_keys());
        for (const key of DESKTOP_REPORTED_KEYS) {
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

    // A missing or nonsensical factor is 1.0, not 0: reading it as Gio would
    // (0.0 for an absent double) would tell the layout rule that the popup's
    // text takes no room at all.
    get textScale() {
        if (this._known && !this._known.has(TEXT_SCALING_FACTOR_KEY)) {
            return DEFAULT_TEXT_SCALE;
        }
        if (typeof this._settings.get_double !== "function") {
            return DEFAULT_TEXT_SCALE;
        }
        const value = this._settings.get_double(TEXT_SCALING_FACTOR_KEY);
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_TEXT_SCALE;
    }

    connectTextScaleChanged(callback) {
        return this._settings.connect(
            "changed::" + TEXT_SCALING_FACTOR_KEY, callback);
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

var CalendarSettings = class CalendarSettings { // NOSONAR [S3504] -- GJS importer export
    constructor(settings) {
        this._settings = settings;
    }

    bindShowWeekNumbers(target, property, callback) {
        this._settings.bindWithObject(target, SHOW_WEEK_NUMBERS_KEY, property, callback);
    }

    bindWeekendLength(target, property, callback) {
        const normalize = () => {
            const value = this._settings.getValue(WEEKEND_LENGTH_KEY);
            if (!WEEKEND_LENGTH_VALUES.includes(value)) {
                this._settings.setValue(WEEKEND_LENGTH_KEY, DEFAULT_WEEKEND_LENGTH);
                return DEFAULT_WEEKEND_LENGTH;
            }
            return value;
        };

        // A radiogroup constrains the settings UI, not an imported or manually
        // edited JSON value. Normalize before Cinnamon installs its property
        // accessor, then again before the calendar sees a remote change. Keep
        // bindWithObject as the owner so settings.finalize() still removes the
        // binding with every other applet setting.
        normalize();
        this._settings.bindWithObject(target, WEEKEND_LENGTH_KEY, property,
            function(_value, ...args) {
                callback.apply(target, [normalize()].concat(args));
            });
    }
};

var EventsSettings = class EventsSettings { // NOSONAR [S3504] -- GJS importer export
    constructor(settings) {
        this._settings = settings;
    }

    get showEvents() {
        return this._settings.getValue(SHOW_EVENTS_KEY);
    }
};

var HolidaySettings = class HolidaySettings { // NOSONAR [S3504] -- GJS importer export
    constructor(settings) {
        this._settings = settings;
    }

    get country() {
        return this._settings.getValue(COUNTRY_KEY);
    }

    set country(value) {
        this._settings.setValue(COUNTRY_KEY, value);
    }

    // The schema's empty value means a genuinely new setting. Older versions
    // used "none" as their default, so an existing "none" may be an explicit
    // opt-out and must survive an upgrade. Resolve only the empty sentinel,
    // then replace it with either a country or "none": every later value is a
    // user choice, and an existing choice does not cost a tzdata read.
    //
    // The returned country is not a convenience — it is the only notification
    // there is. See connectCountryChanged below: this write emits nothing, so a
    // caller that discards the return value leaves the provider on whatever
    // place it already had. `fillEmptyWeatherLocation` compensates for the same
    // silence by assigning `target.weather_location` by hand.
    fillInitialCountryFromTimezone(resolveCountry) {
        const current = this.country;
        if (current !== "" && current != null) {
            return "";
        }

        const inferred = resolveCountry();
        this.country = inferred || NO_HOLIDAYS;
        return inferred || "";
    }

    // Countries whose holidays are region-specific; each has its own key. This
    // is a release fact, not a user choice, so it comes from the shared
    // catalogue rather than the instance file — see REGION_COUNTRIES.
    get regionCountries() {
        return HolidayConstants.REGION_COUNTRIES;
    }

    // A bind() would also define `country` as a property on the applet, and
    // nothing reads it: every read goes through the accessor above. The bind
    // existed for its change callback alone — a producer with no consumer, and
    // a second way to ask the same question that could disagree with the first.
    //
    // This fires for a *remote* change — the settings dialog writing over D-Bus
    // — and only for that. Cinnamon's `setValue` mutates `settingsData` in place
    // and saves; `changed::<key>` is emitted from `_checkSettings`, which
    // `remoteUpdate` alone reaches. Our own writes are therefore silent, and
    // cannot even notify retroactively, because `_checkSettings` reloads from
    // the file `setValue` has already written. Any self-write that something
    // must react to has to say so in-band.
    connectCountryChanged(callback) {
        return this._settings.connect("changed::" + COUNTRY_KEY, callback);
    }

    get religiousIds() {
        if (!this._settings.getValue(SHOW_RELIGIOUS_OBSERVANCES_KEY)) {
            return [];
        }

        return RELIGION_IDS.filter(
            (id) => this._settings.getValue(RELIGION_KEY_PREFIX + id));
    }

    connectReligionsChanged(callback) {
        return [SHOW_RELIGIOUS_OBSERVANCES_KEY].concat(
            RELIGION_IDS.map((id) => RELIGION_KEY_PREFIX + id))
            .map((key) => this._settings.connect("changed::" + key, callback));
    }

    bindRegions(target, callback) {
        for (let country of this.regionCountries) {
            mirrorSetting(
                this._settings, target, REGION_KEY_PREFIX + country, country,
                () => callback(country));
        }
    }
};

var WorldclockSettings = class WorldclockSettings { // NOSONAR [S3504] -- GJS importer export
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

var PanelSettings = class PanelSettings { // NOSONAR [S3504] -- GJS importer export
    constructor(settings) {
        this._settings = settings;
    }

    // the panel label reads these straight off the applet, so they are bound
    // as applet properties rather than read through accessors
    // No target: these call settings.bind(), which binds onto the applet that
    // owns the settings object, not bindWithObject. The parameter was passed by
    // every caller and read by neither. (CalendarSettings.bindShowWeekNumbers
    // genuinely does take one — it uses bindWithObject.)
    bindPanelKeys(handlers) {
        for (let [key, property, handler] of PANEL_KEYS) {
            this._settings.bind(key, property, handlers[handler]);
        }
    }

    // Cinnamon preserves stored values when a schema default changes. Migrate
    // only the exact formats the applet used to ship, once; every other value is
    // a user choice and must survive the upgrade.
    migrateDateFormatDefaults() {
        if (this._settings.getValue(DATE_FORMAT_DEFAULTS_MIGRATED_KEY)) {
            return;
        }

        for (const key of [CUSTOM_FORMAT_KEY, CUSTOM_TOOLTIP_FORMAT_KEY]) {
            if (this._settings.getValue(key) === LEGACY_DATE_TIME_FORMAT) {
                this._settings.setValue(key, DEFAULT_DATE_TIME_FORMAT);
            }
        }

        this._settings.setValue(DATE_FORMAT_DEFAULTS_MIGRATED_KEY, true);
    }

    bindWeatherKeys(target, requestCallback, presentationCallback) {
        for (let [key, property] of WEATHER_KEYS) {
            this._settings.bind(key, property, requestCallback);
        }

        for (const [key, property, kind] of MIRRORED_WEATHER_KEYS) {
            mirrorSetting(this._settings, target, key, property,
                kind === "presentation" ? presentationCallback : requestCallback);
        }
    }

    // An empty weather location is the one setting the applet can answer for
    // itself: the machine's timezone already names a city. It is written into
    // the settings key, not just used, so the user opens the dialog and reads
    // the place the weather is being fetched for — and can correct it, because
    // the timezone names its region's reference city and not their town.
    //
    // Only when it is empty: a location the user chose is never overwritten. The
    // settings dialog does the same on open, for the same reason; whichever runs
    // first fills it, and the other one finds it filled.
    fillEmptyWeatherLocation(target, city) {
        if (!city || this._settings.getValue(WEATHER_LOCATION_KEY)) {
            return "";
        }

        this._settings.setValue(WEATHER_LOCATION_KEY, city);
        target.weather_location = city;
        return city;
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
        DESKTOP_REPORTED_KEYS,
        CLOCK_USE_24H_KEY,
        CLOCK_SHOW_SECONDS_KEY,
        FIRST_DAY_OF_WEEK_KEY,
        TEXT_SCALING_FACTOR_KEY,
        DEFAULT_TEXT_SCALE,
        SHOW_EVENTS_KEY,
        SHOW_WEEK_NUMBERS_KEY,
        WEEKEND_LENGTH_KEY,
        WEEKEND_LENGTH_VALUES,
        DEFAULT_WEEKEND_LENGTH,
        COUNTRY_KEY,
        REGION_KEY_PREFIX,
        SHOW_RELIGIOUS_OBSERVANCES_KEY,
        RELIGION_KEY_PREFIX,
        RELIGION_IDS,
        WORLDCLOCKS_KEY,
        SHOW_WORLDCLOCKS_KEY,
        SHOW_ASTRONOMY_KEY,
        KEY_OPEN_KEY,
        WEATHER_LOCATION_KEY,
        CUSTOM_FORMAT_KEY,
        CUSTOM_TOOLTIP_FORMAT_KEY,
        PANEL_FONT_SCALE_KEY,
        DEFAULT_DATE_TIME_FORMAT,
        NO_HOLIDAYS,
        PANEL_KEYS,
        WEATHER_KEYS,
        MIRRORED_WEATHER_KEYS
    };
}
