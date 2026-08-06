const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// The 6.0 shims load the root modules through the native GJS importer
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
                get_language_names: () => ["C"],
                SpawnFlags: { SEARCH_PATH: 4 },
                get_monotonic_time() {
                    return 2500000;
                },
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
                        calendarServerConnection: {
                            CalendarServerConnection: class {},
                            SERVER_RETRY_SECONDS: 5,
                            SERVER_RETRY_MAX_SECONDS: 300,
                            EDS_BUS_NAME: "org.gnome.evolution.dataserver.Calendar8"
                        },
                        eventIndex: {
                            EventIndex: class {},
                            MAX_SPANNED_DAYS: 50
                        },
                        eventWindow: {
                            EventWindowCoordinator: class {}
                        },
                        clockLimits: {
                            MAX_CLOCKS: 8
                        },
                        elapsedTime: {
                            civilMilliseconds() { return 1000; },
                            monotonicMilliseconds() { return 2500; },
                            monotonicSeconds() { return 2.5; }
                        },
                        dateMath: {
                            MSECS_IN_DAY: 86400000,
                            monthWindowStartOffset() {}
                        },
                        textUtils: {
                            clampText(text, max) { return String(text).slice(0, max); },
                            displayWidth(text) { return Array.from(String(text)).length; },
                            textWithinLimit(text, max) {
                                return Array.from(String(text)).length <= max;
                            },
                            normalizeBoundedText(text) { return String(text).trim(); },
                            urlForLog(url) { return String(url).split(/[?#]/)[0]; },
                            TEXT_ELLIPSIS: "…"
                        },
                        localeText: {
                            translate(str) { return str; },
                            translatePlural(s, p, n) { return n === 1 ? s : p; },
                            joinPhrases(...parts) { return parts.join(" — "); },
                            localeDirectory() { return "/tmp"; }
                        },
                        localeQuery: {
                            registerLocaleConsumer() {},
                            cancelPendingLocaleQueries() {},
                            onLocaleInfoChanged() {},
                            lazyLocaleValue() { return () => ""; },
                            MESSAGE_LANGUAGE_FALLBACK: "en",
                            messageLanguage() { return "en"; },
                            getInfo() { return {}; }
                        },
                        dateFormats: {
                            MSECS_IN_DAY: 86400000,
                            DAY_FORMAT: "%A",
                            DATE_FORMAT_SHORT: "%B %-e, %Y",
                            DATE_FORMAT_FULL: "%A, %B %-e, %Y",
                            MAX_DATE_FORMAT_LENGTH: 256,
                            MAX_CLOCK_STAMP_LENGTH: 256,
                            monthWindowStartOffset() {},
                            dateFormatWithinLimit() { return true; },
                            dateFormatOrDefault(format) { return format; },
                            clampClockStamp(stamp) { return stamp; }
                        },
                        ioUtils: {
                            createHttpSession() {},
                            decodeUtf8() {},
                            MAX_RESPONSE_BYTES: 4194304,
                            HTTP_TIMEOUT_SECONDS: 30,
                            httpGetJson() {},
                            urlForLog() {},
                            readTextFileCapped() {},
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
                            locationCacheKey() {},
                            NOMINATIM_MIN_INTERVAL_MS: 1000,
                            NominatimRequestQueue: class {},
                            WeatherLocationResolver: class {},
                            WeatherForecastResolver: class {},
                            WeatherReadingRepository: class {}
                        },
                        weatherFormat: {
                            REFRESH_SECONDS: 1800,
                            RETRY_SECONDS: 30,
                            STALE_PERIODS: 2,
                            staleAfterSeconds() {},
                            readingIsStale() {},
                            MAX_RETRY_ATTEMPTS: 8,
                            MAX_GEOCODE_CACHE_ENTRIES: 16,
                            MAX_WEATHER_LOCATION_LENGTH: 256,
                            WEATHER_DEBOUNCE_MS: 750,
                            WEATHER_UNITS: { SI: "si", IMPERIAL: "imperial" },
                            WEATHER_ERROR_MARKER: "⚠",
                            WEATHER_PENDING_TEXT: "…",
                            WEATHER_ERRORS: {},
                            WEATHER_CONDITIONS: {},
                            normalizeUnits() {},
                            normalizeWeatherLocation(location) {
                                return String(location || "").trim();
                            },
                            formatTemperature() {}
                        },
                        weatherServiceAdapters: {
                            GEOCODE_CANDIDATE_COUNT: 10,
                            WEATHER_USER_AGENT: "agent",
                            WEATHER_PROVIDER_NAMES: {},
                            AVIATION_WEATHER_BBOX_DEGREES: 1,
                            weatherIcon() {},
                            geocodeUrl() {},
                            geocodeLanguage() {},
                            nominatimGeocodeUrl() {},
                            forecastUrl() {},
                            metNoForecastUrl() {},
                            aviationWeatherUrl() {},
                            aviationWeatherIcon() {},
                            metarNumber() {},
                            aviationWeatherStation() {},
                            aviationWeatherReading() {},
                            weatherReading() {},
                            metNoIcon() {},
                            metNoSummary() {},
                            metNoWeatherReading() {},
                            openMeteoGeocodePlace() {},
                            nominatimGeocodePlace() {}
                        },
                        worldclockData: {
                            registerWorldclockConsumer() {},
                            releaseWorldclockConsumer() {},
                            MAX_CLOCKS: 8,
                            LOCAL_TIMEZONE: "local",
                            INVALID_TIMEZONE_TEXT: "Invalid timezone",
                            LOCAL_TIME_TEXT: "Local time",
                            timezoneFromIdentifier() {},
                            builtinClocks() {},
                            timezoneIdentity() {},
                            timezoneCityName() {},
                            regionalTimezoneIdentifier() {},
                            localTimezoneFromSources() {},
                            countryCodeFromZoneTab() {},
                            localCountryCode() {},
                            builtInTimezoneKeys() {}
                        },
                        holidayAdapters: {
                            HolidayFallbackChain: class {}
                        },
                        holidayConstants: {
                            HOLIDAY_ERRORS: {},
                            HOLIDAY_PROVIDER_NAMES: {},
                            GLOBAL_REGION: "global",
                            PUBLIC_HOLIDAY_FLAG: "public_holiday",
                            RELIGIOUS_HOLIDAY_FLAG: "religious_holiday",
                            OPEN_HOLIDAYS_COUNTRIES: {},
                            COUNTRY_TO_ISO2: {},
                            ISO2_TO_COUNTRY: {},
                            countryFromIso2() {},
                            REGION_TO_SUBDIVISION: {}
                        },
                        religiousCatalog: {
                            RELIGIONS: [],
                            RELIGION_IDS: []
                        },
                        hebrewCalendar: {
                            hebrewLeapYear() {},
                            gregorianFromHebrew() {},
                            hebrewObservances() {}
                        },
                        holidayCache: {
                            HolidayCacheRepository: class {},
                            HolidayCache: class {},
                            GLOBAL_REGION: "global"
                        },
                        holidayRecord: {
                            validDateParts() {},
                            validHolidaySpan() {},
                            holidaySpanDays() {},
                            MAX_HOLIDAY_SPAN_DAYS: 366,
                            MAX_HOLIDAYS_PER_YEAR: 1000,
                            MAX_EXPANDED_HOLIDAY_ROWS: 4000,
                            HolidayRecordContract: class {
                                validResponse() {
                                    return true;
                                }
                            }
                        },
                        religiousHolidays: {},
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
    astronomy: ["ASTRONOMY_DAY_MS", "ASTRONOMY_MAX_DAY_MS", "ASTRONOMY_SAMPLE_MS",
        "validCoordinates", "validDayBounds", "sunAltitude", "moonAltitude",
        "calculateAstronomyEvents"],
    clockLimits: ["MAX_CLOCKS"],
    elapsedTime: ["civilMilliseconds", "monotonicMilliseconds", "monotonicSeconds"],
    dateMath: ["MSECS_IN_DAY", "monthWindowStartOffset"],
    ioUtils: ["createHttpSession", "decodeUtf8", "HTTP_TIMEOUT_SECONDS", "MAX_RESPONSE_BYTES", "httpGetJson", "urlForLog", "readTextFileCapped", "readJsonFileAsync", "writeJsonFileAsync"],
    styleUtils: ["safeCssColor"],
    textUtils: ["clampText", "displayWidth", "textWithinLimit", "normalizeBoundedText",
        "urlForLog", "TEXT_ELLIPSIS"],
    localeText: ["translate", "translatePlural", "joinPhrases", "localeDirectory"],
    localeQuery: ["registerLocaleConsumer", "cancelPendingLocaleQueries",
        "onLocaleInfoChanged", "lazyLocaleValue", "MESSAGE_LANGUAGE_FALLBACK",
        "messageLanguage", "getInfo"],
    dateFormats: ["MSECS_IN_DAY", "MAX_DATE_FORMAT_LENGTH", "MAX_CLOCK_STAMP_LENGTH",
        "DAY_FORMAT", "DATE_FORMAT_SHORT", "DATE_FORMAT_FULL",
        "monthWindowStartOffset", "dateFormatWithinLimit", "dateFormatOrDefault",
        "clampClockStamp", "formatDateWithFallback"],
    providerUtils: ["backoffDelay", "orderProvidersByLastSuccess", "tryProvidersInOrder"],
    weatherFormat: ["REFRESH_SECONDS", "RETRY_SECONDS", "STALE_PERIODS",
        "staleAfterSeconds", "readingIsStale",
        "MAX_WEATHER_LOCATION_LENGTH", "normalizeWeatherLocation",
        "WEATHER_ERROR_MARKER", "WEATHER_PENDING_TEXT", "WEATHER_ERRORS",
        "WEATHER_CONDITIONS", "normalizeUnits", "formatTemperature"],
    weatherServiceAdapters: ["GEOCODE_CANDIDATE_COUNT",
        "WEATHER_USER_AGENT", "WEATHER_PROVIDER_NAMES", "AVIATION_WEATHER_BBOX_DEGREES",
        "weatherIcon", "geocodeUrl", "geocodeLanguage", "nominatimGeocodeUrl",
        "forecastUrl", "metNoForecastUrl", "aviationWeatherUrl", "aviationWeatherIcon",
        "aviationWeatherStation", "metarNumber", "metNoIcon", "metNoSummary",
        "openMeteoGeocodePlace", "nominatimGeocodePlace"],
    weatherScheduler: ["WeatherRefreshScheduler"],
    weatherProviders: ["GEOCODE_PROVIDERS", "FORECAST_PROVIDERS", "locationCacheKey",
        "NOMINATIM_MIN_INTERVAL_MS", "NominatimRequestQueue",
        "WeatherLocationResolver", "WeatherForecastResolver", "WeatherReadingRepository"],
    // The panel provider and the composition-root repository cross the version
    // shim; other consumers require the part that declares their symbol.
    weather: ["WeatherProvider", "WeatherReadingRepository"],
    holidays: ["Provider", "HolidayCacheRepository", "HolidayCache", "EnricoServiceAdapter",
        "NagerDateServiceAdapter", "OpenHolidaysServiceAdapter",
        "createHolidayServiceChain", "HolidayService", "HolidayProviderFacade",
        "ReligiousHolidayProvider", "HOLIDAY_ERRORS"],
    religiousCatalog: ["RELIGIONS", "RELIGION_IDS"],
    hebrewCalendar: ["hebrewLeapYear", "gregorianFromHebrew", "hebrewObservances"],
    religiousHolidays: ["RELIGIOUS_HOLIDAY_FLAG", "RELIGIONS", "gregorianEaster",
        "religionIds", "enabledReligionIds", "holidaysForYear", "monthMap",
        "mergeMonthMaps"],
    holidayAdapters: ["HolidayFallbackChain"],
    holidayCache: ["HolidayCacheRepository", "HolidayCache", "validCachedHoliday",
        "validCachedStamp", "validCachedYears", "clampHolidayName", "MAX_HOLIDAY_NAME_LENGTH", "MAX_MEMOIZED_MONTHS",
        "UPDATE_PERIOD", "RETRY_PERIOD", "YEAR_WINDOW", "GLOBAL_REGION"],
    holidayRecord: ["validDateParts", "validHolidaySpan", "holidaySpanDays",
        "MAX_HOLIDAY_SPAN_DAYS", "MAX_HOLIDAYS_PER_YEAR", "MAX_EXPANDED_HOLIDAY_ROWS",
        "HolidayRecordContract"],
    holidayServiceAdapters: ["regionSubdivisionCode", "isoDateParts",
        "IsoHolidayServiceAdapter", "EnricoServiceAdapter", "NagerDateServiceAdapter",
        "OpenHolidaysServiceAdapter", "createHolidayServiceChain"],
    holidayConstants: ["HOLIDAY_ERRORS", "HOLIDAY_PROVIDER_NAMES", "GLOBAL_REGION",
        "PUBLIC_HOLIDAY_FLAG", "RELIGIOUS_HOLIDAY_FLAG",
        "OPEN_HOLIDAYS_COUNTRIES", "COUNTRY_TO_ISO2", "ISO2_TO_COUNTRY",
        "countryFromIso2", "REGION_TO_SUBDIVISION"],
    worldclockData: ["MAX_CLOCKS", "MAX_CLOCK_LABEL_CELLS", "MAX_CLOCK_INPUT_LABEL_LENGTH",
        "LOCAL_TIMEZONE", "INVALID_TIMEZONE_TEXT",
        "LOCAL_TIME_TEXT", "timezoneFromIdentifier", "builtinClocks",
        "timezoneIdentity", "timezoneCityName", "timezoneWeatherCity", "regionalTimezoneIdentifier",
        "localTimezoneFromSources",
        "countryCodeFromZoneTab", "localCountryCode", "builtInTimezoneKeys",
        "selectUserClocks", "clockDisplayLabel", "clockInputLabel",
        "registerWorldclockConsumer", "releaseWorldclockConsumer"],
    eventData: ["js_date_to_gdatetime", "date_only", "month_year_only", "dt_equals",
        "EventData", "EventDataList"],
    calendarServerConnection: ["CalendarServerConnection", "SERVER_RETRY_SECONDS",
        "SERVER_RETRY_MAX_SECONDS", "EDS_BUS_NAME"],
    eventIndex: ["EventIndex"],
    eventWindow: ["EventWindowCoordinator"],
    eventsManager: ["EventsManager", "createEventsManager", "SERVER_RETRY_SECONDS", "EDS_BUS_NAME"],
    eventFormat: ["EVENT_PHASE_PAST", "EVENT_PHASE_UPCOMING", "EVENT_PHASE_CURRENT",
        "dtEquals", "classifyEventDisplayState", "localeCap", "formatRangePrefix",
        "formatRangeSuffix", "formatEventTimeRange", "ARROW_SEPARATOR"],
    settingsFacade: ["CalendarSettings", "EventsSettings", "SHOW_EVENTS_KEY",
        "SHOW_WEEK_NUMBERS_KEY", "WEEKEND_LENGTH_KEY", "SHOW_RELIGIOUS_OBSERVANCES_KEY",
        "RELIGION_KEY_PREFIX", "RELIGION_IDS", "CUSTOM_FORMAT_KEY",
        "CUSTOM_TOOLTIP_FORMAT_KEY", "NO_HOLIDAYS"]
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

test("elapsed time exposes civil freshness and monotonic pacing clocks", () => {
    const context = nativeImport("elapsedTime");
    const before = Date.now();
    const civil = context.civilMilliseconds();
    const after = Date.now();
    assert.ok(civil >= before && civil <= after);
    assert.equal(context.monotonicMilliseconds(), 2500);
    assert.equal(context.monotonicSeconds(), 2.5);
});

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
// T780: weather.js used to spread its four part modules into module.exports,
// which runs on the Node side alone — so around forty names were functions
// under `node test/` and undefined on the panel, and a consumer reading one got
// a silent wrong value rather than a crash. The guard against that was a
// hand-written list of three files, two of which do not require the barrel at
// all, so its else branch was dead and a new consumer would have passed.
//
// The module now exports exactly the `var` bindings GJS exposes, and the list
// is read from the tree.
test("weather.js exports the same names to Node that GJS can see", () => {
    const source = fs.readFileSync(path.join(APPLET_DIR, "weather.js"), "utf8");
    const declared = new Set(Array.from(
        source.matchAll(/^var (\w+)/gm), ([, name]) => name));
    // WeatherDisplayState is a plain class rather than a var: it is the panel's
    // own state and nothing outside this module and its tests constructs one
    declared.add("WeatherDisplayState");

    const originalImports = global.imports;
    global.imports = gjsImportsMock();
    for (const file of ["weather.js", "weatherScheduler.js", "weatherProviders.js",
        "weatherFormat.js", "weatherServiceAdapters.js", "ioUtils.js", "styleUtils.js",
        "providerUtils.js", "localeQuery.js"]) {
        delete require.cache[require.resolve(path.join(APPLET_DIR, file))];
    }
    const barrel = require(path.join(APPLET_DIR, "weather.js"));
    global.imports = originalImports;

    assert.deepEqual(Object.keys(barrel).sort(), Array.from(declared).sort(),
        "a name exported to Node that GJS cannot see reads as undefined on the panel");
});

// Every module that requires the barrel, found by reading the tree rather than
// by listing them: a new consumer that reads a name weather.js does not declare
// must fail here, not on someone's panel.
test("every barrel consumer reads only names the barrel declares", () => {
    const barrelSource = fs.readFileSync(path.join(APPLET_DIR, "weather.js"), "utf8");
    const declared = new Set(Array.from(
        barrelSource.matchAll(/^var (\w+)/gm), ([, name]) => name));
    declared.add("WeatherDisplayState");

    const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                return walk(full);
            }
            return entry.name.endsWith(".js") ? [full] : [];
        });
    const consumers = walk(APPLET_DIR)
        .map((full) => ({ file: path.relative(APPLET_DIR, full),
            source: fs.readFileSync(full, "utf8") }))
        .filter(({ source }) => /require\("\.\/weather"\)/.test(source));

    assert.ok(consumers.length > 0, "the barrel has at least one consumer to check");
    for (const { file, source } of consumers) {
        const read = new Set(Array.from(
            source.matchAll(/\bWeather\.(\w+)/g), ([, name]) => name));
        const unknown = Array.from(read).filter((name) => !declared.has(name));
        assert.deepEqual(unknown, [],
            `${file} reads a name weather.js does not declare, which is undefined in GJS`);
    }
});

