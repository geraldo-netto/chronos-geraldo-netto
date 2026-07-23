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

// The refresh clock of the weather feature: one period, one exponential backoff
// with a jitter and a ceiling, one debounce, one teardown — shared by the panel
// weather and the per-city weather, which used to own two drifted copies of it.
// weather.js keeps the provider chains and the display state; weatherFormat.js
// keeps the pure numbers and words. This is the split weather.js grew past 600
// lines without.

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

const REFRESH_SECONDS = WeatherFormat.REFRESH_SECONDS;
const RETRY_SECONDS = WeatherFormat.RETRY_SECONDS;
const WEATHER_DEBOUNCE_MS = WeatherFormat.WEATHER_DEBOUNCE_MS;
const MAX_RETRY_ATTEMPTS = WeatherFormat.MAX_RETRY_ATTEMPTS;

var WeatherRefreshScheduler = class WeatherRefreshScheduler { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._timer_id = 0; // NOSONAR [S7757] -- accepted compatible form
        this._debounce_id = 0;
        this._retry_id = 0;
        this._retry_attempts = 0;
        this._active = false;
        this._scheduleTimer = params.scheduleTimer || ((seconds, callback) => {
            return GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, callback);
        });
        this._scheduleDebounceTimer = params.scheduleDebounceTimer || ((milliseconds, callback) => {
            return GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, callback);
        });
        this._removeTimer = params.removeTimer || GLib.source_remove;
        this._refresh_seconds = params.refreshSeconds || REFRESH_SECONDS;
        this._retry_seconds = params.retrySeconds || RETRY_SECONDS;
        this._debounce_ms = params.debounceMs || WEATHER_DEBOUNCE_MS;
        // injectable so the jitter is a fixed number under test
        this._random = params.random || Math.random;
        // What "there is something to refresh" means. The panel weather needs a
        // location; the city weather needs at least one city. The rest of the
        // machinery — the period, the backoff, the jitter, the debounce, the
        // teardown — is identical, and the city provider used to own a second
        // copy of all of it.
        this._isActive = params.isActive ||
            ((settings) => Boolean(settings.showWeather &&
                WeatherFormat.normalizeWeatherLocation(settings.location)));
    }

    get timerId() {
        return this._timer_id;
    }

    get debounceId() {
        return this._debounce_id;
    }

    get retryId() {
        return this._retry_id;
    }

    stop() {
        if (this._debounce_id > 0) {
            this._removeTimer(this._debounce_id);
            this._debounce_id = 0;
        }

        if (this._retry_id > 0) {
            this._removeTimer(this._retry_id);
            this._retry_id = 0;
        }
        this._retry_attempts = 0;

        if (this._timer_id > 0) {
            this._removeTimer(this._timer_id);
            this._timer_id = 0;
        }
    }

    schedule(settings, refresh) {
        this.stop();

        // the first refresh can fail before the periodic timer is armed, so
        // record whether weather is on before running it
        this._active = Boolean(this._isActive(settings));

        refresh();

        if (!this._active) {
            return;
        }

        this._timer_id = this._scheduleTimer(this._refresh_seconds, () => {
            refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // A failed refresh used to wait out the full 30-minute period, so 20
    // seconds of no network at login left the panel showing an error for half
    // an hour. Retry sooner, backing off toward the normal period.
    retry(refresh) {
        if (!this._active) {
            return;
        }

        if (this._retry_id > 0) {
            this._removeTimer(this._retry_id);
            this._retry_id = 0;
        }

        const delay = ProviderUtils.backoffDelay(this._retry_attempts, {
            base: this._retry_seconds,
            cap: this._refresh_seconds,
            random: this._random
        });
        this._retry_attempts = Math.min(this._retry_attempts + 1, MAX_RETRY_ATTEMPTS);

        this._retry_id = this._scheduleTimer(delay, () => {
            this._retry_id = 0;
            refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // the backoff has reached its ceiling: the caller can say so once, rather
    // than logging every retry for the rest of the session
    retriesExhausted() {
        return this._retry_attempts >= MAX_RETRY_ATTEMPTS;
    }

    succeeded() {
        this._retry_attempts = 0;
        if (this._retry_id > 0) {
            this._removeTimer(this._retry_id);
            this._retry_id = 0;
        }
    }

    queue(settings, schedule) {
        if (this._debounce_id > 0) {
            this._removeTimer(this._debounce_id);
        }

        this._debounce_id = this._scheduleDebounceTimer(this._debounce_ms, () => {
            this._debounce_id = 0;
            schedule(settings);
            return GLib.SOURCE_REMOVE;
        });
    }
};

if (typeof module !== "undefined") {
    module.exports = { WeatherRefreshScheduler };
}
