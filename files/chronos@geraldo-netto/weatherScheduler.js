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
// findExtensionSubdirectory has already repointed at the 6.0/ directory — and the
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
const Diagnostics = IS_NODE ?
    require("./diagnostics") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].diagnostics;
const WeatherFormat = IS_NODE ?
    require("./weatherFormat") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherFormat;

const REFRESH_SECONDS = WeatherFormat.REFRESH_SECONDS;
const RETRY_SECONDS = WeatherFormat.RETRY_SECONDS;
const WEATHER_DEBOUNCE_MS = WeatherFormat.WEATHER_DEBOUNCE_MS;
const MAX_RETRY_ATTEMPTS = WeatherFormat.MAX_RETRY_ATTEMPTS;
// Claims the debounce slot while the source is being armed, so a callback that
// runs before the arming call returns can release it and be seen to have done
// so. Negative, because every id GLib hands out is positive and `> 0` is what
// the teardown tests.
const ARMING_TIMER_ID = -1;

var WeatherRefreshScheduler = class WeatherRefreshScheduler { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._timer_id = 0; // NOSONAR [S7757] -- accepted compatible form
        this._debounce_id = 0;
        this._retry_id = 0;
        this._retry_attempts = 0;
        this._retry_generation = 0;
        this._active = false;
        this._generation = 0;
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

    stop() {
        this._active = false;
        this._generation++;

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

        // Armed before the first refresh runs, not after. A refresh that raises
        // used to leave no periodic timer at all, so weather stopped updating
        // for the rest of the session unless a resume, a network restore or a
        // settings change happened to reschedule it — and the applet's _guarded
        // catches and logs that throw, which is exactly why the loss was silent.
        if (this._active) {
            this._armPeriodic(refresh, this._generation);
        }

        refresh();
    }

    _armPeriodic(refresh, generation) {
        this._timer_id = this._scheduleTimer(this._refresh_seconds, () => {
            if (!this._active || generation !== this._generation) {
                return GLib.SOURCE_REMOVE;
            }
            this._refreshSafely(refresh);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refreshSafely(refresh) {
        try {
            refresh();
        } catch (error) {
            Diagnostics.logSafely("logError", error);
        }
    }

    // A failed refresh used to wait out the full 30-minute period, so 20
    // seconds of no network at login left the panel showing an error for half
    // an hour. Retry sooner, backing off toward the normal period.
    //
    // Answers whether a retry was armed. Past the ceiling it arms nothing: the
    // budget used to saturate while the chain went on forever, so a persistent
    // outage ran a second request stream alongside the periodic timer for the
    // rest of the session — and the caller announcing a "falling back to the
    // normal refresh period" transition described one that never happened.
    // Spent budget means the periodic timer is the schedule again, until a
    // success resets it.
    retry(refresh) {
        if (!this._active || this.retriesExhausted()) {
            return false;
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
        const generation = this._generation;
        const retryGeneration = ++this._retry_generation;

        this._retry_id = this._scheduleTimer(delay, () => {
            if (!this._active || generation !== this._generation ||
                retryGeneration !== this._retry_generation) {
                return GLib.SOURCE_REMOVE;
            }
            this._retry_id = 0;
            this._refreshSafely(refresh);
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    // the backoff has reached its ceiling: the caller can say so once, rather
    // than logging every retry for the rest of the session
    retriesExhausted() {
        return this._retry_attempts >= MAX_RETRY_ATTEMPTS;
    }

    succeeded() {
        this._retry_generation++;
        this._retry_attempts = 0;
        if (this._retry_id > 0) {
            this._removeTimer(this._retry_id);
            this._retry_id = 0;
        }
    }

    // The slot is released before the old source is removed and claimed with a
    // sentinel before the new one is armed, for the reason
    // NominatimRequestQueue._scheduleJob states at length: nothing in the timer
    // port's contract says the callback may not run before the arming call
    // returns. If it does, the callback clears the slot and reschedules, and
    // writing the returned id back afterwards would park a spent id for the next
    // stop() to hand to GLib.source_remove. Arming that throws is the same story
    // read backwards: leaving the removed id in the slot would offer it to GLib
    // a second time.
    queue(settings, schedule) {
        const pending = this._debounce_id;
        this._debounce_id = 0;
        if (pending > 0) {
            this._removeTimer(pending);
        }

        this._debounce_id = ARMING_TIMER_ID;
        let timerId = 0;
        try {
            timerId = this._scheduleDebounceTimer(this._debounce_ms, () => {
                this._debounce_id = 0;
                schedule(settings);
                return GLib.SOURCE_REMOVE;
            });
        } finally {
            // Only if the slot is still ours: a callback that has already run
            // released it, and nothing armed is the same answer as a spent id.
            if (this._debounce_id === ARMING_TIMER_ID) {
                this._debounce_id = timerId > 0 ? timerId : 0;
            }
        }
    }
};

if (typeof module !== "undefined") {
    module.exports = { WeatherRefreshScheduler };
}
