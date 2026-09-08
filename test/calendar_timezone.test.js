const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

function runNative(context, cases) {
    const result = spawnSync("cjs", [path.join(__dirname, "helpers/calendarGridGlib.js"),
        path.resolve(__dirname, "../files/chronos@geraldo-netto"), JSON.stringify(cases), "timezone"],
    { encoding: "utf8", timeout: 10000 });
    if (result.error?.code === "ENOENT") {
        context.skip("cjs is not installed; timezone selection requires native GLib");
        return null;
    }
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stderr, "", "the private process emitted no native warnings");
    return JSON.parse(result.stdout);
}

function assertSelection(state, selected, active) {
    assert.deepEqual(state.selected, selected);
    assert.match(state.heading, new RegExp(
        `${selected.year}-${String(selected.month).padStart(2, "0")}-${String(selected.day).padStart(2, "0")}`));
    assert.equal(state.rows[0], `Holiday ${selected.year}/${selected.month}/${selected.day}`);
    assert.deepEqual(state.managerDate, active ? selected : null);
}

function assertTimezoneChange(input, result) {
    assertSelection(result.after, input.selected, input.active);
    assert.equal(result.pendingPreserved, true);
    assert.deepEqual(result.after.queued, result.before.queued);
    const target = { year: 2026, month: input.pending === "month" ? 10 : 9,
        day: input.pending === "day" ? 9 : 8 };
    assertSelection(result.flushed, target, input.active);
    assertSelection(result.returned, target, input.active);
    if (input.pending) {
        assert.deepEqual(result.flushed.focusedDate, target);
        assert.equal(result.before.focusIntent, true);
        assert.ok(result.before.timer > 0);
        assert.equal(result.flushed.timer, 0);
    }
    if (input.active) {
        const delta = input.to === "Pacific/Honolulu" ? 86400 : -86400;
        assert.equal(result.after.managerUnix - result.before.managerUnix, delta,
            "the same civil day has a different local event key");
    }
}

test("native timezone changes retain civil selection and queued day/month focus intent", (context) => {
    const cases = [true, false].flatMap(active => [null, "day", "month"].flatMap(pending => [
        { from: "Pacific/Kiritimati", to: "Pacific/Honolulu", active, pending },
        { from: "Pacific/Honolulu", to: "Pacific/Kiritimati", active, pending }
    ])).map(input => ({ ...input, selected: { year: 2026, month: 9, day: 8 } }));
    const results = runNative(context, cases);
    if (!results) return;
    results.forEach((result, i) => assertTimezoneChange(cases[i], result));
});

test("native omitted selections retain headings and holidays without borrowing next-day events", (context) => {
    const cases = [true, false].flatMap(active => [
        { selected: { year: 2011, month: 12, day: 30 }, pending: null },
        { selected: { year: 2011, month: 12, day: 29 }, pending: "day" },
        { selected: { year: 2011, month: 11, day: 30 }, pending: "month" }
    ].map(input => ({ ...input, active, from: "Europe/Rome", to: "Pacific/Apia" })));
    const results = runNative(context, cases);
    if (!results) return;
    const omitted = { year: 2011, month: 12, day: 30 };
    results.forEach((result, i) => {
        const { active, pending } = cases[i];
        assert.equal(result.pendingPreserved, true);
        assertSelection(result.flushed, omitted, active);
        assert.equal(result.flushed.local, null);
        assert.equal(result.flushed.managerUnix, null);
        assert.deepEqual(result.flushed.rows, ["Holiday 2011/12/30"]);
        if (pending) assert.deepEqual(result.flushed.focusedDate, omitted);
        assertSelection(result.returned, omitted, active);
        assert.equal(result.returned.local, "2011-12-30 +0100");
        assertSelection(result.arrow, { year: 2011, month: 12, day: 31 }, active);
        assert.deepEqual(result.arrow.focusedDate, result.arrow.selected);
        assertSelection(result.pageDown, { year: 2012, month: 1, day: 31 }, active);
        assert.deepEqual(result.pageDown.focusedDate, result.pageDown.selected);
    });
});
