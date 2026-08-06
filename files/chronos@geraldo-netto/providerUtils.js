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
// findExtensionSubdirectory has already repointed at the 6.0/ directory — and the
// applet would fail to load, because localeUtils.js is not in there.
//
// Node is what this asks about, because Node is the only host that requires these
// files directly. Cinnamon's cjs has no `process`.
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;

const urlForLog = TextUtils.urlForLog;

// Exponential backoff with a ceiling and jitter — the one copy.
//
// This was written four times: the panel weather, the city weather, the EDS
// server reconnect and the month-fetch retry. Two of the four had jitter and
// two did not, and one of the two without it was the city weather — the place
// the argument is strongest, since a single failed round is up to eight cities
// retrying at once. The comment explaining why jitter exists sat above a copy
// that had it, three files away from the copies that did not.
//
// Jitter is added on top of the capped backoff rather than folded into it: at
// the ceiling, capping the total would truncate the spread to nothing, which is
// exactly when every instance is retrying in lockstep and the spread matters.
//
// `random` is injectable so a test can observe the jitter instead of asserting
// bounds so loose that deleting the jitter still passes them.
function backoffDelay(attempt, params) {
    const base = params.base;
    const cap = params.cap;
    const jitter = params.jitter === undefined ? base : params.jitter;
    const random = params.random || Math.random;

    const backoff = Math.min(base * Math.pow(2, Math.max(0, attempt)), cap);
    return backoff + Math.floor(random() * jitter);
}

// Shared "try each provider, prefer the last one that worked" machinery
// used by the weather and holiday fallback chains.
function orderProvidersByLastSuccess(providers, lastName) {
    if (!lastName) {
        return providers;
    }

    return providers.slice().sort((a, b) => {
        if (a.name === lastName) {
            return -1;
        }
        if (b.name === lastName) {
            return 1;
        }
        return 0;
    });
}

// attempt(provider, onResult) runs one provider and reports its result;
// accept(result) decides success. The first failure is retained and
// reported to onExhausted when every provider failed.
//
// A provider with no name used to be logged by its raw URL, and a geocode URL
// carries the location the user typed — so a failing geocode wrote their city,
// or their world clock's name, into the Cinnamon log in cleartext. The query
// string is exactly what urlForLog exists to strip.
function providerName(provider) {
    if (!provider) {
        return "unknown provider";
    }

    if (provider.name) {
        return provider.name;
    }

    return provider.url ? urlForLog(provider.url) : "unknown provider";
}

function logProviderFailover(provider) {
    if (typeof global !== "undefined" && global.log) {
        global.log(`provider ${providerName(provider)} failed; trying next provider`);
    }
}

// Failing over is the whole point of this chain, and a provider that raises
// rather than answering used to be the one failure it could not survive: the
// throw unwound every pending step and neither onSuccess nor onExhausted ever
// ran, so the caller was left waiting on a chain that had stopped.
//
// A raise before the provider answered is that provider's failure, and reported
// as one. A throw travelling back out through an attempt that already answered
// belongs to onSuccess, onExhausted or a later step, and is left alone.
function attemptOrFail(attempt, provider, onResult) {
    let answered = false;
    const answer = (result) => {
        answered = true;
        onResult(result);
    };

    try {
        attempt(provider, answer);
    } catch (e) {
        if (answered) {
            throw e;
        }
        if (typeof global !== "undefined" && global.logError) {
            global.logError(e);
        }
        answer(null);
    }
}

function tryProvidersInOrder(providers, attempt, accept, onSuccess, onExhausted) {
    const step = (index, firstFailure) => {
        const provider = providers[index];
        attemptOrFail(attempt, provider, (result) => {
            if (accept(result)) {
                onSuccess(provider, result);
                return;
            }

            const failure = firstFailure || result;
            if (index + 1 < providers.length) {
                logProviderFailover(provider);
                step(index + 1, failure);
                return;
            }

            onExhausted(failure);
        });
    };

    step(0, null);
}

if (typeof module !== "undefined") {
    module.exports = {
        backoffDelay,
        providerName,
        orderProvidersByLastSuccess,
        tryProvidersInOrder
    };
}
