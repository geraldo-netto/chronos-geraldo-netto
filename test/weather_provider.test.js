const {
    assert, test, fs, path,
    shown, immediateNominatimQueue, loadWeather
} = require("./helpers/weatherFixture");

test("weather cache and debounce defaults stay at their shipped bounds", () => {
    const Weather = loadWeather();

    assert.equal(Weather.MAX_GEOCODE_CACHE_ENTRIES, 16);
    assert.equal(Weather.WEATHER_DEBOUNCE_MS, 750);
});

test("enabled weather without a location reports the setup hint", () => {
    const Weather = loadWeather();
    const provider = new Weather.WeatherProvider({ httpGetJson() { throw new Error("no request expected"); } });
    const reports = [];
    provider.refresh({ showWeather: true, location: "  ", units: "si" },
        (reading, error, name) => reports.push({ reading, error, name }));
    assert.deepEqual(reports, [{ reading: null, error: Weather.WEATHER_ERRORS.NO_LOCATION, name: "" }]);

    provider.refresh({ showWeather: false, location: "", units: "si" },
        (reading, error, name) => reports.push({ reading, error, name }));
    assert.deepEqual(reports[1], { reading: null, error: "", name: "" }, "disabled stays silent");
});

test("the first fetch shows a pending placeholder, later ones do not", () => {
    const Weather = loadWeather();
    let respond = null;
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 41.9, longitude: 12.5, population: 2873000 }] });
            } else {
                respond = () => callback({ current_weather: { weathercode: 2, temperature: 12.6 } });
            }
        }
    });

    const reports = [];
    const settings = { showWeather: true, location: "Rome", units: "si" };
    // pending is a state now, not the "…" string: nothing downstream has to
    // compare a display string against a placeholder to know a fetch is running
    provider.schedule(settings, (reading, error, _name, pending) =>
        reports.push({ reading, error, pending }));
    assert.deepEqual(reports[0], { reading: null, error: "", pending: true }, "placeholder first");
    respond();
    assert.deepEqual(reports[1].reading, { condition: "⛅", temperatureC: 12.6 });
    assert.ok(!reports[1].pending);

    provider.schedule(settings, (reading, error, _name, pending) =>
        reports.push({ reading, error, pending }));
    respond();
    assert.equal(reports.length, 3, "no placeholder once a reading exists");
    assert.ok(!reports[2].pending);
});

test("transient failures keep reporting the last good reading", () => {
    const Weather = loadWeather();
    let fail = false;
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            if (fail) {
                callback(null);
            } else if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 41.9, longitude: 12.5, population: 2873000 }] });
            } else {
                callback({ current_weather: { weathercode: 2, temperature: 12.6 } });
            }
        }
    });

    const reports = [];
    const settings = { showWeather: true, location: "Rome", units: "si" };
    provider.refresh(settings, (reading, error, name) => reports.push({ reading, error, name }));
    assert.deepEqual(reports[0].reading, { condition: "⛅", temperatureC: 12.6 });
    assert.equal(reports[0].error, "");

    fail = true;
    provider.refresh(settings, (reading, error, name) => reports.push({ reading, error, name }));
    assert.deepEqual(reports[1].reading, reports[0].reading, "stale reading retained");
    assert.ok(reports[1].error.length > 0, "error still reported");

    // a different location must not inherit the stale reading
    provider.refresh({ showWeather: true, location: "Oslo", units: "si" },
        (reading, error, name) => reports.push({ reading, error, name }));
    assert.equal(reports[2].reading, null);
});

test("weather display state owns stale reading reporting", () => {
    const Weather = loadWeather();
    const state = new Weather.WeatherDisplayState();
    const reports = [];
    const reportRome = state.reporter("rome|si", (text, error, name) => reports.push({ text, error, name }));
    const reportOslo = state.reporter("oslo|si", (text, error, name) => reports.push({ text, error, name }));

    assert.equal(state.hasReading(), false);
    reportRome("☀ 20°C", "", Weather.WEATHER_PROVIDER_NAMES.OPEN_METEO, { condition: "☀", temperatureC: 20 });
    assert.equal(state.hasReading(), true);
    reportRome("", Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE, "");
    reportOslo("", Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE, "");

    assert.deepEqual(reports, [
        { text: "☀ 20°C", error: "", name: Weather.WEATHER_PROVIDER_NAMES.OPEN_METEO },
        {
            text: "☀ 20°C",
            error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE,
            name: Weather.WEATHER_PROVIDER_NAMES.OPEN_METEO
        },
        { text: "", error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE, name: "" }
    ]);
});

test("every readout glyph has a word for it", () => {
    const Weather = loadWeather();

    // both providers funnel into the same eight glyphs, so every glyph either
    // side can emit must map to a condition word for a screen reader
    const codes = [0, 2, 45, 61, 71, 80, 95, 85];
    for (const code of codes) {
        const reading = Weather.weatherReading({ weathercode: code, temperature: 12 });
        assert.notEqual(Weather.WEATHER_CONDITIONS[reading.condition], undefined,
            `the glyph for code ${code} has no condition`);
    }

    for (const symbol of ["clearsky_day", "fair_day", "partlycloudy_day", "cloudy", "fog",
        "snow", "rainshowers_day", "rain", "thunderstorm", "unknown"]) {
        assert.notEqual(Weather.WEATHER_CONDITIONS[Weather.metNoIcon(symbol)], undefined,
            `the MET Norway glyph for ${symbol} has no condition`);
    }

    assert.equal(Weather.WEATHER_CONDITIONS["☀"], "Clear");
    assert.equal(Weather.WEATHER_CONDITIONS["🌤"], "Fair");
});

test("a provider whose refresh fails schedules its own retry", () => {
    const Weather = loadWeather();
    const timers = [];
    let nextId = 900;
    const provider = new Weather.WeatherProvider({
        nominatimQueue: immediateNominatimQueue(),
        retrySeconds: 30,
        scheduleTimer(seconds, callback) {
            timers.push({ seconds, callback });
            return nextId++;
        },
        removeTimer() {},
        httpGetJson(url, callback) {
            // every provider is down
            callback(null);
        }
    });

    const reports = [];
    provider.schedule({ showWeather: true, location: "Rome", units: "si" },
        (text, error) => reports.push([text, error]));

    assert.ok(provider._scheduler.timerId > 0, "the normal refresh timer is armed");
    assert.ok(provider._scheduler.retryId > 0, "and a retry is queued after the failure");
    // the delay is the 30s backoff plus up to 30s of jitter, so it is a range
    const retryTimer = timers.find((timer) => timer.seconds >= 30 && timer.seconds < 60);
    assert.ok(retryTimer, "the retry runs long before the next refresh period");
    assert.ok(reports.some(([, error]) => error === Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE));

    // firing the retry re-runs the refresh
    const before = reports.length;
    retryTimer.callback();
    assert.ok(reports.length > before);

    provider.destroy();
    assert.equal(provider._scheduler.retryId, 0, "destroy clears the retry");
});

