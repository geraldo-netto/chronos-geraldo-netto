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

// What the panel weather and the world-clock weather are both an instance of.
//
// The applet has two weather consumers. They ask different questions — one
// place for the panel, one place per clock row for the tooltip — and they show
// the answers differently, but the lifecycle around the asking is the same
// lifecycle, and it was written out twice: the destroyed flag, the request
// generation and the is-this-answer-still-wanted test, stop(), destroy() with
// its "only if I built it" branch on the reading repository, the injected
// online test with its always-online default, and the decision of which
// failures are worth retrying.
//
// The copies had drifted, which is the reason this exists rather than the
// duplication itself: the panel discarded the scheduler's answer to retry() and
// so burned its whole eight-attempt budget with nothing in the log, while the
// cities logged the ceiling once; and the retry decision was written as "not
// unresolvable and not offline" on one side and as "unresolvable" on the other,
// so an offline city armed a retry the panel deliberately does not arm.
//
// The scheduler (weatherScheduler.js) owns the timers; this owns the policy
// about them. Subclasses keep only their own fetch and presentation.

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
// Which host is loading this file — asked of the host, not of require(). See
// worldclockData.js for why.
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const WeatherFormat = IS_NODE ?
    require("./weatherFormat") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherFormat;

var WeatherConsumer = class WeatherConsumer { // NOSONAR [S3504] -- GJS importer export
    // `scheduler` and `readingRepository` are built by the subclass, which is
    // the only side that knows what its period, its retry seconds and its
    // "there is something to refresh" test are. Whether the repository is this
    // consumer's own is decided here, because destroy() is what asks.
    constructor(params = {}) {
        this._destroyed = false; // NOSONAR [S7757] -- constructor state is the GJS-compatible class pattern
        this._generation = 0;
        // "always online" is the pre-monitor behavior; the composition root
        // injects the real Gio.NetworkMonitor-backed answer
        this._isOnline = params.isOnline || (() => true);
        this._scheduler = params.scheduler;
        this._reading_repository = params.readingRepository;
        this._owns_reading_repository = Boolean(params.ownsReadingRepository);
        // Which of the two this is, for the log. There are two weather
        // consumers and a bare "weather" line does not say which one stopped
        // working.
        this._log_name = params.logName;
        // the ceiling is news once per outage, not once per retry
        this._retry_ceiling_reported = false;
    }

    // The answer to a request nobody wants any more is not an answer. Both the
    // provider being destroyed and the settings having moved on retire it.
    _isCurrent(generation) {
        return !this._destroyed && generation === this._generation;
    }

    // The generation this request is answering for. Callers hold it and hand it
    // back to _isCurrent().
    _startRequest() {
        return ++this._generation;
    }

    stop() {
        this._generation++;
        this._scheduler.stop();
    }

    // A consumer that was handed a shared repository must not destroy it: the
    // composition root gives the panel and the cities the same one, so tearing
    // down one provider would take the other's HTTP session, geocode cache and
    // in-flight requests with it.
    destroy() {
        this._destroyed = true;
        this.stop();
        this._releaseHeldState();

        if (this._owns_reading_repository) {
            this._reading_repository.destroy();
        }
    }

    // What this consumer holds besides the repository. The panel keeps its last
    // reading in a display state it hands back to its presenter; the cities
    // keep a per-city store and a per-city error map, and drop both.
    _releaseHeldState() {}

    // One retry decision for both consumers.
    //
    // A service outage may recover before the normal period, so it is retried.
    // A name that both geocoders answered but could not resolve will not, and
    // neither will a missing network — whose recovery signal is the monitor's
    // flip, not a timer, and which is a state rather than a provider failure.
    _shouldRetry(error) {
        return Boolean(error) &&
            error !== WeatherFormat.WEATHER_ERRORS.LOCATION_NOT_FOUND &&
            error !== WeatherFormat.WEATHER_ERRORS.OFFLINE;
    }

    // Ask for a retry, and say so once when the ladder runs out. The scheduler
    // refuses either because there is nothing to refresh or because the budget
    // is spent — only the second is a transition worth a line, and only the
    // first time it happens. Discarding this answer, as the panel used to,
    // spends eight attempts and announces nothing.
    _retryFailedRefresh(refresh) {
        if (this._scheduler.retry(refresh)) {
            // the budget is live again after a recovery, so the next time it
            // runs out is news again
            this._retry_ceiling_reported = false;
            return;
        }

        if (!this._scheduler.retriesExhausted() || this._retry_ceiling_reported) {
            return;
        }
        this._retry_ceiling_reported = true;
        if (global.log) {
            global.log(this._log_name + ": still failing after " +
                WeatherFormat.MAX_RETRY_ATTEMPTS +
                " attempts; falling back to the normal refresh period");
        }
    }

    // Retry a failure worth retrying; otherwise the answer is accepted and the
    // backoff is cleared — including for offline, where succeeded() cancels a
    // backoff left over from a failure that has just become explainable.
    _settleRefresh(error, refresh) {
        if (this._shouldRetry(error)) {
            this._retryFailedRefresh(refresh);
            return;
        }
        this._scheduler.succeeded();
    }
};

if (typeof module !== "undefined") {
    module.exports = { WeatherConsumer };
}
