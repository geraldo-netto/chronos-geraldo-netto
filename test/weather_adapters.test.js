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
    // a METAR carrying neither present weather nor a cover group describes no
    // sky at all, and "FEW" above is a real cover that cannot double for it
    assert.equal(Weather.aviationWeatherIcon({}), Weather.WEATHER_UNKNOWN_CONDITION);
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

test("seam METAR payloads are merged before nearest-station ranking", () => {
    const Weather = loadWeather();
    const pending = [];
    const provider = Weather.FORECAST_PROVIDERS.find(
        (candidate) => candidate.name === Weather.WEATHER_PROVIDER_NAMES.AVIATION_WEATHER);
    const resolver = new Weather.WeatherForecastResolver({
        providers: [provider],
        httpGetJson(url, callback, options) {
            pending.push({ url, callback, options });
        }
    });
    const answers = [];

    resolver.refresh({ latitude: 0.5, longitude: 179.8 }, () => true,
        (reading, error, name) => answers.push({ reading, error, name }));

    assert.equal(pending.length, 2);
    assert.ok(pending[0].url.includes("178.800%2C"));
    assert.ok(pending[1].url.includes("-180.000%2C"));
    assert.deepEqual(pending.map((request) => request.options),
        [provider.options, provider.options]);

    // The across-seam reply arrives first. It must wait for the eastern half;
    // only then can one ranking compare every returned station.
    pending[1].callback([
        { icaoId: "NEAR", lat: 0.5, lon: -179.7, temp: 21, cover: "CLR" }
    ]);
    assert.equal(answers.length, 0);
    pending[0].callback([
        { icaoId: "FAR", lat: 0.5, lon: 179.0, temp: 25, cover: "BKN" }
    ]);

    assert.equal(answers.length, 1);
    assert.deepEqual({
        text: shown(answers[0].reading, "si"),
        error: answers[0].error,
        name: answers[0].name
    }, { text: "☀ 21°C", error: "", name: provider.name });
});

test("weather location whitespace agrees with settings", () => {
    const Weather = loadWeather();
    const cases = require("./fixtures/settings_whitespace_cases.json");
    for (const entry of cases) {
        assert.equal(Weather.normalizeWeatherLocation(entry.input), entry.weatherLocation);
    }
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
        Weather.nominatimGeocodeUrl(" New York ", "en_US.UTF-8"),
        "https://nominatim.openstreetmap.org/search?q=New%20York&format=json&limit=" +
        Weather.GEOCODE_CANDIDATE_COUNT + "&accept-language=en"
    );
    // the fallback geocoder is asked in the session language too, or the
    // Genova/Génova mismatch comes back whenever Open-Meteo is the one that fails
    assert.equal(
        Weather.nominatimGeocodeUrl("Genova", "it_IT.UTF-8"),
        "https://nominatim.openstreetmap.org/search?q=Genova&format=json&limit=" +
        Weather.GEOCODE_CANDIDATE_COUNT + "&accept-language=it"
    );
    assert.equal(Weather.locationCacheKey(" New York "), "new york");
    const maximum = Weather.MAX_WEATHER_LOCATION_LENGTH;
    const exact = "x".repeat(maximum);
    const unicodeExact = "🎉".repeat(maximum);
    for (const location of [exact, unicodeExact]) {
        assert.equal(Weather.normalizeWeatherLocation(location), location);
        assert.notEqual(Weather.geocodeUrl(location, "en"), "");
        assert.notEqual(Weather.nominatimGeocodeUrl(location, "en"), "");
        assert.equal(Weather.locationCacheKey(location), location.toLowerCase());
    }
    for (const location of [
        "x".repeat(maximum + 1),
        "🎉".repeat(maximum + 1),
        " " + exact
    ]) {
        assert.equal(Weather.normalizeWeatherLocation(location), "");
        assert.equal(Weather.geocodeUrl(location, "en"), "");
        assert.equal(Weather.nominatimGeocodeUrl(location, "en"), "");
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
        { name: "", latitude: 41.9, longitude: 12.5, timezone: "" }
    );
    assert.equal(Weather.openMeteoGeocodePlace({
        results: [{ latitude: 41.9, longitude: 12.5, population: 999 }]
    }), null, "a tiny result is left for the fallback geocoder to arbitrate");
    assert.equal(Weather.openMeteoGeocodePlace({ results: [] }), null);
    assert.deepEqual(
        Weather.nominatimGeocodePlace([{ lat: "41.9", lon: "12.5", display_name: "Rome, Italy" }]),
        { name: "Rome, Italy", latitude: 41.9, longitude: 12.5 }
    );
    for (const displayName of [null, undefined, 7, {}, []]) {
        assert.deepEqual(Weather.nominatimGeocodePlace([{
            lat: "41.9", lon: "12.5", display_name: displayName
        }]), { name: "", latitude: 41.9, longitude: 12.5 });
    }
    const hostileName = "x".repeat(1024 * 1024);
    const boundedName = Weather.nominatimGeocodePlace([{
        lat: "41.9", lon: "12.5", display_name: hostileName
    }]).name;
    assert.equal(Array.from(boundedName).length, Weather.MAX_GEOCODE_PLACE_NAME_LENGTH);
    assert.ok(boundedName.endsWith("…"));
    assert.equal(boundedName.includes(hostileName), false);
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
        }), { name: "", latitude: Number(latitude), longitude: Number(longitude), timezone: "" });
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

