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

// Vendor boundary for weather and geocoding services. Each function below
// translates one provider's URL or wire payload into app-owned place and
// reading records. Display formatting belongs to weatherFormat.js.

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const WeatherFormat = IS_NODE ?
    require("./weatherFormat") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].weatherFormat;
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;

// Open-Meteo may return an exact-name hamlet for a large city it knows only by
// an exonym. A population below this is a candidate, not a confident answer:
// let the next geocoder in the queue arbitrate it instead of showing weather
// for the wrong place. Missing population is equally unverifiable.
var MIN_TRUSTED_GEOCODE_POPULATION = 1000; // NOSONAR [S3504] -- GJS importer export
// One hit was all that was ever asked for, so the first one the geocoder happened
// to rank highest was the city, whatever it was. A handful of them, ranked here by
// what the user typed and by how many people live there, is what makes a wrong
// first hit survivable.
var GEOCODE_CANDIDATE_COUNT = 10; // NOSONAR [S3504] -- GJS importer export
var MAX_GEOCODE_PLACE_NAME_LENGTH = WeatherFormat.MAX_WEATHER_LOCATION_LENGTH; // NOSONAR [S3504] -- GJS importer export
const MAX_GEOCODE_TIMEZONE_LENGTH = 255;
var WEATHER_USER_AGENT = "chronos@geraldo-netto Cinnamon applet (https://github.com/geraldo-netto/cinnamon-chronos)"; // NOSONAR [S3504] -- GJS importer export
// Stable inventory order for cross-runtime disclosures: place services first,
// then forecast-only fallbacks. Provider execution order lives in the separate
// geocode and forecast registries in weatherProviders.js.
var WEATHER_PROVIDER_NAMES = { // NOSONAR [S3504] -- GJS importer export
    OPEN_METEO: "Open-Meteo",
    NOMINATIM: "Nominatim",
    AVIATION_WEATHER: "Aviation Weather",
    MET_NO: "MET Norway"
};

// aviationweather.gov reports per airport, not per point: ask for the METARs
// in a box around the place and keep the closest station that carries a
// temperature. A degree is roughly 111 km at the equator, so this reaches
// airports a city away without dragging in a neighbouring country's.
var AVIATION_WEATHER_BBOX_DEGREES = 1; // NOSONAR [S3504] -- GJS importer export

// The WMO 4677 present-weather codes Open-Meteo publishes, in the condition
// classes the applet renders. Open-ended `<=` buckets put overcast in with
// partly cloudy — so the one code that means a grey sky was the one that did
// not say cloudy — and snow showers in with rain showers, telling a user in a
// snow shower that it was raining. That second one also put this adapter at
// odds with the met.no one, which tests snow before showers, so the same real
// weather was described differently depending on which provider in the
// failover chain answered.
//
// Closed ranges rather than thresholds: the gaps between the groups are not
// codes Open-Meteo emits, and a threshold chain silently adopts them into
// whichever class it happens to reach first.
//
// WMO 1 (mainly clear) is 🌤 and WMO 2 (partly cloudy) is ⛅ because the other
// two vendors already draw that line: aviationweather's FEW (one to two oktas)
// and met.no's `fair` are both 🌤, and SCT and `partlycloudy` are both ⛅.
// Grouping 1 with 2 here made a lightly clouded sky read "🌤 Fair" or
// "⛅ Partly cloudy" - different glyph, different wording, different accessible
// name - according to which provider in the failover chain happened to answer,
// which is the cross-provider disagreement this table was closed to prevent.
const WMO_CONDITION_RANGES = [
    [0, 0, "☀"],    // clear sky
    [1, 1, "🌤"],   // mainly clear
    [2, 2, "⛅"],   // partly cloudy
    [3, 3, "☁"],    // overcast
    [45, 48, "☁"],  // fog, depositing rime fog
    [51, 67, "🌧"], // drizzle, freezing drizzle, rain, freezing rain
    [71, 77, "🌨"], // snow fall, snow grains
    [80, 82, "🌦"], // rain showers
    [85, 86, "🌨"], // snow showers
    [95, 99, "⛈"]  // thunderstorm, thunderstorm with hail
];

