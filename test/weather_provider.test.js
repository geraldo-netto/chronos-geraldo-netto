const {
    assert, test, fs, path,
    shown, immediateNominatimQueue, loadWeather
} = require("./helpers/weatherFixture");
const { URL } = require("node:url");

test("weather cache and debounce defaults stay at their shipped bounds", () => {
    const Weather = loadWeather();

    assert.equal(Weather.MAX_GEOCODE_CACHE_ENTRIES, 16);
    assert.equal(Weather.WEATHER_DEBOUNCE_MS, 750);
});

test("the location resolver injects its message language into geocoding", () => {
    const Weather = loadWeather();
    const requests = [];
    const resolver = new Weather.WeatherLocationResolver({
        language: () => "it",
        httpGetJson(url, callback) {
            requests.push(url);
            callback({ results: [{
                name: "Genova", country: "Italia",
                latitude: 44.40726, longitude: 8.9338624,
                population: 558745
            }] });
        }
    });

    resolver.resolve("Genova", () => true, () => {});

    assert.match(requests[0], /[?&]language=it(?:&|$)/);
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

// T708: at login the applet raced NetworkManager and burned its first refresh
// on DNS errors, then waited out a blind backoff. Offline is consulted before
// dispatch: nothing goes out, no retry is armed — the network monitor's flip
// is the retry — and the state says "no network" instead of blaming the
// weather service.
test("an offline panel refresh dispatches nothing and arms no retry", () => {
    const Weather = loadWeather();
    let online = false;
    const scheduler = {
        retried: 0,
        successes: 0,
        stop() {},
        schedule() {},
        queue() {},
        retry() { this.retried++; },
        succeeded() { this.successes++; }
    };
    const provider = new Weather.WeatherProvider({
        isOnline: () => online,
        scheduler,
        httpGetJson(url, callback) {
            if (!online) {
                throw new Error("no request may leave an offline host");
            }
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 38.7, longitude: -9.1, population: 505000 }] });
            } else {
                callback({ current_weather: { weathercode: 0, temperature: 21.5 } });
            }
        }
    });

    const reports = [];
    const settings = { showWeather: true, location: "Lisboa", units: "si" };
    provider.refresh(settings, (reading, error) => reports.push({ reading, error }));

    assert.deepEqual(reports, [{ reading: null, error: Weather.WEATHER_ERRORS.OFFLINE }]);
    assert.equal(scheduler.retried, 0, "the monitor's flip is the retry, not a timer");
    assert.equal(scheduler.successes, 1, "a leftover backoff is cancelled");

    // the network returns: the same provider fetches normally again
    online = true;
    provider.refresh(settings, (reading, error) => reports.push({ reading, error }));
    assert.deepEqual(reports[1],
        { reading: { condition: "☀", temperatureC: 21.5 }, error: "" });
});

test("panel weather counts suspend time before a failed wake refresh", () => {
    const Weather = loadWeather();
    const reading = { condition: "☀", temperatureC: 20 };
    const reports = [];
    let civilNow = 1_000_000;
    const elapsedNow = 2_000_000;
    let fail = false;
    let forecasts = 0;
    const provider = new Weather.WeatherProvider({
        elapsedNow: () => elapsedNow,
        freshnessNow: () => civilNow,
        cacheSeconds: Weather.REFRESH_SECONDS,
        scheduleTimer: () => 1,
        removeTimer() {},
        locationResolver: {
            resolve(_location, _isCurrent, callback) {
                callback({ latitude: 1, longitude: 2 }, "");
            },
            forget() {}
        },
        forecastResolver: {
            refresh(_place, _isCurrent, callback) {
                forecasts++;
                callback(fail ? null : reading,
                    fail ? Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE : "",
                    fail ? "" : Weather.WEATHER_PROVIDER_NAMES.OPEN_METEO);
            }
        }
    });
    const settings = { showWeather: true, location: "Rome", units: "si" };

    provider.schedule(settings, (...args) => reports.push(args));
    fail = true;
    civilNow += (Weather.staleAfterSeconds(Weather.REFRESH_SECONDS) + 1) * 1000;
    provider.schedule(settings, (...args) => reports.push(args));

    assert.equal(forecasts, 2,
        "a suspend-aged repository entry cannot satisfy the wake refresh");
    assert.equal(reports.at(-1)[0], null,
        "a failed wake refresh cannot revive the pre-suspend reading");
    assert.equal(reports.at(-1)[1], Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE);
    assert.equal(elapsedNow, 2_000_000, "request-pacing time did not advance during sleep");
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
        "snow", "rainshowers_day", "rain", "thunderstorm"]) {
        assert.notEqual(Weather.WEATHER_CONDITIONS[Weather.metNoIcon(symbol)], undefined,
            `the MET Norway glyph for ${symbol} has no condition`);
    }

    assert.equal(Weather.WEATHER_CONDITIONS["☀"], "Clear");
    assert.equal(Weather.WEATHER_CONDITIONS["🌤"], "Fair");

    // ...and a symbol_code the table does not know is not one of them. "fair"
    // is a real met.no symbol, so it cannot double as the answer for an
    // unrecognised one.
    assert.equal(Weather.metNoIcon("unknown"), Weather.WEATHER_UNKNOWN_CONDITION);
    assert.equal(Weather.WEATHER_CONDITIONS[Weather.WEATHER_UNKNOWN_CONDITION], undefined,
        "an undescribed sky names no condition");
});

