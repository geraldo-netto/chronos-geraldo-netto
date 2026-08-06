const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

const APPLET_DIR = path.join(__dirname, "..", "files", "chronos@geraldo-netto");


const { clampText, displayWidth, textWithinLimit, normalizeBoundedText, TEXT_ELLIPSIS } =
    require(path.join(APPLET_DIR, "textUtils.js"));

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