test("panel weather settles an unknown place but retries a service outage", () => {
    const Weather = loadWeather();
    const calls = [];
    const scheduler = {
        retry() {
            calls.push("retry");
        },
        succeeded() {
            calls.push("succeeded");
        },
        stop() {}
    };
    const settings = { showWeather: true, location: "Atlantis", units: "si" };

    for (const error of [
        Weather.WEATHER_ERRORS.LOCATION_NOT_FOUND,
        Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE
    ]) {
        const provider = new Weather.WeatherProvider({
            scheduler,
            locationResolver: {
                forget() {},
                resolve(_location, _isCurrent, callback) {
                    callback(null, error);
                }
            },
            httpGetJson() {}
        });
        provider.refresh(settings, () => {});
    }

    assert.deepEqual(calls, ["succeeded", "retry"]);
});

test("the geocode cache is bounded and re-resolves an edited location", () => {
    const Weather = loadWeather();
    let geocodes = 0;
    const resolver = new Weather.WeatherLocationResolver({
        nominatimQueue: immediateNominatimQueue(),
        maxCacheEntries: 3,
        httpGetJson(url, callback) {
            geocodes++;
            callback({ results: [{ latitude: 1, longitude: 2, population: 1000 }] });
        }
    });

    const resolve = (location) => resolver.resolve(location, () => true, () => {});

    for (const city of ["rome", "oslo", "paris", "lisbon"]) {
        resolve(city);
    }

    assert.equal(resolver.cache.size, 3, "the map does not grow with every string typed");
    assert.equal(resolver.cache.has("rome"), false, "the oldest entry is evicted");

    // an ambiguous name that resolved wrong must not stay pinned
    const before = geocodes;
    resolve("paris");
    assert.equal(geocodes, before, "a hit is still served from the cache");

    resolver.forget("Paris");
    resolve("paris");
    assert.equal(geocodes, before + 1, "forget() forces a re-resolve");
});

test("a failed refresh retries sooner than the refresh period, with backoff", () => {
    const Weather = loadWeather();
    const schedules = [];
    let nextId = 500;
    const scheduler = new Weather.WeatherRefreshScheduler({
        refreshSeconds: 1800,
        retrySeconds: 30,
        // no jitter, so the backoff itself is what the numbers below show
        random: () => 0,
        scheduleTimer(seconds, callback) {
            schedules.push({ seconds, callback });
            return nextId++;
        },
        removeTimer() {}
    });

    scheduler.schedule({ showWeather: true, location: "Rome", units: "si" }, () => {});
    assert.equal(schedules[0].seconds, 1800, "the normal period");

    // the network was down: each failure retries sooner than the period
    scheduler.retry(() => {});
    assert.equal(schedules[1].seconds, 30);
    scheduler.retry(() => {});
    assert.equal(schedules[2].seconds, 60);
    scheduler.retry(() => {});
    assert.equal(schedules[3].seconds, 120);

    // once it works again, the next failure starts over from the short delay
    scheduler.succeeded();
    scheduler.retry(() => {});
    assert.equal(schedules.at(-1).seconds, 30);
});

// The attempt counter is clamped: Math.min(attempts + 1, MAX_RETRY_ATTEMPTS).
// Replacing that with a bare increment left the whole suite green — the delay is
// capped at the refresh period either way, so the clamp's effect is invisible in
// the schedule. What it actually bounds is the counter, and the counter is what
// retriesExhausted() reads: a permanently-offline laptop retries every half hour
// for the life of the session, and an unbounded count is the exponent Math.pow is
// raised to on every one of them.
test("the retry counter stops at the ceiling instead of counting up forever", () => {
    const Weather = loadWeather();
    const { MAX_RETRY_ATTEMPTS } = Weather;
    const schedules = [];
    const scheduler = new Weather.WeatherRefreshScheduler({
        refreshSeconds: 1800,
        retrySeconds: 30,
        random: () => 0,
        scheduleTimer(seconds) {
            schedules.push(seconds);
            return schedules.length;
        },
        removeTimer() {}
    });
    scheduler.schedule({ showWeather: true, location: "Rome", units: "si" }, () => {});

    assert.equal(scheduler.retriesExhausted(), false, "a healthy scheduler has not given up");

    // the ceiling, exactly: one retry short of it is not exhausted
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS - 1; attempt++) {
        scheduler.retry(() => {});
    }
    assert.equal(scheduler._retry_attempts, MAX_RETRY_ATTEMPTS - 1);
    assert.equal(scheduler.retriesExhausted(), false, "one short of the ceiling");

    scheduler.retry(() => {});
    assert.equal(scheduler._retry_attempts, MAX_RETRY_ATTEMPTS);
    assert.equal(scheduler.retriesExhausted(), true, "and at it");

    // an outage that never clears: fifty more failures do not push the counter
    // past the ceiling, and the delay stays pinned at the refresh period
    for (let attempt = 0; attempt < 50; attempt++) {
        scheduler.retry(() => {});
    }
    assert.equal(scheduler._retry_attempts, MAX_RETRY_ATTEMPTS,
        "the counter is clamped, not incremented");
    assert.equal(schedules.at(-1), 1800, "the backoff is still capped at the refresh period");

    // and one success puts it all back
    scheduler.succeeded();
    assert.equal(scheduler._retry_attempts, 0);
    assert.equal(scheduler.retriesExhausted(), false);
});

test("the retry is jittered, so every machine does not come back at once", () => {
    const Weather = loadWeather();
    const schedules = [];
    const jitter = [0, 0.5, 0.999];
    let draw = 0;
    const scheduler = new Weather.WeatherRefreshScheduler({
        refreshSeconds: 1800,
        retrySeconds: 30,
        random: () => jitter[draw++ % jitter.length],
        scheduleTimer(seconds, callback) {
            schedules.push({ seconds, callback });
            return schedules.length;
        },
        removeTimer() {}
    });

    scheduler.schedule({ showWeather: true, location: "Rome", units: "si" }, () => {});

    // a router reboot takes out every applet on the network at the same
    // moment; without jitter they all retry on the identical schedule and hit
    // the provider in lockstep
    scheduler.retry(() => {});
    scheduler.retry(() => {});
    scheduler.retry(() => {});

    assert.equal(schedules[1].seconds, 30, "backoff 30 plus no jitter");
    assert.equal(schedules[2].seconds, 75, "backoff 60 plus 15");
    assert.equal(schedules[3].seconds, 149, "backoff 120 plus 29");

    // the backoff itself never runs past the normal period, however long the
    // outage — the jitter rides on top of it, and only on top of it
    for (let attempt = 0; attempt < 20; attempt++) {
        scheduler.retry(() => {});
    }
    assert.ok(schedules.every((entry) => entry.seconds <= 1800 + 30),
        "the backoff is capped at the refresh period, plus at most one jitter draw");

    // and at that ceiling the delays still differ: capping the *total* would
    // truncate the spread to zero exactly when every applet on the network is
    // retrying at once, which is when the spread is the whole point
    const saturated = schedules.slice(-6).map((entry) => entry.seconds);
    assert.ok(new Set(saturated).size > 1,
        "a saturated backoff still spreads the retries out");
});

