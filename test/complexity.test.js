const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { testBodies, functionBodies } = require("./helpers/cognitive");

// The limit the project holds its code to, and the rule applies to tests: a test
// nobody can follow is not a specification of anything, and a fuzz body that
// re-derives its own expected answer inline is a second implementation that can be
// wrong in the same way as the first — and then they agree, and the suite is green.
//
// Five bodies were over this when the audit measured them by hand (T449), and a
// sixth had drifted over since. Hand-measured means it drifts, so it is a test.
//
// The project rule is "at or below 10, 15 or higher forbidden": this gate holds
// the forbidden line — a body scoring FORBIDDEN_COGNITIVE_COMPLEXITY fails, not
// just one above it. Ratcheting the ceiling toward 10 is tracked work, not this
// constant.
const FORBIDDEN_COGNITIVE_COMPLEXITY = 15;

const TEST_DIR = __dirname;
const APPLET_DIR = path.join(__dirname, "..", "files", "chronos@geraldo-netto");

test("no test body is too complex to follow", () => {
    const offenders = [];

    for (const file of fs.readdirSync(TEST_DIR).filter((name) => name.endsWith(".test.js"))) {
        const source = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
        for (const body of testBodies(source)) {
            if (body.complexity >= FORBIDDEN_COGNITIVE_COMPLEXITY) {
                offenders.push(`${file}:${body.line} — ${body.complexity} — ${body.name}`);
            }
        }
    }

    assert.deepEqual(offenders, [],
        "hoist the tables to module scope and pull the per-round expectation into a " +
        "named helper, so the body is a loop and an assert:\n  " + offenders.join("\n  "));
});

// The walker is the gate, so the walker is checked: a shape it under-counts is a
// body it would let through. Nesting is what separates this from a path count —
// three ifs in a row cost 3, but an if inside an if inside a loop costs 6.
test("the cognitive-complexity walker counts nesting, not just branches", () => {
    const { complexityOf, PARSE_OPTIONS } = require("./helpers/cognitive");
    const espree = require("espree");
    const complexity = (source) =>
        complexityOf(espree.parse(source, PARSE_OPTIONS).body[0]);

    assert.equal(complexity("function f() {}"), 0);
    assert.equal(complexity("function f(a) { if (a) { g(); } }"), 1);
    assert.equal(complexity("function f(a, b, c) { if (a) {} if (b) {} if (c) {} }"), 3,
        "three in a row cost one each");
    assert.equal(complexity("function f(a) { for (;;) { if (a) { while (a) {} } } }"), 6,
        "1 for the loop, 2 for the if inside it, 3 for the while inside that");
    assert.equal(complexity("function f(a) { if (a) {} else { g(); } }"), 2, "the else costs too");
    assert.equal(complexity("function f(a) { if (a) {} else if (a) {} }"), 2,
        "an else-if continues the chain rather than nesting inside it");
    assert.equal(complexity("function f(a, b) { if (a && b && a) {} }"), 2,
        "one sequence of && costs 1, plus the if");
    assert.equal(complexity("function f(a, b) { if (a && b || a) {} }"), 3,
        "alternating operators cost one each");
});

// The limit was scoped to TEST_DIR, so the rule the tests are held to did not
// apply to the code they test. Measured with this same walker when the gate was
// pointed here, httpGetJson was 42, the `locale -k` state machine 32, the
// provider teardown 21 and the grid's holiday annotator 20 — precisely the
// functions where an added branch silently bypasses a size guard, a cancellation
// or a generation check.
function appletSources(dir = APPLET_DIR) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === "po" || entry.name === "__pycache__" ? [] : appletSources(full);
        }
        return entry.isFile() && entry.name.endsWith(".js") ? [full] : [];
    });
}

test("no function in the applet is too complex to follow", () => {
    const offenders = [];

    for (const file of appletSources()) {
        const source = fs.readFileSync(file, "utf8");
        for (const body of functionBodies(source)) {
            if (body.complexity >= FORBIDDEN_COGNITIVE_COMPLEXITY) {
                offenders.push(
                    `${path.relative(APPLET_DIR, file)}:${body.line} — ${body.complexity} — ${body.name}`);
            }
        }
    }

    assert.deepEqual(offenders, [],
        "extract the steps into named helpers; the limit is the same one the tests " +
        "are held to:\n  " + offenders.join("\n  "));
});
