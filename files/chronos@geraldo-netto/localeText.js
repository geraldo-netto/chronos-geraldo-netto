/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const GLib = GjsImports.gi.GLib;
const Gettext = GjsImports.gettext;
const UUID = "chronos@geraldo-netto";

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

if (typeof module !== "undefined") {
    module.exports = { translate, translatePlural, joinPhrases, localeDirectory };
}
