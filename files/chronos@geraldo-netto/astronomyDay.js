// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* global imports */

// One civil day at a place, and how its rise and set read.
//
// astronomy.js is the arithmetic and takes UTC bounds; this is what turns "now,
// over there" into those bounds and the answers back into rows. It touches no
// St and no Clutter, and it holds no instance state — the actor tree that shows
// these rows is 6.0/astronomyView.js.
//
// It lived in that view module, so the rise/set and always-up/always-down copy
// rule was reachable only through a file that requires imports.gi.St and
// imports.gi.Clutter, and a future 6.x/ tree would have had to fork it with the
// actor code. GLib is the one platform dependency, and it is here because a
// civil day is a timezone question.

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const GLib = GjsImports.gi.GLib;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const Astronomy = IS_NODE ?
    require("./astronomy") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].astronomy;

// An event the calculation could not place: the sky is normal, but this
// particular rise or set is not in this civil day.
var MISSING_EVENT_TIME = "—"; // NOSONAR [S3504] -- GJS importer export

function zonedDateTime(timestamp, timezone) {
    if (!Number.isFinite(timestamp) || !timezone) {
        return null;
    }
    const utc = GLib.DateTime.new_from_unix_utc(Math.floor(timestamp / 1000));
    return utc ? utc.to_timezone(timezone) : null;
}

function _civilMidnight(date, timezone) {
    const midnight = GLib.DateTime.new(timezone,
        date.get_year(), date.get_month(), date.get_day_of_month(), 0, 0, 0);
    if (!midnight) {
        return null;
    }
    let earliest = midnight.to_unix();
    const localTime = earliest + midnight.get_utc_offset() / 1000000;
    // GLib can choose the second copy of an ambiguous midnight. Compare both
    // local intervals so the day includes its first hour after a backward jump.
    for (const type of [GLib.TimeType.STANDARD, GLib.TimeType.DAYLIGHT]) {
        const interval = timezone.find_interval(type, localTime);
        if (interval >= 0) {
            earliest = Math.min(earliest, localTime - timezone.get_offset(interval));
        }
    }
    return earliest;
}

function civilDayBounds(now, timezone) {
    if (!now || typeof now.getTime !== "function" || !Number.isFinite(now.getTime())) {
        return null;
    }
    const placeNow = zonedDateTime(now.getTime(), timezone);
    if (!placeNow) {
        return null;
    }
    const start = _civilMidnight(placeNow, timezone);
    const tomorrow = placeNow.add_days(1);
    // A midnight DST jump may normalize start to 01:00. Tomorrow's boundary
    // must be constructed independently rather than carrying that hour forward.
    const end = tomorrow ? _civilMidnight(tomorrow, timezone) : null;
    if (start === null || end === null) {
        return null;
    }
    const bounds = { startMs: start * 1000, endMs: end * 1000 };
    return Astronomy.validDayBounds(bounds.startMs, bounds.endMs) ? bounds : null;
}

function bodyRows(body, riseLabel, setLabel, alwaysUpText, alwaysDownText, formatTime) {
    if (body.state === "alwaysUp") {
        return [{ status: alwaysUpText }];
    }
    if (body.state === "alwaysDown") {
        return [{ status: alwaysDownText }];
    }
    const rise = body.rise === null ? MISSING_EVENT_TIME : formatTime(body.rise);
    const set = body.set === null ? MISSING_EVENT_TIME : formatTime(body.set);
    return [
        { label: riseLabel, value: rise || MISSING_EVENT_TIME },
        { label: setLabel, value: set || MISSING_EVENT_TIME }
    ];
}

function defaultFormatTime(timestamp, use24h, timezone) {
    const placeTime = zonedDateTime(timestamp, timezone);
    if (!placeTime) {
        return "";
    }
    return placeTime.format(use24h ? "%H:%M" : "%-l:%M %p") || "";
}

if (typeof module !== "undefined") {
    module.exports = {
        MISSING_EVENT_TIME, zonedDateTime, civilDayBounds, bodyRows, defaultFormatTime
    };
}
