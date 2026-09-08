const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadWeather } = require("./helpers/weatherFixture");

function forecastFixture(t, hook, withFallback = true) {
    const Weather = loadWeather();
    const requests = [];
    const errors = [];
    const reading = { temperatureC: 20, condition: "☀" };
    const failure = new Error(`T1148: broken ${hook}`);
    const broken = {
        name: "Broken",
        urls: () => ["https://broken.example/a", "https://broken.example/b"],
        merge: (payloads) => payloads,
        normalize: () => reading,
        timezoneFor: () => "Europe/Rome",
        [hook]: () => { throw failure; }
    };
    const healthy = {
        name: "Healthy", url: () => "https://healthy.example/forecast",
        normalize: () => reading, timezoneFor: () => "Europe/Rome"
    };
    const originalLogError = global.logError;
    global.logError = (error) => errors.push(error);
    t.after(() => { global.logError = originalLogError; });
    const forecastResolver = new Weather.WeatherForecastResolver({
        httpGetJson: (url, done) => requests.push({ url, done }),
        providers: withFallback ? [broken, healthy] : [broken]
    });
    const repository = new Weather.WeatherReadingRepository({
        forecastResolver,
        locationResolver: {
            resolve: (_location, _current, done) => done({ latitude: 41.9, longitude: 12.5 }, "")
        }
    });
    t.after(() => repository.destroy());
    return { Weather, requests, errors, reading, failure, repository };
}

for (const hook of ["merge", "normalize", "timezoneFor"]) {
    test(`T1148: asynchronous ${hook} failure settles shared forecast subscribers`, (t) => {
        const fixture = forecastFixture(t, hook);
        const { repository, requests, errors, failure, reading } = fixture;
        const delivered = [];
        const subscribe = () => repository.refresh("Rome", () => true,
            (...args) => delivered.push(args));
        subscribe();
        subscribe();
        assert.equal(requests.length, 2, "subscribers share the multi-request attempt");
        requests[0].done({});
        assert.equal(delivered.length, 0);
        assert.doesNotThrow(() => requests[1].done({}), "adapter failures must trigger fallback");
        assert.equal(requests[2].url, "https://healthy.example/forecast");
        requests[1].done({});
        assert.equal(requests.length, 3, "duplicate replies cannot restart fallback");
        requests[2].done({});
        assert.equal(delivered.length, 2);
        assert.ok(delivered.every(([value, error, provider, place]) =>
            value === reading && error === "" && provider === "Healthy" && place.timezone === "Europe/Rome"));
        assert.ok(errors.includes(failure), "the adapter error is reported");
        assert.equal(repository._inflight.size, 0);
        subscribe();
        assert.equal(requests[3].url, "https://healthy.example/forecast", "another refresh starts normally");
        requests[3].done({});
        assert.equal(delivered.length, 3);
    });
}

test("T1148: an exhausted adapter failure frees the flight and permits retry", (t) => {
    const { Weather, repository, requests } = forecastFixture(t, "normalize", false);
    const delivered = [];
    const subscribe = () => repository.refresh("Rome", () => true, (...args) => delivered.push(args));
    subscribe();
    requests[0].done({});
    assert.doesNotThrow(() => requests[1].done({}));
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].slice(0, 3), [null, Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE, ""]);
    assert.equal(repository._inflight.size, 0);
    subscribe();
    assert.equal(requests.length, 4, "a retry must not join a stranded flight");
});

test("T1148: fallback preserves downstream exceptions after settling other subscribers", (t) => {
    const { repository, requests } = forecastFixture(t, "merge");
    const consumerError = new Error("consumer failed");
    const delivered = [];
    repository.refresh("Rome", () => true, () => { throw consumerError; });
    repository.refresh("Rome", () => true, (reading) => delivered.push(reading));
    requests[0].done({});
    assert.doesNotThrow(() => requests[1].done({}));
    assert.throws(() => requests[2].done({}), (error) => error === consumerError);
    assert.equal(delivered.length, 1, "a failing subscriber cannot strand its neighbor");
    assert.equal(repository._inflight.size, 0);
    assert.equal(requests.length, 3, "consumer errors must not cause another provider attempt");
});
