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
const translate = LocaleText.translate;

var MSECS_IN_DAY = 24 * 60 * 60 * 1000; // NOSONAR [S3504] -- GJS importer export
// Product limits for settings-controlled strftime input and any text it
// renders into compositor actors or accessibility metadata.
var MAX_DATE_FORMAT_LENGTH = 256; // NOSONAR [S3504] -- GJS importer export
var MAX_CLOCK_STAMP_LENGTH = 256; // NOSONAR [S3504] -- GJS importer export

var DAY_FORMAT = CinnamonDesktop.WallClock.lctime_format("cinnamon", "%A"); // NOSONAR [S3504] -- GJS importer export
var DATE_FORMAT_SHORT; // NOSONAR [S3504] -- GJS importer export
var DATE_FORMAT_FULL; // NOSONAR [S3504] -- GJS importer export
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

// days to step back from a month's first day to reach the start of the
// calendar grid. isoWeekDay is GLib's 1=Mon..7=Sun; weekStart is
// Cinnamon.util_get_week_start()'s 0=Sun..6=Sat.
function monthWindowStartOffset (isoWeekDay, weekStart) {
    return ((isoWeekDay % 7) - weekStart + 7) % 7;
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

if (typeof module !== "undefined") {
    module.exports = {
        MSECS_IN_DAY,
        MAX_DATE_FORMAT_LENGTH,
        MAX_CLOCK_STAMP_LENGTH,
        DAY_FORMAT,
        DATE_FORMAT_SHORT,
        DATE_FORMAT_FULL,
        monthWindowStartOffset,
        dateFormatWithinLimit,
        dateFormatOrDefault,
        clampClockStamp
    };
}
