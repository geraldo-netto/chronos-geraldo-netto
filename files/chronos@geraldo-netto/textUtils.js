// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// One truncation rule, for every string this applet shows that a third party
// wrote: a world clock's label, the panel's weather suffix, an event summary off
// a subscribed feed, a holiday name off a provider.
//
// It was written four times, and the surrogate-safe version was applied to two of
// them. The other two sliced UTF-16 units, so a 300th-character emoji in a feed's
// SUMMARY — or in a holiday name — was cut in half and a lone surrogate went to
// Pango.
var TEXT_ELLIPSIS = "…"; // NOSONAR [S3504] -- GJS importer export

// Code points, not UTF-16 units. The trailing whitespace goes before the
// ellipsis: "Rome …" reads as a broken word, "Rome…" as a truncated one.
function clampText(text, maxLength) {
    const source = typeof text === "string" ? text : "";
    if (source.length <= maxLength) {
        return source;
    }
    const chars = Array.from(source);
    if (chars.length <= maxLength) {
        return source;
    }

    return chars.slice(0, maxLength - 1).join("").replace(/\s+$/, "") + TEXT_ELLIPSIS; // NOSONAR [S8786] -- input length is bounded
}

if (typeof module !== "undefined") {
    module.exports = { clampText, TEXT_ELLIPSIS };
}
