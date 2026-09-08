const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "diagnostics.js");
const { logSafely } = require(modulePath);

test("diagnostics preserve the logger receiver and argument", (t) => {
    const received = [];
    const previous = global.log;
    t.after(() => { global.log = previous; });
    global.log = function(value) { received.push([this, value]); };
    const failure = new Error("provider failed");
    logSafely("log", failure);
    assert.deepEqual(received, [[global, failure]]);
});

test("native diagnostics tolerate absent, malformed, and failing loggers", () => {
    const source = fs.readFileSync(modulePath, "utf8");
    const context = vm.createContext({});
    vm.runInContext(source, context, { filename: modulePath });
    const emit = () => vm.runInContext('logSafely("logError", "failure")', context);
    assert.doesNotThrow(emit);
    for (const logger of [undefined, null, 3, () => { throw new Error("logger failed"); }]) {
        context.global = { logError: logger };
        assert.doesNotThrow(emit);
    }
    context.global = Object.defineProperty({}, "logError", {
        get() { throw new Error("logger unavailable"); }
    });
    assert.doesNotThrow(emit);
});
