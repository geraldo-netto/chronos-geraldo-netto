const {
    assert, test, fs, path, makeRandom,
    modulePath, serviceAdaptersPath, schema52Path,
    shown, loadWeather
} = require("./helpers/weatherFixture");

test("aviationweather METARs are read from the nearest station that has a temperature", () => {
    const Weather = loadWeather();
    const place = { latitude: -23.55, longitude: -46.63 };

    assert.equal(
        Weather.aviationWeatherUrl(place),
        "https://aviationweather.gov/api/data/metar?format=json&bbox=-24.550%2C-47.630%2C-22.550%2C-45.630"
    );

    const stations = [
        // no temperature: a station that cannot answer the question is not the
        // nearest station, however close it sits
        { icaoId: "SBSP", lat: -23.62, lon: -46.65, temp: null, cover: "CLR" },
        { icaoId: "SBMT", lat: -23.51, lon: -46.64, temp: 23, cover: "BKN" },
        { icaoId: "SBGR", lat: -23.43, lon: -46.47, temp: 24, cover: "CAVOK" }
    ];

    assert.equal(Weather.aviationWeatherStation(stations, place).icaoId, "SBMT");
    assert.equal(shown(Weather.aviationWeatherReading(stations, place), "si"), "☁ 23°C");
    // METAR temperatures are Celsius; imperial has to convert
    assert.equal(shown(Weather.aviationWeatherReading(stations, place), "imperial"), "☁ 73°F");
    assert.equal(shown(Weather.aviationWeatherReading([], place), "si"), "");
    assert.equal(shown(Weather.aviationWeatherReading(null, place), "si"), "");
    assert.equal(Weather.aviationWeatherStation([{ lat: "x", lon: 1, temp: 5 }], place), null);
});

test("METAR present weather outranks the sky cover in the icon", () => {
    const Weather = loadWeather();

    assert.equal(Weather.aviationWeatherIcon({ wxString: "TSRA", cover: "CLR" }), "⛈");
    assert.equal(Weather.aviationWeatherIcon({ wxString: "-SHRA", cover: "OVC" }), "🌦");
    assert.equal(Weather.aviationWeatherIcon({ wxString: "RA", cover: "BKN" }), "🌧");
    assert.equal(Weather.aviationWeatherIcon({ wxString: "SN", cover: "OVC" }), "🌨");
    assert.equal(Weather.aviationWeatherIcon({ wxString: "BR", cover: "FEW" }), "☁");
    assert.equal(Weather.aviationWeatherIcon({ cover: "CAVOK" }), "☀");
    assert.equal(Weather.aviationWeatherIcon({ cover: "FEW" }), "🌤");
    assert.equal(Weather.aviationWeatherIcon({ cover: "SCT" }), "⛅");
    assert.equal(Weather.aviationWeatherIcon({ cover: "OVC" }), "☁");
    assert.equal(Weather.aviationWeatherIcon({}), "🌤");
});

test("the METAR service answers between Open-Meteo and MET.no", () => {
    const Weather = loadWeather();
    const requests = [];
    const resolver = new Weather.WeatherForecastResolver({
        httpGetJson(url, callback, options = {}) {
            requests.push({ url, options });
            if (url.includes("api.open-meteo.com")) {
                callback(null);
                return;
            }
            callback([{ icaoId: "LIRF", lat: 41.8, lon: 12.25, temp: 18, cover: "SCT" }]);
        }
    });
    const values = [];

    resolver.refresh({ latitude: 41.9, longitude: 12.5 }, () => true, (reading, error, name) => {
        values.push({ text: shown(reading, "si"), error, name });
    });

    assert.deepEqual(values, [
        { text: "⛅ 18°C", error: "", name: Weather.WEATHER_PROVIDER_NAMES.AVIATION_WEATHER }
    ]);
    assert.ok(requests[1].url.includes("aviationweather.gov"));
    // the site asks callers to identify themselves, as MET.no does
    assert.equal(requests[1].options.headers["User-Agent"], Weather.WEATHER_USER_AGENT);
    // MET.no is never reached: the METAR answered first
    assert.equal(requests.length, 2);
});

