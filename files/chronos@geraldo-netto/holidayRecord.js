// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports */

// App-owned holiday record contract. Provider adapters translate wire payloads
// into this shape; the domain validates, localizes and expands it here.
const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const DateMath = IS_NODE ?
    require("./dateMath") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].dateMath;
const HolidayConstants = IS_NODE ?
    require("./holidayConstants") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayConstants;
// only for the religion ids, which are flags this applet mints for its own rows
const ReligiousCatalog = IS_NODE ?
    require("./religiousCatalog") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].religiousCatalog;
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;

const MSECS_IN_DAY = DateMath.MSECS_IN_DAY;
const PUBLIC_HOLIDAY_FLAG = HolidayConstants.PUBLIC_HOLIDAY_FLAG;
const RELIGIOUS_HOLIDAY_FLAG = HolidayConstants.RELIGIOUS_HOLIDAY_FLAG;
const CALENDAR_OBSERVANCE_FLAG = "calendar_observance";
const PART_DAY_HOLIDAY = HolidayConstants.PART_DAY_HOLIDAY;
const DAY_CLASSIFICATION_FLAGS = [PUBLIC_HOLIDAY_FLAG, RELIGIOUS_HOLIDAY_FLAG,
    CALENDAR_OBSERVANCE_FLAG, PART_DAY_HOLIDAY];
const monthHolidayEntry = HolidayConstants.monthHolidayEntry;

var MAX_HOLIDAY_SPAN_DAYS = 366; // NOSONAR [S3504] -- GJS importer export
var MAX_HOLIDAYS_PER_YEAR = 1000; // NOSONAR [S3504] -- GJS importer export
var MAX_EXPANDED_HOLIDAY_ROWS = 4000; // NOSONAR [S3504] -- GJS importer export
// Flags are the one payload dimension expansion multiplies without a bound of
// its own: a 366-day span reuses the same array across 367 rows before the
// cache serializes them all, so a near-cap accepted response could amplify
// toward gigabytes. Real flag sets are one or two short enum words.
var MAX_HOLIDAY_FLAGS = 8; // NOSONAR [S3504] -- GJS importer export
var MAX_HOLIDAY_FLAG_LENGTH = 64; // NOSONAR [S3504] -- GJS importer export

// Holiday names come from three third-party services and land in a Pango
// tooltip. Same-day names are joined, so a provider that repeats itself grows
// the string without limit; a megabyte of tooltip stalls the compositor on
// layout. Real names are a few words, and this is the whole joined cell.
var MAX_HOLIDAY_NAME_LENGTH = 300; // NOSONAR [S3504] -- GJS importer export

function compareCodeUnits(left, right) {
    if (left < right) {
        return -1;
    }
    return left > right ? 1 : 0;
}

function clampHolidayName(name) {
    return TextUtils.clampText(name, MAX_HOLIDAY_NAME_LENGTH);
}

// One order and one bound for every flag list this applet stores or renders.
// 6.0/calendarAnnotations.js diffs a cell's flags positionally, so two
// producers with different orders repaint a tooltip that has not changed.
function _sortedBoundedFlags(flags) {
    const unique = Array.from(new Set(flags)).sort(compareCodeUnits);
    const classification = unique.filter((flag) => DAY_CLASSIFICATION_FLAGS.includes(flag));
    const auxiliary = unique.filter((flag) => !DAY_CLASSIFICATION_FLAGS.includes(flag))
        .slice(0, MAX_HOLIDAY_FLAGS - classification.length);
    return classification.concat(auxiliary).sort(compareCodeUnits);
}

// The union has to respect the same bound each side was admitted under.
// Without the cap, two same-day rows with disjoint flag sets — Nager's
// lowercased `types`, Enrico's verbatim `flags` — could merge to sixteen; the
// loader then rejected that row on `validHolidayFlags`, the row count no longer
// matched what was written, and `_country` responded by discarding **every**
// freshness stamp for the country. The country was then refetched over the
// network at every login for as long as the merge recurred.
//
// Ordinary observances make no non-working-day claim. Public rows still must
// agree the day is partial; a full public holiday takes precedence.
function permitsPartialDay(flags) {
    return flags.includes(PART_DAY_HOLIDAY) || !flags.includes(PUBLIC_HOLIDAY_FLAG);
}

