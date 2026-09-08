"use strict";

const { assert, test, loadWeather, immediateNominatimQueue } = require("./helpers/weatherFixture");
const { URL } = require("node:url");
const FIXTURE = require("./fixtures/open_meteo_san_juan.json");
const ROOT = "../files/chronos@geraldo-netto/";
const ARGENTINA = "America/Argentina/San_Juan";
const AR_HINT = { timezone: ARGENTINA, countryCode: "AR" };
const PR_HINT = { timezone: "America/Puerto_Rico", countryCode: "PR" };
const ZONE_TAB = [
    "AR\t-3132-06831\t" + ARGENTINA,
    "PR\t+182806-0660622\tAmerica/Puerto_Rico",
    "US\t+404251-0740023\tAmerica/New_York",
    "SK\t+4809+01707\tEurope/Bratislava",
    "CZ\t+5005+01426\tEurope/Prague",
    "VA\t+415408+0122711\tEurope/Vatican",
    "IT\t+4154+01229\tEurope/Rome"
].join("\n");

function loadClockWeather(options = {}) {
    for (const name of ["worldclockData", "cityWeather", "6.0/worldclockData", "6.0/appletCoordinators"])
        delete require.cache[require.resolve(ROOT + name)];
    const Weather = loadWeather();
    const glib = global.imports.gi.GLib;
    const known = new Set([...FIXTURE.results.map((place) => place.timezone), "UTC", "Etc/UTC",
        "Etc/GMT+3", "US/Eastern", "America/New_York", "Alias/San_Juan", "Europe/Bratislava",
        "Europe/Prague", "Europe/Vatican", "Europe/Rome", "Asia/Tokyo"]);
    glib.TimeZone = {
        new_identifier: (timezone) => known.has(timezone) ? { get_identifier: () => timezone } : null,
        new_local: () => ({ get_identifier: () => "Etc/UTC" })
    };
    const reads = [];
    const links = { "/usr/share/zoneinfo/US/Eastern": "../America/New_York",
        "/usr/share/zoneinfo/Alias/San_Juan": "../" + ARGENTINA,
        "/usr/share/zoneinfo/Europe/Bratislava": "Prague",
        "/usr/share/zoneinfo/Europe/Vatican": "Rome" };
    glib.file_read_link = (filename) => { reads.push(filename); return links[filename]; };
    glib.file_get_contents = (filename) => {
        reads.push(filename);
        return [true, Buffer.from(options.zoneTab ?? ZONE_TAB)];
    };
    const data = require(ROOT + "worldclockData");
    global.imports.ui = { appletManager: { applets: { "chronos@geraldo-netto": { worldclockData: data } } } };
    return { Weather, data, reads, ...require(ROOT + "cityWeather"), ...require(ROOT + "6.0/appletCoordinators") };
}

function clockFixtureHttp(url, callback, forecasts) {
    if (url.startsWith("https://geocoding-api.open-meteo.com/")) {
        callback(FIXTURE);
        return;
    }
    assert.ok(url.startsWith("https://api.open-meteo.com/v1/forecast?"), url);
    const parameters = new URL(url).searchParams;
    const latitude = Number(parameters.get("latitude"));
    forecasts.push([latitude, Number(parameters.get("longitude"))]);
    callback({ current_weather: { temperature: latitude < 0 ? 12 : 30, weathercode: 0 } });
}

// Captured from the official API on 2026-09-08, without test network traffic:
// https://geocoding-api.open-meteo.com/v1/search?name=San%20Juan&count=10&language=en&format=json
test("T1152 coordinator weather uses Argentina San Juan through the real provider chain", () => {
    const { Weather, CityWeatherProvider, AppletWeatherCoordinator } = loadClockWeather();
    const forecasts = [];
    const repository = new Weather.WeatherReadingRepository({
        cacheSeconds: 60, requestQueue: immediateNominatimQueue(),
        httpGetJson: (url, callback) => clockFixtureHttp(url, callback, forecasts)
    });
    const cities = new CityWeatherProvider({ readingRepository: repository });
    const coordinator = new AppletWeatherCoordinator({
        weatherProvider: {}, cityWeatherProvider: cities,
        settings: () => ({ showWeather: true, showWorldclocks: true }),
        worldclocks: () => [{ label: "Private nickname", timezone: ARGENTINA }],
        onChanged() {}, guard: (_name, run) => run()
    });
    try {
        coordinator.scheduleCities();
        assert.deepEqual(forecasts, [[-31.53726, -68.52568]]);
        assert.deepEqual(coordinator.cityReading(ARGENTINA), { condition: "☀", temperatureC: 12 });
        assert.equal(coordinator.cityReading("Private nickname"), null);
    } finally {
        cities.destroy();
        repository.destroy();
    }
});

