// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports */

// Request pacing and session lifetimes must not follow the user-adjustable
// civil clock. Reading freshness is different: it must count time spent asleep,
// which CLOCK_MONOTONIC deliberately excludes. Keep the two clocks explicit so
// callers cannot accidentally use a suspend-blind age for observed data.
const GLib = imports.gi.GLib;

var civilMilliseconds = function() { // NOSONAR [S3504] -- GJS importer export
    return Date.now();
};

var monotonicMilliseconds = function() { // NOSONAR [S3504] -- GJS importer export
    return GLib.get_monotonic_time() / 1000;
};

var monotonicSeconds = function() { // NOSONAR [S3504] -- GJS importer export
    return GLib.get_monotonic_time() / 1000000;
};

if (typeof module !== "undefined") {
    module.exports = { civilMilliseconds, monotonicMilliseconds, monotonicSeconds };
}