// The code comes off Open-Meteo's JSON, which a degraded or hostile endpoint
// away sends a string, a float, a negative or nothing at all — and bare `<=`
// comparisons coerce, so `null` read as clear sky and every unrecognised value
// read as a confident "Fair". A sky the provider did not describe in terms
// this applet knows is reported as undescribed.
function weatherIcon(weatherCode) {
    if (!Number.isInteger(weatherCode)) {
        return WeatherFormat.WEATHER_UNKNOWN_CONDITION;
    }

    const match = WMO_CONDITION_RANGES.find(
        ([from, to]) => weatherCode >= from && weatherCode <= to);
    return match ? match[2] : WeatherFormat.WEATHER_UNKNOWN_CONDITION;
}

// The geocoders answer in whatever language they are asked in, and both of
// them want a bare ISO 639-1 code. The extraction rule is TextUtils'; the
// fallback is this vendor boundary's, because a geocoder asked in no language
// ranks by its own default rather than refusing.
function geocodeLanguage(locale) {
    return TextUtils.isoLanguageCode(locale, "en");
}

// Open-Meteo ranks a search by the language it is asked in, not only by the name
// it is asked about, and it used to be asked in English whoever was asking.
// "Genova" in English is Génova, Guatemala — 3744 people — before Genova, Italy,
// because Genoa is the English name for the Italian city; the panel showed a
// Guatemalan temperature and nothing said so. Asked in Italian, the Italian city
// is the first hit. A user types a city in the language their session runs in,
// so that is the language to ask in.
function geocodeUrl(location, locale) {
    const normalized = WeatherFormat.normalizeWeatherLocation(location);
    if (!normalized) {
        return "";
    }
    return "https://geocoding-api.open-meteo.com/v1/search?name=" +
        encodeURIComponent(normalized) + "&count=" + GEOCODE_CANDIDATE_COUNT +
        "&language=" + geocodeLanguage(locale) + "&format=json";
}

// Nominatim ranks and names results by `accept-language` the same way Open-Meteo
// ranks by `language`, and it is the provider that answers exactly when
// Open-Meteo is down or refuses on the population floor — so asking it in
// English would reintroduce the Genova/Génova mismatch on the fallback path.
function nominatimGeocodeUrl(location, locale) {
    const normalized = WeatherFormat.normalizeWeatherLocation(location);
    if (!normalized) {
        return "";
    }
    return "https://nominatim.openstreetmap.org/search?q=" +
        encodeURIComponent(normalized) + "&format=json&limit=" + GEOCODE_CANDIDATE_COUNT +
        "&accept-language=" + geocodeLanguage(locale);
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

// Longitude is a circle, so the difference between two of them is the shorter
// way round: a place at 179.9°E and a station at 179.5°W are 0.6° apart, not
// 359.4°. Subtracting them directly made every station across the seam the
// furthest one on the list, so the nearest station there could never be picked.
function longitudeDelta(from, to) {
    const delta = (from - to) % 360;
    if (delta > 180) {
        return delta - 360;
    }
    if (delta < -180) {
        return delta + 360;
    }
    return delta;
}

// Latitude has ends and longitude does not: a box drawn past a pole is not a
// place, while one drawn past ±180 is the same box written in coordinates the
// service does not accept. Clamp the first and hold the second inside range.
function aviationWeatherBox(latitude, longitude) {
    const clampLatitude = (value) => Math.min(90, Math.max(-90, value));
    const clampLongitude = (value) => Math.min(180, Math.max(-180, value));

    return [
        clampLatitude(latitude - AVIATION_WEATHER_BBOX_DEGREES),
        clampLongitude(longitude - AVIATION_WEATHER_BBOX_DEGREES),
        clampLatitude(latitude + AVIATION_WEATHER_BBOX_DEGREES),
        clampLongitude(longitude + AVIATION_WEATHER_BBOX_DEGREES)
    ];
}

function aviationWeatherUrl(place) {
    const latitude = Number(place.latitude);
    const longitude = Number(place.longitude);
    const box = aviationWeatherBox(latitude, longitude)
        .map((value) => value.toFixed(3)).join(",");

    return "https://aviationweather.gov/api/data/metar?format=json&bbox=" + encodeURIComponent(box);
}

// A METAR carries the present weather in its own codes and the sky in an
// oktas-based cover. These are two lookup tables written as data: the present
// codes are tried in order (the precipitation code wins, as a rain shower under
// a broken sky is rain to the person reading the panel), then the cover code.
// Two vendors describe the sky as free text this applet has to classify, and
// both classify it the same way: normalise the case, walk `[tokens, icon]` rules
// in order, first substring hit wins. Only the case direction, the source field
// and what a miss means differ, so those stay with the callers - the aviation
// adapter falls through to its cover table on a miss, the met.no one calls the
// sky undescribed.
function iconFromTokenRules(rules, text) {
    for (const [tokens, icon] of rules) {
        if (tokens.some((token) => text.indexOf(token) !== -1)) { // NOSONAR [S7765] -- accepted compatible form
            return icon;
        }
    }

    return null;
}

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
    const reported = iconFromTokenRules(AVIATION_PRESENT_ICONS, present);
    if (reported) {
        return reported;
    }

    const cover = typeof station.cover === "string" ? station.cover.toUpperCase() : "";
    return AVIATION_COVER_ICONS[cover] || WeatherFormat.WEATHER_UNKNOWN_CONDITION;
}

