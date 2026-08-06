const {
    assert, test, fs, path, makeRandom, APPLET_DIR, rootModules,
    AppletModule, CoordinatorModule, PanelStatusModule, MAX_SUFFIX, Proto, panelStatus,
    Weather, FUZZ_SEED, clockStub, readingFrom, weatherCoordinator, suffixStub,
    updateStub, tooltipEntry
} = require("./helpers/appletFixture");

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
        _updateClockAndDate: () => ticks.push(true)
    });
    stub._weatherCoordinator = new CoordinatorModule.AppletWeatherCoordinator({
        weatherProvider: {},
        cityWeatherProvider: {
            schedule: (settings, callback) => {
                scheduled.push(settings);
                callback();
            }
        },
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

});

test("an invalid runtime timezone never reaches a weather geocoder", () => {
    const original = global.imports.gi.GLib.TimeZone.new_identifier;
    const requests = [];
    global.imports.gi.GLib.TimeZone.new_identifier = (timezone) =>
        timezone === "Company/Secret_Project" ? null : original(timezone);
    const provider = new rootModules.cityWeather.CityWeatherProvider({
        httpGetJson(url, callback) {
            requests.push(url);
            callback(null);
        }
    });
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        show_worldclocks: true,
        weather_units: "si",
        worldclocks: [{ label: "Private", timezone: "Company/Secret_Project" }],
        _updateClockAndDate() {}
    });
    stub._weatherCoordinator = new CoordinatorModule.AppletWeatherCoordinator({
        weatherProvider: {},
        cityWeatherProvider: provider,
        settings: () => ({
            showWeather: stub.show_weather,
            showWorldclocks: stub.show_worldclocks,
            units: stub.weather_units
        }),
        worldclocks: () => stub.worldclocks,
        onChanged: stub._updateClockAndDate,
        guard: (source, fn) => fn()
    });

    try {
        Proto._scheduleCityWeatherRefresh.call(stub);
        assert.deepEqual(requests, [], "neither configured geocoder receives the invalid text");
        assert.deepEqual(provider._cities({
            cities: [{ label: "Private", query: rootModules.worldclockData.timezoneWeatherCity(
                "Company/Secret_Project") }]
        }), []);
    } finally {
        provider.destroy();
        global.imports.gi.GLib.TimeZone.new_identifier = original;
    }
});

test("city weather readings and provider name come from the city provider", () => {
    const coordinator = new CoordinatorModule.AppletWeatherCoordinator({
        weatherProvider: {},
        cityWeatherProvider: {
            recordFor: (city) => (city === "Tokyo" ? { condition: "☀", temperatureC: 30 } : null),
            staleFor: (city) => city === "Tokyo",
            errorFor: (city) => city === "Tokyo" ? "service-unavailable" : "",
            providerFor: (city) => city === "Tokyo" ? "Open-Meteo" : ""
        },
        settings: () => ({}),
        worldclocks: () => [],
        onChanged: () => {},
        guard: (source, fn) => fn()
    });
    assert.deepEqual(coordinator.cityReading("Tokyo"), { condition: "☀", temperatureC: 30 });
    assert.equal(coordinator.cityReading("Nowhere"), null);
    assert.equal(coordinator.cityStale("Tokyo"), true);
    assert.equal(coordinator.cityError("Tokyo"), "service-unavailable");
    assert.equal(coordinator.cityError("Nowhere"), "");
    assert.equal(coordinator.cityProviderName("Tokyo"), "Open-Meteo");
    assert.equal(coordinator.cityProviderName("Nowhere"), "");

    const withoutCityProvider = new CoordinatorModule.AppletWeatherCoordinator({
        weatherProvider: {},
        cityWeatherProvider: null,
        settings: () => ({}),
        worldclocks: () => [],
        onChanged: () => {},
        guard: (source, fn) => fn()
    });
    assert.equal(withoutCityProvider.cityReading("Tokyo"), null);
    assert.equal(withoutCityProvider.cityStale("Tokyo"), false);
    assert.equal(withoutCityProvider.cityError("Tokyo"), "");
    assert.equal(withoutCityProvider.cityProviderName("Tokyo"), "");
});

test("city weather contracts fail loudly when a double is incomplete", () => {
    const port = AppletModule.createPanelPort({
        _weatherCoordinator: { cityError: (city) => city === "Tokyo" ? "offline" : "" }
    });
    assert.equal(port.cityWeatherError("Tokyo"), "offline");

    const incompletePort = AppletModule.createPanelPort({ _weatherCoordinator: {} });
    assert.throws(() => incompletePort.cityWeatherError("Tokyo"), /cityError/);

    const coordinator = new CoordinatorModule.AppletWeatherCoordinator({
        weatherProvider: {},
        cityWeatherProvider: {},
        settings: () => ({}),
        worldclocks: () => [],
        onChanged: () => {},
        guard: (source, fn) => fn()
    });
    assert.throws(() => coordinator.cityError("Tokyo"), /errorFor/);
});

test("the weather being fetched is said in words, not as an ellipsis", () => {
    const names = [];
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        // no reading has landed yet: the state the provider reserves the slot with
        weatherReading: null,
        weatherPending: true,
        weatherError: "",
        worldclocks: [{ label: "Tokyo" }],
        // a city not read yet has no record; unlike the panel it reserves no slot
        cityWeatherReading: () => null,
        actor: { set_accessible_name: (name) => names.push(name) }
    });

    panelStatus(stub)._announce("12 Jul 14:03 …");
    assert.equal(names[0], "12 Jul 14:03 … — Weather: loading…",
        "read aloud, a bare ellipsis is nothing at all");

    const cells = panelStatus(stub)._clockRenderModel([
        tooltipEntry("Tokyo", "Asia/Tokyo", "12 Jul 07:51", false)
    ]).rows[0].slice(2);
    assert.deepEqual(cells, ["", ""],
        "a city not read yet is a blank cell, not a placeholder");
});

