const {
    assert, test, rootModules, AppletModule, CoordinatorModule, PanelStatusModule,
    MAX_SUFFIX, ELLIPSIS, Proto, panelStatus, DateFormats,
    clockStub, readingFrom, suffixStub, updateStub, tooltipEntry
} = require("./helpers/appletFixture");

test("switching world clocks off stops the work they cost", () => {
    const { stub, calls } = updateStub({ menuOpen: true });
    Object.assign(stub, {
        show_worldclocks: false,
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
        _updateClockAndDate: () => {}
    });
    stub._weatherCoordinator = new CoordinatorModule.AppletWeatherCoordinator({
        weatherProvider: {},
        cityWeatherProvider: { schedule: (settings) => scheduled.push(settings) },
        settings: () => ({
            showWeather: stub.show_weather,
            showWorldclocks: stub.show_worldclocks,
            units: stub.weather_units
        }),
        worldclocks: () => stub.worldclocks,
        onChanged: stub._updateClockAndDate,
        guard: (source, fn) => fn()
    });

    Proto._scheduleCityWeatherRefresh.call(stub);

    assert.deepEqual(scheduled[0].cities, [],
        "8 cities × a forecast every 30 minutes, for a feature that is off");
});

// The guard above is only reached if something calls the scheduler when the
// setting changes, and nothing did: the old generic handler updated the format,
// clock and event list and never the city weather. So turning the clocks
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
        custom_format: "",
        desktop_settings: { use24h: true, showSeconds: false },
        _updateFormatString: () => {},
        _updateClockAndDate: () => {},
        _eventListCoordinator: { apply() {} }
    });
    stub._weatherCoordinator = new CoordinatorModule.AppletWeatherCoordinator({
        weatherProvider: {},
        cityWeatherProvider: { schedule: (settings) => scheduled.push(settings) },
        settings: () => ({
            showWeather: stub.show_weather,
            showWorldclocks: stub.show_worldclocks,
            units: stub.weather_units
        }),
        worldclocks: () => stub.worldclocks,
        onChanged: stub._updateClockAndDate,
        guard: (source, fn) => fn()
    });

    Proto._onShowWorldclocksChanged.call(stub);
    assert.equal(scheduled.length, 1, "the first pass arms the round");
    assert.deepEqual(scheduled[0].cities.map((city) => city.query), ["Tokyo"]);

    // the user switches the clocks off
    stub.show_worldclocks = false;
    Proto._onShowWorldclocksChanged.call(stub);

    assert.equal(scheduled.length, 2, "the change reaches the city-weather scheduler");
    assert.deepEqual(scheduled[1].cities, [],
        "and nothing is fetched for a feature the user turned off");

    // ...and an unrelated settings change costs no further round
    Proto._onTooltipFormatChanged.call(stub);
    assert.equal(scheduled.length, 2);
});

// T581 wiring: the grid's events_enabled is recomputed from manager signals,
// and flipping show-events fires none of them — the coordinator's apply pass
// is the only place that can tell the calendar.
test("turning events off reaches the calendar grid's enable state", () => {
    const refreshed = [];
    const coordinator = new CoordinatorModule.AppletEventListCoordinator({
        manager: { is_active: () => false, select_date: () => {} },
        eventList: () => ({
            actor: {},
            set_reporting_enabled() {},
            set_unavailable() {},
            refresh_time_format() {}
        }),
        selectedDate: () => "today",
        guard: (source, fn) => fn(),
        onEnabledChanged: () => refreshed.push(true)
    });

    coordinator.apply(true);
    assert.equal(refreshed.length, 1, "the first pass applies the initial state");

    coordinator.apply(true);
    assert.equal(refreshed.length, 1, "an unchanged setting costs nothing");

    coordinator.apply(false);
    assert.equal(refreshed.length, 2, "the flip reaches the grid");
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
        _calendar: { todaySelected: () => false, getSelectedDate: () => new Date() }
    });
    Object.assign(stub._weatherCoordinator, {
        reading: { condition: "\u2600", temperatureC: 20 },
        providerName: "Open-Meteo",
        cityReading: (city) => (city === "Tokyo" ?
            { condition: "\ud83c\udf27", temperatureC: 12 } : null),
        cityStale: () => false,
        cityProviderName: () => "Open-Meteo"
    });

    Proto._updateClockAndDate.call(stub);

    const tokyo = calls.lastEntries.find((entry) => entry.label === "Tokyo");
    assert.ok(tokyo.weather.includes("12\u00b0C"), "the row carries the city's own reading");
    assert.ok(tokyo.weather.includes("Rain"), "and the condition in words, not an emoji");

    assert.ok(calls.weatherSource.includes("Open-Meteo"),
        "and the service that answered is named where the popup can say it");
});

