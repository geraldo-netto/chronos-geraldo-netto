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
const GLib = GjsImports.gi.GLib;
const LocaleText = IS_NODE ?
    require("./localeText") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].localeText;
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;
const _ = LocaleText.translate;

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
// the IANA "no region" area: Etc/UTC, Etc/GMT+3 and the like are offsets, not
// places. Named to match settings_widgets_common.py's TZ_NO_REGION so the two
// timezone-to-city implementations filter the same set.
var TZ_NO_REGION = "Etc";
var TIMEZONE_FILE = "/etc/timezone";
var LOCALTIME_FILE = "/etc/localtime";
var ZONE_TAB_FILE = "/usr/share/zoneinfo/zone.tab";
var ZONEINFO_DIRECTORY = "/usr/share/zoneinfo/";
var MAX_TIMEZONE_FILE_BYTES = 1024;
var MAX_ZONE_TAB_BYTES = 256 * 1024;
var MAX_TIMEZONE_LINK_BYTES = 1024;
var MAX_TIMEZONE_ALIAS_HOPS = 16;
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
    // Must be an IANA Area/City path, and not the Etc/ block. UTC and "local"
    // have no "/" and are rejected by that; Etc/UTC and Etc/GMT+3 do have one,
    // but they are offsets, not places — and the Python local_city_name filters
    // the identical set. Without the Etc/ guard the last path segment gave the
    // bare "UTC"/"GMT+3", which JS then geocoded while Python wrote "", so the
    // two sides disagreed on the same weather-location key.
    if (identifier.indexOf("/") === -1 || identifier.indexOf(TZ_NO_REGION + "/") === 0) {
        return "";
    }

    return identifier.split("/").pop().replace(/_/g, " ").trim();
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

// A country can only be inferred from a named region. UTC, POSIX offsets and
// Etc/GMT offsets say nothing about where their user lives. Keep valid aliases
// untouched: zone.tab deliberately contains links such as Europe/Vatican, and
// resolving the symlink would discard exactly that lookup key.
function regionalTimezoneIdentifier(value) {
    if (typeof value !== "string") {
        return "";
    }

    const identifier = value.trim();
    if (!identifier || identifier.length > 255) {
        return "";
    }

    const segments = identifier.split("/");
    if (segments.length < 2 || segments[0] === TZ_NO_REGION) {
        return "";
    }

    for (const segment of segments) {
        if (!segment || segment === "." || segment === ".." ||
            !/^[A-Za-z0-9._+-]+$/.test(segment)) {
            return "";
        }
    }

    return identifier;
}

function timezoneFromLocaltimeLink(target) {
    const source = timezoneSourceFromLocaltimeLink(target);
    return source === null ? "" : source;
}

// null means this source revealed no timezone, while "" means it explicitly
// revealed a countryless or invalid timezone. Keeping those states distinct is
// important: an effective UTC setting must not fall through to a stale
// /etc/timezone left behind by another configuration tool.
function timezoneSourceIdentifier(value) {
    if (typeof value !== "string" || !value.trim()) {
        return null;
    }

    return regionalTimezoneIdentifier(value) || "";
}

function timezoneSourceFromLocaltimeLink(target) {
    if (typeof target !== "string") {
        return null;
    }

    const marker = "/zoneinfo/";
    const markerAt = target.indexOf(marker);
    return markerAt === -1 ? null :
        timezoneSourceIdentifier(target.slice(markerAt + marker.length));
}

// Pure source selector kept separate from filesystem I/O so precedence and
// alias preservation can be checked without depending on a test machine.
function localTimezoneFromSources(timezoneFile, localtimeLink, glibIdentifier) {
    const localtimeSource = timezoneSourceFromLocaltimeLink(localtimeLink);
    if (localtimeSource !== null) {
        return localtimeSource;
    }

    const glibSource = timezoneSourceIdentifier(glibIdentifier);
    if (glibSource !== null) {
        return glibSource;
    }

    return timezoneSourceIdentifier(timezoneFile) || "";
}

// Resolve one lexical symlink target as a path below the zoneinfo directory.
// This is deliberately not a general realpath implementation: paths cannot
// escape the database root, and only geographic timezone identifiers survive.
function validTimezoneLinkTarget(target) {
    if (typeof target !== "string") {
        return false;
    }
    if (!target || target.length > MAX_TIMEZONE_LINK_BYTES) {
        return false;
    }
    return target.indexOf("\0") === -1;
}

function timezoneLinkSegments(identifier, target) {
    if (target.indexOf("/") === 0) {
        return target.indexOf(ZONEINFO_DIRECTORY) === 0 ?
            target.slice(ZONEINFO_DIRECTORY.length).split("/") : null;
    }

    const segments = identifier.split("/");
    segments.pop();
    segments.push(...target.split("/"));
    return segments;
}

function normalizedTimezonePath(segments) {
    const normalized = [];
    for (const segment of segments) {
        if (!segment || segment === ".") {
            continue;
        }
        if (segment === "..") {
            if (!normalized.length) {
                return "";
            }
            normalized.pop();
            continue;
        }
        if (!/^[A-Za-z0-9._+-]+$/.test(segment)) {
            return "";
        }
        normalized.push(segment);
    }

    return regionalTimezoneIdentifier(normalized.join("/"));
}

