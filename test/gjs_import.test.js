const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// The 5.4 shims load the root modules through the native GJS importer
// (imports.ui.appletManager.applets[uuid].<module>). That importer provides
// neither require() nor module, and only exposes top-level var/function
// declarations — const/class stay in the lexical environment and read as
// undefined. Running each module as a plain vm script against a bare context
// reproduces exactly those semantics, so these tests fail if an exported
// symbol regresses to const/class or a root module calls require().

const APPLET_DIR = path.join(__dirname, "..", "files", "chronos@geraldo-netto");

function gjsImportsMock() {
    return {
        gi: {
            Cinnamon: {},
            CinnamonDesktop: {
                WallClock: {
                    lctime_format(domain, format) {
                        return format;
                    }
                }
            },
            Clutter: {},
            Gio: {},
            GLib: {
                SpawnFlags: { SEARCH_PATH: 4 },
                get_home_dir() {
                    return "/home/test";
                },
                get_user_cache_dir() {
                    return "/tmp/cache";
                },
                build_filenamev(parts) {
                    return parts.join("/");
                },
                spawn_sync() {
                    throw new Error("locale info must not be queried synchronously");
                }
            },
            Soup: {
                MAJOR_VERSION: 3,
                Session: class {}
            },
            St: {}
        },
        byteArray: {},
        mainloop: {},
        signals: {
            addSignalMethods() {}
        },
        ui: {
            appletManager: {
                applets: {
                    "chronos@geraldo-netto": {
                        eventData: {
                            js_date_to_gdatetime() {},
                            date_only() {},
                            month_year_only() {},
                            dt_equals() {},
                            EventData: class {},
                            EventDataList: class {}
                        },
                        utils: {
                            MSECS_IN_DAY: 86400000,
                            UI_ERROR_MARKER: "⚠",
                            DAY_FORMAT: "%A",
                            DATE_FORMAT_SHORT: "%B %-e, %Y",
                            DATE_FORMAT_FULL: "%A, %B %-e, %Y",
                            translate(str) { return str; },
                            translatePlural(s, p, n) { return n === 1 ? s : p; },
                            HTTP_TIMEOUT_SECONDS: 30,
                            createHttpSession() {},
                            urlForLog() {},
                            writeJsonFileAsync() {},
                            monthWindowStartOffset() {},
                            lazyLocaleValue(env, pick) {
                                let value = null;
                                return () => {
                                    if (value === null) {
                                        value = pick(this.getInfo(env));
                                    }
                                    return value;
                                };
                            },
                            getInfo() {
                                return {
                                    lang_ab: "en",
                                    country_ab3: "usa",
                                    abday: "Sun;Mon;Tue;Wed;Thu;Fri;Sat",
                                    first_workday: 2
                                };
                            }
                        },
                        localeUtils: {
                            MSECS_IN_DAY: 86400000,
                            DAY_FORMAT: "%A",
                            DATE_FORMAT_SHORT: "%B %-e, %Y",
                            DATE_FORMAT_FULL: "%A, %B %-e, %Y",
                            translate(str) { return str; },
                            translatePlural(s, p, n) { return n === 1 ? s : p; },
                            getInfo() {
                                return {
                                    lang_ab: "en",
                                    country_ab3: "usa",
                                    abday: "Sun;Mon;Tue;Wed;Thu;Fri;Sat",
                                    first_workday: 2
                                };
                            },
                            monthWindowStartOffset() {},
                            lazyLocaleValue() {},
                            onLocaleInfoChanged() {},
                            cancelPendingLocaleQueries() {},
                            registerLocaleConsumer() {}
                        },
                        ioUtils: {
                            createHttpSession() {},
                            decodeUtf8() {},
                            MAX_RESPONSE_BYTES: 4194304,
                            HTTP_TIMEOUT_SECONDS: 30,
                            httpGetJson() {},
                            urlForLog() {},
                            readJsonFile() {},
                            readJsonFileAsync() {},
                            writeJsonFile() {},
                            writeJsonFileAsync() {}
                        },
                        styleUtils: {
                            safeCssColor() {}
                        },
                        providerUtils: {
                            backoffDelay() {},
                            orderProvidersByLastSuccess() {},
                            tryProvidersInOrder() {},
                            providerName() {}
                        },
                        weatherScheduler: {
                            WeatherRefreshScheduler: class {}
                        },
                        weatherProviders: {
                            GEOCODE_PROVIDERS: [],
                            FORECAST_PROVIDERS: [],
                            WeatherLocationResolver: class {},
                            WeatherForecastResolver: class {}
                        },
                        weatherFormat: {
                            REFRESH_SECONDS: 1800,
                            RETRY_SECONDS: 30,
                            STALE_PERIODS: 2,
                            staleAfterSeconds() {},
                            readingIsStale() {},
                            MAX_RETRY_ATTEMPTS: 8,
                            MAX_GEOCODE_CACHE_ENTRIES: 16,
                            HTTP_TIMEOUT_SECONDS: 30,
                            WEATHER_DEBOUNCE_MS: 750,
                            WEATHER_UNITS: { SI: "si", IMPERIAL: "imperial" },
                            WEATHER_ERROR_MARKER: "⚠",
                            WEATHER_PENDING_TEXT: "…",
                            WEATHER_ERRORS: {},
                            WEATHER_USER_AGENT: "agent",
                            WEATHER_PROVIDER_NAMES: {},
                            AVIATION_WEATHER_BBOX_DEGREES: 1,
                            WEATHER_CONDITIONS: {},
                            normalizeUnits() {},
                            weatherIcon() {},
                            geocodeUrl() {},
                            nominatimGeocodeUrl() {},
                            locationCacheKey() {},
                            forecastUrl() {},
                            metNoForecastUrl() {},
                            aviationWeatherUrl() {},
                            aviationWeatherIcon() {},
                            metarNumber() {},
                            aviationWeatherStation() {},
                            aviationWeatherReading() {},
                            weatherReading() {},
                            formatReading() {},
                            formatTemperature() {},
                            metNoIcon() {},
                            metNoSummary() {},
                            metNoWeatherReading() {},
                            openMeteoGeocodePlace() {},
                            nominatimGeocodePlace() {}
                        },
                        worldclockData: {
                            MAX_CLOCKS: 8,
                            LOCAL_TIMEZONE: "local",
                            INVALID_TIMEZONE_TEXT: "Invalid timezone",
                            LOCAL_TIME_TEXT: "Local time",
                            timezoneFromIdentifier() {},
                            builtinClocks() {},
                            timezoneIdentity() {},
                            timezoneCityName() {},
                            builtInTimezoneKeys() {}
                        },
                        holidayAdapters: {
                            HolidayFallbackChain: class {}
                        },
                        holidayConstants: {
                            HOLIDAY_ERRORS: {},
                            HOLIDAY_PROVIDER_NAMES: {},
                            GLOBAL_REGION: "global",
                            OPEN_HOLIDAYS_COUNTRIES: {},
                            COUNTRY_TO_ISO2: {},
                            REGION_TO_SUBDIVISION: {}
                        },
                        holidayCache: {
                            HolidayCacheRepository: class {},
                            HolidayCache: class {},
                            GLOBAL_REGION: "global"
                        },
                        holidayServiceAdapters: {
                            EnricoServiceAdapter: class {},
                            NagerDateServiceAdapter: class {},
                            OpenHolidaysServiceAdapter: class {},
                            createHolidayServiceChain: () => ({})
                        }
                    }
                }
            }
        }
    };
}

