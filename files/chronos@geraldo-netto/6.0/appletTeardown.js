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

// The reporter is a step like any other, so it may not end the loop either. It
// used to dereference `global.logError` straight out of the catch: a host that
// does not carry it, or one whose logger raises, turned "report this failure"
// into the failure that stranded every teardown behind it — the exact outcome
// the paragraph above says this module exists to prevent. appletLifecycle's
// _finalizeQuietly guards the identical call; so does every global.log in the
// root modules.
function reportTeardownFailure(error) {
    try {
        if (typeof global !== "undefined" && global.logError) {
            global.logError(error);
        }
    } catch { // NOSONAR [S2486] -- there is no second logger to tell
        // nothing left to report a failing reporter to
    }
}

var runTeardownSteps = function (steps) { // NOSONAR [S3504] -- GJS importer export
    for (const step of steps) {
        try {
            step();
        } catch (e) {
            reportTeardownFailure(e);
        }
    }
};

if (typeof module !== "undefined") {
    module.exports = { runTeardownSteps, reportTeardownFailure };
}