// The ranking has to survive the spelling the user's keyboard can produce. Each
// row pits the real city against a *more populous* decoy whose name does not
// match, so only the fold can pick the right one — population alone would pick
// the decoy every time.
const FOLDED_MATCH_CASES = [
    ["Sao Paulo", "São Paulo", "Sao Paulo Norte", "a Latin accent"],
    ["Strasse", "Straße", "Strasserhof", "a letter with no decomposition"],
    ["Tromso", "Tromsø", "Tromsoya", "a slashed vowel"],
    ["Lodz", "Łódź", "Lodzko", "a barred consonant"],
    ["Izmir", "İzmir", "Izmirli", "a dotted capital I"],
    ["Thorshavn", "Þórshavn", "Thorshavnfjord", "a thorn"],
    ["ＴＯＫＹＯ", "Tokyo", "Tokyorama", "a full-width compatibility form"],
    ["Hawaii", "Hawaiʻi", "Hawaiian Gardens", "an okina"],
    ["Saint Etienne", "Saint-Étienne", "Saint Etiennette", "a hyphen for a space"],
    ["Θεσσαλονικης", "Θεσσαλονίκης", "Θεσσαλονικαια", "a Greek tonos and final sigma"],
    ["القاهرة", "اَلْقَاهِرَة", "القاهرةالجديدة", "Arabic harakat"],
    ["ירושלים", "יְרוּשָׁלַיִם", "ירושליםעילית", "Hebrew niqqud"]
];

test("a place matches the spelling a keyboard can produce", () => {
    const Weather = loadWeather();

    for (const [typed, city, decoy, why] of FOLDED_MATCH_CASES) {
        const place = Weather.openMeteoGeocodePlace({ results: [
            { name: decoy, population: 9000000, latitude: 1, longitude: 2 },
            { name: city, population: 100000, latitude: 3, longitude: 4 }
        ] }, typed);

        assert.equal(place && place.name, city,
            `${why}: "${typed}" must reach "${city}" rather than the larger "${decoy}"`);
    }
});

// ...and the fold has to stop where marks stop being decoration. An Indic vowel
// sign and a Japanese dakuten are letters, so a name that differs only by one
// is a *different* name and must not be promoted over an unrelated larger hit.
//
// The mark-differing hit is deliberately the smaller one and the query matches
// neither exactly, so the ranking's exact tier cannot decide it: only the fold
// can, and a fold that stripped these marks would answer the small one.
const DISTINCT_BY_MARK_CASES = [
    ["मुंबइ", "मंबइ", "ठाणे", "an Indic vowel sign"],
    ["カワ", "ガワ", "トウキョウ", "a Japanese dakuten"]
];

test("the fold leaves marks that are letters alone", () => {
    const Weather = loadWeather();

    for (const [typed, nearby, larger, why] of DISTINCT_BY_MARK_CASES) {
        const place = Weather.openMeteoGeocodePlace({ results: [
            { name: nearby, population: 100000, latitude: 1, longitude: 2 },
            { name: larger, population: 9000000, latitude: 3, longitude: 4 }
        ] }, typed);

        assert.equal(place && place.name, larger,
            `${why} distinguishes two names, so "${nearby}" must not read as "${typed}"`);
    }
});

