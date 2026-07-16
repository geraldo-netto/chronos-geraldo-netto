const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");

const APPLET_DIR = path.join(__dirname, "..", "files", "chronos@geraldo-netto");

if (!String.prototype.capitalize) {
    Object.defineProperty(String.prototype, "capitalize", {
        value: function() {
            return this.charAt(0).toUpperCase() + this.slice(1);
        }
    });
}

if (!String.prototype.format) {
    Object.defineProperty(String.prototype, "format", {
        value: function(...args) {
            let i = 0;
            return this.replace(/%[ds]/g, () => String(args[i++]));
        }
    });
}

global.log = () => {};
global.logError = () => {};
global.imports = {
    gi: {
        Atk: { Role: { PUSH_BUTTON: 3, LIST: 1, LIST_ITEM: 2 } },
        Clutter: { ActorAlign: { CENTER: 0 }, BUTTON_PRIMARY: 1, EVENT_STOP: true,
            EVENT_PROPAGATE: false, KEY_Return: 65293, KEY_KP_Enter: 65421, KEY_space: 32 },
        Gio: { Settings: class { connect() { return 1; } } },
        GLib: {
            get_home_dir: () => "/home/x",
            get_user_cache_dir: () => "/tmp/cache",
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
                new_from_unix_local: () => ({}),
                new_local: () => ({}),
                new_now_local: () => ({}),
                new_now_utc: () => ({ to_timezone: () => ({ format: (f) => f }) })
            },
            // new_local is what the "local" identifier resolves through, and it
            // is as real as the other two: leaving it out let a stub pass where
            // GLib would have answered
            TimeZone: {
                new_identifier: (tz) => ({ get_identifier: () => tz }),
                new_local: () => ({ get_identifier: () => "Europe/Berlin" })
            }
        },
        St: {
            Side: { LEFT: 0, RIGHT: 1, TOP: 2, BOTTOM: 3 },
            BoxLayout: class {
                constructor() {}
                connect() {}
                add_actor() {}
            },
            Label: class {
                constructor() {}
                add_actor() {}
            },
            Widget: class {
                constructor(opts = {}) {
                    this.opts = opts;
                }
                destroy_all_children() {}
                show() {}
                hide() {}
            },
            Bin: class {}
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
        Soup: { MAJOR_VERSION: 3, Session: class {} }
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
                constructor() {}
                set_applet_label() {}
                set_applet_tooltip() {}
                setAllowedLayout() {}
            },
            AllowedLayout: { BOTH: 2 },
            MenuItem: class {}
        },
        popupMenu: {
            PopupMenuManager: class {},
            PopupMenuItem: class { connect() {} },
            PopupSeparatorMenuItem: class {},
            // Cinnamon's PopupMenuSection is a PopupMenuBase whose actor *is* its
            // box, and addActor() puts a plain actor inside it — that is the seam
            // the calendar body hangs from
            PopupMenuSection: class {
                constructor() { this.actor = {}; this.children = []; }
                addActor(actor) { this.children.push(actor); }
            }
        },
        main: { keybindingManager: { addHotKey() {}, removeHotKey() {} } },
        settings: { AppletSettings: class { bind() {} connect() {} getValue() { return []; } } },
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
rootModules.eventsManager = require(path.join(APPLET_DIR, "eventsManager.js"));
rootModules.weather = require(path.join(APPLET_DIR, "weather.js"));
rootModules.weatherFormat = require(path.join(APPLET_DIR, "weatherFormat.js"));
rootModules.weatherServiceAdapters = require(path.join(APPLET_DIR, "weatherServiceAdapters.js"));
rootModules.cityWeather = require(path.join(APPLET_DIR, "cityWeather.js"));
rootModules.holidays = require(path.join(APPLET_DIR, "holidays.js"));
rootModules.holidayConstants = require(path.join(APPLET_DIR, "holidayConstants.js"));
rootModules.worldclockData = require(path.join(APPLET_DIR, "worldclockData.js"));
rootModules.worldclocks = require(path.join(APPLET_DIR, "5.4", "worldclocks.js"));
rootModules.settingsFacade = require(path.join(APPLET_DIR, "settingsFacade.js"));

const AppletModule = require(path.join(APPLET_DIR, "5.4", "applet.js"));
const PanelStatusModule = require(path.join(APPLET_DIR, "5.4", "appletPanelStatus.js"));
const MAX_SUFFIX = PanelStatusModule.LABEL_SUFFIX_MAX_LENGTH;
const ELLIPSIS = PanelStatusModule.LABEL_ELLIPSIS;
const Proto = AppletModule.CinnamonCalendarApplet.prototype;
const panelStatus = (applet) => new AppletModule.AppletPanelStatusPresenter(applet);
const DateFormats = rootModules.dateFormats;
const Weather = rootModules.weather;
const St = global.imports.gi.St;

// Seeded PRNG so a fuzz failure reproduces; change FUZZ_SEED to explore
const FUZZ_SEED = 20260712;

function clockStub(overrides = {}) {
    return Object.assign({
        get_clock: () => "10:00",
        get_clock_for_format: (fmt) => "v:" + fmt
    }, overrides);
}

// show_worldclocks used to do exactly one thing: hide the popup grid. Every
// other consumer ignored it, so a switched-off feature still cost a
// GLib.DateTime per clock per second and 16 HTTP round-trips an hour.
test("switching world clocks off stops the work they cost", () => {
    const { stub, calls } = updateStub({ menuOpen: true });
    Object.assign(stub, {
        show_worldclocks: false,
        panel_clocks: 2,
        worldclocks: [{ label: "Tokyo", timezone: "Asia/Tokyo" }],
        _calendar: { todaySelected: () => false, getSelectedDate: () => new Date() }
    });

    Proto._updateClockAndDate.call(stub);

    assert.equal(calls.clockEntries, 0, "no clock is formatted when none are shown");
    assert.ok(!calls.label.at(-1).includes("Tokyo"), "and none reach the panel label");
    assert.ok(!calls.tooltip.at(-1).includes("Tokyo"), "or the tooltip");
});

test("city weather is not fetched for world clocks that are switched off", () => {
    const scheduled = [];
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        show_worldclocks: false,
        weather_units: "si",
        worldclocks: [{ label: "Tokyo", timezone: "Asia/Tokyo" }],
        _cityWeatherProvider: { schedule: (settings) => scheduled.push(settings) },
        _updateClockAndDate: () => {}
    });

    Proto._scheduleCityWeatherRefresh.call(stub);

    assert.deepEqual(scheduled[0].cities, [],
        "8 cities × a forecast every 30 minutes, for a feature that is off");
});

// The guard above is only reached if something calls the scheduler when the
// setting changes, and nothing did: _onSettingsChanged updated the format, the
// clock and the event list and never the city weather. So turning the clocks
// OFF did not stop anything — the armed timer closed over the old settings and
// went on geocoding and forecasting eight cities every half hour for the rest of
// the session, after the user had opted out. Calling the scheduler directly, as
// the test above does, is exactly what hid it.
test("turning world clocks off stops the city weather that was fetched for them", () => {
    const scheduled = [];
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        show_worldclocks: true,
        weather_units: "si",
        worldclocks: [{ label: "Tokyo", timezone: "Asia/Tokyo" }],
        show_events: false,
        _applied_show_events: false,
        orientation: St.Side.TOP,
        custom_format: "",
        desktop_settings: { use24h: true, showSeconds: false },
        _cityWeatherProvider: { schedule: (settings) => scheduled.push(settings) },
        _updateFormatString: () => {},
        _updateClockAndDate: () => {},
        _updateEventListState: () => {},
        events_manager: { select_date() {} },
        _calendar: { getSelectedDate: () => new Date() }
    });

    Proto._onSettingsChanged.call(stub);
    assert.equal(scheduled.length, 1, "the first pass arms the round");
    assert.deepEqual(scheduled[0].cities.map((city) => city.query), ["Tokyo"]);

    // the user switches the clocks off
    stub.show_worldclocks = false;
    Proto._onSettingsChanged.call(stub);

    assert.equal(scheduled.length, 2, "the change reaches the city-weather scheduler");
    assert.deepEqual(scheduled[1].cities, [],
        "and nothing is fetched for a feature the user turned off");

    // ...and an unrelated settings change costs no further round
    Proto._onSettingsChanged.call(stub);
    assert.equal(scheduled.length, 2);
});

// The per-city temperature, the condition in words and the service that answered
// existed only in the panel's mouse tooltip: a keyboard-only or screen-reader
// user got none of it, and the provider credit is a courtesy the services are
// owed.
test("the popup clock rows carry the weather, not just the tooltip", () => {
    const { stub, calls } = updateStub({ menuOpen: true });
    Object.assign(stub, {
        show_weather: true,
        show_worldclocks: true,
        worldclocks: [{ label: "Tokyo", timezone: "Asia/Tokyo" }],
        _weather_reading: { condition: "\u2600", temperatureC: 20 },
        _weather_provider: "Open-Meteo",
        cityWeatherReading: (city) => (city === "Tokyo" ? { condition: "\ud83c\udf27", temperatureC: 12 } : null),
        cityWeatherStale: () => false,
        cityWeatherProviderName: () => "Open-Meteo",
        _calendar: { todaySelected: () => false, getSelectedDate: () => new Date() }
    });

    Proto._updateClockAndDate.call(stub);

    const tokyo = calls.lastEntries.find((entry) => entry.label === "Tokyo");
    assert.ok(tokyo.weather.includes("12\u00b0C"), "the row carries the city's own reading");
    assert.ok(tokyo.weather.includes("Rain"), "and the condition in words, not an emoji");

    assert.ok(calls.weatherSource.includes("Open-Meteo"),
        "and the service that answered is named where the popup can say it");
});

test("disabling the home button hands its key focus to the calendar", () => {
    const focused = [];
    const button = { reactive: true, can_focus: true, set_style_class_name: () => {} };
    const applet = {
        go_home_button: button,
        _calendar: { focusSelectedDay: () => focused.push("day") }
    };
    const view = new PanelStatusModule.PanelView(applet);
    const originalStage = global.stage;
    global.stage = { get_key_focus: () => button };

    // pressing Enter on "Go to today" selects today, which disables the button
    // under the user's own hands: St drops the stage focus when the focused
    // actor stops being focusable, and Cinnamon closes a menu whose focus left
    view.setHomeEnabled(false);
    global.stage = originalStage;

    assert.deepEqual(focused, ["day"], "focus must move before the button loses can_focus");
    assert.equal(button.can_focus, false);
});

test("the home button leaves an unfocused calendar alone", () => {
    const focused = [];
    const button = { reactive: true, can_focus: true, set_style_class_name: () => {} };
    const applet = {
        go_home_button: button,
        _calendar: { focusSelectedDay: () => focused.push("day") }
    };
    const view = new PanelStatusModule.PanelView(applet);
    const originalStage = global.stage;
    global.stage = { get_key_focus: () => ({}) };

    view.setHomeEnabled(false);
    view.setHomeEnabled(true);
    global.stage = originalStage;

    assert.deepEqual(focused, [], "the focus is somewhere else; do not steal it");
    assert.equal(button.can_focus, true);
});