test("builds Open-Meteo geocode and forecast URLs", () => {
    const Weather = loadWeather();

    assert.equal(
        Weather.geocodeUrl(" New York ", "en_US.UTF-8"),
        "https://geocoding-api.open-meteo.com/v1/search?name=New%20York&count=10&language=en&format=json"
    );
    // the search is run in the language the session runs in: asked in English,
    // "Genova" is Génova, Guatemala before Genova, Italy
    assert.equal(
        Weather.geocodeUrl("Genova", "it_IT.UTF-8"),
        "https://geocoding-api.open-meteo.com/v1/search?name=Genova&count=10&language=it&format=json"
    );
    assert.equal(
        Weather.nominatimGeocodeUrl(" New York "),
        "https://nominatim.openstreetmap.org/search?q=New%20York&format=json&limit=1"
    );
    assert.equal(Weather.locationCacheKey(" New York "), "new york");
    const maximum = Weather.MAX_WEATHER_LOCATION_LENGTH;
    const exact = "x".repeat(maximum);
    const unicodeExact = "🎉".repeat(maximum);
    for (const location of [exact, unicodeExact]) {
        assert.equal(Weather.normalizeWeatherLocation(location), location);
        assert.notEqual(Weather.geocodeUrl(location, "en"), "");
        assert.notEqual(Weather.nominatimGeocodeUrl(location), "");
        assert.equal(Weather.locationCacheKey(location), location.toLowerCase());
    }
    for (const location of [
        "x".repeat(maximum + 1),
        "🎉".repeat(maximum + 1),
        " " + exact
    ]) {
        assert.equal(Weather.normalizeWeatherLocation(location), "");
        assert.equal(Weather.geocodeUrl(location, "en"), "");
        assert.equal(Weather.nominatimGeocodeUrl(location), "");
        assert.equal(Weather.locationCacheKey(location), "");
    }
    // always Celsius now, whatever the units: formatTemperature does the
    // imperial conversion so all three providers share one rule
    assert.equal(
        Weather.forecastUrl({ latitude: 41.9, longitude: 12.5 }, "si"),
        "https://api.open-meteo.com/v1/forecast?latitude=41.9&longitude=12.5&current_weather=true&timezone=auto&temperature_unit=celsius"
    );
    assert.equal(
        Weather.forecastUrl({ latitude: 41.9, longitude: 12.5 }, "imperial"),
        "https://api.open-meteo.com/v1/forecast?latitude=41.9&longitude=12.5&current_weather=true&timezone=auto&temperature_unit=celsius"
    );
    // injection attempts from a hostile geocode reply must be encoded away
    assert.ok(!Weather.forecastUrl(
        { latitude: "41.9&hourly=temperature_2m", longitude: "12.5#frag" }, "si"
    ).includes("&hourly="));
    assert.ok(!Weather.forecastUrl(
        { latitude: "41.9&hourly=x", longitude: 12.5 }, "si"
    ).includes("#"));

    // hostile or malformed geocode payloads never yield non-finite coordinates
    assert.equal(Weather.openMeteoGeocodePlace({ results: [{ latitude: "abc", longitude: 5 }] }), null);
    assert.equal(Weather.openMeteoGeocodePlace({ results: [{ latitude: Infinity, longitude: 5 }] }), null);
    assert.equal(Weather.openMeteoGeocodePlace({
        results: [{ latitude: "41.9", longitude: "12.5", population: 1000 }]
    }).latitude, 41.9);
    assert.equal(typeof Weather.openMeteoGeocodePlace(
        { results: [{ latitude: "41.9", longitude: "12.5", population: 1000 }] }).longitude, "number");

    assert.equal(
        Weather.metNoForecastUrl({ latitude: 41.9, longitude: 12.5 }),
        "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=41.9&lon=12.5"
    );
});

test("normalizes primary and fallback geocode responses", () => {
    const Weather = loadWeather();

    assert.deepEqual(
        Weather.openMeteoGeocodePlace({ results: [{ latitude: 41.9, longitude: 12.5, population: 1000 }] }),
        { name: "", latitude: 41.9, longitude: 12.5 }
    );
    assert.equal(Weather.openMeteoGeocodePlace({
        results: [{ latitude: 41.9, longitude: 12.5, population: 999 }]
    }), null, "a tiny result is left for the fallback geocoder to arbitrate");
    assert.equal(Weather.openMeteoGeocodePlace({ results: [] }), null);
    assert.deepEqual(
        Weather.nominatimGeocodePlace([{ lat: "41.9", lon: "12.5", display_name: "Rome, Italy" }]),
        { name: "Rome, Italy", latitude: 41.9, longitude: 12.5 }
    );
    assert.equal(Weather.nominatimGeocodePlace([{ lat: "x", lon: "12.5" }]), null);

    for (const value of [null, "", " ", false, true, [], {}, NaN, Infinity]) {
        assert.equal(Weather.openMeteoGeocodePlace({
            results: [{ latitude: value, longitude: 12.5, population: 1000 }]
        }), null);
        assert.equal(Weather.nominatimGeocodePlace([{ lat: value, lon: "12.5" }]), null);
    }

    for (const [latitude, longitude] of [
        [-90, -180], [90, 180], ["-90", "-180"], ["90", "180"]
    ]) {
        assert.deepEqual(Weather.openMeteoGeocodePlace({
            results: [{ latitude, longitude, population: 1000 }]
        }), { name: "", latitude: Number(latitude), longitude: Number(longitude) });
        assert.deepEqual(Weather.nominatimGeocodePlace([{
            lat: latitude, lon: longitude, display_name: "edge"
        }]), { name: "edge", latitude: Number(latitude), longitude: Number(longitude) });
    }

    for (const [latitude, longitude] of [
        [-90.001, 0], [90.001, 0], [0, -180.001], [0, 180.001], [999, 999],
        ["41.9north", "12.5"]
    ]) {
        assert.equal(Weather.openMeteoGeocodePlace({
            results: [{ latitude, longitude, population: 1000 }]
        }), null);
        assert.equal(Weather.nominatimGeocodePlace([{ lat: latitude, lon: longitude }]), null);
    }

    const nextUnit = makeRandom(0x51eed123);

    for (let i = 0; i < 100; i++) {
        const latitude = nextUnit() * 180 - 90;
        const longitude = nextUnit() * 360 - 180;
        const place = Weather.nominatimGeocodePlace([{
            lat: latitude.toString(),
            lon: longitude.toString(),
            display_name: "fuzz"
        }]);

        assert.equal(place.latitude, latitude);
        assert.equal(place.longitude, longitude);
    }
});

