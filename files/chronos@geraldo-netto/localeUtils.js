/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;

// This file held six jobs: the gettext binding and its install-path resolution,
// the `locale -k` subprocess state machine with its process-global mutable maps
// and module-level timers, the strftime date-format constants, MSECS_IN_DAY, the
// pure calendar date math, and the accessible-name template helpers. Every module
// that wanted translate() — worldclockData, the grid, the event view, the world
// clocks — linked the subprocess machinery, its pending-timer set and its
// cross-instance consumer counter with it, and that process-wide mutable state is
// what produced the multi-instance teardown bugs the comments in localeQuery
// describe. The three jobs are three modules now.
//
// The aliases are how they reach a GJS consumer: the importer exposes a module's
// top-level var and function declarations, so a name has to be declared here to
// be readable off this module.
const LocaleText = typeof require === "function" ?
    require("./localeText") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].localeText;
const LocaleQuery = typeof require === "function" ?
    require("./localeQuery") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].localeQuery;
const DateFormats = typeof require === "function" ?
    require("./dateFormats") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].dateFormats;

var translate = LocaleText.translate;
var translatePlural = LocaleText.translatePlural;
var joinPhrases = LocaleText.joinPhrases;

var registerLocaleConsumer = LocaleQuery.registerLocaleConsumer;
var cancelPendingLocaleQueries = LocaleQuery.cancelPendingLocaleQueries;
var onLocaleInfoChanged = LocaleQuery.onLocaleInfoChanged;
var lazyLocaleValue = LocaleQuery.lazyLocaleValue;

var MSECS_IN_DAY = DateFormats.MSECS_IN_DAY;
var DAY_FORMAT = DateFormats.DAY_FORMAT;
var DATE_FORMAT_SHORT = DateFormats.DATE_FORMAT_SHORT;
var DATE_FORMAT_FULL = DateFormats.DATE_FORMAT_FULL;
var monthWindowStartOffset = DateFormats.monthWindowStartOffset;

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
