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
// findExtensionSubdirectory has already repointed at the 5.4/ directory — and the
// applet would fail to load, because localeUtils.js is not in there.
//
// Node is what this asks about, because Node is the only host that requires these
// files directly. Cinnamon's cjs has no `process`.
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const ElapsedTime = IS_NODE ?
    require("./elapsedTime") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].elapsedTime;
const IoUtils = IS_NODE ?
    require("./ioUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].ioUtils;

// GJS exports only var bindings: anything another module reaches for
// through imports.ui.appletManager must be declared with var
const WeatherFormat = IS_NODE ?
    require("./weatherFormat") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherFormat;
// The refresh clock lives in its own module now; weather.js is the barrel that
// requires it and hands it on, so consumers and the parity list are unchanged.
const WeatherScheduler = IS_NODE ?
    require("./weatherScheduler") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherScheduler;
// The geocode/forecast chains and their resolvers live in their own module now;
// weather.js is the barrel that requires them and hands them on unchanged.
const WeatherProviders = IS_NODE ?
    require("./weatherProviders") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherProviders;
const WeatherServiceAdapters = IS_NODE ?
    require("./weatherServiceAdapters") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherServiceAdapters;

// The composition root reaches the shared repository through the same version
// shim as WeatherProvider. Keep this a var binding so GJS exposes it.
var WeatherReadingRepository = WeatherProviders.WeatherReadingRepository; // NOSONAR [S3504] -- GJS importer export

class WeatherDisplayState {
    constructor(params = {}) {
        // the reading is the unit-free record, and it is all there is: nothing
        // on this side of the port renders it
        this._last_good_reading = null; // NOSONAR [S7757] -- accepted compatible form
        this._last_good_provider = "";
        this._last_good_key = "";
        this._last_good_fresh_at = 0;
        this._freshness_now = params.freshnessNow || params.now ||
            ElapsedTime.civilMilliseconds;
        // Two refresh periods with nothing getting through means nobody is
        // refreshing this successfully any more, and what is on the panel is
        // not the weather. The rule, and the derivation from the refresh period,
        // are weatherFormat's — the city rows of the same feature use the same
        // ones.
        this._stale_after_seconds = params.staleAfterSeconds ||
            WeatherFormat.staleAfterSeconds(params.refreshSeconds);
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
        this._last_good_provider = "";
        this._last_good_key = "";
        this._last_good_fresh_at = 0;
    }

    // a reading nobody has managed to refresh for two periods is no longer a
    // reading, and showing it is worse than showing nothing
    isStale(now = this._freshness_now()) {
        if (!this._last_good_reading) {
            return false;
        }

        return WeatherFormat.readingIsStale(
            this._last_good_fresh_at, now, this._stale_after_seconds);
    }

    // The forecast resolver reports the unit-free reading record, and nothing
    // else: what it looks like on the panel is decided where it is shown. A
    // failed refresh re-shows the last good record — marked, not dropped.
    reporter(staleKey, callback) {
        return (reading, error, provider) => {
            if (reading && !error) {
                this._last_good_reading = reading;
                this._last_good_provider = provider;
                this._last_good_key = staleKey;
                this._last_good_fresh_at = this._freshness_now();
            } else if (error && this._last_good_reading && this._last_good_key === staleKey &&
                !this.isStale()) {
                callback(this._last_good_reading, error, this._last_good_provider);
                return;
            }
            callback(reading, error, provider);
        };
    }
}

var WeatherProvider = class WeatherProvider { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._request_generation = 0; // NOSONAR [S7757] -- accepted compatible form
        this._destroyed = false;
        // the location the geocode cache was last asked about, so a settings
        // change that did not touch it does not throw the geocode away
        this._resolved_location_key = "";
        this._resolved_place_key = "";
        this._resolved_place = null;
        this._display_state = params.displayState || new WeatherDisplayState(params);
        // "always online" is the pre-monitor behavior; the composition root
        // injects the real Gio.NetworkMonitor-backed answer
        this._isOnline = params.isOnline || (() => true);
        this._scheduler = params.scheduler || new WeatherScheduler.WeatherRefreshScheduler(params);
        this._reading_repository = params.readingRepository ||
            new WeatherReadingRepository(params);
        this._owns_reading_repository = !params.readingRepository;
    }

    placeFor(location) {
        const normalized = WeatherFormat.normalizeWeatherLocation(location);
        if (!normalized) {
            return null;
        }

        const key = WeatherProviders.locationCacheKey(normalized);
        if (key === this._resolved_place_key) {
            return this._resolved_place;
        }
        return this._reading_repository.placeFor(normalized);
    }

    _setLocationKey(key) {
        if (key !== this._resolved_place_key) {
            this._resolved_place_key = "";
            this._resolved_place = null;
        }
        this._resolved_location_key = key;
    }

    _rememberPlace(key, place) {
        if (place && key === this._resolved_location_key) {
            this._resolved_place_key = key;
            this._resolved_place = place;
        }
    }

    stop() {
        this._request_generation++;
        this._scheduler.stop();
    }

    destroy() {
        this._destroyed = true;
        this.stop();

        if (this._owns_reading_repository) {
            this._reading_repository.destroy();
        }
    }

    schedule(settings, callback) {
        if (this._destroyed) {
            return;
        }

        const location = WeatherFormat.normalizeWeatherLocation(settings.location);
        this._setLocationKey(location ? WeatherProviders.locationCacheKey(location) : "");
        // the reading on the panel belongs to the place it was fetched for; if
        // that is not the place being asked about now, it is not the weather
        this._display_state.forgetUnless(this._staleKey(settings));

        if (!this._display_state.hasReading() && settings.showWeather && location) {
            // First fetch: reserve the panel slot instead of popping in later.
            // "Pending" is a state, not a reading — it used to travel as the
            // placeholder *string*, which every consumer had to compare against
            // to find out that no reading had landed yet.
            callback(null, "", "", true);
        }

        this._request_generation++;
        this._scheduler.schedule(settings, () => this.refresh(settings, callback));
    }

    // The user edited the location: re-resolve it rather than answering from a hit
    // that may have been wrong.
    //
    // Only when it actually changed. Unit changes are routed around this request
    // path because the retained reading is deliberately unit-free; one reading
    // serves both display systems.
    _forgetIfLocationChanged(location) {
        const normalized = WeatherFormat.normalizeWeatherLocation(location);
        const key = normalized ? WeatherProviders.locationCacheKey(normalized) : "";
        const changed = key !== this._resolved_location_key;
        if (key && changed) {
            this._reading_repository.forget(normalized);
        }

        this._setLocationKey(key);
        return changed;
    }

    // The panel is showing a place the user has just stopped asking about.
    // Everything attached to it is now wrong, and none of it is an edit worth
    // debouncing: the request generation retires the in-flight callback, the
    // scheduler's timers would otherwise re-dispatch the old settings during
    // the debounce window, and the retained reading is another city's
    // temperature. Only the replacement network request waits for the
    // keystrokes to settle.
    _invalidateForNewLocation(settings, callback) {
        this.stop();
        this._display_state.forgetUnless(this._staleKey(settings));
        // Say so synchronously. The panel used to keep the old city's number,
        // unmarked, for the whole debounce — and if a stale callback landed in
        // that window it refreshed it, which read as the new city's weather.
        callback(null, "", "",
            Boolean(WeatherFormat.normalizeWeatherLocation(settings.location)));
    }

    queue(settings, callback) {
        if (this._destroyed) {
            return;
        }

        const locationChanged = this._forgetIfLocationChanged(settings.location);

        if (!settings.showWeather) {
            // Opting out is a state transition, not an edit to debounce. Drop
            // timers and invalidate the in-flight request before clearing the
            // presentation so no old callback can restart network work.
            this.stop();
            callback(null, "", "");
            return;
        }

        if (locationChanged) {
            this._invalidateForNewLocation(settings, callback);
        }

        this._scheduler.queue(settings, (queuedSettings) => this.schedule(queuedSettings, callback));
    }

    refresh(settings, callback) {
        if (this._destroyed) {
            return;
        }

        const generation = ++this._request_generation;
        const location = WeatherFormat.normalizeWeatherLocation(settings.location);
        this._setLocationKey(location ? WeatherProviders.locationCacheKey(location) : "");
        if (!settings.showWeather) {
            callback(null, "", "");
            return;
        }

        if (!location) {
            // weather is on but unconfigured: surface a hint instead of
            // silently showing nothing
            callback(null, WeatherFormat.WEATHER_ERRORS.NO_LOCATION, "");
            return;
        }

        const report = this._refreshReporter(settings, callback);
        if (!this._isOnline()) {
            // offline is a state, not a provider failure: dispatch nothing and
            // arm no retry — the network monitor's next flip is the retry. The
            // reporter keeps the last reading, so recovery shows it as stale
            // rather than blank.
            report(null, WeatherFormat.WEATHER_ERRORS.OFFLINE, "", null);
            return;
        }
        this._reading_repository.refresh(location,
            () => this._isCurrent(generation), report);
    }

    _isCurrent(generation) {
        return !this._destroyed && generation === this._request_generation;
    }

    _refreshReporter(settings, callback) {
        const key = this._staleKey(settings);
        const report = this._display_state.reporter(key,
            (reading, error, provider) => {
                // Service outages may recover before the normal period. A name
                // that both geocoders answered but could not resolve will not —
                // and neither will a missing network, whose recovery signal is
                // the monitor's flip, not a timer.
                if (error &&
                    error !== WeatherFormat.WEATHER_ERRORS.LOCATION_NOT_FOUND &&
                    error !== WeatherFormat.WEATHER_ERRORS.OFFLINE) {
                    this._scheduler.retry(() => this.refresh(settings, callback));
                } else {
                    this._scheduler.succeeded();
                }
                callback(reading, error, provider);
            });
        return (reading, error, provider, place) => {
            this._rememberPlace(key, place);
            report(reading, error, provider);
        };
    }

    // What a reading is a reading *of*: the place. It used to be the place and
    // the units, because the stored reading was rendered text and °F was a
    // different reading from °C — so switching the unit threw the reading away
    // and refetched. The record is unit-free, so the same reading serves both
    // and only a change of place invalidates it.
    _staleKey(settings) {
        const location = WeatherFormat.normalizeWeatherLocation(settings.location);
        return WeatherProviders.locationCacheKey(location);
    }

};

if (typeof module !== "undefined") {
    // Programmatic, because the alternative was one `var X = Part.X;` line per
    // symbol and the same name again here: adding a constant to any of the three
    // parts was three edits in two files. Nothing in the applet reads a part's
    // symbol off this barrel any more — the consumers require the part — so the
    // var bindings GJS needs live in the module that declares each name.
    module.exports = Object.assign({}, WeatherFormat, WeatherServiceAdapters, // NOSONAR [S6661] -- accepted compatible form
        WeatherScheduler, WeatherProviders, { HTTP_TIMEOUT_SECONDS: IoUtils.HTTP_TIMEOUT_SECONDS },
        { WeatherProvider, WeatherDisplayState, WeatherReadingRepository });
}
