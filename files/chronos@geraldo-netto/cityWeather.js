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
const ElapsedTime = IS_NODE ?
    require("./elapsedTime") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].elapsedTime;
// the parts, not the barrel: requiring ./weather pulled in WeatherProvider — the
// panel provider this module is the twin of — and its Soup session, for a handful
// of constants, two resolvers and the refresh clock
// WeatherFormat, not Weather: `Weather` is weather.js, and the two were bound
// to that one name in files that sit side by side. weather.js flattens
// weatherFormat into its own namespace on the Node side, so names like
// RETRY_SECONDS and readingIsStale resolve under both bindings under `node
// test/` and only under weatherFormat in Cinnamon - moving a line between two
// adjacent files silently rebound every reference, and the suite could not see
// it for any of the flattened names.
const WeatherFormat = IS_NODE ?
    require("./weatherFormat") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherFormat;
const WeatherProviders = IS_NODE ?
    require("./weatherProviders") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherProviders;
const WeatherScheduler = IS_NODE ?
    require("./weatherScheduler") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherScheduler;
const ClockLimits = IS_NODE ?
    require("./clockLimits") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].clockLimits;

const locationCacheKey = WeatherFormat.locationCacheKey;

function compareCodeUnits(left, right) {
    if (left < right) {
        return -1;
    }
    return left > right ? 1 : 0;
}