test("one render model serves tooltip and popup weather", () => {
    const derived = [];
    const original = rootModules.worldclockData.timezoneWeatherCity;
    rootModules.worldclockData.timezoneWeatherCity = (timezone) => {
        derived.push(timezone);
        return timezone.split("/").pop().replace("_", " ");
    };
    const { stub, calls } = updateStub({ menuOpen: true });
    Object.assign(stub, {
        show_weather: true,
        show_worldclocks: true
    });
    Object.assign(stub._weatherCoordinator, {
        cityReading: () => ({ condition: "🌧", temperatureC: 12 }),
        cityStale: () => false
    });

    try {
        Proto._updateClockAndDate.call(stub);
    } finally {
        rootModules.worldclockData.timezoneWeatherCity = original;
    }

    assert.deepEqual(derived,
        ["America/New_York", "Asia/Tokyo", "Australia/Sydney"],
        "each configured timezone is derived once per open-menu tick");
    assert.equal(calls.tooltip.at(-1), [
        "UTC     UTC:%H:%M",
        "NY      04:00      12°C  Rain",
        "Tokyo   18:00      12°C  Rain",
        "Sydney  20:00      12°C  Rain"
    ].join("\n"), "the tooltip remains byte-identical");
    assert.deepEqual(calls.lastEntries.map((entry) => entry.weather || ""), [
        "", "12°C, Rain", "12°C, Rain", "12°C, Rain"
    ], "popup accessibility reuses the same weather cells");
});

test("disabling the home button hands its key focus to the calendar", () => {
    const focused = [];
    const button = { reactive: true, can_focus: true, set_style_class_name: () => {} };
    const applet = {
        go_home_button: button,
        _calendar: { focusSelectedDay: () => focused.push("day") }
    };
    const view = new PanelStatusModule.PanelView(AppletModule.createPanelPort(applet));
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
    const view = new PanelStatusModule.PanelView(AppletModule.createPanelPort(applet));
    const originalStage = global.stage;
    global.stage = { get_key_focus: () => ({}) };

    view.setHomeEnabled(false);
    view.setHomeEnabled(true);
    global.stage = originalStage;

    assert.deepEqual(focused, [], "the focus is somewhere else; do not steal it");
    assert.equal(button.can_focus, true);
});

// T655: setHomeEnabled runs on every open-menu tick, and set_style_class_name
// queues a relayout even for a byte-identical class name
test("an unchanged home state touches no actor", () => {
    const styles = [];
    const button = {
        reactive: false,
        can_focus: false,
        set_style_class_name: (name) => styles.push(name)
    };
    const applet = { go_home_button: button, _calendar: { focusSelectedDay: () => {} } };
    const view = new PanelStatusModule.PanelView(AppletModule.createPanelPort(applet));

    view.setHomeEnabled(true);
    view.setHomeEnabled(true);
    assert.deepEqual(styles, ["calendar-today-home-button-enabled"],
        "a repeated identical state is not re-rendered");

    view.setHomeEnabled(false);
    assert.deepEqual(styles, [
        "calendar-today-home-button-enabled", "calendar-today-home-button"
    ], "a real change still lands");
    assert.equal(button.reactive, false);
});

