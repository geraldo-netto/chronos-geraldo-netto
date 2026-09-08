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
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const ProviderUtils = IS_NODE ?
    require("./providerUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].providerUtils;
const Diagnostics = IS_NODE ?
    require("./diagnostics") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].diagnostics;

// What the chain reports when every provider raised rather than answering:
// attemptOrFail answers null for a raise, so there is no first failure to pass
// on and no empty result either. The callback forwards an optional receipt time, and
// HolidayService.addData reads a missing payload as SERVICE_UNAVAILABLE, which
// is what this is.
const NO_PROVIDER_OUTCOME = { data: null, params: null, retrieved: null };

var HolidayFallbackChain = class HolidayFallbackChain { // NOSONAR [S3504] -- GJS importer export
    // `validResponse` is what an answer from *any* provider in this chain has to
    // satisfy: the record shape the app owns, not the shape of whichever vendor
    // is primary today. It is required — a chain with no idea what a good answer
    // looks like cannot decide when to fall through to the next provider.
    constructor(primary, fallbacks, validResponse) {
        this.primary = primary;
        this.fallbacks = Array.isArray(fallbacks) ? fallbacks : [fallbacks];
        this._validResponse = validResponse;
        this._last_provider = "";
        // the owner tells the chain whether it is still wanted; by default it
        // always is, which is what a bare adapter in a test expects
        this._isAlive = () => true;
    }

    // Tearing the applet down aborts the HTTP session, which arrives here as
    // "this provider failed" and walks the chain on to the next one — issuing
    // fresh requests on the aborted session, and keeping it and every closure
    // behind it alive for the length of the timeout. The weather resolvers
    // already ask this question before continuing.
    setLivenessCheck(isAlive) {
        this._isAlive = typeof isAlive === "function" ? isAlive : () => true;
    }

    fetchYear(country, region, year, callback) {
        const state = { emptyResult: null, acceptedResults: new Set() };
        ProviderUtils.tryProvidersInOrder(
            this._orderedProviders(),
            (provider, onResult) => this._fetchProviderYear(
                provider, country, region, year, state, onResult),
            (result) => state.acceptedResults.has(result),
            (provider, result) => this._acceptProviderResult(
                provider, result, callback),
            (failure) => this._reportProviderFailure(
                country, region, year, failure, state.emptyResult, callback)
        );
    }

    _fetchProviderYear(provider, country, region, year, state, onResult) {
        provider.fetchYear(country, region, year, (data, params, retrieved, received = new Date().toISOString()) => {
            this._handleProviderResult(
                provider, year, data, params, retrieved, state, onResult, received);
        });
    }

    _handleProviderResult(provider, year, data, params, retrieved, state, onResult, received) {
        if (!this._isAlive()) {
            return;
        }
        const result = {
            data,
            params: this._sourceParams(provider, params),
            retrieved,
            received
        };
        const classification = this._classify(result, year);
        if (classification === "empty") {
            state.emptyResult = result;
            onResult(null);
            return;
        }
        if (classification === "success") {
            state.acceptedResults.add(result);
        }
        onResult(result);
    }

    _acceptProviderResult(provider, result, callback) {
        this._last_provider = provider.name;
        callback(result.data, result.params, result.retrieved, result.received);
    }

    _reportProviderFailure(country, region, year, failure, emptyResult, callback) {
        Diagnostics.logSafely("log", `all holiday providers failed for ${country}/${region}/${year}`);
        const outcome = failure || emptyResult || NO_PROVIDER_OUTCOME;
        callback(outcome.data, outcome.params, outcome.retrieved, outcome.received);
    }

    _orderedProviders() {
        const providers = [this.primary].concat(this.fallbacks);
        return ProviderUtils.orderProvidersByLastSuccess(providers, this._last_provider);
    }

    _sourceParams(provider, params) {
        if (!provider.name || (params && params.providerName === provider.name)) {
            return params;
        }

        return Object.assign({}, params || {}, {providerName: provider.name}); // NOSONAR [S6661] -- accepted compatible form
    }

    // The chain used to fall back to `this.primary.validResponse` when no
    // validator was given — so whichever provider happened to be first decided
    // what a valid answer from *all* of them looked like, and the port's
    // contract was one vendor's payload shape. The validator is the caller's,
    // and the caller is the thing that owns the record shape.
    _classify(result, requestedYear) {
        let valid = false;
        try {
            valid = Boolean(result) && this._validResponse(result.data, requestedYear);
        } catch (e) {
            Diagnostics.logSafely("logError", e);
        }

        if (!valid) {
            return "failure";
        }

        // An empty array is a well-formed payload — [].every() is vacuously
        // true — and Enrico returns one for the country/year pairs it does not
        // cover. Taken as an answer it ends the chain before the two providers
        // that would have answered, and marks the year fresh for the update
        // period: a holiday-free calendar, with no error, for 50 days. Let the
        // chain run instead; if every provider says empty, the exhausted path
        // hands the empty answer through and it is believed.
        return Array.isArray(result.data) && result.data.length === 0 ?
            "empty" : "success";
    }
};

if (typeof module !== "undefined") {
    module.exports = { HolidayFallbackChain };
}
