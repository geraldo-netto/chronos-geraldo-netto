const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");
const { makeSoup3 } = require("./helpers/soup");

const APPLET_DIR = path.join(__dirname, "..", "files", "chronos@geraldo-netto");
const modulePath = path.join(APPLET_DIR, "cityWeather.js");
const weatherPath = path.join(APPLET_DIR, "weather.js");
const schedulerPath = path.join(APPLET_DIR, "weatherScheduler.js");
const providersPath = path.join(APPLET_DIR, "weatherProviders.js");
const ioUtilsPath = path.join(APPLET_DIR, "ioUtils.js");

// Seeded PRNG so fuzz failures reproduce; change FUZZ_SEED to explore
const FUZZ_SEED = 20260712;

let originalImports;
let originalLogError;
let soup;

function loadCityWeather(soupOptions = {}) {
    // the HTTP path lives in ioUtils, which captures Soup at load time: reload
    // it so the default (uninjected) session speaks to this call's mock
    [modulePath, weatherPath, schedulerPath, providersPath, ioUtilsPath].forEach(
        (file) => delete require.cache[require.resolve(file)]);

    soup = makeSoup3(Object.assign({ data: "{}" }, soupOptions));

    global.imports = {
        byteArray: { toString: (data) => data.toString() },
        gi: {
            Cinnamon: {},
            CinnamonDesktop: { WallClock: { lctime_format: (domain, format) => format } },
            Gio: {},
            GLib: {
                PRIORITY_DEFAULT: 0,
                SOURCE_CONTINUE: true,
                SOURCE_REMOVE: false,
                timeout_add: () => 2,
                timeout_add_seconds: () => 1,
                source_remove() {}
            },
            Soup: soup
        }
    };

    return require(modulePath);
}

// the unit-free record { condition, temperatureC } a display string stands for.
// The provider stores records now; the test tables stay written as readable
// strings and R() turns them into the record the resolver hands over.
function R(text) {
    if (!text) {
        return null;
    }
    const chars = Array.from(text);
    return { condition: chars[0], temperatureC: parseFloat(chars.slice(1).join("")) };
}

// a resolver pair that answers from a table instead of the network
function stubResolvers(readings, calls = {}) {
    calls.geocodes = calls.geocodes || [];
    calls.forecasts = calls.forecasts || [];

    // the real resolvers ask isCurrent() before answering; the stubs do too, so
    // the provider's generation guards are exercised the same way
    return {
        locationResolver: {
            resolve(city, isCurrent, callback) {
                calls.geocodes.push(city);
                if (!isCurrent()) {
                    return;
                }
                if (!Object.prototype.hasOwnProperty.call(readings, city)) {
                    callback(null, "Location not found");
                    return;
                }
                callback({ latitude: 1, longitude: 2 }, "");
            }
        },
        forecastResolver: {
            // the port hands back a unit-free record and nothing else: no units
            // reach it, and no display text leaves it
            refresh(place, isCurrent, callback) {
                calls.forecasts.push(place);
                if (!isCurrent()) {
                    return;
                }
                const text = readings[calls.geocodes[calls.geocodes.length - 1]] || "";
                callback(R(text), "", "Open-Meteo");
            }
        }
    };
}

beforeEach(() => {
    originalImports = global.imports;
    originalLogError = global.logError;
    global.logError = function() {};
});

afterEach(() => {
    global.imports = originalImports;
    global.logError = originalLogError;
});

test("every world-clock city gets its own reading", () => {
    const CityWeather = loadCityWeather();
    const calls = {};
    const provider = new CityWeather.CityWeatherProvider(
        Object.assign({ httpGetJson() {} }, stubResolvers({ "São Paulo": "⛅ 24°C", Tokyo: "☀ 31°C" }, calls)));
    let updates = 0;

    provider.refresh({ showWeather: true, units: "si", cities: ["São Paulo", "Tokyo", "Atlantis"] },
        () => updates++);

    assert.deepEqual(provider.recordFor("São Paulo"), R("⛅ 24°C"));
    assert.deepEqual(provider.recordFor("Tokyo"), R("☀ 31°C"));
    // a city that will not geocode simply has no temperature; its clock row
    // still shows the time
    assert.equal(provider.recordFor("Atlantis"), null);
    assert.equal(provider.lastProvider, "Open-Meteo");
    // the callback rebuilds the whole panel label and tooltip, padding every
    // column to its widest cell: a round of eight cities used to trigger eight
    // of them, for one set of readings nobody can read until they are all in
    assert.equal(updates, 1, "the panel is repainted once, when the round finishes");
    // the lookup is case- and space-insensitive, like the panel location cache
    assert.deepEqual(provider.recordFor(" tokyo "), R("☀ 31°C"));
});