// Synthetic namesakes pin the ranking independently from the live provider data.
const GENOVA_RESULTS = {
    results: [
        { name: "Génova", country: "Guatemala", population: 3744, latitude: 14.6, longitude: -91.8 },
        { name: "Génova", country: "Colombia", population: 7140, latitude: 4.2, longitude: -75.8 },
        { name: "Genova", country: "Italy", population: 580097, latitude: 44.4, longitude: 8.9 },
        { name: "Genova", country: "Italy", population: 30, latitude: 45.9, longitude: 9.3 }
    ]
};

test("the geocode hit is the one the user typed, not the one the API ranked first", () => {
    const Weather = loadWeather();

    const genova = Weather.openMeteoGeocodePlace(GENOVA_RESULTS, "Genova");
    assert.equal(genova.name, "Genova");
    assert.equal(genova.latitude, 44.4);
    // the exact spelling beats the accented namesakes, and among the two cities
    // that spell it the same the half-million one beats the hamlet
    assert.equal(genova.longitude, 8.9);

    // typed with the accent, the answer is the accented city — the largest of them
    const genovaAccented = Weather.openMeteoGeocodePlace(GENOVA_RESULTS, "Génova");
    assert.equal(genovaAccented.latitude, 4.2);

    // a name nobody matches falls back to the most populous hit rather than to
    // whichever one the geocoder happened to put first
    const unmatched = Weather.openMeteoGeocodePlace(GENOVA_RESULTS, "nowhere");
    assert.equal(unmatched.latitude, 44.4);

    // a hit with no usable coordinates is skipped, not returned
    const skipped = Weather.openMeteoGeocodePlace({
        results: [null, { name: "Genova", latitude: "x", longitude: 8.9 },
            { name: "Genova", country: "Italy", population: 1000, latitude: 44.4, longitude: 8.9 }]
    }, "Genova");
    assert.equal(skipped.latitude, 44.4);
    assert.equal(Weather.openMeteoGeocodePlace({ results: [{ latitude: "x", longitude: 1 }] }, "x"), null);

    // an unranked payload cannot be trusted over the fallback geocoder
    assert.equal(
        Weather.openMeteoGeocodePlace({ results: [{ latitude: 41.9, longitude: 12.5, population: "many" }] }),
        null
    );
});

test("Open-Meteo places drop provider fields before entering the cache", () => {
    const Weather = loadWeather();
    const junk = "x".repeat(1024 * 1024);
    const place = Weather.openMeteoGeocodePlace({ results: [{
        name: "Rome",
        latitude: 41.9,
        longitude: 12.5,
        population: 2873000,
        timezone: "Europe/Rome",
        provider_payload: { junk }
    }] }, "Rome");

    assert.deepEqual(place, { name: "Rome", latitude: 41.9, longitude: 12.5 });
    assert.equal(JSON.stringify(place).includes(junk), false);
});

const LOCALE_VARIABLES = ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"];

function withLocaleEnvironment(locale, assertions) {
    const saved = LOCALE_VARIABLES.map((name) => [name, process.env[name]]);
    LOCALE_VARIABLES.forEach((name) => delete process.env[name]);
    if (locale) {
        process.env.LANG = locale;
    }

    try {
        assertions();
    } finally {
        saved.forEach(([name, value]) => {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        });
    }
}

