const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");
const { makeSoup3 } = require("./helpers/soup");

const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "weather.js");
const utilsPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "utils.js");
const ioUtilsPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "ioUtils.js");
const localeUtilsPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "localeUtils.js");
const shimPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "weather.js");
const schema52Path = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "settings-schema.json");

let originalImports;
let originalLogError;

function loadWeather(soupOverrides = {}) {
    delete require.cache[require.resolve(modulePath)];
    // weather delegates its HTTP path to utils; reload it so it captures
    // this call's Soup mock instead of a previous test's
    delete require.cache[require.resolve(utilsPath)];
    delete require.cache[require.resolve(ioUtilsPath)];
    delete require.cache[require.resolve(localeUtilsPath)];

    const soup = Object.assign(makeSoup3({
        data: "{}",
        sessionMethods: {
            send_and_read_async() {}
        }
    }), soupOverrides);

    global.imports = {
        byteArray: {
            toString(data) {
                return data.toString();
            }
        },
        gi: {
            // needed by utils.js at load time
            Cinnamon: {},
            CinnamonDesktop: {
                WallClock: {
                    lctime_format(_domain, format) {
                        return format;
                    }
                }
            },
            Gio: {},
            GLib: {
                PRIORITY_DEFAULT: 0,
                SOURCE_CONTINUE: true,
                SOURCE_REMOVE: false,
                timeout_add() {
                    return 2;
                },
                timeout_add_seconds() {
                    return 1;
                },
                source_remove() {}
            },
            Soup: soup
        }
    };

    return require(modulePath);
}

