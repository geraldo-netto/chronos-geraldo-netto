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
const GLib = GjsImports.gi.GLib;

// A civil boundary may fall in a gap or occur twice after an offset change.
// Keep GLib's first usable time for gaps, but include both copies of a fold by
// choosing its earliest instant. STANDARD and DAYLIGHT also distinguish the
// two intervals of political offset changes which are not seasonal DST.
function civilDayStart(year, month, day, timezone) {
    const midnight = GLib.DateTime.new(timezone, year, month, day, 0, 0, 0);
    if (!midnight) {
        return null;
    }
    const timestamp = midnight.to_unix();
    let earliest = timestamp;
    const localTime = timestamp + midnight.get_utc_offset() / 1000000;
    for (const type of [GLib.TimeType.STANDARD, GLib.TimeType.DAYLIGHT]) {
        const interval = timezone.find_interval(type, localTime);
        if (interval >= 0) {
            earliest = Math.min(earliest, localTime - timezone.get_offset(interval));
        }
    }
    return earliest === timestamp ? midnight : midnight.add_seconds(earliest - timestamp);
}

if (typeof module !== "undefined") {
    module.exports = { civilDayStart };
}