test("the tooltip says when a city's temperature is no longer current", () => {
    const stub = Object.assign(Object.create(Proto), {
        show_weather: true,
        weatherReading: { condition: "☀", temperatureC: 20 },
        weatherError: "",
        worldclocks: [{ label: "Tokyo" }],
        cityWeatherReading: () => ({ condition: "☀", temperatureC: 30 }),
        cityWeatherStale: (city) => city === "Tokyo"
    });

    const cells = panelStatus(stub)._clockRenderModel([
        tooltipEntry("Tokyo", "Asia/Tokyo", "12 Jul 07:51", false)
    ]).rows[0].slice(2);

    assert.equal(cells[0], "30°C", "the reading it has is still shown");
    assert.match(cells[1], /⚠ Last known reading/,
        "but it is not passed off as the weather now");
});

test("the weather coordinator clears a provider name when a refresh reports none", () => {
    const coordinator = new CoordinatorModule.AppletWeatherCoordinator({
        weatherProvider: {},
        cityWeatherProvider: null,
        settings: () => ({}),
        worldclocks: () => [],
        onChanged: () => {},
        guard: (source, fn) => fn()
    });
    coordinator.providerName = "Open-Meteo";

    // a failed refresh carries no provider: the tooltip must not keep naming
    // the source of a reading that is gone
    coordinator.setStatus(null, "Weather service unavailable");
    assert.equal(coordinator.providerName, "");
});

test("astronomy coordinates come only from the current enabled weather location", () => {
    const places = {
        Rome: { name: "Rome", latitude: 41.9, longitude: 12.5 }
    };
    let settings = { showWeather: true, location: "Rome" };
    const coordinator = new CoordinatorModule.AppletWeatherCoordinator({
        weatherProvider: { placeFor: (location) => places[location] || null },
        cityWeatherProvider: null,
        settings: () => settings,
        worldclocks: () => [],
        onChanged: () => {},
        guard: (source, fn) => fn()
    });

    assert.deepEqual(coordinator.currentPlace(), places.Rome);
    settings = { showWeather: true, location: "Oslo" };
    assert.equal(coordinator.currentPlace(), null, "the old city's coordinates are never reused");
    settings = { showWeather: false, location: "Rome" };
    assert.equal(coordinator.currentPlace(), null, "weather opt-out also disables its location consumer");

    coordinator.weatherProvider = {};
    settings.showWeather = true;
    assert.equal(coordinator.currentPlace(), null, "an unavailable cache degrades to no astronomy");
});

test("the astronomy popup updates only while it can be seen", () => {
    const { stub } = updateStub({ menuOpen: false });
    const updates = [];
    const place = { latitude: 41.9, longitude: 12.5 };
    stub._astronomy = { update: (model) => updates.push(model) };
    stub._weatherCoordinator.currentPlace = () => place;
    stub.show_weather = true;
    stub.show_astronomy = true;
    stub.desktop_settings = { use24h: true };

    Proto._updateClockAndDate.call(stub);
    assert.deepEqual(updates, [], "closed-menu ticks do no astronomy work");
    stub.menu.isOpen = true;
    Proto._updateClockAndDate.call(stub);
    assert.deepEqual(updates, [{ visible: true, place, use24h: true }]);
    stub.menu.isOpen = false;
    stub.show_weather = false;
    Proto._updateClockAndDate.call(stub, true);
    assert.deepEqual(updates[1], { visible: false, place, use24h: true });

    stub.show_weather = true;
    stub.show_astronomy = false;
    Proto._updateClockAndDate.call(stub, true);
    assert.deepEqual(updates[2], { visible: false, place, use24h: true },
        "astronomy has its own popup visibility control");

    stub.show_astronomy = true;
    stub.menu.toggle = () => {
        stub.menu.isOpen = true;
    };
    Proto._openMenu.call(stub);
    assert.deepEqual(updates[3], { visible: true, place, use24h: true },
        "opening renders immediately instead of waiting for the next clock tick");
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
    lifecycle.weatherRepository = { destroy: () => torn.push("repository") };

    lifecycle.destroy();

    assert.deepEqual(torn, ["panel", "city", "repository"]);
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
        weatherReading: { condition: "🌧", temperatureC: 8 },
        weatherError: "",
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
            weatherReading: { condition: "🧊", temperatureC: 0 },
            weatherError: "",
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
        weatherReading: null,
        weatherError: "",
        // an applet that never built a city provider: no cityWeatherReading at all
        worldclocks: [{ label: "Rome" }]
    });
    const presenter = panelStatus(stub);

    // an invalid timezone has no GLib.DateTime to format — and names no city, so
    // it has no weather either, and the row says so rather than leaving a blank
    // that reads as a fetch still in flight
    assert.deepEqual(presenter._clockRenderModel([
        { label: "Rome", time: "Invalid timezone", builtin: false }
    ]).rows[0],
        ["Rome", "Invalid timezone", "", "No weather for this timezone"]);
    assert.deepEqual(presenter._clockRenderModel([
        { label: "UTC", timezone: "UTC", time: "01:52", builtin: true }
    ]).rows[0],
        ["UTC", "01:52", "", ""], "UTC is a scale, not a place: it never had weather");

    // a zone that formats to nothing still shows the time the row came with
    assert.deepEqual(presenter._clockRenderModel([{
        label: "Rome",
        time: "18:52",
        builtin: false,
        localTime: { format: () => "" }
    }]).rows[0], ["Rome", "18:52", "", "No weather for this timezone"]);

    // ...and an offset-only zone is the case this is really about: Etc/GMT+3 is a
    // real, valid timezone that names no city, so nothing can ever be forecast for
    // it. A blank cell was indistinguishable from a pending or a failed fetch.
    assert.deepEqual(presenter._clockRenderModel([{
        label: "GMT-3",
        timezone: "Etc/GMT+3",
        time: "15:52",
        builtin: false,
        localTime: { format: () => "15:52" }
    }]).rows[0], ["GMT-3", "15:52", "", "No weather for this timezone"]);
});

test("the tooltip key ignores seconds so an unchanged tooltip is not rebuilt", () => {
    // the tooltip body has no seconds; if the change-detection key kept them, a
    // hovered panel with clock-show-seconds on rebuilt the whole tooltip every
    // second for a byte-identical string
    const stub = {
        show_weather: false,
        weatherReading: null,
        weatherError: "",
        worldclocks: []
    };
    const presenter = panelStatus(stub);
    const at = (seconds) => ({
        label: "Rome",
        time: `18:52:${seconds}`,
        builtin: false,
        localTime: { format: () => "18 Jul 18:52" }
    });

    assert.equal(presenter._clockRenderModel([at("00")]).key,
        presenter._clockRenderModel([at("59")]).key,
        "the second must not change the key when the rendered tooltip is the same");
});

