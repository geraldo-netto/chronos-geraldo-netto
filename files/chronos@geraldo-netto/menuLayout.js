// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// Which way round the popup puts the month grid and the agenda column.
//
// The popup was built horizontally and only horizontally: a 42-cell grid beside
// an event column whose theme floor is 350 px. That shape is a decision about
// how much horizontal room exists, and the applet was making it once, at build
// time, without looking. On a 1024-wide netbook work area, at 2x UI scale, or
// with accessibility text scaling on, the two columns together ask for more
// width than the desktop has, and a popup menu has no scrollbar of its own to
// absorb the difference — it is simply clipped or pushed off the screen edge.
//
// The choice belongs here, as a function of numbers, rather than in the actor
// tree: it is then the same decision on every monitor and every text size, and
// it can be checked without a display. `appletMenuBuilder` reads the actors and
// the monitor once and hands the numbers over.

var MENU_LAYOUT_HORIZONTAL = "horizontal"; // NOSONAR [S3504] -- GJS importer export
var MENU_LAYOUT_STACKED = "stacked"; // NOSONAR [S3504] -- GJS importer export

// A menu is not a window. It floats over the desktop it belongs to, so it may
// not claim the whole work area even when it would technically fit.
var MENU_WORK_AREA_WIDTH_FRACTION = 0.9; // NOSONAR [S3504] -- GJS importer export
var MENU_WORK_AREA_HEIGHT_FRACTION = 0.9; // NOSONAR [S3504] -- GJS importer export

// Stacking buys width by spending height, and below this the agenda under the
// grid is a title and a scrollbar. Roughly three event rows at the default
// text size; it scales with the text like everything else here.
var MENU_STACKED_AGENDA_MIN_HEIGHT = 120; // NOSONAR [S3504] -- GJS importer export

function positiveNumber(value, fallback) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return fallback;
    }
    return numeric;
}

function measuredSize(value) {
    return positiveNumber(value, 0);
}

// Every field defensively normalized, because three of the four sources are
// outside this applet: the monitor geometry, the theme's scale factor and the
// desktop text-scaling factor all arrive as whatever the desktop last wrote.
//
// Content sizes are the natural sizes **at the default text size**. Keeping the
// text factor out of the measurement and applying it here is what lets a text
// scale change re-decide the layout from numbers already in hand, instead of
// waiting for a relayout of actors that have not been measured again yet — and
// it is what makes the text size a value a test can vary on its own.
function menuLayoutMetrics(input) { // NOSONAR [S3504] -- GJS importer export
    const source = input || {};
    return {
        workAreaWidth: measuredSize(source.workAreaWidth),
        workAreaHeight: measuredSize(source.workAreaHeight),
        uiScale: positiveNumber(source.uiScale, 1),
        textScale: positiveNumber(source.textScale, 1),
        calendarWidth: measuredSize(source.calendarWidth),
        calendarHeight: measuredSize(source.calendarHeight),
        eventsWidth: measuredSize(source.eventsWidth),
        eventsHeight: measuredSize(source.eventsHeight)
    };
}

// St's measured actor sizes and monitor work areas are both device pixels.
// UI scaling is already reflected in the actor measurements. Only CSS length
// assignments need conversion back to logical pixels.
function menuLayoutBudget(metrics) { // NOSONAR [S3504] -- GJS importer export
    return {
        width: metrics.workAreaWidth * MENU_WORK_AREA_WIDTH_FRACTION,
        height: metrics.workAreaHeight * MENU_WORK_AREA_HEIGHT_FRACTION
    };
}

// A work area of zero is a monitor nobody has reported yet — during a hotplug,
// or before the first allocation. Keep the shape the popup already has rather
// than reflowing on a measurement that says the screen has no size.
function menuLayoutMeasured(metrics) { // NOSONAR [S3504] -- GJS importer export
    return metrics.workAreaWidth > 0 && metrics.workAreaHeight > 0 &&
        (metrics.calendarWidth > 0 || metrics.eventsWidth > 0);
}

// Stacking reduces horizontal travel. The body viewport absorbs excess height
// while the agenda keeps its minimum usable size, even on short monitors.
function menuLayoutFor(input) { // NOSONAR [S3504] -- GJS importer export
    const metrics = menuLayoutMetrics(input);
    if (!menuLayoutMeasured(metrics)) {
        return MENU_LAYOUT_HORIZONTAL;
    }

    const budget = menuLayoutBudget(metrics);
    const sideBySide = (metrics.calendarWidth + metrics.eventsWidth) * metrics.textScale;
    if (sideBySide <= budget.width) {
        return MENU_LAYOUT_HORIZONTAL;
    }
    return MENU_LAYOUT_STACKED;
}

function isStackedLayout(layout) { // NOSONAR [S3504] -- GJS importer export
    return layout === MENU_LAYOUT_STACKED;
}

if (typeof module !== "undefined") {
    module.exports = {
        MENU_LAYOUT_HORIZONTAL,
        MENU_LAYOUT_STACKED,
        MENU_STACKED_AGENDA_MIN_HEIGHT,
        MENU_WORK_AREA_HEIGHT_FRACTION,
        MENU_WORK_AREA_WIDTH_FRACTION,
        isStackedLayout,
        menuLayoutBudget,
        menuLayoutFor,
        menuLayoutMeasured,
        menuLayoutMetrics
    };
}
