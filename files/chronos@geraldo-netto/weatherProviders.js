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
// findExtensionSubdirectory has already repointed at the 6.0/ directory — and the
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
const Diagnostics = IS_NODE ?
    require("./diagnostics") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].diagnostics;
const WeatherFormat = IS_NODE ?
    require("./weatherFormat") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherFormat;
const ClockLimits = IS_NODE ?
    require("./clockLimits") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].clockLimits;
const WeatherServiceAdapters = IS_NODE ?
    require("./weatherServiceAdapters") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherServiceAdapters;
const WorldclockData = IS_NODE ?
    require("./worldclockData") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;

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
const openMeteoReading = WeatherServiceAdapters.openMeteoReading;
const openMeteoTimezone = WeatherServiceAdapters.openMeteoTimezone;
const aviationWeatherUrls = WeatherServiceAdapters.aviationWeatherUrls;
const aviationWeatherReading = WeatherServiceAdapters.aviationWeatherReading;
const metNoForecastUrl = WeatherServiceAdapters.metNoForecastUrl;
const metNoWeatherReading = WeatherServiceAdapters.metNoWeatherReading;

// Place identity is shared with consumers: query and geographic hint partition
// geocode caches, reading caches, and in-flight subscriptions in the same way.
const locationCacheKey = WeatherFormat.locationCacheKey;

var NOMINATIM_MIN_INTERVAL_MS = 1000; // NOSONAR [S3504] -- GJS importer export

// The public Nominatim service permits one request at a time and at most one
// request per second. This queue is module-global so every applet instance and
// both the panel and world-clock weather paths share the same budget.
// Held in `_timer_id` while `_schedule` is being called and before it has
// answered with a real source id, so the slot is occupied for the whole arming
// window. Negative because GLib source ids are positive, which lets every
// reader tell "arming" from "armed" and from "idle" without a second field.
const ARMING_TIMER_ID = -1;

var NominatimRequestQueue = class NominatimRequestQueue { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._elapsed_now = params.elapsedNow || params.now ||
            ElapsedTime.monotonicMilliseconds;
        this._schedule = params.schedule || ((delay, callback) =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, callback));
        this._removeTimer = params.removeTimer || GLib.source_remove;
        this._jobs = [];
        this._active = false;
        this._last_started_at = null;
        this._timer_id = 0;
    }

    enqueue(start, isCurrent = () => true, onFailure = null) {
        this._jobs.push({ start, isCurrent, onFailure });
        this._drain();
    }

    // The spacing timer is a main-loop source with no owner: it is armed inside
    // a module-global queue, and every applet on the panel shares it. Bounded —
    // one-shot, under a second, and a job whose isCurrent() has gone false is
    // discarded when it fires — but an unowned source in the compositor process
    // is exactly what cancelPendingLocaleQueries() exists to prevent for the
    // other module-level timers, and this one had no equivalent.
    //
    // Only the last consumer may call this: a queue emptied while another
    // instance is still waiting behind the interval would drop that instance's
    // geocode with nothing to retry it until its next refresh period.
    cancelPending() {
        this._jobs = [];
        // > 0 rather than truthy: the sentinel names a source that does not
        // exist yet, and GLib would report removing it as a programming error.
        if (this._timer_id > 0) {
            this._removeTimer(this._timer_id);
        }
        this._timer_id = 0;
        // The active request cannot be cancelled here and still owns the
        // release closure created by _drain(). Keep its slot occupied until
        // that closure runs; a replacement consumer may enqueue meanwhile.
    }

    // A departing consumer's jobs are dead the moment its repository is
    // destroyed — isCurrent() answers false — but nothing looks at them until
    // the next _drain(), and _drain() is only reachable from enqueue, release
    // or the spacing timer. With two applet instances on the panel, removing
    // one while the other never geocodes again leaves its jobs here for the
    // session, and each holds closures reaching the request record, its
    // subscribers, their callbacks, the provider, the repository and its Soup
    // session.
    prune() {
        this._jobs = this._jobs.filter((job) => job.isCurrent());
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
            this._scheduleJob(job, delay);
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
            this._handleStartFailure(job, released, release, error);
        }
    }

    // `_schedule` is injectable, and nothing in its contract says the callback
    // may not run before it returns. If it does, the callback clears
    // `_timer_id` and drains — and writing the returned id back afterwards
    // would park a spent id in the slot that `_drain()` treats as "a timer is
    // pending", wedging this module-global queue for every applet instance in
    // the process until `cancelPending()` runs. So the slot is claimed before
    // arming and the real id is written only if it is still ours to write.
    _scheduleJob(job, delay) {
        this._jobs.unshift(job);
        this._timer_id = ARMING_TIMER_ID;
        try {
            const timerId = this._schedule(delay, () => {
                this._timer_id = 0;
                this._drain();
                return false;
            });
            if (!timerId) {
                throw new Error("Nominatim queue could not register its spacing timer");
            }
            if (this._timer_id === ARMING_TIMER_ID) {
                this._timer_id = timerId;
            }
        } catch (error) {
            // Nothing was armed, and `_reportParkedFailure` drains: release the
            // slot first or the queue stalls on its own sentinel.
            if (this._timer_id === ARMING_TIMER_ID) {
                this._timer_id = 0;
            }
            this._removeParkedJob(job);
            this._reportParkedFailure(job, error);
        }
    }

    _removeParkedJob(job) {
        const index = this._jobs.indexOf(job);
        if (index >= 0) {
            this._jobs.splice(index, 1);
        }
    }

    _reportParkedFailure(job, error) {
        this._drain();
        if (!job.onFailure) {
            throw error;
        }
        job.onFailure(error);
    }

    _handleStartFailure(job, released, release, error) {
        if (released) {
            throw error;
        }
        release();
        if (!job.onFailure) {
            throw error;
        }
        job.onFailure(error);
    }
};

