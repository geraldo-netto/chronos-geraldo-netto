const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { makeRandom } = require("./prng");
const { makeSoup3 } = require("./soup");

const modulePath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "weather.js");
const schedulerPath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "weatherScheduler.js");
const providersPath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "weatherProviders.js");
const serviceAdaptersPath = path.join(
    __dirname, "..", "..", "files", "chronos@geraldo-netto", "weatherServiceAdapters.js");
const ioUtilsPath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "ioUtils.js");
const shimPath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "5.4", "weather.js");
const schema52Path = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "5.4", "settings-schema.json");

let originalImports;
let originalLogError;

// The port answers with a unit-free reading record, never with display text: the
// provider says what the weather is and the presenter decides how to show it.
// These tests used to assert the rendered string the resolver handed back, so
// they render it here — which is exactly what the panel now does.
function shown(reading, units = "metric") {
    const WeatherFormat = require(path.join(
        __dirname, "..", "..", "files", "chronos@geraldo-netto", "weatherFormat.js"));
    return reading ? reading.condition + " " +
        WeatherFormat.formatTemperature(reading.temperatureC, units) : "";
}

function immediateNominatimQueue() {
    return {
        enqueue(start, isCurrent) {
            if (isCurrent()) {
                start(() => {});
            }
        }
    };
}

function loadWeather(soupOverrides = {}) {
    delete require.cache[require.resolve(modulePath)];
    // the scheduler captures GLib at load; reload it so it binds this call's
    // GLib mock rather than a previous test's timers
    delete require.cache[require.resolve(schedulerPath)];
    // the provider chains capture their format and fallback modules at load;
    // reload them with the scheduler so those seams stay in step
    delete require.cache[require.resolve(providersPath)];
    // weather delegates its HTTP path to ioUtils; reload it so it captures
    // this call's Soup mock instead of a previous test's
    delete require.cache[require.resolve(ioUtilsPath)];

    const soup = Object.assign(makeSoup3({ data: "{}" }), soupOverrides);

    global.imports = {
        byteArray: {
            toString(data) {
                return data.toString();
            }
        },
        gi: {
            // needed by the locale/date modules at load time
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
                get_monotonic_time: () => 1000000,
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

afterEach(() => {
    global.imports = originalImports;
    global.logError = originalLogError;
});

module.exports = {
    assert, test, vm, fs, path, makeRandom, makeSoup3,
    modulePath, schedulerPath, providersPath, serviceAdaptersPath, ioUtilsPath,
    shimPath, schema52Path,
    shown, immediateNominatimQueue, loadWeather
};