// T27a/T27b: day-of-year cache
test("getFormattedToday caches by day and invalidates at rollover", () => {
    let formats = 0;
    const stub = {
        clock: clockStub({ get_clock_for_format: (fmt) => (formats++, "v:" + fmt) })
    };
    const presenter = new AppletModule.AppletPanelStatusPresenter(stub);

    const first = presenter.getFormattedToday();
    assert.equal(formats, 3, "three formats computed once");
    assert.equal(first.full, ("v:" + DateFormats.DATE_FORMAT_FULL).capitalize());

    const second = presenter.getFormattedToday();
    assert.equal(second, first, "same day: cache hit");
    assert.equal(formats, 3);

    // midnight rollover: stale key forces recompute
    presenter._todayFormatCache = { ...first, key: "1999:1" };
    const third = presenter.getFormattedToday();
    assert.notEqual(third.key, "1999:1");
    assert.equal(formats, 6, "recomputed after day change");
});

// T27d: suffix building and ellipsizing
// a reading record {condition, temperatureC} from a display string like "☀ 20°C"
function readingFrom(text) {
    const chars = Array.from(text);
    return { condition: chars[0], temperatureC: parseFloat(chars.slice(1).join("")) };
}

function suffixStub(overrides = {}) {
    return Object.assign({
        orientation: St.Side.TOP,
        show_weather: true,
        weather_units: "si",
        _weather_reading: null,
        _weather_error: "",
        worldclocks: []
    }, overrides);
}

test("buildLabelSuffix is the temperature on every panel orientation", () => {
    // the panel shows the temperature; the sky glyph is in the tooltip and in
    // the accessible name, both of which say it in words anyway
    for (const orientation of [St.Side.TOP, St.Side.BOTTOM, St.Side.LEFT, St.Side.RIGHT]) {
        assert.equal(panelStatus(suffixStub({
            orientation,
            _weather_reading: readingFrom("☀ 20°C")
        })).buildLabelSuffix(), "20°C");
    }

    // world clocks never reach the panel, however many are configured: they are
    // a table, and the panel is one line the date and the weather already share
    const withClocks = suffixStub({
        _weather_reading: readingFrom("☀ 20°C"),
        worldclocks: [{ label: "NY" }, { label: "Tokyo" }]
    });
    assert.equal(panelStatus(withClocks).buildLabelSuffix(), "20°C");

    const stale = suffixStub({ _weather_reading: readingFrom("☀ 20°C"), _weather_error: "boom" });
    assert.equal(panelStatus(stale).buildLabelSuffix(), "⚠ 20°C");
    // an error with no reading yet is the marker alone
    assert.equal(panelStatus(suffixStub({ _weather_error: "boom" })).buildLabelSuffix(), "⚠");
});

test("ellipsizeLabelSuffix truncates long suffixes on a word-safe boundary", () => {
    const short = "short";
    assert.equal(panelStatus({}).ellipsizeLabelSuffix(short), short);

    const long = "x".repeat(MAX_SUFFIX * 2);
    const result = panelStatus({}).ellipsizeLabelSuffix(long);
    assert.ok(result.length < long.length);
    assert.ok(result.endsWith(ELLIPSIS));
});

// T74 regression: the cut must never split an astral glyph in half
test("ellipsizeLabelSuffix never splits surrogate pairs", () => {
    // places the rain glyph exactly across the old UTF-16 cut position
    const straddling = "x".repeat(MAX_SUFFIX - 4) + "🌧" + "y".repeat(20);
    const result = panelStatus({}).ellipsizeLabelSuffix(straddling);
    assert.ok(result.isWellFormed(), "no lone surrogates in the label");
    assert.ok(result.endsWith(ELLIPSIS));

    // an emoji-heavy suffix stays well-formed at any cut
    const stormy = "⛈🌧🌨🌦".repeat(30);
    const cut = panelStatus({}).ellipsizeLabelSuffix(stormy);
    assert.ok(cut.isWellFormed());
    assert.ok(Array.from(cut).length <= MAX_SUFFIX);
});

// T27c: menu-state gating in _updateClockAndDate
function updateStub({ menuOpen = false } = {}) {
    const calls = { label: [], tooltip: [], weatherStatus: [], selected: 0,
        worldTicks: 0, dayText: [], clockEntries: 0, lastEntries: null };
    // the entries carry their timezone, as the real ones do: the city weather is
    // keyed on the city the timezone names, not on the label — two clocks may
    // share a label, and the user's name for a row is not a place
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
        _weather_reading: null,
        _weather_error: "",
        _weather_provider: "",
        worldclocks: [{ label: "NY", timezone: "America/New_York" }],
        panel_clocks: 1,
        orientation: St.Side.TOP,
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
        _day: { set_text: (t) => calls.dayText.push(t) },
        _date: { set_text: () => {} },
        _weather_status: {
            visible: false,
            set_text: (text) => calls.weatherStatus.push(text)
        },
        events_manager: { select_date: () => calls.selected++ },
        set_applet_label: (t) => calls.label.push(t),
        set_applet_tooltip: (t) => calls.tooltip.push(t)
    });
    return { stub, calls };
}

// The weather suffix was capped and the rest of the label was not — and the rest
// is the user's own custom format. "%A, %-d %B %Y — %H:%M:%S %Z" is about 40
// characters before the weather is added; on a 1366px panel that is two-fifths of
// the width, and it pushes the window list off the panel with nothing to say the
// applet did it.
test("a long custom format cannot push the panel's other applets off it", () => {
    const MAX = PanelStatusModule.LABEL_MAX_LENGTH;
    const { stub, calls } = updateStub();
    Object.assign(stub, {
        show_weather: false,
        custom_format: "ignored — the clock double answers with the string below",
        // the label is whatever WallClock renders the user's format into
        clock: Object.assign(clockStub(), {
            get_clock: () => "Wednesday, 15 October 2025 — 14:52:07 Central European Summer Time"
        }),
        actor: { names: [], set_accessible_name(name) { this.names.push(name); } }
    });

    Proto._updateClockAndDate.call(stub);

    const label = calls.label.at(-1);
    assert.equal(Array.from(label).length, MAX, "the label is bounded");
    assert.ok(label.endsWith(ELLIPSIS), "and it says it was cut");

    // the screen reader still hears the whole thing: the cap is about the width of
    // a shared panel, and a name has no width
    assert.ok(stub.actor.names.at(-1).startsWith("Wednesday, 15 October 2025"));
    assert.ok(stub.actor.names.at(-1).length > MAX);
});

test("the panel readout is announced with its condition", () => {
    const { stub } = updateStub({ menuOpen: false });
    stub.actor = { names: [], set_accessible_name(name) { this.names.push(name); } };
    stub.show_weather = true;
    stub._weather_error = "";
    stub._weather_reading = { condition: "🌧", temperatureC: 8 };

    Proto._updateClockAndDate.call(stub);

    assert.match(stub.actor.names.at(-1), /Rain/,
        "the emoji reads as a codepoint name or nothing; the word does not");
});

test("a weather failure on the panel is announced in words", () => {
    const { stub, calls } = updateStub({ menuOpen: false });
    void calls;
    stub.actor = { names: [], set_accessible_name(name) { this.names.push(name); } };
    stub.show_weather = true;
    stub._weather_error = "Weather service unavailable";
    stub._weather_reading = null;

    Proto._updateClockAndDate.call(stub);

    // the panel label carries only the warning glyph; the name carries the words
    assert.match(stub.actor.names.at(-1), /Weather service unavailable/);

    stub._weather_error = "";
    Proto._updateClockAndDate.call(stub);
    assert.doesNotMatch(stub.actor.names.at(-1), /unavailable/);
});

test("_updateClockAndDate with the menu closed only updates the label", () => {
    const { stub, calls } = updateStub({ menuOpen: false });
    Proto._updateClockAndDate.call(stub);
    assert.equal(calls.label.length, 1);
    assert.equal(calls.tooltip.length, 0, "tooltip untouched while not hovered");
    assert.equal(calls.selected, 0, "no event-selection churn while closed");
    assert.equal(calls.worldTicks, 0, "hidden clocks not updated");
    // nothing on a closed panel shows a clock, so a closed tick converts no
    // timezone: that was a GLib.DateTime per configured city, every second
    assert.equal(calls.clockEntries, 0, "a closed panel formats no world clocks");
    assert.equal(calls.dayText.length, 0);

    stub._panel_hovered = true;
    Proto._updateClockAndDate.call(stub);
    assert.equal(calls.tooltip.length, 1, "hovered panel refreshes the tooltip");
    // the tooltip is the full table — UTC, local and every configured city —
    // so a hovered panel pays for the whole set, and only then
    assert.equal(calls.clockEntries, 1, "the clocks are formatted for the tooltip that shows them");
});

test("a closed panel with nothing to show does no per-tick clock work", () => {
    const { stub, calls } = updateStub({ menuOpen: false });
    stub.panel_clocks = 0;
    stub.show_weather = false;

    Proto._updateClockAndDate.call(stub);

    assert.equal(calls.clockEntries, 0, "no timezone conversions when nothing renders them");
    assert.equal(calls.worldTicks, 0);
    assert.equal(calls.label.length, 1, "the clock label is still written");
});

test("the day and date labels are not rewritten every tick", () => {
    const { stub, calls } = updateStub({ menuOpen: true });

    Proto._updateClockAndDate.call(stub);
    Proto._updateClockAndDate.call(stub);
    Proto._updateClockAndDate.call(stub);

    assert.equal(calls.dayText.length, 1,
        "the day changes once a day; the tick is once a second");
});

test("_updateClockAndDate skips tooltip row formatting while hidden", () => {
    let tooltipFormats = 0;
    const { stub } = updateStub({ menuOpen: false });
    stub._worldclocks.getClockEntries = () => [{
        label: "UTC",
        timezone: "UTC",
        builtin: true,
        time: "04 Jul 09:05",
        localTime: { format: () => { tooltipFormats++; return "04 Jul 09:05"; } }
    }];

    Proto._updateClockAndDate.call(stub);

    assert.equal(tooltipFormats, 0);
});

test("_updateClockAndDate with the menu open refreshes the full view", () => {
    const { stub, calls } = updateStub({ menuOpen: true });
    Proto._updateClockAndDate.call(stub);
    assert.equal(calls.selected, 1);
    assert.equal(calls.worldTicks, 1);
    assert.equal(calls.lastEntries.length, 4);
    assert.equal(calls.lastEntries.filter((entry) => entry.builtin).length, 1,
        "menu updates include the built-in rows");
    assert.equal(calls.dayText.length, 1);
});