test("T1152 hinted and free-text flights and caches remain distinct", () => {
    const { Weather } = loadClockWeather();
    const pending = [], forecasts = [], answers = [];
    const repository = new Weather.WeatherReadingRepository({ cacheSeconds: 60,
        requestQueue: immediateNominatimQueue(), httpGetJson(url, callback) {
            if (url.includes("/v1/search?")) pending.push({ url, callback });
            else clockFixtureHttp(url, callback, forecasts);
        } });
    const refresh = (hint) => repository.refresh("San Juan", () => true,
        (reading, error, _provider, place) => answers.push({ reading, error, place }), hint);
    try {
        for (const hint of [null, AR_HINT, PR_HINT, { ...AR_HINT }]) refresh(hint);
        assert.equal(pending.length, 3, "only identical hints share a flight");
        assert.equal(new URL(pending[1].url).searchParams.get("countryCode"), "AR");
        pending.forEach(({ callback }) => callback(FIXTURE));
        assert.deepEqual(forecasts, [[18.46633, -66.10572], [-31.53726, -68.52568], [18.46633, -66.10572]]);
        assert.deepEqual(answers.map((answer) => answer.reading.temperatureC), [30, 12, 12, 30]);
        for (const hint of [null, AR_HINT, PR_HINT]) refresh(hint);
        assert.equal(pending.length, 3, "each identity has its own cached reading");
        assert.equal(repository.placeFor("San Juan", AR_HINT).latitude, -31.53726);
        repository.forget("San Juan", AR_HINT);
        assert.equal(repository.placeFor("San Juan", AR_HINT), null);
        assert.equal(repository.placeFor("San Juan").latitude, 18.46633);
        assert.equal(repository.placeFor("San Juan", PR_HINT).latitude, 18.46633);
    } finally {
        repository.destroy();
    }
});

test("T1152 requests retain exact countries, equivalent aliases, and immutable memo identity", () => {
    const { data, reads } = loadClockWeather();
    const expected = { query: "Bratislava", hint: { timezone: "Europe/Prague", countryCode: "SK" } };
    assert.deepEqual(data.timezoneWeatherRequest("Europe/Bratislava"), expected);
    assert.deepEqual(data.timezoneWeatherRequest("Europe/Vatican"),
        { query: "Vatican", hint: { timezone: "Europe/Rome", countryCode: "VA" } });
    const alias = data.timezoneWeatherRequest("US/Eastern");
    assert.deepEqual(alias, data.timezoneWeatherRequest("America/New_York"));
    assert.deepEqual(alias, { query: "New York", hint: { timezone: "America/New_York", countryCode: "US" } });
    const count = reads.length;
    assert.throws(() => { alias.hint.countryCode = "PR"; }, TypeError);
    assert.throws(() => { alias.query = "Private nickname"; }, TypeError);
    assert.equal(data.timezoneWeatherRequest("US/Eastern"), alias);
    assert.equal(reads.length, count, "presenter lookups perform no repeated timezone I/O");
});

test("T1152 Open-Meteo aliases match while incompatible hints and free-text ranking stay separate", () => {
    const { Weather, data } = loadClockWeather();
    const alias = { ...FIXTURE.results[2], timezone: "Alias/San_Juan" };
    const resolver = new Weather.WeatherLocationResolver({
        httpGetJson: (_url, callback) => callback({ results: [FIXTURE.results[0], alias] })
    });
    let answer;
    resolver.resolve("San Juan", () => true, (place) => { answer = place; }, AR_HINT);
    assert.equal(answer.latitude, -31.53726);
    assert.equal(data.timezoneWeatherRequest(answer.timezone).hint.timezone, ARGENTINA);
    assert.equal(Weather.openMeteoGeocodePlace(FIXTURE, "San Juan").latitude, 18.46633,
        "R25 free-text ranking remains unchanged");
    assert.equal(Weather.openMeteoGeocodePlace(FIXTURE, "San Juan", { ...AR_HINT, countryCode: "US" }), null);
    assert.equal(Weather.openMeteoGeocodePlace(FIXTURE, "San Juan", { ...AR_HINT, timezone: "Asia/Tokyo" }), null);
});

test("T1152 Nominatim fallback verifies country and refuses timezone-only requests", () => {
    const { Weather } = loadClockWeather();
    const requests = [], answers = [];
    const resolver = new Weather.WeatherLocationResolver({ requestQueue: immediateNominatimQueue(),
        httpGetJson(url, callback) {
            requests.push(url);
            callback(url.includes("nominatim") ? [
                { display_name: "San Juan, Puerto Rico", lat: 18.46633, lon: -66.10572,
                    importance: 1, address: { country_code: "pr" } },
                { display_name: "San Juan, Argentina", lat: -31.53726, lon: -68.52568,
                    importance: 0.5, address: { country_code: "ar" } }
            ] : {});
        } });
    resolver.resolve("San Juan", () => true, (place) => answers.push(place), AR_HINT);
    assert.equal(answers[0].latitude, -31.53726);
    assert.equal(new URL(requests[1]).searchParams.get("countrycodes"), "ar");
    assert.equal(new URL(requests[1]).searchParams.get("addressdetails"), "1");
    resolver.resolve("San Juan", () => true, (place) => answers.push(place), { ...AR_HINT, countryCode: "" });
    assert.equal(answers[1], null);
    assert.equal(requests.length, 3, "unverifiable fallback does not issue a global search");
    assert.equal(Weather.nominatimGeocodePlace([{ lat: 1, lon: 2 }], "San Juan", AR_HINT), null);
});