// Every number this file takes off a vendor payload is read here. A METAR
// station with nothing to report sends "temp": null, and Number(null),
// Number(""), Number([]) and Number(false) are all 0. Coercing straight off the
// payload therefore turns a silent station into one reporting 0 °C at Null
// Island, and it can win the nearest-station race. Only a real number or a
// non-blank numeric string is a reading.
//
// The bounds are optional because they are not the same question: a coordinate
// outside [-90, 90] / [-180, 180] is not a coordinate, while a METAR field has
// no range this file is entitled to impose. Unbounded is the METAR reading, and
// it is what the defaults give.
function finiteNumber(value, minimum = -Infinity, maximum = Infinity) {
    if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) {
        return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ?
        parsed : null;
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
        if (!station || typeof station !== "object" || finiteNumber(station.temp) === null) {
            continue;
        }

        const stationLatitude = finiteNumber(station.lat);
        const stationLongitude = finiteNumber(station.lon);
        if (stationLatitude === null || stationLongitude === null) {
            continue;
        }

        // ranking only, so the flat approximation is enough inside a
        // one-degree box; the longitude gap shrinks toward the poles
        const dLatitude = stationLatitude - latitude;
        const dLongitude = longitudeDelta(stationLongitude, longitude) *
            Math.cos(latitude * Math.PI / 180);
        const distance = dLatitude * dLatitude + dLongitude * dLongitude;

        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = station;
        }
    }

    return nearest;
}

// A reading is unit-free: the condition glyph and the temperature in Celsius,
// with no formatting decision made yet. `condition` is the glyph because the
// glyph is the condition class (WEATHER_CONDITIONS keys it to a word for a
// screen reader). formatReading renders it to display text; only that render
// knows the units, so the same record serves the panel, the tooltip and the
// accessible name in whatever unit each is asked for.
function aviationWeatherReading(stations, place) {
    const station = aviationWeatherStation(stations, place);
    if (!station) {
        return null;
    }

    // METAR temperatures are Celsius by definition
    return { condition: aviationWeatherIcon(station), temperatureC: finiteNumber(station.temp) };
}

function weatherReading(weather) {
    // Open-Meteo answers `temperature: null` for a degraded station, and an
    // unchecked Math.round() turns that into "NaN°C" — a non-empty string,
    // which the provider chain reads as success: no failover to the two
    // providers that would have answered, and NaN kept as the last good
    // reading. The other two parsers check; this one has to as well.
    if (!weather || !Number.isFinite(weather.temperature)) {
        return null;
    }

    // Open-Meteo is asked for Celsius (forecastUrl), so the temperature is
    // Celsius like the other two rather than a server-side conversion
    return { condition: weatherIcon(weather.weathercode), temperatureC: weather.temperature };
}