test("_updateClockAndDate keeps an invalid tooltip format inside the clock table", () => {
    const errors = [];
    const formats = [];
    const originalLogError = global.logError;
    global.logError = (message) => errors.push(message);
    const { stub, calls } = updateStub({ menuOpen: true });
    Object.assign(stub, {
        custom_tooltip_format: "bad",
        _calendar: { todaySelected: () => false, getSelectedDate: () => new Date() }
    });
    stub._worldclocks.getClockEntries = () => [{
        label: "UTC",
        timezone: "UTC",
        builtin: true,
        time: "09:05",
        localTime: {
            format: (format) => {
                formats.push(format);
                return format === "bad" ? "" : "04 Jul 09:05";
            }
        }
    }];
    Proto._updateClockAndDate.call(stub);
    global.logError = originalLogError;

    assert.equal(stub.go_home_button.reactive, true);
    assert.equal(calls.tooltip.at(-1), "UTC  04 Jul 09:05");
    assert.deepEqual(formats, ["bad", "%d %b %H:%M", "bad", "%d %b %H:%M"]);
    assert.ok(errors.length > 0);
});

test("_updateClockAndDate appends the weather reading to the clock", () => {
    const { stub, calls } = updateStub({ menuOpen: false });
    Object.assign(stub, {
        show_weather: true,
        _weather_reading: { condition: "☀", temperatureC: 20 },
        clock: clockStub({ get_clock: () => "04 Jul 09:05" })
    });
    Proto._updateClockAndDate.call(stub);
    // the clock and the reading run together; the panel suffix is the
    // temperature and nothing else — the sky glyph and the world clocks are not
    // on the panel. (ellipsizeLabelSuffix is exercised directly elsewhere.)
    assert.equal(calls.label[0], "04 Jul 09:05 20°C");
});

test("_updateClockAndDate forces the full view when asked", () => {
    const { stub, calls } = updateStub({ menuOpen: false });
    Proto._updateClockAndDate.call(stub, true);
    assert.equal(calls.selected, 1);
    assert.equal(calls.worldTicks, 1);
    assert.equal(calls.lastEntries[1].label, "NY");
});

// broader prototype coverage: cheap stubs over the remaining leaf methods
function tooltipEntry(label, timezone, stamp, builtin) {
    return {
        label,
        timezone,
        builtin,
        time: stamp,
        localTime: { format: () => stamp }
    };
}

// the presenter used to reach into the applet's actors and private fields, so
// extracting it had moved the code without decoupling it: the applet's private
// shape was the presenter's API
test("the panel presenter reads and writes through a view it is given", () => {
    const written = [];
    // the seam is the whole API now: the presenter holds no applet, so a view
    // that answers every question it asks is enough to drive it
    const view = {
        orientation: 0,
        showWeather: false,
        worldclocksEnabled: true,
        customFormat: "",
        customTooltipFormat: "",
        panelClocks: 0,
        worldclocks: [],
        // the menu is open, so the tooltip and the today button are drawn too
        panelHovered: true,
        menuOpen: true,
        desktopSettings: { use24h: true, showSeconds: false },
        weatherReading: null,
        weatherPending: false,
        weatherUnits: "metric",
        weatherError: "",
        weatherProvider: "",
        cityWeatherReading: () => null,
        cityWeatherStale: () => false,
        cityWeatherProviderName: () => "",
        formattedClock: () => "12 Jul 14:03",
        formatClock: () => "Sunday, July 12, 2026",
        setClockFormatString: () => true,
        todaySelected: () => true,
        selectEventsDate: () => written.push(["events"]),
        getClockEntries: () => [],
        updateWorldclocks: () => written.push(["clocks"]),
        setWeatherSource: (source) => written.push(["source", source]),
        setWeatherStatus: (text) => written.push(["weather-status", text]),
        setLabel: (text) => written.push(["label", text]),
        setTooltip: (text) => written.push(["tooltip", text]),
        setAccessibleName: (name) => written.push(["name", name]),
        setHomeEnabled: (enabled) => written.push(["home", enabled]),
        dayLabel: { set_text: (text) => written.push(["day", text]) },
        dateLabel: { set_text: (text) => written.push(["date", text]) }
    };

    const presenter = new PanelStatusModule.AppletPanelStatusPresenter(null, view);
    presenter.updateClockAndDate();

    // nothing is written by reaching into the applet
    assert.ok(written.some(([what]) => what === "label"));
    assert.ok(written.some(([what]) => what === "tooltip"));
    assert.deepEqual(written.find(([what]) => what === "home"), ["home", false],
        "today is selected, so there is nowhere to go");
});

test("a translation containing a percent sign cannot corrupt the panel label", () => {
    // The fallback is handed to strftime, where every % is a directive. A
    // translator can legitimately write "100 % ungültig", and xgettext does not
    // mark these strings c-format, so msgfmt would not catch a stray %d either.
    const twentyFour = { desktopSettings: { use24h: true, showSeconds: false } };
    const twelve = { desktopSettings: { use24h: false, showSeconds: false } };

    const escaped = PanelStatusModule.badFormatFallback(twentyFour, "Format 100 % ungültig");
    assert.match(escaped, /Format 100 %% ungültig/, "the percent is escaped for strftime");
    assert.match(escaped, /%H:%M$/, "and the time follows the user's own clock");

    assert.match(PanelStatusModule.badFormatFallback(twelve, "Bad %d format"),
        /^Bad %%d format .*%-l:%M %p$/, "a stray directive cannot survive either");
});

test("the tooltip clock uses its configured day-month 24-hour format", () => {
    const twelveHour = Object.assign(Object.create(Proto), {
        show_weather: false,
        custom_tooltip_format: "%d %b %H:%M",
        desktop_settings: { use24h: false, showSeconds: false }
    });
    const twentyFour = Object.assign(Object.create(Proto), {
        show_weather: false,
        custom_tooltip_format: "%d %b %H:%M",
        desktop_settings: { use24h: true, showSeconds: false }
    });

    assert.equal(panelStatus(twelveHour).tooltipClockFormat(), "%d %b %H:%M");
    assert.equal(panelStatus(twentyFour).tooltipClockFormat(), "%d %b %H:%M");
});

test("a tooltip row is location, fixed-order timestamp, temperature, and weather", () => {
    const formats = [];
    const stub = {
        custom_tooltip_format: "%d %b %H:%M",
        show_weather: true,
        weather_units: "si",
        _weather_reading: { condition: "☀", temperatureC: 20 },
        _weather_pending: false,
        _weather_error: ""
    };
    const entry = {
        label: "Local time",
        timezone: "Europe/Rome",
        builtin: true,
        time: "fallback",
        localTime: {
            format(format) {
                formats.push(format);
                return "04 Jul 09:05";
            }
        }
    };
    const presenter = panelStatus(stub);

    assert.deepEqual(presenter.tooltipClockRow(entry),
        ["Local time", "04 Jul 09:05", "20°C", "Clear"]);
    assert.equal(presenter.buildTooltipText([entry]),
        "Local time  04 Jul 09:05  20°C  Clear");
    assert.ok(formats.every((format) => format === "%d %b %H:%M"));
});

test("buildTooltipText tabulates every clock with its own weather", () => {
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        weather_units: "si",
        _weather_reading: { condition: "☀", temperatureC: 20 },
        _weather_error: "",
        _weather_provider: "Open-Meteo",
        worldclocks: [{ label: "New York" }],
        panel_clocks: 0,
        cityWeatherReading: (city) => (city === "New York" ? { condition: "🌧", temperatureC: 12 } : null),
        cityWeatherProviderName: () => "Aviation Weather"
    });
    const entries = [
        tooltipEntry("UTC", "UTC", "11 Jul 01:52", true),
        tooltipEntry("Local time", "local", "11 Jul 22:52", true),
        tooltipEntry("New York", "America/New_York", "11 Jul 18:52", false)
    ];

    const lines = panelStatus(stub).buildTooltipText(entries).split("\n");

    // UTC is a scale, not a place: no temperature on that row
    assert.equal(lines[0], "UTC         11 Jul 01:52");
    assert.ok(lines[1].includes("Local time") && lines[1].endsWith("20°C  Clear"));
    assert.ok(lines[2].includes("New York") && lines[2].endsWith("12°C  Rain"));
    assert.equal(lines.length, 3, "one line per location and no standalone header");

    stub._weather_error = "boom";
    const errText = panelStatus(stub).buildTooltipText(entries);
    assert.ok(errText.includes("⚠ Weather service unavailable") || errText.includes("⚠ boom"));
    // a failed refresh keeps the last reading: the marker takes the condition's
    // place in the row, it does not take the temperature away
    assert.match(errText.split("\n").find((line) => line.startsWith("Local time")),
        /20°C.*⚠ boom/);
});

test("the tooltip is empty when there are no clocks or weather status", () => {
    const stub = Object.assign(Object.create(Proto), {
        show_weather: false,
        worldclocks: [],
        panel_clocks: 0
    });

    assert.equal(panelStatus(stub).buildTooltipText([]), "");
});

test("_setWeatherStatus stores state and refreshes the clock line", () => {
    let updated = 0;
    const stub = Object.assign(Object.create(Proto), {
        _updateClockAndDate: () => updated++
    });
    Proto._setWeatherStatus.call(stub, { condition: "☀", temperatureC: 20 }, "err", "prov");
    assert.deepEqual(stub._weather_reading, { condition: "☀", temperatureC: 20 });
    assert.equal(stub._weather_pending, false);
    assert.equal(stub._weather_error, "err");
    assert.equal(stub._weather_provider, "prov");
    assert.equal(updated, 1);

    // the reserved first-fetch slot and the switched-off state carry no record;
    // pending is a flag, not a placeholder string the panel has to recognize
    Proto._setWeatherStatus.call(stub, null, "", "", true);
    assert.equal(stub._weather_reading, null);
    assert.equal(stub._weather_pending, true);
});

test("weather refresh scheduling forwards the settings snapshot", () => {
    const scheduled = [];
    const queued = [];
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        weather_location: "Rome",
        weather_units: "si",
        _weatherProvider: {
            schedule: (settings) => scheduled.push(settings),
            queue: (settings) => queued.push(settings)
        }
    });
    Proto._scheduleWeatherRefresh.call(stub);
    Proto._queueWeatherRefresh.call(stub);
    assert.deepEqual(scheduled[0], { showWeather: true, location: "Rome", units: "si" });
    assert.deepEqual(queued[0], { showWeather: true, location: "Rome", units: "si" });
});

test("event-manager readiness toggles the event list and reselects", () => {
    let selected = 0;
    let forced = null;
    const unavailable = [];
    const stub = Object.assign(Object.create(Proto), {
        show_events: true,
        events_manager: {
            is_active: () => true,
            select_date: (date, force) => {
                selected++;
                forced = force;
            }
        },
        event_list: {
            actor: { visible: false },
            set_unavailable: (flag) => unavailable.push(flag)
        },
        _calendar: { getSelectedDate: () => new Date() }
    });
    Proto._events_manager_ready.call(stub);
    assert.equal(stub.event_list.actor.visible, true);
    assert.equal(selected, 1);
    // the first selection after the manager comes up must force the fetch: the
    // window coordinator would otherwise skip a date it thinks it already has
    assert.equal(forced, true);
    Proto._has_calendars_changed.call(stub);
    assert.equal(stub.event_list.actor.visible, true);
    assert.deepEqual(unavailable, [false, false]);
});