function mergeHolidayFlags(current, incoming) {
    const keepPartial = permitsPartialDay(current) && permitsPartialDay(incoming);
    return _sortedBoundedFlags(current.concat(incoming)
        .filter((flag) => keepPartial || flag !== PART_DAY_HOLIDAY));
}

// Tagging one row with a flag it is entitled to — not a merge of two claims, so
// the part-day rule does not apply and a partial day stays partial.
function withHolidayFlag(flags, flag) {
    return _sortedBoundedFlags(flags.concat([flag]));
}

// The one join for "two things happen on this day": the public row the cache
// merges into another public row, and the religious observance the calendar
// layers on top of both. It was written twice, under comments in three files
// claiming the two agreed — and they did not: the religious copy re-appended a
// name it already carried, left the joined string unbounded (so a merged
// public+religious cell could carry exactly the tooltip MAX_HOLIDAY_NAME_LENGTH
// exists to prevent), and kept insertion order where the cache sorted.
//
// `existing` is not mutated; the caller decides whether the result is a change.
function joinHolidayEntry(existing, name, flags) {
    const incoming = flags || [];
    if (!existing) {
        return monthHolidayEntry(clampHolidayName(name),
            _sortedBoundedFlags(incoming));
    }

    const merged = mergeHolidayFlags(existing.flags, incoming);
    if (existing.name.split("\n").includes(name)) {
        return monthHolidayEntry(existing.name, merged);
    }

    return monthHolidayEntry(clampHolidayName(existing.name + "\n" + name),
        merged);
}

function sameHolidayFlags(left, right) {
    return left.length === right.length &&
        left.every((flag, index) => flag === right[index]);
}

function validHolidayFlags(flags) {
    return Array.isArray(flags) &&
        flags.length <= MAX_HOLIDAY_FLAGS &&
        flags.every((flag) => typeof flag === "string" &&
            flag.length <= MAX_HOLIDAY_FLAG_LENGTH);
}

function publicHolidayFlags(flags) {
    return flags.filter((flag) => flag !== RELIGIOUS_HOLIDAY_FLAG);
}

// Every flag the applet mints for itself, and therefore every flag a vendor
// payload may not put into a record. holidayConstants calls PART_DAY_HOLIDAY
// "the only holiday flag this applet does not mint itself" — this is the other
// side of that sentence, and it is not there just for tidiness: the flags
// decide how a day is drawn. calendarAnnotations reads PUBLIC_HOLIDAY_FLAG to
// style a day non-working and RELIGIOUS_HOLIDAY_FLAG (with the religion id) to
// style an observance, so a provider answering `holidayType: "public_holiday"`
// or a `types: ["Religious_Holiday"]` row used to mint the applet's own
// sentinels straight out of the wire.
const APP_MINTED_FLAGS = [PUBLIC_HOLIDAY_FLAG, RELIGIOUS_HOLIDAY_FLAG, CALENDAR_OBSERVANCE_FLAG]
    .concat(ReligiousCatalog.RELIGION_IDS);

// A vendor's flags, with anything the applet mints for itself removed, and the
// public sentinel put back only when the *adapter* — reading the vendor field
// it queried on — says the row is a public holiday. A vendor string never
// reaches the record as an app sentinel.
function normalizeProviderFlags(flags, isPublicHoliday) {
    const vendor = (Array.isArray(flags) ? flags : [])
        .filter((flag) => typeof flag === "string" &&
            APP_MINTED_FLAGS.indexOf(flag) < 0); // NOSONAR [S7765] -- accepted compatible form

    return isPublicHoliday ? [PUBLIC_HOLIDAY_FLAG].concat(vendor) : vendor;
}

function _noonUtc(parts) {
    const date = new Date(0);
    date.setUTCHours(12, 0, 0, 0);
    date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
    return date.getTime();
}

function holidaySpanDays(date, dateTo) {
    return Math.round((_noonUtc(dateTo) - _noonUtc(date)) / MSECS_IN_DAY);
}

function validHolidaySpan(date, dateTo) {
    const days = holidaySpanDays(date, dateTo);
    return days >= 0 && days <= MAX_HOLIDAY_SPAN_DAYS;
}