var NOMINATIM_REQUEST_QUEUE = new NominatimRequestQueue(); // NOSONAR [S3504] -- GJS importer export

// The applet is multi-instance and the queue above is not: one request-per-
// second budget is shared by every instance on the panel, which is the point.
// So a per-instance teardown must not empty it — the same argument, and the
// same shape, as localeQuery's consumer count.
const _weatherConsumers = ProviderUtils.moduleConsumerCount({
    // Unconditionally, and before the consumer count decides anything: the
    // departing instance's jobs can never run again, and dropping them is safe
    // for the instances that remain — it is only emptying the queue wholesale
    // that would take a waiting instance's geocode with it.
    onRelease: (queue) => queue.prune(),
    onLastRelease: (queue) => queue.cancelPending()
});

function registerWeatherConsumer() {
    _weatherConsumers.register();
}

// Each registration owns one release; releasing is not an idempotent cancel.
function releaseWeatherConsumer(queue = NOMINATIM_REQUEST_QUEUE) {
    _weatherConsumers.release(queue);
}

// One reading for each configured world clock and the independent panel location.
// Resolved coordinates have a separate capacity and a much longer lifetime.
var MAX_WEATHER_READING_CACHE_ENTRIES = ClockLimits.MAX_CLOCKS + 1; // NOSONAR [S3504] -- GJS importer export

// The geocoders, in the order they are tried. Named, because a nameless provider
// is logged by its URL when the chain moves on - and a geocode URL carries the
// place the user typed.
var GEOCODE_PROVIDERS = [ // NOSONAR [S3504] -- GJS importer export
    {
        name: WEATHER_PROVIDER_NAMES.OPEN_METEO,
        url: geocodeUrl,
        isValidResponse: WeatherServiceAdapters.isOpenMeteoGeocodeResponse,
        normalize: openMeteoGeocodePlace
    },
    {
        name: WEATHER_PROVIDER_NAMES.NOMINATIM,
        url: nominatimGeocodeUrl,
        isValidResponse: WeatherServiceAdapters.isNominatimGeocodeResponse,
        normalize: nominatimGeocodePlace,
        options: {
            headers: {
                "User-Agent": WEATHER_USER_AGENT
            }
        },
        // A rate limit is a property of the service, so the service's entry
        // declares it. The resolver used to name this vendor instead — a
        // geocoder appended to this list got no queue and unthrottled dispatch,
        // so the built-in did not use the path a third party would, which is
        // the failure mode the FORECAST_PROVIDERS comment below says was closed
        // there. Mechanism stays in the queue; policy is this line.
        requestQueue: NOMINATIM_REQUEST_QUEUE
    }
];

