// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// The applet's teardown primitive, in one place. Every step runs even if an
// earlier one throws: a teardown that stops at the first failure leaves the
// rest of the applet's signals, timers and actors connected to a destroyed
// object for the life of the session.
//
// It was written out three times — applet.js, appletLifecycle.js and
// appletMenuBuilder.js — so a change to it (a source tag on the log line,
// routing through the issue reporter) either had to be made three times or
// silently covered one third of teardown.

/* global global */

var runTeardownSteps = function (steps) { // NOSONAR [S3504] -- GJS importer export
    for (const step of steps) {
        try {
            step();
        } catch (e) {
            global.logError(e);
        }
    }
};

if (typeof module !== "undefined") {
    module.exports = { runTeardownSteps };
}
