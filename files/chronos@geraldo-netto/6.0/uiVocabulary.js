// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// What more than one 6.0 view says, and what more than one of them listens for.
// Neither belongs to a single view, and both were written out in each of them.

/* global imports */

const Clutter = imports.gi.Clutter;
const AppletModules = imports.ui.appletManager.applets["chronos@geraldo-netto"];
const _ = AppletModules.localeText.translate;

// What activates a focused thing from the keyboard. This set existed three
// times — once in appletMenuBuilder and twice in eventView, the second pair
// spelled out as a chain of !== — so nothing stopped one focusable row
// answering Space and its neighbour not.
var ACTIVATION_KEY_SYMBOLS = new Set([ // NOSONAR [S3504] -- GJS importer export
    Clutter.KEY_Return,
    Clutter.KEY_KP_Enter,
    Clutter.KEY_space
]);

// One condition, one sentence. It was declared byte-identically in calendar.js,
// as a day cell's accessible name, and in eventView.js, as the overflow label
// and the footer issue. Editing the wording in one left the applet saying two
// different things about one condition, and the .pot collapses identical msgids
// so msgfmt could not flag the drift.
var EVENTS_HIDDEN_TEXT = // NOSONAR [S3504] -- GJS importer export
    _("Some calendar events were hidden to keep the desktop responsive.");

if (typeof module !== "undefined") {
    module.exports = { ACTIVATION_KEY_SYMBOLS, EVENTS_HIDDEN_TEXT };
}
