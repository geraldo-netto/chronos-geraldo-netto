const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { makeRandom } = require("./prng");

const APPLET_DIR = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto");

if (!String.prototype.capitalize) {
    Object.defineProperty(String.prototype, "capitalize", { // NOSONAR [S6643] -- deliberate test seam
        value: function() {
            return this.charAt(0).toUpperCase() + this.slice(1);
        }
    });
}

if (!String.prototype.format) {
    Object.defineProperty(String.prototype, "format", { // NOSONAR [S6643] -- deliberate test seam
        value: function(...args) {
            let i = 0;
            return this.replace(/%[ds]/g, () => String(args[i++]));
        }
    });
}

// GLib.DateTime is a value type the applet does real arithmetic on, not an
// opaque handle: the seam between the grid's JS `Date` and the event column's
// GLib date runs through get_year/get_month/get_day_of_month on the way in and
// to_unix/format on the way out. A stub answering `{}` accepted a JS `Date`
// where a GLib one was required and let it reach set_date unnoticed.
class FixtureDateTime {
    constructor(date) {
        this.date = date;
    }

    to_unix() {
        return Math.floor(this.date.getTime() / 1000);
    }

    get_year() {
        return this.date.getFullYear();
    }

    get_month() {
        return this.date.getMonth() + 1;
    }

    get_day_of_month() {
        return this.date.getDate();
    }

    get_hour() {
        return this.date.getHours();
    }

    format(fmt) {
        const day = `${this.get_year()}-${String(this.get_month()).padStart(2, "0")}` +
            `-${String(this.get_day_of_month()).padStart(2, "0")}`;
        return `${fmt}|${day}`;
    }
}

