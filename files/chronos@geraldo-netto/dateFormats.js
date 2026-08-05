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
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const CinnamonDesktop = GjsImports.gi.CinnamonDesktop;
const LocaleText = IS_NODE ?
    require("./localeText") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].localeText;
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;
const DateMath = IS_NODE ?
    require("./dateMath") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].dateMath;
const translate = LocaleText.translate;

var MSECS_IN_DAY = DateMath.MSECS_IN_DAY; // NOSONAR [S3504] -- GJS importer export
var monthWindowStartOffset = DateMath.monthWindowStartOffset; // NOSONAR [S3504] -- GJS importer export
// Product limits for settings-controlled strftime input and any text it
// renders into compositor actors or accessibility metadata.
var MAX_DATE_FORMAT_LENGTH = 256; // NOSONAR [S3504] -- GJS importer export
var MAX_CLOCK_STAMP_LENGTH = 256; // NOSONAR [S3504] -- GJS importer export

var DAY_FORMAT = CinnamonDesktop.WallClock.lctime_format("cinnamon", "%A"); // NOSONAR [S3504] -- GJS importer export
var DATE_FORMAT_SHORT; // NOSONAR [S3504] -- GJS importer export
var DATE_FORMAT_FULL; // NOSONAR [S3504] -- GJS importer export
// The translated formats are strftime written by translators, and nothing
// checks their directives — xgettext does not mark them c-format, so msgfmt
// cannot. A broken msgstr makes get_clock_for_format answer null; the
// untranslated msgids are known-valid, so they stay beside the translations
// as render-time fallbacks.
var DATE_FORMAT_SHORT_FALLBACK = CinnamonDesktop.WallClock.lctime_format("cinnamon", "%B %-e, %Y"); // NOSONAR [S3504] -- GJS importer export
var DATE_FORMAT_FULL_FALLBACK = CinnamonDesktop.WallClock.lctime_format("cinnamon", "%A, %B %-e, %Y"); // NOSONAR [S3504] -- GJS importer export
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

function dateFormatWithinLimit(format) {
    return TextUtils.textWithinLimit(format, MAX_DATE_FORMAT_LENGTH);
}

function dateFormatOrDefault(format, fallback) {
    return dateFormatWithinLimit(format) ? format : fallback;
}

function clampClockStamp(stamp) {
    return TextUtils.clampText(stamp, MAX_CLOCK_STAMP_LENGTH);
}

// Translated date formats cross two trust boundaries: the msgstr supplies the
// strftime program, then the formatter supplies compositor text. Keep the
// fallback and output cap together so every presenter degrades identically.
function formatDateWithFallback(formatter, format, fallback = format) {
    const render = (candidate) => {
        const stamp = formatter(candidate);
        return typeof stamp === "string" && stamp ? clampClockStamp(stamp) : "";
    };
    const primary = render(format);
    if (primary) {
        return primary;
    }
    return render(fallback);
}

if (typeof module !== "undefined") {
    module.exports = {
        MSECS_IN_DAY,
        MAX_DATE_FORMAT_LENGTH,
        MAX_CLOCK_STAMP_LENGTH,
        DAY_FORMAT,
        DATE_FORMAT_SHORT,
        DATE_FORMAT_FULL,
        DATE_FORMAT_SHORT_FALLBACK,
        DATE_FORMAT_FULL_FALLBACK,
        monthWindowStartOffset,
        dateFormatWithinLimit,
        dateFormatOrDefault,
        clampClockStamp,
        formatDateWithFallback
    };
}
