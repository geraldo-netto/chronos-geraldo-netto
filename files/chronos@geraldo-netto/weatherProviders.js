/* global imports */
/* eslint camelcase: "off" */

// The provider chains of the weather feature: the geocoders that turn a typed
// place into coordinates, the forecast backends that turn coordinates into a
// reading, and the two resolvers that walk each chain with the shared failover
// machinery. weatherFormat.js owns the pure numbers and words each provider
// reads and writes; weatherScheduler.js owns the refresh clock; weather.js is
// the barrel that requires all three and adds WeatherProvider on top.

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const Utils = typeof require === "function" ?
    require("./utils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].utils;
const WeatherFormat = typeof require === "function" ?
    require("./weatherFormat") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherFormat;

const WEATHER_PROVIDER_NAMES = WeatherFormat.WEATHER_PROVIDER_NAMES;
const WEATHER_USER_AGENT = WeatherFormat.WEATHER_USER_AGENT;
const WEATHER_ERRORS = WeatherFormat.WEATHER_ERRORS;
const MAX_GEOCODE_CACHE_ENTRIES = WeatherFormat.MAX_GEOCODE_CACHE_ENTRIES;
const locationCacheKey = WeatherFormat.locationCacheKey;
const geocodeUrl = WeatherFormat.geocodeUrl;
const openMeteoGeocodePlace = WeatherFormat.openMeteoGeocodePlace;
const nominatimGeocodeUrl = WeatherFormat.nominatimGeocodeUrl;
const nominatimGeocodePlace = WeatherFormat.nominatimGeocodePlace;
const forecastUrl = WeatherFormat.forecastUrl;
const weatherReading = WeatherFormat.weatherReading;
const aviationWeatherUrl = WeatherFormat.aviationWeatherUrl;
const aviationWeatherReading = WeatherFormat.aviationWeatherReading;
const metNoForecastUrl = WeatherFormat.metNoForecastUrl;
const metNoWeatherReading = WeatherFormat.metNoWeatherReading;
const formatReading = WeatherFormat.formatReading;

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
                // that still wants the string (the city rows) keeps it
                callback(formatReading(reading.condition, reading.temperatureC, units),
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

if (typeof module !== "undefined") {
    module.exports = {
        GEOCODE_PROVIDERS, FORECAST_PROVIDERS,
        WeatherLocationResolver, WeatherForecastResolver
    };
}
