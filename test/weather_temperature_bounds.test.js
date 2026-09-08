const { assert, test, loadWeather, immediateNominatimQueue } = require("./helpers/weatherFixture");
const cases = require("./fixtures/temperature_conversion_cases.json");

function metNoForecast(temperature) {
    return { properties: { timeseries: [{ data: {
        instant: { details: { air_temperature: temperature } }
    } }] } };
}

function readingsFor(Weather, temperature) {
    return [Weather.weatherReading({ temperature, weathercode: 0 }),
        Weather.metNoWeatherReading(metNoForecast(temperature)),
        Weather.aviationWeatherReading([{ lat: 0, lon: 0, temp: temperature }],
            { latitude: 0, longitude: 0 })];
}

test("temperature conversion remains finite for both units without intermediate overflow", () => {
    const Weather = loadWeather();
    for (const { celsius, si, imperial } of cases) {
        assert.equal(Weather.validTemperature(celsius), true);
        assert.equal(Weather.formatTemperature(celsius, "si"), si);
        assert.equal(Weather.formatTemperature(celsius, "imperial"), imperial);
        for (const reading of readingsFor(Weather, celsius))
            assert.equal(reading.temperatureC, celsius);
    }
});

test("temperatures that overflow final conversion are refused in both units and every adapter", () => {
    const Weather = loadWeather();
    const limit = Number.MAX_VALUE / 1.8;
    const invalid = [Number.MAX_VALUE, -Number.MAX_VALUE,
        limit * (1 + Number.EPSILON), -limit * (1 + Number.EPSILON), NaN, Infinity, -Infinity];
    for (const value of invalid) {
        assert.equal(Weather.validTemperature(value), false);
        assert.equal(Weather.formatTemperature(value, "si"), "");
        assert.equal(Weather.formatTemperature(value, "imperial"), "");
        assert.deepEqual(readingsFor(Weather, value), [null, null, null]);
    }
});

test("direct formatter inputs never coerce malformed values into temperatures", () => {
    const Weather = loadWeather();
    for (const value of [null, undefined, false, true, "20", "", [], {}, Symbol("temperature")]) {
        assert.equal(Weather.validTemperature(value), false);
        assert.equal(Weather.formatTemperature(value, "si"), "");
        assert.equal(Weather.formatTemperature(value, "imperial"), "");
    }
});

test("a METAR temperature unsafe in Fahrenheit cannot beat a healthy neighboring station", () => {
    const Weather = loadWeather();
    const place = { latitude: 10, longitude: 10 };
    const good = { icaoId: "GOOD", lat: 10, lon: 10.1, temp: "2e307" };
    for (const temp of [Number.MAX_VALUE, -Number.MAX_VALUE, String(Number.MAX_VALUE)]) {
        const bad = { icaoId: "BAD", lat: 10, lon: 10, temp };
        assert.equal(Weather.aviationWeatherStation([bad], place), null);
        assert.equal(Weather.aviationWeatherStation([bad, good], place), good);
        assert.equal(Weather.aviationWeatherReading([good, bad], place).temperatureC, 2e307);
    }
});

function weatherTransport(values, requests) {
    return (url, callback) => {
        requests.push(url);
        if (url.includes("geocoding-api")) {
            callback({ results: [{ name: "Point", latitude: 10, longitude: 10, population: 1000 }] });
        } else if (url.includes("api.open-meteo.com")) {
            callback({ current_weather: { temperature: values.primary, weathercode: 0 } });
        } else if (url.includes("aviationweather.gov")) {
            callback([{ lat: 10, lon: 10, temp: values.station, cover: "CLR" }]);
        } else {
            callback(metNoForecast(values.fallback));
        }
    };
}

function cachedRepository(Weather, values, requests) {
    return new Weather.WeatherReadingRepository({
        cacheSeconds: 60, freshnessNow: () => 0,
        requestQueue: immediateNominatimQueue(), httpGetJson: weatherTransport(values, requests)
    });
}

