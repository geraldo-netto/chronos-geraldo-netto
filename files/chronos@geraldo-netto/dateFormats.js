/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const CinnamonDesktop = GjsImports.gi.CinnamonDesktop;
const LocaleText = typeof require === "function" ?
    require("./localeText") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].localeText;
const translate = LocaleText.translate;

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

// days to step back from a month's first day to reach the start of the
// calendar grid. isoWeekDay is GLib's 1=Mon..7=Sun; weekStart is
// Cinnamon.util_get_week_start()'s 0=Sun..6=Sat.
function monthWindowStartOffset (isoWeekDay, weekStart) {
    return ((isoWeekDay % 7) - weekStart + 7) % 7;
}

if (typeof module !== "undefined") {
    module.exports = {
        MSECS_IN_DAY,
        DAY_FORMAT,
        DATE_FORMAT_SHORT,
        DATE_FORMAT_FULL,
        monthWindowStartOffset
    };
}