beforeEach(() => {
    originalImports = global.imports;
    originalLogError = global.logError;
    global.logError = function() {};
});

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
    assert.equal(Weather.aviationWeatherText(stations, place, "si"), "☁ 23°C");
    // METAR temperatures are Celsius; imperial has to convert
    assert.equal(Weather.aviationWeatherText(stations, place, "imperial"), "☁ 73°F");
    assert.equal(Weather.aviationWeatherText([], place, "si"), "");
    assert.equal(Weather.aviationWeatherText(null, place, "si"), "");
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

    resolver.refresh({ latitude: 41.9, longitude: 12.5 }, "si", () => true, (text, error, name) => {
        values.push({ text, error, name });
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

afterEach(() => {
    global.imports = originalImports;
    global.logError = originalLogError;
});

test("builds Open-Meteo geocode and forecast URLs", () => {
    const Weather = loadWeather();

    assert.equal(
        Weather.geocodeUrl(" New York "),
        "https://geocoding-api.open-meteo.com/v1/search?name=New%20York&count=1&language=en&format=json"
    );
    assert.equal(
        Weather.nominatimGeocodeUrl(" New York "),
        "https://nominatim.openstreetmap.org/search?q=New%20York&format=json&limit=1"
    );
    assert.equal(Weather.locationCacheKey(" New York "), "new york");
    assert.equal(
        Weather.forecastUrl({ latitude: 41.9, longitude: 12.5 }, "si"),
        "https://api.open-meteo.com/v1/forecast?latitude=41.9&longitude=12.5&current_weather=true&timezone=auto&temperature_unit=celsius"
    );
    assert.equal(
        Weather.forecastUrl({ latitude: 41.9, longitude: 12.5 }, "imperial"),
        "https://api.open-meteo.com/v1/forecast?latitude=41.9&longitude=12.5&current_weather=true&timezone=auto&temperature_unit=fahrenheit"
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
    assert.equal(Weather.openMeteoGeocodePlace({ results: [{ latitude: "41.9", longitude: "12.5" }] }).latitude, 41.9);
    assert.equal(typeof Weather.openMeteoGeocodePlace(
        { results: [{ latitude: "41.9", longitude: "12.5" }] }).longitude, "number");

    assert.equal(
        Weather.metNoForecastUrl({ latitude: 41.9, longitude: 12.5 }),
        "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=41.9&lon=12.5"
    );
});

test("normalizes primary and fallback geocode responses", () => {
    const Weather = loadWeather();

    assert.deepEqual(
        Weather.openMeteoGeocodePlace({ results: [{ latitude: 41.9, longitude: 12.5 }] }),
        { latitude: 41.9, longitude: 12.5 }
    );
    assert.equal(Weather.openMeteoGeocodePlace({ results: [] }), null);
    assert.deepEqual(
        Weather.nominatimGeocodePlace([{ lat: "41.9", lon: "12.5", display_name: "Rome, Italy" }]),
        { name: "Rome, Italy", latitude: 41.9, longitude: 12.5 }
    );
    assert.equal(Weather.nominatimGeocodePlace([{ lat: "x", lon: "12.5" }]), null);

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

function assertNullOrFinitePlace(place) {
    if (place === null) {
        return;
    }

    assert.equal(typeof place, "object");
    assert.equal(Number.isFinite(place.latitude), true);
    assert.equal(Number.isFinite(place.longitude), true);
}

test("geocode parsers fuzz malformed payloads without throwing", () => {
    const Weather = loadWeather();
    const rand = makeRandom(0x9e0c0de);
    const scalars = [null, undefined, "", "12.5", "Infinity", "NaN", 0, 42, Infinity, NaN, true, false];

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
        assert.equal(Weather.weatherText({ weathercode: 1, temperature: 20.2 }, units), "⛅ 20°C");
    }

    assert.equal(Weather.normalizeUnits("imperial"), "imperial");
    assert.equal(Weather.weatherText({ weathercode: 1, temperature: 68.1 }, "imperial"), "⛅ 68°F");

    const schema = JSON.parse(fs.readFileSync(schema52Path, "utf8"));
    assert.equal(schema["weather-units"].default, "si");
    assert.deepEqual(Object.values(schema["weather-units"].options).sort(), ["imperial", "si"]);
});

test("formats weather text and maps every fuzzed weather code to an icon", () => {
    const Weather = loadWeather();

    assert.equal(Weather.weatherText({ weathercode: 0, temperature: 21.4 }, "metric"), "☀ 21°C");
    assert.equal(Weather.weatherText({ weathercode: 63, temperature: 70.6 }, "imperial"), "🌧 71°F");
    assert.equal(Weather.weatherText(null, "metric"), "");

    // a degraded Open-Meteo station reports no temperature; rounding that
    // gives "NaN°C", which the provider chain would read as an answer
    for (const missing of [null, undefined, "warm", NaN, Infinity]) {
        assert.equal(Weather.weatherText({ weathercode: 0, temperature: missing }, "metric"), "",
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
    assert.equal(Weather.metNoWeatherText(forecast, "si"), "🌧 10°C");
    assert.equal(Weather.metNoWeatherText(forecast, "imperial"), "🌧 51°F");
    assert.equal(Weather.metNoWeatherText({}, "si"), "");

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

    assert.equal(Weather.metNoWeatherText(forecastWith({
        instant,
        next_6_hours: { summary: { symbol_code: "snow" } }
    }), "si"), "🌨 4°C");
    assert.equal(Weather.metNoWeatherText(forecastWith({
        instant,
        next_12_hours: { summary: { symbol_code: "cloudy" } }
    }), "si"), "☁ 4°C");
    assert.equal(Weather.metNoWeatherText(forecastWith({ instant }), "si"), "🌤 4°C");
    assert.equal(Weather.metNoWeatherText(forecastWith({
        next_1_hours: { summary: { symbol_code: "rain" } }
    }), "si"), "");
    assert.equal(Weather.metNoWeatherText(forecastWith(null), "si"), "");
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
            const text = Weather.metNoWeatherText(forecast, rand() < 0.5 ? "si" : "imperial");
            assert.equal(typeof text, "string");
            assert.ok(text === "" || /^[^\s]+ -?\d+°[CF]$/.test(text), `unexpected text: ${text}`);
        });
    }
});

// Regression: the module used to export these as `class` / `const`. GJS's
// importer only exposes top-level var and function declarations, so the panel
// module read them as undefined and the applet died with
// "Weather.WeatherForecastResolver is not a constructor".
test("regression: the exported resolvers and refresh period are var bindings", () => {
    const source = fs.readFileSync(modulePath, "utf8");

    for (const name of ["WeatherLocationResolver", "WeatherForecastResolver", "REFRESH_SECONDS"]) {
        assert.match(source, new RegExp("^var " + name + "\\b", "m"),
            name + " must be declared with var to survive the GJS importer");
        assert.doesNotMatch(source, new RegExp("^(?:const|let|class)\\s+" + name + "\\b", "m"));
    }
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
    assert.equal(Weather.aviationWeatherText(stations, place, "si"), "⛅ 14°C");

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

test("aviation weather fuzzes malformed station payloads without throwing", () => {
    const Weather = loadWeather();
    const rand = makeRandom(0xa71a7104);
    const place = { latitude: 48.85, longitude: 2.35 };
    // null, "" and [] belong in here: Number() coerces all three to 0, and a
    // station with "temp": null used to be read as a real 0°C reading at Null
    // Island and could win the nearest-station race
    const junkTemps = [undefined, null, "", [], false, "warm", "12abc", NaN, {}, true];
    const junkCoords = [undefined, null, "", [], "north", NaN, Infinity, {}];

    function pick(list) {
        return list[Math.floor(rand() * list.length)];
    }

    function makeStation() {
        const roll = rand();
        if (roll < 0.12) {
            return pick([null, undefined, "SBSP", 42, []]);
        }

        const station = {
            lat: rand() < 0.75 ? place.latitude + (rand() * 2 - 1) : pick(junkCoords),
            lon: rand() < 0.75 ? place.longitude + (rand() * 2 - 1) : pick(junkCoords),
            cover: pick(["CLR", "FEW", "SCT", "BKN", "OVC", "", 7, undefined]),
            wxString: pick(["RA", "TSRA", "SN", "BR", "", 3, undefined])
        };

        if (rand() < 0.7) {
            station.temp = rand() < 0.85 ? Math.round(rand() * 80 - 40) : String(Math.round(rand() * 40 - 10));
        } else if (rand() < 0.8) {
            station.temp = pick(junkTemps);
        }

        return station;
    }

    // Properties, not a second implementation. The oracle here used to
    // reimplement aviationWeatherStation's selection loop line for line, so a
    // shared misunderstanding — both treating lat: "0" as usable when it should
    // be rejected — agreed with itself and passed.
    for (let i = 0; i < 400; i++) {
        const stations = Array.from({ length: Math.floor(rand() * 6) }, makeStation);
        const units = rand() < 0.5 ? "imperial" : pick(["si", "metric", undefined, null]);
        let station;
        let text;

        assert.doesNotThrow(() => {
            station = Weather.aviationWeatherStation(stations, place);
            text = Weather.aviationWeatherText(stations, place, units);
        });

        // it never invents a station, and never picks one it cannot read
        if (station !== null) {
            assert.ok(stations.includes(station), "the station must be one it was given");
            assert.notEqual(usableNumber(station.temp), null,
                "a station with no readable temperature is no use");
            assert.notEqual(usableNumber(station.lat), null);
            assert.notEqual(usableNumber(station.lon), null);
        }

        // and it finds one whenever one exists — this is the filter, checked
        // without reference to how the nearest is chosen
        const anyUsable = stations.some((candidate) => candidate &&
            typeof candidate === "object" &&
            usableNumber(candidate.temp) !== null &&
            usableNumber(candidate.lat) !== null &&
            usableNumber(candidate.lon) !== null);
        assert.equal(station !== null, anyUsable,
            "a usable station exists exactly when one is returned");

        // the readout says what the chosen station says, or says nothing
        if (station === null) {
            assert.equal(text, "", "no usable station means no readout, not a broken one");
            continue;
        }

        // METAR temperatures are Celsius by definition: only imperial converts
        const celsius = usableNumber(station.temp);
        const value = units === "imperial" ? Math.round(celsius * 9 / 5 + 32) : Math.round(celsius);
        assert.equal(text, Weather.aviationWeatherIcon(station) + " " + value +
            (units === "imperial" ? "°F" : "°C"));

        // asking twice answers the same
        assert.equal(Weather.aviationWeatherStation(stations, place), station);
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
        assert.equal(Weather.aviationWeatherText(empty, place, "si"), "");
    }

    // a station without a temperature is skipped even when it is the closest one
    const stations = [
        { icaoId: "LFPB", lat: 48.85, lon: 2.35, cover: "CLR" },
        { icaoId: "LFPG", lat: 49.01, lon: 2.55, temp: 10, cover: "OVC" }
    ];
    assert.equal(Weather.aviationWeatherStation(stations, place).icaoId, "LFPG");
    assert.equal(Weather.aviationWeatherText(stations, place, "si"), "☁ 10°C");
    assert.equal(Weather.aviationWeatherText(stations, place, "imperial"), "☁ 50°F");
});

test("provider sessions carry an explicit HTTP timeout", () => {
    const Weather = loadWeather();
    const provider = new Weather.WeatherProvider();

    // weather is off by default, so the session is built when something first
    // asks for it — not once per applet at startup for every user who never
    // turns weather on
    assert.equal(provider._httpSession, null);

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
    assert.equal(injected._httpSession, null);

    const session = { abort() { this.aborted = true; } };
    const given = new Weather.WeatherProvider({ httpSession: session });
    assert.equal(given._getHttpSession(), session, "and a session it is given is the one it uses");

    given.destroy();
    assert.equal(session.aborted, true);
});

test("enabled weather without a location reports the setup hint", () => {
    const Weather = loadWeather();
    const provider = new Weather.WeatherProvider({ httpGetJson() { throw new Error("no request expected"); } });
    const reports = [];
    provider.refresh({ showWeather: true, location: "  ", units: "si" },
        (text, error, name) => reports.push({ text, error, name }));
    assert.deepEqual(reports, [{ text: "", error: Weather.WEATHER_ERRORS.NO_LOCATION, name: "" }]);

    provider.refresh({ showWeather: false, location: "", units: "si" },
        (text, error, name) => reports.push({ text, error, name }));
    assert.deepEqual(reports[1], { text: "", error: "", name: "" }, "disabled stays silent");
});

test("the first fetch shows a pending placeholder, later ones do not", () => {
    const Weather = loadWeather();
    let respond = null;
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 41.9, longitude: 12.5 }] });
            } else {
                respond = () => callback({ current_weather: { weathercode: 2, temperature: 12.6 } });
            }
        }
    });

    const reports = [];
    const settings = { showWeather: true, location: "Rome", units: "si" };
    provider.schedule(settings, (text, error) => reports.push({ text, error }));
    assert.equal(reports[0].text, Weather.WEATHER_PENDING_TEXT, "placeholder first");
    respond();
    assert.ok(reports[1].text.length > 0);
    assert.notEqual(reports[1].text, Weather.WEATHER_PENDING_TEXT);

    provider.schedule(settings, (text, error) => reports.push({ text, error }));
    respond();
    assert.equal(reports.length, 3, "no placeholder once a reading exists");
    assert.notEqual(reports[2].text, Weather.WEATHER_PENDING_TEXT);
});

