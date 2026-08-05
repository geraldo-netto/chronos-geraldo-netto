const {
    assert, test, vm, fs, shimPath, shown, loadWeather, makeSoup3,
    immediateNominatimQueue
} = require("./helpers/weatherFixture");

test("built-in Soup 3 JSON loader reports parsed data and HTTP errors", () => {
    const messages = [];
    const Weather = loadWeather({
        Message: {
            new(method, url) {
                const headers = [];
                const message = {
                    method,
                    url,
                    headers,
                    request_headers: {
                        append(name, value) {
                            headers.push([name, value]);
                        }
                    },
                    get_status() {
                        return 200;
                    }
                };
                messages.push(message);
                return message;
            }
        },
        Session: makeSoup3({ data: '{"ok":true}' }).Session
    });
    const provider = new Weather.WeatherProvider();
    let parsed = null;

    provider._httpGetJson("https://example.test/weather", (data) => {
        parsed = data;
    }, {
        headers: {
            "User-Agent": "calendar-test"
        }
    });

    assert.deepEqual(parsed, { ok: true });
    assert.deepEqual(messages[0].headers, [["User-Agent", "calendar-test"]]);

    const WeatherError = loadWeather({
        Message: {
            new(method, url) {
                return {
                    method,
                    url,
                    get_status() {
                        return 500;
                    }
                };
            }
        },
        Session: makeSoup3({ data: '{"ok":true}' }).Session
    });
    const providerError = new WeatherError.WeatherProvider();
    let failed = "unset";

    providerError._httpGetJson("https://example.test/weather", (data) => {
        failed = data;
    });

    assert.equal(failed, null);
});

test("Soup message construction failures become the normal provider error", () => {
    const Weather = loadWeather({
        Message: {
            new() {
                throw new Error("invalid URI");
            }
        }
    });
    const provider = new Weather.WeatherProvider({
        nominatimQueue: immediateNominatimQueue()
    });
    const results = [];

    provider.refresh(
        { showWeather: true, location: "Rome", units: "si" },
        (reading, error) => results.push({ reading, error }));

    assert.deepEqual(results, [{
        reading: null,
        error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE
    }]);
});

test("built-in Soup 3 JSON loader does not catch callback errors", () => {
    const Weather = loadWeather({
        Session: makeSoup3({ data: '{"ok":true}' }).Session
    });
    const provider = new Weather.WeatherProvider();
    let calls = 0;

    assert.throws(() => {
        provider._httpGetJson("https://example.test/weather", (data) => {
            calls++;
            if (data) {
                throw new Error("callback boom");
            }
        });
    }, /callback boom/);
    assert.equal(calls, 1);

    // same guarantee on the HTTP-error path: the null-data callback used to
    // run inside the try, so its own throw was swallowed and the callback
    // re-fired with data = null
    global.imports.gi.Soup.Message.new = function() {
        return {
            get_status() {
                return 500;
            }
        };
    };
    let errorCalls = 0;
    assert.throws(() => {
        provider._httpGetJson("https://example.test/weather", () => {
            errorCalls++;
            throw new Error("error-path boom");
        });
    }, /error-path boom/);
    assert.equal(errorCalls, 1);
});

test("built-in JSON loader handles parse failures", () => {
    const Weather = loadWeather({
        Session: makeSoup3({ data: "not json" }).Session
    });
    const provider = new Weather.WeatherProvider();
    let value = "unset";

    provider._httpGetJson("https://example.test/weather", (data) => {
        value = data;
    });

    assert.equal(value, null);
});

test("default GLib timers drive scheduled and queued refresh callbacks", () => {
    const timeoutSeconds = [];
    const timeoutMillis = [];
    const removed = [];
    const Weather = loadWeather();
    global.imports.gi.GLib.timeout_add_seconds = (priority, seconds, cb) => {
        timeoutSeconds.push({ priority, seconds, cb });
        return 101;
    };
    global.imports.gi.GLib.timeout_add = (priority, millis, cb) => {
        timeoutMillis.push({ priority, millis, cb });
        return 202;
    };
    global.imports.gi.GLib.source_remove = (id) => removed.push(id);

    const provider = new Weather.WeatherProvider();
    let refreshes = 0;
    provider.refresh = () => { refreshes++; };
    provider.schedule({ showWeather: true, location: "Rome", units: "si" }, () => {});
    assert.equal(provider._scheduler.timerId, 101);
    assert.equal(timeoutSeconds[0].cb(), true);

    provider.queue({ showWeather: true, location: "Paris", units: "si" }, () => {});
    assert.equal(provider._scheduler.debounceId, 202);
    assert.equal(timeoutMillis[0].cb(), false);
    assert.ok(refreshes >= 2);

    const cleared = [];
    provider.queue({ showWeather: false, location: "", units: "si" },
        (...args) => cleared.push(args));
    assert.equal(timeoutMillis.length, 1, "the opt-out does not arm another debounce");
    assert.deepEqual(cleared, [[null, "", ""]]);
    assert.deepEqual(removed, [101, 101]);
});