test("a clock model names no source when no displayed reading has one", () => {
    // a plain object, not an applet: a half-built applet has no city provider
    // methods at all
    const stub = {
        show_weather: true,
        weatherReading: null,
        weatherError: "",
        weatherProvider: "",
        worldclocks: []
    };
    // a half-built applet has no city provider to ask, and the panel provider
    // has not landed a reading yet: the tooltip simply has no Source line
    assert.deepEqual(panelStatus(stub)._clockRenderModel([]).sources, []);
    assert.equal(panelStatus(stub).buildTooltipText([]), "");

    stub.cityWeatherProviderName = () => "";
    assert.deepEqual(panelStatus(stub)._clockRenderModel([]).sources, []);
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

// Desktop clock preferences must never replace the format stored in
// custom-format.
test("the configured panel format remains authoritative", () => {
    const configured = "%Y-%m-%d %H:%M";
    const stub = Object.assign(Object.create(Proto), {
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
        _worldclocks: {
            format: null,
            buildClocks() {},
            setFormat(format) { this.format = format; },
            setVisible() {}
        }
    });

    Proto._updateFormatString.call(stub);

    assert.equal(stub.clock.formats.at(-1), configured);
    assert.equal(stub._worldclocks.format, configured);
    assert.equal(Object.prototype.hasOwnProperty.call(stub, "worldclock_format"), false);
});

// REGRESSION: the panel suffix used to carry the condition glyph and to bolt
// the reading onto the clock with a " • " bullet, which read as a second field.
// The panel carries the temperature only; the glyph is a picture of what the
// tooltip and the accessible name already say in words. The failure marker is
// the one glyph that stays - it is the only sign on the panel that the reading
// may be stale.
test("the panel suffix carries the temperature alone, and the failure marker when stale", () => {
    const withReading = suffixStub({ weatherReading: readingFrom("⛅ 20°C") });
    const suffix = panelStatus(withReading).buildLabelSuffix();

    assert.equal(suffix, "20°C");
    assert.ok(!suffix.includes("•"), "no bullet divides the clock from its temperature");
    assert.equal(Weather.WEATHER_CONDITIONS[Array.from(suffix)[0]], undefined, "no leading condition glyph");

    // every glyph the providers can emit leaves the panel showing the number alone
    for (const glyph of Object.keys(Weather.WEATHER_CONDITIONS)) {
        assert.equal(panelStatus(suffixStub({
            weatherReading: { condition: glyph, temperatureC: -3 }
        })).buildLabelSuffix(), "-3°C");
    }

    // a failed lookup keeps the last good reading behind the warning marker
    const stale = suffixStub({
        weatherReading: readingFrom("⛅ 20°C"),
        weatherError: "Weather service unavailable"
    });
    assert.equal(panelStatus(stale).buildLabelSuffix(), `${Weather.WEATHER_ERROR_MARKER} 20°C`);
    assert.equal(Weather.WEATHER_ERROR_MARKER, "⚠");

    // and the reading is alone up there: a configured clock adds nothing
    const withClocks = suffixStub({
        weatherReading: readingFrom("⛅ 20°C"),
        worldclocks: [{ label: "NY" }]
    });
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
        weatherReading: { condition: "☀", temperatureC: 20 },
        weatherError: "",
        weatherProvider: "Open-Meteo",
        worldclocks: [{ label: "New York" }, { label: "Tokyo" }],
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
        weatherReading: { condition: "☀", temperatureC: 20 },
        weatherError: "",
        weatherProvider: "Open-Meteo",
        worldclocks: [{ label: "New York" }],
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
    stub._weatherCoordinator.providerName = "MET Norway";
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
        weatherReading: null,
        weatherError: "",
        weatherProvider: "",
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

// REGRESSION: hovering the panel used to redraw the tooltip from an incomplete
// configured-clock subset, leaving the built-in UTC and local rows out.
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

const TOOLTIP_FUZZ_ALPHABETS = [
    "abcdefghijklmnopqrstuvwxyz ",
    "ÅÄÖéèçñüß",
    "東京モスクワ",
    "🌧⛈☀❄🇯🇵",
    "́̈-_/:.",
    ""
];

function randomTooltipCell(rand) {
    const alphabet = TOOLTIP_FUZZ_ALPHABETS[
        Math.floor(rand() * TOOLTIP_FUZZ_ALPHABETS.length)];
    const chars = Array.from(alphabet);
    const length = Math.floor(rand() * 20);
    let cell = "";
    for (let i = 0; i < length && chars.length; i++) {
        cell += chars[Math.floor(rand() * chars.length)];
    }
    return cell.replace(/\s+$/, "");
}

function randomTooltipRows(rand) {
    const rowCount = 1 + Math.floor(rand() * 5);
    return Array.from({ length: rowCount }, () => {
        const cellCount = 1 + Math.floor(rand() * 3);
        return Array.from({ length: cellCount }, () => randomTooltipCell(rand));
    });
}

// The table is padded with spaces in a fixed-width font, so every offset below
// is a count of cells. The oracle states the corpus's own widths rather than
// calling production's displayWidth: the alphabets are a closed set, so it can
// say outright that the CJK one is double-width and the combining marks add
// nothing. An alphabet extended without extending this map fails loudly.
const FUZZ_CELL_WIDTHS = new Map();
Array.from("abcdefghijklmnopqrstuvwxyz ÅÄÖéèçñüß-_/:.⛈☀❄🇯🇵").forEach(
    (character) => FUZZ_CELL_WIDTHS.set(character, 1));
Array.from("東京モスクワ🌧").forEach(
    (character) => FUZZ_CELL_WIDTHS.set(character, 2));
Array.from("́̈").forEach(
    (character) => FUZZ_CELL_WIDTHS.set(character, 0));

function fuzzCellWidth(text) {
    let width = 0;
    for (const character of Array.from(text)) {
        const cells = FUZZ_CELL_WIDTHS.get(character);
        assert.notEqual(cells, undefined,
            `the oracle knows how many cells ${character} takes`);
        width += cells;
    }
    return width;
}

// Where a cell offset lands in the rendered string. A space is one cell and a
// character of the corpus may be two, so the two indexes are not the same.
function charIndexAtCell(chars, targetCell) {
    let cell = 0;
    for (let index = 0; index < chars.length; index++) {
        if (cell >= targetCell) {
            return index;
        }
        cell += FUZZ_CELL_WIDTHS.get(chars[index]);
    }
    return chars.length;
}

function tooltipColumnWidths(rows) {
    const widths = [];
    rows.forEach((cells) => cells.forEach((cell, column) => {
        widths[column] = Math.max(widths[column] || 0, fuzzCellWidth(cell));
    }));
    return widths;
}

function advancingChars(text) {
    return Array.from(text).filter((character) => FUZZ_CELL_WIDTHS.get(character) > 0);
}

function assertTooltipCell(chars, cell, column, last, offset, widths, row) {
    // A trailing empty cell is trimmed off the row entirely. Temperatures are
    // right-aligned, so their cell ends at the shared boundary.
    const expected = advancingChars(last && !cell ? "" : cell).join("");
    const size = fuzzCellWidth(expected);
    const startCell = column === 2 ? offset + widths[column] - size : offset;
    const start = charIndexAtCell(chars, startCell);
    assert.equal(chars.slice(start, charIndexAtCell(chars, startCell + size)).join(""),
        expected, `row ${row} column ${column} sits on the shared offset`);
}

function assertTooltipLine(line, cells, widths, row) {
    assert.ok(line.isWellFormed(), "no glyph is split by the padding");
    assert.doesNotMatch(line, /\s$/, "no row ends in padding");
    // Padding only ever inserts spaces, so every other character — the
    // zero-width marks included — has to survive it in order.
    assert.equal(Array.from(line).filter((character) => character !== " ").join(""),
        cells.join("").replace(/ /g, ""), // NOSONAR [S7781] -- accepted compatible form
        `row ${row} keeps every glyph the cells gave it`);

    // A zero-width mark advances no cell, so it cannot be found by one. The
    // offsets are checked against what the fixed-width font actually advances.
    const chars = advancingChars(line);
    let offset = 0;
    cells.forEach((cell, column) => {
        assertTooltipCell(chars, cell, column, column === cells.length - 1,
            offset, widths, row);
        offset += widths[column] + 2;
    });
}

function assertTooltipTable(lines, rows) {
    const widths = tooltipColumnWidths(rows);
    lines.forEach((line, row) => assertTooltipLine(line, rows[row], widths, row));
}

test("fuzz: the tooltip table never throws and keeps its columns aligned", () => {
    const rand = makeRandom(FUZZ_SEED);
    const presenter = panelStatus({});
    for (let round = 0; round < 200; round++) {
        const rows = randomTooltipRows(rand);

        let lines;
        assert.doesNotThrow(() => { lines = presenter.alignTooltipRows(rows); });
        assert.equal(lines.length, rows.length);
        assertTooltipTable(lines, rows);
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
    for (let round = 0; round < 400; round++) {
        const glyph = rand() < 0.5 ? glyphs[Math.floor(rand() * glyphs.length)] + " " : "";
        const stub = suffixStub({
            show_weather: rand() < 0.8,
            weatherReading: {
                condition: glyph,
                temperatureC: readings[Math.floor(rand() * readings.length)]
            },
            weatherError: errors[Math.floor(rand() * errors.length)],
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

        if (stub.show_weather && stub._weatherCoordinator.error) {
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
            panelStatus(suffixStub({
                worldclocks,
                weatherReading: readingFrom("☀ 20°C")
            })).buildLabelSuffix(),
            "20°C");
    }
});

test("a suffix exactly at the length cap is kept whole, one past it is cut", () => {
    const presenter = panelStatus(suffixStub());
    assert.equal(MAX_SUFFIX, 48, "the panel suffix cap is a product limit");
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
        weatherReading: null,
        weatherError: "",
        worldclocks: [],
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
            weatherReading: { condition: "🌧", temperatureC: 8 },
            weatherError: ""
        }, overrides);
        panelStatus(stub)._announce("10:00");
        return spoken[0];
    }

    assert.equal(announce({}), "10:00 — Rain", "the condition is spoken in words");
    // an error wins over a stale reading: the name must not claim it is raining
    assert.equal(announce({ weatherError: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE }),
        "10:00 — " + PanelStatusModule.translateWeatherError(Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE));
    // weather off: neither the error nor the condition is anyone's business
    assert.equal(announce({ show_weather: false, weatherError: "boom" }), "10:00");
    assert.equal(announce({ show_weather: false }), "10:00");
    assert.equal(announce({ weatherReading: null }), "10:00");
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

test("an unchanged panel label is not rewritten", () => {
    const { stub, calls } = updateStub({ menuOpen: false });

    Proto._updateClockAndDate.call(stub);
    Proto._updateClockAndDate.call(stub);

    assert.deepEqual(calls.label, ["10:00"],
        "an identical render must not queue another St.Label relayout");

    stub.clock.get_clock = () => "10:01";
    Proto._updateClockAndDate.call(stub);

    assert.deepEqual(calls.label, ["10:00", "10:01"],
        "a changed clock still reaches the panel");
});

test("an empty clock list formats no clocks while the menu is closed", () => {
    const { stub, calls } = updateStub({ menuOpen: false });
    Object.assign(stub, { worldclocks: [], _panel_hovered: false });

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
        path.join(__dirname, "..", "files", "chronos@geraldo-netto", "6.0", "appletPanelStatus.js"),
        "utf8");

    const presenterStart = source.indexOf("class AppletPanelStatusPresenter");
    assert.ok(presenterStart > 0);
    const presenter = source.slice(presenterStart);

    assert.doesNotMatch(presenter, /this\.applet/,
        "the presenter holds no applet: everything it knows comes through the view");
    // ...and the view receives an explicit port, not the applet's shape
    const view = source.slice(source.indexOf("class PanelView"), presenterStart);
    assert.doesNotMatch(view, /this\.applet|_weather_reading|_worldclocks/);
    assert.match(view, /this\.port\.weatherReading\(\)/);
    assert.match(view, /this\.port\.setWorldclockFormat\(format\)/);
});

// the record is on the surface now; the panel and tooltip read its fields in
// T442d, so for now the view just exposes it
test("the panel view exposes the weather reading record", () => {
    const view = new PanelStatusModule.PanelView(AppletModule.createPanelPort({
        _weatherCoordinator: weatherCoordinator({
            reading: { condition: "☀", temperatureC: 20 }
        })
    }));
    assert.deepEqual(view.weatherReading, { condition: "☀", temperatureC: 20 });
});

// and the reads are a contract now, so a view can answer them without an applet
test("a panel view can be substituted whole", () => {
    const reads = [];
    const view = {
        showWeather: true,
        worldclocksEnabled: false,
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

    const presenter = new PanelStatusModule.AppletPanelStatusPresenter(view);
    presenter.updateClockAndDate();

    assert.equal(view.label, "12 Jul 14:03 20°C");
    assert.match(view.name, /Clear/, "the condition is said in words, not left as a glyph");
    assert.ok(reads.includes("weatherReading"));
});

// The weather error's words reached the user only through per-clock weather
// cells — and there are no rows when the world clocks are
// off. So with weather on and clocks off, a failed lookup painted a bare ⚠ on the
// panel and hovering it explained nothing; NO_LOCATION was a lone ⚠ that never
// said "Set a weather location". The words existed, translated, and were
// unreachable in the one configuration where the panel has nothing else to say.
test("a weather failure explains itself even with no world clocks", () => {
    const base = {
        showWeather: true,
        worldclocksEnabled: false,
        worldclocks: [],
        desktopSettings: { use24h: true },
        weatherProvider: "",
        cityWeatherReading: () => null,
        cityWeatherStale: () => false,
        cityWeatherProviderName: () => ""
    };

    const failed = new PanelStatusModule.AppletPanelStatusPresenter(Object.assign({}, base, {
        weatherReading: { condition: "☀", temperatureC: 20 },
        weatherUnits: "metric",
        weatherError: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE
    }));
    const tooltip = failed.buildTooltipText([]);
    assert.match(tooltip, /Weather service unavailable/,
        "hovering a bare ⚠ has to say what went wrong");
    assert.doesNotMatch(tooltip, /Sunday, 12 July 2026/, "there is no standalone date line");

    // the configured-nothing case: a lone ⚠ that never said what to do about it
    const unset = new PanelStatusModule.AppletPanelStatusPresenter(Object.assign({}, base, {
        weatherReading: null,
        weatherUnits: "metric",
        weatherError: Weather.WEATHER_ERRORS.NO_LOCATION
    }));
    assert.match(unset.buildTooltipText([]), /Set a weather location/);

    // ...and the first refresh, which is an ellipsis on the panel and nothing at all aloud
    const pending = new PanelStatusModule.AppletPanelStatusPresenter(Object.assign({}, base, {
        weatherReading: null,
        weatherPending: true,
        weatherUnits: "metric",
        weatherError: ""
    }));
    assert.match(pending.buildTooltipText([]), /loading/);

    // a working reading says nothing extra: the temperature is on the panel
    const fine = new PanelStatusModule.AppletPanelStatusPresenter(Object.assign({}, base, {
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
        show_worldclocks: false
    });
    stub._weatherCoordinator.error = Weather.WEATHER_ERRORS.NO_LOCATION;

    Proto._updateClockAndDate.call(stub);

    assert.equal(stub._issueReporter.issues.get("panel"), "Set a weather location");
    assert.equal(calls.weatherStatus.at(-1), "Set a weather location");

    stub._weatherCoordinator.error = "";
    stub._weatherCoordinator.reading = { condition: "☀", temperatureC: 20 };
    Proto._updateClockAndDate.call(stub);
    assert.equal(stub._issueReporter.issues.has("panel"), false,
        "a successful reading leaves no redundant status row");
});

test("the shared footer deduplicates issues and disappears after recovery", () => {
    const { AppletIssueReporter } = require(
        path.join(APPLET_DIR, "6.0", "appletMenuBuilder.js"));
    const label = {
        text: "stale",
        visible: true,
        writes: 0,
        set_text(text) {
            this.text = text;
            this.writes++;
        },
        set_accessible_name(name) { this.accessible_name = name; }
    };
    const reporter = new AppletIssueReporter(label);

    assert.equal(label.text, "");
    assert.equal(label.visible, false, "healthy applet leaves the footer empty");
    const initialWrites = label.writes;

    reporter.set("", "ignored");
    reporter.set("already-healthy", "");
    assert.equal(label.writes, initialWrites,
        "healthy callback ticks do not rewrite the footer");
    reporter.set("weather", "Weather service unavailable");
    const weatherWrites = label.writes;
    reporter.set("weather", "Weather service unavailable");
    assert.equal(label.writes, weatherWrites,
        "repeated failures with the same text are idempotent");
    reporter.set("holidays", "Weather service unavailable");
    reporter.set("events", "Calendar events could not be refreshed.");
    assert.equal(label.text,
        "⚠ Weather service unavailable\n⚠ Calendar events could not be refreshed.");
    assert.equal(label.accessible_name, label.text);
    assert.equal(label.visible, true);

    reporter.set("weather", "");
    assert.match(label.text, /Weather service unavailable/,
        "another source still owns the deduplicated message");
    reporter.set("holidays", "");
    reporter.set("events", "");
    assert.equal(label.text, "");
    assert.equal(label.visible, false);
});

// T706: reloading the applet disposed the footer label with the menu, then a
// later teardown step reported an issue and _render() wrote into the disposed
// St.Label — three Gjs-CRITICALs and Cinnamon's orphan-label warning per reload.
test("a detached footer reporter swallows issues instead of writing the label", () => {
    const { AppletIssueReporter } = require(
        path.join(APPLET_DIR, "6.0", "appletMenuBuilder.js"));
    const label = {
        text: "stale",
        visible: true,
        writes: 0,
        set_text(text) {
            this.text = text;
            this.writes++;
        },
        set_accessible_name(name) { this.accessible_name = name; }
    };
    const reporter = new AppletIssueReporter(label);
    reporter.set("weather", "Weather service unavailable");
    const writesBeforeDetach = label.writes;

    reporter.detach();

    assert.doesNotThrow(() => reporter.set("panel", "Weather service unavailable"));
    assert.doesNotThrow(() => reporter.set("weather", ""));
    assert.equal(label.writes, writesBeforeDetach,
        "no write reaches a label whose actor died with the menu");
});

test("destroying the menu builder detaches its issue reporter", () => {
    const builder = new AppletModule.AppletMenuBuilder({
        eventsManager: { connect: () => 1, disconnect() {} }
    });
    const label = {
        text: "",
        visible: false,
        writes: 0,
        set_text(text) {
            this.text = text;
            this.writes++;
        }
    };
    const { AppletIssueReporter } = require(
        path.join(APPLET_DIR, "6.0", "appletMenuBuilder.js"));
    builder._issueReporter = new AppletIssueReporter(label);
    const writesBeforeDestroy = label.writes;

    builder.destroy();

    builder._issueReporter.set("calendar-service", "no calendar service is running");
    assert.equal(label.writes, writesBeforeDestroy,
        "an issue reported after teardown never touches the footer label");

    // ...and a builder torn down before build() has no reporter to detach
    assert.doesNotThrow(() => new AppletModule.AppletMenuBuilder({
        eventsManager: { connect: () => 1, disconnect() {} }
    }).destroy());
});

test("the footer aggregates weather, clocks, city readings, and format errors", () => {
    let footer = null;
    const view = {
        showWeather: true,
        weatherError: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE,
        cityWeatherReading: () => null,
        cityWeatherError: (city) => city === "Tokyo" ?
            Weather.WEATHER_ERRORS.LOCATION_NOT_FOUND : "",
        cityWeatherStale: (city) => city === "Lisbon",
        customFormat: "%H:%M",
        desktopSettings: { use24h: true },
        setClockFormatString: () => false,
        setWorldclockFormat() {},
        setWorldclocksVisible() {},
        setWeatherStatus: (text) => { footer = text; }
    };
    const presenter = new PanelStatusModule.AppletPanelStatusPresenter(view);
    presenter.updateFormatString();
    const entries = [
        { label: "Broken", timezone: "Invalid/Zone", localTime: null, builtin: false },
        { label: "Tokyo", timezone: "Asia/Tokyo", localTime: {}, builtin: false },
        { label: "Lisbon", timezone: "Europe/Lisbon", localTime: {}, builtin: false }
    ];

    const model = presenter._clockRenderModel(entries);
    const issues = presenter.issueStatus(entries, model.issues);
    assert.match(issues, /Invalid time format/);
    assert.match(issues, /Weather service unavailable/);
    assert.equal(PanelStatusModule.translateWeatherError(Weather.WEATHER_ERRORS.OFFLINE),
        "No network connection", "the offline state has its own words");
    assert.match(issues, /Invalid timezone.*Broken/);
    assert.match(issues, /Tokyo.*Location not found/);
    assert.match(issues, /Lisbon.*Last known reading/);

    view.setClockFormatString = () => true;
    presenter.updateFormatString();
    view.showWeather = false;
    view.weatherError = "";
    const emptyModel = presenter._clockRenderModel([]);
    assert.equal(presenter.issueStatus([], emptyModel.issues), "");
    view.setWeatherStatus(presenter.issueStatus([], emptyModel.issues));
    assert.equal(footer, "", "the aggregate clears when every source recovers");
});

// T608: _tooltipFormatIssue was cleared only inside tooltipClockStamp, on a
// successfully rendered stamp. With world clocks off no stamp ever renders, so
// a user who set a bad custom-tooltip-format, disabled clocks, then fixed the
// format kept the "Invalid time format" footer for the rest of the session.
test("a tooltip-format issue does not outlive the last renderable clock row", () => {
    const view = {
        customTooltipFormat: "%broken",
        desktopSettings: { use24h: true },
        showWeather: false
    };
    const presenter = new PanelStatusModule.AppletPanelStatusPresenter(view);
    const entry = {
        label: "Tokyo",
        time: "12:00",
        localTime: { format: (fmt) => fmt === "%broken" ? null : "stamp" }
    };

    // clocks on: the bad format fails to render and raises the issue
    let model = presenter._clockRenderModel([entry]);
    assert.match(presenter.issueStatus([entry], model.issues), /Invalid time format/);

    // clocks off: no row renders, so the issue no longer applies
    model = presenter._clockRenderModel([]);
    assert.equal(presenter.issueStatus([], model.issues), "");

    // ...and returning clocks with the format still broken re-raises it
    model = presenter._clockRenderModel([entry]);
    assert.match(presenter.issueStatus([entry], model.issues), /Invalid time format/);
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
        _updateClockAndDate: () => {}
    });
    stub._weatherCoordinator = new CoordinatorModule.AppletWeatherCoordinator({
        weatherProvider: { schedule: () => scheduled.push(["panel"]) },
        cityWeatherProvider: {
            schedule: (settings, callback, force) => scheduled.push(["cities", force])
        },
        settings: () => ({
            showWeather: stub.show_weather,
            showWorldclocks: stub.show_worldclocks,
            location: stub.weather_location,
            units: stub.weather_units
        }),
        worldclocks: () => stub.worldclocks,
        onChanged: stub._updateClockAndDate,
        guard: (source, fn) => fn()
    });

    Proto._onResume.call(stub);

    assert.deepEqual(scheduled, [["panel"], ["cities", true]]);

    // ...and an ordinary settings change does not force it
    Proto._scheduleWeatherRefresh.call(stub);
    assert.deepEqual(scheduled.at(-1), ["cities", false]);

    // T708: the network coming back is the retry the offline short-circuit
    // deferred — same shape as a resume: the settings have not changed, the
    // world has, so the city half is forced past its unchanged-settings guard
    scheduled.length = 0;
    Proto._onNetworkRestored.call(stub);
    assert.deepEqual(scheduled, [["panel"], ["cities", true]]);
});

// The menu builder connects six signals — three on the events manager, three on the
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

    const EventView = require(path.join(APPLET_DIR, "6.0", "eventView.js"));
    const originalEventList = EventView.EventList;
    EventView.EventList = class {
        constructor() {
            this.actor = { add_actor() {} };
            this.connected = [];
            this.selectedDate = null;
        }
        connect(name) {
            this.connected.push(name);
            return `list:${name}`;
        }
        disconnect(id) { disconnected.push(id); }
        destroy() {}
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
            "em:refresh-error-changed",
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

// Calendar signals must share the same explicit teardown owner.
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

    const Calendar52 = require(path.join(APPLET_DIR, "6.0", "calendar.js"));
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
        destroy() {}
        holidayForDate() { return null; }
        getSelectedDate() { return null; }
    };

    try {
        const calendar = builder._buildCalendar({ add_actor() {} });
        assert.deepEqual(calendar.connected, ["selected-date-changed", "holidays-changed"]);

        builder.destroy();

        assert.deepEqual(disconnected,
            ["cal:selected-date-changed", "cal:holidays-changed"]);
        assert.doesNotThrow(() => builder.destroy());
    } finally {
        Calendar52.Calendar = originalCalendar;
    }
});

// build() hands the calendar and the event list back only on success, and the
// applet's fields came from that return value alone. A throw anywhere after
// they were constructed therefore left both alive for the session: wired to
// the events manager and the shared desktop settings, holding the module-level
// LC_TIME listener, a pending update idle, the navigation timeout and the
// renderer's three GLib sources — with the applet's own teardown reaching none
// of it.
test("a build that throws partway still tears down what it had built", () => {
    const destroyed = [];
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

    const Calendar52 = require(path.join(APPLET_DIR, "6.0", "calendar.js"));
    const EventView = require(path.join(APPLET_DIR, "6.0", "eventView.js"));
    const originalCalendar = Calendar52.Calendar;
    const originalEventList = EventView.EventList;
    Calendar52.Calendar = class {
        constructor() { this.actor = {}; }
        connect() { return 1; }
        disconnect() {}
        getSelectedDate() { return null; }
        holidayForDate() { return null; }
        destroy() { destroyed.push("calendar"); }
    };
    EventView.EventList = class {
        constructor() {
            this.actor = { add_actor() {} };
            this.selectedDate = null;
        }
        connect() { return 1; }
        disconnect() {}
        set_events() {}
        destroy() { destroyed.push("list"); }
    };
    builder._selectDateInColumn = () => {
        throw new Error("the date heading failed");
    };

    try {
        assert.throws(() => builder.build(), /the date heading failed/);
        assert.ok(builder._issueReporter,
            "the reporter is recorded before anything that can throw, not after");

        builder.destroy();

        assert.deepEqual(destroyed, ["calendar", "list"],
            "the builder destroys what it constructed, not only what it returned");
        assert.doesNotThrow(() => builder.destroy());
        assert.deepEqual(destroyed, ["calendar", "list"], "and a second pass is a no-op");
    } finally {
        Calendar52.Calendar = originalCalendar;
        EventView.EventList = originalEventList;
    }
});

// The panel button is what opens the menu, and it had no accessible role: the
// home button and the date heading were both given PUSH_BUTTON in the
// accessibility pass and this one was missed. Orca read out the date, the time
// and the weather with a filler role and never said the thing was activatable.
test("the panel button announces that it is a button", () => {
    const Atk = global.imports.gi.Atk;
    const actor = { set_accessible_name(name) { this.accessible_name = name; } };
    const view = new PanelStatusModule.PanelView(AppletModule.createPanelPort({ actor }));

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
        showWeather: false,
        worldclocksEnabled: true,
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

    const presenter = new PanelStatusModule.AppletPanelStatusPresenter(view);

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

// T721: `EventWindowCoordinator.selectDate()` returns before any emission when
// `isActive()` is false, and the events manager's "selected-date-changed" was
// the only writer of the column's date heading and of `_selectedEventDate`.
// With "Show events" on and evolution-data-server absent — or present with
// every calendar disabled — that signal never fires for the life of the
// session, while the column stays on screen. So the heading rendered
// permanently blank, and the holiday row stayed pinned to the applet's start
// date while clicking through the grid moved the dots and the cell highlight.
test("the event column follows the grid even with no calendar service", () => {
    const holidays = { "2026-03-17": { name: "St Patrick's Day", flags: ["public_holiday"] } };
    // local components, not toISOString(): the grid selects local days, and a
    // UTC key is off by one for most of the world. GLib components, because the
    // column is handed a GLib.DateTime — the grid navigates in a JS `Date` and
    // _selectDateInColumn is the seam that converts it.
    const key = (date) => `${date.get_year()}-` +
        `${String(date.get_month()).padStart(2, "0")}-` +
        `${String(date.get_day_of_month()).padStart(2, "0")}`;
    const eventsManager = {
        connect: () => 1,
        disconnect() {},
        // evolution-data-server is absent: nothing is ever emitted
        is_active: () => false
    };
    const builder = new AppletModule.AppletMenuBuilder({
        menu: { addActor() {}, addMenuItem() {}, toggle() {} },
        contextMenu: { addMenuItem() {} },
        desktopSettings: { use24h: true },
        calendarSettings: {},
        eventsManager,
        holidayProvider: null,
        onSelectedDateChanged() {},
        onGoHome() {},
        onLaunchSettings() {}
    });

    const dates = [];
    const agendas = [];
    builder._eventList = {
        set_date: (date) => dates.push(key(date)),
        set_events: (agenda) => agendas.push(agenda)
    };
    builder._calendar = {
        holidayForDate: (date) => holidays[key(date)] || null
    };

    builder._selectDateInColumn(new Date(2026, 2, 16));
    builder._selectDateInColumn(new Date(2026, 2, 17));

    assert.deepEqual(dates, ["2026-03-16", "2026-03-17"],
        "the heading tracks the day the user clicked");
    assert.equal(agendas.length, 2, "and the column is redrawn for it");
    // no events and no holiday composes to nothing at all
    assert.equal(agendas[0], null);
    assert.equal(agendas[1].hasHolidays, true,
        "the holiday row is the selected day's, not the start date's");
    assert.deepEqual(agendas[1].get_event_list().map((row) => row.summary || row),
        ["St Patrick's Day"]);

    // with a live service the events manager still owns the render, so the
    // column is not drawn twice for one click
    eventsManager.is_active = () => true;
    builder._selectDateInColumn(new Date(2026, 2, 18));
    assert.deepEqual(dates.at(-1), "2026-03-18", "the heading is still updated");
    assert.equal(agendas.length, 2, "but the redraw is left to the events manager");

    // and nothing is attempted before the column exists
    builder._eventList = null;
    assert.doesNotThrow(() => builder._selectDateInColumn(new Date(2026, 2, 19)));
});

// T819: two producers emit "selected-date-changed" with two different date
// types into one consumer. EventWindowCoordinator emits a GLib.DateTime; the
// calendar emits the JS `Date` its grid navigates in. Every build() test stubs
// both classes and the test above installs a set_date double that accepts
// either, so the real consumer was never driven from the real producer's type —
// and build() threw during construction, leaving a dead, empty panel item.
test("the calendar's JS Date reaches the real EventList.set_date as a GLib date", () => {
    const EventView = require(path.join(APPLET_DIR, "6.0", "eventView.js"));
    const builder = new AppletModule.AppletMenuBuilder({
        menu: { addActor() {}, addMenuItem() {}, toggle() {} },
        contextMenu: { addMenuItem() {} },
        desktopSettings: { use24h: true },
        calendarSettings: {},
        eventsManager: { connect: () => 1, disconnect() {}, is_active: () => false },
        holidayProvider: null,
        onSelectedDateChanged() {},
        onGoHome() {},
        onLaunchSettings() {}
    });

    // the production set_date on a minimal host. It is GLib-only — it formats
    // through GLib.DateTime.format and compares through dt_equals, which calls
    // to_unix() — and this.selected_date is truthy from construction, so the
    // first call is not protected by its own guard.
    const headings = [];
    builder._eventList = {
        selected_date: global.imports.gi.GLib.DateTime.new_now_local(),
        selected_date_label: { set_text: (text) => headings.push(text) },
        _syncSelectedDateLauncher() {},
        set_events() {},
        set_date: EventView.EventList.prototype.set_date
    };

    assert.doesNotThrow(() => builder._selectDateInColumn(new Date(2026, 2, 17)));
    assert.equal(headings.length, 1, "the heading is written");
    assert.match(headings[0], /2026-03-17/, "with the day the grid selected");
    assert.equal(builder._selectedEventDate.get_day_of_month(), 17,
        "and the builder keeps a GLib date whichever producer wrote it last");
});

// EventWindowCoordinator.selectDate emits the new day and then, in the same
// synchronous call, that day's events. Drawing on the first one built a column
// the second replaced: a clear, a "Loading…" write and a 600 ms timer per
// click — and on a holiday day the holiday row itself, built and torn down.
function agendaBuilder() {
    const idles = [];
    const mainloop = global.imports.mainloop;
    const original = { idle_add: mainloop.idle_add, source_remove: mainloop.source_remove };
    let next = 1;
    mainloop.idle_add = (callback) => {
        const id = next++;
        idles.push({ id, callback });
        return id;
    };
    const removed = [];
    mainloop.source_remove = (id) => {
        removed.push(id);
        const at = idles.findIndex((idle) => idle.id === id);
        if (at >= 0) {
            idles.splice(at, 1);
        }
    };

    const handlers = {};
    const drawn = [];
    const builder = new AppletModule.AppletMenuBuilder({
        menu: { addActor() {}, addMenuItem() {}, toggle() {} },
        contextMenu: { addMenuItem() {} },
        desktopSettings: { use24h: true },
        calendarSettings: {},
        eventsManager: {
            connect: (name, handler) => {
                handlers[name] = handler;
                return name;
            },
            disconnect() {}
        },
        holidayProvider: null,
        onGoHome() {},
        onSelectedDateChanged() {},
        onLaunchSettings() {}
    });

    const EventView = require(path.join(APPLET_DIR, "6.0", "eventView.js"));
    const originalEventList = EventView.EventList;
    EventView.EventList = class {
        constructor() {
            this.actor = { add_actor() {} };
            this.selectedDate = null;
        }
        connect() { return 1; }
        disconnect() {}
        destroy() {}
        set_date(date) { this.selectedDate = date; }
        set_events(agenda) { drawn.push(agenda); }
    };
    try {
        builder._buildEventList({ add_actor() {} });
    } finally {
        EventView.EventList = originalEventList;
    }

    const restore = () => Object.assign(mainloop, original);
    const fireIdles = () => {
        while (idles.length) {
            idles.shift().callback();
        }
    };
    return { builder, handlers, drawn, idles, removed, fireIdles, restore };
}

test("a day selection draws the event column once, not twice", () => {
    const { builder, handlers, drawn, idles, restore } = agendaBuilder();
    try {
        const delivered = { length: 2, timestamp: 7 };

        // the pair, in the order the coordinator emits them
        handlers["selected-date-changed"](null, "day-12");
        assert.deepEqual(drawn, [], "the day alone draws nothing yet");
        assert.equal(idles.length, 1, "it is marked stale instead");

        handlers["selected-date-events-changed"](null, delivered, false, false);
        assert.deepEqual(drawn, [delivered], "one draw, with the events in it");
        assert.equal(idles.length, 0, "and the stale mark is spent, not left armed");
    } finally {
        restore();
        builder.destroy();
    }
});

test("a day change with no delivery behind it still redraws the column", () => {
    const { builder, handlers, drawn, idles, removed, fireIdles, restore } = agendaBuilder();
    try {
        // nothing emits this on its own today; if anything ever does, the
        // column must not keep showing the previous day's events
        handlers["selected-date-changed"](null, "day-12");
        assert.deepEqual(drawn, []);

        // a second day change joins the armed draw. Arming another would
        // strand the first source: only the newest id is tracked.
        handlers["selected-date-changed"](null, "day-13");
        assert.equal(idles.length, 1, "one draw is armed, however many days went by");

        fireIdles();
        assert.deepEqual(drawn, [null], "the safety net draws the empty day");
        assert.equal(builder._agenda_render_id, 0);
        // the source that just ran is spent; asking GLib to remove it again is
        // a critical warning in the log
        assert.deepEqual(removed, [], "a draw that fired removes nothing");
    } finally {
        restore();
        builder.destroy();
    }
});

test("tearing the menu down cancels a column draw still waiting on its idle", () => {
    const { builder, handlers, drawn, idles, fireIdles, restore } = agendaBuilder();
    try {
        handlers["selected-date-changed"](null, "day-12");
        assert.equal(idles.length, 1);

        builder.destroy();

        assert.equal(idles.length, 0, "the idle is removed, not just forgotten");
        fireIdles();
        assert.deepEqual(drawn, [], "nothing draws into the destroyed actors");
    } finally {
        restore();
    }
});