// forecastUrl asks timezone=auto, so the reply names the zone of the very point
// it describes. That is the only authoritative zone available for a place the
// Nominatim fallback resolved — it publishes none — and for anything Open-Meteo
// geocoding refused under MIN_TRUSTED_GEOCODE_POPULATION, and it costs no extra
// request. The zone rides on the reading only when the service actually sent
// one, so a reading without it stays exactly the record it was.
function openMeteoReading(data) {
    const reading = weatherReading(data.current_weather);
    const timezone = reading ? geocodeTimezone(data.timezone) : "";
    return timezone ? {...reading, timezone} : reading;
}

const MET_NO_ICON_RULES = [
    [["thunder"], "⛈"],
    [["clearsky"], "☀"],
    [["fair"], "🌤"],
    [["partlycloudy"], "⛅"],
    [["fog", "cloudy"], "☁"],
    [["snow"], "🌨"],
    [["showers"], "🌦"],
    [["rain", "drizzle", "sleet"], "🌧"]
];

function metNoIcon(symbolCode) {
    const symbol = typeof symbolCode === "string" ? symbolCode.toLowerCase() : "";

    // "fair" in the table above is a real met.no symbol, so it cannot double as
    // the answer for a symbol_code this table does not know.
    return iconFromTokenRules(MET_NO_ICON_RULES, symbol) ||
        WeatherFormat.WEATHER_UNKNOWN_CONDITION;
}

function metNoSummary(data) {
    if (!data) {
        return null;
    }

    if (data.next_1_hours && data.next_1_hours.summary) { // NOSONAR [S6582] -- accepted compatible form
        return data.next_1_hours.summary;
    }
    if (data.next_6_hours && data.next_6_hours.summary) { // NOSONAR [S6582] -- accepted compatible form
        return data.next_6_hours.summary;
    }
    if (data.next_12_hours && data.next_12_hours.summary) { // NOSONAR [S6582] -- accepted compatible form
        return data.next_12_hours.summary;
    }

    return null;
}

function metNoWeatherReading(forecast) {
    if (!forecast || !forecast.properties || !Array.isArray(forecast.properties.timeseries) || // NOSONAR [S6582] -- accepted compatible form
        !forecast.properties.timeseries.length) {
        return null;
    }

    const point = forecast.properties.timeseries[0];
    if (!point || typeof point !== "object") {
        return null;
    }

    const data = point.data;
    if (!data || !data.instant || !data.instant.details || // NOSONAR [S6582] -- accepted compatible form
        !Number.isFinite(data.instant.details.air_temperature)) {
        return null;
    }

    const summary = metNoSummary(data);
    const icon = metNoIcon(summary ? summary.symbol_code : "");
    return { condition: icon, temperatureC: data.instant.details.air_temperature };
}

// "Genova" and "Génova" are two cities, and a user who types one of them without
// the accent — as an Italian keyboard makes easy, and as the city itself spells it
// — means the one they spelled. Folded, so that the accent is not the whole of the
// comparison; compared unfolded first, so that the exact spelling still wins.
//
// NFKD does most of the work: it decomposes an accented letter into its base
// plus a combining mark, and folds compatibility forms — full-width Latin
// (ＴＯＫＹＯ), Arabic presentation forms, half-width kana — onto their
// ordinary counterparts. NFD, which this used to use, does none of the last
// three, so a name in any of those forms could not match what the user typed.
//
// The marks are then stripped, but only the ones a writer routinely omits:
// Latin, Greek and Cyrillic accents, Hebrew niqqud, and Arabic harakat — the
// last of which also unifies the alef variants U+0623/U+0625/U+0627, whose
// hamza and madda are marks in that range. Indic vowel signs and the Japanese
// dakuten are deliberately left alone: they are letters rather than decoration,
// and folding them would make distinct names collide.
const OPTIONAL_DIACRITICS = new RegExp(
    String.raw`[\u0300-\u036f` +   // Latin, Greek and Cyrillic accents
    String.raw`\u0483-\u0489` +     // Cyrillic titlo and friends
    String.raw`\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7` + // Hebrew points
    String.raw`\u064b-\u065f\u0670]`, "g");                       // Arabic harakat