test("the geocoder is asked in the language the session runs in", () => {
    const Weather = loadWeather();

    assert.equal(Weather.geocodeLanguage("pt_BR.UTF-8"), "pt");
    assert.equal(Weather.geocodeLanguage("it"), "it");
    // a locale that names no language, or names it in more than two letters, is
    // not a language the geocoder knows: ask in English rather than in nonsense
    assert.equal(Weather.geocodeLanguage("C"), Weather.GEOCODE_LANGUAGE_FALLBACK);
    assert.equal(Weather.geocodeLanguage("POSIX"), "en");

    // no locale given: the session's own is what the search is run in
    withLocaleEnvironment("de_DE.UTF-8", () => {
        assert.equal(Weather.geocodeLanguage(), "de");
    });
    withLocaleEnvironment("", () => {
        assert.equal(Weather.geocodeLanguage(), "en");
    });
});

function assertNullOrFinitePlace(place) {
    if (place === null) {
        return;
    }

    assert.equal(typeof place, "object");
    assert.equal(Number.isFinite(place.latitude), true);
    assert.equal(Number.isFinite(place.longitude), true);
    assert.ok(place.latitude >= -90 && place.latitude <= 90);
    assert.ok(place.longitude >= -180 && place.longitude <= 180);
}

test("geocode parsers fuzz malformed payloads without throwing", () => {
    const Weather = loadWeather();
    const rand = makeRandom(0x9e0c0de);
    const scalars = [
        null, undefined, "", "12.5", "Infinity", "NaN", "999", 0, 42, 999,
        Infinity, NaN, true, false, []
    ];

    function pick(list) {
        return list[Math.floor(rand() * list.length)];
    }

    for (let i = 0; i < 300; i++) {
        const lat = rand() < 0.35 ? (rand() * 180 - 90).toString() : pick(scalars);
        const lon = rand() < 0.35 ? (rand() * 360 - 180).toString() : pick(scalars);
        const entry = pick([
            null,
            undefined,
            "not an object",
            [],
            { latitude: lat, longitude: lon, display_name: "open" },
            { lat, lon, display_name: "fallback" },
            { latitude: { nested: lat }, longitude: lon },
            { lat, lon: { nested: lon } }
        ]);

        assert.doesNotThrow(() => {
            assertNullOrFinitePlace(Weather.openMeteoGeocodePlace(pick([
                null,
                undefined,
                [],
                { results: null },
                { results: "not an array" },
                { results: [entry] },
                { results: [entry, { latitude: "1", longitude: "2" }] }
            ])));
        });

        assert.doesNotThrow(() => {
            assertNullOrFinitePlace(Weather.nominatimGeocodePlace(pick([
                null,
                undefined,
                {},
                "not an array",
                [entry],
                [entry, { lat: "1", lon: "2" }]
            ])));
        });
    }
});

test("supports selectable SI and imperial weather units", () => {
    const Weather = loadWeather();

    for (const units of ["si", "metric", "", null, undefined]) {
        assert.equal(Weather.normalizeUnits(units), "si");
        assert.equal(shown(Weather.weatherReading({ weathercode: 1, temperature: 20.2 }), units), "⛅ 20°C");
    }

    assert.equal(Weather.normalizeUnits("imperial"), "imperial");
    // the temperature is Celsius now (Open-Meteo is asked for Celsius); imperial
    // converts it: 20 °C is 68 °F
    assert.equal(shown(Weather.weatherReading({ weathercode: 1, temperature: 20 }), "imperial"), "⛅ 68°F");

    const schema = JSON.parse(fs.readFileSync(schema52Path, "utf8"));
    assert.equal(schema["weather-units"].default, "si");
    assert.deepEqual(Object.values(schema["weather-units"].options).sort(), ["imperial", "si"]);
});

test("the forecast normalizers return a unit-free reading record", () => {
    const Weather = loadWeather();

    // the record is Celsius and glyph, with no unit decision made yet — one
    // record renders to either unit
    assert.deepEqual(Weather.weatherReading({ weathercode: 0, temperature: 21.4 }),
        { condition: "☀", temperatureC: 21.4 });
    assert.equal(Weather.weatherReading({ weathercode: 0, temperature: NaN }), null);
    assert.equal(Weather.weatherReading(null), null);

    const stations = [{ lat: 41.8, lon: 12.25, temp: 18, cover: "SCT" }];
    assert.deepEqual(Weather.aviationWeatherReading(stations, { latitude: 41.9, longitude: 12.5 }),
        { condition: "⛅", temperatureC: 18 });
    assert.equal(Weather.aviationWeatherReading([], { latitude: 0, longitude: 0 }), null);

    const forecast = { properties: { timeseries: [{ data: {
        instant: { details: { air_temperature: 7.4 } },
        next_1_hours: { summary: { symbol_code: "snow" } }
    } }] } };
    assert.deepEqual(Weather.metNoWeatherReading(forecast), { condition: "🌨", temperatureC: 7.4 });
    assert.equal(Weather.metNoWeatherReading({}), null);

    // and the string form is that record rendered at the caller's unit
    assert.equal(shown(Weather.weatherReading({ weathercode: 0, temperature: 21.4 }), "si"), "☀ 21°C");
    assert.equal(shown(Weather.weatherReading({ weathercode: 0, temperature: 21.4 }), "imperial"), "☀ 71°F");
});