test("events enabled without a calendar service says so instead of vanishing", () => {
    const unavailable = [];
    const stub = Object.assign(Object.create(Proto), {
        show_events: true,
        // the calendar server never answered, or there are no calendars
        events_manager: { is_active: () => false, select_date: () => {} },
        event_list: {
            actor: { visible: false },
            set_unavailable: (flag) => unavailable.push(flag)
        },
        _calendar: { getSelectedDate: () => new Date() }
    });

    Proto._has_calendars_changed.call(stub);

    assert.equal(stub.event_list.actor.visible, true, "the column the user asked for stays up");
    assert.deepEqual(unavailable, [true]);
});

test("world-clock setting changes rebuild and repaint the clocks", () => {
    const ops = [];
    const stub = Object.assign(Object.create(Proto), {
        worldclock_format: "%H:%M",
        _worldclocks: {
            buildClocks: (clocks, format) => ops.push(["build", clocks.length, format]),
            updateClocks: () => ops.push(["update"])
        }
    });
    Proto._onWorldclocksChanged.call(stub, null, "worldclocks", [], [{ a: 1 }, { b: 2 }]);
    assert.deepEqual(stub.worldclocks, [{ a: 1 }, { b: 2 }]);
    assert.deepEqual(ops, [["build", 2, "%H:%M"], ["update"]]);
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
    const original = global.imports.ui.settings.AppletSettings;
    global.imports.ui.settings.AppletSettings = class {
        constructor(owner, uuid, instanceId) {
            binds.push(["ctor", uuid, instanceId]);
        }
        bind(key, prop, cb) {
            binds.push(["bind", key, prop, typeof cb]);
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
    global.imports.ui.settings.AppletSettings = original;

    assert.ok(stub.calendar_settings);
    assert.ok(stub.events_settings);
    assert.deepEqual(binds[0], ["ctor", "chronos@geraldo-netto", 42]);
    assert.ok(binds.some((row) => row[1] === "show-events"));
    assert.ok(binds.some((row) => row[1] === "custom-format"));
    assert.ok(binds.some((row) => row[1] === "custom-tooltip-format"));
    assert.ok(!binds.some((row) => row[1] === "use-custom-format"));
    assert.ok(binds.some((row) => row[0] === "hotkey"));

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

test("settings binding fills the initial holiday country from the operating-system timezone", () => {
    const originalSettings = global.imports.ui.settings.AppletSettings;
    const originalCountryCode = rootModules.worldclockData.localCountryCode;
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

    const stub = Object.assign(Object.create(Proto), {
        instance_id: 42,
        _setKeybinding() {}
    });

    try {
        Proto._bindSettings.call(stub);
        assert.equal(values.country, "ita");

        values.country = "none";
        Proto._bindSettings.call(stub);
    } finally {
        global.imports.ui.settings.AppletSettings = originalSettings;
        rootModules.worldclockData.localCountryCode = originalCountryCode;
    }

    assert.equal(timezoneReads, 1, "tzdata is read only for the initial default");
    assert.equal(values.country, "none", "a later explicit disable is preserved");
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
    const holidayProvider = {
        clearPlace: () => calls.push(["clear"]),
        setPlace: (...args) => calls.push(["place", ...args]),
        destroy() {}
    };
    const settings = {
        values: { has_region: ["usa"], country: null },
        bind(key, prop, cb) { calls.push(["bind", key, prop]); },
        connect(signal) { calls.push(["connect", signal]); return 1; },
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
    }, { holidayProvider: () => holidayProvider });
    lifecycle.initHolidayProvider();
    assert.ok(lifecycle.holidayProvider);
    assert.deepEqual(calls.filter((row) => row[0] === "bindWithObject"), [
        ["bindWithObject", "region_usa", "usa"]
    ]);
    // the country is watched for changes, not bound onto the applet as a
    // property: every read goes through the settings accessor
    assert.deepEqual(calls.filter((row) => row[0] === "connect"),
        [["connect", "changed::country"]]);
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
});

test("applet wrappers open menus, launch settings, and refresh on resume", () => {
    const calls = [];
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
    Proto.on_applet_clicked.call(stub);
    Proto._openMenu.call(stub);
    Proto._onResume.call(stub);
    Proto._onLaunchSettings.call(stub);
    Proto.on_custom_format_button_pressed.call(stub);
    Proto.on_orientation_changed.call(stub, St.Side.BOTTOM);

    assert.equal(stub.menu.toggled, 2);
    assert.equal(stub.menu.closed, 1);
    assert.ok(calls.some((row) => row[0] === "clock"));
    assert.ok(calls.some((row) => row[0] === "weather"));
    assert.ok(calls.some((row) => row[0] === "orientation" && row[1] === St.Side.BOTTOM));
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
        event_list: { actor: { visible: false }, set_unavailable: () => {} },
        events_manager: {
            is_active: () => true,
            select_date: (date, force) => calls.push(["select", force])
        },
        _calendar: { getSelectedDate: () => new Date(2026, 6, 9) }
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
        event_list: { actor: { visible: false }, set_unavailable: () => {} },
        events_manager: {
            is_active: () => true,
            select_date: (date, force) => calls.push(["select", force])
        },
        _calendar: { getSelectedDate: () => new Date(2026, 6, 9) }
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
    const originalEventsManager = rootModules.eventsManager.EventsManager;
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
    rootModules.eventsManager.EventsManager = class {
        constructor(settings) { calls.push(["events", settings]); }
        connect(name, cb) {
            calls.push(["connect", name]);
            return calls.length;
        }
    };

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
            connectCountryChanged() { calls.push(["holiday-init"]); return 1; },
            bindRegions() {}
        },
        _calendar: null,
        _updateClockAndDate: () => calls.push(["clock"])
    });
    Proto._initProviders.call(stub);
    // _panel_hovered gates the expensive path: a tooltip-sized entry list every
    // second. A fresh applet must not think the pointer is already on it.
    assert.equal(stub._panel_hovered, false, "no hover before an enter-event");

    stub.actor.handlers["enter-event"]();
    assert.equal(stub._panel_hovered, true, "an enter-event is what turns it on");

    stub.actor.handlers["leave-event"]();

    rootModules.weather.WeatherProvider = originalWeatherProvider;
    rootModules.eventsManager.EventsManager = originalEventsManager;
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
        set_events() {}
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
    stub.events_manager.handlers["selected-date-events-changed"](null, "events", true);
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
        _resetCalendar: () => calls.push(["reset"]),
        _updateClockAndDate: (force) => calls.push(["clock", force])
    });
    Proto._initContextMenu.call(stub);
    stub.menu.handlers["open-state-changed"](stub.menu, true);
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
        EventsManager: rootModules.eventsManager.EventsManager,
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
    rootModules.eventsManager.EventsManager = class {
        connect() { return 1; }
        is_active() { return true; }
        select_date() {}
        start_events() {}
        destroy() {}
    };
    EventView52.EventList = class {
        constructor() { this.actor = {}; }
        connect() { return 1; }
        destroy() {}
        set_date() {}
        set_events() {}
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
    rootModules.eventsManager.EventsManager = originals.EventsManager;
    rootModules.worldclocks.Worldclocks = originals.Worldclocks;
});

// themes centre tooltip text; a centred block staggers every row of the clock
// table, so the applet's own style class has to reach the tooltip actor
test("_styleTooltip marks the tooltip so the clock table stays left-aligned", () => {
    const classes = [];
    const stub = Object.assign(Object.create(Proto), {
        _applet_tooltip: {
            _tooltip: { add_style_class_name: (name) => classes.push(name) }
        }
    });
    Proto._styleTooltip.call(stub);
    assert.deepEqual(classes, ["calendar-tooltip"]);

    // an applet base class that exposes no tooltip actor must not break the
    // constructor: the styling is a nicety, the applet is not
    for (const tooltip of [undefined, {}, { _tooltip: {} }]) {
        const bare = Object.assign(Object.create(Proto), { _applet_tooltip: tooltip });
        assert.doesNotThrow(() => Proto._styleTooltip.call(bare));
    }
});

test("city weather is asked about the timezone's city, not the clock's name", () => {
    const scheduled = [];
    const ticks = [];
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        weather_units: "si",
        worldclocks: [
            { label: "New York", timezone: "America/New_York" },
            // the label is whatever the user typed; only the timezone is a place
            { label: "Mom's place", timezone: "America/Argentina/Buenos_Aires" }
        ],
        _cityWeatherProvider: {
            schedule: (settings, callback) => {
                scheduled.push(settings);
                callback();
            }
        },
        _updateClockAndDate: () => ticks.push(true)
    });

    Proto._scheduleCityWeatherRefresh.call(stub);

    // every clock is a place to resolve; the panel location is not among them
    assert.deepEqual(scheduled, [{
        showWeather: true,
        units: "si",
        cities: [
            { label: "New York", query: "New York" },
            { label: "Mom's place", query: "Buenos Aires" }
        ]
    }]);
    // the reading lands long after the call returns, so the repaint is the
    // provider's callback
    assert.deepEqual(ticks, [true]);

    // an applet whose clocks were never read yet still schedules
    stub.worldclocks = undefined;
    Proto._scheduleCityWeatherRefresh.call(stub);
    assert.deepEqual(scheduled[1].cities, []);

    // a construction that failed before the providers existed must not throw
    // on the next settings change
    const partial = Object.assign(Object.create(Proto), { _cityWeatherProvider: null });
    assert.doesNotThrow(() => Proto._scheduleCityWeatherRefresh.call(partial));
});

test("city weather readings and provider name come from the city provider", () => {
    const stub = Object.assign(Object.create(Proto), {
        _cityWeatherProvider: {
            recordFor: (city) => (city === "Tokyo" ? { condition: "☀", temperatureC: 30 } : null),
            staleFor: (city) => city === "Tokyo",
            lastProvider: "Open-Meteo"
        }
    });
    assert.deepEqual(Proto.cityWeatherReading.call(stub, "Tokyo"), { condition: "☀", temperatureC: 30 });
    assert.equal(Proto.cityWeatherReading.call(stub, "Nowhere"), null);
    assert.equal(Proto.cityWeatherStale.call(stub, "Tokyo"), true);
    assert.equal(Proto.cityWeatherProviderName.call(stub), "Open-Meteo");

    // the tooltip asks for these on every hover, including on a half-built
    // applet: no provider means no reading, not a crash
    const partial = Object.assign(Object.create(Proto), { _cityWeatherProvider: null });
    assert.equal(Proto.cityWeatherReading.call(partial, "Tokyo"), null);
    assert.equal(Proto.cityWeatherStale.call(partial, "Tokyo"), false);
    assert.equal(Proto.cityWeatherProviderName.call(partial), "");
});