test("version shim forwards the shared weather provider module", () => {
    class SharedWeatherProvider {}
    const shared = {
        WeatherProvider: SharedWeatherProvider,
        WeatherRefreshScheduler: class {},
        WeatherLocationResolver: class {},
        WeatherForecastResolver: class {},
        WEATHER_ERROR_MARKER: "⚠",
        WEATHER_ERRORS: {},
        WEATHER_USER_AGENT: "calendar test",
        WEATHER_PROVIDER_NAMES: {},
        geocodeUrl() {},
        nominatimGeocodeUrl() {},
        forecastUrl() {},
        metNoForecastUrl() {},
        locationCacheKey() {},
        normalizeUnits() {},
        weatherIcon() {},
        weatherText() {},
        metNoIcon() {},
        metNoWeatherText() {},
        openMeteoGeocodePlace() {},
        nominatimGeocodePlace() {}
    };
    const context = {
        module: { exports: null },
        imports: {
            ui: {
                appletManager: {
                    applets: {
                        "chronos@geraldo-netto": { weather: shared }
                    }
                }
            }
        }
    };

    vm.createContext(context);
    vm.runInContext(fs.readFileSync(shimPath, "utf8"), context);

    assert.equal(context.module.exports, shared);
});

// The tests below were written against surviving mutants: each pins a boundary
// or a default that the suite ran through but never actually checked.

test("every Open-Meteo code boundary maps to the glyph on its own side", () => {
    const Weather = loadWeather();
    // the WMO bands are inclusive at the top: 48 is still fog, 49 is already
    // rain. An off-by-one here silently reclassifies the sky.
    const boundaries = [
        [0, "☀"], [1, "⛅"], [3, "⛅"], [4, "☁"], [48, "☁"], [49, "🌧"],
        [67, "🌧"], [68, "🌨"], [77, "🌨"], [78, "🌦"], [86, "🌦"], [87, "🌤"],
        [94, "🌤"], [95, "⛈"], [99, "⛈"], [100, "🌤"]
    ];

    boundaries.forEach(([code, glyph]) => {
        assert.equal(Weather.weatherIcon(code), glyph, "code " + code);
    });
});

test("each METAR present-weather and cover code stands on its own", () => {
    const Weather = loadWeather();
    // these are alternatives, not a conjunction: a station reporting only SG or
    // only IC is still snow, and CLR alone is still clear
    const present = [
        ["TSRA", "⛈"], ["SN", "🌨"], ["SG", "🌨"], ["IC", "🌨"], ["SHRA", "🌦"],
        ["RA", "🌧"], ["DZ", "🌧"], ["PL", "🌧"], ["FG", "☁"], ["BR", "☁"], ["HZ", "☁"]
    ];
    present.forEach(([code, glyph]) => {
        assert.equal(Weather.aviationWeatherIcon({ wxString: code }), glyph, code);
    });

    const cover = [
        ["CAVOK", "☀"], ["CLR", "☀"], ["SKC", "☀"], ["NSC", "☀"],
        ["FEW", "🌤"], ["SCT", "⛅"], ["BKN", "☁"], ["OVC", "☁"], ["OVX", "☁"],
        ["", "🌤"]
    ];
    cover.forEach(([code, glyph]) => {
        assert.equal(Weather.aviationWeatherIcon({ cover: code }), glyph, code);
    });
});

test("each MET.no wet symbol maps to rain on its own", () => {
    const Weather = loadWeather();

    ["rain", "lightrain", "drizzle", "sleet", "heavysleet"].forEach((symbol) => {
        assert.equal(Weather.metNoIcon(symbol), "🌧", symbol);
    });
    assert.equal(Weather.metNoIcon("lightsnow"), "🌨");
    assert.equal(Weather.metNoIcon("rainshowers_day"), "🌦", "a shower is a shower before it is rain");
});

test("the nearest station wins ties by being first, not last", () => {
    const Weather = loadWeather();
    const place = { latitude: 0, longitude: 0 };
    const stations = [
        { icaoId: "FIRST", lat: 0.5, lon: 0, temp: 10 },
        { icaoId: "SECOND", lat: -0.5, lon: 0, temp: 20 }
    ];

    // equidistant: the list order decides, and it must decide the same way every
    // tick or the panel temperature flickers between two airports
    assert.equal(Weather.aviationWeatherStation(stations, place).icaoId, "FIRST");
});