test("T1152 invalid hints never degrade to unhinted network requests", () => {
    const { Weather } = loadClockWeather();
    const requests = [], answers = [];
    const repository = new Weather.WeatherReadingRepository({
        httpGetJson: (url) => requests.push(url)
    });
    const invalid = [false, 1, [], {}, { ...AR_HINT, countryCode: "ar" },
        { ...AR_HINT, timezone: "Europe/Rome\0UTC" }, { ...AR_HINT, timezone: "x".repeat(256) }];
    try {
        for (const hint of invalid) {
            repository.refresh("San Juan", () => true, (reading, error) => answers.push([reading, error]), hint);
            assert.equal(repository.placeFor("San Juan", hint), null);
            assert.equal(Weather.geocodeUrl("San Juan", "en", hint), "");
            assert.equal(Weather.nominatimGeocodeUrl("San Juan", "en", hint), "");
        }
        assert.equal(answers.length, invalid.length);
        assert.ok(answers.every(([reading, error]) => reading === null && error === Weather.WEATHER_ERRORS.LOCATION_NOT_FOUND));
        assert.deepEqual(requests, []);
    } finally {
        repository.destroy();
    }
});

test("T1152 hint snapshots cannot be changed during asynchronous geocoding", () => {
    const { Weather } = loadClockWeather();
    let receive;
    const resolver = new Weather.WeatherLocationResolver({ httpGetJson: (_url, callback) => { receive = callback; } });
    const hint = { ...AR_HINT };
    let answer;
    resolver.resolve("San Juan", () => true, (place) => { answer = place; }, hint);
    hint.countryCode = "PR";
    hint.timezone = PR_HINT.timezone;
    receive(FIXTURE);
    assert.equal(answer.latitude, -31.53726);
    assert.equal(resolver.placeFor("San Juan", AR_HINT), answer);
    assert.equal(resolver.placeFor("San Juan", PR_HINT), null);
});

test("T1152 invalid and non-location clock timezones have no weather request", () => {
    const { data } = loadClockWeather();
    for (const timezone of [null, false, 1, [], {}, "", "Unknown/Place", "UTC", "Etc/GMT+3",
        "EST5EDT,M3.2.0/2,M11.1.0/2", "Europe/Rome\0UTC"])
        assert.equal(data.timezoneWeatherRequest(timezone), null);
    assert.deepEqual(data.timezoneWeatherRequest(ARGENTINA), { query: "San Juan", hint: AR_HINT });
});

test("T1152 same-name city readings, errors, staleness, and removal use the hint", () => {
    const { Weather, CityWeatherProvider } = loadClockWeather();
    let online = true;
    const forecasts = [];
    const repository = new Weather.WeatherReadingRepository({ freshnessNow: () => 1000,
        httpGetJson: (url, callback) => clockFixtureHttp(url, callback, forecasts) });
    const provider = new CityWeatherProvider({ readingRepository: repository, freshnessNow: () => 1000,
        isOnline: () => online, staleAfterSeconds: 60 });
    const cities = [AR_HINT, PR_HINT].map((hint) => ({ label: "Private nickname", query: "San Juan", hint }));
    try {
        provider.schedule({ showWeather: true, cities }, () => {});
        assert.equal(provider.recordFor("San Juan", AR_HINT).temperatureC, 12);
        assert.equal(provider.recordFor("San Juan", PR_HINT).temperatureC, 30);
        assert.equal(provider.recordFor("San Juan"), null);
        assert.equal(provider.staleFor("San Juan", AR_HINT, 61001), true);
        assert.equal(provider.staleFor("San Juan", PR_HINT, 1000), false);
        online = false;
        provider.refresh({ showWeather: true, cities: [cities[0]] }, () => {});
        assert.equal(provider.errorFor("San Juan", AR_HINT), Weather.WEATHER_ERRORS.OFFLINE);
        assert.equal(provider.errorFor("San Juan", PR_HINT), "");
        assert.equal(provider.recordFor("San Juan", PR_HINT), null);
        assert.equal(provider.providerFor("San Juan", AR_HINT), "Open-Meteo");
    } finally {
        provider.destroy();
        repository.destroy();
    }
});