test("transient failures keep reporting the last good reading", () => {
    const Weather = loadWeather();
    let fail = false;
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            if (fail) {
                callback(null);
            } else if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 41.9, longitude: 12.5 }] });
            } else {
                callback({ current_weather: { weathercode: 2, temperature: 12.6 } });
            }
        }
    });

    const reports = [];
    const settings = { showWeather: true, location: "Rome", units: "si" };
    provider.refresh(settings, (text, error, name) => reports.push({ text, error, name }));
    assert.ok(reports[0].text.length > 0);
    assert.equal(reports[0].error, "");

    fail = true;
    provider.refresh(settings, (text, error, name) => reports.push({ text, error, name }));
    assert.equal(reports[1].text, reports[0].text, "stale reading retained");
    assert.ok(reports[1].error.length > 0, "error still reported");

    // a different location must not inherit the stale reading
    provider.refresh({ showWeather: true, location: "Oslo", units: "si" },
        (text, error, name) => reports.push({ text, error, name }));
    assert.equal(reports[2].text, "");
});

test("weather display state owns stale reading reporting", () => {
    const Weather = loadWeather();
    const state = new Weather.WeatherDisplayState();
    const reports = [];
    const reportRome = state.reporter("rome|si", (text, error, name) => reports.push({ text, error, name }));
    const reportOslo = state.reporter("oslo|si", (text, error, name) => reports.push({ text, error, name }));

    assert.equal(state.hasReading(), false);
    reportRome("☀ 20°C", "", Weather.WEATHER_PROVIDER_NAMES.OPEN_METEO);
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
    // side can emit must map to a condition
    const codes = [0, 2, 45, 61, 71, 80, 95, 85];
    for (const code of codes) {
        const text = Weather.weatherText({ weathercode: code, temperature: 12 }, "si");
        assert.notEqual(Weather.weatherCondition(text), "",
            `the glyph for code ${code} has no condition`);
    }

    for (const symbol of ["clearsky_day", "fair_day", "partlycloudy_day", "cloudy", "fog",
        "snow", "rainshowers_day", "rain", "thunderstorm", "unknown"]) {
        assert.notEqual(Weather.weatherCondition(Weather.metNoIcon(symbol)), "",
            `the MET Norway glyph for ${symbol} has no condition`);
    }

    assert.equal(Weather.weatherCondition("☀ 12°C"), "Clear");
    assert.equal(Weather.weatherCondition(""), "");
    assert.equal(Weather.weatherCondition("12°C"), "", "a readout with no glyph has no condition");
});

