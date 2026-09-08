const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

const APPLET_DIR = path.join(__dirname, "..", "files", "chronos@geraldo-netto");


const { clampText, displayWidth, textWithinLimit, normalizeBoundedText, validUnicode, validNativeText,
    sanitizeControlCharacters, TEXT_ELLIPSIS } =
    require(path.join(APPLET_DIR, "textUtils.js"));

test("Unicode validity preserves complete scalar values and rejects isolated surrogates", () => {
    const fixture = require("./fixtures/settings_unicode_cases.json");
    for (const { input, valid } of fixture.text) {
        assert.equal(validUnicode(input), valid, JSON.stringify(input));
        assert.equal(normalizeBoundedText(input, 256), valid ? input : "");
    }
    for (const input of [null, false, 1, [], {}]) assert.equal(validUnicode(input), false);
});

test("T1150 native text refuses NUL without changing Unicode scalar validity", () => {
    const fixture = require("./fixtures/timezone_nul_cases.json");
    for (const input of fixture.invalid) {
        assert.equal(validUnicode(input), true);
        assert.equal(validNativeText(input), false);
    }
    for (const input of fixture.valid) assert.equal(validNativeText(input), true);
    for (const input of [null, false, 1, [], {}, "\ud800", "\udfff"])
        assert.equal(validNativeText(input), false);
    for (const input of ["", "🏙", "a\nb", "\ufeffa\ufeff"])
        assert.equal(validNativeText(input), true);
});

// T783: the test was a code-block one — C0 plus C1 — and U+2028 LINE SEPARATOR
// and U+2029 PARAGRAPH SEPARATOR are categories Zl and Zp, so they went
// straight through the function whose whole job is to stop a third party's
// string breaking a line. Pango, GTK and the Cinnamon log all break on them.
test("the sanitizer removes every character that can break a line", () => {
    const breaks = [0x00, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1f, 0x7f, 0x85, 0x9f,
        0x2028, 0x2029];

    for (const code of breaks) {
        const point = code.toString(16).padStart(4, "0").toUpperCase();
        assert.equal(
            sanitizeControlCharacters("a" + String.fromCodePoint(code) + "b"),
            "a b", "U+" + point + " must not reach a label or a log line");
    }

    // a run of them still collapses to one space
    assert.equal(sanitizeControlCharacters(
        "a" + String.fromCodePoint(0x2028, 0x0a, 0x2029) + "b"), "a b");

    // and what is not a control is left alone. U+2007 FIGURE SPACE and U+3000
    // IDEOGRAPHIC SPACE are Zs: they print, so they are text, not breaks.
    const spaced = "Dia" + String.fromCodePoint(0x2007) + "de" +
        String.fromCodePoint(0x3000) + "la";
    assert.equal(sanitizeControlCharacters(spaced), spaced);
    assert.equal(sanitizeControlCharacters(null), "");
});

// T833: the explicit directional formatting characters are category Cf, so the
// control-block test let them through. Their effect is visual rather than
// structural, and the visual is the point: a holiday name off a provider
// carrying U+202E reverses the display order of everything after it in the same
// Pango layout, rewriting how the rest of the month label, its accessible name
// and its tooltip read - and doing the same to a Cinnamon log line.
test("the sanitizer removes the overrides that reorder what follows them", () => {
    const overrides = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
        0x2066, 0x2067, 0x2068, 0x2069];

    for (const code of overrides) {
        const point = code.toString(16).padStart(4, "0").toUpperCase();
        assert.equal(
            sanitizeControlCharacters("Dia" + String.fromCodePoint(code) + "livre"),
            "Dia livre", "U+" + point + " must not reach a label or a log line");
    }

    // the neighbours on either side of both ranges are ordinary marks and text:
    // U+2029 is handled above, U+202F is a space, U+2065 is unassigned and
    // U+206A is a deprecated format character no renderer acts on
    for (const code of [0x202f, 0x2065, 0x206a]) {
        const kept = "a" + String.fromCodePoint(code) + "b";
        assert.equal(sanitizeControlCharacters(kept), kept);
    }
});

