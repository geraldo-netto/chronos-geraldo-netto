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

var HolidayFallbackChain = class HolidayFallbackChain {
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
        Utils.tryProvidersInOrder(
            this._orderedProviders(),
            (provider, onResult) => {
                provider.fetchYear(country, region, year, (data, params, retrieved) => {
                    if (!this._isAlive()) {
                        return;
                    }

                    onResult({
                        data,
                        params: this._sourceParams(provider, params),
                        retrieved
                    });
                });
            },
            (result) => this._accept(result),
            (provider, result) => {
                this._last_provider = provider.name;
                callback(result.data, result.params, result.retrieved);
            },
            (failure) => {
                if (global.log) {
                    global.log(`all holiday providers failed for ${country}/${region}/${year}`);
                }
                callback(failure.data, failure.params, failure.retrieved);
            }
        );
    }

    _orderedProviders() {
        const providers = [this.primary].concat(this.fallbacks);
        return Utils.orderProvidersByLastSuccess(providers, this._last_provider);
    }

    _sourceParams(provider, params) {
        if (!provider.name || (params && params.providerName === provider.name)) {
            return params;
        }

        return Object.assign({}, params || {}, {providerName: provider.name});
    }

    // The chain used to fall back to `this.primary.validResponse` when no
    // validator was given — so whichever provider happened to be first decided
    // what a valid answer from *all* of them looked like, and the port's
    // contract was one vendor's payload shape. The validator is the caller's,
    // and the caller is the thing that owns the record shape.
    _accept(result) {
        let valid = false;
        try {
            valid = this._validResponse(result.data);
        } catch (e) {
            if (global.logError) {
                global.logError(e);
            }
        }

        if (!valid) {
            return false;
        }

        // An empty array is a well-formed payload — [].every() is vacuously
        // true — and Enrico returns one for the country/year pairs it does not
        // cover. Taken as an answer it ends the chain before the two providers
        // that would have answered, and marks the year fresh for the update
        // period: a holiday-free calendar, with no error, for 50 days. Let the
        // chain run instead; if every provider says empty, the exhausted path
        // hands the empty answer through and it is believed.
        return !Array.isArray(result.data) || result.data.length > 0;
    }
};

if (typeof module !== "undefined") {
    module.exports = { HolidayFallbackChain };
}