global.log = () => {};
global.logError = () => {};
global.imports = {
    gi: {
        Atk: { Role: { PUSH_BUTTON: 3, LIST: 1, LIST_ITEM: 2 } },
        Clutter: { ActorAlign: { CENTER: 0, START: 1, END: 2 }, BUTTON_PRIMARY: 1, EVENT_STOP: true,
            EVENT_PROPAGATE: false, KEY_Return: 65293, KEY_KP_Enter: 65421, KEY_space: 32 },
        Gio: { Settings: class { connect() { return 1; } } },
        GLib: {
            // g_get_language_names() is documented always to include the
            // default locale, so the list is never empty. A stub that left it
            // out sent hostMessageLocale down a fallback Cinnamon cannot reach.
            get_language_names: () => ["C"],
            get_home_dir: () => "/home/x",
            get_user_cache_dir: () => "/tmp/cache", // NOSONAR [S5443] -- in-memory test path
            build_filenamev: (parts) => parts.join("/"),
            find_program_in_path: () => null,
            timeout_add_seconds: () => 1,
            timeout_add: () => 1,
            source_remove: () => {},
            PRIORITY_DEFAULT: 0,
            SOURCE_REMOVE: false,
            SOURCE_CONTINUE: true,
            TIME_SPAN_MINUTE: 60000000,
            TIME_SPAN_DAY: 86400000000,
            get_monotonic_time: () => 1,
            DateTime: {
                new_from_unix_local: (unix) => new FixtureDateTime(new Date(unix * 1000)),
                new_local: (year, month, day, hour, minute, second) =>
                    new FixtureDateTime(
                        new Date(year, month - 1, day, hour, minute, second)),
                new_now_local: () => new FixtureDateTime(new Date()),
                new_now_utc: () => ({ to_timezone: () => ({ format: (f) => f }) })
            },
            // new_local is what the "local" identifier resolves through, and it
            // is as real as the other two: leaving it out let a stub pass where
            // GLib would have answered
            TimeZone: {
                new_identifier: (tz) => ({ get_identifier: () => tz }),
                new_local: () => ({ get_identifier: () => "Europe/Berlin" })
            },
            file_read_link: (filename) => {
                const links = {
                    "/usr/share/zoneinfo/US/Eastern": "../America/New_York",
                    "/usr/share/zoneinfo/Canada/Eastern": "../America/Toronto",
                    "/usr/share/zoneinfo/Brazil/East": "../America/Sao_Paulo"
                };
                if (Object.hasOwn(links, filename)) {
                    return links[filename];
                }
                throw new Error("regular zoneinfo file");
            }
        },
        Pango: { EllipsizeMode: { NONE: 0, END: 3 } },
        St: {
            Align: { START: 0, END: 1 },
            Side: { LEFT: 0, RIGHT: 1, TOP: 2, BOTTOM: 3 },
            BoxLayout: class {
                constructor() {} // NOSONAR [S6647] -- deliberate test seam
                connect() {} // NOSONAR [S1186] -- deliberate test seam
                add_actor() {} // NOSONAR [S1186] -- deliberate test seam
            },
            Label: class {
                constructor(options = {}) {
                    this.text = options.text || "";
                    this.visible = options.visible !== false;
                    this.clutterText = {};
                }
                add_actor() {} // NOSONAR [S1186] -- deliberate test seam
                get_clutter_text() { return this.clutterText; }
                set_text(text) { this.text = text; }
                set_accessible_name(name) { this.accessible_name = name; }
            },
            Widget: class {
                constructor(opts = {}) {
                    this.opts = opts;
                }
                destroy_all_children() {} // NOSONAR [S1186] -- deliberate test seam
                show() {} // NOSONAR [S1186] -- deliberate test seam
                hide() {} // NOSONAR [S1186] -- deliberate test seam
            },
            Bin: class {} // NOSONAR [S2094] -- deliberate test seam
        },
        Cinnamon: {},
        CinnamonDesktop: {
            WallClock: Object.assign(class {
                get_clock() {
                    return "clock";
                }
                get_clock_for_format(fmt) {
                    return fmt;
                }
                connect() {
                    return 1;
                }
            }, { lctime_format: (d, f) => f })
        },
        Soup: { MAJOR_VERSION: 3, Session: class {} } // NOSONAR [S2094] -- deliberate test seam
    },
    byteArray: {},
    mainloop: { timeout_add: () => 1, idle_add: () => 1, source_remove: () => {},
        timeout_add_seconds: () => 1 },
    signals: {
        addSignalMethods(proto) {
            proto.connect = function() { return 1; };
            proto.emit = function() {};
        }
    },
    gettext: {
        bindtextdomain: () => {},
        dgettext: (d, s) => s,
        dngettext: (d, s, p, n) => (n === 1 ? s : p),
        domain: () => ({ gettext: (s) => s })
    },
    ui: {
        applet: {
            TextApplet: class {
                constructor() {} // NOSONAR [S6647] -- deliberate test seam
                set_applet_label() {} // NOSONAR [S1186] -- deliberate test seam
                set_applet_tooltip() {} // NOSONAR [S1186] -- deliberate test seam
                setAllowedLayout() {} // NOSONAR [S1186] -- deliberate test seam
            },
            AllowedLayout: { BOTH: 2 },
            MenuItem: class {} // NOSONAR [S2094] -- deliberate test seam
        },
        popupMenu: {
            PopupMenuManager: class {}, // NOSONAR [S2094] -- deliberate test seam
            PopupMenuItem: class {
                connect() {} // NOSONAR [S1186] -- deliberate test seam
                addActor() {} // NOSONAR [S1186] -- deliberate test seam
            },
            PopupSeparatorMenuItem: class {}, // NOSONAR [S2094] -- deliberate test seam
            // Cinnamon's PopupMenuSection is a PopupMenuBase whose actor *is* its
            // box, and addActor() puts a plain actor inside it — that is the seam
            // the calendar body hangs from
            PopupMenuSection: class {
                constructor() { this.actor = {}; this.children = []; }
                addActor(actor) { this.children.push(actor); }
            }
        },
        main: { keybindingManager: {
            addHotKey() {},
            removeHotKey() {},
            addXletHotKey() {},
            removeXletHotKey() {}
        } },
        settings: { AppletSettings: class { bind() {} connect() {} getValue() { return []; } } }, // NOSONAR [S1186] -- deliberate test seam
        separator: {},
        tooltips: { Tooltip: class { constructor(actor, text) { this.actor = actor; this.text = text; } set_text(text) { this.text = text; } } },
        appletManager: { applets: { "chronos@geraldo-netto": {} } }
    },
    misc: { util: { spawnCommandLine: () => {} } }
};