// T786: one rule, one string - a world clock's Display name, which the settings
// dialog persists and the runtime reads back - and two implementations with no
// gate between them. It had already drifted twice: the line separators and the
// bidi overrides were added here alone, so the dialog went on saving what the
// applet then had to strip. The Python suite asserts the same table.
test("the sanitizer matches the settings dialog's copy of the rule", () => {
    const cases = require("./fixtures/control_character_cases.json");

    for (const { codePoint, why } of cases.removed) {
        assert.equal(
            sanitizeControlCharacters("a" + String.fromCodePoint(codePoint) + "b"),
            "a b", why);
    }
    for (const { codePoint, why } of cases.kept) {
        const kept = "a" + String.fromCodePoint(codePoint) + "b";
        assert.equal(sanitizeControlCharacters(kept), kept, why);
    }
    for (const { codePoints, why } of cases.runs) {
        assert.equal(
            sanitizeControlCharacters("a" + String.fromCodePoint(...codePoints) + "b"),
            "a b", why);
    }
});

// T792: MAX_CLOCK_LABEL_CELLS exists to bound a layout its own comment
// describes in cells - the popup grid, and the monospace tooltip padded to the
// widest cell - and it was enforced with clampText, a code-point clamp.
// textUtils exists because a code-point count is the wrong unit here.
test("clampToWidth counts the cells the tooltip pads with", () => {
    const { clampToWidth, displayWidth } = require(path.join(APPLET_DIR, "textUtils.js"));

    // the measurement that made the two units part company
    assert.equal(displayWidth("東".repeat(24)), 48);
    // 11 ideographs and the ellipsis: a 12th would straddle the last cell
    assert.equal(displayWidth(clampToWidth("東".repeat(24), 24)), 23);

    assert.equal(clampToWidth("Rome", 10), "Rome", "inside the budget is untouched");
    assert.equal(clampToWidth("東".repeat(3), 6), "東東東", "exactly the budget too");

    // one cell is the ellipsis's, and a wide character that would straddle the
    // last cell is dropped rather than half-shown
    assert.equal(clampToWidth("東".repeat(4), 6), "東東…");
    assert.equal(clampToWidth("東".repeat(4), 7), "東東東…");
    assert.equal(clampToWidth("abcdef", 4), "abc…");

    // trailing space goes before the ellipsis, as clampText does it
    assert.equal(clampToWidth("Rio de Janeiro", 5), "Rio…");

    // zero-width marks cost nothing, so a decomposed name is not cut short
    const combining = "a" + String.fromCodePoint(0x0301);
    assert.equal(clampToWidth(combining.repeat(4), 4), combining.repeat(4));

    assert.equal(clampToWidth(null, 4), "");
    assert.equal(clampToWidth("Rome", 0), "");
    assert.equal(clampToWidth("Rome", 1.5), "");
});

test("clampText counts code points and keeps what it cuts readable", () => {
    assert.equal(clampText("Rome", 10), "Rome", "shorter than the cap is untouched");
    assert.equal(clampText("Rome", 4), "Rome", "exactly the cap is untouched");
    assert.equal(clampText(undefined, 4), "", "a non-string is the empty string");
    assert.equal(clampText(null, 4), "");
    assert.equal(clampText("Rome", 0), "");
    assert.equal(clampText("Rome", NaN), "");

    assert.equal(clampText("abcdef", 4), "abc" + TEXT_ELLIPSIS,
        "the ellipsis is one of the code points the cap allows");
    assert.equal(Array.from(clampText("abcdef", 4)).length, 4);

    // the space before the cut goes with it: "Rome …" reads as a broken word
    assert.equal(clampText("ab   cdef", 6), "ab" + TEXT_ELLIPSIS);
});

