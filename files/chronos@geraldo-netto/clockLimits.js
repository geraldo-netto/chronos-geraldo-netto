// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// User-configurable clocks; built-in UTC and local rows come on top. City
// weather uses the same cap because there can be one weather lookup per clock.
var MAX_CLOCKS = 8; // NOSONAR [S3504] -- GJS importer export

if (typeof module !== "undefined") {
    module.exports = { MAX_CLOCKS };
}
