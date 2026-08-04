// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

const Astronomy = imports.ui.appletManager.applets["chronos@geraldo-netto"].astronomy;

if (typeof module !== "undefined") {
    module.exports = Astronomy;
}