test("readings are dropped when weather is off or the city is removed", () => {
    const CityWeather = loadCityWeather();
    const provider = new CityWeather.CityWeatherProvider(
        Object.assign({ httpGetJson() {} }, stubResolvers({ Tokyo: "☀ 31°C", Lisbon: "☁ 17°C" })));

    provider.refresh({ showWeather: true, units: "si", cities: ["Tokyo", "Lisbon"] }, () => {});
    assert.deepEqual(provider.recordFor("Tokyo"), R("☀ 31°C"));

    provider.refresh({ showWeather: true, units: "si", cities: ["Tokyo"] }, () => {});
    assert.equal(provider.recordFor("Lisbon"), null, "a removed clock leaves no stale temperature");
    assert.deepEqual(provider.recordFor("Tokyo"), R("☀ 31°C"));

    provider.refresh({ showWeather: true, units: "si", cities: [] }, () => {});
    assert.equal(provider.recordFor("Tokyo"), null, "an empty clock list clears its reading");
    assert.equal(provider.lastProvider, "", "an empty clock list clears its attribution");

    provider.refresh({ showWeather: true, units: "si", cities: ["Tokyo"] }, () => {});
    assert.equal(provider.lastProvider, "Open-Meteo");

    // weather is opt-in: with it off, no city is read and nothing is kept
    provider.refresh({ showWeather: false, units: "si", cities: ["Tokyo"] }, () => {});
    assert.equal(provider.recordFor("Tokyo"), null);
    assert.equal(provider.lastProvider, "", "disabled weather carries no stale attribution");
});

test("duplicate and blank cities are asked for once, and only eight at most", () => {
    const CityWeather = loadCityWeather();
    const calls = {};
    const provider = new CityWeather.CityWeatherProvider(
        Object.assign({ httpGetJson() {} }, stubResolvers({}, calls)));
    const cities = ["Rome", "rome", " ", "", "Rome "].concat(
        Array.from({ length: 10 }, (_unused, index) => "City" + index));

    provider.refresh({ showWeather: true, units: "si", cities }, () => {});

    assert.equal(calls.geocodes.length, CityWeather.MAX_CITIES);
    assert.equal(calls.geocodes[0], "Rome");
    assert.equal(calls.geocodes.filter((city) => city.toLowerCase().trim() === "rome").length, 1);
});

test("a stale refresh and a destroyed provider write nothing", () => {
    const CityWeather = loadCityWeather();
    const pending = [];
    const provider = new CityWeather.CityWeatherProvider({
        httpGetJson() {},
        locationResolver: {
            resolve(city, isCurrent, callback) {
                pending.push(() => callback({ latitude: 1, longitude: 2 }, ""));
            }
        },
        forecastResolver: {
            refresh(place, isCurrent, callback) {
                callback(R("☀ 20°C"), "", "Open-Meteo");
            }
        }
    });

    provider.refresh({ showWeather: true, units: "si", cities: ["Rome"] }, () => {});
    // the user edited the clocks before the first geocode came back
    provider.refresh({ showWeather: true, units: "si", cities: ["Tokyo"] }, () => {});
    pending[0]();
    assert.equal(provider.recordFor("Rome"), null, "the superseded lookup is dropped");

    provider.destroy();
    pending[1]();
    assert.equal(provider.recordFor("Rome"), null);
});

test("scheduling arms a repeating timer only while there are cities to read", () => {
    const CityWeather = loadCityWeather();
    const timers = [];
    const removed = [];
    const params = Object.assign({
        httpGetJson() {},
        scheduleTimer: (seconds, callback) => {
            timers.push({ seconds, callback });
            return timers.length;
        },
        removeTimer: (id) => removed.push(id)
    }, stubResolvers({ Rome: "☀ 20°C" }));
    const provider = new CityWeather.CityWeatherProvider(params);

    provider.schedule({ showWeather: true, units: "si", cities: ["Rome"] }, () => {});
    assert.equal(timers.length, 1);
    assert.equal(timers[0].seconds, CityWeather.CITY_REFRESH_SECONDS);

    provider.schedule({ showWeather: true, units: "si", cities: [] }, () => {});
    assert.deepEqual(removed, [1], "the old timer is dropped before the new schedule");
    assert.equal(timers.length, 1, "no timer with nothing to read");

    provider.schedule({ showWeather: false, units: "si", cities: ["Rome"] }, () => {});
    assert.equal(timers.length, 1);
});

