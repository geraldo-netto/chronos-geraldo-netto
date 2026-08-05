// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports */

// Session lifetimes must not follow the user-adjustable civil clock. GLib's
// monotonic clock is the one elapsed-time port shared by weather freshness,
// request pacing, in-memory TTLs and runtime timezone rechecks.
const GLib = imports.gi.GLib;

var monotonicMilliseconds = function() { // NOSONAR [S3504] -- GJS importer export
    return GLib.get_monotonic_time() / 1000;
};

var monotonicSeconds = function() { // NOSONAR [S3504] -- GJS importer export
    return GLib.get_monotonic_time() / 1000000;
};

if (typeof module !== "undefined") {
    module.exports = { monotonicMilliseconds, monotonicSeconds };
}