// the script is named after the file it came from, so V8 attributes what the
// GJS path executes to the module itself: the imports.* fallbacks only ever run
// here, and without the real path they would read as dead branches
function nativeImport(moduleName) {
    const context = { imports: gjsImportsMock() };
    vm.createContext(context);
    const modulePath = path.join(APPLET_DIR, moduleName + ".js");
    const source = fs.readFileSync(modulePath, "utf8");
    vm.runInContext(source, context, { filename: modulePath });
    return context;
}

const EXPORTS = {
    localeUtils: ["MSECS_IN_DAY", "DAY_FORMAT", "DATE_FORMAT_SHORT",
        "DATE_FORMAT_FULL", "translate", "translatePlural", "monthWindowStartOffset",
        "lazyLocaleValue", "onLocaleInfoChanged", "cancelPendingLocaleQueries", "registerLocaleConsumer"],
    ioUtils: ["createHttpSession", "decodeUtf8", "HTTP_TIMEOUT_SECONDS", "MAX_RESPONSE_BYTES", "httpGetJson", "urlForLog", "readJsonFileAsync", "writeJsonFileAsync"],
    styleUtils: ["safeCssColor"],
    providerUtils: ["backoffDelay", "orderProvidersByLastSuccess", "tryProvidersInOrder"],
    utils: ["MSECS_IN_DAY", "UI_ERROR_MARKER", "onLocaleInfoChanged", "DAY_FORMAT", "DATE_FORMAT_SHORT", "DATE_FORMAT_FULL",
        "translate", "translatePlural", "createHttpSession", "HTTP_TIMEOUT_SECONDS", "httpGetJson", "monthWindowStartOffset", "readJsonFileAsync",
        "writeJsonFileAsync", "safeCssColor", "lazyLocaleValue", "backoffDelay", "orderProvidersByLastSuccess", "tryProvidersInOrder"],
    weatherFormat: ["REFRESH_SECONDS", "RETRY_SECONDS", "STALE_PERIODS",
        "staleAfterSeconds", "readingIsStale", "HTTP_TIMEOUT_SECONDS",
        "WEATHER_ERROR_MARKER", "WEATHER_PENDING_TEXT", "WEATHER_ERRORS",
        "WEATHER_USER_AGENT", "WEATHER_PROVIDER_NAMES", "WEATHER_CONDITIONS",
        "normalizeUnits", "weatherIcon",
        "geocodeUrl", "nominatimGeocodeUrl", "forecastUrl", "metNoForecastUrl",
        "aviationWeatherUrl", "aviationWeatherIcon", "aviationWeatherStation",
        "metarNumber", "locationCacheKey", "metNoIcon",
        "metNoSummary", "openMeteoGeocodePlace", "nominatimGeocodePlace"],
    weatherScheduler: ["WeatherRefreshScheduler"],
    weatherProviders: ["GEOCODE_PROVIDERS", "FORECAST_PROVIDERS",
        "WeatherLocationResolver", "WeatherForecastResolver"],
    // WeatherProvider is the only name production reads off the barrel through the
    // GJS importer — cityWeather and the panel presenter require the part that
    // declares the symbol they want, and each part's own row above pins those.
    weather: ["WeatherProvider"],
    holidays: ["Provider", "HolidayCacheRepository", "HolidayCache", "EnricoServiceAdapter",
        "NagerDateServiceAdapter", "OpenHolidaysServiceAdapter",
        "createHolidayServiceChain", "HolidayService", "HolidayProviderFacade",
        "HOLIDAY_ERRORS"],
    holidayAdapters: ["HolidayFallbackChain"],
    holidayCache: ["HolidayCacheRepository", "HolidayCache", "validCachedHoliday",
        "validCachedStamp", "validCachedYears", "clampHolidayName", "MAX_HOLIDAY_NAME_LENGTH", "MAX_MEMOIZED_MONTHS",
        "UPDATE_PERIOD", "RETRY_PERIOD", "YEAR_WINDOW", "GLOBAL_REGION"],
    holidayServiceAdapters: ["validDateParts", "regionSubdivisionCode", "isoDateParts",
        "IsoHolidayServiceAdapter", "EnricoServiceAdapter", "NagerDateServiceAdapter",
        "OpenHolidaysServiceAdapter", "createHolidayServiceChain"],
    holidayConstants: ["HOLIDAY_ERRORS", "HOLIDAY_PROVIDER_NAMES", "GLOBAL_REGION",
        "OPEN_HOLIDAYS_COUNTRIES", "COUNTRY_TO_ISO2", "REGION_TO_SUBDIVISION"],
    worldclockData: ["MAX_CLOCKS", "LOCAL_TIMEZONE", "INVALID_TIMEZONE_TEXT",
        "LOCAL_TIME_TEXT", "timezoneFromIdentifier", "builtinClocks",
        "timezoneIdentity", "timezoneCityName", "builtInTimezoneKeys"],
    eventData: ["js_date_to_gdatetime", "date_only", "month_year_only", "dt_equals",
        "EventData", "EventDataList"],
    eventsManager: ["EventsManager", "CalendarServerConnection", "EventIndex", "EventWindowCoordinator", "SERVER_RETRY_SECONDS", "EDS_BUS_NAME"],
    eventFormat: ["EVENT_PHASE_PAST", "EVENT_PHASE_UPCOMING", "EVENT_PHASE_CURRENT",
        "dtEquals", "classifyEventDisplayState", "localeCap", "formatRangePrefix",
        "formatRangeSuffix", "formatEventTimeRange", "ARROW_SEPARATOR"],
    settingsFacade: ["CalendarSettings", "EventsSettings", "SHOW_EVENTS_KEY",
        "SHOW_WEEK_NUMBERS_KEY", "WEEKEND_LENGTH_KEY"]
};

