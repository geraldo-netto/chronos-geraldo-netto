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
    Boolean(process.versions && process.versions.node);

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
const LocaleText = IS_NODE ?
    require("./localeText") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].localeText;
const LocaleQuery = IS_NODE ?
    require("./localeQuery") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].localeQuery;
const DateFormats = IS_NODE ?
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