test("the weather being fetched is said in words, not as an ellipsis", () => {
    const names = [];
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        // no reading has landed yet: the state the provider reserves the slot with
        _weather_reading: null,
        _weather_pending: true,
        _weather_error: "",
        worldclocks: [{ label: "Tokyo" }],
        // a city not read yet has no record; unlike the panel it reserves no slot
        cityWeatherReading: () => null,
        actor: { set_accessible_name: (name) => names.push(name) }
    });

    panelStatus(stub)._announce("12 Jul 14:03 …");
    assert.equal(names[0], "12 Jul 14:03 … — Weather: loading…",
        "read aloud, a bare ellipsis is nothing at all");

    const cells = panelStatus(stub).tooltipWeatherCells(
        tooltipEntry("Tokyo", "Asia/Tokyo", "12 Jul 07:51", false));
    assert.deepEqual(cells, ["", ""],
        "a city not read yet is a blank cell, not a placeholder");
});

test("the tooltip says when a city's temperature is no longer current", () => {
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        _weather_reading: { condition: "☀", temperatureC: 20 },
        _weather_error: "",
        worldclocks: [{ label: "Tokyo" }],
        cityWeatherReading: () => ({ condition: "☀", temperatureC: 30 }),
        cityWeatherStale: (city) => city === "Tokyo"
    });

    const cells = panelStatus(stub).tooltipWeatherCells(
        tooltipEntry("Tokyo", "Asia/Tokyo", "12 Jul 07:51", false));

    assert.equal(cells[0], "30°C", "the reading it has is still shown");
    assert.match(cells[1], /⚠ Last known reading/,
        "but it is not passed off as the weather now");
});

test("_setWeatherStatus clears the provider name when a refresh reports none", () => {
    const stub = Object.assign(Object.create(Proto), {
        _weather_provider: "Open-Meteo",
        _updateClockAndDate: () => {}
    });

    // a failed refresh carries no provider: the tooltip must not keep naming
    // the source of a reading that is gone
    Proto._setWeatherStatus.call(stub, null, "Weather service unavailable");
    assert.equal(stub._weather_provider, "");
});

// a country key that was cleared to an empty string (rather than to "none") is
// still "no holidays": it must not reach the provider as a place to look up
test("an empty holiday country is treated as none", () => {
    const calls = [];
    const lifecycle = new AppletModule.AppletProviderLifecycle({
        holidaySettings: { country: "" },
        onHolidayPlaceChanged: () => calls.push("refresh")
    });
    lifecycle.holidayProvider = {
        clearPlace: () => calls.push("clear"),
        setPlace: () => calls.push("place")
    };

    lifecycle.onHolidayPlaceChanged();

    assert.deepEqual(calls, ["clear", "refresh"]);
});

test("the provider lifecycle releases the city weather provider too", () => {
    const torn = [];
    const lifecycle = new AppletModule.AppletProviderLifecycle({
        actor: { disconnect: () => {} },
        desktopSettings: { disconnect: () => {} }
    });
    // the city provider holds a refresh timer and an HTTP session; leaving it
    // behind leaks both for the rest of the session
    lifecycle.cityWeatherProvider = { destroy: () => torn.push("city") };
    lifecycle.weatherProvider = { destroy: () => torn.push("panel") };

    lifecycle.destroy();

    assert.deepEqual(torn, ["panel", "city"]);
});

test("describeWeather puts the sky glyph into words for a screen reader", () => {
    // the emoji reads as a codepoint name or as nothing at all
    // the condition glyph is said in words; the label already carries the number
    assert.equal(PanelStatusModule.describeWeather("12 Jul 14:03 8°C", "🌧"), "12 Jul 14:03 8°C — Rain");
    assert.equal(PanelStatusModule.describeWeather("8°C", "⛈"), "8°C — Thunderstorm");
    // no condition, nothing to say: the reading speaks for itself
    assert.equal(PanelStatusModule.describeWeather("8°C"), "8°C");
    assert.equal(PanelStatusModule.describeWeather(""), "");

    // the first refresh has not landed: read aloud, the placeholder is nothing
    assert.equal(PanelStatusModule.describeWeather("12 Jul 14:03 …", "", true),
        "12 Jul 14:03 … — Weather: loading…");
});

// the helper above was written, exported and tested, and then nothing called
// it: the panel re-derived the same string inline, so the feature shipped to
// the test suite and to nobody else
test("the panel's spoken name is the one describeWeather builds", () => {
    const names = [];
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        _weather_reading: { condition: "🌧", temperatureC: 8 },
        _weather_error: "",
        actor: { set_accessible_name: (name) => names.push(name) }
    });

    panelStatus(stub)._announce("12 Jul 14:03 8°C");

    assert.deepEqual(names, [PanelStatusModule.describeWeather("12 Jul 14:03 8°C", "🌧")]);
    assert.equal(names[0], "12 Jul 14:03 8°C — Rain");
});

test("a condition with no translation of its own is still spoken", () => {
    // patched on weatherFormat, which is where the glyph table lives and what the
    // presenter now reads: the barrel copies the binding, so patching the barrel
    // would leave the presenter looking at the original table
    const WeatherFormat = rootModules.weatherFormat;
    const original = WeatherFormat.WEATHER_CONDITIONS;
    // a glyph added to the table without a word here must not silence the
    // readout: the raw condition is better than nothing
    WeatherFormat.WEATHER_CONDITIONS = Object.assign({}, original, { "🧊": "Hail" });
    try {
        assert.equal(PanelStatusModule.describeWeather("0°C", "🧊"), "0°C — Hail");

        const stub = Object.assign(Object.create(Proto), {
            show_weather: true,
            _weather_reading: { condition: "🧊", temperatureC: 0 },
            _weather_error: "",
            actor: { names: [], set_accessible_name(name) { this.names.push(name); } }
        });
        const presenter = panelStatus(stub);
        presenter._announce("10:00 0°C");
        assert.equal(stub.actor.names.at(-1), "10:00 0°C — Hail");

        // the name is written once: St compares by pointer, and this runs at 1 Hz
        presenter._announce("10:00 0°C");
        assert.equal(stub.actor.names.length, 1);

        // an applet whose actor cannot be named must not throw
        delete stub.actor.set_accessible_name;
        assert.doesNotThrow(() => presenter._announce("11:00 0°C"));
    } finally {
        WeatherFormat.WEATHER_CONDITIONS = original;
    }
});

test("a clock row with no zoned time falls back to the preformatted time", () => {
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        _weather_reading: null,
        _weather_error: "",
        // an applet that never built a city provider: no cityWeatherReading at all
        worldclocks: [{ label: "Rome" }]
    });
    const presenter = panelStatus(stub);

    // an invalid timezone has no GLib.DateTime to format — and names no city, so
    // it has no weather either, and the row says so rather than leaving a blank
    // that reads as a fetch still in flight
    assert.deepEqual(presenter.tooltipClockRow({ label: "Rome", time: "Invalid timezone", builtin: false }),
        ["Rome", "Invalid timezone", "", "No weather for this timezone"]);
    assert.deepEqual(presenter.tooltipClockRow({ label: "UTC", timezone: "UTC", time: "01:52", builtin: true }),
        ["UTC", "01:52", "", ""], "UTC is a scale, not a place: it never had weather");

    // a zone that formats to nothing still shows the time the row came with
    assert.deepEqual(presenter.tooltipClockRow({
        label: "Rome",
        time: "18:52",
        builtin: false,
        localTime: { format: () => "" }
    }), ["Rome", "18:52", "", "No weather for this timezone"]);

    // ...and an offset-only zone is the case this is really about: Etc/GMT+3 is a
    // real, valid timezone that names no city, so nothing can ever be forecast for
    // it. A blank cell was indistinguishable from a pending or a failed fetch.
    assert.deepEqual(presenter.tooltipClockRow({
        label: "GMT-3",
        timezone: "Etc/GMT+3",
        time: "15:52",
        builtin: false,
        localTime: { format: () => "15:52" }
    }), ["GMT-3", "15:52", "", "No weather for this timezone"]);
});

test("the tooltip key ignores seconds so an unchanged tooltip is not rebuilt", () => {
    // the tooltip body has no seconds; if the change-detection key kept them, a
    // hovered panel with clock-show-seconds on rebuilt the whole tooltip every
    // second for a byte-identical string
    const stub = {
        show_weather: false,
        _weather_reading: null,
        _weather_error: "",
        worldclocks: []
    };
    const presenter = panelStatus(stub);
    const at = (seconds) => ({
        label: "Rome",
        time: `18:52:${seconds}`,
        builtin: false,
        localTime: { format: () => "18 Jul 18:52" }
    });

    assert.equal(presenter._tooltipKey([at("00")]), presenter._tooltipKey([at("59")]),
        "the second must not change the key when the rendered tooltip is the same");
});

test("the tooltip names no source when neither provider has answered", () => {
    // a plain object, not an applet: a half-built applet has no city provider
    // methods at all
    const stub = {
        show_weather: true,
        _weather_reading: null,
        _weather_error: "",
        _weather_provider: "",
        worldclocks: []
    };
    // a half-built applet has no city provider to ask, and the panel provider
    // has not landed a reading yet: the tooltip simply has no Source line
    assert.equal(panelStatus(stub).weatherSourceName(), "");
    assert.equal(panelStatus(stub).buildTooltipText([]), "");

    stub.cityWeatherProviderName = () => "";
    assert.equal(panelStatus(stub).weatherSourceName(), "");
});

test("translateWeatherError translates the known failures and passes others through", () => {
    assert.equal(
        PanelStatusModule.translateWeatherError(Weather.WEATHER_ERRORS.LOCATION_NOT_FOUND),
        "Location not found");
    assert.equal(PanelStatusModule.translateWeatherError("boom"), "boom");
});

// T74 companion: the length gate is in UTF-16 units, the cut is in code points.
// A suffix of astral glyphs is over the limit by the first measure and under it
// by the second, and must come through whole rather than gaining an ellipsis.
test("ellipsizeLabelSuffix leaves an astral suffix that fits in code points alone", () => {
    const astral = "🌧".repeat(MAX_SUFFIX); // code points at the cap, twice that in UTF-16 units
    assert.ok(astral.length > MAX_SUFFIX && Array.from(astral).length <= MAX_SUFFIX);
    assert.equal(panelStatus({}).ellipsizeLabelSuffix(astral), astral);
});

// With no mode switch, orientation and desktop clock preferences must never
// replace the format stored in custom-format.
test("the configured panel format applies on every panel orientation", () => {
    const configured = "%Y-%m-%d %H:%M";
    for (const side of [St.Side.TOP, St.Side.BOTTOM, St.Side.LEFT, St.Side.RIGHT]) {
        const stub = Object.assign(Object.create(Proto), {
            orientation: side,
            custom_format: configured,
            worldclocks: [],
            clock: {
                formats: [],
                set_format_string(fmt) {
                    this.formats.push(fmt);
                    return true;
                }
            },
            desktop_settings: { use24h: true, showSeconds: false },
            _worldclocks: { buildClocks() {}, setFormat() {}, setVisible() {} }
        });

        Proto._updateFormatString.call(stub);

        assert.equal(stub.clock.formats.at(-1), configured, `side ${side}`);
        assert.equal(stub.worldclock_format, configured, `world clocks on side ${side}`);
    }
});