test("a retry is not scheduled when weather is off", () => {
    const Weather = loadWeather();
    const schedules = [];
    const scheduler = new Weather.WeatherRefreshScheduler({
        scheduleTimer(seconds, callback) {
            schedules.push({ seconds, callback });
            return 1;
        },
        removeTimer() {}
    });

    scheduler.schedule({ showWeather: false, location: "", units: "si" }, () => {});
    scheduler.retry(() => {});

    assert.deepEqual(schedules, [], "nothing is scheduled while weather is disabled");
});

test("weather refresh scheduler owns timer and debounce lifecycles", () => {
    const Weather = loadWeather();
    const removed = [];
    const refreshes = [];
    const schedules = [];
    const debounces = [];
    const scheduler = new Weather.WeatherRefreshScheduler({
        refreshSeconds: 9,
        debounceMs: 17,
        scheduleTimer(seconds, callback) {
            schedules.push({ seconds, callback });
            return 301;
        },
        scheduleDebounceTimer(milliseconds, callback) {
            debounces.push({ milliseconds, callback });
            return debounces.length + 400;
        },
        removeTimer(id) {
            removed.push(id);
        }
    });

    scheduler.schedule({ showWeather: true, location: "Rome", units: "si" }, () => refreshes.push("schedule"));
    assert.equal(scheduler.timerId, 301);
    assert.equal(schedules[0].seconds, 9);
    assert.equal(schedules[0].callback(), true);

    scheduler.queue({ showWeather: true, location: "Oslo", units: "si" }, (settings) => {
        refreshes.push(settings.location);
    });
    scheduler.queue({ showWeather: true, location: "Paris", units: "si" }, (settings) => {
        refreshes.push(settings.location);
    });
    assert.equal(scheduler.debounceId, 402);
    assert.deepEqual(removed, [401]);
    assert.equal(debounces[1].milliseconds, 17);
    assert.equal(debounces[1].callback(), false);
    assert.equal(scheduler.debounceId, 0);

    scheduler.schedule({ showWeather: false, location: "Rome", units: "si" }, () => refreshes.push("disabled"));
    assert.equal(scheduler.timerId, 0);
    scheduler.stop();

    assert.deepEqual(refreshes, ["schedule", "schedule", "Paris", "disabled"]);
    assert.deepEqual(removed, [401, 301]);
});

test("stopping the scheduler drops a debounce that never fired", () => {
    const Weather = loadWeather();
    const removed = [];
    const scheduled = [];
    const scheduler = new Weather.WeatherRefreshScheduler({
        scheduleTimer() {
            return 11;
        },
        scheduleDebounceTimer(milliseconds, callback) {
            scheduled.push({ milliseconds, callback });
            return 22;
        },
        removeTimer(id) {
            removed.push(id);
        }
    });

    // the user is still typing in the location entry when the applet is removed
    // from the panel: the pending keystroke must not fire into a dead applet
    scheduler.queue({ showWeather: true, location: "Rom", units: "si" }, () => {
        throw new Error("a stopped scheduler must not schedule");
    });
    assert.equal(scheduler.debounceId, 22);

    scheduler.stop();

    assert.deepEqual(removed, [22]);
    assert.equal(scheduler.debounceId, 0);
    assert.equal(scheduled.length, 1, "the queued refresh never ran");
});

test("a geocode answered after a newer refresh or a destroy is dropped", () => {
    const Weather = loadWeather();
    const pending = [];
    const values = [];
    const forecasts = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson() {},
        // a resolver that answers from its own cache never consults isCurrent,
        // so the provider has to guard the callback itself
        locationResolver: {
            forget() {},
            resolve(location, isCurrent, callback) {
                pending.push(() => callback({ latitude: 1, longitude: 2 }, ""));
            }
        },
        forecastResolver: {
            refresh(place, isCurrent, callback) {
                forecasts.push(place);
                callback({ condition: "☀", temperatureC: 20 }, "", "Open-Meteo");
            }
        }
    });
    const settings = { showWeather: true, location: "Rome", units: "si" };

    provider.refresh(settings, (text) => values.push(text));
    provider.refresh({ showWeather: true, location: "Paris", units: "si" },
        (text) => values.push(text));

    // the first lookup lands after the user's edit already started a newer one
    pending[0]();
    assert.deepEqual(forecasts, [], "the superseded lookup fetches no forecast");
    assert.deepEqual(values, []);

    provider.destroy();
    pending[1]();
    assert.deepEqual(forecasts, []);
    assert.deepEqual(values, []);
});