// Regression: the weather location is a Cinnamon text entry, which fires on
// every keystroke. Each one re-read every city, so typing a nine-letter city
// name with eight clocks configured was over seventy forecast requests in a
// couple of seconds — enough for the free tiers to rate-limit the user.
test("typing the panel location does not re-read the world-clock cities", () => {
    const CityWeather = loadCityWeather();
    const calls = {};
    const timers = [];
    const provider = new CityWeather.CityWeatherProvider(Object.assign({
        httpGetJson() {},
        scheduleTimer: (seconds, callback) => {
            timers.push({ seconds, callback });
            return timers.length;
        },
        removeTimer: () => {}
    }, stubResolvers({ Rome: "☀ 20°C", Tokyo: "☀ 31°C" }, calls)));

    const settings = { showWeather: true, units: "si", cities: ["Rome", "Tokyo"] };
    provider.schedule(settings, () => {});
    assert.equal(calls.forecasts.length, 2, "both cities are read once");

    // the applet re-schedules on every keystroke in the location entry; the
    // cities it reads have not changed
    for (let keystroke = 0; keystroke < "Amsterdam".length; keystroke++) {
        provider.schedule(settings, () => {});
    }

    assert.equal(calls.forecasts.length, 2, "and are not read again");
    assert.equal(timers.length, 1, "nor is the refresh timer rebuilt");

    // adding a clock is a real change; switching the unit is not — the readings
    // are unit-free records, so °F re-renders what is already held rather than
    // geocoding and refetching every city again
    provider.schedule({ showWeather: true, units: "si", cities: ["Rome", "Tokyo", "Rome"] }, () => {});
    assert.equal(calls.forecasts.length, 2, "a duplicate city is not a change");

    provider.schedule({ showWeather: true, units: "imperial", cities: ["Rome", "Tokyo"] }, () => {});
    assert.equal(calls.forecasts.length, 2, "and neither is a different unit");

    provider.schedule({ showWeather: true, units: "si", cities: ["Rome", "Tokyo", "Oslo"] }, () => {});
    assert.equal(calls.forecasts.length, 4, "a new clock is: the round runs again");
});

test("delimiter-bearing labels cannot hide a changed city list", () => {
    const CityWeather = loadCityWeather();
    const rounds = [];
    const provider = new CityWeather.CityWeatherProvider({
        httpGetJson() {},
        scheduler: {
            timerId: 7,
            schedule: (settings) => rounds.push(settings),
            stop() {},
            succeeded() {},
            retry() {},
            retriesExhausted: () => false
        },
        locationResolver: { resolve() {} },
        forecastResolver: { refresh() {} }
    });

    provider.schedule({
        showWeather: true,
        cities: [{ label: "a@Tokyo,b", query: "Rome" }]
    }, () => {});
    provider.schedule({
        showWeather: true,
        cities: [
            { label: "a", query: "Tokyo" },
            { label: "b", query: "Rome" }
        ]
    }, () => {});

    assert.equal(rounds.length, 2, "a structurally different city list is scheduled");
});

// Regression: schedule() used to arm the 30-minute timer unconditionally, so a
// popup with only built-in clocks — or with weather switched off — woke the
// applet up every half hour to read nothing at all.
test("regression: an empty city list or weather off arms no timer", () => {
    const CityWeather = loadCityWeather();
    const timers = [];
    const provider = new CityWeather.CityWeatherProvider(Object.assign({
        httpGetJson() {},
        scheduleTimer: (seconds, callback) => {
            timers.push({ seconds, callback });
            return timers.length;
        },
        removeTimer() {}
    }, stubResolvers({ Rome: "☀ 20°C" })));

    provider.schedule({ showWeather: true, units: "si", cities: [] }, () => {});
    provider.schedule({ showWeather: true, units: "si", cities: ["", "   ", null] }, () => {});
    provider.schedule({ showWeather: false, units: "si", cities: ["Rome"] }, () => {});
    provider.schedule({}, () => {});
    provider.schedule({ showWeather: true, units: "si", cities: "Rome" }, () => {});

    assert.deepEqual(timers, [], "nothing to read means nothing to re-read");
});

// with nothing injected the provider must still work: GLib drives the timer and
// the shared Soup session answers the geocode, exactly as it does in the panel
test("the constructor falls back to GLib timers and a Utils HTTP session", () => {
    const CityWeather = loadCityWeather();
    const timeouts = [];
    const removed = [];
    global.imports.gi.GLib.timeout_add_seconds = (priority, seconds, callback) => {
        timeouts.push({ priority, seconds, callback });
        return 77;
    };
    global.imports.gi.GLib.source_remove = (id) => removed.push(id);

    const provider = new CityWeather.CityWeatherProvider();
    let updates = 0;

    provider.schedule({ showWeather: true, units: "si", cities: ["Rome"] }, () => updates++);

    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].priority, global.imports.gi.GLib.PRIORITY_DEFAULT);
    assert.equal(timeouts[0].seconds, CityWeather.CITY_REFRESH_SECONDS);

    // the mock session answers "{}", so both geocode providers come back empty:
    // the point is that the default httpGetJson reached the wire at all
    const geocodes = soup.messages.filter((message) => message.url.includes("geocoding-api"));
    assert.equal(geocodes.length, 1);
    assert.equal(provider.recordFor("Rome"), null);

    // the periodic callback re-reads and stays armed
    assert.equal(timeouts[0].callback(), global.imports.gi.GLib.SOURCE_CONTINUE);
    assert.equal(soup.messages.filter((message) => message.url.includes("geocoding-api")).length, 2);

    provider.stop();
    assert.deepEqual(removed, [77], "the default remover is GLib.source_remove");
});