test("a provider whose refresh fails schedules its own retry", () => {
    const Weather = loadWeather();
    const timers = [];
    let nextId = 900;
    const provider = new Weather.WeatherProvider({
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

test("the geocode cache is bounded and re-resolves an edited location", () => {
    const Weather = loadWeather();
    let geocodes = 0;
    const resolver = new Weather.WeatherLocationResolver({
        maxCacheEntries: 3,
        httpGetJson(url, callback) {
            geocodes++;
            callback({ results: [{ latitude: 1, longitude: 2 }] });
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
            refresh(place, units, isCurrent, callback) {
                forecasts.push(place);
                callback("☀ 20°C", "", "Open-Meteo");
            }
        }
    });
    const settings = { showWeather: true, location: "Rome", units: "si" };

    provider.refresh(settings, (text) => values.push(text));
    provider.refresh(settings, (text) => values.push(text));

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

    resolver.resolve(" Rome ", () => current, (place, error, cacheKey) => {
        resolved.push({ place, error, cacheKey });
    });
    resolver.resolve("rome", () => current, (place, error, cacheKey) => {
        resolved.push({ place, error, cacheKey });
    });

    assert.equal(resolved.length, 2);
    assert.equal(resolved[0].place.name, "Rome, Italy");
    assert.equal(resolved[0].error, "");
    assert.equal(resolved[0].cacheKey, "rome");
    assert.equal(resolved[1].place, resolved[0].place);
    assert.equal(resolver.cache.get("rome"), resolved[0].place);
    assert.equal(requests.filter((request) => request.url.includes("geocoding-api")).length, 1);
    assert.equal(requests.filter((request) => request.url.includes("nominatim.openstreetmap.org")).length, 1);
    assert.equal(
        requests[1].options.headers["User-Agent"],
        Weather.WEATHER_USER_AGENT
    );

    const staleRequests = [];
    const staleResolver = new Weather.WeatherLocationResolver({
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

    resolver.refresh({ latitude: 1, longitude: 2 }, "si", () => true, (text, error, providerName) => {
        values.push({ text, error, providerName });
    });
    resolver.refresh({ latitude: 1, longitude: 2 }, "si", () => true, (text, error, providerName) => {
        values.push({ text, error, providerName });
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
    staleResolver.refresh({ latitude: 1, longitude: 2 }, "si", () => false, (...args) => staleValues.push(args));
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
        failedResolver.refresh({ latitude: 1, longitude: 2 }, "si", () => true, (text, error, providerName) => {
            failed.push({ text, error, providerName });
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

test("refresh geocodes, fetches forecast, and reports formatted text", () => {
    const Weather = loadWeather();
    const requests = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            requests.push(url);
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 41.9, longitude: 12.5 }] });
            } else {
                callback({ current_weather: { weathercode: 2, temperature: 12.6 } });
            }
        }
    });

    let text = null;
    let providerName = null;
    provider.refresh({ showWeather: true, location: "Rome", units: "metric" }, (value, _error, servedBy) => {
        text = value;
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
        httpGetJson(_url, callback) {
            calls++;
            callback({ results: [] });
        }
    });
    const values = [];

    provider.refresh({ showWeather: false, location: "Rome", units: "metric" }, (value) => values.push(value));
    provider.refresh({ showWeather: true, location: "   ", units: "metric" }, (value) => values.push(value));
    provider.refresh({ showWeather: true, location: "Nowhere", units: "metric" }, (value) => values.push(value));

    assert.deepEqual(values, ["", "", ""]);
    assert.equal(calls, 2);
});

test("refresh reports weather failures with user-visible status", () => {
    const Weather = loadWeather();
    const geocodeFailures = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(_url, callback) {
            callback(null);
        }
    });

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, (text, error) => {
        geocodeFailures.push({ text, error });
    });

    assert.deepEqual(geocodeFailures, [{ text: "", error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE }]);
    assert.equal(Weather.WEATHER_ERROR_MARKER, "⚠");

    const unresolved = [];
    const unresolvedProvider = new Weather.WeatherProvider({
        httpGetJson(_url, callback) {
            callback({ results: [] });
        }
    });
    unresolvedProvider.refresh({ showWeather: true, location: "Nowhere", units: "si" }, (text, error) => {
        unresolved.push({ text, error });
    });
    assert.deepEqual(unresolved, [{ text: "", error: Weather.WEATHER_ERRORS.LOCATION_NOT_FOUND }]);

    const forecastFailures = [];
    const forecastProvider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 1, longitude: 2 }] });
            } else {
                callback(null);
            }
        }
    });
    forecastProvider.refresh({ showWeather: true, location: "Rome", units: "si" }, (text, error) => {
        forecastFailures.push({ text, error });
    });
    assert.deepEqual(forecastFailures, [{ text: "", error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE }]);
});