// REGRESSION: the panel suffix used to carry the condition glyph and to bolt
// the reading onto the clock with a " • " bullet, which read as a second field.
// The panel carries the temperature only; the glyph is a picture of what the
// tooltip and the accessible name already say in words. The failure marker is
// the one glyph that stays - it is the only sign on the panel that the reading
// may be stale.
test("the panel suffix carries the temperature alone, and the failure marker when stale", () => {
    const withReading = suffixStub({ _weather_reading: readingFrom("⛅ 20°C") });
    const suffix = panelStatus(withReading).buildLabelSuffix();

    assert.equal(suffix, "20°C");
    assert.ok(!suffix.includes("•"), "no bullet divides the clock from its temperature");
    assert.equal(Weather.WEATHER_CONDITIONS[Array.from(suffix)[0]], undefined, "no leading condition glyph");

    // every glyph the providers can emit leaves the panel showing the number alone
    for (const glyph of Object.keys(Weather.WEATHER_CONDITIONS)) {
        assert.equal(panelStatus(suffixStub({
            _weather_reading: { condition: glyph, temperatureC: -3 }
        })).buildLabelSuffix(), "-3°C");
    }

    // a failed lookup keeps the last good reading behind the warning marker
    const stale = suffixStub({ _weather_reading: readingFrom("⛅ 20°C"), _weather_error: "Weather service unavailable" });
    assert.equal(panelStatus(stale).buildLabelSuffix(), `${Weather.WEATHER_ERROR_MARKER} 20°C`);
    assert.equal(Weather.WEATHER_ERROR_MARKER, "⚠");

    // and the reading is alone up there: a configured clock adds nothing
    const withClocks = suffixStub({ _weather_reading: readingFrom("⛅ 20°C"), worldclocks: [{ label: "NY" }] });
    assert.equal(panelStatus(withClocks).buildLabelSuffix(), "20°C");
});

// REGRESSION: the tooltip used to be a run-on line per clock, and the UTC row
// was given the panel's temperature. UTC is a scale, not a place: it has no
// weather. The tooltip is the table itself - UTC, local time, then each
// configured city - with no unrelated date/time header above it.
test("the tooltip is exactly the UTC/local/city table", () => {
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        weather_units: "si",
        _weather_reading: { condition: "☀", temperatureC: 20 },
        _weather_error: "",
        _weather_provider: "Open-Meteo",
        worldclocks: [{ label: "New York" }, { label: "Tokyo" }],
        panel_clocks: 1,
        cityWeatherReading: (city) => (city === "New York" ? { condition: "🌧", temperatureC: 12 } : { condition: "🌨", temperatureC: -1 }),
        cityWeatherProviderName: () => "Aviation Weather"
    });
    const entries = [
        tooltipEntry("UTC", "UTC", "11 Jul 01:52", true),
        tooltipEntry("Local time", "local", "11 Jul 22:52", true),
        tooltipEntry("New York", "America/New_York", "11 Jul 18:52", false),
        tooltipEntry("Tokyo", "Asia/Tokyo", "12 Jul 07:52", false)
    ];

    const lines = panelStatus(stub).buildTooltipText(entries).split("\n");

    assert.ok(lines[0].startsWith("UTC"), "UTC is the first row, not a date header");
    assert.equal(lines[0], "UTC         11 Jul 01:52", "and it carries no temperature");
    assert.ok(lines[1].startsWith("Local time"), "local time is the second row");
    assert.ok(lines[1].endsWith("20°C  Clear"), "the local row takes the panel reading");
    assert.ok(lines[2].startsWith("New York") && lines[2].endsWith("12°C  Rain"));
    assert.ok(lines[3].startsWith("Tokyo") && lines[3].endsWith("-1°C  Snow"));

    // There is no header, provider footer or blank line; the provider remains
    // in the popup's accessible name.
    assert.equal(lines.length, entries.length, "one line per location and nothing else");
    lines.forEach((line) => assert.doesNotMatch(line, /Source:/));

    // the columns line up: every row starts its time cell at the same offset
    const timeColumn = lines.map((line) => Array.from(line).indexOf("1"));
    assert.deepEqual(timeColumn, [timeColumn[0], timeColumn[0], timeColumn[0], timeColumn[0]]);

    // and the temperatures hang off the right of their column: the degree signs
    // stack even when one reading is a digit shorter than the others
    const degrees = lines.slice(1).map((line) => Array.from(line).indexOf("°"));
    assert.deepEqual(degrees, [degrees[0], degrees[0], degrees[0]]);

    // no row carries a weather glyph: they are colour emoji from another font,
    // and a row that has one is taller than a row that has not
    lines.forEach((line) => assert.doesNotMatch(line, /[☀🌧🌨⛅☁🌦⛈🌤]/u));
});

// The tooltip contains only the table. The provider credit used to hang under it
// past a blank line: two lines that belong to no column. Attribution lives in
// the world-clock popup's accessible name and in the README.
test("nothing hangs off the bottom of the tooltip table", () => {
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        _weather_reading: { condition: "☀", temperatureC: 20 },
        _weather_error: "",
        _weather_provider: "Open-Meteo",
        worldclocks: [{ label: "New York" }],
        panel_clocks: 1,
        cityWeatherReading: () => ({ condition: "🌧", temperatureC: 12 }),
        cityWeatherProviderName: () => "Aviation Weather"
    });
    const entries = [
        tooltipEntry("UTC", "UTC", "11 Jul 01:52", true),
        tooltipEntry("Local time", "local", "11 Jul 22:52", true),
        tooltipEntry("New York", "America/New_York", "11 Jul 18:52", false)
    ];

    const lines = panelStatus(stub).buildTooltipText(entries).split("\n");

    assert.equal(lines.length, entries.length, "one table line per clock, and no header or footer");
    lines.forEach((line) => {
        assert.notEqual(line.trim(), "", "no blank line anywhere in a table");
        assert.doesNotMatch(line, /Source:|Open-Meteo|Aviation Weather/,
            "the provider is not a row, so it is not in the tooltip");
    });

    // ...and it stays a table when the provider is the only thing that changed
    stub._weather_provider = "MET Norway";
    const relabelled = panelStatus(stub).buildTooltipText(entries).split("\n");
    assert.deepEqual(relabelled, lines, "the tooltip does not depend on who answered");
});

// the city list is the user's, and its labels are any length at all: the column
// widths are measured from the rows, never assumed, so one long name pushes the
// whole table over and a short one leaves it where it is
test("the tooltip columns are as wide as the longest cell in them", () => {
    // the label is the user's name for the row; the reading is of the city the
    // row's timezone names, and that is what it is keyed by
    const rows = [
        { label: "Rio", timezone: "America/Sao_Paulo", city: "Sao Paulo", reading: "☀ 5°C" },
        { label: "Buenos Aires", timezone: "America/Argentina/Buenos_Aires",
            city: "Buenos Aires", reading: "⛅ 11°C" },
        { label: "Sault Ste. Marie, Ontario", timezone: "America/Toronto",
            city: "Toronto", reading: "🌨 -12°C" }
    ];
    const readings = Object.fromEntries(rows.map((row) => [row.city, row.reading]));
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        weather_units: "si",
        _weather_reading: null,
        _weather_error: "",
        _weather_provider: "",
        worldclocks: rows.map(({ label, timezone }) => ({ label, timezone })),
        cityWeatherReading: (city) => (readings[city] ? readingFrom(readings[city]) : null),
        cityWeatherProviderName: () => ""
    });
    const entries = rows.map((row) =>
        tooltipEntry(row.label, row.timezone, "11 Jul 18:52", false));

    const lines = panelStatus(stub).buildTooltipText(entries).split("\n");
    const longest = "Sault Ste. Marie, Ontario".length;

    // every time cell starts one gap past the longest label, whatever the row
    lines.forEach((line, row) => {
        assert.equal(line.indexOf("11 Jul"), longest + 2,
            `row ${row} starts its time cell where every other row does`);
    });

    // and the temperatures are right-aligned, so "5°C" and "-12°C" end together
    const ends = lines.map((line) => line.indexOf("°C") + 2);
    assert.deepEqual(ends, [ends[0], ends[0], ends[0]]);
    assert.ok(lines[0].includes("  5°C"), "the short reading is padded, not the column");
});

// REGRESSION: hovering the panel used to redraw the tooltip from the panel's
// own clock subset - the rows capped by panel_clocks, with the built-in UTC and
// local rows left out - so the tooltip lost exactly the rows it exists to show.
test("a hovered panel shows every clock in the tooltip and none on the panel", () => {
    const { stub, calls } = updateStub({ menuOpen: false });
    stub._panel_hovered = true;

    Proto._updateClockAndDate.call(stub);

    assert.equal(calls.tooltip.length, 1);

    // the panel label is the date and the weather: no clock reaches it
    assert.doesNotMatch(calls.label[0], /NY|Tokyo|Sydney|UTC/);
    // and the tooltip is where they all are, built-in rows included
    assert.match(calls.tooltip[0], /UTC/);
    assert.match(calls.tooltip[0], /Sydney/);
});

test("fuzz: the tooltip table never throws and keeps its columns aligned", () => {
    const TEMPERATURE_COLUMN = 2;
    const rand = makeRandom(FUZZ_SEED);
    const alphabets = [
        "abcdefghijklmnopqrstuvwxyz ",
        "ÅÄÖéèçñüß",
        "東京モスクワ",
        "🌧⛈☀❄🇯🇵",
        "́̈-_/:.",
        ""
    ];

    // a real cell is a label, a stamp or a reading: it never ends in padding
    // of its own, which the row-trailing trim would then eat
    function randomCell() {
        const chars = Array.from(alphabets[Math.floor(rand() * alphabets.length)]);
        const length = Math.floor(rand() * 20);
        let cell = "";
        for (let i = 0; i < length && chars.length; i++) {
            cell += chars[Math.floor(rand() * chars.length)];
        }
        return cell.replace(/\s+$/, "");
    }

    const presenter = panelStatus({});
    for (let round = 0; round < 200; round++) {
        const rowCount = 1 + Math.floor(rand() * 5);
        const rows = Array.from({ length: rowCount }, () => {
            const cellCount = 1 + Math.floor(rand() * 3);
            return Array.from({ length: cellCount }, randomCell);
        });

        let lines;
        assert.doesNotThrow(() => { lines = presenter.alignTooltipRows(rows); });
        assert.equal(lines.length, rows.length);

        // the padding is the only thing holding the columns together, so it is
        // counted in code points: a surrogate pair is one column, not two
        const widths = [];
        rows.forEach((cells) => cells.forEach((cell, column) => {
            widths[column] = Math.max(widths[column] || 0, Array.from(cell).length);
        }));

        lines.forEach((line, row) => {
            const chars = Array.from(line);
            assert.ok(line.isWellFormed(), "no glyph is split by the padding");
            assert.doesNotMatch(line, /\s$/, "no row ends in padding");

            let offset = 0;
            rows[row].forEach((cell, column) => {
                const last = column === rows[row].length - 1;
                // a trailing empty cell is trimmed off the row entirely
                const expected = last && !cell ? "" : cell;
                const size = Array.from(expected).length;
                // the temperature column is right-aligned: its cell ends on the
                // column boundary instead of starting on it
                const start = column === TEMPERATURE_COLUMN ?
                    offset + widths[column] - size : offset;
                assert.equal(chars.slice(start, start + size).join(""),
                    expected, `row ${row} column ${column} sits on the shared offset`);
                offset += widths[column] + 2;
            });
        });
    }

    // rows made of nothing but padding are still rows
    assert.doesNotThrow(() => presenter.alignTooltipRows([["  ", ""], [""], ["   "]]));
    assert.deepEqual(presenter.alignTooltipRows([[]]), [""]);
});

