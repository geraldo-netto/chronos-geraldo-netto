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
// findExtensionSubdirectory has already repointed at the 6.0/ directory — and the
// applet would fail to load, because localeUtils.js is not in there.
//
// Node is what this asks about, because Node is the only host that requires these
// files directly. Cinnamon's cjs has no `process`.
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const GLib = GjsImports.gi.GLib;
const LocaleText = IS_NODE ?
    require("./localeText") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].localeText;
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;
const ClockLimits = IS_NODE ?
    require("./clockLimits") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].clockLimits;
const IoUtils = IS_NODE ?
    require("./ioUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].ioUtils;
const ProviderUtils = IS_NODE ?
    require("./providerUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].providerUtils;
const _ = LocaleText.translate;

var MAX_CLOCKS = ClockLimits.MAX_CLOCKS; // NOSONAR [S3504] -- GJS importer export
// The label is the user's own name for the clock, and the settings dialog puts
// no limit on it. It is rendered in the popup grid and padded to the widest
// cell in the monospace tooltip, so a single 60-character name stretches both
// to match it, with nothing truncating. The panel suffix has been capped all
// along — at 48 — for exactly this reason; the other two readouts were not.
// A city name is a few words.
//
// Cells, because that is what the layout it protects is measured in. It was
// enforced with a code-point clamp, and the two units part company on exactly
// the text the width work exists for: 24 ideographs are 24 code points and 48
// cells.
var MAX_CLOCK_LABEL_CELLS = 24; // NOSONAR [S3504] -- GJS importer export
// Keep persisted/user-facing text available for editing and disclosure, while
// still bounding every settings value admitted into the compositor process.
var MAX_CLOCK_INPUT_LABEL_LENGTH = 128; // NOSONAR [S3504] -- GJS importer export
// Same as the settings entry's bound: imported/hand-edited rows must not reach
// GLib timezone construction or memo keys with text the editor cannot create.
var MAX_CLOCK_TIMEZONE_LENGTH = 64; // NOSONAR [S3504] -- GJS importer export
var LOCAL_TIMEZONE = "local"; // NOSONAR [S3504] -- GJS importer export
var UTC_TIMEZONE = "UTC"; // NOSONAR [S3504] -- GJS importer export
// the IANA "no region" area: Etc/UTC, Etc/GMT+3 and the like are offsets, not
// places. Named to match chronos_timezone_data.py's TZ_NO_REGION so the two
// timezone-to-city implementations filter the same set.
var TZ_NO_REGION = "Etc"; // NOSONAR [S3504] -- GJS importer export
var TIMEZONE_FILE = "/etc/timezone"; // NOSONAR [S3504] -- GJS importer export
var LOCALTIME_FILE = "/etc/localtime"; // NOSONAR [S3504] -- GJS importer export
var ZONE_TAB_FILE = "/usr/share/zoneinfo/zone.tab"; // NOSONAR [S3504] -- GJS importer export
var ZONEINFO_DIRECTORY = "/usr/share/zoneinfo/"; // NOSONAR [S3504] -- GJS importer export
var MAX_TIMEZONE_FILE_BYTES = 1024; // NOSONAR [S3504] -- GJS importer export
var MAX_ZONE_TAB_BYTES = 256 * 1024; // NOSONAR [S3504] -- GJS importer export
var MAX_TIMEZONE_LINK_BYTES = 1024; // NOSONAR [S3504] -- GJS importer export
var MAX_TIMEZONE_ALIAS_HOPS = 16; // NOSONAR [S3504] -- GJS importer export
var INVALID_TIMEZONE_TEXT = _("Invalid timezone"); // NOSONAR [S3504] -- GJS importer export
var LOCAL_TIME_TEXT = _("Local time"); // NOSONAR [S3504] -- GJS importer export

// new_identifier landed in GLib 2.68 and answers null for an identifier it does
// not know, which is what tells an invalid zone from a valid one. Cinnamon 5.4 —
// the oldest release this applet loads on — ships GLib 2.72, so the old
// TimeZone.new() path (which silently answers UTC for an unknown zone, and had
// to be caught by comparing the resolved identifier) was unreachable.
function timezoneFromIdentifier(timezone) {
    if (!TextUtils.validNativeText(timezone)) {
        return null;
    }
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

// Weather egress must use the runtime's resolved timezone, not the configured
// text. The settings fallback can validate only an Area/City shape when no
// timezone database is available; GLib is authoritative in the applet.
//
// The open menu resolves every configured clock on every tick, and each
// resolution includes GLib validation, alias readlinks, and zone.tab country
// lookup. The complete immutable request is memoized per identifier so those
// native operations are not repeated on the compositor's presentation path.
// "local" stays out of the memo: it names whatever the OS timezone is now.
var MAX_MEMOIZED_WEATHER_CITIES = 64; // NOSONAR [S3504] -- GJS importer export
const weatherCityMemo = new Map();

function resolveTimezoneWeatherRequest(timezone) {
    const identifier = regionalTimezoneIdentifier(
        zoneinfoIdentifier(timezoneIdentity(timezoneFromIdentifier(timezone))));
    if (!identifier) {
        return null;
    }
    const canonical = canonicalTimezoneFromSymlinks(identifier, (filename) => GLib.file_read_link(filename));
    if (!canonical) {
        return null;
    }
    const zoneTab = readTextFile(ZONE_TAB_FILE, MAX_ZONE_TAB_BYTES);
    const exactCountry = countryCodeFromZoneTab(identifier, zoneTab);
    const countryCode = exactCountry || countryCodeFromZoneTab(canonical, zoneTab);
    // zone.tab names real locations even when their rules share a symlink.
    // Bratislava is in Slovakia; following its rules to Prague loses that fact.
    const location = exactCountry ? identifier : canonical;
    return Object.freeze({
        query: location.split("/").pop().split("_").join(" "),
        hint: Object.freeze({ timezone: canonical, countryCode })
    });
}

function timezoneWeatherRequest(timezone) {
    if (timezone === LOCAL_TIMEZONE) {
        return resolveTimezoneWeatherRequest(timezone);
    }
    if (weatherCityMemo.has(timezone)) {
        // A Map iterates in insertion order, so re-inserting on a hit is what
        // makes the first key the least recently used one. Without it the
        // eviction below drops whichever zone happened to be resolved first,
        // which may be the one asked about every tick.
        const remembered = weatherCityMemo.get(timezone);
        weatherCityMemo.delete(timezone);
        weatherCityMemo.set(timezone, remembered);
        return remembered;
    }

    const city = resolveTimezoneWeatherRequest(timezone);
    if (weatherCityMemo.size >= MAX_MEMOIZED_WEATHER_CITIES) {
        // the oldest one, not all of them: clearing the memo wholesale sent
        // every configured clock back through a GLib.TimeZone construction and
        // a synchronous readlink chase, on the compositor thread
        weatherCityMemo.delete(weatherCityMemo.keys().next().value);
    }
    weatherCityMemo.set(timezone, city);
    return city;
}

// The memo lives on the importer-loaded root module, so it outlives every
// applet instance on the panel — and it is shared by all of them, like the
// Nominatim spacing queue and the locale query handles. The last one to leave
// releases it; the first to arrive claims it before anything can throw.
const _worldclockConsumers = ProviderUtils.moduleConsumerCount({
    onLastRelease: () => weatherCityMemo.clear()
});

function registerWorldclockConsumer() {
    _worldclockConsumers.register();
}

function releaseWorldclockConsumer() {
    _worldclockConsumers.release();
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

    const fallback = typeof timezoneFile === "function" ? timezoneFile() : timezoneFile;
    return timezoneSourceIdentifier(fallback) || "";
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
    return target.indexOf("\0") === -1; // NOSONAR [S7765] -- accepted compatible form
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

function applyTimezoneSegment(normalized, segment) {
    if (!segment || segment === ".") {
        return true;
    }
    if (segment === "..") {
        if (normalized.length === 0) {
            return false;
        }
        normalized.pop();
        return true;
    }
    if (!/^[A-Za-z0-9._+-]+$/.test(segment)) {
        return false;
    }
    normalized.push(segment);
    return true;
}

function normalizedTimezonePath(segments) {
    const normalized = [];
    for (const segment of segments) {
        if (!applyTimezoneSegment(normalized, segment)) {
            return "";
        }
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

// Answers the canonical identifier for any zone, alias or not: a zone that is
// not a link is already its own canonical name. It used to answer "" at hop
// zero, which forced every caller that wanted a name to probe with a second
// readlink first -- the syscall the weather-city memo above exists to avoid.
// Callers that need "was this an alias?" compare the answer with what they
// passed in.
function followTimezoneSymlinks(current, readLink, seen, hop) {
    const target = readTimezoneLink(current, readLink);
    if (target === null) {
        return current;
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
function validZoneTabFields(fields, seenTimezones) {
    return (fields.length === 3 || fields.length === 4) &&
        /^[A-Z]{2}$/.test(fields[0]) &&
        /^[+-]\d{4}(?:\d{2})?[+-]\d{5}(?:\d{2})?$/.test(fields[1]) &&
        regionalTimezoneIdentifier(fields[2]) === fields[2] &&
        !seenTimezones.has(fields[2]);
}

// Reject an individual malformed row without discarding unrelated mappings.
// Bounded diagnostics keep the source problem visible for investigation.
const MAX_LOGGED_ZONE_TAB_LINE = 200;

function reportMalformedZoneTabLine(line) {
    if (!global.logError) {
        return;
    }
    const shown = line.length > MAX_LOGGED_ZONE_TAB_LINE ?
        `${line.slice(0, MAX_LOGGED_ZONE_TAB_LINE)}...` : line;
    global.logError(`chronos@geraldo-netto: skipping a row in ${ZONE_TAB_FILE} ` +
        `that this applet cannot parse: ` +
        JSON.stringify(shown));
}

function countryCodeFromZoneTab(timezone, zoneTab) {
    const identifier = regionalTimezoneIdentifier(timezone);
    if (!identifier || typeof zoneTab !== "string" ||
        !zoneTab || zoneTab.length > MAX_ZONE_TAB_BYTES) {
        return "";
    }

    let country = "";
    const seenTimezones = new Set();
    for (const line of zoneTab.split(/\r?\n/)) {
        if (!line || line.indexOf("#") === 0) { // NOSONAR [S6557] -- accepted compatible form
            continue;
        }

        const fields = line.split("\t");
        if (!validZoneTabFields(fields, seenTimezones)) {
            reportMalformedZoneTabLine(line);
            continue;
        }

        seenTimezones.add(fields[2]);
        if (fields[2] === identifier) {
            country = fields[0];
        }
    }

    return country;
}

// ioUtils is the project's I/O adapter, and this module used to reach past it:
// GLib.file_get_contents behind two byte caps of its own, a second regime that
// no hardening applied to the shared adapter could reach - and one that
// answered "" for an oversized file without a word, where ioUtils logs it.
function readTextFile(filename, maximumBytes) {
    return IoUtils.readTextFileCapped(filename, maximumBytes, filename);
}

// Read on every call rather than memoizing: changing the operating-system
// timezone must change the next automatic holiday default too.
function localCountryCode() {
    let localtimeLink;
    let glibIdentifier;

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

    const timezone = localTimezoneFromSources(
        () => readTextFile(TIMEZONE_FILE, MAX_TIMEZONE_FILE_BYTES),
        localtimeLink,
        glibIdentifier);
    if (!timezone) {
        return "";
    }

    const zoneTab = readTextFile(ZONE_TAB_FILE, MAX_ZONE_TAB_BYTES);
    const exactCountry = countryCodeFromZoneTab(timezone, zoneTab);
    if (exactCountry) {
        return exactCountry;
    }

    // The exact key has already been tried, so only a *different* canonical
    // name is worth a second pass over zone.tab.
    const canonical = canonicalTimezoneFromSymlinks(timezone,
        (filename) => GLib.file_read_link(filename));
    return canonical && canonical !== timezone ?
        countryCodeFromZoneTab(canonical, zoneTab) : "";
}

// GLib answers get_identifier() with the string it was given — it does not
// canonicalize — and for the local zone that string is whatever TZ holds. TZ
// takes a POSIX colon prefix and an absolute path, so the same zone reaches
// this comparison as "Europe/Rome", ":Europe/Rome" or
// "/usr/share/zoneinfo/Europe/Rome" depending only on how the session was
// started. Comparing those raw meant a clock the user set to their own zone was
// not recognised as the built-in local row, and the popup drew the same zone
// twice while the settings dialog — which already reduces TZ to a plain
// zoneinfo name — considered it a duplicate and hid it.
//
// This is the same rule as chronos_timezone_data.zoneinfo_identifier, and the
// shared parity fixture holds both sides to it.
function zoneinfoIdentifier(identifier) {
    if (typeof identifier !== "string") {
        return "";
    }

    const trimmed = identifier.trim();
    const named = trimmed.startsWith(":") ? trimmed.slice(1) : trimmed;
    const marker = "/zoneinfo/";
    const index = named.lastIndexOf(marker);
    return index === -1 ? named : named.slice(index + marker.length);
}

// A saved clock is already an identifier, so it is reduced and compared as a
// string — the settings side does exactly this, and handing GLib a
// colon-prefixed or absolute spelling to validate answers null for a zone that
// exists, letting the row escape the collision check. "local" is the one saved
// value that is not an identifier: it is the word, and only GLib knows which
// zone the word stands for.
function timezoneComparisonKey(timezone) {
    if (timezone === LOCAL_TIMEZONE) {
        return zoneinfoIdentifier(timezoneIdentity(GLib.TimeZone.new_local()));
    }

    return zoneinfoIdentifier(timezone);
}

// The built-in list is two entries and one of them is "local", so asking GLib
// which zone that stands for is the point of this — and a zone GLib does not
// know names nothing to compare against. The reduction is applied to its
// answer, because for "local" that answer is whatever TZ holds.
function builtInTimezoneKeys(builtins) {
    const keys = new Set();
    builtins.forEach((item) => {
        const tz = timezoneFromIdentifier(item.timezone);
        const identity = zoneinfoIdentifier(timezoneIdentity(tz));
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
function normalizedClockEntry(clock) {
    if (!clock || typeof clock !== "object" || Array.isArray(clock)) {
        return null;
    }

    const label = clockInputLabel(clock.label);
    const timezone = TextUtils.validNativeText(clock.timezone) ? clock.timezone.trim() : "";
    return label && timezone && timezone.length <= MAX_CLOCK_TIMEZONE_LENGTH ?
        { label, timezone } : null;
}

function selectUserClocks(clocks) {
    const configured = Array.isArray(clocks) ? clocks : [];
    const builtinKeys = builtInTimezoneKeys(builtinClocks());
    const selectedKeys = new Set();
    const selected = [];

    for (const clock of configured) {
        const normalized = normalizedClockEntry(clock);
        if (!normalized) {
            continue;
        }

        const identity = timezoneComparisonKey(normalized.timezone) || normalized.timezone;
        if (builtinKeys.has(identity) || selectedKeys.has(identity)) {
            continue;
        }

        selectedKeys.add(identity);
        selected.push(normalized);
        if (selected.length >= MAX_CLOCKS) {
            break;
        }
    }

    return selected;
}

// Cells, not code points: the cap's own rationale is the popup grid and the
// monospace tooltip, which pads to the widest cell, and both are measured with
// TextUtils.displayWidth. A code-point clamp let "東".repeat(24) through at 24
// points and 48 cells - twice the budget - in the CJK sessions the width work
// was done for.
function clockDisplayLabel(label) {
    const normalized = typeof label === "string" ? label.trim() : "";
    return TextUtils.clampToWidth(normalized, MAX_CLOCK_LABEL_CELLS);
}

// textUtils names "a world clock's label" as exactly what its shared rule is
// for, and this was the one caller that clamped without it. A Display name
// pasted with an embedded newline reached the popup row's St.Label verbatim, so
// the row grew a second line and shifted the calendar grid, and the same string
// became one cell of the monospace panel tooltip whose padding is computed from
// the cell's code-point count — splitting the row and misaligning every column.
function clockInputLabel(label) {
    const normalized = TextUtils.validUnicode(label) ?
        TextUtils.sanitizeControlCharacters(label).trim() : "";
    return TextUtils.clampText(normalized, MAX_CLOCK_INPUT_LABEL_LENGTH);
}

if (typeof module !== "undefined") {
    module.exports = {
        MAX_CLOCKS,
        LOCAL_TIMEZONE,
        UTC_TIMEZONE,
        INVALID_TIMEZONE_TEXT,
        LOCAL_TIME_TEXT,
        timezoneFromIdentifier,
        builtinClocks,
        timezoneIdentity,
        zoneinfoIdentifier,
        timezoneWeatherRequest,
        registerWorldclockConsumer,
        releaseWorldclockConsumer,
        regionalTimezoneIdentifier,
        localTimezoneFromSources,
        timezoneAliasTarget,
        canonicalTimezoneFromSymlinks,
        countryCodeFromZoneTab,
        localCountryCode,
        builtInTimezoneKeys,
        selectUserClocks,
        clockDisplayLabel,
        clockInputLabel,
        MAX_CLOCK_LABEL_CELLS,
        MAX_CLOCK_INPUT_LABEL_LENGTH,
        MAX_CLOCK_TIMEZONE_LENGTH,
        MAX_ZONE_TAB_BYTES,
        MAX_MEMOIZED_WEATHER_CITIES
    };
}