test("refresh falls back to MET.no forecast with required user agent", () => {
    const Weather = loadWeather();
    const requests = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback, options = {}) {
            requests.push({ url, options });
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 1, longitude: 2 }] });
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

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, (text, error, providerName) => {
        result = { text, error, providerName };
    });

    assert.deepEqual(result, { text: "🌧 10°C", error: "", providerName: Weather.WEATHER_PROVIDER_NAMES.MET_NO });
    assert.equal(provider._forecast_resolver.lastProvider, Weather.WEATHER_PROVIDER_NAMES.MET_NO);
    assert.equal(requests.length, 4);
    assert.ok(requests[1].url.includes("api.open-meteo.com"));
    assert.ok(requests[2].url.includes("aviationweather.gov"));
    assert.ok(requests[3].url.includes("api.met.no"));
    assert.equal(requests[3].options.headers["User-Agent"], Weather.WEATHER_USER_AGENT);

    provider.refresh({ showWeather: true, location: "rome", units: "si" }, (text, error, providerName) => {
        result = { text, error, providerName };
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
                normalize: () => ""
            },
            {
                name: "Local station",
                url: (place) => `https://local.example/now?lat=${place.latitude}`.split("?")[0],
                normalize: (data, _place, units) => (data ? `☀ ${data.degrees}°${units === "si" ? "C" : "F"}` : ""),
                options: { headers: { "User-Agent": "test" } }
            }
        ]
    });

    let result = null;
    resolver.refresh({ latitude: 1, longitude: 2 }, "si", () => true,
        (text, error, provider) => {
            result = { text, error, provider };
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
                callback({ results: [{ latitude: 1, longitude: 2 }] });
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

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, (text, error, providerName) => {
        result = { text, error, providerName };
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

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, (text, error, providerName) => {
        values.push({ text, error, providerName });
    });
    provider.refresh({ showWeather: true, location: " rome ", units: "si" }, (text, error, providerName) => {
        values.push({ text, error, providerName });
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
                callback({ results: [{ latitude: 1, longitude: 2 }] });
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

    provider.schedule({ showWeather: true, location: "Oslo", units: "metric" }, (value) => values.push(value));
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
        { showWeather: true, location: "   ", units: "metric" }
    ]) {
        const values = [];
        provider.schedule(settings, (...value) => values.push(value));
        const expectedError = settings.showWeather ? "Set a weather location" : "";
        assert.deepEqual(values, [["", expectedError, ""]], JSON.stringify(settings));
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

            send_and_read_async() {}
        }
    });
    const pending = [];
    const values = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            pending.push({ url, callback });
        }
    });

    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, (value) => values.push(value));
    provider.destroy();

    pending[0].callback({ results: [{ latitude: 1, longitude: 2 }] });
    provider.refresh({ showWeather: true, location: "Rome", units: "si" }, (value) => values.push(value));

    // nothing asked for a session — httpGetJson is injected — so there is none
    // to abort, and destroy() must not trip over that
    assert.equal(provider._httpSession, null);
    assert.deepEqual(values, []);
    assert.equal(pending.length, 1);

    provider.schedule({ showWeather: true, location: "Rome", units: "si" }, (value) => values.push(value));
    provider.queue({ showWeather: true, location: "Rome", units: "si" }, (value) => values.push(value));
    assert.deepEqual(values, []);
    assert.equal(pending.length, 1);
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
                callback({ results: [{ latitude: 1, longitude: 2 }] });
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

    provider.refresh({ showWeather: true, location: "Older", units: "si" }, (value) => values.push(value));
    assert.equal(pending.length, 1);

    provider.refresh({ showWeather: true, location: "Newer", units: "si" }, (value) => values.push(value));
    assert.equal(pending.length, 2);

    pending[0].callback({ results: [{ latitude: 1, longitude: 1 }] });
    assert.equal(pending.length, 2);
    assert.deepEqual(values, []);

    pending[1].callback({ results: [{ latitude: 2, longitude: 2 }] });
    assert.equal(pending.length, 3);

    provider.refresh({ showWeather: true, location: "Newest", units: "si" }, (value) => values.push(value));
    assert.equal(pending.length, 4);
    pending[3].callback({ results: [{ latitude: 3, longitude: 3 }] });
    assert.equal(pending.length, 5);

    pending[4].callback({ current_weather: { weathercode: 2, temperature: 15 } });
    pending[2].callback({ current_weather: { weathercode: 0, temperature: 99 } });

    assert.deepEqual(values, ["⛅ 15°C"]);
});