test("bounded text checks and normalization count Unicode code points", () => {
    assert.equal(textWithinLimit("x".repeat(4), 4), true);
    assert.equal(textWithinLimit("x".repeat(5), 4), false);
    assert.equal(textWithinLimit("🎉".repeat(4), 4), true);
    assert.equal(textWithinLimit("🎉".repeat(5), 4), false);
    assert.equal(textWithinLimit(null, 4), false);
    assert.equal(textWithinLimit("text", -1), false);

    assert.equal(normalizeBoundedText("  São Paulo  ", 13), "São Paulo");
    assert.equal(normalizeBoundedText("  São Paulo  ", 9), "",
        "the cheap raw bound runs before trim");
    assert.equal(normalizeBoundedText("🎉".repeat(4), 4), "🎉".repeat(4));
    assert.equal(normalizeBoundedText("🎉".repeat(5), 4), "");
    assert.equal(normalizeBoundedText(null, 4), "");

    const huge = clampText("x".repeat(200000), 32);
    assert.equal(Array.from(huge).length, 32);
    assert.ok(huge.endsWith(TEXT_ELLIPSIS));
});

// REGRESSION: two of the four copies of this rule sliced UTF-16 units. A string
// whose code point at the cap is astral — an emoji, which a subscribed feed's
// SUMMARY or a provider's holiday name may well contain — was cut between the
// two halves of a surrogate pair, and the lone surrogate went on to Pango.
test("a clamp never splits a surrogate pair", () => {
    const emoji = "🎉";
    assert.equal(emoji.length, 2, "one code point, two UTF-16 units");

    for (const cap of [2, 3, 4, 5]) {
        const clamped = clampText(emoji.repeat(10), cap);
        assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clamped),
            `a lone surrogate survived a clamp at ${cap}: ${JSON.stringify(clamped)}`);
        assert.equal(Array.from(clamped).length, cap);
    }
});

// T805: byte-identical in holidays.js and religiousHolidays.js, and both on the
// path a single grid render takes - the religious provider coerces the pair,
// then the holiday service coerces it again. The comment in holidays.js pointed
// at the copy rather than sharing it.
test("numericInput coerces the strings a grid key splits into, and nothing else", () => {
    const { numericInput } = require(path.join(APPLET_DIR, "textUtils.js"));

    assert.equal(numericInput("2026"), 2026, "the calendar splits YYYY/M into strings");
    assert.equal(numericInput(7), 7);
    assert.equal(numericInput(" 7 "), 7);
    assert.equal(Number.isNaN(numericInput("July")), true);
    assert.equal(Number.isNaN(numericInput("")), false, "the empty string is 0 to Number");

    // a boolean or an array would coerce too, and `true` reading as January is
    // not a conversion anyone asked for
    for (const junk of [true, false, [], [1], {}, null, undefined, () => 1]) {
        assert.equal(Number.isNaN(numericInput(junk)), true, JSON.stringify(junk) || String(junk));
    }
});

// T947: the same ISO-639-1 extraction stood in weatherServiceAdapters
// (geocodeLanguage) and localeQuery (messageLanguage). One rule now, with the
// fallback left to the caller because that is the only part that differed.
test("isoLanguageCode reduces a session locale to the code providers take", () => {
    const { isoLanguageCode } = require(path.join(APPLET_DIR, "textUtils.js"));

    assert.equal(isoLanguageCode("pt_BR.UTF-8", "en"), "pt");
    assert.equal(isoLanguageCode("de_DE@euro", "en"), "de");
    assert.equal(isoLanguageCode("it-IT", "en"), "it");
    assert.equal(isoLanguageCode("IT", "en"), "it");
    assert.equal(isoLanguageCode("en:en_GB", "xx"), "en");

    // a locale naming no language, or naming it in anything but two letters, is
    // not a language a provider knows: the caller's fallback stands instead
    assert.equal(isoLanguageCode("C", "en"), "en");
    assert.equal(isoLanguageCode("POSIX", "pt"), "pt");
    assert.equal(isoLanguageCode("", "pt"), "pt");
    assert.equal(isoLanguageCode(undefined, "pt"), "pt");
    assert.equal(isoLanguageCode(null, "pt"), "pt");
    assert.equal(isoLanguageCode(0, "pt"), "pt");
    assert.equal(isoLanguageCode("eng_GB", "en"), "en");
});

