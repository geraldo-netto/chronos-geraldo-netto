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
const Gio = GjsImports.gi.Gio;
const GLib = GjsImports.gi.GLib;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const ProviderUtils = IS_NODE ?
    require("./providerUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].providerUtils;
var MESSAGE_LANGUAGE_FALLBACK = "en"; // NOSONAR [S3504] -- GJS importer export
// `locale -k` answers in milliseconds when it answers at all; this is a
// deadline, not a budget
const LOCALE_TIMEOUT_SECONDS = 5;
// A query that fails is not a locale that will never work. `locale` wedges on a
// hung NSS or nscd lookup — classically at login, when the applet asks — and the
// old code marked the query "requested" before running it and never unmarked it
// on any failure path. The deadline fired, the defaults were stored, and the day
// abbreviations and weekend days stayed on the English/US defaults for the rest
// of the session, even though the lookup would have succeeded a minute later.
// The deadline is right; the permanent degradation is not.
const LOCALE_RETRY_SECONDS = 60;
const LOCALE_MAX_ATTEMPTS = 3;

// The locale query is asked once per process and its timers are module-level, so
// nothing owned them: the 5-second deadline and the 60-second retry were armed
// and never removable. Remove the applet a second after login, while `locale` is
// wedged on a hung NSS lookup, and the retry still spawns a subprocess up to two
// minutes after the applet is gone. Bounded and harmless — and unreapable, which
// is the part worth fixing.
const _pendingTimers = new Set();

function _scheduleTimeout(seconds, callback) {
    let id = 0;
    id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
        _pendingTimers.delete(id);
        return callback();
    });
    _pendingTimers.add(id);

    return id;
}

// The applet is multi-instance (`"max-instances": -1`), and everything below is
// process-wide, so a *per-instance* teardown must not cancel work the other
// instances are still waiting on. It used to: remove one of two applets while
// `locale -k LC_TIME` is still in flight — the first seconds after login, which
// is exactly when it is in flight — and the survivor's query was cancelled out
// from under it, counted as a failure, and burned one of its three attempts.
// Three of those and every instance in the process is pinned to the English
// defaults for the rest of the session. The instance that left paid nothing; the
// one that stayed paid everything.
//
// So instances are counted, and the queries are cancelled when the last one goes.
let _consumers = 0;

function registerLocaleConsumer() {
    _consumers++;
    if (_consumers !== 1) {
        return;
    }
    // The last teardown cancelled the armed retry with the other timers, and
    // the degraded gate admits only that retry — so an env that failed under
    // the previous consumer stayed on the defaults for the process lifetime
    // no matter how many attempts were left. A fresh first consumer resumes
    // the ladder where it stopped.
    Object.keys(degraded).forEach((env) => {
        if (degraded[env] && !(attempts[env] >= LOCALE_MAX_ATTEMPTS)) { // NOSONAR [S1940] -- mirrors _shouldAsk's cap guard
            _resumeLocaleQuery(env);
        }
    });
    // An env cancelled after the last consumer left is not degraded — that is
    // deliberate — so the loop above cannot see it, and every memo would stay
    // warm on the English defaults because `localeGeneration` never moved
    // either. It never failed; it was never finished. Ask again.
    Object.keys(unanswered).forEach((env) => {
        if (unanswered[env]) {
            unanswered[env] = false;
            _resumeLocaleQuery(env);
        }
    });
}

// One rule for every place that picks a query back up: a resume carries the
// env's degraded flag. `_shouldAsk` admits a degraded env only to its own armed
// retry, so a resume that forgets the flag is silently refused — which is
// exactly how an env already on the ladder used to stop being asked at all.
function _resumeLocaleQuery(env) {
    _requestInfo(env, Boolean(degraded[env]));
}

function _lastLocaleConsumerLeft() {
    if (_consumers === 0) {
        return true;
    }
    _consumers--;
    return _consumers === 0;
}

function _removePendingTimer(id) {
    try {
        GLib.source_remove(id);
    } catch (e) {
        if (global.logError) {
            global.logError(e);
        }
    }
}

function _cancelPendingTimers() {
    _pendingTimers.forEach(_removePendingTimer);
    _pendingTimers.clear();
}

// Every settle path gives back what the query was holding. Only the abandoned
// branch used to, so a successful or degraded query parked a finished
// Gio.Subprocess and its cancellable in the module for the life of the
// compositor — and left "is a query in flight?" answerable two ways that had to
// agree, with force_exit() on a reaped child as the cost of disagreeing. There
// is one record now, and holding it is what being in flight means.
function _releaseQuery(env) {
    requested[env] = false;
    delete _inflight[env];
}

