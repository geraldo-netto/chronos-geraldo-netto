// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
//
// SPDX-License-Identifier: GPL-2.0-or-later

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "panelFont.js");
const PanelFont = require(modulePath);
const schema = require(path.join(__dirname, "..", "files", "chronos@geraldo-netto",
    "6.0", "settings-schema.json"));

test("the default is no opinion at all, so the theme keeps deciding", () => {
    // Not "font-size: 1em": an inline declaration outranks the theme even when
    // it restates the theme's own value, which would freeze this applet's text
    // against a later theme or font-scaling change.
    assert.equal(PanelFont.panelFontStyle(PanelFont.DEFAULT_PANEL_FONT_SCALE), "");
    assert.equal(PanelFont.panelFontStyle(1), "");
});

test("a chosen scale becomes a style relative to the theme's own size", () => {
    assert.equal(PanelFont.panelFontStyle(1.2), "font-size: 1.2em;");
    assert.equal(PanelFont.panelFontStyle(0.85), "font-size: 0.85em;");
});

test("a scale outside the readable range is clamped, not obeyed", () => {
    // Below the floor the clock is unreadable; above the ceiling a 40-pixel
    // panel clips it, and panel height is the user's setting, not ours.
    assert.equal(PanelFont.panelFontScale(0.1), PanelFont.MIN_PANEL_FONT_SCALE);
    assert.equal(PanelFont.panelFontScale(9), PanelFont.MAX_PANEL_FONT_SCALE);
});

test("an unreadable setting is the default rather than a refusal", () => {
    // A corrupt value must not leave the panel without a clock.
    for (const value of [undefined, null, "large", NaN, {}]) {
        assert.equal(PanelFont.panelFontScale(value), PanelFont.DEFAULT_PANEL_FONT_SCALE);
        assert.equal(PanelFont.panelFontStyle(value), "");
    }
});

test("a numeric string from the settings file is read as a number", () => {
    assert.equal(PanelFont.panelFontScale("1.25"), 1.25);
});

test("the shipped schema agrees with the module about its bounds", () => {
    const entry = schema["panel-font-scale"];

    assert.equal(entry.default, PanelFont.DEFAULT_PANEL_FONT_SCALE);
    assert.equal(entry.min, PanelFont.MIN_PANEL_FONT_SCALE);
    assert.equal(entry.max, PanelFont.MAX_PANEL_FONT_SCALE);
    assert.ok(entry.tooltip.includes("theme"), "the setting says whose decision it overrides");
});