// The city provider takes an httpSession the same way the panel provider does —
// both hold the one lazy-session lifecycle now — and nothing exercised that
// parameter here: a session handed to this provider was never proven to be the
// session it used, or the one it aborted.
test("a session it is given is the one it uses and the one it aborts", () => {
    const CityWeather = loadCityWeather();
    const session = { abort() { this.aborted = true; } };
    const provider = new CityWeather.CityWeatherProvider({ httpSession: session });

    assert.equal(provider._session.created, null, "and it is still lazy");
    assert.equal(provider._getHttpSession(), session);
    assert.equal(provider._getHttpSession(), session, "asked twice, built once");

    provider.destroy();
    assert.equal(session.aborted, true);
});

test("destroy aborts the session and turns schedule and refresh into no-ops", () => {
    const aborts = [];
    const CityWeather = loadCityWeather({
        sessionMethods: {
            abort() {
                aborts.push(this);
            }
        }
    });
    const timers = [];
    const calls = {};
    const provider = new CityWeather.CityWeatherProvider(Object.assign({
        scheduleTimer: (seconds, callback) => {
            timers.push({ seconds, callback });
            return timers.length;
        },
        removeTimer() {}
    }, stubResolvers({ Rome: "☀ 20°C" }, calls)));
    const settings = { showWeather: true, units: "si", cities: ["Rome"] };
    let updates = 0;

    // the resolvers are stubbed, so nothing asks for the session on its own;
    // build it so there is a live one for destroy to abort (the session is lazy
    // now — a provider whose feature is never used never allocates one)
    assert.equal(provider._session.created, null, "the session is not built at construction");
    provider._getHttpSession();

    provider.refresh(settings, () => updates++);
    assert.deepEqual(provider.recordFor("Rome"), R("☀ 20°C"));

    provider.destroy();
    assert.equal(aborts.length, 1, "an in-flight request must not outlive the applet");
    assert.equal(provider.recordFor("Rome"), null, "destroy drops the readings");

    // a settings signal that lands during teardown must not restart the applet
    provider.schedule(settings, () => updates++);
    provider.refresh(settings, () => updates++);

    assert.equal(timers.length, 0);
    assert.equal(calls.geocodes.length, 1, "no lookup is started after destroy");
    assert.equal(updates, 1);

    // a session without abort() (Soup 2) is left alone rather than crashed into
    const plain = new CityWeather.CityWeatherProvider({ httpSession: {}, httpGetJson() {} });
    assert.doesNotThrow(() => plain.destroy());
});

test("recordFor answers null for anything that is not a city name", () => {
    const CityWeather = loadCityWeather();
    const provider = new CityWeather.CityWeatherProvider(
        Object.assign({ httpGetJson() {} }, stubResolvers({ Rome: "☀ 20°C" })));

    provider.refresh({ showWeather: true, units: "si", cities: ["Rome"] }, () => {});

    for (const input of ["", "   ", null, undefined, 42, {}, [], true, NaN]) {
        assert.equal(provider.recordFor(input), null);
        assert.equal(provider.errorFor(input), "");
    }

    assert.deepEqual(provider.recordFor("Rome"), R("☀ 20°C"));
});

test("a forecast that fails or comes back empty keeps the previous reading", () => {
    const CityWeather = loadCityWeather();
    let answer = ["☀ 20°C", "", "Open-Meteo"];
    const provider = new CityWeather.CityWeatherProvider({
        httpGetJson() {},
        locationResolver: {
            resolve(city, isCurrent, callback) {
                callback({ latitude: 1, longitude: 2 }, "");
            }
        },
        forecastResolver: {
            refresh(place, isCurrent, callback) {
                callback(R(answer[0]), answer[1], answer[2]);
            }
        }
    });
    const settings = { showWeather: true, units: "si", cities: ["Rome"] };
    let updates = 0;

    provider.refresh(settings, () => updates++);
    assert.deepEqual(provider.recordFor("Rome"), R("☀ 20°C"));
    assert.equal(updates, 1);

    // the network dropped: the tooltip keeps yesterday's number rather than
    // blinking the temperature out of the row
    answer = ["", "Weather service unavailable", ""];
    provider.refresh(settings, () => updates++);
    assert.deepEqual(provider.recordFor("Rome"), R("☀ 20°C"));
    assert.equal(provider.lastProvider, "Open-Meteo");
    assert.equal(provider.errorFor("Rome"), "Weather service unavailable");
    assert.equal(updates, 2, "a new failure redraws once so the footer can report it");

    // every provider answered, none had a reading for the place
    answer = ["", "", ""];
    provider.refresh(settings, () => updates++);
    assert.deepEqual(provider.recordFor("Rome"), R("☀ 20°C"));
    assert.equal(provider.errorFor("Rome"), "Weather service unavailable");
    assert.equal(updates, 2, "the same failure is not redrawn on every retry");

    answer = ["☀ 21°C", "", "MET.no"];
    provider.refresh(settings, () => updates++);
    assert.equal(provider.errorFor("Rome"), "", "a successful refresh clears the issue");
    assert.equal(updates, 3);
});

