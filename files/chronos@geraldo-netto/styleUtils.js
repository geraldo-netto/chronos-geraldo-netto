/* eslint camelcase: "off" */

// Event/holiday colors come from external calendar data; only let plain
// color syntax through to inline St styles (blocks `;`-injection of extra
// declarations such as background-image).
var CSS_COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9,.\s%]+\)|[a-zA-Z]+)$/;

function safeCssColor(color, fallback = "transparent") {
    if (typeof color === "string" && CSS_COLOR_PATTERN.test(color.trim())) {
        return color.trim();
    }
    return fallback;
}

if (typeof module !== "undefined") {
    module.exports = {
        safeCssColor
    };
}
