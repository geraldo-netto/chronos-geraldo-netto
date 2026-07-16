// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

// App-owned weather display and freshness rules. This module deliberately has
// no platform, network or vendor dependency and can load in plain JavaScript.

var REFRESH_SECONDS = 1800;
var RETRY_SECONDS = 30;
var STALE_PERIODS = 2;
var MAX_RETRY_ATTEMPTS = 8;
var MAX_GEOCODE_CACHE_ENTRIES = 16;
var WEATHER_DEBOUNCE_MS = 750;
var WEATHER_UNITS = {
    SI: "si",
    IMPERIAL: "imperial"
};
var WEATHER_ERROR_MARKER = "⚠";
var WEATHER_PENDING_TEXT = "…";
var WEATHER_ERRORS = {
    LOCATION_NOT_FOUND: "Location not found",
    SERVICE_UNAVAILABLE: "Weather service unavailable",
    NO_LOCATION: "Set a weather location"
};

// The glyph is the normalized condition class. Presenters translate the word
// associated with it for tooltips and accessible names.
var WEATHER_CONDITIONS = {
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

function formatReading(condition, celsius, units) {
    return condition + " " + formatTemperature(celsius, units);
}

if (typeof module !== "undefined") {
    module.exports = { REFRESH_SECONDS, RETRY_SECONDS, STALE_PERIODS,
        staleAfterSeconds, readingIsStale, MAX_RETRY_ATTEMPTS,
        MAX_GEOCODE_CACHE_ENTRIES, WEATHER_DEBOUNCE_MS, WEATHER_UNITS,
        WEATHER_ERROR_MARKER, WEATHER_PENDING_TEXT, WEATHER_ERRORS,
        WEATHER_CONDITIONS, normalizeUnits, formatTemperature, formatReading };
}
