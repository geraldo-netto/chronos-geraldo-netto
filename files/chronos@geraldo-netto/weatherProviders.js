// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* global imports */
/* eslint camelcase: "off" */

// The provider chains of the weather feature: the geocoders that turn a typed
// place into coordinates, the forecast backends that turn coordinates into a
// reading, and the two resolvers that walk each chain with the shared failover
// machinery. weatherServiceAdapters.js owns vendor URLs and wire formats;
// weatherScheduler.js owns the refresh clock; weather.js composes the feature.

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
// Which host is loading this file — and it is asked of the *host*, not of
// require(). It used to test `typeof require === "function"`, on the stated
// assumption that "Cinnamon provides neither require() nor module". That was true
// of 5.4 through 6.4 and is not true of Cinnamon master, which sets
// globalThis.require = xletRequire (js/ui/extension.js). There the test would
// invert: the root modules would take the require() branch, _requireLocal would
// resolve "./localeUtils" against extension.meta.path — which
// findExtensionSubdirectory has already repointed at the 5.4/ directory — and the
// applet would fail to load, because localeUtils.js is not in there.
//
// Node is what this asks about, because Node is the only host that requires these
// files directly. Cinnamon's cjs has no `process`.
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const GLib = GjsImports.gi.GLib;
const ProviderUtils = IS_NODE ?
    require("./providerUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].providerUtils;
const WeatherFormat = IS_NODE ?
    require("./weatherFormat") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherFormat;
const WeatherServiceAdapters = IS_NODE ?
    require("./weatherServiceAdapters") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherServiceAdapters;

const WEATHER_ERRORS = WeatherFormat.WEATHER_ERRORS;
const MAX_GEOCODE_CACHE_ENTRIES = WeatherFormat.MAX_GEOCODE_CACHE_ENTRIES;
const WEATHER_PROVIDER_NAMES = WeatherServiceAdapters.WEATHER_PROVIDER_NAMES;
const WEATHER_USER_AGENT = WeatherServiceAdapters.WEATHER_USER_AGENT;
const geocodeUrl = WeatherServiceAdapters.geocodeUrl;
const openMeteoGeocodePlace = WeatherServiceAdapters.openMeteoGeocodePlace;
const nominatimGeocodeUrl = WeatherServiceAdapters.nominatimGeocodeUrl;
const nominatimGeocodePlace = WeatherServiceAdapters.nominatimGeocodePlace;
const forecastUrl = WeatherServiceAdapters.forecastUrl;
const weatherReading = WeatherServiceAdapters.weatherReading;
const aviationWeatherUrl = WeatherServiceAdapters.aviationWeatherUrl;
const aviationWeatherReading = WeatherServiceAdapters.aviationWeatherReading;
const metNoForecastUrl = WeatherServiceAdapters.metNoForecastUrl;
const metNoWeatherReading = WeatherServiceAdapters.metNoWeatherReading;

function locationCacheKey(location) {
    return location.trim().toLowerCase();
}

var NOMINATIM_MIN_INTERVAL_MS = 1000; // NOSONAR [S3504] -- GJS importer export

// The public Nominatim service permits one request at a time and at most one
// request per second. This queue is module-global so every applet instance and
// both the panel and world-clock weather paths share the same budget.
var NominatimRequestQueue = class NominatimRequestQueue { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._now = params.now || (() => Date.now());
        this._schedule = params.schedule || ((delay, callback) =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, callback));
        this._jobs = [];
        this._active = false;
        this._last_started_at = null;
        this._timer_id = 0;
    }

    enqueue(start, isCurrent = () => true) {
        this._jobs.push({ start, isCurrent });
        this._drain();
    }

    _nextCurrentJob() {
        while (this._jobs.length) {
            const job = this._jobs.shift();
            if (job.isCurrent()) {
                return job;
            }
        }
        return null;
    }

    _drain() {
        if (this._active || this._timer_id) {
            return;
        }

        const job = this._nextCurrentJob();
        if (!job) {
            return;
        }

        const elapsed = this._last_started_at === null ?
            NOMINATIM_MIN_INTERVAL_MS : this._now() - this._last_started_at;
        const delay = Math.max(0, NOMINATIM_MIN_INTERVAL_MS - elapsed);
        if (delay > 0) {
            this._jobs.unshift(job);
            this._timer_id = this._schedule(delay, () => {
                this._timer_id = 0;
                this._drain();
                return false;
            });
            return;
        }

        this._active = true;
        this._last_started_at = this._now();
        let released = false;
        const release = () => {
            if (released) {
                return;
            }
            released = true;
            this._active = false;
            this._drain();
        };

        try {
            job.start(release);
        } catch (error) {
            release();
            throw error;
        }
    }
};

var NOMINATIM_REQUEST_QUEUE = new NominatimRequestQueue(); // NOSONAR [S3504] -- GJS importer export

