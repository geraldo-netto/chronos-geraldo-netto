// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
//
// SPDX-License-Identifier: GPL-2.0-or-later

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const MenuLayout = require(
    path.join(__dirname, "..", "files", "chronos@geraldo-netto", "menuLayout.js"));

const HORIZONTAL = MenuLayout.MENU_LAYOUT_HORIZONTAL;
const STACKED = MenuLayout.MENU_LAYOUT_STACKED;

// A roomy desktop and the popup as it actually measures: Cinnamon's theme puts
// a 350 px floor under the event column and the month grid asks for about 300.
function metrics(overrides) {
    return Object.assign({ // NOSONAR [S6661] -- deliberate test seam
        workAreaWidth: 1920,
        workAreaHeight: 1080,
        uiScale: 1,
        textScale: 1,
        calendarWidth: 300,
        calendarHeight: 420,
        eventsWidth: 350,
        eventsHeight: 400
    }, overrides);
}

test("a desktop with room for both columns keeps them side by side", () => {
    assert.equal(MenuLayout.menuLayoutFor(metrics()), HORIZONTAL);
    // and a laptop is still roomy: 650 of a 1366-wide work area
    assert.equal(MenuLayout.menuLayoutFor(metrics({ workAreaWidth: 1366 })), HORIZONTAL);
});

test("a work area too narrow for both columns stacks them", () => {
    // 650 logical pixels of content against 0.9 x 700
    assert.equal(MenuLayout.menuLayoutFor(metrics({ workAreaWidth: 700 })), STACKED);
    // the boundary itself is a fit, not an overflow
    const exact = 650 / MenuLayout.MENU_WORK_AREA_WIDTH_FRACTION;
    assert.equal(MenuLayout.menuLayoutFor(metrics({ workAreaWidth: exact })), HORIZONTAL);
    assert.equal(MenuLayout.menuLayoutFor(
        metrics({ workAreaWidth: exact - 1 })), STACKED);
});

test("UI scaling is already included in native actor sizes", () => {
    // the same monitor, portrait: room for both columns at 1x, and at 2x the
    // popup is drawn twice as large into the same glass
    const portrait = { workAreaWidth: 1400, workAreaHeight: 2000 };
    assert.equal(MenuLayout.menuLayoutFor(metrics(portrait)), HORIZONTAL);
    assert.equal(MenuLayout.menuLayoutFor(
        metrics({ ...portrait, uiScale: 2, calendarWidth: 600, eventsWidth: 700 })), STACKED);

    const scaled = MenuLayout.menuLayoutBudget(
        MenuLayout.menuLayoutMetrics(metrics({ uiScale: 2 })));
    assert.equal(scaled.width, 1920 * MenuLayout.MENU_WORK_AREA_WIDTH_FRACTION);
    assert.equal(scaled.height, 1080 * MenuLayout.MENU_WORK_AREA_HEIGHT_FRACTION);
});

test("large text and long translations reach the same decision", () => {
    // accessibility text scaling, with the content measured at the default size
    assert.equal(MenuLayout.menuLayoutFor(
        metrics({ workAreaWidth: 1024, textScale: 1 })), HORIZONTAL);
    assert.equal(MenuLayout.menuLayoutFor(
        metrics({ workAreaWidth: 1024, textScale: 1.5 })), STACKED);

    // a translation that widens the agenda's headings is the same overflow
    // arriving through the measurement instead of through the factor
    assert.equal(MenuLayout.menuLayoutFor(
        metrics({ workAreaWidth: 1024, eventsWidth: 700 })), STACKED);
});

test("short monitors stack within a scrolling viewport instead of clipping both axes", () => {
    const short = metrics({ workAreaWidth: 700, workAreaHeight: 560 });
    assert.equal(MenuLayout.menuLayoutFor(short), STACKED);
    // the same monitor with a shorter grid has room for both, one over the other
    assert.equal(MenuLayout.menuLayoutFor(
        Object.assign({}, short, { calendarHeight: 300 })), STACKED); // NOSONAR [S6661] -- deliberate test seam

    // and the height floor scales with the text like everything else here
    const tall = metrics({ workAreaWidth: 700, workAreaHeight: 800, calendarHeight: 420 });
    assert.equal(MenuLayout.menuLayoutFor(tall), STACKED);
    assert.equal(MenuLayout.menuLayoutFor(
        Object.assign({}, tall, { textScale: 1.5 })), STACKED); // NOSONAR [S6661] -- deliberate test seam
});

test("a monitor nobody has measured yet does not reflow the popup", () => {
    // mid-hotplug, or before the first allocation: a work area of zero would
    // otherwise read as a screen too narrow for anything
    assert.equal(MenuLayout.menuLayoutFor(metrics({ workAreaWidth: 0 })), HORIZONTAL);
    assert.equal(MenuLayout.menuLayoutFor(metrics({ workAreaHeight: 0 })), HORIZONTAL);
    assert.equal(MenuLayout.menuLayoutFor(
        metrics({ workAreaWidth: 320, calendarWidth: 0, eventsWidth: 0 })), HORIZONTAL);
    assert.equal(MenuLayout.menuLayoutFor(undefined), HORIZONTAL);
});

test("every number the desktop hands over is normalized before it is used", () => {
    for (const hostile of [null, undefined, "", NaN, Infinity, -1, "nonsense", {}]) {
        const normalized = MenuLayout.menuLayoutMetrics({
            workAreaWidth: hostile,
            workAreaHeight: hostile,
            uiScale: hostile,
            textScale: hostile,
            calendarWidth: hostile,
            calendarHeight: hostile,
            eventsWidth: hostile,
            eventsHeight: hostile
        });
        // a scale of zero would divide the work area away; a size of zero is
        // simply an unmeasured actor
        assert.equal(normalized.uiScale, 1);
        assert.equal(normalized.textScale, 1);
        assert.equal(normalized.workAreaWidth, 0);
        assert.equal(normalized.eventsHeight, 0);
    }

    // numeric strings are what a settings read hands back, and they are numbers
    const fromStrings = MenuLayout.menuLayoutMetrics(
        { workAreaWidth: "1920", uiScale: "2", textScale: "1.25" });
    assert.equal(fromStrings.workAreaWidth, 1920);
    assert.equal(fromStrings.uiScale, 2);
    assert.equal(fromStrings.textScale, 1.25);
});

test("the budget is the work area less the room a menu must leave around it", () => {
    const budget = MenuLayout.menuLayoutBudget(MenuLayout.menuLayoutMetrics(metrics()));
    assert.equal(budget.width, 1920 * MenuLayout.MENU_WORK_AREA_WIDTH_FRACTION);
    assert.equal(budget.height, 1080 * MenuLayout.MENU_WORK_AREA_HEIGHT_FRACTION);
    assert.ok(MenuLayout.MENU_WORK_AREA_WIDTH_FRACTION < 1,
        "a popup that claims the whole work area is a window");

    assert.ok(MenuLayout.menuLayoutMeasured(MenuLayout.menuLayoutMetrics(metrics())));
    assert.ok(!MenuLayout.menuLayoutMeasured(
        MenuLayout.menuLayoutMetrics(metrics({ workAreaHeight: 0 }))));
});

test("only the stacked layout is stacked", () => {
    assert.ok(MenuLayout.isStackedLayout(STACKED));
    assert.ok(!MenuLayout.isStackedLayout(HORIZONTAL));
    assert.ok(!MenuLayout.isStackedLayout(undefined));
    assert.notEqual(HORIZONTAL, STACKED);
});
