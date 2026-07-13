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
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;
const LocaleUtils = IS_NODE ?
    require("./localeUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].localeUtils;
const IoUtils = IS_NODE ?
    require("./ioUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].ioUtils;
const StyleUtils = IS_NODE ?
    require("./styleUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].styleUtils;
const ProviderUtils = IS_NODE ?
    require("./providerUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].providerUtils;

var MSECS_IN_DAY = LocaleUtils.MSECS_IN_DAY;
var UI_ERROR_MARKER = "⚠";
var DAY_FORMAT = LocaleUtils.DAY_FORMAT;
var DATE_FORMAT_SHORT = LocaleUtils.DATE_FORMAT_SHORT;
var DATE_FORMAT_FULL = LocaleUtils.DATE_FORMAT_FULL;
var translate = LocaleUtils.translate;
var joinPhrases = LocaleUtils.joinPhrases;
var translatePlural = LocaleUtils.translatePlural;
var monthWindowStartOffset = LocaleUtils.monthWindowStartOffset;
var lazyLocaleValue = LocaleUtils.lazyLocaleValue;
var onLocaleInfoChanged = LocaleUtils.onLocaleInfoChanged;
var cancelPendingLocaleQueries = LocaleUtils.cancelPendingLocaleQueries;
var registerLocaleConsumer = LocaleUtils.registerLocaleConsumer;
var readJsonFileAsync = IoUtils.readJsonFileAsync;
var writeJsonFileAsync = IoUtils.writeJsonFileAsync;
var clampText = TextUtils.clampText;
var TEXT_ELLIPSIS = TextUtils.TEXT_ELLIPSIS;
var createHttpSession = IoUtils.createHttpSession;
var LazyHttpSession = IoUtils.LazyHttpSession;
var HTTP_TIMEOUT_SECONDS = IoUtils.HTTP_TIMEOUT_SECONDS;
var httpGetJson = IoUtils.httpGetJson;
var safeCssColor = StyleUtils.safeCssColor;
var backoffDelay = ProviderUtils.backoffDelay;
var orderProvidersByLastSuccess = ProviderUtils.orderProvidersByLastSuccess;
var tryProvidersInOrder = ProviderUtils.tryProvidersInOrder;

if (typeof module !== "undefined") {
    module.exports = {
        MSECS_IN_DAY,
        UI_ERROR_MARKER,
        DAY_FORMAT,
        DATE_FORMAT_SHORT,
        DATE_FORMAT_FULL,
        translate,
        joinPhrases,
        translatePlural,
        httpGetJson,
        monthWindowStartOffset,
        readJsonFileAsync,
        writeJsonFileAsync,
        clampText,
        TEXT_ELLIPSIS,
        createHttpSession,
        LazyHttpSession,
        HTTP_TIMEOUT_SECONDS,
        safeCssColor,
        lazyLocaleValue,
        onLocaleInfoChanged,
        cancelPendingLocaleQueries,
        registerLocaleConsumer,
        backoffDelay,
        orderProvidersByLastSuccess,
        tryProvidersInOrder
    };
}
