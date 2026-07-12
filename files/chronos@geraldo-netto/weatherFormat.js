/* global imports */
/* eslint camelcase: "off" */

// The pure half of the weather feature: the numbers and the words, with no HTTP
// session, no timer and no state. weather.js keeps the parts that talk to the
// network and to the clock. Every other module here was split the same way
// (utils into localeUtils/ioUtils/styleUtils/providerUtils, holidays into
// holidayConstants/holidayCache/holidayAdapters/holidayServiceAdapters); this
// one had grown to 870 lines without it.

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const Utils = typeof require === "function" ?
    require("./utils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].utils;

var REFRESH_SECONDS = 1800;
var RETRY_SECONDS = 30;
// A reading nobody has managed to refresh for two whole periods is not the
// weather any more, and saying so is the difference between a temperature and a
// temperature from this morning.
//
// This rule was written twice — once in the panel's display state, once in the
// city provider — and the copies agreed only at the default refresh period. The
// city one read a module constant and ignored the refresh period it was
// constructed with, so a provider asked to refresh every 60 seconds still
// called a reading current until it was an hour old: 59 refresh cycles of
// presenting a stale number as the weather. There is one rule here now, and it
// is derived from whatever period the caller actually uses.
var STALE_PERIODS = 2;

function staleAfterSeconds(refreshSeconds) {
    return (refreshSeconds || REFRESH_SECONDS) * STALE_PERIODS;
}

function readingIsStale(readingAt, now, staleAfter) {
    return (now - readingAt) / 1000 > staleAfter;
}
// the backoff doubles until it reaches the refresh period and then stops
// counting: past that the delay cannot grow, so an unbounded counter is just a
// number nobody reads
var MAX_RETRY_ATTEMPTS = 8;
var MAX_GEOCODE_CACHE_ENTRIES = 16;
var HTTP_TIMEOUT_SECONDS = Utils.HTTP_TIMEOUT_SECONDS;
var WEATHER_DEBOUNCE_MS = 750;
var WEATHER_UNITS = {
    SI: "si",
    IMPERIAL: "imperial"
};
var WEATHER_ERROR_MARKER = Utils.UI_ERROR_MARKER;
var WEATHER_PENDING_TEXT = "…";
var WEATHER_ERRORS = {
    LOCATION_NOT_FOUND: "Location not found",
    SERVICE_UNAVAILABLE: "Weather service unavailable",
    NO_LOCATION: "Set a weather location"
};
var WEATHER_USER_AGENT = "chronos@geraldo-netto Cinnamon applet (https://github.com/geraldo-netto/chronos-geraldo-netto)";
var WEATHER_PROVIDER_NAMES = {
    OPEN_METEO: "Open-Meteo",
    AVIATION_WEATHER: "Aviation Weather",
    MET_NO: "MET Norway",
    NOMINATIM: "Nominatim"
};

// aviationweather.gov reports per airport, not per point: ask for the METARs
// in a box around the place and keep the closest station that carries a
// temperature. A degree is roughly 111 km at the equator, so this reaches
// airports a city away without dragging in a neighbouring country's.
var AVIATION_WEATHER_BBOX_DEGREES = 1;

// Both providers map their own codes onto the same eight glyphs, so the glyph
// is the condition class. A screen reader reads the emoji's codepoint name or
// nothing at all, so keep a word for each one.
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

function weatherCondition(text) {
    if (typeof text !== "string" || !text) {
        return "";
    }

    // the glyph is the first code point, not the first UTF-16 unit
    const icon = Array.from(text)[0];
    return WEATHER_CONDITIONS[icon] || "";
}

function normalizeUnits(units) {
    if (units === WEATHER_UNITS.IMPERIAL) {
        return WEATHER_UNITS.IMPERIAL;
    }

    return WEATHER_UNITS.SI;
}

// One temperature rule for all three providers. They each hand back Celsius —
// METAR is Celsius by definition, MET.no reports Celsius, and Open-Meteo is now
// asked for Celsius rather than converting server-side — and this owns the
// imperial conversion, the rounding and the suffix. Two adapters used to carry
// their own `* 9 / 5 + 32` and the Open-Meteo path asked the API to convert, so
// the rule lived in three places that could disagree: the same city could read
// 21°C on one provider and 70°F on another in one tooltip.
function formatTemperature(celsius, units) {
    const imperial = normalizeUnits(units) === WEATHER_UNITS.IMPERIAL;
    const value = imperial ? celsius * 9 / 5 + 32 : celsius;
    return Math.round(value) + (imperial ? "°F" : "°C");
}

function formatReading(icon, celsius, units) {
    return icon + " " + formatTemperature(celsius, units);
}

function weatherIcon(weatherCode) {
    if (weatherCode === 0) {
        return "☀";
    }
    if (weatherCode <= 3) {
        return "⛅";
    }
    if (weatherCode <= 48) {
        return "☁";
    }
    if (weatherCode <= 67) {
        return "🌧";
    }
    if (weatherCode <= 77) {
        return "🌨";
    }
    if (weatherCode <= 86) {
        return "🌦";
    }
    if (weatherCode >= 95 && weatherCode <= 99) {
        return "⛈";
    }
    return "🌤";
}

function geocodeUrl(location) {
    return "https://geocoding-api.open-meteo.com/v1/search?name=" +
        encodeURIComponent(location.trim()) + "&count=1&language=en&format=json";
}

function nominatimGeocodeUrl(location) {
    return "https://nominatim.openstreetmap.org/search?q=" +
        encodeURIComponent(location.trim()) + "&format=json&limit=1";
}

function locationCacheKey(location) {
    return location.trim().toLowerCase();
}

function forecastUrl(place) {
    // always Celsius: formatTemperature owns the imperial conversion, so all
    // three providers go through one rounding-and-suffix rule and the same city
    // cannot read a different unit depending on which one answered
    return "https://api.open-meteo.com/v1/forecast?latitude=" +
        encodeURIComponent(place.latitude) + "&longitude=" + encodeURIComponent(place.longitude) +
        "&current_weather=true&timezone=auto&temperature_unit=celsius";
}

function metNoForecastUrl(place) {
    return "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=" +
        encodeURIComponent(place.latitude) + "&lon=" + encodeURIComponent(place.longitude);
}

function aviationWeatherUrl(place) {
    const latitude = Number(place.latitude);
    const longitude = Number(place.longitude);
    const box = [
        latitude - AVIATION_WEATHER_BBOX_DEGREES,
        longitude - AVIATION_WEATHER_BBOX_DEGREES,
        latitude + AVIATION_WEATHER_BBOX_DEGREES,
        longitude + AVIATION_WEATHER_BBOX_DEGREES
    ].map((value) => value.toFixed(3)).join(",");

    return "https://aviationweather.gov/api/data/metar?format=json&bbox=" + encodeURIComponent(box);
}

// A METAR carries the present weather in its own codes and the sky in an
// oktas-based cover. These are two lookup tables written as data: the present
// codes are tried in order (the precipitation code wins, as a rain shower under
// a broken sky is rain to the person reading the panel), then the cover code.
const AVIATION_PRESENT_ICONS = [
    [["TS"], "⛈"],
    [["SN", "SG", "IC"], "🌨"],
    [["SH"], "🌦"],
    [["RA", "DZ", "PL"], "🌧"],
    [["FG", "BR", "HZ"], "☁"]
];
const AVIATION_COVER_ICONS = {
    CAVOK: "☀", CLR: "☀", SKC: "☀", NSC: "☀",
    FEW: "🌤",
    SCT: "⛅",
    BKN: "☁", OVC: "☁", OVX: "☁"
};

function aviationWeatherIcon(station) {
    const present = typeof station.wxString === "string" ? station.wxString.toUpperCase() : "";
    for (const [codes, icon] of AVIATION_PRESENT_ICONS) {
        if (codes.some((code) => present.indexOf(code) !== -1)) {
            return icon;
        }
    }

    const cover = typeof station.cover === "string" ? station.cover.toUpperCase() : "";
    return AVIATION_COVER_ICONS[cover] || "🌤";
}

// A METAR station with nothing to report sends "temp": null, and Number(null),
// Number(""), Number([]) and Number(false) are all 0. Coercing straight off the
// payload therefore turns a silent station into one reporting 0 °C at Null
// Island, and it can win the nearest-station race. Only a real number or a
// non-blank numeric string is a reading.
function metarNumber(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }

    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

function aviationWeatherStation(stations, place) {
    if (!Array.isArray(stations)) {
        return null;
    }

    const latitude = Number(place.latitude);
    const longitude = Number(place.longitude);
    let nearest = null;
    let nearestDistance = Infinity;

    for (const station of stations) {
        if (!station || typeof station !== "object" || metarNumber(station.temp) === null) {
            continue;
        }

        const stationLatitude = metarNumber(station.lat);
        const stationLongitude = metarNumber(station.lon);
        if (stationLatitude === null || stationLongitude === null) {
            continue;
        }

        // ranking only, so the flat approximation is enough inside a
        // one-degree box; the longitude gap shrinks toward the poles
        const dLatitude = stationLatitude - latitude;
        const dLongitude = (stationLongitude - longitude) * Math.cos(latitude * Math.PI / 180);
        const distance = dLatitude * dLatitude + dLongitude * dLongitude;

        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = station;
        }
    }

    return nearest;
}