const rootModules = global.imports.ui.appletManager.applets["chronos@geraldo-netto"];
rootModules.dateFormats = require(path.join(APPLET_DIR, "dateFormats.js"));
rootModules.ioUtils = require(path.join(APPLET_DIR, "ioUtils.js"));
rootModules.localeQuery = require(path.join(APPLET_DIR, "localeQuery.js"));
rootModules.localeText = require(path.join(APPLET_DIR, "localeText.js"));
rootModules.providerUtils = require(path.join(APPLET_DIR, "providerUtils.js"));
rootModules.styleUtils = require(path.join(APPLET_DIR, "styleUtils.js"));
rootModules.textUtils = require(path.join(APPLET_DIR, "textUtils.js"));
rootModules.eventData = require(path.join(APPLET_DIR, "eventData.js"));
rootModules.eventFormat = require(path.join(APPLET_DIR, "eventFormat.js"));
rootModules.calendarServerConnection = require(path.join(APPLET_DIR, "calendarServerConnection.js"));
rootModules.eventIndex = require(path.join(APPLET_DIR, "eventIndex.js"));
rootModules.eventWindow = require(path.join(APPLET_DIR, "eventWindow.js"));
rootModules.eventsManager = require(path.join(APPLET_DIR, "eventsManager.js"));
rootModules.weather = require(path.join(APPLET_DIR, "weather.js"));
rootModules.weatherFormat = require(path.join(APPLET_DIR, "weatherFormat.js"));
rootModules.weatherServiceAdapters = require(path.join(APPLET_DIR, "weatherServiceAdapters.js"));
rootModules.cityWeather = require(path.join(APPLET_DIR, "cityWeather.js"));
rootModules.holidays = require(path.join(APPLET_DIR, "holidays.js"));
rootModules.holidayConstants = require(path.join(APPLET_DIR, "holidayConstants.js"));
rootModules.holidayRecord = require(path.join(APPLET_DIR, "holidayRecord.js"));
rootModules.worldclockData = require(path.join(APPLET_DIR, "worldclockData.js"));
rootModules.astronomy = require(path.join(APPLET_DIR, "astronomy.js"));
rootModules.worldclocks = require(path.join(APPLET_DIR, "6.0", "worldclocks.js"));
rootModules.settingsFacade = require(path.join(APPLET_DIR, "settingsFacade.js"));

const AppletModule = require(path.join(APPLET_DIR, "6.0", "applet.js"));
const CoordinatorModule = require(path.join(APPLET_DIR, "6.0", "appletCoordinators.js"));
const PanelStatusModule = require(path.join(APPLET_DIR, "6.0", "appletPanelStatus.js"));
const MAX_SUFFIX = PanelStatusModule.LABEL_SUFFIX_MAX_LENGTH;
const ELLIPSIS = PanelStatusModule.LABEL_ELLIPSIS;
const Proto = AppletModule.CinnamonCalendarApplet.prototype;
const DateFormats = rootModules.dateFormats;
const Weather = rootModules.weather;
const St = global.imports.gi.St;

// Seeded PRNG so a fuzz failure reproduces; change FUZZ_SEED to explore
const FUZZ_SEED = 20260712;

function clockStub(overrides = {}) {
    return Object.assign({ // NOSONAR [S6661] -- deliberate test seam
        get_clock: () => "10:00",
        get_clock_for_format: (fmt) => "v:" + fmt
    }, overrides);
}

function readingFrom(text) {
    const chars = Array.from(text);
    return { condition: chars[0], temperatureC: parseFloat(chars.slice(1).join("")) }; // NOSONAR [S7773] -- deliberate test seam
}

function weatherCoordinator(overrides = {}) {
    return Object.assign({ // NOSONAR [S6661] -- deliberate test seam
        reading: null,
        pending: false,
        error: "",
        providerName: "",
        schedule() {},
        queue() {},
        scheduleCities() {},
        cityReading: () => null,
        cityStale: () => false,
        cityError: () => "",
        cityProviderName: () => "",
        setStatus(reading = null, error = "", providerName = "", pending = false) {
            this.reading = reading || null;
            this.pending = pending;
            this.error = error;
            this.providerName = providerName || "";
        }
    }, overrides);
}

function legacyCityReading(applet, city) {
    return applet.cityWeatherReading ? applet.cityWeatherReading(city) : null;
}

function legacyCityStale(applet, city) {
    return Boolean(applet.cityWeatherStale && // NOSONAR [S6582] -- deliberate test seam
        applet.cityWeatherStale(city));
}

function legacyCityProviderName(applet, city) {
    return applet.cityWeatherProviderName ? applet.cityWeatherProviderName(city) : "";
}