test("fuzz: the panel label builder never throws on any weather state", () => {
    const rand = makeRandom(FUZZ_SEED + 1);
    const glyphs = Object.keys(Weather.WEATHER_CONDITIONS);
    const errors = Object.values(Weather.WEATHER_ERRORS).concat(["", "boom", "⚠", "네트워크"]);
    const readings = ["", "20°C", "-3 °F", "…", "🌡".repeat(40), "x".repeat(200)];
    const sides = [St.Side.TOP, St.Side.BOTTOM, St.Side.LEFT, St.Side.RIGHT];

    for (let round = 0; round < 400; round++) {
        const glyph = rand() < 0.5 ? glyphs[Math.floor(rand() * glyphs.length)] + " " : "";
        const orientation = sides[Math.floor(rand() * sides.length)];
        const stub = suffixStub({
            orientation,
            show_weather: rand() < 0.8,
            _weather_reading: { condition: glyph, temperatureC: readings[Math.floor(rand() * readings.length)] },
            _weather_error: errors[Math.floor(rand() * errors.length)],
            worldclocks: Array.from({ length: Math.floor(rand() * 9) }, () => ({}))
        });
        const clockTexts = stub.worldclocks.map((clock, i) => ({
            label: "город".repeat(1 + Math.floor(rand() * 3)) + i,
            time: rand() < 0.5 ? "07:00" : "🕖"
        }));

        const presenter = panelStatus(stub);
        let suffix;
        assert.doesNotThrow(() => { suffix = presenter.buildLabelSuffix(clockTexts); });
        assert.equal(typeof suffix, "string");

        if (stub.show_weather && stub._weather_error) {
            assert.ok(suffix.startsWith(Weather.WEATHER_ERROR_MARKER),
                "a stale reading always says so first");
        }

        let label;
        assert.doesNotThrow(() => { label = presenter.ellipsizeLabelSuffix(suffix); });
        assert.ok(label.isWellFormed(), "the cut never splits a surrogate pair");
        assert.ok(Array.from(label).length <= MAX_SUFFIX, "the panel label stays bounded");
    }
});

// The tests below were written against surviving mutants: each one flips a
// single operator in appletPanelStatus.js that the suite ran but never checked.

test("the world-clock block hides only when the setting says so", () => {
    const shown = [];
    const stub = Object.assign(Object.create(Proto), {
        orientation: St.Side.TOP,
        custom_format: "",
        clock: clockStub({ set_format_string: () => true }),
        desktop_settings: { use24h: true, showSeconds: true },
        worldclocks: [],
        _worldclocks: { buildClocks() {}, setFormat() {}, setVisible: (visible) => shown.push(visible) },
        show_worldclocks: true
    });

    Proto._updateFormatString.call(stub);
    assert.equal(shown[0], true, "clocks on when the switch is on");

    stub.show_worldclocks = false;
    Proto._updateFormatString.call(stub);
    assert.equal(shown[1], false, "and off when it is off");

    // an unset setting is not the same as a disabled one: a settings file that
    // predates the switch must keep showing the clocks
    stub.show_worldclocks = undefined;
    Proto._updateFormatString.call(stub);
    assert.equal(shown[2], true, "an absent setting still shows them");
});

test("no clock list, however shaped, puts a clock on the panel", () => {
    // the panel label asks the clock list nothing at all now, so an absent,
    // empty or populated list all produce the same suffix: the weather
    for (const worldclocks of [undefined, null, [], [{ label: "NY" }]]) {
        assert.equal(panelStatus(suffixStub({ worldclocks })).buildLabelSuffix(), "");
        assert.equal(
            panelStatus(suffixStub({ worldclocks, _weather_reading: readingFrom("☀ 20°C") })).buildLabelSuffix(),
            "20°C");
    }
});

test("a suffix exactly at the length cap is kept whole, one past it is cut", () => {
    const presenter = panelStatus(suffixStub());
    const cap = "x".repeat(MAX_SUFFIX);

    assert.equal(presenter.ellipsizeLabelSuffix(cap), cap, "a suffix at the cap needs no trim");
    assert.equal(presenter.ellipsizeLabelSuffix(cap + "x").length, MAX_SUFFIX, "one past it is cut to fit");

    // astral glyphs: code points at the cap, measuring twice that in UTF-16
    const astral = "🌧".repeat(MAX_SUFFIX);
    assert.equal(presenter.ellipsizeLabelSuffix(astral), astral);
    assert.equal(Array.from(presenter.ellipsizeLabelSuffix("🌧".repeat(MAX_SUFFIX + 1))).length, MAX_SUFFIX);
});

test("the tooltip never adds a standalone date/time header", () => {
    const base = {
        show_weather: false,
        _weather_reading: null,
        _weather_error: "",
        worldclocks: [],
        panel_clocks: 0,
        cityWeatherReading: () => null,
        cityWeatherProviderName: () => ""
    };

    const presenter = panelStatus(base);
    assert.equal(presenter.buildTooltipText([]), "");
    const lines = presenter.buildTooltipText([
        tooltipEntry("UTC", "UTC", "04 Jul 09:05", true)
    ]).split("\n");

    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith("UTC"));
    assert.doesNotMatch(lines[0], /^date-line$/);
});

test("the accessible name speaks the error, or the condition, or neither", () => {
    function announce(overrides) {
        const spoken = [];
        const stub = Object.assign({
            actor: { set_accessible_name: (name) => spoken.push(name) },
            show_weather: true,
            _weather_reading: { condition: "🌧", temperatureC: 8 },
            _weather_error: ""
        }, overrides);
        panelStatus(stub)._announce("10:00");
        return spoken[0];
    }

    assert.equal(announce({}), "10:00 — Rain", "the condition is spoken in words");
    // an error wins over a stale reading: the name must not claim it is raining
    assert.equal(announce({ _weather_error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE }),
        "10:00 — " + PanelStatusModule.translateWeatherError(Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE));
    // weather off: neither the error nor the condition is anyone's business
    assert.equal(announce({ show_weather: false, _weather_error: "boom" }), "10:00");
    assert.equal(announce({ show_weather: false }), "10:00");
    assert.equal(announce({ _weather_reading: null }), "10:00");
});

test("getClockEntries reads the complete clock list through the view", () => {
    let calls = 0;
    const stub = {
        _worldclocks: {
            getClockEntries() {
                calls++;
                return [];
            }
        }
    };
    const presenter = panelStatus(stub);

    presenter.getClockEntries();
    assert.equal(calls, 1);
});

test("the go-home button is dead only while today is the selected day", () => {
    // a button that goes where you already are is not a button
    const { stub } = updateStub({ menuOpen: true });
    Proto._updateClockAndDate.call(stub);
    assert.equal(stub.go_home_button.reactive, false, "today is selected: nowhere to go");

    stub._calendar.todaySelected = () => false;
    Proto._updateClockAndDate.call(stub);
    assert.equal(stub.go_home_button.reactive, true, "another day: the button comes alive");
});

test("a closed menu refreshes nothing but the panel label", () => {
    // the default is the cheap path: the 1 Hz tick must not rebuild the menu
    const { stub, calls } = updateStub({ menuOpen: false });
    Proto._updateClockAndDate.call(stub);

    assert.equal(calls.label.length, 1, "the label still ticks");
    assert.equal(calls.selected, 0, "but no date is selected");
    assert.equal(calls.worldTicks, 0, "and no world clock is redrawn");
    assert.equal(calls.dayText.length, 0);
});

test("an empty clock list formats no clocks, whatever panel-clocks says", () => {
    // panel_clocks is a cap, not a demand: with nothing to show, formatting a
    // clock every second is pure waste
    const { stub, calls } = updateStub({ menuOpen: false });
    Object.assign(stub, { worldclocks: [], panel_clocks: 3, _panel_hovered: false });

    Proto._updateClockAndDate.call(stub);

    assert.equal(calls.clockEntries, 0, "no clocks configured: none asked for");
    assert.equal(calls.label[0], "10:00", "and the panel is just the clock");
});

// The seam is only worth having if it is the only way through. The presenter used
// to read about fifteen applet privates straight past it, so renaming any of them
// threw nothing — `undefined` is falsy, and the panel suffix, the tooltip's
// temperature column, the accessible name and the "Source:" credit all just went
// blank. This is what that looks like from the outside.
test("the panel presenter goes through the view for every read", () => {
    const source = fs.readFileSync(
        path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "appletPanelStatus.js"),
        "utf8");

    const presenterStart = source.indexOf("class AppletPanelStatusPresenter");
    assert.ok(presenterStart > 0);
    const presenter = source.slice(presenterStart);

    assert.doesNotMatch(presenter, /this\.applet/,
        "the presenter holds no applet: everything it knows comes through the view");
    // ...and the view is the only thing that touches the applet's shape
    const view = source.slice(source.indexOf("class PanelView"), presenterStart);
    assert.match(view, /this\.applet\._weather_reading/);
    assert.match(view, /this\.applet\._weather_reading/);
    assert.match(view, /this\.applet\.worldclock_format = format;/,
        "including the one field the presenter used to write around the seam");
});

// the record is on the surface now; the panel and tooltip read its fields in
// T442d, so for now the view just exposes it
test("the panel view exposes the weather reading record", () => {
    const view = new PanelStatusModule.PanelView({
        _weather_reading: { condition: "☀", temperatureC: 20 }
    });
    assert.deepEqual(view.weatherReading, { condition: "☀", temperatureC: 20 });
});

// and the reads are a contract now, so a view can answer them without an applet
test("a panel view can be substituted whole", () => {
    const reads = [];
    const view = {
        orientation: St.Side.TOP,
        showWeather: true,
        worldclocksEnabled: false,
        panelClocks: 0,
        worldclocks: [],
        panelHovered: false,
        menuOpen: false,
        desktopSettings: { use24h: true },
        get weatherReading() { reads.push("weatherReading"); return { condition: "☀", temperatureC: 20 }; },
        get weatherPending() { reads.push("weatherPending"); return false; },
        weatherUnits: "si",
        get weatherError() { reads.push("weatherError"); return ""; },
        weatherProvider: "Open-Meteo",
        cityWeatherReading: () => null,
        cityWeatherStale: () => false,
        cityWeatherProviderName: () => "",
        formattedClock: () => "12 Jul 14:03",
        formatClock: () => "Sunday",
        getClockEntries: () => [],
        setLabel(text) { this.label = text; },
        setTooltip() {},
        setAccessibleName(name) { this.name = name; }
    };

    const presenter = new PanelStatusModule.AppletPanelStatusPresenter(null, view);
    presenter.updateClockAndDate();

    assert.equal(view.label, "12 Jul 14:03 20°C");
    assert.match(view.name, /Clear/, "the condition is said in words, not left as a glyph");
    assert.ok(reads.includes("weatherReading"));
});