function aviationWeatherText(stations, place, units) {
    const station = aviationWeatherStation(stations, place);
    if (!station) {
        return "";
    }

    // METAR temperatures are Celsius by definition
    return formatReading(aviationWeatherIcon(station), metarNumber(station.temp), units);
}

function weatherText(weather, units) {
    if (!weather) {
        return "";
    }

    // Open-Meteo answers `temperature: null` for a degraded station, and an
    // unchecked Math.round() turns that into "NaN°C" — a non-empty string,
    // which the provider chain reads as success: no failover to the two
    // providers that would have answered, and NaN kept as the last good
    // reading. The other two parsers check; this one has to as well.
    if (!Number.isFinite(weather.temperature)) {
        return "";
    }

    // Open-Meteo is asked for Celsius (forecastUrl), so this converts like the
    // other two rather than trusting a server-side unit
    return formatReading(weatherIcon(weather.weathercode), weather.temperature, units);
}

function metNoIcon(symbolCode) {
    const symbol = typeof symbolCode === "string" ? symbolCode.toLowerCase() : "";

    if (symbol.indexOf("thunder") !== -1) {
        return "⛈";
    }
    if (symbol.indexOf("clearsky") !== -1) {
        return "☀";
    }
    if (symbol.indexOf("fair") !== -1) {
        return "🌤";
    }
    if (symbol.indexOf("partlycloudy") !== -1) {
        return "⛅";
    }
    if (symbol.indexOf("fog") !== -1 || symbol.indexOf("cloudy") !== -1) {
        return "☁";
    }
    if (symbol.indexOf("snow") !== -1) {
        return "🌨";
    }
    if (symbol.indexOf("showers") !== -1) {
        return "🌦";
    }
    if (symbol.indexOf("rain") !== -1 || symbol.indexOf("drizzle") !== -1 || symbol.indexOf("sleet") !== -1) {
        return "🌧";
    }

    return "🌤";
}