function _cancelPendingRequest(env) {
    const query = _inflight[env];
    if (!query) {
        return;
    }
    // a cancel we asked for is not a locale that failed: without this the abort
    // lands in fail(), which degrades the env and spends an attempt, so removing
    // and re-adding the applet three times would leave the next one on the
    // English defaults with the retry ladder used up
    abandoned[env] = true;
    // The armed deadline was the only other holder of the process handle, and
    // the teardown just removed it with the rest of the timers. Cancelling the
    // read only stops us waiting: a genuinely wedged `locale` has to be
    // killed here too, or it lingers for the rest of the session.
    if (query.proc && query.proc.force_exit) { // NOSONAR [S6582] -- accepted compatible form
        query.proc.force_exit();
    }
    query.cancellable.cancel();
}

// Called from the applet's teardown. The locale cache itself is deliberately
// process-wide — a second applet on the panel should not re-run `locale` — so
// this cancels what is in flight rather than forgetting what was learned.
function cancelPendingLocaleQueries() {
    // another applet is still on the panel, still waiting on this query
    if (!_lastLocaleConsumerLeft()) {
        return;
    }
    _cancelPendingTimers();
    Object.keys(_inflight).forEach(_cancelPendingRequest);
}

const re = /^(\w+)=(.*)$/;
const DEFAULT_LOCALE_INFO = {
    LC_ADDRESS: {
        country_ab3: "usa",
        lang_ab: "en"
    },
    LC_TIME: {
        abday: "Sun;Mon;Tue;Wed;Thu;Fri;Sat",
        first_workday: 2
    }
};
const localeInfoCache = {};
// in flight right now
const requested = {};
// The query in flight for an env: its cancellable, so a teardown can stop the
// read, and its subprocess, so a teardown can kill a wedged child rather than
// merely stop reading from it. Present exactly while the query is unsettled.
const _inflight = {};
// holding defaults because the query failed, and how many times it has
const degraded = {};
const attempts = {};
// cancelled deliberately by the last instance's teardown, rather than failed
const abandoned = {};
// Envs whose query we cancelled on the way out and which no consumer was left
// to resume. The abandoned branch deliberately skips `_storeInfo` and leaves
// `degraded` unset — the ladder stays clean for the next applet — but that is
// also the set `registerLocaleConsumer` resumes from, so nothing remembered the
// env had been left mid-flight and it was never asked again for the session.
const unanswered = {};
const listeners = [];

function _defaultInfo(env) {
    return Object.assign({}, DEFAULT_LOCALE_INFO[env] || {}); // NOSONAR [S6661] -- accepted compatible form
}

// g_get_language_names() reads the same LC_ALL/LC_MESSAGES/LANG/LANGUAGE chain
// this used to walk by hand, in the order the C library defines, and is
// documented always to include the default locale "C" — so the list is never
// empty and its first entry is never falsy.
//
// The hand-walked fallback behind it was therefore dead in Cinnamon twice over:
// it could not be reached, and cjs has no `process` to read anyway. Only the
// harness took it, because the GLib stub had no get_language_names — so the one
// branch with a test was the one production cannot run, and the one production
// always runs had none. That is the shape worldclockData.js:88-92 condemns.
function hostMessageLocale() {
    return GLib.get_language_names()[0] || "";
}

// Display and request language follows the message locale, independently of
// LC_ADDRESS/LC_TIME regional formatting. Providers accept ISO 639-1 only.
function messageLanguage(locale) {
    const language = String(locale || hostMessageLocale())
        .toLowerCase().split(/[._@:-]/)[0];
    return (/^[a-z]{2}$/).test(language) ? language : MESSAGE_LANGUAGE_FALLBACK;
}

// values derived from locale info are memoized against this: they are all
// computed before the locale query answers, and must be recomputed after
var localeGeneration = 0; // NOSONAR [S3504] -- GJS importer export

// The locale keys we need have no GLib API, so they come from `locale -k`.
// That is a fork+exec: run it synchronously and the whole compositor stalls,
// so it runs asynchronously and callers get the defaults until it lands.
// Keyed by the env it is about.
//
// Every listener used to be told whenever *any* env answered, and the calendar's
// listener responds by rebuilding its whole header — destroy_all_children(),
// which drops the 42 day cells and every per-cell holiday tooltip with them, and
// then the next update rebuilds 42 Cinnamon.Stacks, 42 St.Buttons, 42
// GenericContainers and 84 signal connections. An unrelated locale category —
// historically LC_ADDRESS — could therefore tear the whole grid down when it
// answered. Scope each listener to the category its view actually consumes.
function onLocaleInfoChanged(env, callback) {
    const entry = { env, callback };
    listeners.push(entry);

    return () => {
        const index = listeners.indexOf(entry);
        if (index >= 0) {
            listeners.splice(index, 1);
        }
    };
}

