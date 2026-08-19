// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// No dependencies, one rule, tested standalone: a file rather than a class in
// the middle of the holidays.js barrel.

// The fetches in flight, and who is waiting for each. The 42-day grid always
// spans two months, so the second one asks for a year whose fetch is already
// running: it joins that one rather than issuing a second request.
var HolidayInflight = class HolidayInflight { // NOSONAR [S3504] -- GJS importer export
    constructor() {
        this._waiting = {};
    }

    has(key) {
        return Boolean(this._waiting[key]);
    }

    // Every entry is tagged with the place generation that started it, and only
    // that generation can settle it.
    //
    // Without the tag: change country mid-fetch, and the old (BR) response lands
    // after setPlace() has already emptied this map and the new (FR) request has
    // refilled it under the same `${year}/${region}` key. The old response then
    // deleted the *new* request's entry — so the FR response found no callbacks
    // and nothing repainted, and `fetching()` answered false while a request was
    // still live, which fired a duplicate. The month stayed on the old country's
    // holidays until the user scrolled a month or reopened the menu.
    //
    // returns true when this call started the fetch, false when it joined one
    start(key, callback, generation = 0) {
        const entry = this._waiting[key];
        if (entry) {
            if (callback) {
                entry.callbacks.push(callback);
            }
            return false;
        }

        this._waiting[key] = {
            generation,
            callbacks: callback ? [callback] : []
        };
        return true;
    }

    // a response for a generation that is no longer current owns nothing here:
    // it takes no callbacks and, crucially, removes nothing
    settle(key, generation = 0) {
        const entry = this._waiting[key];
        if (!entry || entry.generation !== generation) { // NOSONAR [S6582] -- accepted compatible form
            return [];
        }

        delete this._waiting[key];
        return entry.callbacks;
    }

    clear() {
        this._waiting = {};
    }
};

if (typeof module !== "undefined") {
    module.exports = { HolidayInflight };
}
