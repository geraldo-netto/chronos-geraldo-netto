/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const LocaleUtils = typeof require === "function" ?
    require("./localeUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].localeUtils;
const IoUtils = typeof require === "function" ?
    require("./ioUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].ioUtils;
const StyleUtils = typeof require === "function" ?
    require("./styleUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].styleUtils;
const ProviderUtils = typeof require === "function" ?
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
var createHttpSession = IoUtils.createHttpSession;
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
        createHttpSession,
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