// The weather error's words reached the user only through tooltipWeatherCells(),
// which is called per clock row — and there are no rows when the world clocks are
// off. So with weather on and clocks off, a failed lookup painted a bare ⚠ on the
// panel and hovering it explained nothing; NO_LOCATION was a lone ⚠ that never
// said "Set a weather location". The words existed, translated, and were
// unreachable in the one configuration where the panel has nothing else to say.
test("a weather failure explains itself even with no world clocks", () => {
    const base = {
        showWeather: true,
        worldclocksEnabled: false,
        panelClocks: 0,
        worldclocks: [],
        desktopSettings: { use24h: true },
        weatherProvider: "",
        cityWeatherReading: () => null,
        cityWeatherStale: () => false,
        cityWeatherProviderName: () => ""
    };

    const failed = new PanelStatusModule.AppletPanelStatusPresenter(null, Object.assign({}, base, {
        weatherReading: { condition: "☀", temperatureC: 20 },
        weatherUnits: "metric",
        weatherError: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE
    }));
    const tooltip = failed.buildTooltipText([]);
    assert.match(tooltip, /Weather service unavailable/,
        "hovering a bare ⚠ has to say what went wrong");
    assert.doesNotMatch(tooltip, /Sunday, 12 July 2026/, "there is no standalone date line");

    // the configured-nothing case: a lone ⚠ that never said what to do about it
    const unset = new PanelStatusModule.AppletPanelStatusPresenter(null, Object.assign({}, base, {
        weatherReading: null,
        weatherUnits: "metric",
        weatherError: Weather.WEATHER_ERRORS.NO_LOCATION
    }));
    assert.match(unset.buildTooltipText([]), /Set a weather location/);

    // ...and the first refresh, which is an ellipsis on the panel and nothing at all aloud
    const pending = new PanelStatusModule.AppletPanelStatusPresenter(null, Object.assign({}, base, {
        weatherReading: null,
        weatherPending: true,
        weatherUnits: "metric",
        weatherError: ""
    }));
    assert.match(pending.buildTooltipText([]), /loading/);

    // a working reading says nothing extra: the temperature is on the panel
    const fine = new PanelStatusModule.AppletPanelStatusPresenter(null, Object.assign({}, base, {
        weatherReading: { condition: "☀", temperatureC: 20 },
        weatherUnits: "metric",
        weatherError: ""
    }));
    assert.equal(fine.buildTooltipText([]), "");
});

test("a keyboard-opened popup shows weather status without world clocks", () => {
    const { stub, calls } = updateStub({ menuOpen: true });
    Object.assign(stub, {
        show_weather: true,
        show_worldclocks: false,
        _weather_error: Weather.WEATHER_ERRORS.NO_LOCATION
    });

    Proto._updateClockAndDate.call(stub);

    assert.equal(stub._weather_status.visible, true);
    assert.equal(calls.weatherStatus.at(-1), "⚠ Set a weather location");

    stub._weather_error = "";
    stub._weather_reading = { condition: "☀", temperatureC: 20 };
    Proto._updateClockAndDate.call(stub);
    assert.equal(stub._weather_status.visible, false,
        "a successful reading leaves no redundant status row");
});

// The applet's resume path drives both readouts. The city half needs to be forced
// past its "nothing changed" guard: after a suspend the settings are identical
// and the armed timer still looks alive, because CLOCK_MONOTONIC did not advance.
test("resuming forces the city weather past its unchanged-settings guard", () => {
    const scheduled = [];
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        show_worldclocks: true,
        weather_units: "si",
        weather_location: "Lisbon",
        worldclocks: [{ label: "Tokyo", timezone: "Asia/Tokyo" }],
        _weatherProvider: { schedule: () => scheduled.push(["panel"]) },
        _cityWeatherProvider: {
            schedule: (settings, callback, force) => scheduled.push(["cities", force])
        },
        _updateClockAndDate: () => {},
        _setWeatherStatus: () => {}
    });

    Proto._onResume.call(stub);

    assert.deepEqual(scheduled, [["panel"], ["cities", true]]);

    // ...and an ordinary settings change does not force it
    Proto._scheduleWeatherRefresh.call(stub);
    assert.deepEqual(scheduled.at(-1), ["cities", false]);
});

// The menu builder connects five signals — two on the events manager, three on the
// event list — and discarded every handler id. There was no teardown path from
// on_applet_removed_from_panel that could have used them: they were the only set
// of connects in the applet with no owner.
test("the menu builder disconnects the signals it connected", () => {
    const disconnected = [];
    const eventsManager = {
        connect: (name) => `em:${name}`,
        disconnect: (id) => disconnected.push(id)
    };

    const builder = new AppletModule.AppletMenuBuilder({
        menu: { addActor() {}, addMenuItem() {}, toggle() {} },
        contextMenu: { addMenuItem() {} },
        desktopSettings: { use24h: true },
        calendarSettings: { bindShowWeekNumbers() {}, bindWeekendLength() {} },
        eventsManager,
        holidayProvider: null,
        onGoHome() {},
        onSelectedDateChanged() {},
        onLaunchSettings() {}
    });

    const EventView = require(path.join(APPLET_DIR, "5.4", "eventView.js"));
    const originalEventList = EventView.EventList;
    EventView.EventList = class {
        constructor() {
            this.actor = { add_actor() {} };
            this.connected = [];
        }
        connect(name) {
            this.connected.push(name);
            return `list:${name}`;
        }
        disconnect(id) { disconnected.push(id); }
    };

    try {
        const box = { add_actor() {} };
        const list = builder._buildEventList(box);

        assert.deepEqual(list.connected,
            ["launched-calendar", "start-pass-events", "stop-pass-events"]);

        builder.destroy();

        assert.deepEqual(disconnected.sort(), [
            "em:selected-date-changed",
            "em:selected-date-events-changed",
            "list:launched-calendar",
            "list:start-pass-events",
            "list:stop-pass-events"
        ].sort(), "every signal it connected, it disconnects");

        // ...and a second teardown is not an error
        assert.doesNotThrow(() => builder.destroy());
    } finally {
        EventView.EventList = originalEventList;
    }
});

// The sixth connect: the calendar's selected-date-changed. Its id was discarded
// while the other five were being given an owner — the one connect left in the
// applet that nothing could disconnect, in the file whose comment says why that
// is the shape that breaks when something upstream starts emitting later than it
// used to.
test("the menu builder disconnects the calendar signal too", () => {
    const disconnected = [];
    const builder = new AppletModule.AppletMenuBuilder({
        menu: { addActor() {}, addMenuItem() {}, toggle() {} },
        contextMenu: { addMenuItem() {} },
        desktopSettings: { use24h: true },
        calendarSettings: {},
        eventsManager: { connect: () => 1, disconnect() {} },
        holidayProvider: null,
        onSelectedDateChanged() {},
        onGoHome() {},
        onLaunchSettings() {}
    });

    const Calendar52 = require(path.join(APPLET_DIR, "5.4", "calendar.js"));
    const originalCalendar = Calendar52.Calendar;
    Calendar52.Calendar = class {
        constructor() {
            this.actor = {};
            this.connected = [];
        }
        connect(name) {
            this.connected.push(name);
            return `cal:${name}`;
        }
        disconnect(id) { disconnected.push(id); }
    };

    try {
        const calendar = builder._buildCalendar({ add_actor() {} });
        assert.deepEqual(calendar.connected, ["selected-date-changed"]);

        builder.destroy();

        assert.deepEqual(disconnected, ["cal:selected-date-changed"]);
        assert.doesNotThrow(() => builder.destroy());
    } finally {
        Calendar52.Calendar = originalCalendar;
    }
});

// The panel button is what opens the menu, and it had no accessible role: the
// home button and the date heading were both given PUSH_BUTTON in the
// accessibility pass and this one was missed. Orca read out the date, the time
// and the weather with a filler role and never said the thing was activatable.
test("the panel button announces that it is a button", () => {
    const Atk = global.imports.gi.Atk;
    const actor = { set_accessible_name(name) { this.accessible_name = name; } };
    const view = new PanelStatusModule.PanelView({ actor });

    view.setAccessibleName("12 Jul 14:03");

    assert.equal(actor.accessible_name, "12 Jul 14:03");
    assert.equal(actor.accessible_role, Atk.Role.PUSH_BUTTON);
});

// The tooltip is rebuilt on every tick while the panel is hovered — 1 Hz — and
// alignTooltipRows makes two passes over every cell with Array.from() plus a
// " ".repeat() each: some eighty allocations for ten clocks. The format carries
// no seconds, so 59 of every 60 rebuilds produced byte-identical text.
test("a hovered panel does not rebuild a tooltip that has not changed", () => {
    const written = [];
    const entry = {
        label: "Tokyo", timezone: "Asia/Tokyo", builtin: false,
        time: "12 Jul 22:03", localTime: { format: () => "12 Jul 22:03" }
    };
    const view = {
        orientation: St.Side.TOP,
        showWeather: false,
        worldclocksEnabled: true,
        panelClocks: 1,
        worldclocks: [{ label: "Tokyo" }],
        panelHovered: true,
        menuOpen: false,
        desktopSettings: { use24h: true },
        weatherReading: null, weatherPending: false, weatherUnits: "metric",
        weatherError: "", weatherProvider: "",
        cityWeatherReading: () => null, cityWeatherStale: () => false,
        cityWeatherProviderName: () => "",
        formattedClock: () => "12 Jul 14:03",
        formatClock: () => "Sunday, 12 July 2026",
        getClockEntries: () => [entry],
        setLabel() {},
        setAccessibleName() {},
        setTooltip: (text) => written.push(text)
    };

    const presenter = new PanelStatusModule.AppletPanelStatusPresenter(null, view);

    presenter.updateClockAndDate();
    assert.equal(written.length, 1, "the first tick builds it");

    // the clock ticks again, and the tooltip carries no seconds: nothing it is
    // built from has changed
    presenter.updateClockAndDate();
    presenter.updateClockAndDate();
    assert.equal(written.length, 1, "59 of every 60 rebuilds were thrown away");

    // ...and the minute rolls over
    entry.time = "12 Jul 22:04";
    entry.localTime = { format: () => "12 Jul 22:04" };
    presenter.updateClockAndDate();
    assert.equal(written.length, 2, "a changed clock still lands");
    assert.match(written[1], /22:04/);
});
