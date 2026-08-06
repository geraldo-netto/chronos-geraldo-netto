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

// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are categories Zl and
// Zp, not Cc, so a control-block test alone lets them straight through — and
// Pango, GTK and the Cinnamon log all break a line on them. They are the exact
// multi-line break this function exists to prevent: a holiday name or an event
// summary carrying one grows the label by a row, and a log line carrying one
// forges a second entry.
const LINE_SEPARATORS = new Set([0x2028, 0x2029]);

// The Unicode explicit directional formatting characters: the embeddings and
// overrides U+202A..U+202E and the isolates U+2066..U+2069. They are category
// Cf, so a control-block test lets them through as well.
//
// Their effect is purely visual, which is why they are not the line break
// above — but the visual is the point. A holiday name off a provider carrying
// U+202E RIGHT-TO-LEFT OVERRIDE reverses the display order of everything after
// it in the same Pango layout, so a compromised endpoint rewrites how the rest
// of the month label, its accessible name and its tooltip read, and does the
// same to a Cinnamon log line. Nothing this applet displays needs to set a
// direction by hand: Pango derives it from the text.
const DIRECTIONAL_FORMATTING = [[0x202a, 0x202e], [0x2066, 0x2069]];

function isDirectionalFormatting(code) {
    return DIRECTIONAL_FORMATTING.some(([from, to]) => code >= from && code <= to);
}

function isRemovedControl(code) {
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ||
        LINE_SEPARATORS.has(code) || isDirectionalFormatting(code);
}

