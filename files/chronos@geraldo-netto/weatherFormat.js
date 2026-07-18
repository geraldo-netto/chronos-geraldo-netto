// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

// App-owned weather display and freshness rules. This module deliberately has
// no platform, network or vendor dependency and can load in plain JavaScript.

var REFRESH_SECONDS = 1800; // NOSONAR [S3504] -- GJS importer export
var RETRY_SECONDS = 30; // NOSONAR [S3504] -- GJS importer export
var STALE_PERIODS = 2; // NOSONAR [S3504] -- GJS importer export
var MAX_RETRY_ATTEMPTS = 8; // NOSONAR [S3504] -- GJS importer export
var MAX_GEOCODE_CACHE_ENTRIES = 16; // NOSONAR [S3504] -- GJS importer export
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
    NO_LOCATION: "Set a weather location"
};

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
    return (now - readingAt) / 1000 > staleAfter;
}

function normalizeUnits(units) {
    return units === WEATHER_UNITS.IMPERIAL ?
        WEATHER_UNITS.IMPERIAL : WEATHER_UNITS.SI;
}

function formatTemperature(celsius, units) {
    const imperial = normalizeUnits(units) === WEATHER_UNITS.IMPERIAL;
    const value = imperial ? celsius * 9 / 5 + 32 : celsius;
    return Math.round(value) + (imperial ? "°F" : "°C");
}

if (typeof module !== "undefined") {
    module.exports = { REFRESH_SECONDS, RETRY_SECONDS, STALE_PERIODS,
        staleAfterSeconds, readingIsStale, MAX_RETRY_ATTEMPTS,
        MAX_GEOCODE_CACHE_ENTRIES, WEATHER_DEBOUNCE_MS, WEATHER_UNITS,
        WEATHER_ERROR_MARKER, WEATHER_PENDING_TEXT, WEATHER_ERRORS,
        WEATHER_CONDITIONS, normalizeUnits, formatTemperature };
}