test("displayWidth measures fixed-width cells, not code points", () => {
    assert.equal(displayWidth("Rome"), 4, "Latin letters are one cell each");
    assert.equal(displayWidth(""), 0);
    assert.equal(displayWidth(undefined), 0, "a non-string measures nothing");
    assert.equal(displayWidth(42), 0);

    // the case the panel tooltip was misaligning: a clock the user names in
    // Japanese is four code points and eight cells
    assert.equal(Array.from("東京モスクワ").length, 6);
    assert.equal(displayWidth("東京モスクワ"), 12, "CJK and kana take two cells each");
    assert.equal(displayWidth("Ｒｏｍｅ"), 8, "so do fullwidth Latin forms");
    assert.equal(displayWidth("서울"), 4, "and Hangul syllables");

    // a decomposed accent is a letter plus a mark, and advances one cell
    assert.equal(Array.from("e\u0301").length, 2);
    assert.equal(displayWidth("e\u0301"), 1, "a combining mark advances nothing");
    assert.equal(displayWidth("\u200d"), 0, "nor does a zero-width joiner");

    // East Asian Ambiguous stays narrow: these are the applet's own glyphs, in
    // fonts where they take one cell
    assert.equal(displayWidth("\u26a0"), 1, "the failure marker is one cell");
    assert.equal(displayWidth("21 \u00b0C"), 5, "as is the degree sign");

    // the boundaries of the first and last wide ranges, either side
    assert.equal(displayWidth("\u10ff\u1100\u115f\u1160"), 6);
    assert.equal(displayWidth("\u{1ffff}\u{20000}"), 3);
});

// T807: the table was hand-picked and had holes on both sides. A clock named
// with a leading \ud83d\ude80 misaligned every column to its right by one cell, and the
// same was true of the enclosed-alphanumeric and mahjong blocks and of the Wide
// singletons below U+2E80 - while U+1F321..U+1F32C, which UAX #11 calls
// Neutral, were counted as two. The tooltip is padded from this number.
test("displayWidth agrees with UAX #11 across the blocks a label can carry", () => {
    // one row per block the table used to miss, and one for the range it
    // over-counted. Two cells:
    for (const wide of ["\u{1F680}", "\u{1F6D5}", "\u{1F004}", "\u{1F0CF}",
        "\u{1F19A}", "\u{1F210}", "\u231a", "\u2b1b", "\u2b50", "\u2b55",
        "\u{1F7E0}", "\u{1FA90}", "\u{1F302}", "\u{1F950}"]) {
        assert.equal(displayWidth(wide), 2,
            "U+" + wide.codePointAt(0).toString(16).toUpperCase() + " is Wide");
    }

    // ...and one cell, including the Neutral pocket inside the pictographs and
    // the Neutral neighbours just outside three of the ranges above
    for (const narrow of ["\u{1F321}", "\u{1F32C}", "\u{1F1E6}", "\u{1F6C7}",
        "\u2b1a", "\u2b51", "\u{1F003}", "\u{1F93B}"]) {
        assert.equal(displayWidth(narrow), 1,
            "U+" + narrow.codePointAt(0).toString(16).toUpperCase() + " is Neutral");
    }

});

test("displayWidth is what lines the tooltip columns up", () => {
    const pad = (cell, width) => cell + " ".repeat(width - displayWidth(cell));
    const rows = [["東京", "18:52"], ["Rome", "10:52"]];
    const width = Math.max(...rows.map(([label]) => displayWidth(label)));

    const [tokyo, rome] = rows.map(([label, time]) => pad(label, width) + "  " + time);
    assert.equal(displayWidth(tokyo.split("  ")[0]), displayWidth(rome.split("  ")[0]),
        "both label columns end on the same cell");
    // the count that used to be used would have padded 東京 to four cells and
    // pushed the time column two cells right of Rome's
    assert.notEqual(tokyo.indexOf("18:52"), rome.indexOf("10:52"));
});
