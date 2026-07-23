const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

const APPLET_DIR = path.join(__dirname, "..", "files", "chronos@geraldo-netto");


const { clampText, textWithinLimit, normalizeBoundedText, TEXT_ELLIPSIS } =
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
