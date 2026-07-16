const {
    assert, test, fs, path, makeRandom, APPLET_DIR, rootModules,
    AppletModule, PanelStatusModule, MAX_SUFFIX, Proto, panelStatus, Weather, St, FUZZ_SEED,
    clockStub, readingFrom, suffixStub, updateStub, tooltipEntry
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
    assert.equal(stub._weatherCoordinator.providerName, "");
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
        _weather_reading: { condition: "☀", temperatureC: 20 }
    }));
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

    stub._weatherCoordinator.error = "";
    stub._weatherCoordinator.reading = { condition: "☀", temperatureC: 20 };
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