test("weather location resolver owns geocode fallback and cache", () => {
    const Weather = loadWeather();
    const requests = [];
    let current = true;
    const resolver = new Weather.WeatherLocationResolver({
        nominatimQueue: immediateNominatimQueue(),
        httpGetJson(url, callback, options = {}) {
            requests.push({ url, options });
            if (url.includes("geocoding-api")) {
                callback(null);
                return;
            }
            callback([{ lat: "41.9", lon: "12.5", display_name: "Rome, Italy" }]);
        }
    });
    const resolved = [];

    resolver.resolve(" Rome ", () => current, (place, error) => {
        resolved.push({ place, error });
    });
    resolver.resolve("rome", () => current, (place, error) => {
        resolved.push({ place, error });
    });

    assert.equal(resolved.length, 2);
    assert.equal(resolved[0].place.name, "Rome, Italy");
    assert.equal(resolved[0].error, "");
    assert.equal(resolved[1].place, resolved[0].place);
    // the cache key is the resolver's own business — the port hands back a place
    // and an error, which is what both production callbacks take. That the two
    // spellings share one key is asserted through the cache and the request count.
    assert.equal(resolver.cache.get("rome"), resolved[0].place);
    assert.equal(requests.filter((request) => request.url.includes("geocoding-api")).length, 1);
    assert.equal(requests.filter((request) => request.url.includes("nominatim.openstreetmap.org")).length, 1);
    assert.equal(
        requests[1].options.headers["User-Agent"],
        Weather.WEATHER_USER_AGENT
    );

    const staleRequests = [];
    const staleResolver = new Weather.WeatherLocationResolver({
        nominatimQueue: immediateNominatimQueue(),
        httpGetJson(url, callback) {
            staleRequests.push({ url, callback });
        }
    });
    const staleResults = [];
    current = false;
    staleResolver.resolve("Paris", () => current, (...args) => staleResults.push(args));
    staleRequests[0].callback({ results: [{ latitude: 1, longitude: 2 }] });
    assert.deepEqual(staleResults, []);

    const unresolved = [];
    const originalLog = global.log;
    const exhaustedLogs = [];
    global.log = (message) => exhaustedLogs.push(message);
    const unresolvedResolver = new Weather.WeatherLocationResolver({
        nominatimQueue: immediateNominatimQueue(),
        httpGetJson(_url, callback) {
            callback({ results: [] });
        }
    });
    try {
        unresolvedResolver.resolve("Nowhere", () => true, (place, error) => unresolved.push({ place, error }));
    } finally {
        global.log = originalLog;
    }
    assert.deepEqual(unresolved, [{ place: null, error: Weather.WEATHER_ERRORS.LOCATION_NOT_FOUND }]);
    assert.equal(exhaustedLogs.at(-1), "all weather geocode providers failed");

    // the failover line names the provider; a nameless one would be named by
    // its URL, and a geocode URL carries the place the user typed
    assert.deepEqual(
        exhaustedLogs.filter((message) => message.includes("trying next provider")),
        ["provider Open-Meteo failed; trying next provider"]);
    assert.ok(exhaustedLogs.every((message) => !message.includes("Nowhere")),
        "the searched-for location never reaches the log");

    const rejected = [];
    unresolvedResolver.resolve(
        "x".repeat(Weather.MAX_WEATHER_LOCATION_LENGTH + 1),
        () => true,
        (place, error) => rejected.push({ place, error }));
    assert.deepEqual(rejected, [{
        place: null,
        error: Weather.WEATHER_ERRORS.LOCATION_NOT_FOUND
    }]);
});

test("Nominatim requests are single-flight and start at least one second apart", () => {
    const Weather = loadWeather();
    let now = 0;
    const timers = [];
    const starts = [];
    const releases = [];
    const queue = new Weather.NominatimRequestQueue({
        now: () => now,
        schedule(delay, callback) {
            timers.push({ delay, callback });
            return timers.length;
        }
    });

    queue.enqueue((release) => {
        starts.push(now);
        releases.push(release);
    });
    queue.enqueue((release) => {
        starts.push(now);
        releases.push(release);
    });

    assert.deepEqual(starts, [0], "only one request is in flight");
    releases.shift()();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, Weather.NOMINATIM_MIN_INTERVAL_MS);

    now = Weather.NOMINATIM_MIN_INTERVAL_MS;
    assert.equal(timers.shift().callback(), false);
    assert.deepEqual(starts, [0, Weather.NOMINATIM_MIN_INTERVAL_MS]);
});

test("panel and city resolvers share the process-wide Nominatim queue", () => {
    const Weather = loadWeather();
    const panelResolver = new Weather.WeatherLocationResolver({ httpGetJson() {} });
    const cityResolver = new Weather.WeatherLocationResolver({ httpGetJson() {} });

    assert.equal(panelResolver._nominatim_queue, cityResolver._nominatim_queue);
});

test("a tiny exact Open-Meteo namesake falls through to Nominatim", () => {
    const Weather = loadWeather();
    const requests = [];
    const resolver = new Weather.WeatherLocationResolver({
        nominatimQueue: immediateNominatimQueue(),
        httpGetJson(url, callback, options = {}) {
            requests.push({ url, options });
            if (url.includes("geocoding-api")) {
                // This is the significant shape of the live English `Genova`
                // response: the only exact spelling is a thirty-person hamlet.
                callback({ results: [
                    { name: "Génova", country: "Guatemala", population: 3744,
                        latitude: 14.61667, longitude: -91.83333 },
                    { name: "Geneva", country: "United States", population: 6447,
                        latitude: 41.80505, longitude: -80.94815 },
                    { name: "Genova", country: "Italy", admin1: "Veneto", population: 30,
                        latitude: 45.21604, longitude: 11.87211 }
                ] });
                return;
            }
            callback([{ lat: "44.4072600", lon: "8.9338624", display_name: "Genova, Liguria, Italia" }]);
        }
    });
    let resolved = null;

    resolver.resolve("Genova", () => true, (place, error) => {
        resolved = { place, error };
    });

    assert.equal(requests.length, 2, "the weak primary answer does not stop the queue");
    assert.equal(requests[1].options.headers["User-Agent"], Weather.WEATHER_USER_AGENT);
    assert.deepEqual(resolved, {
        place: { name: "Genova, Liguria, Italia", latitude: 44.40726, longitude: 8.9338624 },
        error: ""
    });
});

test("weather forecast resolver owns fallback and last-success ordering", () => {
    const Weather = loadWeather();
    const requests = [];
    const resolver = new Weather.WeatherForecastResolver({
        httpGetJson(url, callback, options = {}) {
            requests.push({ url, options });
            if (url.includes("api.open-meteo.com")) {
                callback(null);
                return;
            }
            callback({
                properties: {
                    timeseries: [{
                        data: {
                            instant: {
                                details: {
                                    air_temperature: 7.4
                                }
                            },
                            next_1_hours: {
                                summary: {
                                    symbol_code: "snow"
                                }
                            }
                        }
                    }]
                }
            });
        }
    });
    const values = [];

    resolver.refresh({ latitude: 1, longitude: 2 }, () => true, (reading, error, providerName) => {
        values.push({ text: shown(reading, "si"), error, providerName });
    });
    resolver.refresh({ latitude: 1, longitude: 2 }, () => true, (reading, error, providerName) => {
        values.push({ text: shown(reading, "si"), error, providerName });
    });

    assert.deepEqual(values, [
        { text: "🌨 7°C", error: "", providerName: Weather.WEATHER_PROVIDER_NAMES.MET_NO },
        { text: "🌨 7°C", error: "", providerName: Weather.WEATHER_PROVIDER_NAMES.MET_NO }
    ]);
    assert.equal(resolver.lastProvider, Weather.WEATHER_PROVIDER_NAMES.MET_NO);
    // Open-Meteo, then the METAR service, then MET.no
    assert.equal(requests[0].url.includes("api.open-meteo.com"), true);
    assert.equal(requests[1].url.includes("aviationweather.gov"), true);
    assert.equal(requests[2].url.includes("api.met.no"), true);
    assert.equal(requests[2].options.headers["User-Agent"], Weather.WEATHER_USER_AGENT);
    // the second refresh starts from the provider that last answered
    assert.equal(requests[3].url.includes("api.met.no"), true);

    const staleRequests = [];
    const staleResolver = new Weather.WeatherForecastResolver({
        httpGetJson(url, callback) {
            staleRequests.push({ url, callback });
        }
    });
    const staleValues = [];
    staleResolver.refresh({ latitude: 1, longitude: 2 }, () => false, (...args) => staleValues.push(args));
    staleRequests[0].callback({ current_weather: { weathercode: 1, temperature: 20 } });
    assert.deepEqual(staleValues, []);

    const failed = [];
    const originalLog = global.log;
    const exhaustedLogs = [];
    global.log = (message) => exhaustedLogs.push(message);
    const failedResolver = new Weather.WeatherForecastResolver({
        httpGetJson(_url, callback) {
            callback(null);
        }
    });
    try {
        failedResolver.refresh({ latitude: 1, longitude: 2 }, () => true, (reading, error, providerName) => {
            failed.push({ text: shown(reading, "si"), error, providerName });
        });
    } finally {
        global.log = originalLog;
    }
    assert.deepEqual(failed, [{
        text: "",
        error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE,
        providerName: ""
    }]);
    assert.equal(exhaustedLogs.at(-1), "all weather forecast providers failed");
});

