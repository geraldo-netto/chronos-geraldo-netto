// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// Dependency-free calendar arithmetic shared by domain and presentation code.
var MSECS_IN_DAY = 24 * 60 * 60 * 1000; // NOSONAR [S3504] -- GJS importer export

// Days to step back from a month's first day to reach the start of the
// calendar grid. isoWeekDay is GLib's 1=Mon..7=Sun; weekStart is
// Cinnamon.util_get_week_start()'s 0=Sun..6=Sat.
function monthWindowStartOffset(isoWeekDay, weekStart) {
    return ((isoWeekDay % 7) - weekStart + 7) % 7;
}

if (typeof module !== "undefined") {
    module.exports = { MSECS_IN_DAY, monthWindowStartOffset };
}