test("formats weather text and maps every fuzzed weather code to an icon", () => {
    const Weather = loadWeather();

    assert.equal(shown(Weather.weatherReading({ weathercode: 0, temperature: 21.4 }), "metric"), "☀ 21°C");
    // 21.7 °C converts to 71 °F
    assert.equal(shown(Weather.weatherReading({ weathercode: 63, temperature: 21.7 }), "imperial"), "🌧 71°F");
    assert.equal(shown(Weather.weatherReading(null), "metric"), "");

    // a degraded Open-Meteo station reports no temperature; rounding that
    // gives "NaN°C", which the provider chain would read as an answer
    for (const missing of [null, undefined, "warm", NaN, Infinity]) {
        assert.equal(shown(Weather.weatherReading({ weathercode: 0, temperature: missing }), "metric"), "",
            `a temperature of ${String(missing)} is no reading at all`);
    }

    // WMO 95-99 are thunderstorms — the most severe codes must never
    // render as fair weather
    for (const code of [95, 96, 97, 98, 99]) {
        assert.equal(Weather.weatherIcon(code), "⛈");
    }

    const nextUnit = makeRandom(0xc10c1e5);
    const nextCode = () => Math.floor(nextUnit() * 140);

    for (let i = 0; i < 200; i++) {
        const code = nextCode();
        const icon = Weather.weatherIcon(code);
        assert.equal(typeof icon, "string");
        assert.ok(icon.length > 0);
        if (code >= 95 && code <= 99) {
            assert.equal(icon, "⛈");
        } else {
            assert.notEqual(icon, "⛈");
        }
    }

    // ...and the weathercode does not arrive as a tidy integer. It comes off
    // Open-Meteo's JSON, which is a degraded or hostile endpoint away from
    // handing over a string, a float, a negative, or nothing at all — and
    // weatherText passes whatever it finds straight to weatherIcon.
    const junk = ["63", "", "  95 ", null, undefined, NaN, Infinity, -1, -0.5,
        63.7, 1e9, true, false, {}, [], [63], () => 63];

    for (const code of junk) {
        const icon = Weather.weatherIcon(code);
        assert.equal(typeof icon, "string", `weatherIcon(${String(code)}) must be a string`);
        assert.ok(icon.length > 0, `weatherIcon(${String(code)}) must not be empty`);
    }
});

test("formats MET.no forecast data with SI and imperial units", () => {
    const Weather = loadWeather();
    const forecast = {
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
    };

    assert.equal(Weather.metNoIcon("clearsky_day"), "☀");
    assert.equal(Weather.metNoIcon("partlycloudy_night"), "⛅");
    assert.equal(Weather.metNoIcon("heavyrainshowers_day"), "🌦");
    assert.equal(Weather.metNoIcon("snow"), "🌨");
    assert.equal(Weather.metNoIcon("rainshowersandthunder_day"), "⛈");
    assert.equal(Weather.metNoIcon("heavysnowandthunder"), "⛈");
    assert.equal(shown(Weather.metNoWeatherReading(forecast), "si"), "🌧 10°C");
    assert.equal(shown(Weather.metNoWeatherReading(forecast), "imperial"), "🌧 51°F");
    assert.equal(shown(Weather.metNoWeatherReading({}), "si"), "");

    for (const symbol of ["clearsky", "fair", "partlycloudy", "cloudy", "fog", "rain", "drizzle", "sleet", "snow", "rainshowers", "unknown"]) {
        const icon = Weather.metNoIcon(symbol);
        assert.equal(typeof icon, "string");
        assert.ok(icon.length > 0);
    }
});

test("MET.no summaries fall back through longer forecast horizons", () => {
    const Weather = loadWeather();

    function forecastWith(data) {
        return { properties: { timeseries: [{ data }] } };
    }
    const instant = { details: { air_temperature: 3.6 } };

    assert.equal(shown(Weather.metNoWeatherReading(forecastWith({
        instant,
        next_6_hours: { summary: { symbol_code: "snow" } }
    })), "si"), "🌨 4°C");
    assert.equal(shown(Weather.metNoWeatherReading(forecastWith({
        instant,
        next_12_hours: { summary: { symbol_code: "cloudy" } }
    })), "si"), "☁ 4°C");
    assert.equal(shown(Weather.metNoWeatherReading(forecastWith({ instant })), "si"), "🌤 4°C");
    assert.equal(shown(Weather.metNoWeatherReading(forecastWith({
        next_1_hours: { summary: { symbol_code: "rain" } }
    })), "si"), "");
    assert.equal(shown(Weather.metNoWeatherReading(forecastWith(null)), "si"), "");
});