test("a provider whose refresh fails schedules its own retry", () => {
    const Weather = loadWeather();
    const timers = [];
    let nextId = 900;
    const provider = new Weather.WeatherProvider({
        requestQueue: immediateNominatimQueue(),
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

    // the delay is the 30s backoff plus up to 30s of jitter, so it is a range
    const retryTimer = timers.find((timer) => timer.seconds >= 30 && timer.seconds < 60);
    assert.ok(retryTimer, "the retry runs long before the next refresh period");
    assert.ok(reports.some(([, error]) => error === Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE));

    // firing the retry re-runs the refresh
    const before = reports.length;
    retryTimer.callback();
    assert.ok(reports.length > before);

    provider.destroy();
    // the retry timer is released on destroy: firing it again must not reach
    // a dead provider
    const afterDestroy = reports.length;
    retryTimer.callback();
    assert.equal(reports.length, afterDestroy, "destroy clears the retry");
});

test("panel weather settles an unknown place but retries a service outage", () => {
    const Weather = loadWeather();
    const calls = [];
    const scheduler = {
        retry() {
            calls.push("retry");
            return true;
        },
        succeeded() {
            calls.push("succeeded");
        },
        retriesExhausted() {
            return false;
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

// T949: `retriesExhausted()` exists, its comment says, "so the caller can say so
// once". The city weather said it; the panel discarded the answer to retry()
// and burned its whole eight-attempt budget with nothing anywhere in the log.
test("the panel says once when its retry ladder runs out", () => {
    const Weather = loadWeather();
    const lines = [];
    const originalLog = global.log;
    global.log = (line) => lines.push(line);

    let exhausted = false;
    const scheduler = {
        retry() {
            return !exhausted;
        },
        succeeded() {},
        retriesExhausted() {
            return exhausted;
        },
        stop() {}
    };
    const settings = { showWeather: true, location: "Atlantis", units: "si" };
    const provider = new Weather.WeatherProvider({
        scheduler,
        locationResolver: {
            forget() {},
            resolve(_location, _isCurrent, callback) {
                callback(null, Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE);
            }
        },
        httpGetJson() {}
    });

    try {
        provider.refresh(settings, () => {});
        assert.deepEqual(lines, [], "a retry that was armed is not news");

        exhausted = true;
        provider.refresh(settings, () => {});
        assert.equal(lines.length, 1, "the ceiling is worth exactly one line");
        assert.match(lines[0], /^panel weather: still failing after 8 attempts/,
            "and it says which of the two weather consumers is failing");

        provider.refresh(settings, () => {});
        assert.equal(lines.length, 1, "every later failure is the same news");

        // a recovery makes the next exhaustion news again
        exhausted = false;
        provider.refresh(settings, () => {});
        exhausted = true;
        provider.refresh(settings, () => {});
        assert.equal(lines.length, 2);
    } finally {
        global.log = originalLog;
    }
});

test("the geocode cache is bounded and re-resolves an edited location", () => {
    const Weather = loadWeather();
    let geocodes = 0;
    const resolver = new Weather.WeatherLocationResolver({
        requestQueue: immediateNominatimQueue(),
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

    assert.equal(resolver.placeFor("rome"), null, "the oldest entry is evicted");
    for (const kept of ["oslo", "paris", "lisbon"]) {
        assert.ok(resolver.placeFor(kept), `${kept} is still cached`);
    }

    // an ambiguous name that resolved wrong must not stay pinned
    const before = geocodes;
    resolve("paris");
    assert.equal(geocodes, before, "a hit is still served from the cache");
    assert.deepEqual(resolver.placeFor(" Paris "),
        { name: "", latitude: 1, longitude: 2, timezone: "" },
        "the astronomy feature reads the same normalized geocode cache entry");

    resolver.forget("Paris");
    assert.equal(resolver.placeFor("Paris"), null);
    resolve("paris");
    assert.equal(geocodes, before + 1, "forget() forces a re-resolve");
});

// The bound evicts by Map iteration order, so whether a hit reorders decides
// which entry the bound throws away: without it the eviction drops the place
// asked for most often and keeps a name typed once on the way past.
test("the geocode cache evicts the least recently used place, not the first", () => {
    const Weather = loadWeather();
    let geocodes = 0;
    const resolver = new Weather.WeatherLocationResolver({
        requestQueue: immediateNominatimQueue(),
        maxCacheEntries: 3,
        httpGetJson(url, callback) {
            geocodes++;
            callback({ results: [{ latitude: 1, longitude: 2, population: 1000 }] });
        }
    });
    const resolve = (location) => resolver.resolve(location, () => true, () => {});

    for (const city of ["rome", "oslo", "paris"]) {
        resolve(city);
    }

    // Rome is the panel's location: it is read every refresh, so it is the
    // last thing that should go
    assert.ok(resolver.placeFor("rome"), "and reading it is a use");

    resolve("lisbon");
    assert.ok(resolver.placeFor("rome"), "the place in use survives the bound");
    assert.equal(resolver.placeFor("oslo"), null,
        "the one nothing has touched since is the one evicted");

    // resolve() serves from the cache too, and that is a use as well
    const before = geocodes;
    resolve("paris");
    assert.equal(geocodes, before, "served from the cache");
    resolve("madrid");
    assert.ok(resolver.placeFor("paris"), "a cache-served resolve counts as a use");
    assert.equal(resolver.placeFor("lisbon"), null);
});

test("the panel provider exposes the coordinates resolved for its weather location", () => {
    const Weather = loadWeather();
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            callback(url.includes("geocoding-api") ?
                { results: [{ name: "Rome", latitude: 41.9, longitude: 12.5,
                    timezone: "Europe/Rome", population: 2873000 }] } :
                { current_weather: { weathercode: 0, temperature: 20 } });
        }
    });

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, () => {});
    assert.deepEqual(provider.placeFor(" rome "),
        { name: "Rome", latitude: 41.9, longitude: 12.5, timezone: "Europe/Rome" });
    assert.equal(provider.placeFor("Oslo"), null);

    const bounded = Weather.openMeteoGeocodePlace({ results: [{
        name: "Long Zone", latitude: 1, longitude: 2, population: 1000,
        timezone: "Area/" + "x".repeat(300)
    }] }, "Long Zone");
    assert.equal([...bounded.timezone].length, 255, "provider timezone input is bounded");
});

test("the current observer survives shared geocode-cache eviction", () => {
    const Weather = loadWeather();
    const places = {
        Rome: [41.9, 12.5, "Europe/Rome"],
        Paris: [48.9, 2.3, "Europe/Paris"],
        London: [51.5, -0.1, "Europe/London"]
    };
    let geocodes = 0;
    const httpGetJson = (url, callback) => {
        if (url.includes("geocoding-api")) {
            geocodes++;
            const name = new URL(url).searchParams.get("name");
            const [latitude, longitude, timezone] = places[name];
            callback({ results: [{ name, latitude, longitude, timezone, population: 1000000 }] });
            return;
        }
        callback({ current_weather: { weathercode: 0, temperature: 20 } });
    };
    const resolver = new Weather.WeatherLocationResolver({
        httpGetJson,
        maxCacheEntries: 2
    });
    const repository = new Weather.WeatherReadingRepository({
        httpGetJson,
        locationResolver: resolver,
        cacheSeconds: 1800,
        maxCacheEntries: 8
    });
    const provider = new Weather.WeatherProvider({ readingRepository: repository });

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, () => {});
    assert.equal(repository.placeFor(" "), null);
    assert.deepEqual(repository.placeFor("Rome"), {
        name: "Rome", latitude: 41.9, longitude: 12.5, timezone: "Europe/Rome"
    }, "the observer travels with its cached reading");
    repository.refresh("Paris", () => true, () => {});
    repository.refresh("London", () => true, () => {});
    assert.equal(resolver.placeFor("Rome"), null, "the shared location cache did evict Rome");
    assert.deepEqual(provider.placeFor("Rome"), {
        name: "Rome", latitude: 41.9, longitude: 12.5, timezone: "Europe/Rome"
    });

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, () => {});
    assert.equal(geocodes, 3, "a fresh weather hit needs no repair geocode");
    assert.deepEqual(provider.placeFor("Rome"), {
        name: "Rome", latitude: 41.9, longitude: 12.5, timezone: "Europe/Rome"
    });
});

// Nominatim publishes no timezone and Open-Meteo geocoding refuses anything
// under MIN_TRUSTED_GEOCODE_POPULATION, so a smaller place reached the
// astronomy view with no zone and it silently used the viewer's own — the wrong
// civil day's sunrise for anywhere far east or west. The forecast reply is
// asked with timezone=auto, so it names the point's zone at no extra cost.
test("a place its geocoder could not place in time takes the forecast's zone", () => {
    const Weather = loadWeather();
    const httpGetJson = (url, callback) => {
        if (url.includes("geocoding-api")) {
            // below the trusted floor: Open-Meteo declines and Nominatim answers
            callback({ results: [] });
            return;
        }
        if (url.includes("nominatim")) {
            callback([{
                display_name: "Ushuaia, Tierra del Fuego, Argentina",
                lat: "-54.8", lon: "-68.3", importance: 0.7
            }]);
            return;
        }
        callback({
            timezone: "America/Argentina/Ushuaia",
            current_weather: { weathercode: 0, temperature: 4 }
        });
    };
    const repository = new Weather.WeatherReadingRepository({
        httpGetJson,
        requestQueue: { enqueue: (start) => start() },
        cacheSeconds: 1800
    });

    let observed = null;
    repository.refresh("Ushuaia", () => true, (reading, error, provider, place) => {
        observed = place;
    });

    assert.equal(observed.timezone, "America/Argentina/Ushuaia",
        "the resolved place carries a zone the geocoder never sent");
    assert.equal(repository.placeFor("Ushuaia").timezone, "America/Argentina/Ushuaia",
        "and the cached observer the astronomy view reads carries it too");
});

// T946: the zone is a fact about the place. Riding it on the reading made the
// record - documented as unit-free `{ condition, temperatureC }`, cached and
// handed to presenters - a different shape according to which provider in the
// failover chain answered.
test("the reading record is the same shape whichever provider answered", () => {
    const Weather = loadWeather();
    const readings = [];
    const forecasts = {
        "Ushuaia": {
            timezone: "America/Argentina/Ushuaia",
            current_weather: { weathercode: 0, temperature: 4 }
        }
    };
    const httpGetJson = (url, callback) => {
        if (url.includes("geocoding-api")) {
            callback({ results: [{
                name: "Ushuaia", latitude: -54.8, longitude: -68.3,
                population: 1000000
            }] });
            return;
        }
        callback(forecasts.Ushuaia);
    };
    const repository = new Weather.WeatherReadingRepository({
        httpGetJson,
        requestQueue: { enqueue: (start) => start() },
        cacheSeconds: 1800
    });

    repository.refresh("Ushuaia", () => true, (reading) => readings.push(reading));

    assert.deepEqual(readings, [{ condition: "☀", temperatureC: 4 }]);
    assert.deepEqual(Object.keys(readings[0]).sort(), ["condition", "temperatureC"],
        "the Open-Meteo reading carries no more than the other two providers'");
});

test("a geocoder that named the zone keeps it against a disagreeing forecast", () => {
    const Weather = loadWeather();
    const httpGetJson = (url, callback) => {
        if (url.includes("geocoding-api")) {
            callback({ results: [{
                name: "Rome", latitude: 41.9, longitude: 12.5,
                timezone: "Europe/Rome", population: 2800000
            }] });
            return;
        }
        // the forecast describes a point, not the city: its zone loses
        callback({
            timezone: "Etc/UTC",
            current_weather: { weathercode: 0, temperature: 20 }
        });
    };
    const repository = new Weather.WeatherReadingRepository({
        httpGetJson, cacheSeconds: 1800
    });

    let observed = null;
    repository.refresh("Rome", () => true, (reading, error, provider, place) => {
        observed = place;
    });

    assert.equal(observed.timezone, "Europe/Rome");
    assert.equal(repository.locationResolver.placeFor("Rome").timezone, "Europe/Rome",
        "and the geocode entry is not rewritten behind it");
});

test("a geocoded zone is never overwritten by the forecast's", () => {
    const Weather = loadWeather();
    const place = { name: "Rome", latitude: 41.9, longitude: 12.5, timezone: "Europe/Rome" };

    assert.equal(Weather.placeWithTimezone(place, "Etc/UTC"), place,
        "the geocoder named the place; the forecast only describes a point near it");
    assert.equal(Weather.placeWithTimezone(null, "Etc/UTC"), null);

    const bare = { name: "Ushuaia", latitude: -54.8, longitude: -68.3 };
    assert.equal(Weather.placeWithTimezone(bare, ""), bare, "a failed forecast adds nothing");
    assert.equal(Weather.placeWithTimezone(bare, undefined), bare,
        "and neither does a provider that does not publish zones");
    assert.deepEqual(Weather.placeWithTimezone(bare, "America/Argentina/Ushuaia"),
        {...bare, timezone: "America/Argentina/Ushuaia"});
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
    const armedBeforeCeiling = schedules.length;
    for (let attempt = 0; attempt < 50; attempt++) {
        assert.equal(scheduler.retry(() => {}), false,
            "a spent budget arms nothing");
    }
    assert.equal(scheduler._retry_attempts, MAX_RETRY_ATTEMPTS,
        "the counter is clamped, not incremented");
    assert.equal(schedules.at(-1), 1800, "the backoff is still capped at the refresh period");
    // T704: the chain used to run forever beside the periodic timer, so a
    // persistent outage kept two request streams alive for the whole session
    assert.equal(schedules.length, armedBeforeCeiling,
        "past the ceiling the periodic timer is the only schedule left");

    // and one success puts it all back
    scheduler.succeeded();
    assert.equal(scheduler._retry_attempts, 0);
    assert.equal(scheduler.retriesExhausted(), false);
    assert.equal(scheduler.retry(() => {}), true, "a reset budget arms again");

    // weather switched off refuses too, and says so the same way
    scheduler.stop();
    assert.equal(scheduler.retry(() => {}), false);
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
    assert.equal(debounces.length, 2, "the second keystroke arms a new debounce");
    assert.deepEqual(removed, [401]);
    assert.equal(debounces[1].milliseconds, 17);
    assert.equal(debounces[1].callback(), false);

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
    assert.equal(scheduled.length, 1, "a debounce is armed");

    scheduler.stop();

    assert.deepEqual(removed, [22]);
    scheduler.stop();
    assert.deepEqual(removed, [22], "the id is released, not removed twice");
    assert.equal(scheduled.length, 1, "the queued refresh never ran");
});

// T1046: the same hazard NominatimRequestQueue._scheduleJob spells out. Nothing
// in the timer port's contract says the debounce callback may not run before the
// arming call returns, and `queue` used to write the returned id into the slot
// afterwards regardless — parking a spent id that the next stop() handed to
// GLib.source_remove. The removal of the previous debounce had the same shape:
// the id stayed in the slot while the re-arm ran, so a throw out of the arming
// call left a removed id behind for stop() to remove a second time.
test("a debounce that fires while it is being armed leaves no spent id behind", () => {
    const Weather = loadWeather();
    const removed = [];
    const scheduled = [];
    let armings = 0;
    const scheduler = new Weather.WeatherRefreshScheduler({
        scheduleTimer() {
            return 11;
        },
        scheduleDebounceTimer(milliseconds, callback) {
            armings++;
            scheduled.push({ milliseconds, callback });
            // the port runs the callback synchronously, before it answers
            callback();
            return 900 + armings;
        },
        removeTimer(id) {
            removed.push(id);
        }
    });

    scheduler.queue({ showWeather: true, location: "Rome", units: "si" }, () => {});
    assert.equal(scheduled.length, 1, "a debounce was armed");

    // the callback already ran and released the slot, so there is nothing left
    // to remove — and stop() must not remove a source that has fired
    scheduler.stop();
    assert.deepEqual(removed, [],
        "a debounce that already fired is not removed again");

    // and a re-arm never hands the old, already-removed id back to the port
    const throwing = new Weather.WeatherRefreshScheduler({
        scheduleTimer() {
            return 11;
        },
        scheduleDebounceTimer(milliseconds, callback) {
            armings++;
            if (armings > 2) {
                throw new Error("the debounce timer could not be armed");
            }
            scheduled.push({ milliseconds, callback });
            return 500;
        },
        removeTimer(id) {
            removed.push(id);
        }
    });
    throwing.queue({ showWeather: true, location: "Oslo", units: "si" }, () => {});
    assert.throws(() => throwing.queue(
        { showWeather: true, location: "Oslo2", units: "si" }, () => {}));
    assert.deepEqual(removed, [500], "the first debounce was removed once");
    throwing.stop();
    assert.deepEqual(removed, [500],
        "the removed id is not offered to GLib a second time");
});

// REGRESSION: the periodic timer was armed only after the first refresh
// returned, so a refresh that raised left no timer at all and weather stopped
// updating for the rest of the session — until a resume, a network restore or a
// settings change happened to reschedule it. The applet's _guarded catches and
// logs the throw, which is exactly why the loss was silent.
test("a first refresh that raises still leaves the periodic timer armed", () => {
    const Weather = loadWeather();
    const timers = [];
    const logged = [];
    global.logError = (error) => logged.push(String(error));
    const scheduler = new Weather.WeatherRefreshScheduler({
        scheduleTimer(_seconds, callback) {
            timers.push(callback);
            return timers.length;
        },
        removeTimer() {}
    });

    let refreshes = 0;
    const refresh = () => {
        refreshes++;
        throw new Error("no network stack");
    };
    assert.throws(() => scheduler.schedule(
        { showWeather: true, location: "Rome", units: "si" }, refresh),
    /no network stack/);

    assert.equal(refreshes, 1);
    assert.equal(timers.length, 1, "the periodic timer is armed regardless");
    assert.ok(scheduler.timerId > 0);

    // and it keeps trying: recurring callback failures are reported but cannot
    // remove the source before the next independent recovery opportunity
    assert.equal(timers[0](), true);
    assert.equal(timers[0](), true);
    assert.equal(refreshes, 3, "weather keeps recovering on its own every period");
    assert.deepEqual(logged, [
        "Error: no network stack",
        "Error: no network stack"
    ]);
});

test("retry exceptions end that attempt while periodic recovery remains available", () => {
    const Weather = loadWeather();
    const timers = [];
    const logged = [];
    let loggingBroken = false;
    global.logError = (error) => {
        logged.push(error);
        if (loggingBroken) throw new Error("logger failed");
    };
    const scheduler = new Weather.WeatherRefreshScheduler({
        scheduleTimer: (_seconds, callback) => timers.push(callback),
        removeTimer() {}
    });
    const failure = new Error("refresh failed");
    let failing = false;
    let refreshed = 0;
    const refresh = () => {
        refreshed++;
        if (failing) throw failure;
    };
    scheduler.schedule({ showWeather: true, location: "Rome" }, refresh);
    failing = true;
    scheduler.retry(refresh);
    assert.equal(timers.at(-1)(), false);
    assert.equal(scheduler._retry_id, 0, "the one-shot source is retired");
    assert.equal(timers[0](), true, "the normal period still offers recovery");
    assert.deepEqual(logged, [failure, failure]);

    loggingBroken = true;
    scheduler.retry(refresh);
    assert.equal(timers.at(-1)(), false);
    assert.equal(timers[0](), true);
    failing = false;
    assert.equal(timers[0](), true);
    assert.equal(refreshed, 6);
    scheduler.stop();
});

test("stopped periodic and retry callbacks cannot revive an old schedule", () => {
    const Weather = loadWeather();
    const timers = [];
    const refreshes = [];
    const removed = [];
    const scheduler = new Weather.WeatherRefreshScheduler({
        scheduleTimer(_seconds, callback) {
            timers.push(callback);
            return timers.length;
        },
        removeTimer(id) { removed.push(id); }
    });

    scheduler.schedule({ showWeather: true, location: "Rome", units: "si" },
        () => refreshes.push("refresh"));
    scheduler.retry(() => refreshes.push("retry"));
    const [periodic, retry] = timers;

    scheduler.stop();
    scheduler.schedule({ showWeather: true, location: "Paris", units: "si" },
        () => refreshes.push("new"));
    scheduler.retry(() => refreshes.push("new retry"));
    const replacementId = scheduler._retry_id;

    assert.equal(periodic(), false);
    assert.equal(retry(), false);
    assert.deepEqual(refreshes, ["refresh", "new"],
        "callbacks from the prior generation stay terminal after reactivation");
    assert.equal(scheduler._retry_id, replacementId,
        "an obsolete callback cannot release the current retry source");
    scheduler.stop();
    assert.ok(removed.includes(replacementId));
});

test("replaced or successful retry callbacks cannot release a later retry", () => {
    const Weather = loadWeather();
    const timers = [];
    const removed = [];
    const scheduler = new Weather.WeatherRefreshScheduler({
        scheduleTimer(_seconds, callback) {
            timers.push(callback);
            return timers.length;
        },
        removeTimer(id) { removed.push(id); }
    });
    let refreshes = 0;
    const refresh = () => refreshes++;
    scheduler.schedule({ showWeather: true, location: "Rome" }, refresh);
    scheduler.retry(refresh);
    const replaced = timers.at(-1);
    scheduler.retry(refresh);
    const completed = timers.at(-1);
    const replacementId = scheduler._retry_id;

    assert.equal(replaced(), false);
    assert.equal(scheduler._retry_id, replacementId);
    scheduler.succeeded();
    assert.ok(removed.includes(replacementId));
    scheduler.retry(refresh);
    const nextId = scheduler._retry_id;
    assert.equal(completed(), false);
    assert.equal(scheduler._retry_id, nextId);
    assert.equal(refreshes, 1);
    scheduler.stop();
    assert.ok(removed.includes(nextId));
});

test("rescheduling invalidates an answer before a delayed scheduler refreshes", () => {
    const Weather = loadWeather();
    const scheduled = [];
    const pending = [];
    const forecasts = [];
    const reports = [];
    const provider = new Weather.WeatherProvider({
        scheduler: {
            schedule(_settings, refresh) { scheduled.push(refresh); },
            stop() {},
            succeeded() {}
        },
        locationResolver: {
            forget() {},
            resolve(location, isCurrent, callback) {
                pending.push({ location, isCurrent, callback });
            }
        },
        forecastResolver: {
            refresh(place, _isCurrent, callback) {
                forecasts.push(place.name);
                callback({ condition: "☀", temperatureC: 20 }, "", "test");
            }
        }
    });
    const report = (reading) => reports.push(reading);
    provider.refresh({ showWeather: true, location: "Rome" }, report);
    provider.schedule({ showWeather: true, location: "Paris" }, report);
    assert.equal(pending[0].isCurrent(), false);
    pending[0].callback({ name: "Rome", latitude: 41, longitude: 12 }, "");
    assert.deepEqual(forecasts, []);
    assert.deepEqual(reports, [null], "only the replacement's pending state is reported");

    scheduled[0]();
    assert.equal(pending[1].isCurrent(), true);
    pending[1].callback({ name: "Paris", latitude: 48, longitude: 2 }, "");
    assert.deepEqual(forecasts, ["Paris"]);
    assert.equal(reports.at(-1).temperatureC, 20);
    provider.destroy();
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

// T730: the resolved-place cache had a size bound but no expiry, and `resolve()`
// short-circuited on any hit forever after. The sibling reading cache does
// expire, so a stale *reading* self-corrected within the refresh period while a
// stale *place* never did — one glitched geocode round pinned the wrong
// coordinates for the panel temperature and the astronomy sunrise/sunset for the
// life of the Cinnamon session, and the only production invalidation
// (`_forgetIfLocationChanged`) does nothing when the typed text is unchanged.
test("a wrongly geocoded place expires instead of pinning for the session", () => {
    const Weather = loadWeather();
    let clock = 1000;
    const answers = [
        { results: [{ name: "Rome", latitude: 0, longitude: 0, population: 5000 }] },
        { results: [{ name: "Rome", latitude: 41.9, longitude: 12.5, population: 2800000 }] }
    ];
    let rounds = 0;
    const resolver = new Weather.WeatherLocationResolver({
        requestQueue: immediateNominatimQueue(),
        now: () => clock,
        httpGetJson(_url, callback) {
            rounds++;
            callback(answers.shift());
        }
    });
    const resolve = () => {
        let got = null;
        resolver.resolve("Rome", () => true, (place) => { got = place; });
        return got;
    };

    assert.deepEqual([resolve().latitude, resolve().latitude], [0, 0]);
    assert.equal(rounds, 1, "a fresh entry is not re-fetched");

    // still inside the window: the same wrong answer, no new request
    clock += Weather.GEOCODE_CACHE_MILLISECONDS - 1;
    assert.equal(resolve().latitude, 0);
    assert.equal(rounds, 1);

    // past it: asked again, and the correction lands
    clock += 1;
    assert.equal(resolve().latitude, 41.9);
    assert.equal(rounds, 2);
    assert.equal(resolver.placeFor("Rome").latitude, 41.9);

    // a clock that jumped backwards is not a licence to believe an entry
    // indefinitely either
    clock -= Weather.GEOCODE_CACHE_MILLISECONDS;
    assert.equal(resolver.placeFor("Rome"), null);
});

test("weather location resolver owns geocode fallback and cache", () => {
    const Weather = loadWeather();
    const requests = [];
    let current = true;
    const resolver = new Weather.WeatherLocationResolver({
        requestQueue: immediateNominatimQueue(),
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
    assert.equal(resolver.placeFor("rome"), resolved[0].place);
    assert.equal(requests.filter((request) => request.url.includes("geocoding-api")).length, 1);
    assert.equal(requests.filter((request) => request.url.includes("nominatim.openstreetmap.org")).length, 1);
    assert.equal(
        requests[1].options.headers["User-Agent"],
        Weather.WEATHER_USER_AGENT
    );

    const staleRequests = [];
    const staleResolver = new Weather.WeatherLocationResolver({
        requestQueue: immediateNominatimQueue(),
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
        requestQueue: immediateNominatimQueue(),
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

test("malformed asynchronous geocode ranking falls back and frees shared weather requests", (t) => {
    const Weather = loadWeather();
    const previousLog = global.log;
    t.after(() => { global.log = previousLog; });
    global.log = () => { throw new Error("message logger failed"); };
    t.mock.method(global, "logError", () => { throw new Error("error logger failed"); });
    const requests = [];
    const repository = new Weather.WeatherReadingRepository({
        requestQueue: immediateNominatimQueue(),
        httpGetJson: (url, callback) => requests.push({ url, callback })
    });
    t.after(() => repository.destroy());
    const replies = [];
    const receive = (reading, error) => replies.push({ reading, error });
    const answer = (urlPattern, body) => {
        const request = requests.shift();
        assert.match(request.url, urlPattern);
        request.callback(body);
    };
    repository.refresh("Rome", () => true, receive);
    repository.refresh("Rome", () => true, receive);
    assert.equal(requests.length, 1);

    answer(/geocoding-api/, { results: [{
        name: "Rome", latitude: 1, longitude: 2,
        population: JSON.parse('{"valueOf":null,"toString":null}')
    }] });
    answer(/nominatim/, [{ display_name: "Rome", lat: "3", lon: "4", importance: 0.5 }]);
    answer(/api.open-meteo.com/, { current_weather: { temperature: 12, weathercode: 0 } });
    assert.equal(replies.length, 2);
    assert.ok(replies.every((reply) => reply.reading.temperatureC === 12 && reply.error === ""));
    assert.equal(repository._inflight.size, 0);

    repository.forget("Rome");
    repository.refresh("Rome", () => true, receive);
    answer(/geocoding-api/, { results: [{
        name: "Rome", latitude: 3, longitude: 4, population: 1000
    }] });
    answer(/api.open-meteo.com/, { current_weather: { temperature: 13, weathercode: 0 } });
    assert.equal(replies.at(-1).reading.temperatureC, 13);
    assert.equal(repository._inflight.size, 0);
});

test("asynchronous geocode normalizer exceptions fall back without swallowing consumer errors", (t) => {
    const Weather = loadWeather();
    const requests = [];
    const failure = new Error("invalid provider response");
    const reported = t.mock.method(global, "logError");
    const place = { name: "Rome", latitude: 1, longitude: 2 };
    const resolver = new Weather.WeatherLocationResolver({
        providers: [
            { name: "broken", url: () => "https://broken.test", isValidResponse: () => true,
                normalize: () => { throw failure; } },
            { name: "healthy", url: () => "https://healthy.test", isValidResponse: () => true,
                normalize: () => place }
        ],
        httpGetJson: (_url, callback) => requests.push(callback)
    });
    const results = [];
    resolver.resolve("Rome", () => true, (...args) => results.push(args));
    requests.shift()({});
    requests.shift()({});
    assert.deepEqual(results, [[place, ""]]);
    assert.equal(reported.mock.calls[0].arguments[0], failure);

    const consumerFailure = new Error("consumer failed");
    resolver.forget("Rome");
    resolver.resolve("Rome", () => true, () => { throw consumerFailure; });
    requests.shift()({});
    assert.throws(() => requests.shift()({}), (error) => error === consumerFailure);
    assert.equal(reported.mock.callCount(), 2, "only normalizer errors are diagnosed");
});

test("Nominatim requests are single-flight and use bounded elapsed delays", () => {
    const Weather = loadWeather();
    let now = 0;
    const timers = [];
    const starts = [];
    const releases = [];
    const queue = new Weather.NominatimRequestQueue({
        elapsedNow: () => now,
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

    queue.enqueue((release) => {
        starts.push(now);
        releases.push(release);
    });
    now = 500;
    releases.shift()();
    assert.equal(timers.shift().delay, Weather.NOMINATIM_MIN_INTERVAL_MS,
        "a broken elapsed-time port cannot turn a backward jump into an unbounded wait");
});

// T956: the spacing timer's id used to be written back after `schedule`
// returned, so a scheduler that ran its callback in line parked an already
// spent id in `_timer_id`. `_drain()` reads that slot as "a timer is pending",
// which wedges this module-global queue for every applet instance in the
// process. GLib's timeout_add is asynchronous, so only an injected or future
// in-line scheduler reaches it — but the blast radius is the whole panel.
test("a synchronous scheduler does not wedge the Nominatim queue", () => {
    const Weather = loadWeather();
    let now = 0;
    let scheduled = 0;
    const starts = [];
    const releases = [];
    const queue = new Weather.NominatimRequestQueue({
        elapsedNow: () => now,
        schedule(delay, callback) {
            scheduled++;
            now += delay;
            callback();
            return scheduled;
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
    assert.equal(scheduled, 1, "the second job waits out the interval");
    assert.deepEqual(starts, [0, Weather.NOMINATIM_MIN_INTERVAL_MS],
        "the in-line callback dispatched the queued job");

    // the slot must be free again, or nothing enqueued later ever starts
    releases.shift()();
    queue.enqueue((release) => {
        starts.push(now);
        releases.push(release);
    });
    assert.equal(starts.length, 3,
        "a later job still starts after a synchronous spacing timer");
});

test("a delayed Nominatim dispatch failure completes its provider chain", () => {
    const Weather = loadWeather();
    let now = 0;
    const timers = [];
    const queue = new Weather.NominatimRequestQueue({
        elapsedNow: () => now,
        schedule(delay, callback) {
            timers.push({ delay, callback });
            return timers.length;
        }
    });
    let releaseFirst = null;
    queue.enqueue((release) => { releaseFirst = release; });

    const dispatchError = new Error("Soup construction failed");
    const logged = [];
    global.logError = (error) => logged.push(error);
    const resolver = new Weather.WeatherLocationResolver({
        requestQueue: queue,
        providers: [{
            name: "Nominatim",
            url: () => "https://nominatim.example/search",
            isValidResponse: Array.isArray,
            normalize: () => null,
            requestQueue: queue
        }],
        httpGetJson() {
            throw dispatchError;
        }
    });

    const answers = [];
    resolver.resolve("Rome", () => true, (place, error) => {
        assert.equal(queue._active, false, "the failed slot is released before reporting");
        answers.push({ place, error });
    });
    assert.deepEqual(answers, [], "the geocode is waiting behind the active request");

    releaseFirst();
    now = Weather.NOMINATIM_MIN_INTERVAL_MS;
    assert.equal(timers.shift().callback(), false);
    assert.deepEqual(answers, [{
        place: null,
        error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE
    }]);
    assert.deepEqual(logged, [dispatchError]);
    assert.equal(queue._active, false, "the failed slot was released");
});

test("the Nominatim queue does not reinterpret an exception after release", () => {
    const Weather = loadWeather();
    const queue = new Weather.NominatimRequestQueue();
    let failures = 0;

    assert.throws(() => queue.enqueue((release) => {
        release();
        throw new Error("consumer failed");
    }, () => true, () => { failures++; }), /consumer failed/);

    assert.equal(failures, 0);
    assert.equal(queue._active, false);
});

test("a Nominatim timer failure drops its job and advances the queue", () => {
    const Weather = loadWeather();
    let now = 0;
    let scheduleCalls = 0;
    const timers = [];
    const queue = new Weather.NominatimRequestQueue({
        elapsedNow: () => now,
        schedule(delay, callback) {
            scheduleCalls++;
            if (scheduleCalls === 1) {
                throw new Error("timer registration failed");
            }
            timers.push({ delay, callback });
            return scheduleCalls;
        }
    });
    let releaseFirst = null;
    const starts = [];
    const failures = [];
    queue.enqueue((release) => { releaseFirst = release; });
    queue.enqueue(() => starts.push("replayed"), () => true,
        (error) => failures.push(error.message));
    queue.enqueue(() => starts.push("next"));

    releaseFirst();
    assert.deepEqual(failures, ["timer registration failed"]);
    assert.deepEqual(starts, [], "the failed job was not dispatched");
    assert.equal(queue._jobs.length, 1, "only the later job remains parked");
    assert.equal(timers.length, 1, "queue progress was secured before failure reporting");

    now = Weather.NOMINATIM_MIN_INTERVAL_MS;
    timers[0].callback();
    assert.deepEqual(starts, ["next"], "a later wake cannot replay the failed job");
});

test("a timer failure without a continuation still removes its job", () => {
    const Weather = loadWeather();
    const queue = new Weather.NominatimRequestQueue({
        elapsedNow: () => 0,
        schedule() {
            return 0;
        }
    });
    let releaseFirst = null;
    queue.enqueue((release) => { releaseFirst = release; });
    queue.enqueue(() => assert.fail("failed timer job must not start"));

    assert.throws(() => releaseFirst(), /could not register its spacing timer/);
    assert.deepEqual(queue._jobs, []);
    assert.equal(queue._timer_id, 0);
});

// The spacing timer is armed inside a module-global queue, so no instance owns
// it: without a teardown path it outlives the applet, which is what
// cancelPendingLocaleQueries() exists to prevent for the other module-level
// timers. And because the queue is shared on purpose — one request-per-second
// budget for the whole panel — only the last instance to leave may empty it.
test("the Nominatim queue is released by the last consumer, not the first", () => {
    const Weather = loadWeather();
    let now = 0;
    const timers = [];
    const removed = [];
    const starts = [];
    const queue = new Weather.NominatimRequestQueue({
        elapsedNow: () => now,
        schedule(delay, callback) {
            timers.push({ delay, callback });
            return timers.length;
        },
        removeTimer: (id) => removed.push(id)
    });

    // two applets on the panel, one geocode in flight and one waiting out the
    // one-second interval behind it
    Weather.registerWeatherConsumer();
    Weather.registerWeatherConsumer();
    let release = null;
    queue.enqueue((done) => {
        starts.push("first");
        release = done;
    });
    queue.enqueue((done) => {
        starts.push("second");
        release = done;
    });
    release();
    assert.deepEqual(starts, ["first"]);
    assert.equal(timers.length, 1, "the second is behind the interval");

    // the user removes one of them: the other is still waiting on that job
    Weather.releaseWeatherConsumer(queue);
    assert.deepEqual(removed, [], "the shared timer is not the departing instance's to remove");
    now = Weather.NOMINATIM_MIN_INTERVAL_MS;
    timers[0].callback();
    assert.deepEqual(starts, ["first", "second"],
        "the applet that stayed still gets its geocode");
    release();

    // ...and when the last one goes, the queue goes with it
    queue.enqueue(() => starts.push("third"));
    assert.equal(timers.length, 2, "a third request waits out its own interval");
    Weather.releaseWeatherConsumer(queue);
    assert.deepEqual(removed, [2], "the pending source is removed, not left armed");
    assert.deepEqual(queue._jobs, [], "and the jobs behind it are dropped");

    // A teardown with nobody left to release cannot bank credit against the
    // applets that come after it: without the floor the count goes negative,
    // and the next real teardown then empties a queue two live instances are
    // still using.
    Weather.releaseWeatherConsumer(queue);
    Weather.releaseWeatherConsumer(queue);
    Weather.registerWeatherConsumer();
    Weather.registerWeatherConsumer();

    now += Weather.NOMINATIM_MIN_INTERVAL_MS;
    let lastRelease = null;
    queue.enqueue((done) => {
        starts.push("fourth");
        lastRelease = done;
    });
    lastRelease();
    queue.enqueue(() => starts.push("fifth"));
    const armed = timers.length;
    assert.ok(armed > 0, "a request is waiting out the interval");

    removed.length = 0;
    Weather.releaseWeatherConsumer(queue);
    assert.deepEqual(removed, [],
        "one of two live instances leaving takes nothing with it");
    assert.equal(queue._jobs.length, 1, "and the queued request is still queued");
});

test("last-consumer cancellation retains an in-flight Nominatim slot", () => {
    const Weather = loadWeather();
    let now = 0;
    const starts = [];
    const releases = [];
    const queue = new Weather.NominatimRequestQueue({
        elapsedNow: () => now
    });

    queue.enqueue((release) => {
        starts.push("old");
        releases.push(release);
    });
    queue.cancelPending();

    now = Weather.NOMINATIM_MIN_INTERVAL_MS;
    queue.enqueue((release) => {
        starts.push("new");
        releases.push(release);
    });

    assert.deepEqual(starts, ["old"],
        "teardown cannot release a request that is still running");
    releases.shift()();
    assert.deepEqual(starts, ["old", "new"],
        "the replacement starts when the old owner releases its slot");
    releases.shift()();
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
        requestQueue: immediateNominatimQueue(),
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

// T722: the test above is the case that already worked, because OSM happened to
// rank the right city first. Nominatim was asked for `limit=1` and
// `nominatimGeocodePlace` took data[0] with no name comparison and no use of the
// query at all — it silently dropped the second argument every normalizer is
// handed — so the arbitration Open-Meteo's population floor defers to could not
// happen. Whatever OSM ranked first became the panel temperature and the
// AstronomyView sunrise/sunset, with nothing marking it as a guess.
test("the fallback geocoder arbitrates by the typed name, not by OSM's order", () => {
    const Weather = loadWeather();
    const requests = [];
    const resolver = new Weather.WeatherLocationResolver({
        requestQueue: immediateNominatimQueue(),
        httpGetJson(url, callback) {
            requests.push(url);
            if (url.includes("geocoding-api")) {
                // below the population floor: deliberately left to the fallback
                callback({ results: [
                    { name: "Genova", country: "Italy", population: 30,
                        latitude: 45.21604, longitude: 11.87211 }
                ] });
                return;
            }
            callback([
                // OSM's own order puts a more "important" administrative area
                // and a namesake abroad ahead of the city that was asked for
                { lat: "44.5", lon: "9.0", display_name: "Città Metropolitana di Genova, Italia",
                    importance: 0.72 },
                { lat: "14.61667", lon: "-91.83333", display_name: "Génova, Quetzaltenango, Guatemala",
                    importance: 0.55 },
                { lat: "44.4072600", lon: "8.9338624", display_name: "Genova, Liguria, Italia",
                    importance: 0.51 }
            ]);
        }
    });
    let resolved = null;

    resolver.resolve("Genova", () => true, (place) => { resolved = place; });

    assert.match(requests[1], /limit=10/, "a handful of candidates, not one");
    assert.deepEqual(resolved,
        { name: "Genova, Liguria, Italia", latitude: 44.40726, longitude: 8.9338624 },
        "the exact typed name outranks OSM's importance order");

    // with nothing matching the typed name, importance still decides — refusing
    // outright would leave a legitimately spelled place with no weather at all
    const byImportance = Weather.nominatimGeocodePlace([
        { lat: "1", lon: "1", display_name: "Somewhere Else", importance: 0.1 },
        { lat: "2", lon: "2", display_name: "Another Place", importance: 0.9 }
    ], "Genova");
    assert.equal(byImportance.name, "Another Place");

    // and an accent-only difference is still the place they meant
    const folded = Weather.nominatimGeocodePlace([
        { lat: "1", lon: "1", display_name: "Elsewhere, Nowhere", importance: 0.99 },
        { lat: "2", lon: "2", display_name: "Génova, Liguria, Italia", importance: 0.01 }
    ], "Genova");
    assert.match(folded.name, /^Génova/);
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
        freshnessNow: () => now,
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
    pending.shift().callback({ current_weather: { weathercode: 2, temperature: 18 } });
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

test("shared reading cache expires entries and evicts the least recently used", () => {
    const Weather = loadWeather();
    let now = 1000;
    let deferPlaces = false;
    const pendingPlaces = [];
    const locationResolver = {
        resolve(location, _isCurrent, callback) {
            if (deferPlaces) {
                pendingPlaces.push(callback);
                return;
            }
            callback({ name: location, latitude: 1, longitude: 2 }, "");
        },
        forget() {}
    };
    const repository = new Weather.WeatherReadingRepository({
        freshnessNow: () => now,
        cacheSeconds: 10,
        maxCacheEntries: 3,
        locationResolver,
        forecastResolver: {
            refresh(place, _isCurrent, callback) {
                callback({ condition: "☀", temperatureC: place.name.length }, "", "test");
            }
        }
    });
    const read = (location) => repository.refresh(location, () => true, () => {});

    // Panel edits and world-clock cities share this repository. Many sequential
    // locations must not turn into process-lifetime retained readings.
    for (const location of ["Panel A", "City B", "City C"]) {
        read(location);
    }
    read("Panel A");
    read("City D");
    assert.deepEqual([...repository._cache.keys()], ["city c", "panel a", "city d"],
        "the fresh hit moved Panel A past the older City B entry");
    assert.equal(repository._cache.size, 3);

    now += 10000;
    deferPlaces = true;
    read("City C");
    assert.equal(repository._cache.has("city c"), false,
        "an expired entry is removed before its replacement arrives");
    assert.equal(pendingPlaces.length, 1);

    repository.destroy();
});

// REGRESSION: the flight was recorded before the resolve was dispatched, so a
// resolver that raised pinned that location's key for good — every later
// refresh for it found an active request and joined a flight that could never
// complete.
test("a location resolve that raises frees the flight instead of pinning it", () => {
    const Weather = loadWeather();
    let raise = true;
    const resolves = [];
    const repository = new Weather.WeatherReadingRepository({
        cacheSeconds: 0,
        locationResolver: {
            resolve(location, _isCurrent, callback) {
                resolves.push(location);
                if (raise) {
                    throw new Error("geocoder disposed");
                }
                callback({ name: location, latitude: 1, longitude: 2 }, "");
            },
            forget() {}
        },
        forecastResolver: {
            refresh(_place, _isCurrent, callback) {
                callback({ condition: "☀", temperatureC: 7 }, "", "test");
            }
        }
    });
    global.logError = () => { throw new Error("error logger failed"); };

    const answers = [];
    repository.refresh("Rome", () => true,
        (reading, error) => answers.push({ reading, error }));

    assert.deepEqual(answers,
        [{ reading: null, error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE }],
        "the subscriber is settled rather than left waiting on the flight");
    assert.equal(repository._inflight.size, 0, "and the key is released");

    raise = false;
    repository.refresh("Rome", () => true,
        (reading) => answers.push({ reading, error: "" }));
    assert.equal(resolves.length, 2, "a later refresh starts a new flight");
    assert.equal(answers.length, 2);

    repository.destroy();
});

// the other half: once the request has settled, a throw coming back out through
// a subscriber's own callback is still that subscriber's
test("a throw from a settled subscriber is not reported as a resolve failure", () => {
    const Weather = loadWeather();
    const repository = new Weather.WeatherReadingRepository({
        cacheSeconds: 0,
        locationResolver: {
            resolve(_location, _isCurrent, callback) {
                callback(null, Weather.WEATHER_ERRORS.LOCATION_NOT_FOUND);
            },
            forget() {}
        }
    });

    assert.throws(() => repository.refresh("Rome", () => true, () => {
        throw new Error("consumer exploded");
    }), /consumer exploded/);
    assert.equal(repository._inflight.size, 0, "the flight settled before the throw");

    repository.destroy();
});

// T828: the composition root hands one repository to both the panel provider
// and the city provider, and WeatherCoordinator.schedule() drives them in the
// same synchronous call — so a world clock naming the panel's own location is
// subscriber #1 on the panel's flight. A bare dispatch loop made the panel's
// raise the end of the round: the city never heard back, cityWeather's
// outstanding count never reached zero, and no repaint, no retry and no
// backoff reset happened until the next 1800 s tick.
test("a subscriber that raises does not strand the rest of the shared flight", () => {
    const Weather = loadWeather();
    // the geocode is left pending so the flight can gather subscribers the way
    // a real one does, then settled on demand
    let resolveLater = null;
    const repository = new Weather.WeatherReadingRepository({
        cacheSeconds: 0,
        locationResolver: {
            resolve(location, _isCurrent, callback) {
                resolveLater = () =>
                    callback({ name: location, latitude: 1, longitude: 2 }, "");
            },
            forget() {}
        },
        forecastResolver: {
            refresh(_place, _isCurrent, callback) {
                callback({ condition: "☀", temperatureC: 7 }, "", "test");
            }
        }
    });

    const settled = [];
    let deferred = null;

    // the panel starts the flight and raises when it settles
    repository.refresh("Lisbon", () => true, () => {
        throw new Error("panel label exploded");
    });
    assert.equal(repository._inflight.size, 1, "the flight is pending");

    // a world clock naming the same place joins it, and behind that a consumer
    // that has since moved on
    repository.refresh("Lisbon", () => true, (reading) => settled.push(reading));
    repository.refresh("Lisbon", () => false,
        () => settled.push("a stale subscriber must be skipped"));
    assert.equal(repository._inflight.size, 1, "one flight, three subscribers");

    try {
        resolveLater();
    } catch (e) {
        deferred = e;
    }

    assert.equal(settled.length, 1, "the subscriber behind the raise is still settled");
    assert.equal(settled[0].temperatureC, 7);
    assert.match(deferred.message, /panel label exploded/,
        "and the raise is handed back to the caller it came from");
    assert.equal(repository._inflight.size, 0, "the flight settled before the throw");

    repository.destroy();
});

// T829: the repository stored startedAtFresh but published neither settle path
// with it, so a consumer could only stamp receipt time. The panel and the city
// round share one repository and their periods drift — a location edit restarts
// the panel's and leaves the city signature unchanged, so the city's is not
// restarted — and a cache hit on an almost-expired entry then reset the
// reading's apparent age. With cacheSeconds 1800 against a 3600 second
// staleness policy, a hit at 1799 seconds withheld the marker until 5399
// seconds of real age.
test("a cache hit reports when the reading was fetched, not when it arrived", () => {
    const Weather = loadWeather();
    let now = 1000000;
    const repository = new Weather.WeatherReadingRepository({
        cacheSeconds: 1800,
        freshnessNow: () => now,
        locationResolver: {
            resolve(location, _isCurrent, callback) {
                callback({ name: location, latitude: 1, longitude: 2 }, "");
            },
            forget() {}
        },
        forecastResolver: {
            refresh(_place, _isCurrent, callback) {
                callback({ condition: "\u2600", temperatureC: 7 }, "", "test");
            }
        }
    });

    const answers = [];
    const collect = (reading, error, provider, place, readingAt) =>
        answers.push({ error, readingAt });

    const fetchedAt = now;
    repository.refresh("Lisbon", () => true, collect);
    assert.equal(answers[0].readingAt, fetchedAt, "a fresh fetch is stamped now");

    // 1799 seconds later the entry is still inside the 1800 second cache window,
    // so this is a hit — and it is 1799 seconds old, not new
    now += 1799 * 1000;
    repository.refresh("Lisbon", () => true, collect);

    assert.equal(answers.length, 2);
    assert.equal(answers[1].error, "", "the cached reading is served");
    assert.equal(answers[1].readingAt, fetchedAt,
        "and it carries the age it actually has");

    repository.destroy();
});

// T832: the consumer count is right for the shared spacing timer — only the
// last instance may clear it — but nothing pruned the departing instance's own
// jobs. They can never run again, because isCurrent() goes false with its
// repository, and _nextCurrentJob would discard them on sight; but _drain() is
// only reachable from enqueue, release or the spacing timer, so with two applets
// on the panel, removing one while the other never geocodes again left its jobs
// here for the session — each holding closures that reach the request record,
// its subscribers, their callbacks, the provider and its Soup session.
test("a departing instance's queued geocodes leave with it", () => {
    const Weather = loadWeather();
    const starts = [];
    let now = 0;
    const timers = [];
    const queue = new Weather.NominatimRequestQueue({
        elapsedNow: () => now,
        schedule(delay, callback) {
            timers.push({ delay, callback });
            return timers.length;
        },
        removeTimer: () => {}
    });

    Weather.registerWeatherConsumer();
    Weather.registerWeatherConsumer();

    // one job in flight, then one each from the two instances waiting out the
    // interval behind it
    let release = null;
    queue.enqueue((done) => {
        starts.push("in flight");
        release = done;
    });
    let departingIsCurrent = true;
    queue.enqueue(() => starts.push("departing"), () => departingIsCurrent);
    queue.enqueue(() => starts.push("staying"));
    assert.equal(queue._jobs.length, 2);

    // the user removes the first instance: its repository is destroyed, so its
    // job's isCurrent() answers false
    departingIsCurrent = false;
    Weather.releaseWeatherConsumer(queue);

    assert.deepEqual(queue._jobs.map((job) => job.isCurrent()), [true],
        "only the remaining instance's job is still held");

    // and the instance that stayed still gets its geocode
    release();
    now = Weather.NOMINATIM_MIN_INTERVAL_MS;
    timers[0].callback();
    assert.deepEqual(starts, ["in flight", "staying"]);

    Weather.releaseWeatherConsumer(queue);
});

test("shared reading cache fits every configured clock and the panel location", () => {
    const Weather = loadWeather();
    const repository = new Weather.WeatherReadingRepository({ cacheSeconds: 1 });
    assert.equal(repository._max_cache_entries, Weather.MAX_WEATHER_READING_CACHE_ENTRIES);
    const { MAX_CLOCKS } = require("../files/chronos@geraldo-netto/clockLimits");
    assert.equal(Weather.MAX_WEATHER_READING_CACHE_ENTRIES, MAX_CLOCKS + 1);
    repository.destroy();
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
        requestQueue: immediateNominatimQueue(),
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
        requestQueue: immediateNominatimQueue(),
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
        requestQueue: immediateNominatimQueue(),
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

    // The shipped providers are data — one or more URLs, a normalize, and the request
    // options they need — so a third party's provider takes exactly the same
    // path the built-ins do. Each entry used to be a thunk into a private method
    // of this resolver, which meant adding a provider was an edit to the class
    // as well, and the built-ins did *not* use the plugin path.
    for (const provider of Weather.FORECAST_PROVIDERS) {
        assert.ok(typeof provider.url === "function" || typeof provider.urls === "function",
            `${provider.name} names its endpoint or endpoints`);
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
    asked.length = 0;
    resolver.refresh({ latitude: 1, longitude: 2 }, () => true, () => {});
    assert.equal(asked[0].url, "https://local.example/now",
        "and the one that worked is tried first next time");
});

test("a multi-request forecast merges once and keeps provider semantics", () => {
    const Weather = loadWeather();
    const pending = [];
    const asked = [];
    let normalizeCalls = 0;
    const split = {
        name: "Split service",
        urls: () => ["https://split.example/east", "https://split.example/west"],
        merge: (payloads) => payloads.flatMap((payload) => payload || []),
        normalize(data) {
            normalizeCalls++;
            return data.length ? { condition: "☀", temperatureC: data[0].degrees } : null;
        },
        options: { headers: { "User-Agent": "test" } }
    };
    const resolver = new Weather.WeatherForecastResolver({
        providers: [
            { name: "Before", url: () => "https://before.example", normalize: () => null },
            split,
            {
                name: "After",
                url: () => "https://after.example",
                normalize: (data) => data &&
                    { condition: "☀", temperatureC: data.degrees }
            }
        ],
        httpGetJson(url, callback, options = {}) {
            asked.push({ url, options });
            if (url.includes("before")) {
                callback(null);
            } else if (url.includes("after")) {
                callback({ degrees: 9 });
            } else {
                pending.push({ url, callback });
            }
        }
    });
    const answers = [];

    resolver.refresh({ latitude: 0, longitude: 180 }, () => true,
        (reading, error, provider) => answers.push({ reading, error, provider }));

    assert.deepEqual(asked.map((request) => request.url), [
        "https://before.example",
        "https://split.example/east",
        "https://split.example/west"
    ]);
    assert.deepEqual(asked.slice(1).map((request) => request.options),
        [split.options, split.options], "every leg keeps the provider's request options");
    pending[1].callback([{ degrees: 22 }]);
    pending[1].callback([{ degrees: 99 }]);
    assert.equal(answers.length, 0, "one leg cannot settle the provider");
    pending[0].callback(null);

    assert.equal(normalizeCalls, 1, "partial payloads are merged, then normalized once");
    assert.equal(answers.length, 1, "duplicate and out-of-order callbacks settle once");
    assert.deepEqual({
        text: shown(answers[0].reading, "si"),
        error: answers[0].error,
        provider: answers[0].provider
    }, { text: "☀ 22°C", error: "", provider: split.name });

    asked.length = 0;
    pending.length = 0;
    resolver.refresh({ latitude: 0, longitude: 180 }, () => true,
        (reading, error, provider) => answers.push({ reading, error, provider }));
    assert.deepEqual(asked.map((request) => request.url), [
        "https://split.example/east",
        "https://split.example/west"
    ], "last successful multi-request provider remains first");
    pending[1].callback(null);
    pending[0].callback(null);

    assert.deepEqual(asked.slice(2).map((request) => request.url),
        ["https://before.example", "https://after.example"],
        "total failure advances once through the remaining provider order");
    assert.equal(answers.length, 2);
    assert.equal(answers[1].provider, "After");
});

test("stale multi-request forecast callbacks do not settle or fail over", () => {
    const Weather = loadWeather();
    const pending = [];
    const asked = [];
    const resolver = new Weather.WeatherForecastResolver({
        providers: [
            {
                name: "Split",
                urls: () => ["https://split.example/east", "https://split.example/west"],
                merge: (payloads) => payloads.flatMap((payload) => payload || []),
                normalize: () => ({ condition: "☀", temperatureC: 20 })
            },
            {
                name: "Backup",
                url: () => "https://backup.example",
                normalize: () => ({ condition: "☀", temperatureC: 10 })
            }
        ],
        httpGetJson(url, callback) {
            asked.push(url);
            pending.push(callback);
        }
    });
    const answers = [];

    resolver.refresh({ latitude: 0, longitude: 180 }, () => false,
        (...args) => answers.push(args));
    pending[1]([]);
    pending[0]([]);

    assert.deepEqual(answers, []);
    assert.deepEqual(asked,
        ["https://split.example/east", "https://split.example/west"],
        "a stale provider neither reports nor starts its backup");
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

            callback({ current_weather: { weathercode: 2, temperature: 15.4 } });
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
    assert.equal(provider._reading_repository.session.created, null);
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
    assert.equal(scheduledRefreshes.length, 0, "no network work before the edit settles");
    // T703: each edit retires the old place's state at once — the panel is not
    // left showing the previous city while the keystrokes settle — but only
    // the replacement request is debounced
    assert.equal(refreshes, 2, "each edit says so synchronously");

    assert.equal(scheduledDebounces[1].callback(), false);
    assert.equal(scheduledRefreshes.length, 1);
    assert.equal(refreshes, 4, "pending placeholder plus the reading");

    provider.stop();
    assert.deepEqual(removed, [101, 42]);
});

// T703: queue() moved the resolved location key but left the request
// generation, the timers and the retained reading alone until the 750 ms
// debounce fired. In that window an in-flight callback was still "current", so
// the previous city's reading was stored and painted under the new city's
// name, and an old retry could arm more work with the previous settings.
test("editing the location retires the old city's work before the debounce", () => {
    const Weather = loadWeather();
    const reports = [];
    const armed = [];
    let respondLisbon = null;
    const provider = new Weather.WeatherProvider({
        debounceMs: 750,
        httpGetJson(url, callback) {
            if (url.includes("geocoding-api") && url.includes("Lisbon")) {
                // the geocode for the first city never comes back in time
                respondLisbon = () => callback(
                    { results: [{ latitude: 38, longitude: -9, population: 505000 }] });
                return;
            }
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 35, longitude: 139, population: 8000000 }] });
                return;
            }
            callback({ current_weather: { weathercode: 0, temperature: 31 } });
        },
        scheduleDebounceTimer: (milliseconds, callback) => {
            armed.push({ kind: "debounce", callback });
            return armed.length;
        },
        scheduleTimer: (seconds, callback) => {
            armed.push({ kind: "timer", seconds, callback });
            return armed.length;
        },
        removeTimer() {}
    });
    const report = (reading, error, provider_name, pending) =>
        reports.push({ reading, error, pending: Boolean(pending) });

    // Lisbon is asked for and hangs; its periodic timer is armed
    provider.schedule({ showWeather: true, location: "Lisbon", units: "si" }, report);
    assert.deepEqual(reports.at(-1), { reading: null, error: "", pending: true });
    const armedForLisbon = armed.length;

    // the user retypes: Tokyo. The edit is debounced, the invalidation is not.
    reports.length = 0;
    provider.queue({ showWeather: true, location: "Tokyo", units: "si" }, report);
    assert.deepEqual(reports, [{ reading: null, error: "", pending: true }],
        "the panel stops claiming Lisbon's slot the moment the place changes");

    // Lisbon's geocode finally answers, inside the debounce window
    respondLisbon();
    assert.deepEqual(reports, [{ reading: null, error: "", pending: true }],
        "a retired request paints nothing");
    assert.equal(provider._display_state.hasReading(), false,
        "nor is another city's reading retained");

    // ...and Lisbon's armed timers cannot dispatch the old settings either
    for (const timer of armed.slice(0, armedForLisbon)) {
        if (timer.kind === "timer") {
            assert.equal(timer.callback(), false, "the old periodic timer retires itself");
        }
    }

    // the debounce settles: Tokyo, and only Tokyo, is fetched
    armed.filter((timer) => timer.kind === "debounce").at(-1).callback();
    assert.deepEqual(reports.at(-1),
        { reading: { condition: "☀", temperatureC: 31 }, error: "", pending: false });
});

test("queue applies the weather opt-out immediately and invalidates in-flight work", () => {
    const Weather = loadWeather();
    const requests = [];
    const timers = [];
    const debounces = [];
    const reports = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            requests.push({ url, callback });
        },
        scheduleTimer(_seconds, callback) {
            timers.push(callback);
            return timers.length;
        },
        scheduleDebounceTimer(_milliseconds, callback) {
            debounces.push(callback);
            return 20;
        },
        removeTimer() {}
    });
    const active = { showWeather: true, location: "Rome", units: "si" };

    provider.schedule(active, (...args) => reports.push(args));
    assert.equal(requests.length, 1);
    assert.equal(timers.length, 1);

    provider.queue({ ...active, showWeather: false }, (...args) => reports.push(args));
    assert.equal(debounces.length, 0, "the opt-out bypasses the edit debounce");
    assert.deepEqual(reports.at(-1), [null, "", ""], "the visible state clears synchronously");

    requests[0].callback({ results: [{ latitude: 1, longitude: 2, population: 1000 }] });
    assert.equal(requests.length, 1, "the stale geocode starts no forecast");
    assert.equal(timers[0](), false, "the old periodic callback is terminal");
    assert.deepEqual(reports, [[null, "", "", true], [null, "", ""]]);
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

    assert.deepEqual(values, ["☁ 10°C", "☁ 10°C"]);
    assert.ok(provider._reading_repository.locationResolver.placeFor("rome"));
    assert.equal(requests.filter((url) => url.includes("geocoding-api")).length, 1);
    assert.equal(requests.filter((url) => url.includes("/v1/forecast")).length, 2);
});

test("applets bind only weather settings to debounced refresh", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "6.0", "applet.js"), "utf8");
    const lifecycle = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "6.0", "appletLifecycle.js"), "utf8");
    const facade = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "settingsFacade.js"), "utf8");
    // request and presentation settings are separate, so changing units cannot
    // drag a weather refetch along with it
    assert.match(facade, /var WEATHER_KEYS = \[(?: \/\/ NOSONAR[^\n]*)?\s*\["show-weather", "show_weather"\]/);
    // units and location are both mirrored rather than bound: their widgets make
    // their schema type "custom", which Cinnamon's bind() refuses. Only the
    // callback differs, and units must not be a request key
    assert.match(facade, /var MIRRORED_WEATHER_KEYS = \[(?: \/\/ NOSONAR[^\n]*)?\s*\["weather-units", "weather_units", "presentation"\],\s*\[WEATHER_LOCATION_KEY, "weather_location", "request"\]/);
    assert.match(lifecycle,
        /bindWeatherKeys\([\s\S]*?this\.handlers\.onWeatherSettingsChanged,[\s\S]*?this\.handlers\.onWeatherUnitsChanged\)/);

    const unitSettingsChanged = source.match(/_onWeatherUnitsChanged\(\) \{([\s\S]*?)\n {4}\}/);
    assert.ok(unitSettingsChanged);
    assert.doesNotMatch(unitSettingsChanged[1], /_scheduleWeatherRefresh|_queueWeatherRefresh/);

    const generalSettingsChanged = source.match(/_onSettingsChanged\(\) \{([\s\S]*?)\n {4}\}/);
    assert.ok(generalSettingsChanged);
    assert.doesNotMatch(generalSettingsChanged[1], /_scheduleWeatherRefresh|_queueWeatherRefresh/);
});

test("applets schedule weather once when added to a panel", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "6.0", "applet.js"), "utf8");
    const panelAdded = source.match(/on_applet_added_to_panel\(\) \{([\s\S]*?)\n {4}\}/);
    assert.ok(panelAdded);
    assert.equal((panelAdded[1].match(/this\._scheduleWeatherRefresh\(\);/g) || []).length, 1);

    const generalSettingsChanged = source.match(/_onSettingsChanged\(\) \{([\s\S]*?)\n {4}\}/);
    assert.ok(generalSettingsChanged);
    assert.doesNotMatch(generalSettingsChanged[1], /_scheduleWeatherRefresh/);
});

test("applets refresh weather when the system resumes", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "6.0", "applet.js"), "utf8");
    const lifecycle = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "6.0", "appletLifecycle.js"), "utf8");
    assert.match(lifecycle, /"PrepareForSleep"/);
    assert.match(lifecycle,
        /if \(!sleeping\) \{\s*this\._dayRollover\.reschedule\(\);\s*context\.onResume\(\);/);

    const onResume = source.match(/_onResume\(\) \{([\s\S]*?)\n {4}\}/);
    assert.ok(onResume);
    assert.match(onResume[1], /this\._updateClockAndDate\(\);/);
    assert.match(onResume[1], /this\._scheduleWeatherRefresh\(\{ force: true \}\);/);
});