test("shared reading repository coalesces one remote read per refresh period", () => {
    const Weather = loadWeather();
    const pending = [];
    const requests = [];
    const reports = [];
    let now = 10000;
    const repository = new Weather.WeatherReadingRepository({
        now: () => now,
        cacheSeconds: Weather.REFRESH_SECONDS,
        httpGetJson(url, callback) {
            requests.push(url);
            pending.push({ url, callback });
        }
    });

    repository.refresh("Rome", () => true,
        (reading, error, provider) => reports.push(["panel", shown(reading), error, provider]));
    repository.refresh(" rome ", () => true,
        (reading, error, provider) => reports.push(["city", shown(reading), error, provider]));

    assert.equal(requests.length, 1, "the overlapping consumers share one geocode");
    pending.shift().callback({
        results: [{ latitude: 41.9, longitude: 12.5, population: 2873000 }]
    });
    assert.equal(requests.length, 2, "and one forecast");
    pending.shift().callback({ current_weather: { weathercode: 1, temperature: 18 } });
    assert.deepEqual(reports.map((row) => row.slice(0, 3)), [
        ["panel", "⛅ 18°C", ""],
        ["city", "⛅ 18°C", ""]
    ]);

    repository.refresh("ROME", () => true,
        (reading) => reports.push(["cached", shown(reading)]));
    repository.refresh("Rome", () => false,
        () => reports.push(["stale consumer must not be called"]));
    assert.equal(requests.length, 2, "a synchronous follower uses the period cache");
    assert.deepEqual(reports.at(-1), ["cached", "⛅ 18°C"]);

    now += Weather.REFRESH_SECONDS * 1000;
    repository.refresh("Rome", () => true,
        (reading) => reports.push(["next-period", shown(reading)]));
    assert.equal(requests.length, 3, "the next period performs one new forecast");
    assert.ok(requests.at(-1).includes("/v1/forecast"), "the geocode cache is still shared");
    pending.shift().callback({ current_weather: { weathercode: 2, temperature: 19 } });
    assert.deepEqual(reports.at(-1), ["next-period", "⛅ 19°C"]);

    const invalid = [];
    repository.refresh(" ", () => true, (...args) => invalid.push(args));
    assert.equal(invalid[0][1], Weather.WEATHER_ERRORS.LOCATION_NOT_FOUND);

    repository.destroy();
    repository.refresh("Rome", () => true, () => reports.push(["destroyed"]));
    assert.equal(requests.length, 3, "destroyed repositories start no work");
});

test("refresh geocodes, fetches forecast, and reports formatted text", () => {
    const Weather = loadWeather();
    const requests = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            requests.push(url);
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 41.9, longitude: 12.5, population: 2873000 }] });
            } else {
                callback({ current_weather: { weathercode: 2, temperature: 12.6 } });
            }
        }
    });

    let text = null;
    let providerName = null;
    provider.refresh({ showWeather: true, location: "Rome", units: "metric" }, (reading, _error, servedBy) => {
        text = shown(reading, "metric");
        providerName = servedBy;
    });

    assert.equal(text, "⛅ 13°C");
    assert.equal(providerName, Weather.WEATHER_PROVIDER_NAMES.OPEN_METEO);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].includes("name=Rome"));
    assert.ok(requests[1].includes("latitude=41.9"));
});

test("refresh returns empty text when disabled, blank, or unresolved", () => {
    const Weather = loadWeather();
    let calls = 0;
    const provider = new Weather.WeatherProvider({
        nominatimQueue: immediateNominatimQueue(),
        httpGetJson(_url, callback) {
            calls++;
            callback({ results: [] });
        }
    });
    const values = [];

    provider.refresh({ showWeather: false, location: "Rome", units: "metric" }, (reading) => values.push(shown(reading)));
    provider.refresh({ showWeather: true, location: "   ", units: "metric" }, (reading) => values.push(shown(reading)));
    provider.refresh({ showWeather: true, location: "Nowhere", units: "metric" }, (reading) => values.push(shown(reading)));

    assert.deepEqual(values, ["", "", ""]);
    assert.equal(calls, 2);
});

test("refresh reports weather failures with user-visible status", () => {
    const Weather = loadWeather();
    const geocodeFailures = [];
    const provider = new Weather.WeatherProvider({
        nominatimQueue: immediateNominatimQueue(),
        httpGetJson(_url, callback) {
            callback(null);
        }
    });

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, (reading, error) => {
        geocodeFailures.push({ text: shown(reading, "si"), error });
    });

    assert.deepEqual(geocodeFailures, [{ text: "", error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE }]);
    assert.equal(Weather.WEATHER_ERROR_MARKER, "⚠");

    const unresolved = [];
    const unresolvedProvider = new Weather.WeatherProvider({
        nominatimQueue: immediateNominatimQueue(),
        httpGetJson(_url, callback) {
            callback({ results: [] });
        }
    });
    unresolvedProvider.refresh({ showWeather: true, location: "Nowhere", units: "si" }, (reading, error) => {
        unresolved.push({ text: shown(reading, "si"), error });
    });
    assert.deepEqual(unresolved, [{ text: "", error: Weather.WEATHER_ERRORS.LOCATION_NOT_FOUND }]);

    const forecastFailures = [];
    const forecastProvider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 1, longitude: 2, population: 1000 }] });
            } else {
                callback(null);
            }
        }
    });
    forecastProvider.refresh({ showWeather: true, location: "Rome", units: "si" }, (reading, error) => {
        forecastFailures.push({ reading, error });
    });
    // an exhausted forecast chain hands back null, the same "no reading" every
    // other path on this port uses — it used to be the empty string, alone
    assert.deepEqual(forecastFailures,
        [{ reading: null, error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE }]);
});