test("the geocoder is asked about the timezone's city, never the user's label", () => {
    const CityWeather = loadCityWeather();
    const asked = [];
    const provider = new CityWeather.CityWeatherProvider({
        httpGetJson() {},
        locationResolver: {
            resolve(city, _isCurrent, callback) {
                asked.push(city);
                callback({ latitude: 1, longitude: 2 }, "");
            }
        },
        forecastResolver: {
            refresh(_place, _isCurrent, callback) {
                callback(R("☀ 20°C"), "", "Open-Meteo");
            }
        }
    });

    provider.refresh({
        showWeather: true,
        units: "si",
        cities: [
            { label: "Mom's place", query: "Buenos Aires" },
            // a clock whose timezone names no city is not a place to ask about
            { label: "Somewhere", query: "" }
        ]
    }, () => {});

    assert.deepEqual(asked, ["Buenos Aires"],
        "a nickname never reaches a third-party geocoder");
    // ...and the reading is filed under the city it is *of*. It used to be filed
    // under the label, which is the user's own name for the row and is unique
    // only by luck: see the two clocks called "Home", below.
    assert.deepEqual(provider.recordFor("Buenos Aires"), R("☀ 20°C"));
    assert.equal(provider.recordFor("Mom's place"), null);
    assert.equal(provider.recordFor("Somewhere"), null);
});

// REGRESSION: the readings were keyed by the clock's label — free text the user
// types, which nothing makes unique, and which clockDisplayLabel clamps to 24
// code points so two labels sharing 23 characters collapse too. Two clocks both
// called "Home" therefore shared one entry: the second city was never geocoded,
// never fetched, and its row showed the first city's temperature, with no
// staleness marker and no error to say so.
test("two clocks with the same label each get their own city's weather", () => {
    const CityWeather = loadCityWeather();
    const asked = [];
    const provider = new CityWeather.CityWeatherProvider({
        httpGetJson() {},
        locationResolver: {
            resolve(city, _isCurrent, callback) {
                asked.push(city);
                callback({ latitude: 1, longitude: 2, name: city }, "");
            }
        },
        forecastResolver: {
            refresh(place, _isCurrent, callback) {
                callback(place.name === "Tokyo" ? R("🌧 12°C") : R("☀ 20°C"), "", "Open-Meteo");
            }
        }
    });

    provider.refresh({
        showWeather: true,
        units: "si",
        cities: [
            { label: "Home", query: "Lisbon" },
            { label: "Home", query: "Tokyo" }
        ]
    }, () => {});

    assert.deepEqual(asked.sort(), ["Lisbon", "Tokyo"], "both cities are read");
    assert.deepEqual(provider.recordFor("Lisbon"), R("☀ 20°C"));
    assert.deepEqual(provider.recordFor("Tokyo"), R("🌧 12°C"));
});

test("a city that fails to read is retried, and says so once it is old", () => {
    const CityWeather = loadCityWeather();
    const timers = [];
    const logged = [];
    global.log = (message) => logged.push(message);

    let answer = ["☀ 20°C", "", "Open-Meteo"];
    let clock = 1000000;
    const provider = new CityWeather.CityWeatherProvider({
        httpGetJson() {},
        now: () => clock,
        // the jitter has its own test; this one is about the backoff under it
        random: () => 0,
        scheduleTimer: (seconds, callback) => {
            timers.push({ seconds, callback });
            return timers.length;
        },
        removeTimer: () => {},
        locationResolver: {
            resolve(_city, _isCurrent, callback) {
                callback({ latitude: 1, longitude: 2 }, "");
            }
        },
        forecastResolver: {
            refresh(_place, _isCurrent, callback) {
                callback(R(answer[0]), answer[1], answer[2]);
            }
        }
    });
    const settings = { showWeather: true, units: "si", cities: ["Rome"] };

    provider.schedule(settings, () => {});
    assert.deepEqual(provider.recordFor("Rome"), R("☀ 20°C"));
    assert.equal(provider.staleFor("Rome"), false);
    assert.equal(timers.length, 1, "just the periodic timer while everything works");

    // the network drops
    answer = ["", "Weather service unavailable", ""];
    provider.refresh(settings, () => {});

    assert.equal(timers.length, 2, "the failed round is retried");
    assert.equal(timers[1].seconds, CityWeather.CITY_RETRY_SECONDS);

    // and keeps failing: the delay backs off toward the normal period
    timers[1].callback();
    assert.equal(timers[2].seconds, CityWeather.CITY_RETRY_SECONDS * 2);

    // the reading it is still showing was taken two periods ago, and is no
    // longer the weather
    clock += (CityWeather.CITY_REFRESH_SECONDS * 2 + 1) * 1000;
    assert.deepEqual(provider.recordFor("Rome"), R("☀ 20°C"));
    assert.equal(provider.staleFor("Rome"), true);
    assert.equal(provider.staleFor("Atlantis"), false, "a city with no reading is not stale");

    // the network comes back
    answer = ["🌧 12°C", "", "Open-Meteo"];
    timers[2].callback();
    assert.deepEqual(provider.recordFor("Rome"), R("🌧 12°C"));
    assert.equal(provider.staleFor("Rome"), false);
    assert.equal(timers.length, 3, "and no further retry is queued");
});