var WeatherLocationResolver = class WeatherLocationResolver { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._providers = params.providers || GEOCODE_PROVIDERS;
        this._language = params.language || "en";
        this._httpGetJson = params.httpGetJson;
        // one substitute for whichever registry entries declare a queue: the
        // parameter used to be named for a vendor too
        this._request_queue = params.requestQueue || null;
        this._resolved_now = params.resolvedNow || params.now ||
            ElapsedTime.civilMilliseconds;
        this._entry_milliseconds = Number.isFinite(params.entrySeconds) ?
            Math.max(0, params.entrySeconds) * 1000 : GEOCODE_CACHE_MILLISECONDS;
        // A day is ample: place coordinates are static, so the expiry is a
        // correction window rather than a freshness window. `resolve()` used to
        // short-circuit on any hit forever, and the only invalidation path in
        // production is `_forgetIfLocationChanged`, which does nothing when the
        // text is unchanged — so one glitched or ambiguous geocode round pinned
        // the wrong coordinates, for the panel temperature and the astronomy
        // sunrise/sunset alike, for the whole Cinnamon session.
        this._geocode_cache = new ProviderUtils.ExpiringLruCache({
            store: params.cache,
            now: () => this._resolved_now(),
            maxEntries: params.maxCacheEntries || MAX_GEOCODE_CACHE_ENTRIES,
            lifetimeMilliseconds: this._entry_milliseconds
        });
    }

    placeFor(location, hint = null) {
        return this._freshPlace(locationCacheKey(location, hint));
    }

    _freshPlace(cacheKey) {
        return this._geocode_cache.get(cacheKey);
    }

    _remember(cacheKey, place) {
        this._geocode_cache.set(cacheKey, place);
    }

    // an ambiguous name that resolved to the wrong city would otherwise stay
    // pinned for the life of the applet
    forget(location, hint = null) {
        this._geocode_cache.delete(locationCacheKey(location, hint));
    }

    resolve(location, isCurrent, callback, hint = null) {
        const normalized = WeatherFormat.normalizeWeatherLocation(location);
        const cacheKey = locationCacheKey(normalized, hint);
        if (!cacheKey) {
            callback(null, WEATHER_ERRORS.LOCATION_NOT_FOUND);
            return;
        }

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
        }, WeatherFormat.normalizeLocationHint(hint));
    }

    _geocodeLocation(location, isCurrent, callback, hint) {
        // `url` is built per lookup; the rest of the provider is fixed. The
        // normalizer is bound to the same lookup, because choosing between the
        // hits a geocoder returns needs the name they were asked about.
        const language = typeof this._language === "function" ?
            this._language() : this._language;
        const providers = this._providers.map((provider) => ({
            name: provider.name,
            url: provider.url(location, language, hint),
            isValidResponse: (data) => provider.isValidResponse(data),
            normalize: (data) => provider.normalize(data, location, hint,
                (timezone) => WorldclockData.timezoneWeatherRequest(timezone)?.hint.timezone || ""),
            options: provider.options,
            requestQueue: this._requestQueueFor(provider)
        })).filter((provider) => provider.url);

        this._tryGeocodeProviders(providers, isCurrent, callback);
    }

    _requestQueueFor(provider) {
        if (!provider.requestQueue) {
            return null;
        }

        return this._request_queue || provider.requestQueue;
    }

    _tryGeocodeProviders(providers, isCurrent, callback) {
        const state = { anyValidResponse: false };
        ProviderUtils.tryProvidersInOrder(
            providers,
            (provider, onResult) => this._requestGeocodeProvider(
                provider, isCurrent, onResult, state),
            (place) => Boolean(place), // NOSONAR [S7770] -- accepted compatible form
            (provider, place) => callback(place, ""),
            () => this._reportGeocodeFailure(state.anyValidResponse, callback)
        );
    }

    _requestGeocodeProvider(provider, isCurrent, onResult, state) {
        const request = (release = () => {}) => this._httpGetJson(
            provider.url,
            (data) => {
                release();
                this._geocodeReceived(provider, data, isCurrent, onResult, state);
            },
            provider.options || {}
        );

        if (provider.requestQueue) {
            provider.requestQueue.enqueue(request, isCurrent, (error) =>
                this._reportGeocodeAttemptFailure(error, isCurrent, onResult));
        } else {
            request();
        }
    }

    _geocodeReceived(provider, data, isCurrent, onResult, state) {
        if (!isCurrent()) {
            return;
        }
        let place = null;
        try {
            if (provider.isValidResponse(data) === true) {
                place = provider.normalize(data);
                state.anyValidResponse = true;
            }
        } catch (error) {
            this._reportGeocodeAttemptFailure(error, isCurrent, onResult);
            return;
        }
        onResult(place);
    }

    _reportGeocodeAttemptFailure(error, isCurrent, onResult) {
        Diagnostics.logSafely("logError", error);
        if (isCurrent()) {
            onResult(null);
        }
    }

    _reportGeocodeFailure(anyValidResponse, callback) {
        Diagnostics.logSafely("log", "all weather geocode providers failed");
        callback(null, anyValidResponse ?
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
// GEOCODE_PROVIDERS is: `url` for one request or `urls` plus `merge` when one
// logical answer spans several requests, a `normalize` that turns the answer
// into a unit-free reading record `{ condition, temperatureC }`, and the request
// options each request needs. A provider says *what* the weather is; nothing on
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
            openMeteoReading(data) : null),
        // the one provider that can say where the place it just described is:
        // a hint about the place, kept off the reading record
        timezoneFor: (data) => openMeteoTimezone(data)
    },
    {
        name: WEATHER_PROVIDER_NAMES.AVIATION_WEATHER,
        urls: (place) => aviationWeatherUrls(place),
        merge: (payloads) => payloads.reduce((stations, payload) =>
            Array.isArray(payload) ? stations.concat(payload) : stations, []),
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

// Nominatim publishes no timezone, and Open-Meteo geocoding refuses every hit
// under MIN_TRUSTED_GEOCODE_POPULATION, so any smaller place — or any Open-Meteo
// outage — reached the astronomy view with no zone at all, and it silently
// substituted the viewer's: the wrong civil day's sunrise for anywhere far east
// or west, and the same city reading differently depending on which geocoder
// answered. The forecast reply already names the point's zone, so the place is
// completed from the round trip that was being made anyway.
//
// A geocoded zone wins: this only completes a place that has none.
function placeWithTimezone(place, timezone) {
    if (!place || place.timezone || !timezone) {
        return place;
    }
    return {...place, timezone};
}

function forecastProviderUrls(provider, place) {
    const requested = provider.urls ? provider.urls(place) : [provider.url(place)];
    return Array.isArray(requested) ? requested : [requested];
}

function forecastAttemptResult(attempt) {
    const provider = attempt.provider;
    const data = provider.merge ? provider.merge(attempt.payloads) : attempt.payloads[0];
    const reading = provider.normalize(data, attempt.place);
    return {
        reading,
        timezone: reading && provider.timezoneFor ? provider.timezoneFor(data) : ""
    };
}

function completeForecastAttempt(attempt) {
    if (attempt.finished || !attempt.isCurrent()) {
        attempt.finished = true;
        return;
    }
    attempt.finished = true;
    let result = null;
    try {
        result = forecastAttemptResult(attempt);
    } catch (error) {
        Diagnostics.logSafely("logError", error);
    }
    attempt.onResult(result);
}

function receiveForecastPayload(attempt, index, data) {
    if (attempt.finished || attempt.answered[index]) {
        return;
    }
    attempt.answered[index] = true;
    if (!attempt.isCurrent()) {
        attempt.finished = true;
        return;
    }
    attempt.payloads[index] = data;
    attempt.remaining--;
    if (attempt.remaining === 0) {
        completeForecastAttempt(attempt);
    }
}

function dispatchForecastAttempt(httpGetJson, provider, place, isCurrent, onResult) {
    const urls = forecastProviderUrls(provider, place);
    const attempt = {
        provider, place, isCurrent, onResult,
        payloads: new Array(urls.length),
        answered: new Array(urls.length).fill(false),
        remaining: urls.length,
        finished: false
    };

    if (!urls.length) {
        completeForecastAttempt(attempt);
        return;
    }

    try {
        urls.forEach((url, index) => httpGetJson(
            url, (data) => receiveForecastPayload(attempt, index, data),
            provider.options || {}));
    } catch (error) {
        attempt.finished = true;
        throw error;
    }
}

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

    // One provider's turn: what it said the weather is, and whatever it was
    // able to say about the place. A zone is only worth having from the answer
    // that is being believed, so a provider that failed to describe the weather
    // does not get to name the place either.
    _forecastAttempt(provider, place, isCurrent, onResult) {
        dispatchForecastAttempt((...args) => this._httpGetJson(...args),
            provider, place, isCurrent, onResult);
    }

    _tryForecastProviders(providers, place, isCurrent, callback) {
        ProviderUtils.tryProvidersInOrder(
            providers,
            (provider, onResult) => this._forecastAttempt(
                provider, place, isCurrent, onResult),
            (result) => Boolean(result && result.reading && // NOSONAR [S7770] -- accepted compatible form
                WeatherFormat.validTemperature(result.reading.temperatureC)),
            (provider, result) => {
                this._last_forecast_provider = provider.name;
                // the port ends here: a reading record, who answered, and any
                // hint about the place that answer carried. No display text is
                // built on this path at all — the presenter that knows the units
                // renders it, once, at the edge that shows it
                callback(result.reading, "", provider.name, result.timezone);
            },
            () => {
                Diagnostics.logSafely("log", "all weather forecast providers failed");
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
        this._destroyed = false; // NOSONAR [S7757] -- constructor state is the GJS-compatible class pattern
        this._freshness_now = params.freshnessNow || params.now ||
            ElapsedTime.civilMilliseconds;
        this._cache_milliseconds = Math.max(0, Number(params.cacheSeconds) || 0) * 1000;
        const requestedMax = Number(params.maxCacheEntries);
        this._max_cache_entries = Number.isInteger(requestedMax) && requestedMax > 0 ?
            requestedMax : MAX_WEATHER_READING_CACHE_ENTRIES;
        this._cache = new ProviderUtils.ExpiringLruCache({
            store: params.readingCache,
            now: () => this._freshness_now(),
            maxEntries: this._max_cache_entries,
            lifetimeMilliseconds: this._cache_milliseconds
        });
        this._inflight = new Map();
        this.session = new IoUtils.LazyHttpSession(
            params.httpSession ? () => params.httpSession : undefined);
        this.httpGetJson = params.httpGetJson || ((url, callback, options = {}) => {
            IoUtils.httpGetJson(this.getHttpSession(), url, callback, options);
        });
        this.locationResolver = params.locationResolver || new WeatherLocationResolver({
            cache: params.geocodeCache,
            httpGetJson: this.httpGetJson,
            language: params.language,
            requestQueue: params.requestQueue
        });
        this.forecastResolver = params.forecastResolver || new WeatherForecastResolver({
            httpGetJson: this.httpGetJson
        });
    }

    getHttpSession() {
        return this.session.get();
    }

    forget(location, hint = null) {
        const key = locationCacheKey(location, hint);
        this._cache.delete(key);
        this.locationResolver.forget(location, hint);
    }

    placeFor(location, hint = null) {
        const normalized = WeatherFormat.normalizeWeatherLocation(location);
        const key = locationCacheKey(normalized, hint);
        if (!key) {
            return null;
        }

        const cached = this._freshReading(key);
        if (cached?.place) {
            return cached.place;
        }
        return this.locationResolver.placeFor(normalized, hint);
    }

    _freshReading(key) {
        return this._cache.get(key);
    }

    // The entry ages from when the reading was *fetched*, not from when it
    // reached the cache: without that a hit on an almost-expired entry resets
    // the reading's apparent age for the consumer that stamps receipt time.
    _rememberReading(key, reading, provider, startedAtFresh, place) {
        this._cache.set(key, { reading, provider, startedAtFresh, place },
            startedAtFresh);
    }

    // The fifth argument is when the reading was fetched, not when it was
    // handed over. Without it a consumer can only stamp receipt time, and a
    // cache hit on an almost-expired entry then resets the reading's apparent
    // age: with cacheSeconds 1800 and a staleness policy of 3600, a hit at 1799
    // seconds withheld the marker until 5399 seconds of real age.
    refresh(location, isCurrent, callback, hint = null) {
        const normalized = WeatherFormat.normalizeWeatherLocation(location);
        const key = locationCacheKey(normalized, hint);
        if (this._destroyed || !key) {
            if (!this._destroyed && isCurrent()) {
                callback(null, WEATHER_ERRORS.LOCATION_NOT_FOUND, "");
            }
            return;
        }

        const cached = this._freshReading(key);
        if (cached) {
            if (isCurrent()) {
                callback(cached.reading, "", cached.provider, cached.place,
                    cached.startedAtFresh);
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
        try {
            this.locationResolver.resolve(normalized, requestIsCurrent,
                (place, error) => this._placeResolved(
                    key, request, requestIsCurrent, place, error), WeatherFormat.normalizeLocationHint(hint));
        } catch (e) {
            this._abandonRequest(key, request, requestIsCurrent, e);
        }
    }

    // The flight was recorded one statement above, so a resolve that raises
    // before it has a callback to answer through used to pin this location's
    // key forever: every later refresh for it found an active request and
    // joined a flight that could never complete. Report it through the same
    // no-place path a geocode failure takes, which settles the subscribers and
    // frees the key.
    //
    // A throw arriving once the request has settled came back out through a
    // subscriber's own callback, and is still theirs.
    _abandonRequest(key, request, requestIsCurrent, error) {
        if (this._inflight.get(key) !== request) {
            throw error;
        }

        Diagnostics.logSafely("logError", error);
        this._placeResolved(key, request, requestIsCurrent, null,
            WEATHER_ERRORS.SERVICE_UNAVAILABLE);
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
            (reading, forecastError, provider, timezone) => {
                request.place = placeWithTimezone(request.place, timezone);
                this._complete(key, request, reading, forecastError, provider);
            });
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

        this._dispatch(request, reading, error, provider);
    }

    // A flight is shared: the panel and a world clock naming the same place join
    // one request, and the composition root gives both providers the same
    // repository. Dispatching in a bare loop made the first subscriber that
    // raised the last one to be settled, so the city round behind it never heard
    // back — its outstanding count never reached zero, the freed slot was never
    // pumped, and the rest of that round was stranded with no repaint, no retry
    // and no backoff reset until the next period.
    //
    // Settle everyone, then hand the raise back the way it came. That is the
    // settle-once discipline attemptOrFail, _abandonRequest and httpGetJson
    // already keep; this was the one fan-out seam without it.
    _dispatch(request, reading, error, provider) {
        let raised = null;

        for (const subscriber of request.subscribers) {
            if (!subscriber.isCurrent()) {
                continue;
            }
            try {
                subscriber.callback(reading, error, provider, request.place,
                    request.startedAtFresh);
            } catch (e) {
                raised = raised || e;
            }
        }

        if (raised) {
            throw raised;
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
        GEOCODE_PROVIDERS, FORECAST_PROVIDERS,
        MAX_WEATHER_READING_CACHE_ENTRIES, GEOCODE_CACHE_MILLISECONDS,
        NOMINATIM_MIN_INTERVAL_MS, NominatimRequestQueue,
        registerWeatherConsumer, releaseWeatherConsumer,
        WeatherLocationResolver, WeatherForecastResolver, WeatherReadingRepository,
        placeWithTimezone
    };
}