// REGRESSION (forward-compat): the loader guard asked `typeof require ===
// "function"`, on the stated assumption that Cinnamon provides neither require()
// nor module. True of 5.4 through 6.4. Cinnamon master sets globalThis.require =
// xletRequire (js/ui/extension.js), and there the test inverts: every root module
// would take the require() branch, _requireLocal would resolve "./localeUtils"
// against extension.meta.path — which findExtensionSubdirectory has already
// repointed at the 6.0/ directory — and the applet would fail to load, because the
// root modules are not in there.
//
// So the question is asked of the host: Node has `process`, Cinnamon's cjs does
// not. This runs every root module in a context shaped like Cinnamon master —
// require() present, importer present, no process — and requires that it still
// reads its collaborators through the importer.
test("a host with both require() and the importer loads through the importer", () => {
    for (const moduleName of Object.keys(EXPORTS)) {
        const modulePath = path.join(APPLET_DIR, moduleName + ".js");
        const context = {
            imports: gjsImportsMock(),
            // Cinnamon master's xletRequire: it resolves against the *version*
            // directory, so a root module reaching it would get nothing
            require: (request) => {
                throw new Error(
                    `${moduleName}.js called require(${request}) under the GJS importer`);
            },
            module: { exports: {} }
        };
        context.globalThis = context;
        vm.createContext(context);

        assert.doesNotThrow(
            () => vm.runInContext(fs.readFileSync(modulePath, "utf8"), context,
                { filename: modulePath }),
            `${moduleName}.js must not require() when the applet importer is there`);

        for (const symbol of EXPORTS[moduleName]) {
            assert.notEqual(context[symbol], undefined,
                `${moduleName}.${symbol} is missing after loading through the importer`);
        }
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
            // the guarded shape is `typeof require === "function" ? require("./x") : …`,
            // so the require sits either on the typeof line or on the true branch's own
            // line — naming every module here made the pattern a list to maintain
            assert.match(line, /typeof require|^require\("\.\/\w+"\) :$|APPLET_MODULES \? APPLET_MODULES\.\w+ : require\("\.\/\w+"\);$/,
                `${moduleName}.js: unguarded require: ${line}`);
        }
    }
});