test("refresh falls back to MET.no forecast with required user agent", () => {
    const Weather = loadWeather();
    const requests = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback, options = {}) {
            requests.push({ url, options });
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 1, longitude: 2, population: 1000 }] });
                return;
            }
            if (url.includes("api.open-meteo.com")) {
                callback(null);
                return;
            }
            callback({
                properties: {
                    timeseries: [{
                        data: {
                            instant: {
                                details: {
                                    air_temperature: 10.4
                                }
                            },
                            next_1_hours: {
                                summary: {
                                    symbol_code: "rain"
                                }
                            }
                        }
                    }]
                }
            });
        }
    });
    let result = null;

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, (reading, error, providerName) => {
        result = { text: shown(reading, "si"), error, providerName };
    });

    assert.deepEqual(result, { text: "🌧 10°C", error: "", providerName: Weather.WEATHER_PROVIDER_NAMES.MET_NO });
    assert.equal(provider._forecast_resolver.lastProvider, Weather.WEATHER_PROVIDER_NAMES.MET_NO);
    assert.equal(requests.length, 4);
    assert.ok(requests[1].url.includes("api.open-meteo.com"));
    assert.ok(requests[2].url.includes("aviationweather.gov"));
    assert.ok(requests[3].url.includes("api.met.no"));
    assert.equal(requests[3].options.headers["User-Agent"], Weather.WEATHER_USER_AGENT);

    provider.refresh({ showWeather: true, location: "rome", units: "si" }, (reading, error, providerName) => {
        result = { text: shown(reading, "si"), error, providerName };
    });

    assert.deepEqual(result, { text: "🌧 10°C", error: "", providerName: Weather.WEATHER_PROVIDER_NAMES.MET_NO });
    assert.equal(requests.length, 5);
    assert.ok(requests[4].url.includes("api.met.no"));
});

// the backends were an array built inside a private method, so adding one meant
// editing that method - while the failover machinery it feeds has always been
// shared with the holiday chain
test("a forecast backend can be added without editing the resolver", () => {
    const Weather = loadWeather();
    const asked = [];

    assert.deepEqual(Weather.FORECAST_PROVIDERS.map((provider) => provider.name),
        [Weather.WEATHER_PROVIDER_NAMES.OPEN_METEO,
            Weather.WEATHER_PROVIDER_NAMES.AVIATION_WEATHER,
            Weather.WEATHER_PROVIDER_NAMES.MET_NO],
        "the shipped chain, in the order it is tried");

    // The shipped providers are data — a url, a normalize, and the request
    // options they need — so a third party's provider takes exactly the same
    // path the built-ins do. Each entry used to be a thunk into a private method
    // of this resolver, which meant adding a provider was an edit to the class
    // as well, and the built-ins did *not* use the plugin path.
    for (const provider of Weather.FORECAST_PROVIDERS) {
        assert.equal(typeof provider.url, "function", `${provider.name} names its endpoint`);
        assert.equal(typeof provider.normalize, "function", `${provider.name} reads its own answer`);
    }

    const resolver = new Weather.WeatherForecastResolver({
        httpGetJson(url, callback, options) {
            asked.push({ url, options });
            callback(url === "https://local.example/now" ?
                { degrees: 21 } : null);
        },
        providers: [
            {
                name: "Broken",
                url: () => "https://broken.example/now",
                normalize: () => null
            },
            {
                name: "Local station",
                url: (place) => `https://local.example/now?lat=${place.latitude}`.split("?")[0],
                // a provider returns a unit-free record; the resolver renders it
                normalize: (data) => (data ? { condition: "☀", temperatureC: data.degrees } : null),
                options: { headers: { "User-Agent": "test" } }
            }
        ]
    });

    let result = null;
    resolver.refresh({ latitude: 1, longitude: 2 }, () => true,
        (reading, error, provider) => {
            result = { text: shown(reading, "si"), error, provider };
        });

    assert.deepEqual(asked.map((call) => call.url),
        ["https://broken.example/now", "https://local.example/now"]);
    // the provider's own request options reach the HTTP helper unchanged
    assert.deepEqual(asked.at(-1).options, { headers: { "User-Agent": "test" } });
    assert.deepEqual(result, { text: "☀ 21°C", error: "", provider: "Local station" });
    assert.equal(resolver.lastProvider, "Local station",
        "and the one that worked is tried first next time");
});

test("a forecast with no temperature fails over instead of reading NaN", () => {
    const Weather = loadWeather();
    const asked = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            asked.push(url);
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 1, longitude: 2, population: 1000 }] });
                return;
            }
            // Open-Meteo answers, but the station has no reading
            if (url.includes("api.open-meteo.com")) {
                callback({ current_weather: { weathercode: 0, temperature: null } });
                return;
            }
            callback([{ icaoId: "LIRA", lat: 1, lon: 2, temp: 14, cover: "BKN" }]);
        }
    });
    let result = null;

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, (reading, error, providerName) => {
        result = { text: shown(reading, "si"), error, providerName };
    });

    assert.ok(asked.some((url) => url.includes("aviationweather.gov")),
        "the chain moves on rather than believing an empty reading");
    assert.equal(result.error, "");
    assert.doesNotMatch(result.text, /NaN/);
    assert.equal(result.providerName, Weather.WEATHER_PROVIDER_NAMES.AVIATION_WEATHER);
});

test("refresh falls back to Nominatim geocode with required user agent", () => {
    const Weather = loadWeather();
    const requests = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback, options = {}) {
            requests.push({ url, options });

            if (url.includes("geocoding-api")) {
                callback(null);
                return;
            }
            if (url.includes("nominatim.openstreetmap.org")) {
                callback([{ lat: "41.9", lon: "12.5", display_name: "Rome, Italy" }]);
                return;
            }

            callback({ current_weather: { weathercode: 1, temperature: 15.4 } });
        }
    });
    const values = [];

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, (reading, error, providerName) => {
        values.push({ text: shown(reading, "si"), error, providerName });
    });
    provider.refresh({ showWeather: true, location: " rome ", units: "si" }, (reading, error, providerName) => {
        values.push({ text: shown(reading, "si"), error, providerName });
    });

    assert.deepEqual(values, [
        { text: "⛅ 15°C", error: "", providerName: Weather.WEATHER_PROVIDER_NAMES.OPEN_METEO },
        { text: "⛅ 15°C", error: "", providerName: Weather.WEATHER_PROVIDER_NAMES.OPEN_METEO }
    ]);
    assert.equal(requests.filter((request) => request.url.includes("geocoding-api")).length, 1);
    assert.equal(requests.filter((request) => request.url.includes("nominatim.openstreetmap.org")).length, 1);
    assert.equal(requests.filter((request) => request.url.includes("/v1/forecast")).length, 2);
    assert.equal(
        requests.find((request) => request.url.includes("nominatim.openstreetmap.org")).options.headers["User-Agent"],
        Weather.WEATHER_USER_AGENT
    );
});