function legacyWeatherCoordinator(applet) {
    return weatherCoordinator({
        reading: applet.weatherReading || null,
        pending: Boolean(applet.weatherPending),
        error: applet.weatherError || "",
        providerName: applet.weatherProvider || "",
        cityReading: (city) => legacyCityReading(applet, city),
        cityStale: (city) => legacyCityStale(applet, city),
        cityProviderName: (city) => legacyCityProviderName(applet, city)
    });
}

function panelStatus(applet) {
    if (!applet._weatherCoordinator) {
        applet._weatherCoordinator = legacyWeatherCoordinator(applet);
    }
    return new AppletModule.AppletPanelStatusPresenter(
        new PanelStatusModule.PanelView(AppletModule.createPanelPort(applet)));
}

function suffixStub(overrides = {}) {
    const {
        weatherReading = null,
        weatherPending = false,
        weatherError = "",
        weatherProvider = "",
        ...appletOverrides
    } = overrides;
    return Object.assign({ // NOSONAR [S6661] -- deliberate test seam
        show_weather: true,
        weather_units: "si",
        _weatherCoordinator: weatherCoordinator({
            reading: weatherReading,
            pending: weatherPending,
            error: weatherError,
            providerName: weatherProvider
        }),
        worldclocks: []
    }, appletOverrides);
}

function updateStub({ menuOpen = false } = {}) {
    const calls = { label: [], tooltip: [], weatherStatus: [], selected: 0,
        rowRefreshes: 0,
        worldTicks: 0, dayText: [], clockEntries: 0, lastEntries: null };
    const clockEntries = [
        { label: "UTC", timezone: "UTC", time: "UTC:%H:%M", builtin: true },
        { label: "NY", timezone: "America/New_York", time: "04:00", builtin: false },
        { label: "Tokyo", timezone: "Asia/Tokyo", time: "18:00", builtin: false },
        { label: "Sydney", timezone: "Australia/Sydney", time: "20:00", builtin: false }
    ];
    const stub = Object.assign(Object.create(Proto), {
        clock: clockStub(),
        custom_tooltip_format: "%d %b %H:%M",
        _todayFormatCache: null,
        show_weather: false,
        weather_units: "si",
        _weatherCoordinator: weatherCoordinator(),
        worldclocks: [{ label: "NY", timezone: "America/New_York" }],
        menu: { isOpen: menuOpen },
        _worldclocks: {
            setVisible: () => {},
            getClockEntries: () => {
                calls.clockEntries++;
                return clockEntries;
            },
            updateClocks: (entries) => {
                calls.worldTicks++;
                calls.lastEntries = entries;
            },
            setWeatherSource: (source) => {
                calls.weatherSource = source;
            }
        },
        _calendar: { todaySelected: () => true, getSelectedDate: () => new Date() },
        go_home_button: { reactive: true, set_style_class_name: () => {} },
        _day: { set_text: (text) => calls.dayText.push(text) },
        _date: { set_text: () => {} },
        _issueReporter: {
            issues: new Map(),
            set(source, text) {
                calls.weatherStatus.push(text);
                if (text) {
                    this.issues.set(source, text);
                } else {
                    this.issues.delete(source);
                }
            }
        },
        events_manager: { select_date: () => calls.selected++ },
        event_list: { refresh_time_state: () => calls.rowRefreshes++ },
        set_applet_label: (text) => calls.label.push(text),
        set_applet_tooltip: (text) => calls.tooltip.push(text)
    });
    return { stub, calls };
}

function tooltipEntry(label, timezone, stamp, builtin) {
    return {
        label,
        timezone,
        builtin,
        time: stamp,
        localTime: { format: () => stamp }
    };
}

module.exports = {
    assert, test, fs, path, makeRandom, APPLET_DIR, rootModules,
    AppletModule, CoordinatorModule, PanelStatusModule, MAX_SUFFIX, ELLIPSIS, Proto, panelStatus,
    DateFormats, Weather, St, FUZZ_SEED, FixtureDateTime,
    clockStub, readingFrom, weatherCoordinator, suffixStub, updateStub, tooltipEntry
};

// show_worldclocks used to do exactly one thing: hide the popup grid. Every
// other consumer ignored it, so a switched-off feature still cost a
// GLib.DateTime per clock per second and 16 HTTP round-trips an hour.