test("MET.no forecast parser fuzzes truncated payloads without throwing", () => {
    const Weather = loadWeather();
    const rand = makeRandom(0x6d37);
    const values = [null, undefined, "", "10", NaN, Infinity, -Infinity, {}, [], true];
    const summaries = [
        null,
        {},
        { summary: null },
        { summary: {} },
        { summary: { symbol_code: "rain" } },
        { summary: { symbol_code: "snow" } },
        { summary: { symbol_code: 42 } }
    ];

    function pick(list) {
        return list[Math.floor(rand() * list.length)];
    }

    for (let i = 0; i < 300; i++) {
        const temperature = rand() < 0.35 ? (rand() * 80 - 40) : pick(values);
        const instant = pick([
            null,
            {},
            { details: null },
            { details: {} },
            { details: { air_temperature: temperature } }
        ]);
        const data = pick([
            null,
            undefined,
            "not data",
            {},
            {
                instant,
                next_1_hours: pick(summaries),
                next_6_hours: pick(summaries),
                next_12_hours: pick(summaries)
            }
        ]);
        const point = pick([null, undefined, "not point", {}, { data }]);
        const forecast = pick([
            null,
            undefined,
            {},
            { properties: null },
            { properties: {} },
            { properties: { timeseries: null } },
            { properties: { timeseries: "not an array" } },
            { properties: { timeseries: [] } },
            { properties: { timeseries: [point] } },
            { properties: { timeseries: [point, { data: { instant: { details: { air_temperature: 12 } } } }] } }
        ]);

        assert.doesNotThrow(() => {
            const text = shown(Weather.metNoWeatherReading(forecast), rand() < 0.5 ? "si" : "imperial");
            assert.equal(typeof text, "string");
            assert.ok(text === "" || /^[^\s]+ -?\d+°[CF]$/.test(text), `unexpected text: ${text}`);
        });
    }
});

// Regression: these were exported as `class` / `const`. GJS's importer only
// exposes top-level var and function declarations, so the module that read them
// got undefined and the applet died with "WeatherForecastResolver is not a
// constructor". They are asserted in the module that declares each one — which is
// the module GJS consumers import, now that the barrel no longer aliases them.
test("regression: the resolvers and the refresh period are var bindings", () => {
    const declared = {
        weatherProviders: ["WeatherLocationResolver", "WeatherForecastResolver",
            "WeatherReadingRepository"],
        weather: ["WeatherReadingRepository"],
        weatherFormat: ["REFRESH_SECONDS"]
    };

    for (const [moduleName, names] of Object.entries(declared)) {
        const source = fs.readFileSync(path.join(
            __dirname, "..", "files", "chronos@geraldo-netto", moduleName + ".js"), "utf8");
        for (const name of names) {
            assert.match(source, new RegExp("^var " + name + "\\b", "m"),
                name + " must be declared with var to survive the GJS importer");
            assert.doesNotMatch(source, new RegExp("^(?:const|let|class)\\s+" + name + "\\b", "m"));
        }
    }
});

// weather.js is a barrel now: the numbers and words, the refresh clock and the
// provider chains each live in their own module. weather.js requires all three
// and adds WeatherProvider + WeatherDisplayState on top. This pins that shape so
// a future edit cannot quietly inline a part back or drop one of the requires.
test("weather.js composes display, adapters, scheduling and resolvers", () => {
    const source = fs.readFileSync(modulePath, "utf8");
    for (const dep of ["weatherFormat", "weatherServiceAdapters",
        "weatherScheduler", "weatherProviders"]) {
        assert.match(source, new RegExp('require\\("\\./' + dep + '"\\)'),
            "weather.js must require " + dep);
    }

    const Weather = loadWeather();
    // a symbol that originates in each part reaches consumers through the barrel
    assert.equal(typeof Weather.staleAfterSeconds, "function", "carried on from weatherFormat");
    assert.equal(typeof Weather.geocodeUrl, "function", "carried on from weatherServiceAdapters");
    assert.equal(typeof Weather.WeatherRefreshScheduler, "function", "carried on from weatherScheduler");
    assert.equal(typeof Weather.WeatherForecastResolver, "function", "carried on from weatherProviders");
    assert.equal(typeof Weather.WeatherReadingRepository, "function", "shared reading repository");
    // ...and weather.js's own two additions
    assert.equal(typeof Weather.WeatherProvider, "function");
    assert.equal(typeof Weather.WeatherDisplayState, "function");
});