function validDateParts(parts) {
    if (!parts ||
        !Number.isInteger(parts.year) ||
        parts.year < 1 || parts.year > 9999 ||
        !Number.isInteger(parts.month) ||
        !Number.isInteger(parts.day)) {
        return false;
    }

    const date = new Date(_noonUtc(parts));
    return date.getUTCFullYear() === parts.year &&
        date.getUTCMonth() === parts.month - 1 &&
        date.getUTCDate() === parts.day;
}

function holidayOverlapsYear(holiday, year) {
    const end = holiday.dateTo || holiday.date;
    return holiday.date.year <= year && end.year >= year;
}

function nonBlankText(value) {
    return typeof value === "string" && value.trim().length > 0;
}

var HolidayRecordContract = class HolidayRecordContract { // NOSONAR [S3504] -- GJS importer export
    constructor(lang = "en") {
        this._lang = lang;
    }

    // An injected language may be a live resolver, so consult it at each use.
    // The composition root injects the shipped message-locale resolver; a bare
    // domain record remains deterministic and infrastructure-free in English.
    get language() {
        return typeof this._lang === "function" ? this._lang() : this._lang;
    }

    validHoliday(holiday) {
        return holiday &&
            validDateParts(holiday.date) &&
            (!holiday.dateTo ||
                (validDateParts(holiday.dateTo) && validHolidaySpan(holiday.date, holiday.dateTo))) &&
            Array.isArray(holiday.name) &&
            holiday.name.length > 0 &&
            holiday.name.every((entry) => entry && typeof entry.lang === "string" &&
                typeof entry.text === "string") &&
            holiday.name.some((entry) => nonBlankText(entry.text)) &&
            validHolidayFlags(holiday.flags);
    }

    validResponse(data, requestedYear) {
        return Array.isArray(data) &&
            data.length <= MAX_HOLIDAYS_PER_YEAR &&
            data.every((holiday) => this.validHoliday(holiday)) &&
            (requestedYear === undefined ||
                (Number.isInteger(requestedYear) &&
                    data.every((holiday) => holidayOverlapsYear(holiday, requestedYear))));
    }

    localizeName(holiday) {
        const lang = this.language;
        const usable = holiday.name.filter((entry) => nonBlankText(entry.text));
        const localized = usable
            .filter((entry) => entry.lang === lang || entry.lang === "en")
            .sort((a, b) => Number(a.lang === "en") - Number(b.lang === "en"))[0];

        return (localized || usable[0] || { text: "" }).text.trim();
    }

    expandHoliday(holiday, region) {
        const {year, month, day} = holiday.date;
        const name = this.localizeName(holiday);
        const flags = publicHolidayFlags(holiday.flags);
        const days = [{year, month, day, name, flags, region}];

        if (holiday.dateTo) {
            // Local Dates drift across a clocks-back transition: a raw 24 h
            // step lands at 11:00 local, still under a local-noon limit, and
            // the loop once pushed a phantom row past dateTo. UTC has no
            // transitions — holidaySpanDays above does the same arithmetic.
            let iter = _noonUtc(holiday.date);
            const limit = _noonUtc(holiday.dateTo);
            while (iter < limit && days.length <= MAX_HOLIDAY_SPAN_DAYS) {
                iter += MSECS_IN_DAY;
                const utcDay = new Date(iter);
                days.push({
                    year: utcDay.getUTCFullYear(),
                    month: utcDay.getUTCMonth() + 1,
                    day: utcDay.getUTCDate(),
                    name,
                    flags,
                    region
                });
            }
        }

        return days;
    }
};

if (typeof module !== "undefined") {
    module.exports = { validDateParts, validHolidaySpan, holidaySpanDays, holidayOverlapsYear, nonBlankText,
        publicHolidayFlags, normalizeProviderFlags, APP_MINTED_FLAGS,
        validHolidayFlags, MAX_HOLIDAY_SPAN_DAYS, MAX_HOLIDAYS_PER_YEAR, MAX_EXPANDED_HOLIDAY_ROWS,
        MAX_HOLIDAY_FLAGS, MAX_HOLIDAY_FLAG_LENGTH, MAX_HOLIDAY_NAME_LENGTH,
        clampHolidayName, compareCodeUnits, mergeHolidayFlags, withHolidayFlag,
        joinHolidayEntry, sameHolidayFlags,
        HolidayRecordContract };
}