test("a city weather outage that never clears is logged, not just retried", () => {
    const CityWeather = loadCityWeather();
    const timers = [];
    const logged = [];
    global.log = (message) => logged.push(message);

    const provider = new CityWeather.CityWeatherProvider({
        httpGetJson() {},
        random: () => 0,
        scheduleTimer: (seconds, callback) => {
            timers.push({ seconds, callback });
            return timers.length;
        },
        removeTimer: () => {},
        locationResolver: {
            resolve(_city, _isCurrent, callback) {
                callback({ latitude: 1, longitude: 2 }, "");
            }
        },
        forecastResolver: {
            refresh(_place, _isCurrent, callback) {
                callback(null, "Weather service unavailable", "");
            }
        }
    });
    const settings = { showWeather: true, units: "si", cities: ["Rome"] };

    provider.schedule(settings, () => {});
    // back off until the retry delay reaches the normal refresh period
    for (let attempt = 0; attempt < 8 && !logged.length; attempt++) {
        timers[timers.length - 1].callback();
    }

    assert.match(logged[0], /city weather: still failing/,
        "an outage nobody can see is an outage nobody fixes");
});

function fuzzCities(rand) {
    const junk = [null, undefined, 42, {}, [], true, "", "   ", "\t\n"];
    const names = ["Rome", "rome", " ROME ", "Tokyo", "tokyo ", "São Paulo", " são paulo", "Oslo", "Lisbon",
        "Cairo", "Lima", "Perth", "Quito", "Riga"];
    const length = Math.floor(rand() * 14);

    return Array.from({ length }, () => {
        const pool = rand() < 0.35 ? junk : names;
        return pool[Math.floor(rand() * pool.length)];
    });
}

function assertNormalizedCity(city, cities) {
    assert.equal(typeof city.label, "string");
    assert.equal(typeof city.query, "string");
    assert.equal(city.query, city.query.trim(), "the trimmed name is what gets geocoded");
    assert.notEqual(city.query, "");
    assert.ok(cities.some((entry) => typeof entry === "string" &&
        entry.trim() === city.label));
}

function assertNormalizedCities(CityWeather, provider, cities) {
    const unique = provider._cities({ cities });
    assert.ok(unique.length <= CityWeather.MAX_CITIES, "the clock list is capped");
    assert.ok(unique.length <= cities.length);
    const keys = unique.map((city) => city.label.trim().toLowerCase());
    assert.equal(new Set(keys).size, keys.length, "one lookup per place, whatever the spelling");
    unique.forEach((city) => assertNormalizedCity(city, cities));
}

test("city lists fuzz junk, blanks and duplicates into a capped unique list", () => {
    const CityWeather = loadCityWeather();
    const rand = makeRandom(FUZZ_SEED);
    const calls = {};
    const provider = new CityWeather.CityWeatherProvider(
        Object.assign({ httpGetJson() {} }, stubResolvers({}, calls)));

    for (let i = 0; i < 300; i++) {
        const cities = fuzzCities(rand);
        assertNormalizedCities(CityWeather, provider, cities);
    }

    // a settings object with no cities at all is a list of nothing
    assert.deepEqual(provider._cities(null), []);
    assert.deepEqual(provider._cities({}), []);
    assert.deepEqual(provider._cities({ cities: "Rome" }), []);
});

test("fuzz: city signatures ignore hostile labels without merging queries", () => {
    const CityWeather = loadCityWeather();
    const rand = makeRandom(FUZZ_SEED ^ 0x51a);
    const provider = new CityWeather.CityWeatherProvider({ httpGetJson() {} });
    const delimiters = ["@", ",", "|", "@,|", "home@Tokyo,b"];

    for (let i = 0; i < 300; i++) {
        const label = delimiters[Math.floor(rand() * delimiters.length)] + i;
        const reversed = rand() < 0.5;
        const sameQueries = reversed ?
            [{ label, query: "Tokyo" }, { label: "x", query: "Rome" }] :
            [{ label: "x", query: "Rome" }, { label, query: "Tokyo" }];
        const baseline = {
            showWeather: true,
            cities: [{ label: "first", query: "Rome" }, { label: "second", query: "Tokyo" }]
        };
        const changed = {
            showWeather: true,
            cities: sameQueries.concat({ label, query: "Oslo" + i })
        };

        assert.equal(provider._signature({ showWeather: true, cities: sameQueries }),
            provider._signature(baseline), "labels and ordering are not network inputs");
        assert.notEqual(provider._signature(changed), provider._signature(baseline),
            "a distinct normalized query cannot collide");
    }
});