test("schedule refreshes immediately, repeats, and can stop the timer", () => {
    const Weather = loadWeather();
    const removed = [];
    let scheduled = null;
    const provider = new Weather.WeatherProvider({
        refreshSeconds: 15,
        httpGetJson(url, callback) {
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 1, longitude: 2, population: 1000 }] });
            } else {
                callback({ current_weather: { weathercode: 80, temperature: 5 } });
            }
        },
        scheduleTimer(seconds, callback) {
            scheduled = { seconds, callback };
            return 42;
        },
        removeTimer(id) {
            removed.push(id);
        }
    });
    const values = [];

    provider.schedule({ showWeather: true, location: "Oslo", units: "metric" },
        (reading, _error, _name, pending) =>
            values.push(pending ? Weather.WEATHER_PENDING_TEXT : shown(reading)));
    assert.equal(scheduled.seconds, 15);
    assert.deepEqual(values, [Weather.WEATHER_PENDING_TEXT, "🌦 5°C"]);

    const repeatResult = scheduled.callback();
    assert.equal(repeatResult, true);
    assert.deepEqual(values, [Weather.WEATHER_PENDING_TEXT, "🌦 5°C", "🌦 5°C"]);

    provider.stop();
    assert.deepEqual(removed, [42]);
});

test("schedule skips the repeat timer while weather is disabled or blank", () => {
    const Weather = loadWeather();
    let scheduled = 0;
    const provider = new Weather.WeatherProvider({
        httpGetJson() {
            throw new Error("no request expected while disabled");
        },
        scheduleTimer() {
            scheduled++;
            return 42;
        },
        removeTimer() {}
    });

    // disabled or unconfigured weather previously kept a 30-minute timer
    // alive that re-ran the empty-status callback forever
    for (const settings of [
        { showWeather: false, location: "Oslo", units: "metric" },
        { showWeather: true, location: "", units: "metric" },
        { showWeather: true, location: "   ", units: "metric" },
        {
            showWeather: true,
            location: "🎉".repeat(Weather.MAX_WEATHER_LOCATION_LENGTH + 1),
            units: "metric"
        }
    ]) {
        const values = [];
        provider.schedule(settings, (reading, error, name) => values.push([reading, error, name]));
        const expectedError = settings.showWeather ? "Set a weather location" : "";
        assert.deepEqual(values, [[null, expectedError, ""]], JSON.stringify(settings));
        assert.equal(scheduled, 0, JSON.stringify(settings));
        assert.equal(provider._scheduler.timerId, 0, JSON.stringify(settings));
    }
});

test("destroy aborts the session and suppresses pending weather callbacks", () => {
    const Weather = loadWeather({
        Session: class {
            constructor() {
                this.aborted = false;
            }

            abort() {
                this.aborted = true;
            }

            send_async() {}
        }
    });
    const pending = [];
    const values = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            pending.push({ url, callback });
        }
    });

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, (reading) => values.push(shown(reading)));
    provider.destroy();

    pending[0].callback({ results: [{ latitude: 1, longitude: 2 }] });
    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, (reading) => values.push(shown(reading)));

    // nothing asked for a session — httpGetJson is injected — so there is none
    // to abort, and destroy() must not trip over that
    assert.equal(provider._session.created, null);
    assert.deepEqual(values, []);
    assert.equal(pending.length, 1);

    provider.schedule({ showWeather: true, location: "Rome", units: "si" }, (reading) => values.push(shown(reading)));
    provider.queue({ showWeather: true, location: "Rome", units: "si" }, (reading) => values.push(shown(reading)));
    assert.deepEqual(values, []);
    assert.equal(pending.length, 1);
});

// REGRESSION: queue() dropped the cached geocode unconditionally, and it is
// reached from the one handler that fires for *every* weather key — so switching
// °C to °F re-issued the geocoding request and the forecast request. The reading
// record is unit-free on purpose and _staleKey() deliberately excludes the units
// ("the same reading serves both"): a unit change is a re-render, not a refetch.
// On an Open-Meteo outage the geocode falls through to Nominatim, whose usage
// policy is one request a second.
test("changing the units re-renders; it does not re-resolve the location", () => {
    const Weather = loadWeather();
    const urls = [];
    const timers = [];
    const provider = new Weather.WeatherProvider({
        debounceMs: 0,
        httpGetJson(url, callback) {
            urls.push(url);
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 1, longitude: 2, population: 1000 }] });
            } else {
                callback({ current_weather: { weathercode: 0, temperature: 8 } });
            }
        },
        scheduleDebounceTimer(_ms, callback) { timers.push(callback); return timers.length; },
        scheduleTimer() { return 42; },
        removeTimer() {}
    });

    const settled = () => {
        while (timers.length) {
            timers.shift()();
        }
    };

    // Startup reaches schedule() directly from on_applet_added_to_panel. It
    // must record the location key just like the debounced settings path does.
    provider.schedule({ showWeather: true, location: "Rome", units: "si" }, () => {});
    const afterFirst = urls.length;
    assert.ok(urls.some((url) => url.includes("geocoding-api")), "the first read resolves the city");

    urls.length = 0;
    provider.queue({ showWeather: true, location: "Rome", units: "imperial" }, () => {});
    settled();
    assert.deepEqual(urls.filter((url) => url.includes("geocoding-api")), [],
        "the same city is not geocoded again for a unit change");

    // and a location the user actually edited is re-resolved
    urls.length = 0;
    provider.queue({ showWeather: true, location: "Lisbon", units: "imperial" }, () => {});
    settled();
    assert.ok(urls.some((url) => url.includes("geocoding-api")), "a new city is");
    assert.ok(afterFirst > 0);
});