// T830: GEOCODE_PROVIDERS declares validation, normalization, and transport -
// and the resolver reached back out and branched on the vendor to decide
// throttling. A geocoder appended to the registry could not declare a rate
// limit; it got requestQueue: null and unthrottled dispatch, so the built-in
// did not use the path a third party would. That is the exact failure mode the
// sibling comment on FORECAST_PROVIDERS claims was closed there.
test("a geocoder declares its own rate limit in the registry", () => {
    const Weather = loadWeather();
    const dispatched = [];
    const queued = [];
    const queue = {
        enqueue(start) {
            queued.push(start);
            start();
        }
    };
    const resolver = new Weather.WeatherLocationResolver({
        httpGetJson(url, callback) {
            dispatched.push(url);
            callback(url.startsWith("https://slow.") ?
                { lat: 1, lon: 2, display_name: "Rome" } : null);
        },
        providers: [
            {
                name: "Fast",
                url: () => "https://fast.example/geocode",
                isValidResponse: (data) => data !== null,
                normalize: () => null
            },
            {
                name: "Slow",
                url: () => "https://slow.example/geocode",
                isValidResponse: (data) => data !== null,
                normalize: (data) => (data ?
                    { latitude: Number(data.lat), longitude: Number(data.lon),
                        name: data.display_name } : null),
                // one line, and this third-party geocoder is throttled like the
                // built-in one
                requestQueue: queue
            }
        ]
    });

    let place = null;
    resolver.resolve("Rome", () => true, (resolved) => { place = resolved; });

    assert.equal(place && place.name, "Rome");
    assert.deepEqual(dispatched,
        ["https://fast.example/geocode", "https://slow.example/geocode"]);
    assert.equal(queued.length, 1,
        "only the entry that declared a queue goes through one");
});

// ...and an injected substitute stands in for whichever entries declared one,
// rather than for a vendor the resolver had to know the name of.
test("a substitute request queue replaces every declared one", () => {
    const Weather = loadWeather();
    const substitute = { calls: 0, enqueue(start) { this.calls++; start(); } };
    const declared = { calls: 0, enqueue(start) { this.calls++; start(); } };
    const resolver = new Weather.WeatherLocationResolver({
        httpGetJson: (url, callback) => callback({ lat: 1, lon: 2, display_name: "Rome" }),
        requestQueue: substitute,
        providers: [{
            name: "Throttled",
            url: () => "https://throttled.example/geocode",
            isValidResponse: (data) => data !== null,
            normalize: (data) => ({ latitude: Number(data.lat),
                longitude: Number(data.lon), name: data.display_name }),
            requestQueue: declared
        }]
    });

    resolver.resolve("Rome", () => true, () => {});

    assert.equal(substitute.calls, 1);
    assert.equal(declared.calls, 0);
});
