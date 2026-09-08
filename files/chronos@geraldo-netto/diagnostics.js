// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

function logSafely(method, value) {
    try {
        globalThis.global?.[method]?.(value);
    } catch {
        // Diagnostics cannot interrupt cleanup, fallback, or callback delivery.
    }
}

if (typeof module !== "undefined") {
    module.exports = { logSafely };
}
