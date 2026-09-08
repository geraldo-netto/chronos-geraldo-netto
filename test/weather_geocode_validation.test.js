const {
    assert, test, immediateNominatimQueue, loadWeather
} = require("./helpers/weatherFixture");

const PRIMARY_PLACE = { name: "Rome", latitude: 41.9, longitude: 12.5, population: 10000 };
const FALLBACK_PLACE = { display_name: "Rome", lat: "41.9", lon: "12.5", importance: 0.5 };

function geocodeRefresh(Weather, primary, fallback) {
    const decisions = [];
    const replies = [];
    const requests = [];
    const provider = new Weather.WeatherProvider({
        requestQueue: immediateNominatimQueue(),
        scheduler: {
            retry() { decisions.push("retry"); return true; },
            succeeded() { decisions.push("succeeded"); },
            retriesExhausted() { return false; },
            stop() {}
        },
        httpGetJson(url, callback) {
            requests.push(url);
            if (url.includes("geocoding-api")) {
                callback(primary);
            } else if (url.includes("nominatim")) {
                callback(fallback);
            } else {
                callback({ current_weather: { temperature: 20, weathercode: 0 } });
            }
        }
    });
    provider.refresh({ showWeather: true, location: "Rome", units: "si" },
        (reading, error) => replies.push({ reading, error }));
    provider.destroy();
    return { decisions, replies, requests };
}

test("Open-Meteo validates empty envelopes and candidate shapes independently of ranking", () => {
    const Weather = loadWeather();
    const valid = [{}, { generationtime_ms: 0 }, { generationtime_ms: 0.1 }, { results: [] },
        { results: [PRIMARY_PLACE] }, { results: [{ ...PRIMARY_PLACE, population: 1 }] },
        { results: [{ latitude: 41.9, longitude: 12.5 }] }];
    const invalid = [null, undefined, [], "", true, 1, { message: "maintenance" },
        { error: true, reason: "unavailable" }, { error: true, results: [PRIMARY_PLACE] },
        { reason: "unavailable" }, { results: null }, { results: {} },
        { results: "none" }, { generationtime_ms: "broken" }, { generationtime_ms: -1 },
        { results: [null, [], {}, { ...PRIMARY_PLACE, population: "many" }] }];

    for (const body of valid)
        assert.equal(Weather.isOpenMeteoGeocodeResponse(body), true, JSON.stringify(body));
    for (const body of invalid)
        assert.equal(Weather.isOpenMeteoGeocodeResponse(body), false, JSON.stringify(body));
});

test("Nominatim requires an empty array or a valid candidate", () => {
    const Weather = loadWeather();
    for (const body of [[], [FALLBACK_PLACE], [{ ...FALLBACK_PLACE, importance: undefined }]])
        assert.equal(Weather.isNominatimGeocodeResponse(body), true);
    for (const body of [null, {}, { error: "unavailable" }, "none", [null, {}, []],
        [{ ...FALLBACK_PLACE, importance: false }], [{ ...FALLBACK_PLACE, lat: 91 }]])
        assert.equal(Weather.isNominatimGeocodeResponse(body), false);
});

test("malformed geocoder responses retain the retryable service failure", () => {
    const Weather = loadWeather();
    const badPrimary = [{ error: true, reason: "temporarily unavailable" },
        { results: [null, {}] }, { results: null }, "maintenance"];
    for (const body of badPrimary) {
        const result = geocodeRefresh(Weather, body, [{ lat: false, lon: "12.5" }]);
        assert.deepEqual(result.replies, [{ reading: null, error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE }]);
        assert.deepEqual(result.decisions, ["retry"]);
    }
});

test("valid empty and untrusted geocode answers settle without transient retry", () => {
    const Weather = loadWeather();
    const emptyPairs = [[{}, null], [{ generationtime_ms: 0.2 }, null], [{ results: [] }, null],
        [null, []], [{ results: [{ ...PRIMARY_PLACE, population: 1 }] }, null],
        [{ results: [{ latitude: 41.9, longitude: 12.5 }] }, null]];
    for (const [primary, fallback] of emptyPairs) {
        const result = geocodeRefresh(Weather, primary, fallback);
        assert.deepEqual(result.replies, [{ reading: null, error: Weather.WEATHER_ERRORS.LOCATION_NOT_FOUND }]);
        assert.deepEqual(result.decisions, ["succeeded"]);
    }
});

test("malformed candidates leave healthy neighbors and fallback providers usable", () => {
    const Weather = loadWeather();
    const pairs = [
        [{ results: [null, { ...PRIMARY_PLACE, population: {} }, PRIMARY_PLACE] }, null],
        [{ results: [null] }, [null, { ...FALLBACK_PLACE, lat: 91 }, FALLBACK_PLACE]],
        [{ error: true, results: [PRIMARY_PLACE] }, [FALLBACK_PLACE]]
    ];
    for (const [primary, fallback] of pairs) {
        const before = JSON.stringify([primary, fallback]);
        const result = geocodeRefresh(Weather, primary, fallback);
        assert.equal(result.replies[0].reading.temperatureC, 20);
        assert.equal(result.replies[0].error, "");
        assert.deepEqual(result.decisions, ["succeeded"]);
        assert.equal(JSON.stringify([primary, fallback]), before);
    }
});

test("a custom geocoder must declare validity and complete normalization before counting as answered", () => {
    const Weather = loadWeather();
    const fail = () => { throw new Error("invalid response"); };
    const contracts = [
        { normalize: () => PRIMARY_PLACE },
        { isValidResponse: () => false, normalize: () => PRIMARY_PLACE },
        { isValidResponse: () => "yes", normalize: () => PRIMARY_PLACE },
        { isValidResponse: fail, normalize: () => PRIMARY_PLACE },
        { isValidResponse: () => true, normalize: fail }
    ];
    for (const contract of contracts) {
        const replies = [];
        const resolver = new Weather.WeatherLocationResolver({
            providers: [{ name: "custom", url: () => "https://example.test/", ...contract }],
            httpGetJson: (_url, callback) => callback({})
        });
        resolver.resolve("Rome", () => true, (place, error) => replies.push({ place, error }));
        assert.deepEqual(replies, [{ place: null, error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE }]);
    }
});
