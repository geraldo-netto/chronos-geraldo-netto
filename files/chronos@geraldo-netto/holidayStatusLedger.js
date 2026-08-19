// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// It has no dependencies at all, which is why it is a file: it was one of four
// unrelated classes inside the holidays.js barrel, where any change to it cost
// an edit to the barrel's re-export list, to its module.exports and to the
// export-name assertion in the suite.

// The outcome of the last fetch for a year+region: what the month label shows.
//
// HolidayService kept this as a bare object and pruned it by hand, alongside the HTTP
// session, the provider chain, the cache repository, the cache, the inflight
// map, the place-generation counter, the staleness policy and the validation
// policy. It is a small thing with a rule of its own — the key carries no
// country, so it must be cleared whenever the place changes — and that rule is
// easier to see, and to test, on its own.
var HolidayStatusLedger = class HolidayStatusLedger { // NOSONAR [S3504] -- GJS importer export
    constructor() {
        this._status = {};
        this.lastError = "";
        this.lastProvider = "";
    }

    for(key) {
        return this._status[key] || { error: "", provider: "" };
    }

    record(key) {
        this._status[key] = {
            error: this.lastError,
            provider: this.lastProvider
        };
    }

    // The inflight entry deletes itself when the fetch lands; the status beside
    // it stays, one entry per year+region ever browsed. The cache evicts years
    // LRU-style, so the status follows the years the cache still stamps: pruning
    // by calendar distance instead deleted the record the moment it was written
    // for any year past the persist window, while the attempt stamp it belonged
    // to lived on and suppressed the refetch — a failure two years out rendered
    // a bare month with no warning at all.
    prune(liveYears) {
        const keep = new Set(liveYears.map(Number));

        Object.keys(this._status).forEach((key) => {
            if (!keep.has(Number(key.split("/")[0]))) {
                delete this._status[key];
            }
        });
    }

    clear() { // NOSONAR [S4144] -- distinct provider contract
        this._status = {};
        this.lastError = "";
        this.lastProvider = "";
    }
};

if (typeof module !== "undefined") {
    module.exports = { HolidayStatusLedger };
}
