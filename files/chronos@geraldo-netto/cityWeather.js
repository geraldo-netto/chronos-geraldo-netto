/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const Utils = typeof require === "function" ?
    require("./utils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].utils;
// the parts, not the barrel: requiring ./weather pulled in WeatherProvider — the
// panel provider this module is the twin of — and its Soup session, for a handful
// of constants, two resolvers and the refresh clock
const Weather = typeof require === "function" ?
    require("./weatherFormat") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherFormat;
const WeatherProviders = typeof require === "function" ?
    require("./weatherProviders") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherProviders;
const WeatherScheduler = typeof require === "function" ?
    require("./weatherScheduler") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherScheduler;
const WorldclockData = typeof require === "function" ?
    require("./worldclockData") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;

const locationCacheKey = Weather.locationCacheKey;

// the world-clock cities are read on the same period as the panel weather:
// the popup is a glance at the time, not a forecast desk
const CITY_REFRESH_SECONDS = Weather.REFRESH_SECONDS;
// One city per clock, so this is the clock cap — not a number of its own. It
// used to be its own literal 8, a fifth copy of the cap and the one the parity
// test did not cover: raising the cap to 10 would have left clocks 9 and 10
// with a permanently blank temperature column, no error anywhere, and a green
// suite certifying it. A resolve plus a forecast per city is already sixteen
// requests, so nothing here fans out further.
const MAX_CITIES = WorldclockData.MAX_CLOCKS;
// The cities are geocoded through a small pool, not all at once. On an
// Open-Meteo outage every one falls through to Nominatim, whose usage policy
// caps a client at one request a second, so a cold-cache round of eight
// simultaneous fallbacks could get the user throttled. Two in flight keeps the
// round quick without bursting.
const GEOCODE_CONCURRENCY = 2;
// a failed round is retried sooner than the next period, backing off toward
// it — the panel reading has worked this way all along
const CITY_RETRY_SECONDS = Weather.RETRY_SECONDS;
// a reading older than two periods is no longer being refreshed successfully,
// and the tooltip says so rather than presenting it as current. The rule lives
// in weatherFormat, with the panel's — this is only its value at the default
// period.
const CITY_STALE_AFTER_SECONDS = Weather.staleAfterSeconds(CITY_REFRESH_SECONDS);

// The panel weather asks one place for one reading. The tooltip asks every
// configured world clock, so each city carries its own place lookup and its
// own last-good reading; a city that fails to geocode simply has no
// temperature and its row still shows the time.
var CityWeatherProvider = class CityWeatherProvider {
    constructor(params = {}) {
        this._destroyed = false;
        this._generation = 0;
        this._readings = new Map();
        this._last_provider = "";
        this._applied_signature = null;
        this._now = params.now || (() => Date.now());
        this._refresh_seconds = params.refreshSeconds || CITY_REFRESH_SECONDS;
        // derived from the period this provider actually refreshes on, not from
        // the module default: staleFor() used to read the constant and ignore
        // the injected period entirely, so a provider refreshing every minute
        // called an hour-old temperature current
        this._stale_after_seconds = params.staleAfterSeconds ||
            Weather.staleAfterSeconds(this._refresh_seconds);

        // The panel weather's scheduler, doing the same job for the cities: the
        // period, the exponential backoff with its cap and jitter, the attempt
        // ceiling and the timer teardown were all hand-rolled a second time
        // here — and the copy had drifted, losing the jitter and the attempt
        // cap. It differs from the panel's only in what counts as "something to
        // refresh", which is now a parameter.
        this._scheduler = params.scheduler || new WeatherScheduler.WeatherRefreshScheduler(
            Object.assign({
                refreshSeconds: this._refresh_seconds,
                retrySeconds: CITY_RETRY_SECONDS,
                isActive: (settings) =>
                    Boolean(this._active(settings) && this._cities(settings).length)
            }, params));

        // Built on first use, not at construction: initProviders() makes one of
        // these for every applet whether or not weather or world clocks are on,
        // and an idle Soup.Session is a cost paid for a feature nobody enabled.
        // WeatherProvider defers the same way for the same reason.
        // one lazy session, guarded abort and all, shared with the panel provider
        // and the holiday chain: the lifecycle lives in ioUtils
        this._session = new Utils.LazyHttpSession(
            params.httpSession ? () => params.httpSession : undefined);
        this._httpGetJson = params.httpGetJson || ((url, callback, options = {}) => {
            Utils.httpGetJson(this._getHttpSession(), url, (data) => callback(data), options);
        });

        this._location_resolver = params.locationResolver || new WeatherProviders.WeatherLocationResolver({
            httpGetJson: this._httpGetJson
        });
        this._forecast_resolver = params.forecastResolver || new WeatherProviders.WeatherForecastResolver({
            httpGetJson: this._httpGetJson
        });
    }

    _getHttpSession() {
        return this._session.get();
    }

    get lastProvider() {
        return this._last_provider;
    }

    // the readings outlive a refresh: a city that failed this round keeps the
    // temperature it last had rather than blinking out of the tooltip. The
    // reading is the unit-free record { condition, temperatureC }; the tooltip
    // renders it in the user's unit.
    recordFor(city) {
        const reading = this._readingFor(city);
        return reading ? reading.record : null;
    }

    // ...but a reading nobody has managed to refresh for two whole periods is
    // not the weather any more, and saying so is the difference between a
    // temperature and a temperature from this morning
    staleFor(city, now = this._now()) {
        const reading = this._readingFor(city);
        if (!reading) {
            return false;
        }

        return Weather.readingIsStale(reading.at, now, this._stale_after_seconds);
    }

    _readingFor(city) {
        if (typeof city !== "string" || !city.trim()) {
            return null;
        }

        return this._readings.get(locationCacheKey(city)) || null;
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
        const wasSaturated = this._scheduler.retriesExhausted();
        this._scheduler.retry(() => this.refresh(settings, callback));

        // said once, when the backoff reaches its ceiling — not on every retry
        // for the rest of the session
        if (!wasSaturated && this._scheduler.retriesExhausted() && global.log) {
            global.log("city weather: still failing after " +
                Weather.MAX_RETRY_ATTEMPTS +
                " attempts; falling back to the normal refresh period");
        }
    }

    destroy() {
        this._destroyed = true;
        this.stop();
        this._readings.clear();

        this._session.abort();
    }

    // What the cities are read from: the clock list, and whether weather is on at
    // all. The panel's weather location is not in here — it is a different place,
    // asked a different question. Nor is the unit: the readings are unit-free
    // records now, so switching °C to °F re-renders the tooltip from what is
    // already held instead of geocoding and refetching every city again.
    _signature(settings) {
        return [
            this._active(settings) ? "on" : "off",
            this._cities(settings).map((city) => city.label + "@" + city.query).join(",")
        ].join("|");
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
            this._readings.clear();
            this._scheduler.succeeded();
            callback(this);
            return;
        }

        const wanted = new Set(cities.map((city) => locationCacheKey(city.label)));
        for (const key of Array.from(this._readings.keys())) {
            if (!wanted.has(key)) {
                this._readings.delete(key);
            }
        }

        // the round is done when every city has answered one way or the other;
        // if any of them failed, the round failed and is worth retrying
        const round = { outstanding: cities.length, failed: 0, changed: false, completed: false, settings, queue: cities.slice() };
        // start the next queued city; _cityDone calls this again as each frees a
        // slot, so at most GEOCODE_CONCURRENCY chains run at once
        round.pump = () => {
            if (!this._isCurrent(generation)) {
                return;
            }
            const city = round.queue.shift();
            if (city) {
                this._refreshCity(city, generation, callback, round);
            }
        };
        for (let started = 0; started < GEOCODE_CONCURRENCY; started++) {
            round.pump();
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
        return Boolean(settings && settings.showWeather);
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
        const label = typeof entry === "string" ? entry : (entry && entry.label);
        const query = typeof entry === "string" ? entry : (entry && entry.query);

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

            const key = locationCacheKey(city.label);
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
        const settings = round.settings;
        const done = (ok) => this._cityDone(generation, round, settings, callback, ok);

        // the query is the timezone's city; the label is only ever a local key
        this._location_resolver.resolve(city.query, () => this._isCurrent(generation), (place, error) => {
            if (!this._isCurrent(generation)) {
                return;
            }

            if (!place) {
                // A place that will not geocode is not a failure to retry: the
                // name is wrong, and asking again will not make it right. That is
                // true of LOCATION_NOT_FOUND — and this used to discard the error
                // argument entirely and apply it to every failure, including the
                // one that means "nobody answered".
                //
                // Start before NetworkManager is up and every city exhausts its
                // chain with SERVICE_UNAVAILABLE; the round then scored zero
                // failures, told the scheduler it had succeeded, and armed no
                // retry — so the tooltip had no temperatures for thirty minutes,
                // while the panel weather beside it, on the identical failure,
                // was back in twenty seconds.
                done(error !== Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE);
                return;
            }

            this._forecast_resolver.refresh(place, () => this._isCurrent(generation),
                (reading, forecastError, provider) => {
                    if (!this._isCurrent(generation)) {
                        return;
                    }

                    if (forecastError || !reading) {
                        // the city keeps the reading it had; it is now aging,
                        // and staleFor() says so once it is two periods old
                        done(false);
                        return;
                    }

                    this._readings.set(locationCacheKey(city.label), { record: reading, at: this._now() });
                    this._last_provider = provider || this._last_provider;
                    // the panel is repainted once, when the round finishes
                    round.changed = true;
                    done(true);
                });
        });
    }
};

if (typeof module !== "undefined") {
    module.exports = { CityWeatherProvider, CITY_REFRESH_SECONDS, CITY_RETRY_SECONDS, CITY_STALE_AFTER_SECONDS, MAX_CITIES };
}