test("queue debounces weather refreshes before scheduling", () => {
    const Weather = loadWeather();
    const removed = [];
    const scheduledDebounces = [];
    const scheduledRefreshes = [];
    let refreshes = 0;
    const provider = new Weather.WeatherProvider({
        debounceMs: 25,
        httpGetJson(url, callback) {
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 1, longitude: 2, population: 1000 }] });
            } else {
                callback({ current_weather: { weathercode: 0, temperature: 8 } });
            }
        },
        scheduleDebounceTimer(milliseconds, callback) {
            scheduledDebounces.push({ milliseconds, callback });
            return scheduledDebounces.length + 100;
        },
        scheduleTimer(seconds, callback) {
            scheduledRefreshes.push({ seconds, callback });
            return 42;
        },
        removeTimer(id) {
            removed.push(id);
        }
    });

    provider.queue({ showWeather: true, location: "Ro", units: "si" }, () => refreshes++);
    provider.queue({ showWeather: true, location: "Rome", units: "si" }, () => refreshes++);

    assert.deepEqual(removed, [101]);
    assert.equal(scheduledDebounces.length, 2);
    assert.equal(scheduledDebounces[1].milliseconds, 25);
    assert.equal(scheduledRefreshes.length, 0);
    assert.equal(refreshes, 0);

    assert.equal(scheduledDebounces[1].callback(), false);
    assert.equal(scheduledRefreshes.length, 1);
    assert.equal(refreshes, 2, "pending placeholder plus the reading");

    provider.stop();
    assert.deepEqual(removed, [101, 42]);
});

test("refresh ignores stale geocode and forecast callbacks", () => {
    const Weather = loadWeather();
    const pending = [];
    const values = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            pending.push({ url, callback });
        }
    });

    provider.refresh({ showWeather: true, location: "Older", units: "si" }, (reading) => values.push(shown(reading)));
    assert.equal(pending.length, 1);

    provider.refresh({ showWeather: true, location: "Newer", units: "si" }, (reading) => values.push(shown(reading)));
    assert.equal(pending.length, 2);

    pending[0].callback({ results: [{ latitude: 1, longitude: 1, population: 1000 }] });
    assert.equal(pending.length, 2);
    assert.deepEqual(values, []);

    pending[1].callback({ results: [{ latitude: 2, longitude: 2, population: 1000 }] });
    assert.equal(pending.length, 3);

    provider.refresh({ showWeather: true, location: "Newest", units: "si" }, (reading) => values.push(shown(reading)));
    assert.equal(pending.length, 4);
    pending[3].callback({ results: [{ latitude: 3, longitude: 3, population: 1000 }] });
    assert.equal(pending.length, 5);

    pending[4].callback({ current_weather: { weathercode: 2, temperature: 15 } });
    pending[2].callback({ current_weather: { weathercode: 0, temperature: 99 } });

    assert.deepEqual(values, ["⛅ 15°C"]);
});

test("stop abandons an in-flight weather refresh", () => {
    const Weather = loadWeather();
    const pending = [];
    const values = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            pending.push({ url, callback });
        }
    });

    provider.refresh({ showWeather: true, location: "Rome", units: "si" },
        (reading) => values.push(shown(reading)));
    assert.equal(pending.length, 1);

    provider.stop();
    pending[0].callback({ results: [{ latitude: 1, longitude: 1, population: 1000 }] });

    assert.equal(pending.length, 1, "a stopped geocode starts no forecast request");
    assert.deepEqual(values, [], "a stopped refresh reports no late value");
});

test("refresh caches geocode results by normalized location", () => {
    const Weather = loadWeather();
    const requests = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            requests.push(url);
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 41.9, longitude: 12.5, population: 2873000 }] });
            } else {
                callback({ current_weather: { weathercode: 3, temperature: 10 } });
            }
        }
    });
    const values = [];

    provider.refresh({ showWeather: true, location: " Rome ", units: "si" }, (reading) => values.push(shown(reading)));
    provider.refresh({ showWeather: true, location: "rome", units: "si" }, (reading) => values.push(shown(reading)));

    assert.deepEqual(values, ["⛅ 10°C", "⛅ 10°C"]);
    assert.equal(provider._location_resolver.cache.has("rome"), true);
    assert.equal(requests.filter((url) => url.includes("geocoding-api")).length, 1);
    assert.equal(requests.filter((url) => url.includes("/v1/forecast")).length, 2);
});

test("applets bind only weather settings to debounced refresh", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "applet.js"), "utf8");
    const lifecycle = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "appletLifecycle.js"), "utf8");
    const facade = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "settingsFacade.js"), "utf8");
    // the weather keys are bound as one group, so a general settings change
    // cannot drag a weather refetch along with it
    assert.match(facade, /var WEATHER_KEYS = \[(?: \/\/ NOSONAR[^\n]*)?\s*\["show-weather", "show_weather"\],\s*\["weather-units", "weather_units"\]/);
    // ...and the location travels with them, mirrored rather than bound: its
    // widget makes its schema type "custom", which Cinnamon's bind() refuses
    assert.match(facade, /var CUSTOM_WEATHER_KEYS = \[(?: \/\/ NOSONAR[^\n]*)?\s*\[WEATHER_LOCATION_KEY, "weather_location"\]/);
    assert.match(lifecycle, /bindWeatherKeys\(applet, this\.handlers\.onWeatherSettingsChanged\)/);

    const generalSettingsChanged = source.match(/_onSettingsChanged\(\) \{([\s\S]*?)\n {4}\}/);
    assert.ok(generalSettingsChanged);
    assert.doesNotMatch(generalSettingsChanged[1], /_scheduleWeatherRefresh|_queueWeatherRefresh/);
});

test("applets schedule weather once when added to a panel", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "applet.js"), "utf8");
    const panelAdded = source.match(/on_applet_added_to_panel\(\) \{([\s\S]*?)\n {4}\}/);
    assert.ok(panelAdded);
    assert.equal((panelAdded[1].match(/this\._scheduleWeatherRefresh\(\);/g) || []).length, 1);

    const generalSettingsChanged = source.match(/_onSettingsChanged\(\) \{([\s\S]*?)\n {4}\}/);
    assert.ok(generalSettingsChanged);
    assert.doesNotMatch(generalSettingsChanged[1], /_scheduleWeatherRefresh/);
});

test("applets refresh weather when the system resumes", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "applet.js"), "utf8");
    const lifecycle = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "appletLifecycle.js"), "utf8");
    assert.match(lifecycle, /"PrepareForSleep"/);
    assert.match(lifecycle, /if \(!sleeping\) \{\s*context\.onResume\(\);/);

    const onResume = source.match(/_onResume\(\) \{([\s\S]*?)\n {4}\}/);
    assert.ok(onResume);
    assert.match(onResume[1], /this\._updateClockAndDate\(\);/);
    assert.match(onResume[1], /this\._scheduleWeatherRefresh\(\{ force: true \}\);/);
});