for (const [moduleName, symbols] of Object.entries(EXPORTS)) {
    test(`${moduleName}.js loads through the native GJS importer and exposes its API`, () => {
        const context = nativeImport(moduleName);
        for (const symbol of symbols) {
            assert.notEqual(context[symbol], undefined,
                `${moduleName}.${symbol} must be a top-level var/function for GJS`);
        }
    });
}

// weather.js re-exports weatherFormat through three hand-maintained lists — the
// `var X = WeatherFormat.X` block, module.exports, and the gate above — and they
// had already drifted: module.exports was missing MAX_RETRY_ATTEMPTS, which is
// how a live NaN got into the city-weather backoff. A fourth list would drift
// too, so this derives the answer from the source instead: whatever weather.js
// pulls off WeatherFormat, it must hand on to both hosts.
// The barrel used to re-export its three parts by hand — one `var X = Part.X;`
// line per symbol, then the same name again in module.exports — so adding a
// constant to a part was three edits in two files. It composes module.exports
// from the parts now, which GJS could not see: a GJS consumer reading a part's
// symbol off the barrel would get undefined. That is safe only as long as none
// does, so this asserts both halves — Node sees every part symbol through the
// barrel, and the only name GJS takes from it is the one the barrel declares.
test("the barrel carries its parts to Node, and nothing reads a part off it in GJS", () => {
    // the root modules read their collaborators through globalThis.imports at
    // load time, so the mock has to be in place while they are required
    const originalImports = global.imports;
    global.imports = gjsImportsMock();
    for (const file of ["weather.js", "weatherScheduler.js", "weatherProviders.js", "weatherFormat.js",
        "utils.js", "localeUtils.js", "ioUtils.js", "styleUtils.js", "providerUtils.js"]) {
        delete require.cache[require.resolve(path.join(APPLET_DIR, file))];
    }
    const parts = ["weatherFormat", "weatherScheduler", "weatherProviders"]
        .map((part) => require(path.join(APPLET_DIR, part + ".js")));
    const barrel = require(path.join(APPLET_DIR, "weather.js"));
    global.imports = originalImports;

    for (const part of parts) {
        for (const name of Object.keys(part)) {
            assert.notEqual(barrel[name], undefined,
                `weather.js must carry ${name} on to its Node consumers`);
        }
    }

    // every module that requires the barrel, and every name it reads off it
    for (const file of ["cityWeather.js", "5.4/appletLifecycle.js", "5.4/appletPanelStatus.js"]) {
        const source = fs.readFileSync(path.join(APPLET_DIR, file), "utf8");
        if (!/require\("\.\/weather"\)/.test(source)) {
            continue;
        }
        const read = Array.from(source.matchAll(/\bWeather\.(\w+)/g)).map(([, name]) => name);
        assert.deepEqual([...new Set(read)], ["WeatherProvider"],
            `${file} reads a part's symbol off the barrel, which GJS cannot see`);
    }
});

