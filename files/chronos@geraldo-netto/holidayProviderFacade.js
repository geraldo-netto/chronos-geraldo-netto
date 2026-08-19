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

// The two presentation-facing decorators the composition root wraps a
// HolidayService in: the facade that narrows it to what the calendar grid uses,
// and the religious provider that merges the locally-computed observances into
// its answer. Neither touches HTTP, the cache or the provider chain — they take
// a provider and hand back a provider — which is why they are not in holidays.js
// beside the service that does.

const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
// asked once, as holidays.js asks it: one ternary for the whole preamble
const APPLET_MODULES = IS_NODE ?
    null : imports.ui.appletManager.applets["chronos@geraldo-netto"];

function sibling(name) {
    return APPLET_MODULES ? APPLET_MODULES[name] : require("./" + name); // NOSONAR [S7773] -- the Node guard is APPLET_MODULES
}

const HolidayConstants = sibling("holidayConstants");
const ReligiousHolidays = sibling("religiousHolidays");
const TextUtils = sibling("textUtils");

const GLOBAL_REGION = HolidayConstants.GLOBAL_REGION;
const HOLIDAY_ERRORS = HolidayConstants.HOLIDAY_ERRORS;

var HolidayProviderFacade = class HolidayProviderFacade { // NOSONAR [S3504] -- GJS importer export
    constructor(provider) {
        this._provider = provider;
    }

    get country() {
        return this._provider.country;
    }

    // whether this provider has anything to annotate: the calendar gates on
    // this, never on country-truthiness
    get active() {
        return Boolean(this._provider.country);
    }

    destroy() {
        this._provider.destroy();
    }

    clearPlace() {
        this._provider.clearPlace();
    }

    setPlace(country, region = GLOBAL_REGION, onUpdated) { // NOSONAR [S1788] -- accepted compatible form
        this._provider.setPlace(country, region, onUpdated);
    }

    getHolidays(year, month, callback) {
        this._provider.getHolidays(year, month, callback);
    }
};

// Decorates the facade with the locally-computed religious observances the
// catalogue module expands: the merged month keeps the public provider's
// names first, the way the cache joins same-day rows. The provider contract
// lives here, beside the facade it wraps. The catalogue is pure per call but
// not stateless -- it memoizes its year expansions at module scope, which is
// why teardown reaches into it below.
var ReligiousHolidayProvider = class ReligiousHolidayProvider { // NOSONAR [S3504] -- GJS importer export
    constructor(provider, enabledIds = [], translateName = (text) => text) {
        this._base = provider;
        this._translateName = translateName;
        this.setEnabledIds(enabledIds);
    }

    get country() {
        return this._base.country;
    }

    get active() {
        return this._base.active || this._enabledIds.length > 0;
    }

    setEnabledIds(enabledIds) {
        this._enabledIds = ReligiousHolidays.enabledReligionIds(enabledIds);
    }

    destroy() {
        this._base.destroy();
        // The catalogue's memos are module scope and shared by every applet
        // instance, so nothing else would ever drop them: without this they
        // outlive the last applet for the rest of the login session.
        ReligiousHolidays.releaseMemos();
    }

    clearPlace() {
        this._base.clearPlace();
    }

    setPlace(country, region, onUpdated) {
        this._base.setPlace(country, region, onUpdated);
    }

    // The observance tables cover a bounded window, and past its end a
    // table-backed religion rendered zero rows with no marker, no tooltip and
    // no status line — indistinguishable from a month that simply has none.
    // The provider status channel already reaches the month label, so say it
    // there. A real provider failure still wins: the network is the more
    // actionable problem, and the two would otherwise contend for one label.
    _coverageError(year) {
        return ReligiousHolidays.uncoveredReligions(TextUtils.numericInput(year), this._enabledIds)
            .length > 0 ? HOLIDAY_ERRORS.RELIGIOUS_DATES_UNAVAILABLE : "";
    }

    getHolidays(year, month, callback) {
        const religious = ReligiousHolidays.monthMap(
            year, month, this._enabledIds, this._translateName);
        const coverage = this._coverageError(year);
        if (!this._base.active) {
            callback(religious, coverage, "");
            return;
        }

        this._base.getHolidays(year, month, (publicHolidays, error, providerName) => {
            callback(ReligiousHolidays.mergeMonthMaps(publicHolidays, religious),
                error || coverage, providerName);
        });
    }
};

if (typeof module !== "undefined") {
    module.exports = { HolidayProviderFacade, ReligiousHolidayProvider };
}
