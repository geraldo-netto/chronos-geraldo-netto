// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* global imports */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const HolidayRecord = IS_NODE ?
    require("./holidayRecord") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayRecord;
const HolidayConstants = IS_NODE ?
    require("./holidayConstants") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayConstants;
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;

const MANIFEST_FIELDS = ["apiVersion", "id", "name", "category", "coverage", "source", "events"];
const SOURCE_FIELDS = ["name", "url", "tradition", "location"];
const EVENT_FIELDS = ["name", "month", "day", "year", "nonWorking"];
const BAD_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;
const CALENDAR_ID = /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+(?:-[a-z0-9]+)*)+$/;

function assertValue(condition, field, expectation) {
    if (!condition) {
        throw new Error(`Calendar plugin ${field}: ${expectation}`);
    }
}

function ownsProperty(object, key) {
    return Object.getOwnPropertyDescriptor(object, key) !== undefined;
}

function plainFields(value, allowed, field) {
    assertValue(value !== null && typeof value === "object", field, "expected a plain object");
    const prototype = Object.getPrototypeOf(value);
    assertValue(prototype === Object.prototype || prototype === null, field,
        "expected a plain object");
    assertValue(Object.getOwnPropertySymbols(value).length === 0, field, "unexpected symbol field");
    for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        assertValue(allowed.includes(key) && ownsProperty(descriptor, "value"), field,
            "unexpected field or accessor");
    }
    return value;
}

function boundedText(value, field, maximum) {
    assertValue(typeof value === "string", field, "expected text");
    assertValue(value.length <= maximum && value.trim().length > 0, field,
        `expected nonblank text of at most ${maximum} characters`);
    assertValue(TextUtils.sanitizeControlCharacters(value) === value && !BAD_SURROGATES.test(value), field,
        "control characters or invalid Unicode are not allowed");
    return value.trim();
}

function calendarId(value) {
    const id = boundedText(value, "id", 96);
    assertValue(CALENDAR_ID.test(id), "id", "expected a lowercase namespaced identifier");
    assertValue(!id.split(/[.:-]/).some((part) =>
        ["constructor", "prototype"].includes(part)), "id", "reserved identifier");
    return id;
}

function yearValue(value, field) {
    assertValue(Number.isInteger(value) && value >= 1 && value <= 9999, field,
        "expected an integer year from 1 through 9999");
    return value;
}

function validDay(year, month, day) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return Number.isInteger(month) && month >= 1 && month <= 12 &&
        Number.isInteger(day) && day >= 1 && day <= monthDays[month - 1];
}

function normalizeCoverage(raw) {
    plainFields(raw, ["from", "through"], "coverage");
    const from = yearValue(raw.from, "coverage.from");
    const through = yearValue(raw.through, "coverage.through");
    assertValue(from <= through, "coverage", "from must not be later than through");
    return Object.freeze({ from, through });
}

function normalizeSource(raw) {
    plainFields(raw, SOURCE_FIELDS, "source");
    const source = { name: boundedText(raw.name, "source.name", 160) };
    for (const key of ["tradition", "location"]) {
        if (ownsProperty(raw, key)) {
            source[key] = boundedText(raw[key], `source.${key}`, 160);
        }
    }
    if (ownsProperty(raw, "url")) {
        source.url = boundedText(raw.url, "source.url", 2048);
        const match = /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::([0-9]{1,5}))?(?:[/?#][^\s\\]*)?$/i.exec(source.url);
        assertValue(match !== null, "source.url", "expected an HTTPS source URL without credentials");
        assertValue(!match[1] || Number(match[1]) <= 65535, "source.url", "expected a port from 0 through 65535");
    }
    return Object.freeze(source);
}

function normalizeEvent(raw, coverage) {
    plainFields(raw, EVENT_FIELDS, "event");
    const event = { name: boundedText(raw.name, "event.name", 160), month: raw.month, day: raw.day };
    if (ownsProperty(raw, "year")) {
        event.year = yearValue(raw.year, "event.year");
        assertValue(event.year >= coverage.from && event.year <= coverage.through,
            "event.year", "outside declared coverage");
    }
    assertValue(validDay(event.year || 2000, event.month, event.day), "event date",
        "expected a real Gregorian date");
    if (ownsProperty(raw, "nonWorking")) {
        assertValue(typeof raw.nonWorking === "boolean", "event.nonWorking", "expected a boolean");
        event.nonWorking = raw.nonWorking;
    }
    return Object.freeze(event);
}

function normalizeEvents(raw, coverage) {
    assertValue(Array.isArray(raw) && raw.length <= 4096, "events",
        "expected an array with at most 4096 events");
    assertValue(Object.getPrototypeOf(raw) === Array.prototype &&
        Object.getOwnPropertySymbols(raw).length === 0 &&
        Object.getOwnPropertyNames(raw).length === raw.length + 1, "events",
        "expected a dense JSON array without extra fields");
    const events = [];
    for (let index = 0; index < raw.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
        assertValue(descriptor && ownsProperty(descriptor, "value"), "events",
            "expected a dense JSON array");
        events.push(normalizeEvent(descriptor.value, coverage));
    }
    return Object.freeze(events);
}

function validateCalendarManifest(raw) {
    plainFields(raw, MANIFEST_FIELDS, "manifest");
    assertValue(raw.apiVersion === 1, "apiVersion", "unsupported version; expected 1");
    const coverage = normalizeCoverage(raw.coverage);
    return Object.freeze({
        apiVersion: 1,
        id: calendarId(raw.id),
        name: boundedText(raw.name, "name", 100),
        category: boundedText(raw.category, "category", 64),
        coverage,
        source: normalizeSource(raw.source),
        events: normalizeEvents(raw.events, coverage)
    });
}

// Coverage declares completeness, including a covered year with no events.
function manifestAvailable(manifest, year) {
    return Number.isInteger(year) && year >= manifest.coverage.from &&
        year <= manifest.coverage.through;
}

function eventMatches(event, year, month) {
    return event.month === month && (event.year === undefined || event.year === year) &&
        validDay(year, event.month, event.day);
}

function manifestMonthMap(manifest, year, month) {
    const holidays = new Map();
    if (!manifestAvailable(manifest, year) || !Number.isInteger(month) || month < 1 || month > 12) {
        return holidays;
    }
    for (const event of manifest.events.filter((row) => eventMatches(row, year, month))) {
        const key = `${month}/${event.day}`;
        const flag = event.nonWorking ? HolidayConstants.PUBLIC_HOLIDAY_FLAG : "calendar_observance";
        holidays.set(key, HolidayRecord.joinHolidayEntry(holidays.get(key),
            `${event.name} (${manifest.name})`, [flag]));
    }
    return holidays;
}

if (typeof module !== "undefined") {
    module.exports = { validateCalendarManifest, manifestAvailable, manifestMonthMap };
}