function timezoneAliasTarget(timezone, target) {
    const identifier = regionalTimezoneIdentifier(timezone);
    if (!identifier || !validTimezoneLinkTarget(target)) {
        return "";
    }

    const segments = timezoneLinkSegments(identifier, target);
    return segments ? normalizedTimezonePath(segments) : "";
}

function readTimezoneLink(current, readLink) {
    try {
        const target = readLink(ZONEINFO_DIRECTORY + current);
        return target === undefined ? null : target;
    } catch {
        return null;
    }
}

function followTimezoneSymlinks(current, readLink, seen, hop) {
    const target = readTimezoneLink(current, readLink);
    if (target === null) {
        return hop ? current : "";
    }
    if (hop === MAX_TIMEZONE_ALIAS_HOPS) {
        return "";
    }

    const next = timezoneAliasTarget(current, target);
    if (!next || seen.has(next)) {
        return "";
    }
    seen.add(next);
    return followTimezoneSymlinks(next, readLink, seen, hop + 1);
}

// Follow only lexical zoneinfo links. The callback makes the bounded, cycle-
// safe algorithm independently testable and keeps filesystem I/O at the edge.
function canonicalTimezoneFromSymlinks(timezone, readLink) {
    const current = regionalTimezoneIdentifier(timezone);
    if (!current || typeof readLink !== "function") {
        return "";
    }

    return followTimezoneSymlinks(current, readLink, new Set([current]), 0);
}

// zone.tab is the OS timezone database's explicit timezone-to-country mapping.
// Do not guess from the Area part: America/Indiana/Indianapolis and
// America/Argentina/Buenos_Aires demonstrate why that would not be a country.
function countryCodeFromZoneTab(timezone, zoneTab) {
    const identifier = regionalTimezoneIdentifier(timezone);
    if (!identifier || typeof zoneTab !== "string" ||
        !zoneTab || zoneTab.length > MAX_ZONE_TAB_BYTES) {
        return "";
    }

    let country = "";
    const seenTimezones = new Set();
    for (const line of zoneTab.split(/\r?\n/)) {
        if (!line || line.indexOf("#") === 0) {
            continue;
        }

        const fields = line.split("\t");
        const validFieldCount = fields.length === 3 || fields.length === 4;
        if (!validFieldCount || !/^[A-Z]{2}$/.test(fields[0]) ||
            !/^[+-]\d{4}(?:\d{2})?[+-]\d{5}(?:\d{2})?$/.test(fields[1]) ||
            regionalTimezoneIdentifier(fields[2]) !== fields[2] ||
            seenTimezones.has(fields[2])) {
            return "";
        }

        seenTimezones.add(fields[2]);
        if (fields[2] === identifier) {
            country = fields[0];
        }
    }

    return country;
}

function readTextFile(filename, maximumBytes) {
    try {
        const [success, contents] = GLib.file_get_contents(filename);
        if (!success || contents === null || contents === undefined ||
            contents.length > maximumBytes) {
            return "";
        }
        return typeof contents === "string" ? contents :
            new TextDecoder().decode(contents);
    } catch {
        return "";
    }
}

// Read on every call rather than memoizing: changing the operating-system
// timezone must change the next automatic holiday default too.
function localCountryCode() {
    let localtimeLink = "";
    let glibIdentifier = "";

    try {
        localtimeLink = GLib.file_read_link(LOCALTIME_FILE);
    } catch {
        localtimeLink = "";
    }

    try {
        glibIdentifier = timezoneIdentity(GLib.TimeZone.new_local()) || "";
    } catch {
        glibIdentifier = "";
    }

    let timezoneSource = timezoneSourceFromLocaltimeLink(localtimeLink);
    if (timezoneSource === null) {
        timezoneSource = timezoneSourceIdentifier(glibIdentifier);
    }
    if (timezoneSource === null) {
        const timezoneFile = readTextFile(TIMEZONE_FILE, MAX_TIMEZONE_FILE_BYTES);
        timezoneSource = timezoneSourceIdentifier(timezoneFile);
    }

    const timezone = timezoneSource || "";
    if (!timezone) {
        return "";
    }

    const zoneTab = readTextFile(ZONE_TAB_FILE, MAX_ZONE_TAB_BYTES);
    const exactCountry = countryCodeFromZoneTab(timezone, zoneTab);
    if (exactCountry) {
        return exactCountry;
    }

    const canonical = canonicalTimezoneFromSymlinks(timezone,
        (filename) => GLib.file_read_link(filename));
    return canonical ? countryCodeFromZoneTab(canonical, zoneTab) : "";
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
    return TextUtils.clampText(label, MAX_CLOCK_LABEL_LENGTH);
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
        regionalTimezoneIdentifier,
        timezoneFromLocaltimeLink,
        localTimezoneFromSources,
        timezoneAliasTarget,
        canonicalTimezoneFromSymlinks,
        countryCodeFromZoneTab,
        localCountryCode,
        builtInTimezoneKeys,
        selectUserClocks,
        clockDisplayLabel,
        MAX_CLOCK_LABEL_LENGTH,
        MAX_ZONE_TAB_BYTES
    };
}