// the world-clock cities are read on the same period as the panel weather:
// the popup is a glance at the time, not a forecast desk
const CITY_REFRESH_SECONDS = WeatherFormat.REFRESH_SECONDS;
// One city per clock, so this is the clock cap — not a number of its own. It
// used to be its own literal 8, a fifth copy of the cap and the one the parity
// test did not cover: raising the cap to 10 would have left clocks 9 and 10
// with a permanently blank temperature column, no error anywhere, and a green
// suite certifying it. A resolve plus a forecast per city is already sixteen
// requests, so nothing here fans out further.
const MAX_CITIES = ClockLimits.MAX_CLOCKS;
// The cities are geocoded through a small pool, not all at once. On an
// Open-Meteo outage every one falls through to Nominatim, whose usage policy
// caps a client at one request a second, so a cold-cache round of eight
// simultaneous fallbacks could get the user throttled. Two primary lookups may
// stay in flight; their Nominatim fallbacks pass through the process-wide queue.
const GEOCODE_CONCURRENCY = 2;
// a failed round is retried sooner than the next period, backing off toward
// it — the panel reading has worked this way all along
const CITY_RETRY_SECONDS = WeatherFormat.RETRY_SECONDS;
// The panel weather asks one place for one reading. The tooltip asks every
// configured world clock, so each city carries its own place lookup and its
// own last-good reading; a city that fails to geocode simply has no
// temperature and its row still shows the time.
var CityWeatherProvider = class CityWeatherProvider { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._destroyed = false; // NOSONAR [S7757] -- accepted compatible form
        this._generation = 0;
        this._errors = new Map();
        this._applied_signature = null;
        this._freshness_now = params.freshnessNow || params.now ||
            ElapsedTime.civilMilliseconds;
        this._refresh_seconds = params.refreshSeconds || CITY_REFRESH_SECONDS;
        // One store per provider, holding one last-good reading per city: the
        // panel provider this module is the twin of holds the same thing for
        // one place, and the four fields and the freshness derivation behind
        // them used to be written out here a second time.
        //
        // The horizon is derived from the period this provider actually
        // refreshes on, not from the module default: staleFor() used to read
        // the constant and ignore the injected period entirely, so a provider
        // refreshing every minute called an hour-old temperature current.
        this._reading_store = new WeatherFormat.WeatherReadingStore({
            freshnessNow: this._freshness_now,
            staleAfterSeconds: params.staleAfterSeconds,
            refreshSeconds: this._refresh_seconds
        });

        // The panel weather's scheduler, doing the same job for the cities: the
        // period, the exponential backoff with its cap and jitter, the attempt
        // ceiling and the timer teardown were all hand-rolled a second time
        // here — and the copy had drifted, losing the jitter and the attempt
        // cap. It differs from the panel's only in what counts as "something to
        // refresh", which is now a parameter.
        // `params` used to be the second argument to Object.assign here, so a
        // caller's keys won over these three. isActive is the one thing the
        // comment above names as distinguishing this scheduler from the panel's,
        // and a caller passing it silently replaced "weather on and at least one
        // city" with something else; retrySeconds went the same way.
        //
        // Named arguments rather than the whole bag, for the same reason: one
        // object was simultaneously the parameter set for this class, the
        // scheduler, the reading repository and the two resolvers behind it, so
        // adding a parameter to any one of the three files changed the meaning
        // of a call to the other two and nothing checked it.
        this._scheduler = params.scheduler || new WeatherScheduler.WeatherRefreshScheduler({
            refreshSeconds: this._refresh_seconds,
            retrySeconds: CITY_RETRY_SECONDS,
            isActive: (settings) =>
                Boolean(this._active(settings) && this._cities(settings).length),
            random: params.random,
            scheduleTimer: params.scheduleTimer,
            scheduleDebounceTimer: params.scheduleDebounceTimer,
            removeTimer: params.removeTimer,
            debounceMs: params.debounceMs
        });

        this._reading_repository = params.readingRepository ||
            new WeatherProviders.WeatherReadingRepository({
                // the repository's own collaborators, named: it reaches two
                // resolvers and an HTTP session behind them. cacheSeconds is
                // forwarded rather than defaulted: a provider that owns its
                // repository has no second consumer to share readings with, and
                // giving it one here would change what a failed round sees.
                cacheSeconds: params.cacheSeconds,
                locationResolver: params.locationResolver,
                forecastResolver: params.forecastResolver,
                httpSession: params.httpSession,
                httpGetJson: params.httpGetJson,
                geocodeCache: params.geocodeCache,
                requestQueue: params.requestQueue,
                freshnessNow: params.freshnessNow,
                now: params.now
            });
        this._owns_reading_repository = !params.readingRepository;
        // "always online" is the pre-monitor behavior; the composition root
        // injects the real Gio.NetworkMonitor-backed answer
        this._isOnline = params.isOnline || (() => true);
        this._retry_ceiling_reported = false;
    }

    // `city` is the geocoded city — what the reading is *of* — and not the clock's
    // label, which is the user's own name for the row and is not unique.
    //
    // the readings outlive a refresh: a city that failed this round keeps the
    // temperature it last had rather than blinking out of the tooltip. The
    // reading is the unit-free record { condition, temperatureC }; the tooltip
    // renders it in the user's unit.
    recordFor(city) {
        const key = this._readingKey(city);
        return key ? this._reading_store.recordFor(key) : null;
    }

    providerFor(city) {
        const key = this._readingKey(city);
        return key ? this._reading_store.providerFor(key) : "";
    }

    errorFor(city) {
        if (typeof city !== "string" || !city.trim()) {
            return "";
        }
        return this._errors.get(locationCacheKey(city)) || "";
    }

    _setError(city, error) {
        const key = locationCacheKey(city);
        const next = error || "";
        const previous = this._errors.get(key) || "";
        if (next === previous) {
            return false;
        }
        if (next) {
            this._errors.set(key, next);
        } else {
            this._errors.delete(key);
        }
        return true;
    }

    // ...but a reading nobody has managed to refresh for two whole periods is
    // not the weather any more, and saying so is the difference between a
    // temperature and a temperature from this morning
    staleFor(city, now = this._freshness_now()) {
        const key = this._readingKey(city);
        return key ? this._reading_store.isStale(key, now) : false;
    }

    _readingKey(city) {
        if (typeof city !== "string" || !city.trim()) {
            return "";
        }

        return locationCacheKey(city);
    }

    stop() {
        this._generation++;
        this._scheduler.stop();
    }

    // The panel reading retries a failed refresh instead of waiting out the
    // whole period; the cities used to drop the failure on the floor, so a city
    // that failed to read kept yesterday's temperature until something else
    // happened to reschedule it — or forever, if the network was down at every
    // tick. The backoff, its ceiling and its jitter are the scheduler's.
    _retry(settings, callback) {
        if (this._scheduler.retry(() => this.refresh(settings, callback))) {
            // the budget is live again after a recovery, so the next time it
            // runs out is news again
            this._retry_ceiling_reported = false;
            return;
        }

        // The scheduler refused: either weather is off, or the budget is spent
        // and the periodic timer is the schedule from here. Only the second is
        // worth a line, and only the first time it happens.
        if (!this._scheduler.retriesExhausted() || this._retry_ceiling_reported) {
            return;
        }
        this._retry_ceiling_reported = true;
        if (global.log) {
            global.log("city weather: still failing after " +
                WeatherFormat.MAX_RETRY_ATTEMPTS +
                " attempts; falling back to the normal refresh period");
        }
    }

    destroy() {
        this._destroyed = true;
        this.stop();
        this._reading_store.clear();
        this._errors.clear();

        if (this._owns_reading_repository) {
            this._reading_repository.destroy();
        }
    }

    // What the cities are read from: the clock list, and whether weather is on at
    // all. The panel's weather location is not in here — it is a different place,
    // asked a different question. Nor is the unit: the readings are unit-free
    // records now, so switching °C to °F re-renders the tooltip from what is
    // already held instead of geocoding and refetching every city again.
    _signature(settings) {
        const queries = this._cities(settings)
            .map((city) => locationCacheKey(city.query))
            .sort(compareCodeUnits);

        // Labels are local presentation and clock order does not change the
        // readings. JSON keeps arbitrary query text structurally distinct:
        // delimiter concatenation let one label/query pair impersonate two.
        return JSON.stringify([this._active(settings), queries]);
    }

    // `force` says the settings have not changed but the world has: it is the
    // resume path.
    //
    // GLib's timeouts ride CLOCK_MONOTONIC, which does not advance across a
    // suspend, so a laptop that slept for two hours wakes with its 30-minute
    // timer still holding most of its time. The panel weather handles this — on
    // resume it stops its scheduler and refreshes at once — but the city weather
    // saw an unchanged signature and a live timer id and early-returned, so the
    // tooltip kept its pre-suspend temperatures for up to 25 more minutes while
    // the panel beside it showed a fresh one.
    schedule(settings, callback, force = false) {
        if (this._destroyed) {
            return;
        }

        // The weather location is a Cinnamon text entry, so it fires on every
        // keystroke, and each one used to re-read every city: eight clocks and
        // a nine-letter city name is over seventy forecast requests in a
        // couple of seconds, which is what the free tiers rate-limit on.
        const signature = this._signature(settings);
        if (!force && signature === this._applied_signature && this._scheduler.timerId > 0) {
            return;
        }
        this._applied_signature = signature;

        // the generation moves so an in-flight round for the old settings is
        // dropped; the scheduler owns the timers. Nothing to read means nothing
        // to re-read: a clock list of built-ins only, or weather switched off,
        // arms no timer — that is what isActive() tells it.
        this._generation++;
        this._scheduler.schedule(settings, () => this.refresh(settings, callback));
    }

    refresh(settings, callback) {
        if (this._destroyed) {
            return;
        }

        const generation = ++this._generation;
        const cities = this._cities(settings);

        if (!this._active(settings) || !cities.length) {
            // weather off, or every clock is a built-in: drop what was read
            // for a city the user has since removed
            this._reading_store.clear();
            this._errors.clear();
            this._scheduler.succeeded();
            callback(this);
            return;
        }

        this._forgetRemovedCities(
            new Set(cities.map((city) => locationCacheKey(city.query))));

        if (!this._isOnline()) {
            this._offlineRound(cities, callback);
            return;
        }

        // the round is done when every city has answered one way or the other;
        // if any of them failed, the round failed and is worth retrying
        const round = { outstanding: cities.length, failed: 0, changed: false, completed: false, settings, queue: cities.slice() };
        // start the next queued city; _cityDone calls this again as each frees a
        // slot, so at most GEOCODE_CONCURRENCY chains run at once
        round.pump = () => this._pumpRound(round, generation, callback);
        for (let started = 0; started < GEOCODE_CONCURRENCY; started++) {
            round.pump();
        }
    }

    // a reading or an error for a city the user has since removed must not
    // outlive the clock row that showed it
    _forgetRemovedCities(wanted) {
        this._reading_store.keepOnly(wanted);
        for (const key of Array.from(this._errors.keys())) {
            if (!wanted.has(key)) {
                this._errors.delete(key);
            }
        }
    }

    // Offline is a state, not eight per-service failures: dispatch nothing,
    // keep the readings (staleness already says how old they are), and arm no
    // retry — the network monitor's next flip is the retry. succeeded() also
    // cancels a backoff left over from a failure that has just become
    // explainable.
    _offlineRound(cities, callback) {
        let changed = false;
        for (const city of cities) {
            changed = this._setError(
                city.query, WeatherFormat.WEATHER_ERRORS.OFFLINE) || changed;
        }
        this._scheduler.succeeded();
        if (changed) {
            callback(this);
        }
    }

    _pumpRound(round, generation, callback) {
        if (!this._isCurrent(generation)) {
            return;
        }
        const city = round.queue.shift();
        if (city) {
            this._refreshCity(city, generation, callback, round);
        }
    }

    _cityDone(generation, round, settings, callback, ok) {
        if (!this._isCurrent(generation)) {
            return;
        }

        if (!ok) {
            round.failed++;
        }

        round.outstanding--;
        // this city freed a slot; start the next queued one
        round.pump();
        // a synchronous resolver (a test double, a cache hit) drains the queue
        // inside one _cityDone call, so several stack frames can see outstanding
        // reach zero — finish the round exactly once
        if (round.outstanding > 0 || round.completed) {
            return;
        }
        round.completed = true;

        // The round is what produces a new set of readings, and the callback
        // rebuilds the whole panel label and tooltip (padding every tooltip
        // column to its widest cell). Firing it per city meant eight rebuilds
        // where the readings are only worth looking at once — and this is the
        // place that knows the round is over.
        if (round.changed) {
            callback(this);
        }

        if (round.failed > 0) {
            this._retry(settings, callback);
            return;
        }

        this._scheduler.succeeded();
    }

    _active(settings) {
        return Boolean(settings && settings.showWeather); // NOSONAR [S6582] -- accepted compatible form
    }

    // A city is what the tooltip calls it (the clock's label, which is where
    // the reading is looked up) and what the geocoder is asked about (the city
    // its timezone names). Those are not the same string, and only the second
    // one leaves the machine. A plain string means both, which is what a bare
    // provider in a test hands us.
    // A settings entry is either a bare string (label and query both) or an
    // object with its own label and query. Coerce and validate one; a built-in
    // clock or a timezone that names no city has no query and drops out here,
    // its row still showing the time.
    _normalizeCityEntry(entry) {
        const label = typeof entry === "string" ? entry : (entry && entry.label); // NOSONAR [S6582] -- accepted compatible form
        const query = typeof entry === "string" ? entry : (entry && entry.query); // NOSONAR [S6582] -- accepted compatible form

        if (typeof label !== "string" || !label.trim()) {
            return null;
        }
        if (typeof query !== "string" || !query.trim()) {
            return null;
        }

        return { label: label.trim(), query: query.trim() };
    }

    _cities(settings) {
        const cities = settings && Array.isArray(settings.cities) ? settings.cities : [];
        const seen = new Set();
        const unique = [];

        for (const entry of cities) {
            const city = this._normalizeCityEntry(entry);
            if (!city) {
                continue;
            }

            // keyed on the city, not on the label: the label is the user's own
            // name for the clock and nothing makes it unique. Two clocks both
            // called "Home" — Lisbon and Tokyo — collapsed into one entry here,
            // so Tokyo was never geocoded, never fetched, and its row showed
            // Lisbon's temperature with nothing to say it was the wrong city.
            const key = locationCacheKey(city.query);
            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            unique.push(city);
            if (unique.length >= MAX_CITIES) {
                break;
            }
        }

        return unique;
    }

    _isCurrent(generation) {
        return !this._destroyed && generation === this._generation;
    }

    _refreshCity(city, generation, callback, round) {
        // the query is the timezone's city; the label is only ever a local key
        this._reading_repository.refresh(city.query,
            () => this._isCurrent(generation),
            (reading, forecastError, provider, place, readingAt) =>
                this._cityForecastResolved(city, generation, callback, round,
                    { reading, forecastError, provider, readingAt }));
    }

    _cityForecastResolved(city, generation, callback, round, answer) {
        const { reading, forecastError, provider, readingAt } = answer;
        if (!this._isCurrent(generation)) {
            return;
        }
        if (forecastError || !reading) {
            // the city keeps the reading it had; it is now aging, and staleFor()
            // says so once it is two periods old. An unknown place will not
            // improve on retry; a service failure may.
            const cityError = forecastError || WeatherFormat.WEATHER_ERRORS.SERVICE_UNAVAILABLE;
            round.changed = this._setError(city.query, cityError) || round.changed;
            const ok = cityError === WeatherFormat.WEATHER_ERRORS.LOCATION_NOT_FOUND;
            this._cityDone(generation, round, round.settings, callback, ok);
            return;
        }

        this._setError(city.query, "");
        this._reading_store.record(
            locationCacheKey(city.query), reading, provider, readingAt);
        // the panel is repainted once, when the round finishes
        round.changed = true;
        this._cityDone(generation, round, round.settings, callback, true);
    }
};

if (typeof module !== "undefined") {
    module.exports = { CityWeatherProvider, CITY_REFRESH_SECONDS, CITY_RETRY_SECONDS, MAX_CITIES };
}