test("a reading with no text and no error is not remembered as good", () => {
    const Weather = loadWeather();
    const state = new Weather.WeatherDisplayState();
    const seen = [];

    // weather switched off answers ("", "", ""): nothing failed, but there is
    // nothing to keep either — remembering it would resurrect it later as stale
    state.reporter("rome", (text, error) => seen.push([text, error]))("", "", "");
    assert.equal(state.hasReading(), false);

    state.reporter("rome", (text, error) => seen.push([text, error]))(
        "☀ 20°C", "", "Open-Meteo", { condition: "☀", temperatureC: 20 });
    assert.equal(state.hasReading(), true);
});

// The panel kept rendering the last good reading behind a ⚠ glyph for as long
// as the failure lasted — three days offline, and it was still showing a
// temperature from Tuesday. The world-clock rows of the same weather feature
// have always downgraded a reading after two refresh periods.
test("a last-good panel reading expires like the city readings do", () => {
    const Weather = loadWeather();
    let clock = 1000000;
    const state = new Weather.WeatherDisplayState({
        elapsedNow: () => clock,
        staleAfterSeconds: 3600
    });
    const seen = [];
    const report = (text, error) => seen.push([text, error]);

    state.reporter("rome", report)("☀ 20°C", "", "Open-Meteo", { condition: "☀", temperatureC: 20 });
    assert.equal(state.isStale(), false);

    // the network drops: the reading is still the weather, with a marker on it
    clock += 30 * 60 * 1000;
    state.reporter("rome", report)("", "Weather service unavailable", "");
    assert.deepEqual(seen.at(-1), ["☀ 20°C", "Weather service unavailable"]);

    // ...and two periods later it is not the weather any more
    clock += 40 * 60 * 1000;
    assert.equal(state.isStale(), true);
    state.reporter("rome", report)("", "Weather service unavailable", "");
    assert.deepEqual(seen.at(-1), ["", "Weather service unavailable"],
        "a reading nobody has refreshed for two periods is not a reading");

    // and a fresh reading revives it
    state.reporter("rome", report)("🌧 12°C", "", "Open-Meteo", { condition: "🌧", temperatureC: 12 });
    assert.equal(state.isStale(), false);

    // A monotonic clock should never regress. If an injected or broken port
    // does, fail stale instead of treating a negative age as indefinitely fresh.
    clock--;
    assert.equal(state.isStale(), true);
});

test("a fresh scheduler is inactive and carries the shipped retry period", () => {
    const Weather = loadWeather();
    const scheduled = [];
    const scheduler = new Weather.WeatherRefreshScheduler({
        scheduleTimer: (seconds, callback) => (scheduled.push(seconds), callback, 7)
    });

    // retry() on an unstarted scheduler must not arm anything: a failure before
    // the first schedule() is a failure of a refresh nobody asked for
    scheduler.retry(() => {});
    assert.deepEqual(scheduled, []);

    scheduler.schedule({ showWeather: true, location: "Rome" }, () => {});
    scheduler.retry(() => {});
    assert.ok(scheduled.at(-1) >= 30 && scheduled.at(-1) < 60,
        "the first retry waits the shipped 30s plus jitter, not the refresh period");
});

test("a reading that arrived with an error is never remembered as the good one", () => {
    const Weather = loadWeather();
    const state = new Weather.WeatherDisplayState();

    // the provider chain can hand back both a text and an error (a stale value
    // passed through). Storing that as the last good reading would make the
    // failure permanent: every later error would replay it as if it were fresh.
    state.reporter("rome", () => {})("☀ 20°C", Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE, "Open-Meteo");

    assert.equal(state.hasReading(), false);
});

test("a retry with nothing armed does not cancel timer zero", () => {
    const Weather = loadWeather();
    const removed = [];
    let nextId = 10;
    const scheduler = new Weather.WeatherRefreshScheduler({
        scheduleTimer: () => nextId++,
        removeTimer: (id) => removed.push(id)
    });

    scheduler.schedule({ showWeather: true, location: "Rome" }, () => {});
    const armed = removed.length;

    scheduler.retry(() => {});
    // GLib source ids start at 1; handing 0 to source_remove is a warning at
    // best and someone else's timer at worst
    assert.equal(removed.length, armed, "nothing was armed, so nothing is cancelled");

    scheduler.retry(() => {});
    assert.ok(removed.at(-1) > 0, "the second retry cancels the first, by its real id");
});