test("Open-Meteo places retain app-owned observer fields and drop provider payloads", () => {
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

    assert.deepEqual(place,
        { name: "Rome", latitude: 41.9, longitude: 12.5, timezone: "Europe/Rome" });
    assert.equal(JSON.stringify(place).includes(junk), false);

    const bounded = Weather.openMeteoGeocodePlace({ results: [{
        name: junk,
        latitude: 41.9,
        longitude: 12.5,
        population: 2873000
    }] }, junk);
    assert.equal(Array.from(bounded.name).length, Weather.MAX_GEOCODE_PLACE_NAME_LENGTH);
    assert.ok(bounded.name.endsWith("…"));
});


// T791: this used to set process.env and read it back, which is a path
// Cinnamon cannot take — cjs has no `process`. g_get_language_names() is what
// production reads, and it has already applied the LC_ALL/LC_MESSAGES/LANG/
// LANGUAGE precedence in the order the C library defines. It is documented
// always to include the default locale, so "no locale set" is ["C"], not [].
function withSessionLocale(locale, assertions) {
    const GLib = global.imports.gi.GLib;
    const saved = GLib.get_language_names;
    GLib.get_language_names = () => (locale ? [locale, "C"] : ["C"]);

    try {
        assertions();
    } finally {
        GLib.get_language_names = saved;
    }
}