test("root modules never call require() outside the Node guard", () => {
    for (const moduleName of Object.keys(EXPORTS)) {
        const source = fs.readFileSync(path.join(APPLET_DIR, moduleName + ".js"), "utf8");
        for (const match of source.matchAll(/^.*\brequire\(.*$/gm)) {
            const line = match[0].trim();
            if (line.startsWith("//") || line.startsWith("*")) {
                continue;
            }
            assert.match(line, /typeof require|^require\("\.\/utils"\) :$|^require\("\.\/localeUtils"\) :$|^require\("\.\/ioUtils"\) :$|^require\("\.\/styleUtils"\) :$|^require\("\.\/providerUtils"\) :$|^require\("\.\/holidayAdapters"\) :$|^require\("\.\/holidayConstants"\) :$|^require\("\.\/holidayCache"\) :$|^require\("\.\/holidayServiceAdapters"\) :$|^require\("\.\/worldclockData"\) :$|^require\("\.\/weatherFormat"\) :$|^require\("\.\/weatherScheduler"\) :$|^require\("\.\/weatherProviders"\) :$|APPLET_MODULES \? APPLET_MODULES\.\w+ : require\("\.\/\w+"\);$/,
                `${moduleName}.js: unguarded require: ${line}`);
        }
    }
});