function randomCityWeatherSettings(rand, cities) {
    return rand() < 0.1 ? null : {
        showWeather: rand() < 0.75,
        units: [undefined, "si", "imperial", "metric", 7][Math.floor(rand() * 5)],
        cities: rand() < 0.08 ? "Rome" : cities
    };
}

function assertNoStrayCityReadings(provider, settings) {
    const wanted = new Set(provider._cities(settings)
        .map((city) => city.label.trim().toLowerCase()));
    for (const key of provider._readings.keys()) {
        assert.ok(wanted.has(key), "no temperature survives for a clock the user removed");
    }
}

function assertCityReadingShape(provider, input) {
    let reading;
    assert.doesNotThrow(() => {
        reading = provider.recordFor(input);
    });
    assert.ok(reading === null ||
        (typeof reading === "object" && typeof reading.condition === "string" &&
            typeof reading.temperatureC === "number"),
    "the tooltip row always gets a reading record or nothing");
}

function runCityWeatherFuzzRound(provider, rand, inputs) {
    const cities = fuzzCities(rand);
    const settings = randomCityWeatherSettings(rand, cities);
    assert.doesNotThrow(() => provider.refresh(settings, () => {}));
    assertNoStrayCityReadings(provider, settings);
    inputs.forEach((input) => assertCityReadingShape(provider, input));
}

test("recordFor and refresh fuzz random settings without throwing or keeping strays", () => {
    const CityWeather = loadCityWeather();
    const rand = makeRandom(FUZZ_SEED ^ 0x5c17);
    const readings = { Rome: "☀ 20°C", Tokyo: "⛅ 24°C", Oslo: "🌨 -2°C", "São Paulo": "🌧 19°C" };
    const provider = new CityWeather.CityWeatherProvider(
        Object.assign({ httpGetJson() {} }, stubResolvers(readings)));
    const inputs = [null, undefined, 42, {}, [], true, "", "  ", "Rome", " rome ", "TOKYO", "Atlantis", " "];

    for (let i = 0; i < 300; i++) {
        runCityWeatherFuzzRound(provider, rand, inputs);
    }
});

// regression (mutation-found): the generation guard in the forecast callback was
// only ever exercised together with an error. A forecast that answers *after* a
// newer refresh has started must be dropped on its own merit — otherwise a slow
// reply for a city the user has since renamed overwrites the fresh reading.
test("a forecast answering after a newer refresh is dropped", () => {
    const CityWeather = loadCityWeather();
    const pending = [];
    const provider = new CityWeather.CityWeatherProvider({
        httpGetJson() {},
        locationResolver: {
            resolve(city, isCurrent, callback) {
                callback({ latitude: 1, longitude: 2 }, "");
            }
        },
        forecastResolver: {
            // hold the answer instead of calling back, so the test decides when
            // the slow reply lands
            refresh(place, isCurrent, callback) {
                pending.push(() => callback(R("⛅ 24°C"), "", "Open-Meteo"));
            }
        }
    });

    let updates = 0;
    provider.refresh({ showWeather: true, units: "si", cities: ["Lisbon"] }, () => updates++);
    // the user edits the clock list: a second, different key supersedes the first
    provider.refresh({ showWeather: true, units: "si", cities: ["Tokyo"] }, () => updates++);

    const stale = pending.shift();
    stale();

    assert.equal(provider.recordFor("Lisbon"), null,
        "the superseded round must not write a reading, error or not");
    assert.equal(updates, 0, "and it must not redraw the tooltip");

    pending.shift()();
    assert.deepEqual(provider.recordFor("Tokyo"), R("⛅ 24°C"), "the current round still lands");
    assert.equal(updates, 1);
});

// staleFor() read the module constant and ignored the refresh period it was
// constructed with, so a provider asked to refresh every minute went on calling
// an hour-old temperature current — 59 refresh cycles of presenting a stale
// number as the weather, with no "last known reading" marker beside it. The rule
// is one function now, and it is derived from the period actually in use.
test("staleness follows the refresh period the provider was given", () => {
    const CityWeather = loadCityWeather();
    let now = 1_000_000;
    const calls = {};
    const provider = new CityWeather.CityWeatherProvider(Object.assign({
        httpGetJson() {},
        refreshSeconds: 60,
        now: () => now
    }, stubResolvers({ Lisbon: "☀ 20°C" }, calls)));

    provider.refresh({ showWeather: true, units: "si", cities: ["Lisbon"] }, () => {});
    assert.deepEqual(provider.recordFor("Lisbon"), R("☀ 20°C"));
    assert.equal(provider.staleFor("Lisbon"), false);

    // two refresh periods less a second: still the weather
    now += 119 * 1000;
    assert.equal(provider.staleFor("Lisbon"), false);

    // past two periods: nobody has refreshed this, and it is not the weather
    now += 2 * 1000;
    assert.equal(provider.staleFor("Lisbon"), true,
        "a 60s provider must not call a 2-minute-old reading current");
});