test("refresh caches geocode results by normalized location", () => {
    const Weather = loadWeather();
    const requests = [];
    const provider = new Weather.WeatherProvider({
        httpGetJson(url, callback) {
            requests.push(url);
            if (url.includes("geocoding-api")) {
                callback({ results: [{ latitude: 41.9, longitude: 12.5 }] });
            } else {
                callback({ current_weather: { weathercode: 3, temperature: 10 } });
            }
        }
    });
    const values = [];

    provider.refresh({ showWeather: true, location: " Rome ", units: "si" }, (value) => values.push(value));
    provider.refresh({ showWeather: true, location: "rome", units: "si" }, (value) => values.push(value));

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
    assert.match(facade, /var WEATHER_KEYS = \[\s*\["show-weather", "show_weather"\],\s*\["weather-location", "weather_location"\],\s*\["weather-units", "weather_units"\]/);
    assert.match(lifecycle, /bindWeatherKeys\(this\.handlers\.onWeatherSettingsChanged\)/);

    const generalSettingsChanged = source.match(/_onSettingsChanged\(\) \{([\s\S]*?)\n    \}/);
    assert.ok(generalSettingsChanged);
    assert.doesNotMatch(generalSettingsChanged[1], /_scheduleWeatherRefresh|_queueWeatherRefresh/);
});

test("applets schedule weather once when added to a panel", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "applet.js"), "utf8");
    const panelAdded = source.match(/on_applet_added_to_panel\(\) \{([\s\S]*?)\n    \}/);
    assert.ok(panelAdded);
    assert.equal((panelAdded[1].match(/this\._scheduleWeatherRefresh\(\);/g) || []).length, 1);

    const generalSettingsChanged = source.match(/_onSettingsChanged\(\) \{([\s\S]*?)\n    \}/);
    assert.ok(generalSettingsChanged);
    assert.doesNotMatch(generalSettingsChanged[1], /_scheduleWeatherRefresh/);
});

