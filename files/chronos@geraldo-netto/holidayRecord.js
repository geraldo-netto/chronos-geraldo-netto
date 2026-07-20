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
const DateFormats = IS_NODE ?
    require("./dateFormats") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].dateFormats;
const LocaleQuery = IS_NODE ?
    require("./localeQuery") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].localeQuery;

const MSECS_IN_DAY = DateFormats.MSECS_IN_DAY;
const _lcLang = LocaleQuery.lazyLocaleValue("LC_ADDRESS", (info) => info.lang_ab);

var MAX_HOLIDAY_SPAN_DAYS = 366; // NOSONAR [S3504] -- GJS importer export
var MAX_HOLIDAYS_PER_YEAR = 1000; // NOSONAR [S3504] -- GJS importer export
var MAX_EXPANDED_HOLIDAY_ROWS = 4000; // NOSONAR [S3504] -- GJS importer export

function _noonUtc(parts) {
    return Date.UTC(parts.year, parts.month - 1, parts.day, 12);
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
        !Number.isInteger(parts.month) ||
        !Number.isInteger(parts.day)) {
        return false;
    }

    const date = new Date(parts.year, parts.month - 1, parts.day, 12);
    return date.getFullYear() === parts.year &&
        date.getMonth() === parts.month - 1 &&
        date.getDate() === parts.day;
}

function holidayOverlapsYear(holiday, year) {
    const end = holiday.dateTo || holiday.date;
    return holiday.date.year <= year && end.year >= year;
}

function nonBlankText(value) {
    return typeof value === "string" && value.trim().length > 0;
}

var HolidayRecordContract = class HolidayRecordContract { // NOSONAR [S3504] -- GJS importer export
    constructor(lang = _lcLang()) {
        this._lang = lang;
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
            Array.isArray(holiday.flags);
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
        const usable = holiday.name.filter((entry) => nonBlankText(entry.text));
        const localized = usable
            .filter((entry) => entry.lang === this._lang || entry.lang === "en")
            .sort((a, b) => a.lang === "en" ? 1 : b.lang === "en" ? -1 : 0)[0]; // NOSONAR [S3358] -- accepted compatible form

        return (localized || usable[0] || { text: "" }).text.trim();
    }

    expandHoliday(holiday, region) {
        const {year, month, day} = holiday.date;
        const name = this.localizeName(holiday);
        const flags = holiday.flags;
        const days = [{year, month, day, name, flags, region}];

        if (holiday.dateTo) {
            const {year: yearTo, month: monthTo, day: dayTo} = holiday.dateTo;
            let iter = new Date(year, month - 1, day, 12);
            const limit = new Date(yearTo, monthTo - 1, dayTo, 12);
            while (iter < limit && days.length <= MAX_HOLIDAY_SPAN_DAYS) { // NOSONAR [S2189] -- setTime mutates the iterator
                iter.setTime(iter.getTime() + MSECS_IN_DAY);
                days.push({
                    year: iter.getFullYear(),
                    month: iter.getMonth() + 1,
                    day: iter.getDate(),
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
        MAX_HOLIDAY_SPAN_DAYS, MAX_HOLIDAYS_PER_YEAR, MAX_EXPANDED_HOLIDAY_ROWS,
        HolidayRecordContract };
}
