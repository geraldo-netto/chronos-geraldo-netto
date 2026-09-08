// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// The panel label's size, as a multiple of whatever the theme already chose.
//
// Panel text size is a desktop-wide typographic decision: the theme sets it,
// the user scales it, and every text applet in the panel agrees on it. This
// applet sits beside 32-pixel icons, which makes its text look small, but
// hard-coding a larger size would ignore the user's own font scaling and make
// this one applet taller than the panel text next to it.
//
// So the scale is opt-in and defaults to no opinion at all: at 1.0 the applet
// sets no style and the theme decides, exactly as before the setting existed.

// Below this the clock is unreadable; above it, a 40-pixel panel clips.
var MIN_PANEL_FONT_SCALE = 0.8; // NOSONAR [S3504] -- GJS importer export
var MAX_PANEL_FONT_SCALE = 1.6; // NOSONAR [S3504] -- GJS importer export
var DEFAULT_PANEL_FONT_SCALE = 1; // NOSONAR [S3504] -- GJS importer export

// An unreadable value is the default rather than a refusal: a corrupt setting
// must not leave the panel without a clock.
function panelFontScale(value) { // NOSONAR [S3504] -- GJS importer export
    // Only a number, or a string that is one: Number(null) is 0, which would
    // clamp a missing setting to the smallest readable text rather than
    // leaving the theme in charge of it.
    let numeric = NaN;
    if (typeof value === "number") {
        numeric = value;
    } else if (typeof value === "string" && value.trim() !== "") {
        numeric = Number(value);
    }
    if (!Number.isFinite(numeric)) {
        return DEFAULT_PANEL_FONT_SCALE;
    }
    return Math.min(MAX_PANEL_FONT_SCALE, Math.max(MIN_PANEL_FONT_SCALE, numeric));
}

// Null clears St's inline style without asking its CSS parser to parse an
// empty declaration. Leaving the property unset lets later theme changes apply.
function panelFontStyle(value) { // NOSONAR [S3504] -- GJS importer export
    let scale = panelFontScale(value);
    if (scale === DEFAULT_PANEL_FONT_SCALE) {
        return null;
    }
    return "font-size: " + Math.round(scale * 100) / 100 + "em;";
}

if (typeof module !== "undefined") {
    module.exports = {
        DEFAULT_PANEL_FONT_SCALE,
        MAX_PANEL_FONT_SCALE,
        MIN_PANEL_FONT_SCALE,
        panelFontScale,
        panelFontStyle
    };
}