test("applets refresh weather when the system resumes", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "applet.js"), "utf8");
    const lifecycle = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "appletLifecycle.js"), "utf8");
    assert.match(lifecycle, /connect\("notify-resume", context\.onResume\)/);
    assert.match(lifecycle, /connect\("notify::resume", context\.onResume\)/);

    const onResume = source.match(/_onResume\(\) \{([\s\S]*?)\n    \}/);
    assert.ok(onResume);
    assert.match(onResume[1], /this\._updateClockAndDate\(\);/);
    assert.match(onResume[1], /this\._scheduleWeatherRefresh\(\{ force: true \}\);/);
});

test("applets use valid vertical panel clock formats", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "appletPanelStatus.js"), "utf8");
    assert.doesNotMatch(source, /"%[Hl]%n%M%"/);
    assert.match(source, /"%H%n%M"/);
    assert.match(source, /"%l%n%M"/);
});

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
                    get_request_headers() {
                        return {
                            append(name, value) {
                                headers.push([name, value]);
                            }
                        };
                    },
                    get_status() {
                        return 200;
                    }
                };
                messages.push(message);
                return message;
            }
        },
        Session: class {
            send_and_read_async(_message, _priority, _cancellable, callback) {
                callback(this, {});
            }

            send_and_read_finish() {
                return {
                    get_data() {
                        return Buffer.from('{"ok":true}');
                    }
                };
            }
        }
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
        Session: class {
            send_and_read_async(_message, _priority, _cancellable, callback) {
                callback(this, {});
            }

            send_and_read_finish() {
                return {
                    get_data() {
                        return Buffer.from('{"ok":true}');
                    }
                };
            }
        }
    });
    const providerError = new WeatherError.WeatherProvider();
    let failed = "unset";

    providerError._httpGetJson("https://example.test/weather", (data) => {
        failed = data;
    });

    assert.equal(failed, null);
});

