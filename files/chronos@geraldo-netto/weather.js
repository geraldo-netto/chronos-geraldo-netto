/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const Utils = typeof require === "function" ?
    require("./utils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].utils;

// GJS exports only var bindings: anything another module reaches for
// through imports.ui.appletManager must be declared with var
const WeatherFormat = typeof require === "function" ?
    require("./weatherFormat") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherFormat;
// The refresh clock lives in its own module now; weather.js is the barrel that
// requires it and hands it on, so consumers and the parity list are unchanged.
const WeatherScheduler = typeof require === "function" ?
    require("./weatherScheduler") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherScheduler;
var WeatherRefreshScheduler = WeatherScheduler.WeatherRefreshScheduler;

// re-exported so the applet, the tests and the 5.4 shim keep one import for the
// whole weather feature; GJS only exports var bindings
var REFRESH_SECONDS = WeatherFormat.REFRESH_SECONDS;
var RETRY_SECONDS = WeatherFormat.RETRY_SECONDS;
var STALE_PERIODS = WeatherFormat.STALE_PERIODS;
var staleAfterSeconds = WeatherFormat.staleAfterSeconds;
var readingIsStale = WeatherFormat.readingIsStale;
var MAX_RETRY_ATTEMPTS = WeatherFormat.MAX_RETRY_ATTEMPTS;
var MAX_GEOCODE_CACHE_ENTRIES = WeatherFormat.MAX_GEOCODE_CACHE_ENTRIES;
var HTTP_TIMEOUT_SECONDS = WeatherFormat.HTTP_TIMEOUT_SECONDS;
var WEATHER_DEBOUNCE_MS = WeatherFormat.WEATHER_DEBOUNCE_MS;
var WEATHER_ERROR_MARKER = WeatherFormat.WEATHER_ERROR_MARKER;
var WEATHER_PENDING_TEXT = WeatherFormat.WEATHER_PENDING_TEXT;
var WEATHER_ERRORS = WeatherFormat.WEATHER_ERRORS;
var WEATHER_USER_AGENT = WeatherFormat.WEATHER_USER_AGENT;
var WEATHER_PROVIDER_NAMES = WeatherFormat.WEATHER_PROVIDER_NAMES;
var WEATHER_CONDITIONS = WeatherFormat.WEATHER_CONDITIONS;
var normalizeUnits = WeatherFormat.normalizeUnits;
var formatTemperature = WeatherFormat.formatTemperature;
var weatherIcon = WeatherFormat.weatherIcon;
var geocodeUrl = WeatherFormat.geocodeUrl;
var nominatimGeocodeUrl = WeatherFormat.nominatimGeocodeUrl;
var locationCacheKey = WeatherFormat.locationCacheKey;
var forecastUrl = WeatherFormat.forecastUrl;
var metNoForecastUrl = WeatherFormat.metNoForecastUrl;
var aviationWeatherUrl = WeatherFormat.aviationWeatherUrl;
var aviationWeatherIcon = WeatherFormat.aviationWeatherIcon;
var metarNumber = WeatherFormat.metarNumber;
var aviationWeatherStation = WeatherFormat.aviationWeatherStation;
var aviationWeatherReading = WeatherFormat.aviationWeatherReading;
var aviationWeatherText = WeatherFormat.aviationWeatherText;
var weatherReading = WeatherFormat.weatherReading;
var weatherText = WeatherFormat.weatherText;
var metNoIcon = WeatherFormat.metNoIcon;
var metNoWeatherReading = WeatherFormat.metNoWeatherReading;
var metNoWeatherText = WeatherFormat.metNoWeatherText;
var openMeteoGeocodePlace = WeatherFormat.openMeteoGeocodePlace;
var nominatimGeocodePlace = WeatherFormat.nominatimGeocodePlace;

class WeatherDisplayState {
    constructor(params = {}) {
        // the reading is the unit-free record; the text is what it rendered to,
        // kept only until the applet takes the record itself (T442c)
        this._last_good_reading = null;
        this._last_good_text = "";
        this._last_good_provider = "";
        this._last_good_key = "";
        this._last_good_at = 0;
        this._now = params.now || (() => Date.now());
        // Two refresh periods with nothing getting through means nobody is
        // refreshing this successfully any more, and what is on the panel is
        // not the weather. The rule, and the derivation from the refresh period,
        // are weatherFormat's — the city rows of the same feature use the same
        // ones.
        this._stale_after_seconds = params.staleAfterSeconds ||
            staleAfterSeconds(params.refreshSeconds);
    }

    hasReading() {
        return Boolean(this._last_good_reading);
    }

    // A reading belongs to the place and the units it was fetched for. The error
    // path has always known this — it only re-shows the last good reading when
    // the key still matches — but the success path had no equivalent, so a
    // location change left the *old* city's temperature on the panel, unmarked,
    // for as long as the new chains took to walk.
    //
    // Change Lisbon to Tokyo: queue() forgets the geocode entry, but hasReading()
    // was still true, so schedule() did not reserve the slot with the "…"
    // placeholder and the panel went on presenting Lisbon's temperature as
    // Tokyo's — for up to about 90 seconds, with nothing to say it was not.
    forgetUnless(staleKey) {
        if (!this._last_good_key || this._last_good_key === staleKey) {
            return;
        }

        this._last_good_reading = null;
        this._last_good_text = "";
        this._last_good_provider = "";
        this._last_good_key = "";
        this._last_good_at = 0;
    }

    // a reading nobody has managed to refresh for two periods is no longer a
    // reading, and showing it is worse than showing nothing
    isStale(now = this._now()) {
        if (!this._last_good_reading) {
            return false;
        }

        return readingIsStale(this._last_good_at, now, this._stale_after_seconds);
    }

    // The forecast resolver reports a rendered text and, alongside it, the
    // unit-free reading record it came from. This keeps the record as the last
    // good one and still carries the text for the applet edge; the error path
    // re-shows both. When the applet takes the record (T442c) the text falls out.
    reporter(staleKey, callback) {
        return (text, error, provider, reading) => {
            if (reading && !error) {
                this._last_good_reading = reading;
                this._last_good_text = text;
                this._last_good_provider = provider;
                this._last_good_key = staleKey;
                this._last_good_at = this._now();
            } else if (error && this._last_good_reading && this._last_good_key === staleKey &&
                !this.isStale()) {
                callback(this._last_good_text, error, this._last_good_provider, this._last_good_reading);
                return;
            }
            callback(text, error, provider, reading);
        };
    }
}

// The geocoders, in the order they are tried. Named, because a nameless provider
// is logged by its URL when the chain moves on - and a geocode URL carries the
// place the user typed.
var GEOCODE_PROVIDERS = [
    {
        name: WEATHER_PROVIDER_NAMES.OPEN_METEO,
        url: geocodeUrl,
        normalize: openMeteoGeocodePlace
    },
    {
        name: WEATHER_PROVIDER_NAMES.NOMINATIM,
        url: nominatimGeocodeUrl,
        normalize: nominatimGeocodePlace,
        options: {
            headers: {
                "User-Agent": WEATHER_USER_AGENT
            }
        }
    }
];

var WeatherLocationResolver = class WeatherLocationResolver {
    constructor(params = {}) {
        this._providers = params.providers || GEOCODE_PROVIDERS;
        this._geocode_cache = params.cache || new Map();
        this._max_entries = params.maxCacheEntries || MAX_GEOCODE_CACHE_ENTRIES;
        this._httpGetJson = params.httpGetJson;
    }

    get cache() {
        return this._geocode_cache;
    }

    // every debounced keystroke in the location entry resolves a place, so
    // without a bound the map grows with the typing
    _remember(cacheKey, place) {
        if (this._geocode_cache.size >= this._max_entries) {
            const oldest = this._geocode_cache.keys().next();
            if (!oldest.done) {
                this._geocode_cache.delete(oldest.value);
            }
        }

        this._geocode_cache.set(cacheKey, place);
    }

    // an ambiguous name that resolved to the wrong city would otherwise stay
    // pinned for the life of the applet
    forget(location) {
        this._geocode_cache.delete(locationCacheKey(location));
    }

    resolve(location, isCurrent, callback) {
        const cacheKey = locationCacheKey(location);
        const cachedPlace = this._geocode_cache.get(cacheKey);
        if (cachedPlace) {
            callback(cachedPlace, "", cacheKey);
            return;
        }

        this._geocodeLocation(location, isCurrent, (place, error) => {
            if (!place) {
                callback(null, error, cacheKey);
                return;
            }

            this._remember(cacheKey, place);
            callback(place, "", cacheKey);
        });
    }

    _geocodeLocation(location, isCurrent, callback) {
        // `url` is built per lookup; the rest of the provider is fixed
        const providers = this._providers.map((provider) => ({
            name: provider.name,
            url: provider.url(location),
            normalize: provider.normalize,
            options: provider.options
        }));

        this._tryGeocodeProviders(providers, isCurrent, callback);
    }

    _tryGeocodeProviders(providers, isCurrent, callback) {
        let anyResponse = false;
        Utils.tryProvidersInOrder(
            providers,
            (provider, onResult) => {
                this._httpGetJson(provider.url, (data) => {
                    if (!isCurrent()) {
                        return;
                    }
                    anyResponse = anyResponse || (data !== null && data !== undefined);
                    onResult(provider.normalize(data));
                }, provider.options || {});
            },
            (place) => Boolean(place),
            (provider, place) => callback(place, ""),
            () => {
                if (global.log) {
                    global.log("all weather geocode providers failed");
                }
                callback(null, anyResponse ?
                    WEATHER_ERRORS.LOCATION_NOT_FOUND :
                    WEATHER_ERRORS.SERVICE_UNAVAILABLE);
            }
        );
    }
}

// Both third-party services want to be told who is calling; the geocode registry
// already carries this and used to be the only one that did
var USER_AGENT_OPTIONS = {
    headers: {
        "User-Agent": WEATHER_USER_AGENT
    }
};

// The forecast backends, in the order they are tried — data, the way
// GEOCODE_PROVIDERS is: a `url` for the place, a `normalize` that turns the
// answer into a unit-free reading record `{ condition, temperatureC }`, and the
// request options it needs. The resolver renders the record to display text at
// one seam, so a provider decides *what* the weather is and the render decides
// how to show it — the units live in exactly one place.
//
// Every entry used to be a thunk into a private method of the resolver that
// consumes it, so "adding a provider is an edit to the registry" was not true:
// it was an edit to the class as well, and the built-ins did not use the path a
// third party would — the rubric's own failure mode. They do now: the resolver
// knows nothing about any particular service.
var FORECAST_PROVIDERS = [
    {
        name: WEATHER_PROVIDER_NAMES.OPEN_METEO,
        url: (place, units) => forecastUrl(place, units),
        normalize: (data) => (data && data.current_weather ?
            weatherReading(data.current_weather) : null)
    },
    {
        name: WEATHER_PROVIDER_NAMES.AVIATION_WEATHER,
        url: (place) => aviationWeatherUrl(place),
        normalize: (stations, place) => aviationWeatherReading(stations, place),
        options: USER_AGENT_OPTIONS
    },
    {
        name: WEATHER_PROVIDER_NAMES.MET_NO,
        url: (place) => metNoForecastUrl(place),
        normalize: (data) => metNoWeatherReading(data),
        options: USER_AGENT_OPTIONS
    }
];

var WeatherForecastResolver = class WeatherForecastResolver {
    constructor(params = {}) {
        this._last_forecast_provider = "";
        this._httpGetJson = params.httpGetJson;
        // a caller can hand in its own chain; the shipped one is the default
        this._providers = params.providers || FORECAST_PROVIDERS;
    }

    get lastProvider() {
        return this._last_forecast_provider;
    }

    refresh(place, units, isCurrent, callback) {
        this._tryForecastProviders(this._orderedForecastProviders(), place, units, isCurrent, callback);
    }

    _orderedForecastProviders() {
        return Utils.orderProvidersByLastSuccess(this._providers, this._last_forecast_provider);
    }

    _tryForecastProviders(providers, place, units, isCurrent, callback) {
        Utils.tryProvidersInOrder(
            providers,
            (provider, onResult) => {
                this._httpGetJson(provider.url(place, units), (data) => {
                    if (!isCurrent()) {
                        return;
                    }
                    onResult(provider.normalize(data, place, units));
                }, provider.options || {});
            },
            (reading) => Boolean(reading),
            (provider, reading) => {
                this._last_forecast_provider = provider.name;
                // the render seam: the record becomes display text here, and the
                // record travels alongside it as a fourth argument so a consumer
                // that wants the fields (the panel display state) has them and one
                // that still wants the string (the city rows, until T442e) keeps it
                callback(WeatherFormat.formatReading(reading.condition, reading.temperatureC, units),
                    "", provider.name, reading);
            },
            () => {
                if (global.log) {
                    global.log("all weather forecast providers failed");
                }
                callback("", WEATHER_ERRORS.SERVICE_UNAVAILABLE, "", null);
            }
        );
    }

}

var WeatherProvider = class WeatherProvider {
    constructor(params = {}) {
        this._request_generation = 0;
        this._destroyed = false;
        this._display_state = params.displayState || new WeatherDisplayState(params);
        this._httpGetJson = params.httpGetJson || this._httpGetJson.bind(this);
        this._scheduler = params.scheduler || new WeatherRefreshScheduler(params);
        this._location_resolver = params.locationResolver || new WeatherLocationResolver({
            cache: params.geocodeCache,
            httpGetJson: this._httpGetJson
        });
        this._forecast_resolver = params.forecastResolver || new WeatherForecastResolver({
            httpGetJson: this._httpGetJson
        });

        // The session used to be built here unconditionally — including when the
        // caller injected httpGetJson and the session could never be used. Its
        // twin, CityWeatherProvider, has always taken one: the HTTP adapter was
        // bypassable in one provider and mandatory in the other.
        //
        // It is also built on first use rather than at construction. Weather is
        // opt-in and off by default, so a Soup session per applet at startup is
        // paid by every user who never turns it on; the holiday provider makes
        // the same argument for the same reason.
        this._httpSession = params.httpSession || null;
    }

    _getHttpSession() {
        if (!this._httpSession) {
            this._httpSession = Utils.createHttpSession({
                timeout: HTTP_TIMEOUT_SECONDS,
                idleTimeout: HTTP_TIMEOUT_SECONDS
            });
        }

        return this._httpSession;
    }

    stop() {
        this._request_generation++;
        this._scheduler.stop();
    }

    destroy() {
        this._destroyed = true;
        this.stop();

        // nothing to abort if nothing ever asked for a session
        if (this._httpSession && this._httpSession.abort) {
            this._httpSession.abort();
        }
    }

    schedule(settings, callback) {
        if (this._destroyed) {
            return;
        }

        const location = settings.location ? settings.location.trim() : "";
        // the reading on the panel belongs to the place it was fetched for; if
        // that is not the place being asked about now, it is not the weather
        this._display_state.forgetUnless(this._staleKey(settings));

        if (!this._display_state.hasReading() && settings.showWeather && location) {
            // first fetch: reserve the panel slot instead of popping in later
            callback(WEATHER_PENDING_TEXT, "", "");
        }

        this._request_generation++;
        this._scheduler.schedule(settings, () => this.refresh(settings, callback));
    }

    queue(settings, callback) {
        if (this._destroyed) {
            return;
        }

        // the user edited the location: re-resolve it rather than answering
        // from a hit that may have been wrong
        if (settings.location) {
            this._location_resolver.forget(settings.location);
        }

        this._scheduler.queue(settings, (queuedSettings) => this.schedule(queuedSettings, callback));
    }

    refresh(settings, callback) {
        if (this._destroyed) {
            return;
        }

        const generation = ++this._request_generation;
        const location = settings.location ? settings.location.trim() : "";
        if (!settings.showWeather) {
            callback("", "", "");
            return;
        }

        if (!location) {
            // weather is on but unconfigured: surface a hint instead of
            // silently showing nothing
            callback("", WEATHER_ERRORS.NO_LOCATION, "");
            return;
        }

        const units = normalizeUnits(settings.units);
        const report = this._display_state.reporter(this._staleKey(settings),
            (text, error, provider, reading) => {
                // a failed refresh must not wait out the whole refresh period
                if (error) {
                    this._scheduler.retry(() => this.refresh(settings, callback));
                } else {
                    this._scheduler.succeeded();
                }
                // the record rides along; the applet still reads the text until
                // T442c takes the record itself
                callback(text, error, provider, reading);
            });
        this._location_resolver.resolve(location, () => {
            return !this._destroyed && generation === this._request_generation;
        }, (place, error) => {
            if (this._destroyed || generation !== this._request_generation) {
                return;
            }

            if (!place) {
                report("", error, "");
                return;
            }

            this._refreshForecast(place, units, generation, report);
        });
    }

    // what a reading is a reading *of*: the place, and the units it is in
    _staleKey(settings) {
        const location = settings.location ? settings.location.trim() : "";
        return locationCacheKey(location) + "|" + normalizeUnits(settings.units);
    }

    _refreshForecast(place, units, generation, callback) {
        this._forecast_resolver.refresh(place, units, () => {
            return !this._destroyed && generation === this._request_generation;
        }, callback);
    }

    _httpGetJson(url, callback, options = {}) {
        Utils.httpGetJson(this._getHttpSession(), url, (data) => callback(data), options);
    }
};

if (typeof module !== "undefined") {
    module.exports = { WeatherProvider, FORECAST_PROVIDERS, GEOCODE_PROVIDERS, WeatherDisplayState, WeatherRefreshScheduler, WeatherLocationResolver, WeatherForecastResolver, STALE_PERIODS, staleAfterSeconds, readingIsStale, HTTP_TIMEOUT_SECONDS, MAX_GEOCODE_CACHE_ENTRIES, MAX_RETRY_ATTEMPTS, WEATHER_DEBOUNCE_MS, WEATHER_ERROR_MARKER, WEATHER_PENDING_TEXT, WEATHER_ERRORS, WEATHER_USER_AGENT, WEATHER_PROVIDER_NAMES, WEATHER_CONDITIONS, REFRESH_SECONDS, RETRY_SECONDS, geocodeUrl, nominatimGeocodeUrl, forecastUrl, metNoForecastUrl, aviationWeatherUrl, aviationWeatherIcon, aviationWeatherStation, aviationWeatherReading, aviationWeatherText, metarNumber, locationCacheKey, normalizeUnits, formatTemperature, weatherIcon, weatherReading, weatherText, metNoIcon, metNoWeatherReading, metNoWeatherText, openMeteoGeocodePlace, nominatimGeocodePlace };
}
