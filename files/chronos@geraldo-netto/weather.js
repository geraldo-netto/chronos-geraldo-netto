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
    Boolean(process.versions && process.versions.node);
const Utils = IS_NODE ?
    require("./utils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].utils;

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


class WeatherDisplayState {
    constructor(params = {}) {
        // the reading is the unit-free record, and it is all there is: nothing
        // on this side of the port renders it
        this._last_good_reading = null;
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
        this._last_good_at = 0;
    }

    // a reading nobody has managed to refresh for two periods is no longer a
    // reading, and showing it is worse than showing nothing
    isStale(now = this._now()) {
        if (!this._last_good_reading) {
            return false;
        }

        return WeatherFormat.readingIsStale(this._last_good_at, now, this._stale_after_seconds);
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
                this._last_good_at = this._now();
            } else if (error && this._last_good_reading && this._last_good_key === staleKey &&
                !this.isStale()) {
                callback(this._last_good_reading, error, this._last_good_provider);
                return;
            }
            callback(reading, error, provider);
        };
    }
}

var WeatherProvider = class WeatherProvider {
    constructor(params = {}) {
        this._request_generation = 0;
        this._destroyed = false;
        // the location the geocode cache was last asked about, so a settings
        // change that did not touch it does not throw the geocode away
        this._resolved_location_key = "";
        this._display_state = params.displayState || new WeatherDisplayState(params);
        this._httpGetJson = params.httpGetJson || this._httpGetJson.bind(this);
        this._scheduler = params.scheduler || new WeatherScheduler.WeatherRefreshScheduler(params);
        this._location_resolver = params.locationResolver || new WeatherProviders.WeatherLocationResolver({
            cache: params.geocodeCache,
            httpGetJson: this._httpGetJson
        });
        this._forecast_resolver = params.forecastResolver || new WeatherProviders.WeatherForecastResolver({
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
        // the same lazy session, the same guarded abort, as the city provider and
        // the holiday chain: one lifecycle, in ioUtils
        this._session = new Utils.LazyHttpSession(
            params.httpSession ? () => params.httpSession : undefined);
    }

    _getHttpSession() {
        return this._session.get();
    }

    stop() {
        this._request_generation++;
        this._scheduler.stop();
    }

    destroy() {
        this._destroyed = true;
        this.stop();

        // nothing to abort if nothing ever asked for a session
        this._session.abort();
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
    // Only when it actually changed. This runs for *every* weather key — the
    // handler is one — so flipping °C to °F dropped the geocode and re-issued the
    // geocoding request and the forecast request. The reading record is unit-free
    // on purpose and _staleKey() deliberately excludes the units ("the same reading
    // serves both"), so a unit toggle needs a re-render, not two round trips; and
    // on an Open-Meteo outage the geocode falls through to Nominatim, whose usage
    // policy is one request a second.
    _forgetIfLocationChanged(location) {
        const key = location ? WeatherFormat.locationCacheKey(location) : "";
        if (key && key !== this._resolved_location_key) {
            this._location_resolver.forget(location);
        }

        this._resolved_location_key = key;
    }

    queue(settings, callback) {
        if (this._destroyed) {
            return;
        }

        this._forgetIfLocationChanged(settings.location);

        this._scheduler.queue(settings, (queuedSettings) => this.schedule(queuedSettings, callback));
    }

    refresh(settings, callback) {
        if (this._destroyed) {
            return;
        }

        const generation = ++this._request_generation;
        const location = settings.location ? settings.location.trim() : "";
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

        const report = this._display_state.reporter(this._staleKey(settings),
            (reading, error, provider) => {
                // a failed refresh must not wait out the whole refresh period
                if (error) {
                    this._scheduler.retry(() => this.refresh(settings, callback));
                } else {
                    this._scheduler.succeeded();
                }
                callback(reading, error, provider);
            });
        this._location_resolver.resolve(location, () => {
            return !this._destroyed && generation === this._request_generation;
        }, (place, error) => {
            if (this._destroyed || generation !== this._request_generation) {
                return;
            }

            if (!place) {
                report(null, error, "");
                return;
            }

            this._refreshForecast(place, generation, report);
        });
    }

    // What a reading is a reading *of*: the place. It used to be the place and
    // the units, because the stored reading was rendered text and °F was a
    // different reading from °C — so switching the unit threw the reading away
    // and refetched. The record is unit-free, so the same reading serves both
    // and only a change of place invalidates it.
    _staleKey(settings) {
        const location = settings.location ? settings.location.trim() : "";
        return WeatherFormat.locationCacheKey(location);
    }

    // A reading is a reading *of* somewhere, and the somewhere is what the
    // geocoder picked — not what the user typed. Those are not always the same
    // city ("Genova" has namesakes in Guatemala, Colombia and Mexico), so the
    // resolved place travels with the reading and the tooltip shows it: the user
    // can see which Genova the temperature belongs to.
    _refreshForecast(place, generation, callback) {
        const label = WeatherFormat.placeLabel(place);
        this._forecast_resolver.refresh(place, () => {
            return !this._destroyed && generation === this._request_generation;
        }, (reading, error, provider) => {
            // a geocoder that named no place — Nominatim without a display_name —
            // leaves the record as it was rather than carrying an empty line into
            // the tooltip
            callback(reading && label ? Object.assign({}, reading, { place: label }) : reading,
                error, provider);
        });
    }

    _httpGetJson(url, callback, options = {}) {
        Utils.httpGetJson(this._getHttpSession(), url, (data) => callback(data), options);
    }
};

if (typeof module !== "undefined") {
    // Programmatic, because the alternative was one `var X = Part.X;` line per
    // symbol and the same name again here: adding a constant to any of the three
    // parts was three edits in two files. Nothing in the applet reads a part's
    // symbol off this barrel any more — the consumers require the part — so the
    // var bindings GJS needs live in the module that declares each name.
    module.exports = Object.assign({}, WeatherFormat, WeatherScheduler, WeatherProviders,
        { WeatherProvider, WeatherDisplayState });
}
