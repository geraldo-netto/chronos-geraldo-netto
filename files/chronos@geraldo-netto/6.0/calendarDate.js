// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

const GLib = imports.gi.GLib;
const DateFormats = require("./dateFormats");
const DateMath = require("./dateMath");
const CivilTime = require("./civilTime");

function sameDay(dateA, dateB) {
    if (!dateA || !dateB) {
        return false;
    }
    return dateA.getDate() === dateB.getDate() &&
        dateA.getMonth() === dateB.getMonth() &&
        dateA.getFullYear() === dateB.getFullYear();
}

function isToday(date, today = new Date()) {
    return sameDay(date, today);
}

// Formatting a Gregorian label must not normalize a locally skipped date.
function formatCivilDate(date, format, fallback = format) {
    const dt = GLib.DateTime.new_utc(date.year, date.month, date.day, 12, 0, 0);
    return dt ? DateFormats.formatDateWithFallback(
        (candidate) => dt.format(candidate), format, fallback) : "";
}

function formatJsDate(jsDate, format, fallback = format) {
    return formatCivilDate(DateMath.localDateParts(jsDate), format, fallback);
}

// A whole skipped date has no local event bucket or selectable instant. GLib
// normalizes it into the following date; reject that projection explicitly.
function localUnixForCivilDate(date) {
    const dt = CivilTime.civilDayStart(date.year, date.month, date.day, GLib.TimeZone.new_local());
    if (!dt || dt.get_year() !== date.year || dt.get_month() !== date.month ||
            dt.get_day_of_month() !== date.day) {
        return null;
    }
    return dt.to_unix();
}

if (typeof module !== "undefined") {
    module.exports = { sameDay, isToday, formatJsDate, formatCivilDate, localUnixForCivilDate };
}