test("weather display rules do not own vendor wire contracts", () => {
    const displaySource = fs.readFileSync(path.join(
        __dirname, "..", "files", "chronos@geraldo-netto", "weatherFormat.js"), "utf8");
    const display = require(path.join(
        __dirname, "..", "files", "chronos@geraldo-netto", "weatherFormat.js"));
    const adapters = require(serviceAdaptersPath);

    assert.doesNotMatch(displaySource, /open-meteo|nominatim|aviationweather|api\.met\.no/i);
    assert.equal(display.geocodeUrl, undefined);
    assert.equal(display.weatherReading, undefined);
    assert.equal(display.formatReading, undefined);
    assert.equal(typeof display.formatTemperature, "function");
    assert.equal(typeof adapters.geocodeUrl, "function");
    assert.equal(typeof adapters.weatherReading, "function");
});

// pick the nearest station that carries a usable temperature, whatever the
// service put in the rest of the payload
// an oracle written from the METAR contract, not from the module: a reading is
// a number or a non-blank numeric string, and nothing else. Number() would call
// null, "" and [] a valid 0.
function usableNumber(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return null;
}

// regression: aviationweather.gov sends "temp": null for a station with nothing
// to report, and Number(null) is 0. The nearest-station race used to hand that
// station the win and the panel showed a fabricated 0°C.
test("a METAR station with no temperature never wins the nearest-station race", () => {
    const Weather = loadWeather();
    const place = { latitude: 48.85, longitude: 2.35 };

    const stations = [
        { icaoId: "SILENT", lat: 48.85, lon: 2.35, temp: null, cover: "CLR" },
        { icaoId: "BLANK", lat: 48.86, lon: 2.36, temp: "", cover: "CLR" },
        { icaoId: "REPORTING", lat: 49.6, lon: 3.1, temp: 14, cover: "SCT" }
    ];

    assert.equal(Weather.aviationWeatherStation(stations, place).icaoId, "REPORTING");
    assert.equal(shown(Weather.aviationWeatherReading(stations, place), "si"), "⛅ 14°C");

    // and a station whose coordinates are missing is not sitting at Null Island
    assert.equal(Weather.aviationWeatherStation(
        [{ icaoId: "NOWHERE", lat: null, lon: null, temp: 5 }], place), null);

    assert.equal(Weather.metarNumber(null), null);
    assert.equal(Weather.metarNumber(""), null);
    assert.equal(Weather.metarNumber([]), null);
    assert.equal(Weather.metarNumber(false), null);
    assert.equal(Weather.metarNumber("  "), null);
    assert.equal(Weather.metarNumber("-3"), -3);
    assert.equal(Weather.metarNumber(0), 0);
});

// null, "" and [] belong in here: Number() coerces all three to 0, and a station
// with "temp": null used to be read as a real 0 °C reading at Null Island, where
// it could win the nearest-station race.
const JUNK_TEMPS = [undefined, null, "", [], false, "warm", "12abc", NaN, {}, true];
const JUNK_COORDS = [undefined, null, "", [], "north", NaN, Infinity, {}];
const FUZZ_PLACE = { latitude: 48.85, longitude: 2.35 };

function pickFrom(rand, list) {
    return list[Math.floor(rand() * list.length)];
}

// One METAR station as the service might send it: usually usable, sometimes junk,
// sometimes not an object at all.
function fuzzStation(rand) {
    if (rand() < 0.12) {
        return pickFrom(rand, [null, undefined, "SBSP", 42, []]);
    }

    const station = {
        lat: rand() < 0.75 ? FUZZ_PLACE.latitude + (rand() * 2 - 1) : pickFrom(rand, JUNK_COORDS),
        lon: rand() < 0.75 ? FUZZ_PLACE.longitude + (rand() * 2 - 1) : pickFrom(rand, JUNK_COORDS),
        cover: pickFrom(rand, ["CLR", "FEW", "SCT", "BKN", "OVC", "", 7, undefined]),
        wxString: pickFrom(rand, ["RA", "TSRA", "SN", "BR", "", 3, undefined])
    };

    if (rand() < 0.7) {
        station.temp = rand() < 0.85 ?
            Math.round(rand() * 80 - 40) : String(Math.round(rand() * 40 - 10));
    } else if (rand() < 0.8) {
        station.temp = pickFrom(rand, JUNK_TEMPS);
    }

    return station;
}

// a station is usable when all three fields it is read for are readable numbers
function stationIsUsable(candidate) {
    return Boolean(candidate) && typeof candidate === "object" &&
        usableNumber(candidate.temp) !== null &&
        usableNumber(candidate.lat) !== null &&
        usableNumber(candidate.lon) !== null;
}

// What the readout must say for a chosen station. METAR temperatures are Celsius
// by definition, so only imperial converts.
function expectedStationText(Weather, station, units) {
    if (!station) {
        return "";
    }

    const celsius = usableNumber(station.temp);
    const value = units === "imperial" ? Math.round(celsius * 9 / 5 + 32) : Math.round(celsius);
    return `${Weather.aviationWeatherIcon(station)} ${value}${units === "imperial" ? "°F" : "°C"}`;
}