function sanitizeControlCharacters(text) {
    if (typeof text !== "string") {
        return "";
    }
    const sanitized = [];
    let replacing = false;
    for (const character of text) {
        const code = character.codePointAt(0);
        if (isRemovedControl(code)) {
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

// UAX #11 Wide and Fullwidth, as ranges: ECMAScript publishes no
// \p{East_Asian_Width} escape, so the property has to be spelled out. The
// combining marks and format characters below do have escapes, and are exactly
// what those escapes mean, so they are written as escapes.
//
// East Asian Ambiguous is counted as one cell. UAX #11 makes it
// context-dependent — two cells only under a legacy East Asian font — and the
// ambiguous characters this applet renders (the ⚠ failure marker, the degree
// sign) come from its own strings, in fonts where they are narrow.
//
// This was a hand-picked approximation and it had holes on both sides: the
// transport block (a leading 🚀 in a clock name misaligned every column to its
// right by one cell), the enclosed-alphanumeric and mahjong blocks, and the
// Wide singletons below U+2E80 — ⌚, ⬛, ⭐, ⭕ — were all counted as one cell,
// while U+1F321..U+1F32C, which UAX #11 calls Neutral, were counted as two. The
// table is the whole W and F set now, generated from Unicode 15.0.0 rather than
// chosen, plus the blocks UAX #11 gives a Wide default to even where
// unassigned.
const WIDE_RANGES = [
    [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec],
    [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
    [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
    [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
    [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
    [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
    [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
    [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
    [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x2e99],
    [0x2e9b, 0x2ef3], [0x2f00, 0x2fd5], [0x2ff0, 0x2ffb], [0x3000, 0x303e],
    [0x3041, 0x3096], [0x3099, 0x30ff], [0x3105, 0x312f], [0x3131, 0x318e],
    [0x3190, 0x31e3], [0x31f0, 0x321e], [0x3220, 0x3247], [0x3250, 0x4dbf],
    [0x4e00, 0xa48c], [0xa490, 0xa4c6], [0xa960, 0xa97c], [0xac00, 0xd7a3],
    [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe52], [0xfe54, 0xfe66],
    [0xfe68, 0xfe6b], [0xff01, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
    [0x16ff0, 0x16ff1], [0x17000, 0x187f7], [0x18800, 0x18cd5],
    [0x18d00, 0x18d08], [0x1aff0, 0x1aff3], [0x1aff5, 0x1affb],
    [0x1affd, 0x1affe], [0x1b000, 0x1b122], [0x1b132, 0x1b132],
    [0x1b150, 0x1b152], [0x1b155, 0x1b155], [0x1b164, 0x1b167],
    [0x1b170, 0x1b2fb], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
    [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f202],
    [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251],
    [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335],
    [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca],
    [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4],
    [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc],
    [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567],
    [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4],
    [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc],
    [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df],
    [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb],
    [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945],
    [0x1f947, 0x1f9ff], [0x1fa70, 0x1fa7c], [0x1fa80, 0x1fa88],
    [0x1fa90, 0x1fabd], [0x1fabf, 0x1fac5], [0x1face, 0x1fadb],
    [0x1fae0, 0x1fae8], [0x1faf0, 0x1faf8], [0x20000, 0x2fffd],
    [0x30000, 0x3fffd]

];
const ZERO_WIDTH_MARKS = /[\p{Mn}\p{Me}\p{Cf}]/u;

function wideCodePoint(codePoint) {
    return WIDE_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last);
}

// How many cells this text occupies in a fixed-width font.
//
// The panel tooltip is a table of clocks lined up with space padding, and the
// stylesheet sets `font-family: monospace` on it for exactly that reason — so
// the padding is only correct if it is computed in cells. A code-point count is
// not one: an ideograph or a fullwidth form takes two, a combining mark or a
// zero-width joiner takes none. The label column is the user's own text and the
// condition column is translated, so in a zh/ja/ko session every column after
// the first was out of step with its heading.
function displayWidth(text) {
    if (typeof text !== "string") {
        return 0;
    }

    let width = 0;
    for (const character of text) {
        if (ZERO_WIDTH_MARKS.test(character)) {
            continue;
        }
        width += wideCodePoint(character.codePointAt(0)) ? 2 : 1;
    }
    return width;
}

// Keep user-supplied query strings and fragments out of logs without pulling
// the HTTP stack into code that only needs a printable provider identity.
function urlForLog(url) {
    if (typeof url !== "string") {
        return "";
    }

    const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)?/i.exec(url); // NOSONAR [S5842] -- empty URL path is valid
    if (match) {
        return match[1] + (match[2] || "");
    }

    return url.split(/[?#]/)[0];
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

// The same rule in the unit the tooltip's padding is made of.
//
// A cap that exists to bound a column has to be counted the way the column is,
// and clampText counts code points: "東".repeat(24) clamps to 24 of those and
// 48 cells, twice the budget, in exactly the CJK sessions displayWidth was
// written for. The ellipsis is one cell and is inside the budget, so the result
// never exceeds maxCells; a wide character that would straddle the last cell is
// dropped rather than half-shown.
function clampToWidth(text, maxCells) {
    const source = typeof text === "string" ? text : "";
    if (!Number.isInteger(maxCells) || maxCells < 1) {
        return "";
    }
    if (displayWidth(source) <= maxCells) {
        return source;
    }

    const prefix = [];
    let width = 0;
    for (const character of source) {
        width += displayWidth(character);
        if (width > maxCells - 1) {
            break;
        }
        prefix.push(character);
    }

    return prefix.join("").replace(/\s+$/, "") + TEXT_ELLIPSIS; // NOSONAR [S8786] -- prefix width is bounded
}

// The parts are an event summary from whatever ICS or CalDAV feed the user
// subscribed to, a holiday name from a third-party service, and a provider's own
// error string. They were passed as the *replacement* argument of
// String.prototype.replace, where `$&`, `` $` ``, `$'` and `$1` are expanded as
// replacement patterns — so a summary containing $& was announced with the
// matched text spliced into it.
//
// Worse, and much easier to hit: the substitutions were chained, so the second
// .replace("%s", right) scanned the string the first one had already built. An
// event called "50%sale" made the screen reader announce
// "10:00 — 50In progressale — %s".
//
// A function replacement expands nothing, and the template is scanned once: a %s
// inside a substituted value is text, not a placeholder.
//
// It was private, so eight production sites went on writing the unsafe form it
// was written to eliminate - latent only because of what the values they
// substitute happen to contain today, which is the argument this comment
// rejects. It is the shared rule now, and a static test refuses the raw form.
function fillTemplate(template, values) {
    let index = 0;

    return template.replace(/%s/g, () => // NOSONAR [S7781] -- accepted compatible form
        index < values.length ? values[index++] : "%s");
}

// The calendar grid splits its "YYYY/M" keys into strings, so both the holiday
// service and the religious observance tables coerce their year and month the
// same way: a number or a numeric string converts, and anything else - a
// boolean, an array - reads as not-a-number rather than coercing. `true`
// reading as January is not a conversion anyone asked for.
//
// It was byte-identical in both, and both sit on the path a single grid render
// takes: ReligiousHolidayProvider.getHolidays coerces the pair, then
// HolidayService.getHolidays coerces it again.
function numericInput(value) {
    return typeof value === "number" || typeof value === "string" ?
        Number(value) : NaN;
}

if (typeof module !== "undefined") {
    module.exports = {
        clampText,
        fillTemplate,
        clampToWidth,
        displayWidth,
        sanitizeControlCharacters,
        textWithinLimit,
        normalizeBoundedText,
        numericInput,
        urlForLog,
        TEXT_ELLIPSIS
    };
}
