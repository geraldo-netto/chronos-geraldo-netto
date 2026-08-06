// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports */

// App-owned weather display, freshness and input rules. This module deliberately
// has no platform, network or vendor dependency and can load in plain JavaScript.
const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;

var REFRESH_SECONDS = 1800; // NOSONAR [S3504] -- GJS importer export
var RETRY_SECONDS = 30; // NOSONAR [S3504] -- GJS importer export
var STALE_PERIODS = 2; // NOSONAR [S3504] -- GJS importer export
var MAX_RETRY_ATTEMPTS = 8; // NOSONAR [S3504] -- GJS importer export
var MAX_GEOCODE_CACHE_ENTRIES = 16; // NOSONAR [S3504] -- GJS importer export
var MAX_WEATHER_LOCATION_LENGTH = 256; // NOSONAR [S3504] -- GJS importer export
var WEATHER_DEBOUNCE_MS = 750; // NOSONAR [S3504] -- GJS importer export
var WEATHER_UNITS = { // NOSONAR [S3504] -- GJS importer export
    SI: "si",
    IMPERIAL: "imperial"
};
var WEATHER_ERROR_MARKER = "⚠"; // NOSONAR [S3504] -- GJS importer export
var WEATHER_PENDING_TEXT = "…"; // NOSONAR [S3504] -- GJS importer export
var WEATHER_ERRORS = { // NOSONAR [S3504] -- GJS importer export
    LOCATION_NOT_FOUND: "Location not found",
    SERVICE_UNAVAILABLE: "Weather service unavailable",
    NO_LOCATION: "Set a weather location",
    // a state, not a provider failure: nothing was dispatched, so nothing is
    // "unavailable" — and recovery rides the network monitor, not the backoff
    OFFLINE: "No network connection"
};

// A reading whose sky the provider did not describe in terms this applet
// recognises. It is deliberately not a glyph: every glyph below names a real
// condition, and the presenters render an absent condition as absent — no word
// in the tooltip, nothing added to the accessible name — rather than as a
// confident-looking one. 🌤 "Fair" used to serve as both a real met.no symbol
// and this fallback, which made an unrecognised code indistinguishable from a
// genuine reading.
var WEATHER_UNKNOWN_CONDITION = ""; // NOSONAR [S3504] -- GJS importer export

// The glyph is the normalized condition class. Presenters translate the word
// associated with it for tooltips and accessible names.
var WEATHER_CONDITIONS = { // NOSONAR [S3504] -- GJS importer export
    "☀": "Clear",
    "⛅": "Partly cloudy",
    "☁": "Cloudy",
    "🌧": "Rain",
    "🌨": "Snow",
    "🌦": "Showers",
    "⛈": "Thunderstorm",
    "🌤": "Fair"
};

function staleAfterSeconds(refreshSeconds) {
    return (refreshSeconds || REFRESH_SECONDS) * STALE_PERIODS;
}

function readingIsStale(readingAt, now, staleAfter) {
    const age = now - readingAt;
    return !Number.isFinite(age) || age < 0 || age / 1000 > staleAfter;
}

function normalizeUnits(units) {
    return units === WEATHER_UNITS.IMPERIAL ?
        WEATHER_UNITS.IMPERIAL : WEATHER_UNITS.SI;
}

function normalizeWeatherLocation(location) {
    return TextUtils.normalizeBoundedText(location, MAX_WEATHER_LOCATION_LENGTH);
}

function formatTemperature(celsius, units) {
    const imperial = normalizeUnits(units) === WEATHER_UNITS.IMPERIAL;
    const value = imperial ? celsius * 9 / 5 + 32 : celsius;
    return Math.round(value) + (imperial ? "°F" : "°C");
}

if (typeof module !== "undefined") {
    module.exports = { REFRESH_SECONDS, RETRY_SECONDS, STALE_PERIODS,
        staleAfterSeconds, readingIsStale, MAX_RETRY_ATTEMPTS,
        MAX_GEOCODE_CACHE_ENTRIES, MAX_WEATHER_LOCATION_LENGTH,
        WEATHER_DEBOUNCE_MS, WEATHER_UNITS,
        WEATHER_ERROR_MARKER, WEATHER_PENDING_TEXT, WEATHER_ERRORS,
        WEATHER_CONDITIONS, WEATHER_UNKNOWN_CONDITION,
        normalizeUnits, normalizeWeatherLocation,
        formatTemperature };
}
