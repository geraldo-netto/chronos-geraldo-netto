// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

const GLib = imports.gi.GLib;

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

// Date.prototype.toLocaleFormat is a removed SpiderMonkey extension. Noon
// avoids local DST transitions while GLib performs the locale-aware format.
function formatJsDate(jsDate, format) {
    const dt = GLib.DateTime.new_local(
        jsDate.getFullYear(), jsDate.getMonth() + 1, jsDate.getDate(), 12, 0, 0);
    return dt ? dt.format(format) : "";
}

if (typeof module !== "undefined") {
    module.exports = { sameDay, isToday, formatJsDate };
}