test("staleness at the default period is still two refresh periods", () => {
    const CityWeather = loadCityWeather();
    let now = 1_000_000;
    const calls = {};
    const provider = new CityWeather.CityWeatherProvider(Object.assign({
        httpGetJson() {},
        now: () => now
    }, stubResolvers({ Lisbon: "☀ 20°C" }, calls)));

    provider.refresh({ showWeather: true, units: "si", cities: ["Lisbon"] }, () => {});

    now += CityWeather.CITY_REFRESH_SECONDS * 2 * 1000;
    assert.equal(provider.staleFor("Lisbon"), false);
    now += 1000;
    assert.equal(provider.staleFor("Lisbon"), true);
});

// The resolver's callback is (place, error) and _refreshCity took only (place),
// so every geocode failure looked the same. A name that will not resolve is not
// worth retrying — but "nobody answered" is, and that is what you get when the
// applet starts before NetworkManager is up: every city exhausts its chain with
// SERVICE_UNAVAILABLE, the round scores zero failures, the scheduler is told it
// succeeded, and no retry is armed. The tooltip then has no temperatures for
// thirty minutes, while the panel weather — on the identical failure — is back in
// twenty seconds.
test("a city that could not be reached is retried; one that does not exist is not", () => {
    const CityWeather = loadCityWeather();
    const Weather = require(weatherPath);
    const retries = [];

    const provider = new CityWeather.CityWeatherProvider({
        httpGetJson() {},
        scheduler: {
            timerId: 1,
            schedule() {},
            stop() {},
            retriesExhausted: () => false,
            retry: (refresh) => retries.push(refresh),
            succeeded: () => retries.push("succeeded")
        },
        locationResolver: {
            resolve(city, isCurrent, callback) {
                void isCurrent;
                // the network is down: nobody answered about this city
                callback(null, Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE);
            }
        },
        forecastResolver: { refresh() {} }
    });

    provider.refresh({ showWeather: true, units: "si", cities: ["Lisbon"] }, () => {});
    assert.equal(retries.length, 1, "a round nobody answered is retried");
    assert.notEqual(retries[0], "succeeded");

    // ...and a name that will never geocode is not worth asking about again
    const settled = [];
    const stubborn = new CityWeather.CityWeatherProvider({
        httpGetJson() {},
        scheduler: {
            timerId: 1,
            schedule() {},
            stop() {},
            retriesExhausted: () => false,
            retry: () => settled.push("retry"),
            succeeded: () => settled.push("succeeded")
        },
        locationResolver: {
            resolve(city, isCurrent, callback) {
                void isCurrent;
                callback(null, Weather.WEATHER_ERRORS.LOCATION_NOT_FOUND);
            }
        },
        forecastResolver: { refresh() {} }
    });

    stubborn.refresh({ showWeather: true, units: "si", cities: ["Atlantis"] }, () => {});
    assert.deepEqual(settled, ["succeeded"],
        "asking again will not make the name right");
});

// GLib's timeouts ride CLOCK_MONOTONIC, which does not advance across a suspend:
// a laptop that slept for two hours wakes with its 30-minute refresh timer still
// holding most of its time. The panel weather handles this — it stops and
// re-reads at once — but the city weather saw an unchanged signature and a live
// timer and early-returned, so the tooltip kept its pre-suspend temperatures for
// up to 25 more minutes beside a panel showing a fresh one.
test("a resume re-reads the cities even though nothing about them changed", () => {
    const CityWeather = loadCityWeather();
    const rounds = [];
    const provider = new CityWeather.CityWeatherProvider({
        httpGetJson() {},
        scheduler: {
            timerId: 7,
            schedule: (settings, refresh) => rounds.push(refresh),
            stop() {},
            succeeded() {},
            retry() {},
            retriesExhausted: () => false
        },
        locationResolver: { resolve() {} },
        forecastResolver: { refresh() {} }
    });

    const settings = { showWeather: true, units: "si", cities: ["Lisbon"] };
    provider.schedule(settings, () => {});
    assert.equal(rounds.length, 1);

    // the ordinary case: nothing changed, so nothing is re-read. This is what
    // keeps a keystroke in the location entry from re-reading eight cities.
    provider.schedule(settings, () => {});
    assert.equal(rounds.length, 1, "an unchanged signature still costs nothing");

    // the resume: the settings have not changed, but the world has
    provider.schedule(settings, () => {}, true);
    assert.equal(rounds.length, 2, "a resume re-reads the cities");
});
