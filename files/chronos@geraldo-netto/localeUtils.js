/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const CinnamonDesktop = GjsImports.gi.CinnamonDesktop;
const Gio = GjsImports.gi.Gio;
const GLib = GjsImports.gi.GLib;
const IoUtils = typeof require === "function" ?
    require("./ioUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].ioUtils;
const decodeUtf8 = IoUtils.decodeUtf8;
const Gettext = GjsImports.gettext;
const UUID = "chronos@geraldo-netto";

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

// Called from the applet's teardown. The locale cache itself is deliberately
// process-wide — a second applet on the panel should not re-run `locale` — so
// this cancels what is in flight rather than forgetting what was learned.
function cancelPendingLocaleQueries() {
    if (_consumers > 0) {
        _consumers--;
        // another applet is still on the panel, still waiting on this query
        if (_consumers > 0) {
            return;
        }
    }

    for (const id of _pendingTimers) {
        try {
            GLib.source_remove(id);
        } catch (e) {
            if (global.logError) {
                global.logError(e);
            }
        }
    }
    _pendingTimers.clear();

    for (const env of Object.keys(requested)) {
        if (requested[env] && _cancellables[env]) {
            // a cancel we asked for is not a locale that failed: without this the
            // abort lands in fail(), which degrades the env and spends an attempt,
            // so removing and re-adding the applet three times would leave the
            // next one on the English defaults with the retry ladder used up
            abandoned[env] = true;
            _cancellables[env].cancel();
        }
    }
}

// The applet can be installed per-user or system-wide, and its catalogs follow
// it. bindtextdomain *replaces* the search path, so binding only to $HOME meant
// a system-wide install (/usr/share/cinnamon/applets, catalogs in
// /usr/share/locale) resolved nothing and every string fell back to English.
// Where the applet itself lives is what says which of the two it is.
function localeDirectory() {
    const home = GLib.get_home_dir();
    const appletManager = GjsImports.ui && GjsImports.ui.appletManager;
    const meta = appletManager && appletManager.appletMeta ?
        appletManager.appletMeta[UUID] : null;
    const installedPath = meta && typeof meta.path === "string" ? meta.path : "";

    if (installedPath && home && !installedPath.startsWith(home)) {
        return "/usr/share/locale";
    }

    return home + "/.local/share/locale";
}

if (Gettext && Gettext.bindtextdomain) {
    Gettext.bindtextdomain(UUID, localeDirectory());
}

// The applet's own translation domain, and only that one.
//
// This used to fall back to Cinnamon's domain when our catalog had no entry,
// which is a lookup by English word rather than by meaning — and the words are
// not ours to reuse. "Fair" is the sharpest case: untranslated in all 15 of our
// catalogs, it fell through to Cinnamon's, which translates it as a *quality
// rating* — de "Ausreichend" (adequate), fr "Moyen" (average), es "Normal". A
// German user with weather on was told the sky was adequate. "Clear", "Rain",
// "Snow", "Week" carry the same risk.
//
// The fallback bought almost nothing: of the 32 msgids de.po leaves
// untranslated, Cinnamon's domain answers two — one of them being that wrong
// "Fair". Everything genuinely shared with the stock calendar ("No Events",
// "All day", "Date and Time Settings") is already translated in our own
// catalogs. Falling back to English says "not translated yet"; falling back to
// another domain says something else, confidently.
var translate = (Gettext && Gettext.dgettext) ?
    function(str) {
        return Gettext.dgettext(UUID, str);
    } :
    (typeof _ === "undefined" ? function(str) { return str; } : _);

var translatePlural = (Gettext && Gettext.dngettext) ?
    function(singular, plural, n) {
        return Gettext.dngettext(UUID, singular, plural, n);
    } :
    function(singular, plural, n) {
        return n === 1 ? singular : plural;
    };

// Accessible names are built from parts — a date, then its holiday; a reading,
// then the words for it — and the parts were glued together with a hardcoded
// " — ". A translator could neither reorder them nor change the separator,
// because the separator never appeared in a msgid. This is that separator, and
// it is one msgid for every site that joins.
function joinPhrases(...parts) {
    // local, not module-scope: a module-level `const _` would shadow the GJS
    // global `_` that the translate fallbacks above read, from the top of the
    // file. xgettext scans text, so it finds the msgid either way.
    const _ = translate;
    const kept = parts.filter((part) => part || part === 0).map(String);
    if (kept.length === 0) {
        return "";
    }

    return kept.reduce((left, right) => _fillTemplate(_("%s — %s"), [left, right]));
}

// The parts are an event summary from whatever ICS or CalDAV feed the user
// subscribed to, a holiday name from a third-party service, and a provider's own
// error string. They were passed as the *replacement* argument of
// String.prototype.replace, where `$&`, `` $` ``, `$'` and `$1` are expanded as
// replacement patterns — so a summary containing $& was announced with the
// matched text spliced into it.
//
// Worse, and much easier to hit: the substitutions were chained, so the second
// .replace("%s", right) scanned the string the first one had already built. An
// event called "50%sale" made the screen reader announce
// "10:00 — 50In progressale — %s".
//
// A function replacement expands nothing, and the template is scanned once: a %s
// inside a substituted value is text, not a placeholder.
function _fillTemplate(template, values) {
    let index = 0;

    return template.replace(/%s/g, () =>
        index < values.length ? values[index++] : "%s");
}

var MSECS_IN_DAY = 24 * 60 * 60 * 1000;

var DAY_FORMAT = CinnamonDesktop.WallClock.lctime_format("cinnamon", "%A");
var DATE_FORMAT_SHORT;
var DATE_FORMAT_FULL;
{
    // cinnamon-xlet-makepot extracts only the _() keyword, so these two date
    // formats were invisible to translators under the bare translate() name and
    // every locale was stuck with the US month-day-year order. Alias locally,
    // not at module scope, for the same reason joinPhrases does: a module-level
    // `const _` would shadow the GJS global `_` the translate fallbacks read.
    const _ = translate;
    DATE_FORMAT_SHORT = CinnamonDesktop.WallClock.lctime_format("cinnamon", _("%B %-e, %Y"));
    DATE_FORMAT_FULL = CinnamonDesktop.WallClock.lctime_format("cinnamon", _("%A, %B %-e, %Y"));
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
// holding defaults because the query failed, and how many times it has
const degraded = {};
const attempts = {};
// cancelled deliberately by the last instance's teardown, rather than failed
const abandoned = {};
const listeners = [];

function _defaultInfo(env) {
    return Object.assign({}, DEFAULT_LOCALE_INFO[env] || {});
}

// values derived from locale info are memoized against this: they are all
// computed before the locale query answers, and must be recomputed after
var localeGeneration = 0;

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

    // communicate_utf8_finish() answers with a string, as its name says — the
    // bytes have already been decoded. Handing that to a TextDecoder throws
    // ("Provided input cannot be converted to ArrayBufferView"), the throw was
    // caught, and the locale silently fell back to English day names and a US
    // work week. Older GJS handed back a byte array here, so take either.
    const text = typeof output === "string" ? output : decodeUtf8(output);

    text.split("\n").forEach((line) => {
        const match = re.exec(line);
        if (!match) {
            return;
        }

        const [, key, rawValue] = match;

        if (rawValue.length >= 2 && rawValue[0] === "\"" &&
            rawValue[rawValue.length - 1] === "\"") {
            info[key] = rawValue.slice(1, -1);
        } else {
            info[key] = parseInt(rawValue, 10);
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
function _requestInfo(env, force = false) {
    if (requested[env]) {
        return;
    }
    // a real answer is final
    if (localeInfoCache[env] && !degraded[env]) {
        return;
    }
    if (degraded[env] && !force) {
        return;
    }
    if (attempts[env] >= LOCALE_MAX_ATTEMPTS) {
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

        // `locale` can wedge — a hung NSS or nscd lookup is the classic way —
        // and this is asked for once and never retried. Without a deadline the
        // callback simply never fires: day names and the work week stay on the
        // English defaults for the life of the session, nothing that waits on
        // the locale is ever told, and the process is never reaped.
        const cancellable = new Gio.Cancellable();
        _cancellables[env] = cancellable;
        let settled = false;
        const succeed = (info) => {
            if (settled) {
                return;
            }
            settled = true;
            requested[env] = false;
            degraded[env] = false;
            _storeInfo(env, info);
        };
        const fail = () => {
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
                return;
            }

            _degrade(env);
        };

        _scheduleTimeout(LOCALE_TIMEOUT_SECONDS, () => {
            if (!settled) {
                cancellable.cancel();
                if (global.logError) {
                    global.logError("locale -k " + env + " did not answer; using the defaults");
                }
                fail();
            }
            return false;
        });

        proc.communicate_utf8_async(null, cancellable, (source, result) => {
            try {
                const [ok, output] = source.communicate_utf8_finish(result);
                if (ok && output) {
                    succeed(_parseInfo(env, output));
                } else {
                    fail();
                }
            } catch (e) {
                if (global.logError) {
                    global.logError(e);
                }
                fail();
            }
        });
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

// days to step back from a month's first day to reach the start of the
// calendar grid. isoWeekDay is GLib's 1=Mon..7=Sun; weekStart is
// Cinnamon.util_get_week_start()'s 0=Sun..6=Sat.
function monthWindowStartOffset (isoWeekDay, weekStart) {
    return ((isoWeekDay % 7) - weekStart + 7) % 7;
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
        cancelPendingLocaleQueries,
        registerLocaleConsumer,
        joinPhrases,
        MSECS_IN_DAY,
        DAY_FORMAT,
        DATE_FORMAT_SHORT,
        DATE_FORMAT_FULL,
        translate,
        translatePlural,
        monthWindowStartOffset,
        lazyLocaleValue,
        onLocaleInfoChanged
    };
}
