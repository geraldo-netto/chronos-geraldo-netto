"use strict";

const assert = require("node:assert/strict");
const { makeRandom } = require("../helpers/prng");
const Adapters = require("../../files/chronos@geraldo-netto/weatherServiceAdapters");
const Format = require("../../files/chronos@geraldo-netto/weatherFormat");
const ZERO_COORDINATE_CASES = require("../fixtures/open_meteo_zero_coordinate_cases.json");
const TEMPERATURE_CASES = require("../fixtures/temperature_conversion_cases.json");
const TIMEZONE_CASES = require("../fixtures/timezone_nul_cases.json");

function pick(random, values) {
    return values[Math.floor(random() * values.length)];
}

function recorder(seed) {
    const report = { checks: 0, failureCount: 0, failures: [] };
    const seen = new Set();
    return {
        report,
        check(target, round, input, verify) {
            report.checks++;
            try {
                verify();
            } catch (error) {
                report.failureCount++;
                if (!seen.has(target)) {
                    seen.add(target);
                    report.failures.push({ target, seed, case: round, input,
                        message: String(error.message) });
                }
            }
        }
    };
}

function locationInput(random, round) {
    const fixed = [null, false, 0, [], {}, "", " ", "\ud800", "\udfff",
        "Genoa 🏙", "Plzeň", "a".repeat(255), "a".repeat(256), "a".repeat(257),
        "🏙".repeat(256), "🏙".repeat(257), "Boston\nUSA", "\u202eRome"];
    if (round < fixed.length) {
        return fixed[round];
    }
    const alphabet = ["a", "é", "東", "🏙", "\ud800", "\udfff", "\0", " ", "\u2028"];
    return Array.from({ length: Math.floor(random() * 270) }, () =>
        pick(random, alphabet)).join("");
}

function checkLocation(audit, random, round) {
    const input = locationInput(random, round);
    audit.check("weather.location.normalize", round, input, () => {
        const normalized = Format.normalizeWeatherLocation(input);
        assert.equal(typeof normalized, "string");
        assert.ok(!normalized.includes("\0"), "weather location retains a NUL that GTK truncates");
        assert.ok(Array.from(normalized).length <= 256);
        assert.equal(Format.normalizeWeatherLocation(normalized), normalized);
    });
    for (const [name, build] of [["open-meteo", Adapters.geocodeUrl],
        ["nominatim", Adapters.nominatimGeocodeUrl]]) {
        audit.check(`weather.location.url.${name}`, round, input, () => {
            const url = build(input, "en");
            const normalized = Format.normalizeWeatherLocation(input);
            assert.equal(Boolean(url), Boolean(normalized));
            if (url) {
                assert.ok(url.startsWith("https://"));
                assert.ok(url.includes(encodeURIComponent(normalized)));
            }
        });
    }
}

function checkNulLocation(audit, random, round) {
    const name = "Genova" + pick(random, ["é", "東", "🏙"]).repeat(Math.floor(random() * 20));
    const characters = Array.from(name);
    characters.splice(Math.floor(random() * (characters.length + 1)), 0, "\0");
    const input = characters.join("");
    audit.check("weather.location.nul", round, input, () => {
        assert.equal(Format.normalizeWeatherLocation(input), "");
        assert.equal(Adapters.geocodeUrl(input, "en"), "");
        assert.equal(Adapters.nominatimGeocodeUrl(input, "en"), "");
        assert.equal(Format.normalizeWeatherLocation(name), name);
    });
}

