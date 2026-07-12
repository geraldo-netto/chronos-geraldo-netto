/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const GLib = GjsImports.gi.GLib;
const Utils = typeof require === "function" ?
    require("./utils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].utils;
const _ = Utils.translate;

// user-configurable clocks; the built-in UTC and local rows come on top
var MAX_CLOCKS = 8;
// The label is the user's own name for the clock, and the settings dialog puts
// no limit on it. It is rendered in the popup grid and padded to the widest
// cell in the monospace tooltip, so a single 60-character name stretches both
// to match it, with nothing truncating. The panel suffix has been capped all
// along — at 48 — for exactly this reason; the other two readouts were not.
// A city name is a few words.
var MAX_CLOCK_LABEL_LENGTH = 24;
var LOCAL_TIMEZONE = "local";
var UTC_TIMEZONE = "UTC";
var INVALID_TIMEZONE_TEXT = _("Invalid timezone");
var LOCAL_TIME_TEXT = _("Local time");

// new_identifier landed in GLib 2.68 and answers null for an identifier it does
// not know, which is what tells an invalid zone from a valid one. Cinnamon 5.4 —
// the oldest release this applet loads on — ships GLib 2.72, so the old
// TimeZone.new() path (which silently answers UTC for an unknown zone, and had
// to be caught by comparing the resolved identifier) was unreachable.
function timezoneFromIdentifier(timezone) {
    if (timezone === LOCAL_TIMEZONE) {
        return GLib.TimeZone.new_local();
    }

    return GLib.TimeZone.new_identifier(timezone);
}

function builtinClocks() {
    return [
        { label: UTC_TIMEZONE, timezone: UTC_TIMEZONE },
        { label: LOCAL_TIME_TEXT, timezone: LOCAL_TIMEZONE }
    ];
}

// GLib.TimeZone has had get_identifier() since 2.58, and answers null only for
// a zone it does not know. There used to be a `tz.timezone || fallback` branch
// under this — a property no real GLib.TimeZone has. It existed because a test
// double had the wrong shape, and it was "covered" by a case that cannot happen
// at runtime: production code bent to fit a mock.
function timezoneIdentity(tz) {
    return tz ? tz.get_identifier() : null;
}

// The place to ask the weather about is the one the timezone names, not the
// name the user typed. A clock called "Mom's place" or "Work" is a nickname,
// and geocoding it sends that nickname to two third-party services every half
// hour — while answering the wrong question anyway. The IANA identifier
// already carries the city: America/Argentina/Buenos_Aires is Buenos Aires.
function timezoneCityName(timezone) {
    if (typeof timezone !== "string" || !timezone.trim()) {
        return "";
    }

    const identifier = timezone.trim();
    // the built-in rows are not places: UTC is a scale, and the local row is
    // the panel location's job
    if (identifier === LOCAL_TIMEZONE || identifier === UTC_TIMEZONE) {
        return "";
    }

    const city = identifier.split("/").pop();
    if (!city || city === identifier) {
        // a bare word that is not an IANA path is not something to geocode
        return "";
    }

    return city.replace(/_/g, " ").trim();
}

// The city the machine's own timezone names, for a weather location nobody has
// filled in. Nothing is asked of the network to find out where the user is: the
// zone is already on disk, and it is the same answer the local clock row uses.
// It names the zone's reference city, so a user in Genoa gets Rome — which is
// why this is written into the settings field rather than resolved invisibly.
// An offset-only zone (+02) and a stub /etc/localtime name no city and answer "".
function localCityName() {
    return timezoneCityName(timezoneIdentity(GLib.TimeZone.new_local()));
}

function builtInTimezoneKeys(builtins) {
    const keys = new Set();
    builtins.forEach((item) => {
        const tz = timezoneFromIdentifier(item.timezone);
        const identity = timezoneIdentity(tz);
        if (identity) {
            keys.add(identity);
        }
    });
    keys.add("Etc/UTC");
    return keys;
}

// Which of the user's configured clocks actually count: the ones that are not
// already shown as a built-in row, up to the cap.
//
// This existed twice, and the two copies disagreed. The popup filtered the
// built-in identities and took the first eight; the weather side took the first
// eight with no built-in filter at all. So a clock set to Etc/UTC appeared
// nowhere — it collides with the built-in UTC row — and was still geocoded
// against two third-party services every half hour, forever, and still consumed
// one of the eight weather slots, which silently cost the last real clock its
// temperature. Two selection algorithms for one list will keep diverging.
function selectUserClocks(clocks) {
    const configured = Array.isArray(clocks) ? clocks : [];
    const builtinKeys = builtInTimezoneKeys(builtinClocks());
    const selected = [];

    for (const clock of configured) {
        if (!clock) {
            continue;
        }

        const tz = timezoneFromIdentifier(clock.timezone);
        const identity = timezoneIdentity(tz);
        if (builtinKeys.has(identity)) {
            continue;
        }

        // clamped here, where the clocks are chosen, so the popup, the tooltip
        // and the weather readings all key off the same string
        selected.push({ label: clockDisplayLabel(clock.label), timezone: clock.timezone });
        if (selected.length >= MAX_CLOCKS) {
            break;
        }
    }

    return selected;
}

function clockDisplayLabel(label) {
    const text = typeof label === "string" ? label : "";
    // code points, not UTF-16 units: a blind slice splits a surrogate pair, and
    // emoji in a clock name are entirely normal
    const chars = Array.from(text);
    if (chars.length <= MAX_CLOCK_LABEL_LENGTH) {
        return text;
    }

    return chars.slice(0, MAX_CLOCK_LABEL_LENGTH - 1).join("").replace(/\s+$/, "") + "…";
}

if (typeof module !== "undefined") {
    module.exports = {
        MAX_CLOCKS,
        LOCAL_TIMEZONE,
        UTC_TIMEZONE,
        INVALID_TIMEZONE_TEXT,
        LOCAL_TIME_TEXT,
        timezoneFromIdentifier,
        localCityName,
        builtinClocks,
        timezoneIdentity,
        timezoneCityName,
        builtInTimezoneKeys,
        selectUserClocks,
        clockDisplayLabel,
        MAX_CLOCK_LABEL_LENGTH
    };
}