// What no normalization can reach: these letters carry the accent in the
// codepoint itself and have no decomposition at all — which is exactly why a
// keyboard without them produces the spelling on the right. The Greek final
// sigma is here for the same reason Unicode's own full case folding maps it
// onto sigma.
const UNDECOMPOSED_LETTERS = {
    "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o",
    "đ": "d", "ð": "d", "þ": "th", "ł": "l",
    "ħ": "h", "ı": "i", "ŋ": "n", "ĸ": "k",
    "ς": "σ"
};
const UNDECOMPOSED_PATTERN =
    new RegExp("[" + Object.keys(UNDECOMPOSED_LETTERS).join("") + "]", "g");

// An apostrophe is decoration in a place name and arrives in five shapes
// (Hawaiʻi, Coeur d’Alene, N'Djamena), and a hyphen and a space are the same
// joint (Saint-Étienne, Saint Etienne). Both sides of every comparison are
// folded, so dropping them cannot favour one spelling over the other.
const PLACE_NAME_PUNCTUATION = /['‘’ʻʼ´`]/g;
// An underscore is the same joint again: it is how an IANA identifier writes a
// space, so a settings field completing "Buenos_Aires" against "Buenos Aires"
// folds them together here rather than in a fourth rule of its own.
const PLACE_NAME_GAPS = /[\s_-]+/g;

function foldPlaceName(name) {
    return String(name || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(OPTIONAL_DIACRITICS, "")
        .replace(UNDECOMPOSED_PATTERN, (letter) => UNDECOMPOSED_LETTERS[letter])
        .replace(PLACE_NAME_PUNCTUATION, "")
        .replace(PLACE_NAME_GAPS, " ") // NOSONAR [S8786] -- input length is bounded
        .trim();
}

function geocodePlaceName(name) {
    return TextUtils.clampText(name, MAX_GEOCODE_PLACE_NAME_LENGTH);
}

function geocodeTimezone(value) {
    return typeof value === "string" ?
        TextUtils.clampText(value.trim(), MAX_GEOCODE_TIMEZONE_LENGTH) : "";
}

function placeCandidate(place) {
    if (!place || typeof place !== "object") {
        return null;
    }

    const latitude = finiteNumber(place.latitude, -90, 90);
    const longitude = finiteNumber(place.longitude, -180, 180);

    if (latitude === null || longitude === null) {
        return null;
    }

    return {
        name: geocodePlaceName(place.name),
        // what the typed name is compared against; for Open-Meteo the place name
        // is already bare, but a Nominatim hit carries its whole administrative
        // chain and only its leading component is the place
        matchName: geocodePlaceName(place.name),
        population: place.population,
        rankWeight: place.population,
        latitude,
        longitude,
        timezone: geocodeTimezone(place.timezone)
    };
}

// What makes one hit better than another, in order: the user's spelling exactly;
// then their spelling with the accents taken off both sides; then population.
// Population alone is not enough — it would answer "Genova" with the largest of
// the four Génovas — and an exact name alone is not enough either, since a
// thirty-person hamlet shares its name with the city.
function placeRank(place, query) {
    const typed = String(query || "").trim();
    const name = String(place.matchName || "");
    // Open-Meteo publishes population; Nominatim publishes `importance`, its own
    // relevance score. Both answer "how likely is this the one they meant" on
    // their own scale, and a weight is only ever compared against another hit
    // from the same provider, so one field carries both.
    const weight = Number(place.rankWeight);
    const exact = name.toLowerCase() === typed.toLowerCase() ? 2 : 0;
    const folded = foldPlaceName(name) === foldPlaceName(typed) ? 1 : 0;

    return [exact || folded, Number.isFinite(weight) ? weight : 0];
}

function betterPlace(candidate, best, query) {
    if (!best) {
        return candidate;
    }

    const [candidateName, candidatePopulation] = placeRank(candidate, query);
    const [bestName, bestPopulation] = placeRank(best, query);

    if (candidateName !== bestName) {
        return candidateName > bestName ? candidate : best;
    }

    return candidatePopulation > bestPopulation ? candidate : best;
}

function openMeteoGeocodePlace(data, query) {
    if (!data || !Array.isArray(data.results) || !data.results.length) {
        return null;
    }

    const best = data.results.reduce((currentBest, result) => {
        const candidate = placeCandidate(result);
        return candidate ? betterPlace(candidate, currentBest, query) : currentBest;
    }, null);

    const population = best ? Number(best.population) : NaN; // NOSONAR [S7773] -- accepted compatible form
    if (!Number.isFinite(population) || population < MIN_TRUSTED_GEOCODE_POPULATION) {
        return null;
    }
    return {
        name: best.name,
        latitude: best.latitude,
        longitude: best.longitude,
        timezone: best.timezone
    };
}

function nominatimCandidate(place) {
    if (!place || typeof place !== "object") {
        return null;
    }

    const latitude = finiteNumber(place.lat, -90, 90);
    const longitude = finiteNumber(place.lon, -180, 180);

    if (latitude === null || longitude === null) {
        return null;
    }

    // a non-string display_name is no name, not its coercion: `7` must read as
    // "" the way geocodePlaceName already treats it
    const displayName = typeof place.display_name === "string" ? place.display_name : "";

    return {
        name: geocodePlaceName(displayName),
        // display_name is the place followed by its administrative chain
        // ("Genoa, Liguria, Italy"); only the leading component is the name the
        // user could have typed
        matchName: geocodePlaceName(displayName.split(",")[0].trim()),
        rankWeight: place.importance,
        latitude,
        longitude
    };
}

// Open-Meteo refuses a candidate below MIN_TRUSTED_GEOCODE_POPULATION so that
// "the next geocoder in the queue arbitrates it" — but the next geocoder could
// not arbitrate anything: it asked for one hit, took data[0] with no population
// floor and no comparison against the name at all, and silently dropped the
// `query` every normalizer is handed. Whatever OSM ranked first became the
// resolved place, which is precisely the ambiguous-namesake case the floor
// exists for, with no marker distinguishing it from a confident hit.
//
// Ask for the same handful of candidates and run the same ranking. Nominatim
// publishes no population, so `importance` — its own relevance score — is the
// tiebreaker, and the typed name decides first, exactly as it does upstream.
function nominatimGeocodePlace(data, query) {
    if (!Array.isArray(data) || !data.length) {
        return null;
    }

    const best = data.reduce((currentBest, result) => {
        const candidate = nominatimCandidate(result);
        return candidate ? betterPlace(candidate, currentBest, query) : currentBest;
    }, null);

    if (!best) {
        return null;
    }

    return {
        name: best.name,
        latitude: best.latitude,
        longitude: best.longitude
    };
}

if (typeof module !== "undefined") {
    module.exports = { GEOCODE_CANDIDATE_COUNT,
        MAX_GEOCODE_PLACE_NAME_LENGTH,
        WEATHER_USER_AGENT, WEATHER_PROVIDER_NAMES, AVIATION_WEATHER_BBOX_DEGREES,
        weatherIcon, geocodeUrl, geocodeLanguage, nominatimGeocodeUrl, forecastUrl,
        metNoForecastUrl, aviationWeatherUrl, aviationWeatherIcon, finiteNumber,
        aviationWeatherStation, aviationWeatherReading, weatherReading, metNoIcon,
        metNoSummary, metNoWeatherReading, openMeteoReading,
        openMeteoGeocodePlace, nominatimGeocodePlace, foldPlaceName };
}
