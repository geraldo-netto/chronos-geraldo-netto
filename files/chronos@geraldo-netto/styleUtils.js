// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* eslint camelcase: "off" */

// Event/holiday colors come from external calendar data; only let plain
// color syntax through to inline St styles (blocks `;`-injection of extra
// declarations such as background-image).
var CSS_COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9,.\s%]+\)|[a-zA-Z]+)$/; // NOSONAR [S3504] -- GJS importer export
var MAX_CSS_COLOR_LENGTH = 64; // NOSONAR [S3504] -- GJS importer export

function safeCssColor(color, fallback = "transparent") {
    // Check the cheap, allocation-free bound before trim() and the regex.
    // Valid CSS color tokens are ASCII, so UTF-16 length is deliberately the
    // strictest useful measure here.
    if (typeof color !== "string" || color.length > MAX_CSS_COLOR_LENGTH) {
        return fallback;
    }

    const normalized = color.trim();
    if (CSS_COLOR_PATTERN.test(normalized)) {
        return normalized;
    }
    return fallback;
}

if (typeof module !== "undefined") {
    module.exports = {
        MAX_CSS_COLOR_LENGTH,
        safeCssColor
    };
}