function checkNulTimezone(audit, random, round) {
    const clean = pick(random, TIMEZONE_CASES.valid);
    const offset = Math.floor(random() * (clean.length + 1));
    const generated = clean.slice(0, offset) + "\0" + clean.slice(offset);
    const input = round < TIMEZONE_CASES.invalid.length ? TIMEZONE_CASES.invalid[round] : generated;
    audit.check("weather.timezone.nul", round, input, () => {
        const candidate = { name: "Rome", latitude: 41.9, longitude: 12.5, population: 10000, timezone: input };
        const place = Adapters.openMeteoGeocodePlace({ results: [candidate] }, "Rome");
        assert.equal(place.timezone, "");
        assert.equal(Adapters.openMeteoTimezone({ timezone: input }), "");
        assert.equal(Adapters.openMeteoTimezone({ timezone: clean }), clean);
        const length = [63, 64, 65, 254, 255, 256][round % 6];
        assert.equal(Adapters.openMeteoTimezone({ timezone: "a".repeat(length) + "\0UTC" }), "");
    });
}

function malformedNumber(random, bound, round) {
    const fixed = [null, false, true, "", " ", [], {}, "NaN", "Infinity",
        bound + 0.000001, -bound - 0.000001, Number.MAX_VALUE, -Number.MAX_VALUE];
    if (round < fixed.length) {
        return fixed[round];
    }
    const outside = (bound + 1 + Math.floor(random() * 10000)) * pick(random, [-1, 1]);
    return pick(random, [outside, String(outside), "not-a-number", [outside]]);
}

function checkStation(audit, random, round) {
    const longitude = -170 + random() * 340;
    const latitude = -80 + random() * 160;
    const place = { latitude, longitude };
    const good = { icaoId: "GOOD", lat: latitude, lon: longitude + 0.25,
        temp: 20, cover: "CLR" };
    const axis = round % 2 ? "lat" : "lon";
    const bad = { icaoId: "BAD", lat: latitude, lon: longitude, temp: 99, cover: "CLR" };
    bad[axis] = malformedNumber(random, axis === "lat" ? 90 : 180, round);
    // Wrapped longitudes can falsely rank as a perfect match; keep this
    // generated family beside the generic out-of-range corpus.
    if (round >= 13 && round % 3 === 0) {
        bad.lon = longitude + 360 * (1 + Math.floor(random() * 5));
        bad.lat = latitude;
    }
    const stations = round % 2 ? [good, bad] : [bad, good];
    audit.check("weather.metar.invalid-neighbor", round, { stations, place }, () => {
        assert.equal(Adapters.aviationWeatherStation(stations, place)?.icaoId, "GOOD");
        assert.equal(Adapters.aviationWeatherReading(stations, place)?.temperatureC, 20);
    });
    audit.check("weather.metar.invalid-only", round, { bad, place }, () => {
        assert.equal(Adapters.aviationWeatherStation([bad], place), null);
        assert.equal(Adapters.aviationWeatherReading([bad], place), null);
    });
}

function checkGeocode(audit, random, round) {
    const axis = round % 2 ? "latitude" : "longitude";
    const bad = { name: "Genoa", latitude: 44.4, longitude: 8.9, population: 1e9 };
    bad[axis] = malformedNumber(random, axis === "latitude" ? 90 : 180, round);
    const good = { name: "Genoa", latitude: 44.4, longitude: 8.9, population: 500000 };
    const results = round % 2 ? [good, bad] : [bad, good];
    audit.check("weather.geocode.invalid-neighbor", round, results, () => {
        const before = JSON.stringify(results);
        assert.deepEqual(Adapters.openMeteoGeocodePlace({ results }, "Genoa"),
            { name: "Genoa", latitude: 44.4, longitude: 8.9, timezone: "" });
        assert.equal(JSON.stringify(results), before);
        assert.equal(Adapters.openMeteoGeocodePlace({ results: [bad] }, "Genoa"), null);
        assert.equal(Adapters.isOpenMeteoGeocodeResponse({ results }), true);
        assert.equal(Adapters.isOpenMeteoGeocodeResponse({ results: [bad] }), false);
    });
    const osm = results.map((row) => ({ display_name: row.name,
        lat: row.latitude, lon: row.longitude, importance: row.population }));
    audit.check("weather.nominatim.invalid-neighbor", round, osm, () => {
        assert.deepEqual(Adapters.nominatimGeocodePlace(osm, "Genoa"),
            { name: "Genoa", latitude: 44.4, longitude: 8.9 });
        assert.equal(Adapters.isNominatimGeocodeResponse(osm), true);
        const invalid = osm[round % 2 ? 1 : 0];
        assert.equal(Adapters.isNominatimGeocodeResponse([invalid]), false);
    });
}