// Properties, not a second implementation. The oracle here used to reimplement
// aviationWeatherStation's selection loop line for line, so a shared
// misunderstanding — both treating lat: "0" as usable when it should be rejected —
// agreed with itself and passed.
function assertStationRound(Weather, stations, units) {
    let station;
    let text;

    assert.doesNotThrow(() => {
        station = Weather.aviationWeatherStation(stations, FUZZ_PLACE);
        text = shown(Weather.aviationWeatherReading(stations, FUZZ_PLACE), units);
    });

    // it never invents a station, and never picks one it cannot read...
    assert.equal(station === null || stationIsUsable(station), true,
        "the chosen station must be readable");
    assert.equal(station === null || stations.includes(station), true,
        "and it must be one it was given");

    // ...and it finds one whenever one exists: the filter, checked without
    // reference to how the nearest is chosen
    assert.equal(station !== null, stations.some(stationIsUsable),
        "a usable station exists exactly when one is returned");

    // the readout says what the chosen station says, or says nothing
    assert.equal(text, expectedStationText(Weather, station, units));

    // asking twice answers the same
    assert.equal(Weather.aviationWeatherStation(stations, FUZZ_PLACE), station);
}

test("aviation weather fuzzes malformed station payloads without throwing", () => {
    const Weather = loadWeather();
    const rand = makeRandom(0xa71a7104);
    const place = FUZZ_PLACE;

    for (let i = 0; i < 400; i++) {
        const stations = Array.from({ length: Math.floor(rand() * 6) }, () => fuzzStation(rand));
        const units = rand() < 0.5 ?
            "imperial" : pickFrom(rand, ["si", "metric", undefined, null]);

        assertStationRound(Weather, stations, units);
    }

    // A station standing exactly where the user is must win, whatever else is in
    // the box. This is the one thing about the *choice* that can be asserted
    // without rebuilding the distance metric — and a metric that got the sign
    // wrong, or compared the wrong fields, would fail it.
    for (let i = 0; i < 50; i++) {
        const decoys = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({
            lat: place.latitude + 0.5 + rand(),
            lon: place.longitude + 0.5 + rand(),
            temp: Math.round(rand() * 30)
        }));
        const here = { lat: place.latitude, lon: place.longitude, temp: 7, name: "here" };
        const shuffled = decoys.concat([here]).sort(() => (rand() < 0.5 ? -1 : 1));

        assert.equal(Weather.aviationWeatherStation(shuffled, place), here,
            "the station at the user's own coordinates is the nearest one there is");
    }

    // an empty box and a service that answered with something other than a list
    for (const empty of [[], null, undefined, {}, "no stations"]) {
        assert.equal(Weather.aviationWeatherStation(empty, place), null);
        assert.equal(shown(Weather.aviationWeatherReading(empty, place), "si"), "");
    }

    // a station without a temperature is skipped even when it is the closest one
    const stations = [
        { icaoId: "LFPB", lat: 48.85, lon: 2.35, cover: "CLR" },
        { icaoId: "LFPG", lat: 49.01, lon: 2.55, temp: 10, cover: "OVC" }
    ];
    assert.equal(Weather.aviationWeatherStation(stations, place).icaoId, "LFPG");
    assert.equal(shown(Weather.aviationWeatherReading(stations, place), "si"), "☁ 10°C");
    assert.equal(shown(Weather.aviationWeatherReading(stations, place), "imperial"), "☁ 50°F");
});

test("provider sessions carry an explicit HTTP timeout", () => {
    const Weather = loadWeather();
    const provider = new Weather.WeatherProvider();

    // weather is off by default, so the session is built when something first
    // asks for it — not once per applet at startup for every user who never
    // turns weather on
    assert.equal(provider._session.created, null);

    const session = provider._getHttpSession();
    assert.equal(session.timeout, Weather.HTTP_TIMEOUT_SECONDS);
    assert.equal(session.idle_timeout, Weather.HTTP_TIMEOUT_SECONDS);
    assert.equal(provider._getHttpSession(), session, "and it is built once");
    assert.ok(Weather.HTTP_TIMEOUT_SECONDS > 0);
});

// The HTTP adapter was bypassable in CityWeatherProvider and mandatory here: a
// caller that injected httpGetJson still got a live Soup session it could never
// use. The two halves of one feature take the same seam now.
test("a provider given its HTTP is not handed a session it cannot use", () => {
    const Weather = loadWeather();
    const injected = new Weather.WeatherProvider({ httpGetJson() {} });
    assert.equal(injected._session.created, null);

    const session = { abort() { this.aborted = true; } };
    const given = new Weather.WeatherProvider({ httpSession: session });
    assert.equal(given._getHttpSession(), session, "and a session it is given is the one it uses");

    given.destroy();
    assert.equal(session.aborted, true);
});
