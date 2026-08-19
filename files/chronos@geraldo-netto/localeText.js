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
const GLib = GjsImports.gi.GLib;
const Gettext = GjsImports.gettext;
// Which host is loading this file — asked of the host, not of require(): Cinnamon
// master sets globalThis.require, so a require() probe inverts there. See the
// full rationale in worldclockData.js.
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;
const UUID = "chronos@geraldo-netto";

// The applet can be installed per-user or system-wide, and its catalogs follow
// it. bindtextdomain *replaces* the search path, so binding only to $HOME meant
// a system-wide install (/usr/share/cinnamon/applets, catalogs in
// /usr/share/locale) resolved nothing and every string fell back to English.
// Where the applet itself lives is what says which of the two it is.
function localeDirectory() {
    const home = GLib.get_home_dir();
    const appletManager = GjsImports.ui && GjsImports.ui.appletManager; // NOSONAR [S6582] -- accepted compatible form
    const meta = appletManager && appletManager.appletMeta ? // NOSONAR [S6582] -- accepted compatible form
        appletManager.appletMeta[UUID] : null;
    const installedPath = meta && typeof meta.path === "string" ? meta.path : "";

    if (installedPath && home && !installedPath.startsWith(home)) {
        return "/usr/share/locale";
    }

    return home + "/.local/share/locale";
}

if (Gettext && Gettext.bindtextdomain) { // NOSONAR [S6582] -- accepted compatible form
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
var translate = (Gettext && Gettext.dgettext) ? // NOSONAR [S3504,S6582] -- GJS importer export
    function(str) {
        return Gettext.dgettext(UUID, str);
    } :
    (typeof _ === "undefined" ? function(str) { return str; } : _); // NOSONAR [S3358] -- accepted compatible form

var translatePlural = (Gettext && Gettext.dngettext) ? // NOSONAR [S3504,S6582] -- GJS importer export
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

    return kept.reduce((left, right) => TextUtils.fillTemplate(_("%s — %s"), [left, right])); // NOSONAR [S6959] -- nonempty input is guarded
}

if (typeof module !== "undefined") {
    module.exports = { translate, translatePlural, joinPhrases, localeDirectory };
}
