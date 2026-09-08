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
var WEATHER_ERROR_MARKER = TextUtils.WARNING_MARKER; // NOSONAR [S3504] -- GJS importer export
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
    const normalized = TextUtils.normalizeBoundedText(location, MAX_WEATHER_LOCATION_LENGTH);
    return normalized.includes("\0") ? "" : normalized;
}

// A cache key, and deliberately not the display fold in
// weatherServiceAdapters.foldPlaceName. A key needs to be stable and to
// separate places the user meant to keep apart; the fold needs to be diacritic-
// and punctuation-insensitive so a keyboard spelling reaches the city. Genova
// and Génova are two cities - the fold's own comment says so - and folding the
// key would make one geocode answer for the other, forever, out of the cache.
//
// It lives here, beside the normalization it wraps, because it is a rule about
// place identity and nothing else: weatherProviders.js, where it used to sit,
// is the Soup and GLib layer, and the domain modules that key by it - the
// reading store, the per-city error map, the city dedup - would have had to
// reach downstream through the transport to ask what a place is called.
function locationCacheKey(location) {
    return normalizeWeatherLocation(location).toLowerCase();
}

function fahrenheitTemperature(celsius) {
    if (!Number.isFinite(celsius)) {
        return null;
    }
    // Multiplying by nine first can overflow a representable final result.
    const fahrenheit = celsius * 1.8 + 32;
    return Number.isFinite(fahrenheit) ? fahrenheit : null;
}

function validTemperature(celsius) {
    // The cached Celsius reading must remain valid after a display-unit change.
    return fahrenheitTemperature(celsius) !== null;
}

function formatTemperature(celsius, units) {
    const fahrenheit = fahrenheitTemperature(celsius);
    if (fahrenheit === null) {
        return "";
    }
    const imperial = normalizeUnits(units) === WEATHER_UNITS.IMPERIAL;
    const value = imperial ? fahrenheit : celsius;
    return Math.round(value) + (imperial ? "°F" : "°C");
}


// One last-good reading per place, and the rule for when it stops being one.
//
// "the last reading, who provided it, when it was fetched, and is that still
// the weather?" was written twice: WeatherDisplayState held the panel's four
// fields, and CityWeatherProvider held the same four per city, unnamed, in a
// Map — while both derived the staleness horizon from staleAfterSeconds above.
// One policy, two implementations, in the two files that call each other twins;
// the refresh scheduler had already been de-duplicated the same way.
//
// The store keeps readings and answers how old they are. What a surface does
// with a reading that has gone stale stays with that surface: the panel is one
// line where a marker cannot say "old" apart from "failed", so it stops
// re-showing it; a tooltip row has room for "Last known reading" beside the
// temperature, so it keeps it and says so.
var WeatherReadingStore = class WeatherReadingStore { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._readings = new Map();
        // Freshness has to count time spent asleep, so this is the civil clock
        // and never a monotonic one. It is Date.now() written out rather than
        // ElapsedTime.civilMilliseconds imported, because elapsedTime reaches
        // for GLib at load and this module deliberately has no platform
        // dependency - it is the same function, and it is what both callers
        // already fall back to.
        //
        // There was no default, on a constructor whose params default to {}:
        // `new WeatherReadingStore()` built an object that raised "this._now is
        // not a function" on the first record of a reading with no fetch stamp,
        // and on every isStale - including for a key it does not hold, because
        // a default argument is evaluated before the body.
        this._now = params.freshnessNow || (() => Date.now());
        this._stale_after_seconds = params.staleAfterSeconds ||
            staleAfterSeconds(params.refreshSeconds);
    }

    // `readingAt` is when the reading was fetched, which is not when it
    // arrived: a hit on the shared cache hands over a reading that may already
    // be most of a period old, and stamping receipt time here reset its age and
    // withheld the staleness marker for another one.
    record(key, reading, provider, readingAt) {
        this._readings.set(key, {
            record: reading,
            provider: provider || "",
            freshAt: Number.isFinite(readingAt) ? readingAt : this._now()
        });
    }

    recordFor(key) {
        const entry = this._readings.get(key);
        return entry ? entry.record : null;
    }

    providerFor(key) {
        const entry = this._readings.get(key);
        return entry ? entry.provider : "";
    }

    has(key) {
        return Boolean(this.recordFor(key));
    }

    isStale(key, now = this._now()) {
        const entry = this._readings.get(key);
        return entry ?
            readingIsStale(entry.freshAt, now, this._stale_after_seconds) : false;
    }

    // a reading for a place the user has since removed must not outlive the row
    // that showed it
    keepOnly(keys) {
        for (const key of Array.from(this._readings.keys())) {
            if (!keys.has(key)) {
                this._readings.delete(key);
            }
        }
    }

    clear() {
        this._readings.clear();
    }
};

if (typeof module !== "undefined") {
    module.exports = { REFRESH_SECONDS, RETRY_SECONDS, STALE_PERIODS,
        staleAfterSeconds, readingIsStale, WeatherReadingStore, MAX_RETRY_ATTEMPTS,
        MAX_GEOCODE_CACHE_ENTRIES, MAX_WEATHER_LOCATION_LENGTH,
        WEATHER_DEBOUNCE_MS, WEATHER_UNITS,
        WEATHER_ERROR_MARKER, WEATHER_PENDING_TEXT, WEATHER_ERRORS,
        WEATHER_CONDITIONS, WEATHER_UNKNOWN_CONDITION,
        normalizeUnits, normalizeWeatherLocation, locationCacheKey,
        validTemperature, formatTemperature };
}
