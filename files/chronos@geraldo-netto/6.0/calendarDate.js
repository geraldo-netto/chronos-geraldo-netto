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

const sameDay = DateMath.sameCivilDate;

function isToday(date, today = DateMath.localDateParts(new Date())) {
    return sameDay(date, today);
}

// Formatting a Gregorian label must not normalize a locally skipped date.
function formatCivilDate(date, format, fallback = format) {
    const dt = GLib.DateTime.new_utc(date.year, date.month, date.day, 12, 0, 0);
    return dt ? DateFormats.formatDateWithFallback(
        (candidate) => dt.format(candidate), format, fallback) : "";
}

// A whole skipped date has no local event bucket or selectable instant. GLib
// normalizes it into the following date; reject that projection explicitly.
function localUnixForCivilDate(date) {
    const dt = CivilTime.projectCivilDate(date, GLib.TimeZone.new_local());
    return dt ? dt.to_unix() : null;
}

if (typeof module !== "undefined") {
    module.exports = { sameDay, isToday, formatCivilDate, localUnixForCivilDate };
}