test("the geocoder normalizes an injected language and has an inert default", () => {
    const Weather = loadWeather();

    assert.equal(Weather.geocodeLanguage("pt_BR.UTF-8"), "pt");
    assert.equal(Weather.geocodeLanguage("it"), "it");
    // a locale that names no language, or names it in more than two letters, is
    // not a language the geocoder knows: ask in English rather than in nonsense
    assert.equal(Weather.geocodeLanguage("C"), "en");
    assert.equal(Weather.geocodeLanguage("POSIX"), "en");

    // A bare wire adapter owns no desktop state. The composition root injects
    // the live message language into the resolver that calls it.
    withSessionLocale("de_DE.UTF-8", () => {
        assert.equal(Weather.geocodeLanguage(), "en");
    });
    withSessionLocale("", () => {
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
        assert.equal(shown(Weather.weatherReading({ weathercode: 2, temperature: 20.2 }), units), "⛅ 20°C");
    }

    assert.equal(Weather.normalizeUnits("imperial"), "imperial");
    // the temperature is Celsius now (Open-Meteo is asked for Celsius); imperial
    // converts it: 20 °C is 68 °F
    assert.equal(shown(Weather.weatherReading({ weathercode: 2, temperature: 20 }), "imperial"), "⛅ 68°F");

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

    // T946: every reading record is `{ condition, temperatureC }` whichever
    // provider made it. The zone the Open-Meteo reply carries is a fact about
    // the place, and it used to be spread onto the reading - so the record's
    // own shape depended on which provider in the failover chain answered.
    assert.deepEqual(Weather.openMeteoReading({
        timezone: "America/Sao_Paulo",
        current_weather: { weathercode: 0, temperature: 21.4 }
    }), { condition: "☀", temperatureC: 21.4 });
    assert.equal(Weather.openMeteoReading({
        timezone: "America/Sao_Paulo",
        current_weather: { weathercode: 0, temperature: null }
    }), null, "a degraded station is still a failover, zone or no zone");

    // forecastUrl asks timezone=auto, so the reply names the zone of the point
    // it describes — the only authoritative zone for a place Nominatim
    // resolved, and it was being thrown away. It is answered on its own channel.
    assert.equal(Weather.openMeteoTimezone({ timezone: "America/Sao_Paulo" }),
        "America/Sao_Paulo");
    assert.equal(Weather.openMeteoTimezone({}), "",
        "a reply without a zone names none");
    assert.equal(Weather.openMeteoTimezone({ timezone: 7 }), "",
        "and a non-string zone is no zone, not its coercion");
    assert.equal(Weather.openMeteoTimezone(null), "");

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

    // T827: bare `<=` comparisons coerce, so `null` and `-1` read as clear sky
    // and every other unrecognised value read as a confident "Fair" —
    // indistinguishable in the panel from a real reading. None of these is a
    // published code, so none of them describes a sky.
    for (const code of junk) {
        const icon = Weather.weatherIcon(code);
        assert.equal(icon, Weather.WEATHER_UNKNOWN_CONDITION,
            `weatherIcon(${String(code)}) must not read as weather`);
    }

    // and the one junk value that is a published code is still read as one
    assert.equal(Weather.weatherIcon(63), "🌧");
});

// T826: the buckets were open-ended `<=` thresholds, so WMO 3 (overcast) fell
// into the partly-cloudy one — the single code that means a grey sky was the
// one that did not say cloudy — and 85/86 (snow showers) fell into the
// rain-shower one, telling a user in a snow shower that it was raining. The
// published WMO 4677 table Open-Meteo documents, one row per code.
const WMO_CONDITIONS = {
    0: "☀",
    1: "🌤", 2: "⛅",
    3: "☁", 45: "☁", 48: "☁",
    51: "🌧", 53: "🌧", 55: "🌧", 56: "🌧", 57: "🌧",
    61: "🌧", 63: "🌧", 65: "🌧", 66: "🌧", 67: "🌧",
    71: "🌨", 73: "🌨", 75: "🌨", 77: "🌨",
    80: "🌦", 81: "🌦", 82: "🌦",
    85: "🌨", 86: "🌨",
    95: "⛈", 96: "⛈", 99: "⛈"
};

test("every published Open-Meteo code renders the condition it means", () => {
    const Weather = loadWeather();

    for (const [code, icon] of Object.entries(WMO_CONDITIONS)) {
        assert.equal(Weather.weatherIcon(Number(code)), icon,
            `WMO ${code} => ${Weather.WEATHER_CONDITIONS[icon]}`);
    }

    // the gaps between the groups are not codes Open-Meteo emits, and a
    // threshold chain adopted each of them into whichever class it reached
    // first: 4-44 read as fog, 49-50 as rain, 83-84 as showers
    for (const code of [4, 20, 44, 49, 50, 68, 70, 78, 79, 83, 84, 87, 94, 100]) {
        assert.equal(Weather.weatherIcon(code), Weather.WEATHER_UNKNOWN_CONDITION,
            `WMO ${code} is not a published code and must not read as one`);
    }
});

// The failover chain means the same real weather may be described by either
// adapter from one refresh to the next, so they have to agree about it.
test("the two adapters describe the same weather the same way", () => {
    const Weather = loadWeather();
    const agreements = [
        ["clearsky_day", 0],
        ["fair_day", 1],
        ["partlycloudy_night", 2],
        ["cloudy", 3],
        ["fog", 45],
        ["lightrain", 61],
        ["heavysnow", 75],
        ["rainshowers_day", 80],
        ["lightsnowshowers_day", 85],
        ["heavyrainandthunder", 95]
    ];

    for (const [symbol, code] of agreements) {
        assert.equal(Weather.metNoIcon(symbol), Weather.weatherIcon(code),
            `met.no "${symbol}" and WMO ${code} are the same weather`);
    }

    // T957: and the third vendor draws the same line. A lightly clouded sky used
    // to read "🌤 Fair" from aviationweather and met.no and "⛅ Partly cloudy"
    // from Open-Meteo, so the wording, the glyph and the accessible name all
    // changed when the failover chain moved.
    const covers = [["FEW", 1], ["SCT", 2], ["BKN", 3], ["CLR", 0]];
    for (const [cover, code] of covers) {
        assert.equal(Weather.aviationWeatherIcon({ cover }), Weather.weatherIcon(code),
            `METAR ${cover} and WMO ${code} are the same weather`);
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

    for (const symbol of ["clearsky", "fair", "partlycloudy", "cloudy", "fog", "rain", "drizzle", "sleet", "snow", "rainshowers"]) {
        const icon = Weather.metNoIcon(symbol);
        assert.ok(Weather.WEATHER_CONDITIONS[icon],
            `the met.no symbol ${symbol} names a condition`);
    }

    // a symbol_code the table does not know describes no sky. "fair" above is
    // a real met.no symbol and cannot double as the answer for one it isn't.
    for (const symbol of ["unknown", "", null, undefined, 42, {}]) {
        assert.equal(Weather.metNoIcon(symbol), Weather.WEATHER_UNKNOWN_CONDITION,
            `metNoIcon(${String(symbol)}) must not read as weather`);
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
    // no summary at any horizon: the temperature is real, the sky is undescribed
    assert.equal(shown(Weather.metNoWeatherReading(forecastWith({ instant })), "si"), " 4°C");
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
test("weather.js composes the panel provider from the parts it needs", () => {
    const source = fs.readFileSync(modulePath, "utf8");
    // the two it builds WeatherProvider out of. It used to require all four and
    // spread them into module.exports, which is a Node-only export surface:
    // around forty names that are functions under `node test/` and undefined on
    // the panel, where GJS exposes a module's own var bindings and no more.
    for (const dep of ["weatherFormat", "weatherScheduler", "weatherProviders"]) {
        assert.match(source, new RegExp('require\\("\\./' + dep + '"\\)'),
            "weather.js must require " + dep);
    }

    const module = require(modulePath);
    assert.deepEqual(Object.keys(module).sort(), [
        "WeatherDisplayState", "WeatherProvider", "WeatherReadingRepository",
        "cancelPendingWeatherRequests", "registerWeatherConsumer",
        "releaseWeatherConsumer"
    ], "and it exports its own bindings, which is what GJS can see");

    // the harness composes the parts when a test wants one handle for them
    const Weather = loadWeather();
    assert.equal(typeof Weather.staleAfterSeconds, "function", "from weatherFormat");
    assert.equal(typeof Weather.geocodeUrl, "function", "from weatherServiceAdapters");
    assert.equal(typeof Weather.WeatherRefreshScheduler, "function", "from weatherScheduler");
    assert.equal(typeof Weather.WeatherForecastResolver, "function", "from weatherProviders");
    assert.equal(typeof Weather.WeatherProvider, "function", "and weather.js itself");
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

    assert.equal(Weather.finiteNumber(null), null);
    assert.equal(Weather.finiteNumber(""), null);
    assert.equal(Weather.finiteNumber([]), null);
    assert.equal(Weather.finiteNumber(false), null);
    assert.equal(Weather.finiteNumber("  "), null);
    assert.equal(Weather.finiteNumber("-3"), -3);
    assert.equal(Weather.finiteNumber(0), 0);

    // the METAR fields are read unbounded: the range test is the coordinate
    // reader's, and imposing it here would drop fields this file may not judge
    assert.equal(Weather.finiteNumber(-273.15), -273.15);
    assert.equal(Weather.finiteNumber(1e9), 1e9);
    assert.equal(Weather.finiteNumber(Infinity), null);

    // and with bounds it is the coordinate reader the geocode parsers use
    assert.equal(Weather.finiteNumber("48.85", -90, 90), 48.85);
    assert.equal(Weather.finiteNumber(91, -90, 90), null);
    assert.equal(Weather.finiteNumber(-181, -180, 180), null);
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
    const repository = provider._reading_repository;
    assert.equal(repository.session.created, null);

    const session = repository.getHttpSession();
    assert.equal(session.timeout, Weather.HTTP_TIMEOUT_SECONDS);
    assert.equal(session.idle_timeout, Weather.HTTP_TIMEOUT_SECONDS);
    assert.equal(repository.getHttpSession(), session, "and it is built once");
    assert.ok(Weather.HTTP_TIMEOUT_SECONDS > 0);
});

// The HTTP adapter was bypassable in CityWeatherProvider and mandatory here: a
// caller that injected httpGetJson still got a live Soup session it could never
// use. The two halves of one feature take the same seam now.
test("a provider given its HTTP is not handed a session it cannot use", () => {
    const Weather = loadWeather();
    const injected = new Weather.WeatherProvider({ httpGetJson() {} });
    assert.equal(injected._reading_repository.session.created, null);

    const session = { abort() { this.aborted = true; } };
    const given = new Weather.WeatherProvider({ httpSession: session });
    assert.equal(given._reading_repository.getHttpSession(), session,
        "and a session it is given is the one it uses");

    given.destroy();
    assert.equal(session.aborted, true);
});

// T796: "the last reading, who provided it, when it was fetched, and is that
// still the weather?" was written twice - four fields in WeatherDisplayState,
// the same four per city and unnamed in CityWeatherProvider's Map - while both
// derived the horizon from staleAfterSeconds. The two copies had already forked
// on policy, so the panel and the popup rows of one feature answered the
// staleness question differently. cityWeather.js calls this module the twin of
// the panel provider, and the refresh scheduler was de-duplicated the same way.
// T839: params defaults to {}, and freshnessNow had no fallback, so the
// no-argument construction the signature advertises produced an object that
// raised "this._now is not a function" on its first use — including isStale for
// a key it does not hold, because a default argument is evaluated before the
// body. Both callers pass a clock that resolves to civilMilliseconds, which is
// Date.now(), so that is the default rather than a construction-time throw.
test("a reading store built with no clock still answers", () => {
    const Weather = loadWeather();
    const store = new Weather.WeatherReadingStore();
    const record = { condition: "☀", temperatureC: 20 };

    assert.equal(store.isStale("lisbon"), false, "a key it does not hold is not stale");
    store.record("lisbon", record, "Open-Meteo");
    assert.equal(store.recordFor("lisbon"), record);
    assert.equal(store.isStale("lisbon"), false, "a reading taken now is not old");
});

test("one reading store answers freshness for the panel and for a city", () => {
    const Weather = loadWeather();
    let now = 1_000_000;
    const store = new Weather.WeatherReadingStore({
        freshnessNow: () => now,
        refreshSeconds: 60
    });
    const record = { condition: "☀", temperatureC: 20 };

    assert.equal(store.has("lisbon"), false);
    assert.equal(store.recordFor("lisbon"), null);
    assert.equal(store.providerFor("lisbon"), "");
    assert.equal(store.isStale("lisbon"), false, "no reading is not a stale one");

    // the fetch time travels with the reading: a shared-cache hit hands over a
    // reading that may already be most of a period old
    store.record("lisbon", record, "Open-Meteo", now - 100_000);
    assert.equal(store.recordFor("lisbon"), record);
    assert.equal(store.providerFor("lisbon"), "Open-Meteo");
    assert.equal(store.has("lisbon"), true);
    assert.equal(store.isStale("lisbon"), false, "100s old against a 120s horizon");

    now += 30_000;
    assert.equal(store.isStale("lisbon"), true, "two refresh periods, and it is not the weather");
    assert.equal(store.isStale("lisbon", now - 30_000), false, "an explicit clock is honoured");

    // a receipt with no fetch time falls back to now, and a provider with no
    // name is the empty string rather than undefined
    store.record("tokyo", record, undefined, NaN);
    assert.equal(store.providerFor("tokyo"), "");
    assert.equal(store.isStale("tokyo"), false);

    // a reading for a place the user removed must not outlive its row
    store.keepOnly(new Set(["tokyo"]));
    assert.equal(store.has("lisbon"), false);
    assert.equal(store.has("tokyo"), true);
    store.clear();
    assert.equal(store.has("tokyo"), false);
});

test("the panel state and the city readings are the same store", () => {
    const displaySource = fs.readFileSync(modulePath, "utf8");
    const citySource = fs.readFileSync(
        path.join(path.dirname(modulePath), "cityWeather.js"), "utf8");

    for (const [name, source] of [["weather.js", displaySource],
        ["cityWeather.js", citySource]]) {
        assert.match(source, /WeatherReadingStore/,
            name + " must hold its readings in the shared store");
        assert.doesNotMatch(source, /freshAt:/,
            name + " must not lay the reading record out a second time");
    }
    assert.doesNotMatch(citySource, /WeatherFormat\.readingIsStale/,
        "and the horizon is asked of the store, not recomputed beside it");
});

// T795: one conceptual rule - fold a place name so two spellings of it meet -
// had three implementations. The settings-side completion list folded with
// strip/lower/replace('_',' '), so it would not offer "São Paulo" for a typed
// "Sao" nor "Saint-Étienne" for "saint etienne", while this matcher folded
// both: the user was shown a narrower set of suggestions than the thing that
// actually answers accepts. The Python port asserts the same table.
test("the place fold matches the settings dialog's port of it", () => {
    const Weather = loadWeather();
    const fixture = require("./fixtures/place_name_fold_cases.json");

    for (const { input, folded, why } of fixture.cases) {
        assert.equal(Weather.foldPlaceName(input), folded, why);
    }
    for (const { left, right, why } of fixture.distinct) {
        assert.notEqual(Weather.foldPlaceName(left), Weather.foldPlaceName(right), why);
    }
});

// ...and the cache key is deliberately not that rule. A key needs to be stable
// and to keep apart the places the user meant to keep apart; the fold needs to
// reach a city from the spelling a keyboard can produce. Genova and Génova are
// two cities, and one key for both would serve one geocode answer for the other.
test("the geocode cache key is not the display fold", () => {
    const Weather = loadWeather();

    assert.notEqual(Weather.locationCacheKey("Genova"), Weather.locationCacheKey("Génova"));
    assert.equal(Weather.foldPlaceName("Genova"), Weather.foldPlaceName("Génova"));
    // what it does promise is stability: case and padding never make two keys
    assert.equal(Weather.locationCacheKey("  LISBOA "), Weather.locationCacheKey("lisboa"));
});

test("the METAR boxes split at both sides of the antimeridian", () => {
    const Weather = loadWeather();
    const boxesOf = (place) => Weather.aviationWeatherUrls(place).map((url) =>
        decodeURIComponent(url.split("bbox=")[1]).split(",").map(Number));

    // Eastern Fiji: one box reaches east to 180 and the remainder continues
    // from -180. Mirroring the place mirrors the two spans.
    assert.deepEqual(boxesOf({ latitude: -18.05, longitude: 179.9 }), [
        [-19.05, 178.9, -17.05, 180],
        [-19.05, -180, -17.05, -179.1]
    ]);
    assert.deepEqual(boxesOf({ latitude: -18.05, longitude: -179.9 }), [
        [-19.05, -180, -17.05, -178.9],
        [-19.05, 179.1, -17.05, 180]
    ]);
    // Latitude has ends: a box drawn past a pole is not a place
    assert.deepEqual(boxesOf({ latitude: 89.5, longitude: 10 }), [[88.5, 9, 90, 11]]);
    assert.deepEqual(boxesOf({ latitude: -89.5, longitude: 10 }), [[-90, 9, -88.5, 11]]);
    // Away from either edge nothing is clamped
    assert.deepEqual(boxesOf({ latitude: -23.55, longitude: -46.63 }),
        [[-24.55, -47.63, -22.55, -45.63]]);
    assert.equal(Weather.aviationWeatherUrl({ latitude: -23.55, longitude: -46.63 }),
        Weather.aviationWeatherUrls({ latitude: -23.55, longitude: -46.63 })[0],
        "the old one-URL adapter stays compatible away from the seam");
});

test("the nearest METAR station is measured the shorter way round the meridian", () => {
    const Weather = loadWeather();
    const place = { latitude: 0.5, longitude: 179.8 };

    // 0.7° east across the seam, against 3.3° west of the place: subtracting
    // the longitudes directly made the near one 359.3° away and picked the far
    // one, so a place beside the antimeridian never saw the station next to it
    const across = { icaoId: "NEAR", lat: 0.5, lon: -179.5, temp: 21, cover: "CLR" };
    const behind = { icaoId: "FAR", lat: 0.5, lon: 176.5, temp: 25, cover: "CLR" };

    assert.equal(Weather.aviationWeatherStation([behind, across], place).icaoId, "NEAR");
    assert.equal(Weather.aviationWeatherStation([across, behind], place).icaoId, "NEAR");

    // the same case seen from the western side of the seam: the place is at
    // 179.8°W and the near station 0.7° east of it is written as 179.5°E
    const west = { latitude: 0.5, longitude: -179.8 };
    assert.equal(Weather.aviationWeatherStation([
        { icaoId: "FAR", lat: 0.5, lon: -176.5, temp: 25, cover: "CLR" },
        { icaoId: "NEAR", lat: 0.5, lon: 179.5, temp: 21, cover: "CLR" }
    ], west).icaoId, "NEAR");
    // and the ranking is unchanged where no seam is crossed
    assert.equal(Weather.aviationWeatherStation([
        { icaoId: "FAR", lat: 0.5, lon: 12, temp: 25, cover: "CLR" },
        { icaoId: "NEAR", lat: 0.5, lon: 10.2, temp: 21, cover: "CLR" }
    ], { latitude: 0.5, longitude: 10 }).icaoId, "NEAR");
});
