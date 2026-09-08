const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseConfig, readReport, runAudits } = require("./fuzz/runner");

test("input fuzz configuration is bounded and keeps seed zero reproducible", () => {
    assert.deepEqual(parseConfig({}), { seed: 20260908, cases: 512 });
    assert.deepEqual(parseConfig({ FUZZ_SEED: "0", FUZZ_CASES: "1" }), { seed: 0, cases: 1 });
    for (const text of ["", "-1", "1.5", "Infinity", "NaN", "1e3", "4294967296"]) {
        assert.throws(() => parseConfig({ FUZZ_SEED: text }), /FUZZ_SEED/);
    }
    for (const text of ["0", "-1", "10001", "1.5", "", "Infinity"]) {
        assert.throws(() => parseConfig({ FUZZ_CASES: text }), /FUZZ_CASES/);
    }
});

test("fuzz worker crashes, timeouts and dishonest reports cannot look green", () => {
    const green = { checks: 1, failureCount: 0, failures: [] };
    const outcomes = [
        { error: new Error("ETIMEDOUT") }, { signal: "SIGABRT" },
        { status: 1, stdout: JSON.stringify(green) },
        { status: 0, stdout: "not JSON" },
        { status: 0, stdout: JSON.stringify({ checks: 0, failureCount: 0, failures: [] }) },
        { status: 0, stdout: JSON.stringify({ ...green, failureCount: 1 }) }
    ];
    for (const outcome of outcomes) {
        const report = readReport(outcome, "weather", 42);
        assert.equal(report.failureCount, 1);
        assert.equal(report.failures[0].target, "weather.harness");
    }
});

test("input audit runs every suite after a failure with isolated bounded workers", () => {
    const failure = { checks: 2, failureCount: 1, failures: [
        { target: "invalid-neighbor", seed: 42, case: 0, input: null, message: "bad" }
    ] };
    const calls = [];
    const report = runAudits({ seed: 42, cases: 20 }, (command, args, options) => {
        calls.push({ command, args, options });
        const result = calls.length === 1 ? failure : { checks: 3, failureCount: 0, failures: [] };
        return { status: result.failureCount ? 1 : 0, stdout: JSON.stringify(result) };
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(report.suites.map((suite) => suite.suite), ["calendar", "weather", "settings"]);
    assert.equal(report.checks, 8);
    assert.equal(report.failureCount, 1);
    assert.deepEqual(report.suites[0].failures, failure.failures);
    for (const call of calls) {
        assert.equal(call.options.shell, false);
        assert.equal(call.options.timeout, 30000);
        assert.deepEqual(JSON.parse(call.options.input), { seed: 42, cases: 20 });
    }
    assert.equal(calls[2].command, "python3");
    assert.equal(calls[2].args[0], "-B");
});
