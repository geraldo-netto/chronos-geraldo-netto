const {
    assert, test, immediateNominatimQueue, loadWeather
} = require("./helpers/weatherFixture");
const cases = require("./fixtures/open_meteo_zero_coordinate_cases.json");
const { URL } = require("node:url");

test("Open-Meteo decodes absent zero coordinates in validation and selection", () => {
    const Weather = loadWeather();
    for (const { input, place } of cases) {
        const before = JSON.stringify(input);
        assert.equal(Weather.isOpenMeteoGeocodeResponse({ results: [input] }), true);
        assert.deepEqual(Weather.openMeteoGeocodePlace({ results: [input] }, "Point"), place);
        assert.equal(JSON.stringify(input), before);
    }
});

test("explicit malformed coordinates never receive protobuf defaults or beat healthy neighbors", () => {
    const Weather = loadWeather();
    const good = { name: "Point", population: 1000 };
    const expected = { name: "Point", latitude: 0, longitude: 0, timezone: "" };
    for (const [axis, bound] of [["latitude", 90], ["longitude", 180]]) {
        for (const value of [undefined, null, false, true, "", " ", {}, [], NaN,
            Infinity, -Infinity, bound + 0.01, -bound - 0.01]) {
            const bad = { name: "Point", population: 10000, [axis]: value };
            assert.equal(Weather.isOpenMeteoGeocodeResponse({ results: [bad] }), false);
            assert.equal(Weather.openMeteoGeocodePlace({ results: [bad] }, "Point"), null);
            assert.equal(Weather.isOpenMeteoGeocodeResponse({ results: [bad, good] }), true);
            assert.deepEqual(Weather.openMeteoGeocodePlace({ results: [bad, good] }, "Point"), expected);
        }
    }
});

test("zero coordinate defaults preserve ranking refusal and malformed-only response failure", () => {
    const Weather = loadWeather();
    const untrusted = { name: "Point", population: 5 };
    const alternative = { name: "Other", latitude: 10, longitude: 20, population: 10000 };
    const data = { results: [untrusted, alternative] };
    assert.equal(Weather.isOpenMeteoGeocodeResponse(data), true);
    assert.equal(Weather.openMeteoGeocodePlace(data, "Point"), null);
    assert.equal(Weather.isOpenMeteoGeocodeResponse({ results: [{ name: "Point" }] }), true);
    assert.equal(Weather.isOpenMeteoGeocodeResponse({ results: [{}, { error: "unavailable" }] }), false);
    assert.equal(Weather.isNominatimGeocodeResponse([{ display_name: "Point", importance: 1 }]), false);
});

test("two absent coordinates require a recognizable name or valid identifier", () => {
    const Weather = loadWeather();
    const malformed = [{}, { population: 1000 }, { timezone: 42 }, { name: " \ufeff\t", population: 1000 },
        { id: 0 }, { id: -1 }, { id: "12345" }, { id: 1.5 }, { id: 2147483648 }];
    for (const input of malformed) {
        assert.equal(Weather.isOpenMeteoGeocodeResponse({ results: [input] }), false);
        assert.equal(Weather.openMeteoGeocodePlace({ results: [input] }, "Point"), null);
    }
});

function cachedZeroCoordinateReading(Weather, input) {
    const requests = [];
    const httpGetJson = (url, callback) => {
        requests.push(new URL(url));
        callback(url.includes("geocoding-api") ? { results: [input] } :
            { current_weather: { temperature: 20, weathercode: 0 } });
    };
    const resolver = new Weather.WeatherLocationResolver({
        httpGetJson, requestQueue: immediateNominatimQueue()
    });
    const repository = new Weather.WeatherReadingRepository({
        locationResolver: resolver, httpGetJson, cacheSeconds: 60, freshnessNow: () => 0
    });
    const replies = [];
    repository.refresh("Point", () => true, (reading, error) => replies.push({ reading, error }));
    repository.refresh("Point", () => true, (reading, error) => replies.push({ reading, error }));
    const place = resolver.placeFor("Point");
    repository.destroy();
    return { requests, replies, place };
}

test("decoded coordinates reach the retained place, forecast URL, and reading cache", () => {
    const Weather = loadWeather();
    for (const { input, place } of cases) {
        const result = cachedZeroCoordinateReading(Weather, input);
        assert.deepEqual(result.place, place);
        assert.equal(result.requests.length, 2);
        assert.equal(result.requests[1].searchParams.get("latitude"), String(place.latitude));
        assert.equal(result.requests[1].searchParams.get("longitude"), String(place.longitude));
        assert.equal(result.replies.length, 2);
        assert.equal(result.replies[0].reading.temperatureC, 20);
        assert.equal(result.replies[0].error, "");
        assert.equal(result.replies[1].reading, result.replies[0].reading);
    }
});
