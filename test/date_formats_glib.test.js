const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("T1167 admitted formats preserve native clock output", (context) => {
    const invalid = ["Before\0After %H:%M", "\0%H:%M", "\ud800", "a\udfffb"];
    const result = spawnSync("cjs", [path.join(__dirname, "helpers/dateFormatsGlib.js"),
        path.resolve(__dirname, "../files/chronos@geraldo-netto"),
        JSON.stringify([...invalid, "🌙 %H:%M"])], { encoding: "utf8", timeout: 10000 });
    if (result.error?.code === "ENOENT") {
        context.skip("cjs unavailable; composed portable format regressions remain active");
        return;
    }
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.deepEqual(JSON.parse(result.stdout), [
        ...invalid.map(() => ({ admitted: false, format: "%H:%M", glib: "12:34",
            accepted: true, clockVisible: true })),
        { admitted: true, format: "🌙 %H:%M", glib: "🌙 12:34",
            accepted: true, clockVisible: true }
    ]);
});