test("a large accepted reading stays finite when the cached result changes display units", () => {
    const Weather = loadWeather();
    const requests = [];
    const repository = cachedRepository(Weather, { primary: 2e307 }, requests);
    const replies = [];
    const receive = (reading, error) => replies.push({ reading, error });
    repository.refresh("Point", () => true, receive);
    repository.refresh("Point", () => true, receive);

    assert.equal(requests.length, 2);
    assert.equal(replies[1].reading, replies[0].reading);
    assert.equal(replies[0].error, "");
    assert.equal(Weather.formatTemperature(replies[0].reading.temperatureC, "si"), "2e+307°C");
    assert.equal(Weather.formatTemperature(replies[1].reading.temperatureC, "imperial"), "3.6e+307°F");
    repository.destroy();
});

test("unsafe provider temperatures fall through and only a valid fallback is cached", () => {
    const Weather = loadWeather();
    const requests = [];
    const repository = cachedRepository(Weather, {
        primary: Number.MAX_VALUE, station: -Number.MAX_VALUE, fallback: -20
    }, requests);
    const replies = [];
    const receive = (reading, error, provider) => replies.push({ reading, error, provider });
    repository.refresh("Point", () => true, receive);
    repository.refresh("Point", () => true, receive);

    assert.equal(requests.length, 4);
    assert.equal(replies[0].reading.temperatureC, -20);
    assert.equal(replies[0].provider, Weather.WEATHER_PROVIDER_NAMES.MET_NO);
    assert.equal(replies[0].error, "");
    assert.equal(replies[1].reading, replies[0].reading);
    repository.destroy();
});

test("failed unsafe readings are never cached and the next request can recover", () => {
    const Weather = loadWeather();
    const values = { primary: Number.MAX_VALUE, station: Number.MAX_VALUE, fallback: Number.MAX_VALUE };
    const requests = [];
    const repository = cachedRepository(Weather, values, requests);
    const replies = [];
    const receive = (reading, error) => replies.push({ reading, error });
    repository.refresh("Point", () => true, receive);
    assert.deepEqual(replies, [{ reading: null, error: Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE }]);

    values.primary = 20;
    repository.refresh("Point", () => true, receive);
    assert.equal(requests.length, 5);
    assert.equal(replies[1].reading.temperatureC, 20);
    assert.equal(replies[1].error, "");
    repository.destroy();
});

test("an exhausted unsafe forecast keeps the panel's last good reading", () => {
    const Weather = loadWeather();
    const values = { primary: 20, station: Number.MAX_VALUE, fallback: Number.MAX_VALUE };
    const provider = new Weather.WeatherProvider({
        requestQueue: immediateNominatimQueue(), httpGetJson: weatherTransport(values, [])
    });
    const replies = [];
    const receive = (reading, error) => replies.push({ reading, error });
    provider.refresh({ showWeather: true, location: "Point", units: "si" }, receive);
    values.primary = Number.MAX_VALUE;
    provider.refresh({ showWeather: true, location: "Point", units: "imperial" }, receive);

    assert.equal(replies[1].reading, replies[0].reading);
    assert.equal(replies[1].error, Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE);
    assert.equal(Weather.formatTemperature(replies[1].reading.temperatureC, "imperial"), "68°F");
    provider.destroy();
});

test("injected forecast providers obey the same temperature contract", () => {
    const Weather = loadWeather();
    const resolver = new Weather.WeatherForecastResolver({
        providers: [
            { name: "unsafe", url: () => "https://unsafe.test/",
                normalize: () => ({ condition: "☀", temperatureC: Number.MAX_VALUE }) },
            { name: "valid", url: () => "https://valid.test/",
                normalize: () => ({ condition: "☀", temperatureC: 20 }) }
        ],
        httpGetJson: (_url, callback) => callback({})
    });
    const replies = [];
    resolver.refresh({ latitude: 0, longitude: 0 }, () => true,
        (reading, error, provider) => replies.push({ reading, error, provider }));
    assert.deepEqual(replies, [{ reading: { condition: "☀", temperatureC: 20 }, error: "", provider: "valid" }]);
});