function checkReadings(audit, random, round) {
    const malformed = pick(random, [null, false, true, "", "hot", "20", [], {},
        { temperature: 20 }, Number.NaN, Infinity, -Infinity]);
    const input = { type: typeof malformed,
        value: typeof malformed === "number" ? String(malformed) : malformed };
    audit.check("weather.reading.invalid-temperature", round, input, () => {
        assert.equal(Adapters.weatherReading({ temperature: malformed, weathercode: 0 }), null);
        assert.equal(Adapters.metNoWeatherReading({ properties: { timeseries: [{ data: {
            instant: { details: { air_temperature: malformed } }
        } }] } }), null);
    });
    const value = -100 + random() * 200;
    audit.check("weather.reading.valid-control", round, value, () => {
        assert.equal(Adapters.weatherReading({ temperature: value, weathercode: 0 })
            .temperatureC, value);
        const reading = Adapters.aviationWeatherReading(
            [{ lat: 0, lon: 180, temp: String(value), cover: "CLR" }],
            { latitude: 0, longitude: -180 });
        assert.equal(reading.temperatureC, value);
    });
}

function checkOmittedCoordinates(audit, round) {
    const { input, place } = ZERO_COORDINATE_CASES[round % ZERO_COORDINATE_CASES.length];
    audit.check("weather.geocode.omitted-zero", round, input, () => {
        const before = JSON.stringify(input);
        const data = { results: [input] };
        assert.equal(Adapters.isOpenMeteoGeocodeResponse(data), true);
        assert.deepEqual(Adapters.openMeteoGeocodePlace(data, "Point"), place);
        assert.equal(JSON.stringify(input), before);
    });
}

function temperatureBoundary(random, round) {
    const limit = Number.MAX_VALUE / 1.8;
    const fixed = [2e307, -2e307, limit, -limit, limit * (1 + Number.EPSILON),
        -limit * (1 + Number.EPSILON), Number.MAX_VALUE, -Number.MAX_VALUE, 0, 20, -40];
    return round < fixed.length ? fixed[round] :
        limit * (0.25 + random() * 1.5) * pick(random, [-1, 1]);
}

function checkTemperatureBoundary(audit, random, round) {
    const value = temperatureBoundary(random, round);
    audit.check("weather.temperature.conversion-boundary", round, value, () => {
        const expectedValid = Math.abs(value) <= Number.MAX_VALUE / 1.8;
        assert.equal(Format.validTemperature(value), expectedValid);
        const reading = Adapters.weatherReading({ temperature: value, weathercode: 0 });
        assert.equal(Boolean(reading), expectedValid);
        for (const units of ["si", "imperial"]) {
            const text = Format.formatTemperature(value, units);
            assert.equal(Boolean(text), expectedValid);
            assert.doesNotMatch(text, /NaN|Infinity/);
        }
        const fixture = TEMPERATURE_CASES[round % TEMPERATURE_CASES.length];
        assert.equal(Format.formatTemperature(fixture.celsius, "si"), fixture.si);
        assert.equal(Format.formatTemperature(fixture.celsius, "imperial"), fixture.imperial);
    });
}

function runWeatherInputs({ seed, cases }) {
    const audit = recorder(seed);
    const random = makeRandom(seed);
    for (let round = 0; round < cases; round++) {
        checkLocation(audit, random, round);
        checkNulLocation(audit, random, round);
        checkNulTimezone(audit, random, round);
        checkStation(audit, random, round);
        checkGeocode(audit, random, round);
        checkOmittedCoordinates(audit, round);
        checkTemperatureBoundary(audit, random, round);
        checkReadings(audit, random, round);
    }
    return audit.report;
}

module.exports = { runWeatherInputs };