test("a destroyed provider drops a geocode even when its generation still matches", () => {
    const Weather = loadWeather();
    let isCurrent = null;
    const provider = new Weather.WeatherProvider({
        httpGetJson() {},
        locationResolver: {
            resolve(location, current) {
                isCurrent = current;   // hold the answer; nothing calls back yet
            }
        },
        forecastResolver: { refresh() {} },
        scheduler: {
            schedule: (settings, refresh) => refresh(),
            queue: () => {},
            stop() {},
            succeeded() {},
            retry() {}
        }
    });

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, () => {});
    assert.equal(isCurrent(), true, "the request is current while the applet lives");

    provider.destroy();
    // the generation is untouched by destroy(): only the destroyed flag says the
    // applet is gone, and a late geocode must not touch a torn-down applet
    assert.equal(isCurrent(), false, "a destroyed applet is never current");
});

// The error path has always known that a reading belongs to the place it was
// fetched for — it only re-shows the last good reading when the key still
// matches. The success path had no equivalent: hasReading() was still true after
// a location change, so schedule() did not reserve the panel slot with the "…"
// placeholder, and the panel went on presenting Lisbon's temperature as Tokyo's
// for as long as the new provider chains took to walk.
test("changing the location does not leave the old city's temperature on the panel", () => {
    const Weather = loadWeather();
    const pending = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            pending.push({ url, callback });
        },
        scheduler: {
            timerId: 0,
            schedule: (settings, refresh) => refresh(),
            queue: (settings, schedule) => schedule(settings),
            stop() {}, succeeded() {}, retry() {}, retriesExhausted: () => false
        }
    });

    const reported = [];
    const lisbon = { showWeather: true, location: "Lisbon", units: "si" };
    provider.schedule(lisbon, (reading, error, _name, pending) =>
        reported.push([pending ? Weather.WEATHER_PENDING_TEXT : shown(reading, "si"), error]));

    // the geocode, then the forecast
    pending.shift().callback({ results: [{ latitude: 38, longitude: -9, population: 567000 }] });
    pending.shift().callback({ current_weather: { temperature: 21, weathercode: 0 } });

    assert.deepEqual(reported.at(-1), ["☀ 21°C", ""], "Lisbon is on the panel");
    reported.length = 0;

    // the user types a new location
    const tokyo = { showWeather: true, location: "Tokyo", units: "si" };
    provider.schedule(tokyo, (reading, error, _name, pending) =>
        reported.push([pending ? Weather.WEATHER_PENDING_TEXT : shown(reading, "si"), error]));

    assert.deepEqual(reported[0], ["…", ""],
        "the panel says it is fetching, instead of showing Lisbon's temperature as Tokyo's");
    assert.equal(provider._display_state.hasReading(), false);

    pending.shift().callback({ results: [{ latitude: 35, longitude: 139, population: 14000000 }] });
    pending.shift().callback({ current_weather: { temperature: 30, weathercode: 0 } });

    assert.deepEqual(reported.at(-1), ["☀ 30°C", ""]);
});

test("a reading survives a refresh of the same place, and a change of place forgets it", () => {
    const Weather = loadWeather();
    const state = new Weather.WeatherDisplayState({ now: () => 1000 });
    const reports = [];
    state.reporter("lisbon", (...args) => reports.push(args))(
        { condition: "☀", temperatureC: 21 }, "", "Open-Meteo");

    assert.equal(state.hasReading(), true);

    // the same place, asked again: the reading is still that place's
    state.forgetUnless("lisbon");
    assert.equal(state.hasReading(), true);

    // Lisbon's temperature is not Tokyo's, and showing it as Tokyo's is the bug
    // this key exists to prevent
    state.forgetUnless("tokyo");
    assert.equal(state.hasReading(), false);
});

// The key used to carry the units as well, because the stored reading was
// rendered text: "21°C" was a different reading from "70°F", so switching the
// unit threw the reading away, re-geocoded and refetched. The record is Celsius
// and unit-free — the presenter converts — so the same reading serves both.
test("switching between Celsius and Fahrenheit re-renders instead of refetching", () => {
    const Weather = loadWeather();
    const requests = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            requests.push(url);
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 38, longitude: -9, population: 567000 }] });
            } else {
                callback({ current_weather: { weathercode: 0, temperature: 21 } });
            }
        }
    });

    const readings = [];
    provider.refresh({ showWeather: true, location: "Lisbon", units: "metric" },
        (reading) => readings.push(reading));
    provider.refresh({ showWeather: true, location: "Lisbon", units: "imperial" },
        (reading) => readings.push(reading));

    assert.equal(provider._display_state.hasReading(), true,
        "the units changed, not the place: the reading still stands");
    assert.deepEqual(readings[1], { condition: "☀", temperatureC: 21 },
        "and it is the same unit-free record, whatever the panel is about to render it as");
    assert.equal(shown(readings[1], "metric"), "☀ 21°C");
    assert.equal(shown(readings[1], "imperial"), "☀ 70°F");
});