// T27a/T27b/T657: formatting keeps a local-day cache, but rollover side effects
// belong to the lifecycle workflow rather than this getter.
test("getFormattedToday is cache-only across a local-day key change", () => {
    let formats = 0;
    const stub = {
        clock: clockStub({ get_clock_for_format: (fmt) => (formats++, "v:" + fmt) })
    };
    const presenter = panelStatus(stub);

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

// T609: DATE_FORMAT_SHORT/FULL are translator-supplied strftime msgstrs in 15
// catalogs, and nothing gates their directives — a broken one made
// get_clock_for_format answer null and `.capitalize()` threw on every menu
// open for that locale, blanking the day/date header for good. The header now
// falls back to the untranslated msgid, which is known-valid.
test("a broken translated date format falls back to the untranslated one", () => {
    const seen = new Set();
    const stub = {
        clock: clockStub({
            get_clock_for_format: (fmt) => {
                // the first ask per format is the translated msgstr answering
                // null; the retry is the untranslated fallback
                if (!seen.has(fmt)) {
                    seen.add(fmt);
                    return null;
                }
                return "stamp:" + fmt;
            }
        })
    };
    const presenter = panelStatus(stub);

    const today = presenter.getFormattedToday();
    assert.equal(today.full, ("stamp:" + DateFormats.DATE_FORMAT_FULL_FALLBACK).capitalize());
    assert.equal(today.short, ("stamp:" + DateFormats.DATE_FORMAT_SHORT_FALLBACK).capitalize());
    assert.equal(today.day, ("stamp:" + DateFormats.DAY_FORMAT).capitalize());
});

test("date headers stay empty when translated and fallback formats fail", () => {
    const formats = [];
    const stub = {
        clock: clockStub({
            get_clock_for_format: (format) => {
                formats.push(format);
                return null;
            }
        })
    };
    const presenter = panelStatus(stub);

    assert.deepEqual(presenter.getFormattedToday(), {
        key: presenter._todayFormatCache.key,
        full: "",
        short: "",
        day: ""
    });
    assert.deepEqual(formats, [
        DateFormats.DATE_FORMAT_FULL,
        DateFormats.DATE_FORMAT_FULL_FALLBACK,
        DateFormats.DATE_FORMAT_SHORT,
        DateFormats.DATE_FORMAT_SHORT_FALLBACK,
        DateFormats.DAY_FORMAT,
        DateFormats.DAY_FORMAT
    ]);
});

// T27d: suffix building and ellipsizing
// a reading record {condition, temperatureC} from a display string like "☀ 20°C"
test("buildLabelSuffix is the temperature", () => {
    // the panel shows the temperature; the sky glyph is in the tooltip and in
    // the accessible name, both of which say it in words anyway
    assert.equal(panelStatus(suffixStub({
        weatherReading: readingFrom("☀ 20°C")
    })).buildLabelSuffix(), "20°C");

    // world clocks never reach the panel, however many are configured: they are
    // a table, and the panel is one line the date and the weather already share
    const withClocks = suffixStub({
        weatherReading: readingFrom("☀ 20°C"),
        worldclocks: [{ label: "NY" }, { label: "Tokyo" }]
    });
    assert.equal(panelStatus(withClocks).buildLabelSuffix(), "20°C");

    const stale = suffixStub({
        weatherReading: readingFrom("☀ 20°C"),
        weatherError: "boom"
    });
    assert.equal(panelStatus(stale).buildLabelSuffix(), "⚠ 20°C");
    // an error with no reading yet is the marker alone
    assert.equal(panelStatus(suffixStub({ weatherError: "boom" })).buildLabelSuffix(), "⚠");
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
// The weather suffix was capped and the rest of the label was not — and the rest
// is the user's own custom format. "%A, %-d %B %Y — %H:%M:%S %Z" is about 40
// characters before the weather is added; on a 1366px panel that is two-fifths of
// the width, and it pushes the window list off the panel with nothing to say the
// applet did it.
test("a long custom format cannot push the panel's other applets off it", () => {
    const MAX = PanelStatusModule.LABEL_MAX_LENGTH;
    const MAX_STAMP = DateFormats.MAX_CLOCK_STAMP_LENGTH;
    const { stub, calls } = updateStub();
    Object.assign(stub, {
        show_weather: false,
        custom_format: "ignored — the clock double answers with the string below",
        // the label is whatever WallClock renders the user's format into
        clock: Object.assign(clockStub(), {
            get_clock: () => "x".repeat(200000)
        }),
        actor: { names: [], set_accessible_name(name) { this.names.push(name); } }
    });

    Proto._updateClockAndDate.call(stub);

    const label = calls.label.at(-1);
    assert.equal(Array.from(label).length, MAX, "the label is bounded");
    assert.ok(label.endsWith(ELLIPSIS), "and it says it was cut");

    // Accessibility gets more than the narrow panel can draw, but not the
    // unbounded output of a hand-edited format.
    assert.ok(stub.actor.names.at(-1).length > MAX);
    assert.equal(Array.from(stub.actor.names.at(-1)).length, MAX_STAMP);
    assert.ok(stub.actor.names.at(-1).endsWith(ELLIPSIS));
});

test("the panel readout is announced with its condition", () => {
    const { stub } = updateStub({ menuOpen: false });
    stub.actor = { names: [], set_accessible_name(name) { this.names.push(name); } };
    stub.show_weather = true;
    stub._weatherCoordinator.error = "";
    stub._weatherCoordinator.reading = { condition: "🌧", temperatureC: 8 };

    Proto._updateClockAndDate.call(stub);

    assert.match(stub.actor.names.at(-1), /Rain/,
        "the emoji reads as a codepoint name or nothing; the word does not");
});

test("a weather failure on the panel is announced in words", () => {
    const { stub, calls } = updateStub({ menuOpen: false });
    void calls;
    stub.actor = { names: [], set_accessible_name(name) { this.names.push(name); } };
    stub.show_weather = true;
    stub._weatherCoordinator.error = "Weather service unavailable";
    stub._weatherCoordinator.reading = null;

    Proto._updateClockAndDate.call(stub);

    // the panel label carries only the warning glyph; the name carries the words
    assert.match(stub.actor.names.at(-1), /Weather service unavailable/);

    stub._weatherCoordinator.error = "";
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
    assert.deepEqual(formats, ["bad", "%d %b %H:%M"],
        "the shared render model formats each row once");
    assert.ok(errors.length > 0);
});

test("_updateClockAndDate appends the weather reading to the clock", () => {
    const { stub, calls } = updateStub({ menuOpen: false });
    Object.assign(stub, {
        show_weather: true,
        clock: clockStub({ get_clock: () => "04 Jul 09:05" })
    });
    stub._weatherCoordinator.reading = { condition: "☀", temperatureC: 20 };
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
// the presenter used to reach into the applet's actors and private fields, so
// extracting it had moved the code without decoupling it: the applet's private
// shape was the presenter's API
test("the panel presenter reads and writes through a view it is given", () => {
    const written = [];
    // the seam is the whole API now: the presenter holds no applet, so a view
    // that answers every question it asks is enough to drive it
    const view = {
        showWeather: false,
        worldclocksEnabled: true,
        customFormat: "",
        customTooltipFormat: "",
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

    const presenter = new PanelStatusModule.AppletPanelStatusPresenter(view);
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

test("tooltip formats and rendered stamps use shared Unicode bounds", () => {
    const maxFormat = DateFormats.MAX_DATE_FORMAT_LENGTH;
    const maxStamp = DateFormats.MAX_CLOCK_STAMP_LENGTH;
    const formats = [];
    const stub = { show_weather: false, custom_tooltip_format: "" };
    const entry = {
        label: "Local time", builtin: true, timezone: "local", time: "fallback",
        localTime: {
            format(format) {
                formats.push(format);
                return format === "%d %b %H:%M" ? "x".repeat(200000) : "stamp";
            }
        }
    };
    const presenter = panelStatus(stub);
    const originalLogError = global.logError;
    global.logError = () => {};

    for (const overlong of [" ".repeat(maxFormat + 1), "x".repeat(maxFormat + 1)]) {
        stub.custom_tooltip_format = overlong;
        const stamp = presenter.tooltipClockStamp(entry);
        assert.equal(formats.at(-1), "%d %b %H:%M");
        assert.equal(Array.from(stamp).length, maxStamp);
        assert.ok(stamp.endsWith(ELLIPSIS));
    }

    for (const accepted of [
        "%S".repeat(Math.floor(maxFormat / 2)),
        "🎉".repeat(maxFormat)
    ]) {
        stub.custom_tooltip_format = accepted;
        presenter.tooltipClockStamp(entry);
        assert.equal(formats.at(-1), accepted);
    }
    stub.custom_tooltip_format = "🎉".repeat(maxFormat + 1);
    presenter.tooltipClockStamp(entry);
    assert.equal(formats.at(-1), "%d %b %H:%M");
    assert.match(presenter.issueStatus([entry], []), /Invalid time format/);
    global.logError = originalLogError;
});

test("a tooltip row is location, fixed-order timestamp, temperature, and weather", () => {
    const formats = [];
    const stub = {
        custom_tooltip_format: "%d %b %H:%M",
        show_weather: true,
        weather_units: "si",
        weatherReading: { condition: "☀", temperatureC: 20 },
        weatherPending: false,
        weatherError: ""
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

    const model = presenter._clockRenderModel([entry]);
    assert.deepEqual(model.rows[0],
        ["Local time", "04 Jul 09:05", "20°C", "Clear"]);
    assert.equal(presenter._tooltipText(model),
        "Local time  04 Jul 09:05  20°C  Clear");
    assert.ok(formats.every((format) => format === "%d %b %H:%M"));
});

test("buildTooltipText tabulates every clock with its own weather", () => {
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        weather_units: "si",
        weatherReading: { condition: "☀", temperatureC: 20 },
        weatherError: "",
        weatherProvider: "Open-Meteo",
        worldclocks: [{ label: "New York" }],
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

    stub._weatherCoordinator.error = "boom";
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
        worldclocks: []
    });

    assert.equal(panelStatus(stub).buildTooltipText([]), "");
});

test("the weather coordinator stores state and refreshes the clock line", () => {
    let updated = 0;
    const coordinator = new CoordinatorModule.AppletWeatherCoordinator({
        weatherProvider: {},
        cityWeatherProvider: null,
        settings: () => ({}),
        worldclocks: () => [],
        onChanged: () => updated++,
        guard: (source, fn) => fn()
    });
    coordinator.setStatus({ condition: "☀", temperatureC: 20 }, "err", "prov");
    assert.deepEqual(coordinator.reading, { condition: "☀", temperatureC: 20 });
    assert.equal(coordinator.pending, false);
    assert.equal(coordinator.error, "err");
    assert.equal(coordinator.providerName, "prov");
    assert.equal(updated, 1);

    // the reserved first-fetch slot and the switched-off state carry no record;
    // pending is a flag, not a placeholder string the panel has to recognize
    coordinator.setStatus(null, "", "", true);
    assert.equal(coordinator.reading, null);
    assert.equal(coordinator.pending, true);
});

test("weather refresh scheduling forwards the settings snapshot", () => {
    const scheduled = [];
    const queued = [];
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        weather_location: "Rome",
        weather_units: "si"
    });
    stub._weatherCoordinator = new CoordinatorModule.AppletWeatherCoordinator({
        weatherProvider: {
            schedule: (settings) => scheduled.push(settings),
            queue: (settings) => queued.push(settings)
        },
        cityWeatherProvider: null,
        settings: () => ({
            showWeather: stub.show_weather,
            location: stub.weather_location,
            units: stub.weather_units
        }),
        worldclocks: () => [],
        onChanged: () => {},
        guard: (source, fn) => fn()
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
            set_reporting_enabled: () => {},
            set_unavailable: (flag) => unavailable.push(flag)
        },
        _calendar: { getSelectedDate: () => new Date() }
    });
    stub._eventListCoordinator = new CoordinatorModule.AppletEventListCoordinator({
        manager: stub.events_manager,
        eventList: () => stub.event_list,
        selectedDate: () => stub._calendar.getSelectedDate(),
        guard: (source, fn) => fn()
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
            set_reporting_enabled: () => {},
            set_unavailable: (flag) => unavailable.push(flag)
        },
        _calendar: { getSelectedDate: () => new Date() }
    });
    stub._eventListCoordinator = new CoordinatorModule.AppletEventListCoordinator({
        manager: stub.events_manager,
        eventList: () => stub.event_list,
        selectedDate: () => stub._calendar.getSelectedDate(),
        guard: (source, fn) => fn()
    });

    Proto._has_calendars_changed.call(stub);

    assert.equal(stub.event_list.actor.visible, true, "the column the user asked for stays up");
    assert.deepEqual(unavailable, [true]);
});

test("world-clock setting changes repaint retained weather through the presenter", () => {
    const ops = [];
    const rendered = [];
    let rows = [];
    const { stub } = updateStub({ menuOpen: true });
    Object.assign(stub, {
        show_weather: true,
        show_worldclocks: true,
        worldclock_settings: {
            clocks: [{ label: "Tokyo", timezone: "Asia/Tokyo" }]
        },
        _worldclocks: {
            buildClocks(clocks) {
                ops.push(["build", clocks.length]);
                rows = clocks.map((clock) => ({
                    label: clock.label,
                    timezone: clock.timezone,
                    time: "18:00",
                    builtin: false
                }));
            },
            getClockEntries: () => rows,
            updateClocks(entries) {
                ops.push(["render"]);
                rendered.push(entries);
            },
            setWeatherSource() {}
        }
    });
    stub._weatherCoordinator.cityReading = (city) => city === "Tokyo" ?
        { condition: "🌧", temperatureC: 12 } : null;
    stub._weatherCoordinator.cityStale = () => false;
    stub._weatherCoordinator.scheduleCities = () => ops.push(["schedule"]);

    const renamed = [{ label: "Office", timezone: "Asia/Tokyo" }];
    stub.worldclock_settings.clocks = renamed;
    delete stub.worldclocks;
    Proto._onWorldclocksChanged.call(stub, null, "worldclocks", [], renamed);

    assert.equal(Object.prototype.hasOwnProperty.call(stub, "worldclocks"), false);
    assert.deepEqual(ops, [["build", 1], ["render"], ["schedule"]]);
    assert.equal(rendered.at(-1)[0].label, "Office");
    assert.match(rendered.at(-1)[0].weather, /12°C/,
        "the rebuilt row immediately reuses the cached Tokyo reading");
});
