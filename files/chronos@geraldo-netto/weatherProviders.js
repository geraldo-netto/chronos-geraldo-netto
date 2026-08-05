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
const ElapsedTime = IS_NODE ?
    require("./elapsedTime") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].elapsedTime;
const IoUtils = IS_NODE ?
    require("./ioUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].ioUtils;
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
// How long a resolved place is believed. Coordinates do not move, so this is
// not a freshness window — it is the window in which a wrong or transient
// resolution can correct itself without the user having to type a different
// city and type this one back.
var GEOCODE_CACHE_MILLISECONDS = 24 * 60 * 60 * 1000; // NOSONAR [S3504] -- GJS importer export
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
    return WeatherFormat.normalizeWeatherLocation(location).toLowerCase();
}

var NOMINATIM_MIN_INTERVAL_MS = 1000; // NOSONAR [S3504] -- GJS importer export

// The public Nominatim service permits one request at a time and at most one
// request per second. This queue is module-global so every applet instance and
// both the panel and world-clock weather paths share the same budget.
var NominatimRequestQueue = class NominatimRequestQueue { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._elapsed_now = params.elapsedNow || params.now ||
            ElapsedTime.monotonicMilliseconds;
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

        const measuredElapsed = this._last_started_at === null ?
            NOMINATIM_MIN_INTERVAL_MS : this._elapsed_now() - this._last_started_at;
        // Monotonic time cannot move backwards, but an injected or broken port
        // must still delay by at most one normal interval, never by the size of
        // a civil-clock correction.
        const elapsed = Number.isFinite(measuredElapsed) && measuredElapsed >= 0 ?
            measuredElapsed : 0;
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
        this._last_started_at = this._elapsed_now();
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
var MAX_WEATHER_READING_CACHE_ENTRIES = WeatherFormat.MAX_GEOCODE_CACHE_ENTRIES; // NOSONAR [S3504] -- GJS importer export

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
        this._resolved_now = params.resolvedNow || params.now ||
            ElapsedTime.civilMilliseconds;
        this._entry_milliseconds = Number.isFinite(params.entrySeconds) ?
            Math.max(0, params.entrySeconds) * 1000 : GEOCODE_CACHE_MILLISECONDS;
    }

    placeFor(location) {
        return this._freshPlace(locationCacheKey(location));
    }

    // The sibling reading cache expires — `_freshReading` drops anything past
    // `cacheSeconds` — so a stale *reading* self-corrects within the refresh
    // period while a stale *place* never did: `resolve()` short-circuited on any
    // hit forever, and the only invalidation path in production is
    // `_forgetIfLocationChanged`, which does nothing when the text is unchanged.
    // One glitched or ambiguous geocode round therefore pinned the wrong
    // coordinates — for the panel temperature and the astronomy sunrise/sunset
    // alike — for the whole Cinnamon session, with no timer and no retry.
    //
    // A day is ample: place coordinates are static, so this is a correction
    // window rather than a freshness window.
    _freshPlace(cacheKey) {
        const entry = this._geocode_cache.get(cacheKey);
        if (!entry) {
            return null;
        }

        const age = this._resolved_now() - entry.resolvedAt;
        if (!Number.isFinite(age) || age < 0 || age >= this._entry_milliseconds) {
            this._geocode_cache.delete(cacheKey);
            return null;
        }

        return entry.place;
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

        this._geocode_cache.set(cacheKey, { place, resolvedAt: this._resolved_now() });
    }

    // an ambiguous name that resolved to the wrong city would otherwise stay
    // pinned for the life of the applet
    forget(location) {
        this._geocode_cache.delete(locationCacheKey(location));
    }

    resolve(location, isCurrent, callback) {
        const normalized = WeatherFormat.normalizeWeatherLocation(location);
        if (!normalized) {
            callback(null, WEATHER_ERRORS.LOCATION_NOT_FOUND);
            return;
        }

        const cacheKey = locationCacheKey(normalized);
        const cachedPlace = this._freshPlace(cacheKey);
        if (cachedPlace) {
            callback(cachedPlace, "");
            return;
        }

        this._geocodeLocation(normalized, isCurrent, (place, error) => {
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

// One applet has two weather consumers: the panel and the world-clock rows.
// Their refresh clocks and last-good display state are deliberately separate,
// but resolving a place and reading its forecast are the same data operation.
// This repository is that operation's single owner. A shared instance at the
// composition root means an overlapping panel/city request joins the same
// flight, and a consumer arriving just after a synchronous completion reads the
// same result for the rest of that refresh period.
var WeatherReadingRepository = class WeatherReadingRepository { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._destroyed = false;
        this._freshness_now = params.freshnessNow || params.now ||
            ElapsedTime.civilMilliseconds;
        this._cache_milliseconds = Math.max(0, Number(params.cacheSeconds) || 0) * 1000;
        this._cache = params.readingCache || new Map();
        const requestedMax = Number(params.maxCacheEntries);
        this._max_cache_entries = Number.isInteger(requestedMax) && requestedMax > 0 ?
            requestedMax : MAX_WEATHER_READING_CACHE_ENTRIES;
        this._inflight = new Map();
        this.session = new IoUtils.LazyHttpSession(
            params.httpSession ? () => params.httpSession : undefined);
        this.httpGetJson = params.httpGetJson || ((url, callback, options = {}) => {
            IoUtils.httpGetJson(this.getHttpSession(), url, callback, options);
        });
        this.locationResolver = params.locationResolver || new WeatherLocationResolver({
            cache: params.geocodeCache,
            httpGetJson: this.httpGetJson,
            nominatimQueue: params.nominatimQueue
        });
        this.forecastResolver = params.forecastResolver || new WeatherForecastResolver({
            httpGetJson: this.httpGetJson
        });
    }

    getHttpSession() {
        return this.session.get();
    }

    forget(location) {
        const key = locationCacheKey(location);
        this._cache.delete(key);
        this.locationResolver.forget(location);
    }

    placeFor(location) {
        const normalized = WeatherFormat.normalizeWeatherLocation(location);
        if (!normalized) {
            return null;
        }

        const cached = this._freshReading(locationCacheKey(normalized));
        if (cached && cached.place) {
            return cached.place;
        }
        return this.locationResolver.placeFor(normalized);
    }

    _freshReading(key) {
        const cached = this._cache.get(key);
        if (!cached || this._cache_milliseconds <= 0) {
            this._cache.delete(key);
            return null;
        }
        const age = this._freshness_now() - cached.startedAtFresh;
        if (!Number.isFinite(age) || age < 0 || age >= this._cache_milliseconds) {
            this._cache.delete(key);
            return null;
        }

        // Map iteration order is the LRU order. A cache hit becomes newest.
        this._cache.delete(key);
        this._cache.set(key, cached);
        return cached;
    }

    _rememberReading(key, reading, provider, startedAtFresh, place) {
        this._cache.delete(key);
        while (this._cache.size >= this._max_cache_entries) {
            const oldest = this._cache.keys().next();
            if (oldest.done) {
                break;
            }
            this._cache.delete(oldest.value);
        }
        this._cache.set(key, { reading, provider, startedAtFresh, place });
    }

    refresh(location, isCurrent, callback) {
        const normalized = WeatherFormat.normalizeWeatherLocation(location);
        if (this._destroyed || !normalized) {
            if (!this._destroyed && isCurrent()) {
                callback(null, WEATHER_ERRORS.LOCATION_NOT_FOUND, "");
            }
            return;
        }

        const key = locationCacheKey(normalized);
        const cached = this._freshReading(key);
        if (cached) {
            if (isCurrent()) {
                callback(cached.reading, "", cached.provider, cached.place);
            }
            return;
        }

        const subscriber = { isCurrent, callback };
        const active = this._inflight.get(key);
        if (active) {
            active.subscribers.push(subscriber);
            return;
        }

        const request = {
            startedAtFresh: this._freshness_now(),
            subscribers: [subscriber],
            place: null
        };
        this._inflight.set(key, request);
        // A consumer generation decides whether that subscriber still wants the
        // answer. The shared operation continues while any subscriber does: if
        // the panel changes location while a city still wants the old one, that
        // city must not inherit the panel's cancellation.
        const requestIsCurrent = () => this._requestIsCurrent(key, request);
        this.locationResolver.resolve(normalized, requestIsCurrent,
            (place, error) => this._placeResolved(
                key, request, requestIsCurrent, place, error));
    }

    _placeResolved(key, request, requestIsCurrent, place, error) {
        if (!requestIsCurrent()) {
            return;
        }
        if (!place) {
            this._complete(key, request, null, error, "");
            return;
        }
        request.place = place;
        this.forecastResolver.refresh(place, requestIsCurrent,
            (reading, forecastError, provider) => this._complete(
                key, request, reading, forecastError, provider));
    }

    _requestIsCurrent(key, request) {
        if (this._destroyed || this._inflight.get(key) !== request) {
            return false;
        }
        if (request.subscribers.some((subscriber) => subscriber.isCurrent())) {
            return true;
        }

        // No consumer can use the result. Remove the flight before the resolver
        // drops its callback, so a later request for the same key can start.
        this._inflight.delete(key);
        return false;
    }

    _complete(key, request, reading, error, provider) {
        if (this._destroyed || this._inflight.get(key) !== request) {
            return;
        }

        this._inflight.delete(key);
        if (reading && !error && this._cache_milliseconds > 0) {
            this._rememberReading(
                key, reading, provider, request.startedAtFresh, request.place);
        }

        for (const subscriber of request.subscribers) {
            if (subscriber.isCurrent()) {
                subscriber.callback(reading, error, provider, request.place);
            }
        }
    }

    destroy() {
        this._destroyed = true;
        this._inflight.clear();
        this._cache.clear();
        this.session.abort();
    }
}

if (typeof module !== "undefined") {
    module.exports = {
        GEOCODE_PROVIDERS, FORECAST_PROVIDERS, locationCacheKey,
        MAX_WEATHER_READING_CACHE_ENTRIES, GEOCODE_CACHE_MILLISECONDS,
        NOMINATIM_MIN_INTERVAL_MS, NominatimRequestQueue,
        WeatherLocationResolver, WeatherForecastResolver, WeatherReadingRepository
    };
}
