// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports */

const ReligiousHolidaysModule = imports.ui.appletManager.applets["chronos@geraldo-netto"].religiousHolidays;

if (typeof module !== "undefined") {
    module.exports = ReligiousHolidaysModule;
}