function metNoSummary(data) {
    if (!data) {
        return null;
    }

    if (data.next_1_hours && data.next_1_hours.summary) {
        return data.next_1_hours.summary;
    }
    if (data.next_6_hours && data.next_6_hours.summary) {
        return data.next_6_hours.summary;
    }
    if (data.next_12_hours && data.next_12_hours.summary) {
        return data.next_12_hours.summary;
    }

    return null;
}

function metNoWeatherText(forecast, units) {
    if (!forecast || !forecast.properties || !Array.isArray(forecast.properties.timeseries) ||
        !forecast.properties.timeseries.length) {
        return "";
    }

    const point = forecast.properties.timeseries[0];
    if (!point || typeof point !== "object") {
        return "";
    }

    const data = point.data;
    if (!data || !data.instant || !data.instant.details ||
        !Number.isFinite(data.instant.details.air_temperature)) {
        return "";
    }

    const summary = metNoSummary(data);
    const icon = metNoIcon(summary ? summary.symbol_code : "");
    return formatReading(icon, data.instant.details.air_temperature, units);
}

function openMeteoGeocodePlace(data) {
    if (!data || !Array.isArray(data.results) || !data.results.length) {
        return null;
    }

    const place = data.results[0];
    if (!place || typeof place !== "object") {
        return null;
    }

    const latitude = Number(place.latitude);
    const longitude = Number(place.longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
    }

    return Object.assign({}, place, { latitude, longitude });
}

function nominatimGeocodePlace(data) {
    if (!Array.isArray(data) || !data.length) {
        return null;
    }

    const place = data[0];
    if (!place || typeof place !== "object") {
        return null;
    }

    const latitude = parseFloat(place.lat);
    const longitude = parseFloat(place.lon);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
    }

    return {
        name: place.display_name,
        latitude,
        longitude
    };
}

if (typeof module !== "undefined") {
    module.exports = { REFRESH_SECONDS, RETRY_SECONDS, STALE_PERIODS, staleAfterSeconds, readingIsStale, MAX_RETRY_ATTEMPTS, MAX_GEOCODE_CACHE_ENTRIES, HTTP_TIMEOUT_SECONDS, WEATHER_DEBOUNCE_MS, WEATHER_UNITS, WEATHER_ERROR_MARKER, WEATHER_PENDING_TEXT, WEATHER_ERRORS, WEATHER_USER_AGENT, WEATHER_PROVIDER_NAMES, AVIATION_WEATHER_BBOX_DEGREES, WEATHER_CONDITIONS, weatherCondition, normalizeUnits, weatherIcon, geocodeUrl, nominatimGeocodeUrl, locationCacheKey, forecastUrl, metNoForecastUrl, aviationWeatherUrl, aviationWeatherIcon, metarNumber, aviationWeatherStation, aviationWeatherText, weatherText, metNoIcon, metNoSummary, metNoWeatherText, openMeteoGeocodePlace, nominatimGeocodePlace };
}
