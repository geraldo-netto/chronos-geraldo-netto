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

function sanitizeControlCharacters(text) {
    if (typeof text !== "string") {
        return "";
    }
    const sanitized = [];
    let replacing = false;
    for (const character of text) {
        const code = character.codePointAt(0);
        const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
        if (control) {
            if (!replacing) {
                sanitized.push(" ");
                replacing = true;
            }
        } else {
            sanitized.push(character);
            replacing = false;
        }
    }
    return sanitized.join("");
}

// A cheap UTF-16 check handles ordinary ASCII text. Only a string that may fit
// because it contains astral code points is iterated, and iteration stops as
// soon as the cap is exceeded instead of materializing the whole input.
function textWithinLimit(text, maxLength) {
    if (typeof text !== "string" || !Number.isInteger(maxLength) || maxLength < 0) {
        return false;
    }
    if (text.length <= maxLength) {
        return true;
    }

    let length = 0;
    for (const _character of text) {
        length++;
        if (length > maxLength) {
            return false;
        }
    }
    return true;
}

function normalizeBoundedText(text, maxLength) {
    if (!textWithinLimit(text, maxLength)) {
        return "";
    }
    return text.trim();
}

// Code points, not UTF-16 units. The trailing whitespace goes before the
// ellipsis: "Rome …" reads as a broken word, "Rome…" as a truncated one.
function clampText(text, maxLength) {
    const source = typeof text === "string" ? text : "";
    if (!Number.isInteger(maxLength) || maxLength < 1) {
        return "";
    }
    if (textWithinLimit(source, maxLength)) {
        return source;
    }

    const prefix = [];
    for (const character of source) {
        if (prefix.length >= maxLength - 1) {
            break;
        }
        prefix.push(character);
    }

    return prefix.join("").replace(/\s+$/, "") + TEXT_ELLIPSIS; // NOSONAR [S8786] -- prefix length is bounded
}

if (typeof module !== "undefined") {
    module.exports = {
        clampText,
        sanitizeControlCharacters,
        textWithinLimit,
        normalizeBoundedText,
        TEXT_ELLIPSIS
    };
}