// locale(1) decides string-versus-number by whether it happened to quote the
// value, so the type of a key was libc's choice rather than this module's. Real
// output carries unquoted-empty values — era= and alt_digits= on the machine
// this was found on — and parseInt turns those into NaN.
//
// Nothing consumes those two, but the contract on the two that are consumed was
// unenforced in both directions: 6.0/calendar.js does info.abday.split(";"),
// which throws inside a lazyLocaleValue memo on the compositor thread for any
// libc that emits abday unquoted-empty, and (info.first_workday + 6) % 7, which
// is NaN for one that quotes first_workday — silently marking every day a
// workday. DEFAULT_LOCALE_INFO already declares the shape of both.
function _typedValue(rawValue, declared) {
    const quoted = rawValue.length >= 2 && rawValue[0] === "\"" && // NOSONAR [S6557] -- accepted compatible form
        rawValue[rawValue.length - 1] === "\""; // NOSONAR [S6557,S7755] -- accepted compatible form
    const value = quoted ? rawValue.slice(1, -1) : rawValue;

    if (typeof declared === "string") {
        return value || null;
    }
    const number = Number(value);
    return value !== "" && Number.isInteger(number) ? number : null;
}

// DEFAULT_LOCALE_INFO is the schema, not only the fallback: a key it does not
// declare is dropped, and a value that will not parse to the declared type
// leaves the default in place rather than replacing it with NaN or undefined.
function _parseInfo(env, output) {
    const info = _defaultInfo(env);

    output.split("\n").forEach((line) => {
        const match = re.exec(line);
        if (!match || !Object.hasOwn(info, match[1])) {
            return;
        }

        const value = _typedValue(match[2], info[match[1]]);
        if (value !== null) {
            info[match[1]] = value;
        }
    });

    return info;
}

function _storeInfo(env, info) {
    localeInfoCache[env] = info;
    localeGeneration++;
    const callbacks = listeners.slice()
        .filter((entry) => entry.env === env)
        .map((entry) => entry.callback);
    ProviderUtils.notifyAll(callbacks);
}

// the query failed: keep the defaults, but do not pretend the question is
// settled. Another attempt is armed, up to a small cap.
function _degrade(env) {
    _releaseQuery(env);
    degraded[env] = true;
    attempts[env] = (attempts[env] || 0) + 1;

    if (attempts[env] < LOCALE_MAX_ATTEMPTS) {
        _scheduleTimeout(LOCALE_RETRY_SECONDS, () => {
            _requestInfo(env, true);
            return false;
        });
    }

    _storeInfo(env, _defaultInfo(env));
}

// `force` is the armed retry's key. Storing the defaults wakes every memo that
// reads the locale, and each one asks again — so without a gate, a failure would
// spawn `locale` afresh on the spot, fail again, and spin. Only the retry above
// may re-ask.
function _shouldAsk(env, force) {
    if (requested[env]) {
        return false;
    }
    // a real answer is final
    if (localeInfoCache[env] && !degraded[env]) {
        return false;
    }
    if (degraded[env] && !force) {
        return false;
    }

    return !(attempts[env] >= LOCALE_MAX_ATTEMPTS); // NOSONAR [S1940] -- accepted compatible form
}

// An abandoned query is unfinished, not failed. The last consumer left, but
// another applet can be added before Gio delivers the cancellation callback:
// its getInfo() sees the old request still in flight and cannot restart it, so
// clearing that request here is what makes a resume possible.
//
// Whoever is here to want it asks again immediately; with nobody left, the env
// is remembered so the next first consumer can. Both were true before for an
// env that had never failed — and neither was for one already on the retry
// ladder. That env is still flagged degraded (only a success clears it), so the
// unforced resume was refused by `_shouldAsk`, and because the immediate branch
// recorded nothing in `unanswered` the process was left with no route back:
// remove and re-add the applet while a retry is in flight and every locale
// value stayed on the English defaults, with attempts still unspent.
function _resumeAbandonedQuery(env) {
    if (_consumers === 0) {
        unanswered[env] = true;
        return;
    }

    _resumeLocaleQuery(env);
}