test("built-in Soup 3 JSON loader does not catch callback errors", () => {
    const Weather = loadWeather({
        Session: class {
            send_and_read_async(_message, _priority, _cancellable, callback) {
                callback(this, {});
            }

            send_and_read_finish() {
                return {
                    get_data() {
                        return Buffer.from('{"ok":true}');
                    }
                };
            }
        }
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
        Session: class {
            send_and_read_async(_message, _priority, _cancellable, callback) {
                callback(this, {});
            }

            send_and_read_finish() {
                return {
                    get_data() {
                        return Buffer.from("not json");
                    }
                };
            }
        }
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

    provider.queue({ showWeather: false, location: "", units: "si" }, () => {});
    assert.equal(provider._scheduler.debounceId, 202);
    assert.equal(timeoutMillis[0].cb(), false);
    assert.ok(refreshes >= 2);
    assert.deepEqual(removed, [101]);
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

    state.reporter("rome", (text, error) => seen.push([text, error]))("☀ 20°C", "", "Open-Meteo");
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
        now: () => clock,
        staleAfterSeconds: 3600
    });
    const seen = [];
    const report = (text, error) => seen.push([text, error]);

    state.reporter("rome", report)("☀ 20°C", "", "Open-Meteo");
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
    state.reporter("rome", report)("🌧 12°C", "", "Open-Meteo");
    assert.equal(state.isStale(), false);
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
    provider.schedule(lisbon, (text, error) => reported.push([text, error]));

    // the geocode, then the forecast
    pending.shift().callback({ results: [{ latitude: 38, longitude: -9 }] });
    pending.shift().callback({ current_weather: { temperature: 21, weathercode: 0 } });

    assert.deepEqual(reported.at(-1), ["☀ 21°C", ""], "Lisbon is on the panel");
    reported.length = 0;

    // the user types a new location
    const tokyo = { showWeather: true, location: "Tokyo", units: "si" };
    provider.schedule(tokyo, (text, error) => reported.push([text, error]));

    assert.deepEqual(reported[0], ["…", ""],
        "the panel says it is fetching, instead of showing Lisbon's temperature as Tokyo's");
    assert.equal(provider._display_state.hasReading(), false);

    pending.shift().callback({ results: [{ latitude: 35, longitude: 139 }] });
    pending.shift().callback({ current_weather: { temperature: 30, weathercode: 0 } });

    assert.deepEqual(reported.at(-1), ["☀ 30°C", ""]);
});

test("a reading survives a refresh of the same place, and a units change forgets it", () => {
    const Weather = loadWeather();
    const state = new Weather.WeatherDisplayState({ now: () => 1000 });
    const reports = [];
    state.reporter("lisbon|si", (...args) => reports.push(args))("☀ 21°C", "", "Open-Meteo");

    assert.equal(state.hasReading(), true);

    // the same place, asked again: the reading is still that place's
    state.forgetUnless("lisbon|si");
    assert.equal(state.hasReading(), true);

    // 21 °C is not 21 °F: a units change makes the number wrong, not just old
    state.forgetUnless("lisbon|imperial");
    assert.equal(state.hasReading(), false);
});
