/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IoUtils = typeof require === "function" ?
    require("./ioUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].ioUtils;

const urlForLog = IoUtils.urlForLog;

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

function tryProvidersInOrder(providers, attempt, accept, onSuccess, onExhausted) {
    const step = (index, firstFailure) => {
        const provider = providers[index];
        attempt(provider, (result) => {
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