// The two ways a query ends, and the state each one leaves behind. Exactly one of
// them runs: whichever gets there first, the deadline or the answer.
function _settlers(env) {
    let settled = false;

    return {
        succeed(info) {
            if (settled) {
                return;
            }
            settled = true;
            _releaseQuery(env);
            degraded[env] = false;
            _storeInfo(env, info);
        },
        fail() {
            if (settled) {
                return;
            }
            settled = true;

            // we cancelled this ourselves on the way out: leave the attempt count
            // and the degraded flag alone, so the next applet to ask starts from a
            // clean ladder rather than one rung from permanent English
            if (abandoned[env]) {
                abandoned[env] = false;
                _releaseQuery(env);
                _resumeAbandonedQuery(env);
                return;
            }

            _degrade(env);
        },
        get settled() {
            return settled;
        }
    };
}

// `locale` can wedge — a hung NSS or nscd lookup is the classic way — and this is
// asked for once and never retried. Without a deadline the callback simply never
// fires: day names and the work week stay on the English defaults for the life of
// the session, nothing that waits on the locale is ever told, and the process is
// never reaped.
function _armDeadline(env, proc, cancellable, settlers) {
    _scheduleTimeout(LOCALE_TIMEOUT_SECONDS, () => {
        if (!settlers.settled) {
            // Cancelling the read only stops us waiting; the child keeps running.
            // A genuinely wedged `locale` has to be killed, or it lingers past the
            // applet.
            if (proc.force_exit) {
                proc.force_exit();
            }
            cancellable.cancel();
            if (global.logError) {
                global.logError("locale -k " + env + " did not answer; using the defaults");
            }
            settlers.fail();
        }
        return false;
    });
}

function _finishLocaleOutput(env, source, result) {
    const [ok, output] = source.communicate_utf8_finish(result);
    return ok && output ? _parseInfo(env, output) : null;
}

function _settleLocaleOutput(env, source, result, settlers) {
    let info;
    try {
        info = _finishLocaleOutput(env, source, result);
    } catch (e) {
        // The last consumer deliberately killed and cancelled this query during
        // teardown. Gio still requires the completion to be finished, and that
        // finish raises cancellation: settle its ownership below, but do not
        // report the teardown we requested as a runtime failure.
        if (!abandoned[env] && global.logError) {
            global.logError(e);
        }
        settlers.fail();
        return;
    }

    // Notification happens outside the parsing catch: listener exceptions are
    // consumer failures, not a failed locale subprocess.
    if (info) {
        settlers.succeed(info);
    } else {
        settlers.fail();
    }
}

function _readLocaleOutput(env, proc, cancellable, settlers) {
    proc.communicate_utf8_async(null, cancellable, (source, result) => {
        _settleLocaleOutput(env, source, result, settlers);
    });
}

function _handleRequestFailure(env, settlers, error) {
    if (settlers?.settled) {
        throw error;
    }
    if (global.logError) {
        global.logError(error);
    }
    if (settlers) {
        settlers.fail();
    } else {
        _degrade(env);
    }
}

function _requestInfo(env, force = false) {
    if (!_shouldAsk(env, force)) {
        return;
    }
    requested[env] = true;
    let settlers = null;

    try {
        // argv form: no shell, no interpolation
        const proc = new Gio.Subprocess({
            argv: ["locale", "-k", env],
            flags: Gio.SubprocessFlags.STDOUT_PIPE
        });
        proc.init(null);

        const cancellable = new Gio.Cancellable();
        _inflight[env] = { cancellable, proc };
        settlers = _settlers(env);

        _readLocaleOutput(env, proc, cancellable, settlers);
        if (!settlers.settled) {
            _armDeadline(env, proc, cancellable, settlers);
        }
    } catch (e) {
        _handleRequestFailure(env, settlers, e);
    }
}

function getInfo (env) {
    _requestInfo(env);

    return localeInfoCache[env] || _defaultInfo(env);
}

// the locale query answers after the first paint, so a value picked from it
// is recomputed once the real info lands instead of staying at the default
function lazyLocaleValue(env, pick) {
    let value = null;
    let generation = -1;
    return () => {
        if (value === null || generation !== localeGeneration) {
            value = pick(getInfo(env));
            generation = localeGeneration;
        }
        return value;
    };
}

if (typeof module !== "undefined") {
    module.exports = {
        registerLocaleConsumer,
        cancelPendingLocaleQueries,
        onLocaleInfoChanged,
        lazyLocaleValue,
        MESSAGE_LANGUAGE_FALLBACK,
        messageLanguage,
        getInfo
    };
}
