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

function _cancelPendingRequest(env) {
    if (!requested[env] || !_cancellables[env]) {
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
    if (_subprocesses[env] && _subprocesses[env].force_exit) {
        _subprocesses[env].force_exit();
    }
    _cancellables[env].cancel();
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
    Object.keys(requested).forEach(_cancelPendingRequest);
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
// the cancellable of the query in flight, so a teardown can stop it
const _cancellables = {};
// the subprocess in flight, so a teardown can kill a wedged child rather than
// merely stop reading from it
const _subprocesses = {};
// holding defaults because the query failed, and how many times it has
const degraded = {};
const attempts = {};
// cancelled deliberately by the last instance's teardown, rather than failed
const abandoned = {};
const listeners = [];

function _defaultInfo(env) {
    return Object.assign({}, DEFAULT_LOCALE_INFO[env] || {}); // NOSONAR [S6661] -- accepted compatible form
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
// GenericContainers and 84 signal connections. LC_ADDRESS is asked for only to
// pick the holiday provider's language, and nothing in the header depends on it —
// yet its arrival tore the whole grid down. One spurious full-grid rebuild per
// session, and up to three more if `locale -k` degrades and retries.
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

function _parseInfo(env, output) {
    const info = _defaultInfo(env);

    output.split("\n").forEach((line) => {
        const match = re.exec(line);
        if (!match) {
            return;
        }

        const [, key, rawValue] = match;

        if (rawValue.length >= 2 && rawValue[0] === "\"" && // NOSONAR [S6557] -- accepted compatible form
            rawValue[rawValue.length - 1] === "\"") { // NOSONAR [S6557,S7755] -- accepted compatible form
            info[key] = rawValue.slice(1, -1);
        } else {
            info[key] = parseInt(rawValue, 10); // NOSONAR [S7773] -- accepted compatible form
        }
    });

    return info;
}

function _storeInfo(env, info) {
    localeInfoCache[env] = info;
    localeGeneration++;
    listeners.slice()
        .filter((entry) => entry.env === env)
        .forEach((entry) => entry.callback());
}

// the query failed: keep the defaults, but do not pretend the question is
// settled. Another attempt is armed, up to a small cap.
function _degrade(env) {
    requested[env] = false;
    degraded[env] = true;
    attempts[env] = (attempts[env] || 0) + 1;

    _storeInfo(env, _defaultInfo(env));

    if (attempts[env] >= LOCALE_MAX_ATTEMPTS) {
        return;
    }

    _scheduleTimeout(LOCALE_RETRY_SECONDS, () => {
        _requestInfo(env, true);
        return false;
    });
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
            requested[env] = false;
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
                requested[env] = false;
                delete _cancellables[env];
                delete _subprocesses[env];
                // The last consumer left, but another applet can be added before
                // Gio delivers the cancellation callback. Its getInfo() sees the
                // old request in flight and cannot restart it; once this callback
                // clears that request, resume it for the replacement consumer.
                if (_consumers > 0) {
                    _requestInfo(env);
                }
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

function _readLocaleOutput(env, proc, cancellable, settlers) {
    proc.communicate_utf8_async(null, cancellable, (source, result) => {
        try {
            const [ok, output] = source.communicate_utf8_finish(result);
            if (ok && output) {
                settlers.succeed(_parseInfo(env, output));
            } else {
                settlers.fail();
            }
        } catch (e) {
            if (global.logError) {
                global.logError(e);
            }
            settlers.fail();
        }
    });
}

function _requestInfo(env, force = false) {
    if (!_shouldAsk(env, force)) {
        return;
    }
    requested[env] = true;

    try {
        // argv form: no shell, no interpolation
        const proc = new Gio.Subprocess({
            argv: ["locale", "-k", env],
            flags: Gio.SubprocessFlags.STDOUT_PIPE
        });
        proc.init(null);

        const cancellable = new Gio.Cancellable();
        _cancellables[env] = cancellable;
        _subprocesses[env] = proc;
        const settlers = _settlers(env);

        _armDeadline(env, proc, cancellable, settlers);
        _readLocaleOutput(env, proc, cancellable, settlers);
    } catch (e) {
        if (global.logError) {
            global.logError(e);
        }
        _degrade(env);
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
        getInfo
    };
}