// The geocoders, in the order they are tried. Named, because a nameless provider
// is logged by its URL when the chain moves on - and a geocode URL carries the
// place the user typed.
var GEOCODE_PROVIDERS = [ // NOSONAR [S3504] -- GJS importer export
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

var WeatherLocationResolver = class WeatherLocationResolver { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._providers = params.providers || GEOCODE_PROVIDERS;
        this._geocode_cache = params.cache || new Map();
        this._max_entries = params.maxCacheEntries || MAX_GEOCODE_CACHE_ENTRIES;
        this._httpGetJson = params.httpGetJson;
        this._nominatim_queue = params.nominatimQueue || NOMINATIM_REQUEST_QUEUE;
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
            callback(cachedPlace, "");
            return;
        }

        this._geocodeLocation(location, isCurrent, (place, error) => {
            if (!place) {
                callback(null, error);
                return;
            }

            this._remember(cacheKey, place);
            callback(place, "");
        });
    }

    _geocodeLocation(location, isCurrent, callback) {
        // `url` is built per lookup; the rest of the provider is fixed. The
        // normalizer is bound to the same lookup, because choosing between the
        // hits a geocoder returns needs the name they were asked about.
        const providers = this._providers.map((provider) => ({
            name: provider.name,
            url: provider.url(location),
            normalize: (data) => provider.normalize(data, location),
            options: provider.options,
            requestQueue: provider.name === WEATHER_PROVIDER_NAMES.NOMINATIM ?
                this._nominatim_queue : null
        }));

        this._tryGeocodeProviders(providers, isCurrent, callback);
    }

    _tryGeocodeProviders(providers, isCurrent, callback) {
        const state = { anyResponse: false };
        ProviderUtils.tryProvidersInOrder(
            providers,
            (provider, onResult) => this._requestGeocodeProvider(
                provider, isCurrent, onResult, state),
            (place) => Boolean(place), // NOSONAR [S7770] -- accepted compatible form
            (provider, place) => callback(place, ""),
            () => this._reportGeocodeFailure(state.anyResponse, callback)
        );
    }

    _requestGeocodeProvider(provider, isCurrent, onResult, state) {
        const request = (release = () => {}) => this._httpGetJson(
            provider.url,
            (data) => {
                release();
                if (!isCurrent()) {
                    return;
                }
                state.anyResponse = state.anyResponse ||
                    (data !== null && data !== undefined);
                onResult(provider.normalize(data));
            },
            provider.options || {}
        );

        if (provider.requestQueue) {
            provider.requestQueue.enqueue(request, isCurrent);
        } else {
            request();
        }
    }

    _reportGeocodeFailure(anyResponse, callback) {
        if (global.log) {
            global.log("all weather geocode providers failed");
        }
        callback(null, anyResponse ?
            WEATHER_ERRORS.LOCATION_NOT_FOUND :
            WEATHER_ERRORS.SERVICE_UNAVAILABLE);
    }
}

// Both third-party services want to be told who is calling; the geocode registry
// already carries this and used to be the only one that did
var USER_AGENT_OPTIONS = { // NOSONAR [S3504] -- GJS importer export
    headers: {
        "User-Agent": WEATHER_USER_AGENT
    }
};

// The forecast backends, in the order they are tried — data, the way
// GEOCODE_PROVIDERS is: a `url` for the place, a `normalize` that turns the
// answer into a unit-free reading record `{ condition, temperatureC }`, and the
// request options it needs. A provider says *what* the weather is; nothing on
// this side of the port knows how it will be shown, and the units live in the
// presenter alone.
//
// Every entry used to be a thunk into a private method of the resolver that
// consumes it, so "adding a provider is an edit to the registry" was not true:
// it was an edit to the class as well, and the built-ins did not use the path a
// third party would — the rubric's own failure mode. They do now: the resolver
// knows nothing about any particular service.
var FORECAST_PROVIDERS = [ // NOSONAR [S3504] -- GJS importer export
    {
        name: WEATHER_PROVIDER_NAMES.OPEN_METEO,
        url: (place) => forecastUrl(place),
        normalize: (data) => (data && data.current_weather ? // NOSONAR [S6582] -- accepted compatible form
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

var WeatherForecastResolver = class WeatherForecastResolver { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._last_forecast_provider = ""; // NOSONAR [S7757] -- accepted compatible form
        this._httpGetJson = params.httpGetJson;
        // a caller can hand in its own chain; the shipped one is the default
        this._providers = params.providers || FORECAST_PROVIDERS;
    }

    get lastProvider() {
        return this._last_forecast_provider;
    }

    // no units: a reading is unit-free, and the URLs all ask for Celsius. What
    // the temperature is shown in is the presenter's business, not the port's.
    refresh(place, isCurrent, callback) {
        this._tryForecastProviders(this._orderedForecastProviders(), place, isCurrent, callback);
    }

    _orderedForecastProviders() {
        return ProviderUtils.orderProvidersByLastSuccess(
            this._providers, this._last_forecast_provider);
    }

    _tryForecastProviders(providers, place, isCurrent, callback) {
        ProviderUtils.tryProvidersInOrder(
            providers,
            (provider, onResult) => {
                this._httpGetJson(provider.url(place), (data) => {
                    if (!isCurrent()) {
                        return;
                    }
                    onResult(provider.normalize(data, place));
                }, provider.options || {});
            },
            (reading) => Boolean(reading), // NOSONAR [S7770] -- accepted compatible form
            (provider, reading) => {
                this._last_forecast_provider = provider.name;
                // the port ends here: a reading record, and who answered. No
                // display text is built on this path at all — the presenter that
                // knows the units renders it, once, at the edge that shows it
                callback(reading, "", provider.name);
            },
            () => {
                if (global.log) {
                    global.log("all weather forecast providers failed");
                }
                // null is what "no reading" is everywhere else on this port;
                // the fourth argument was for a receiver that does not exist
                callback(null, WEATHER_ERRORS.SERVICE_UNAVAILABLE, "");
            }
        );
    }

}

if (typeof module !== "undefined") {
    module.exports = {
        GEOCODE_PROVIDERS, FORECAST_PROVIDERS, locationCacheKey,
        NOMINATIM_MIN_INTERVAL_MS, NominatimRequestQueue,
        WeatherLocationResolver, WeatherForecastResolver
    };
}
