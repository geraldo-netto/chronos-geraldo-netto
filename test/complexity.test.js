const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { testBodies } = require("./helpers/cognitive");

// The limit the project holds its code to, and the rule applies to tests: a test
// nobody can follow is not a specification of anything, and a fuzz body that
// re-derives its own expected answer inline is a second implementation that can be
// wrong in the same way as the first — and then they agree, and the suite is green.
//
// Five bodies were over this when the audit measured them by hand (T449), and a
// sixth had drifted over since. Hand-measured means it drifts, so it is a test.
const MAX_COGNITIVE_COMPLEXITY = 15;

const TEST_DIR = __dirname;

test("no test body is too complex to follow", () => {
    const offenders = [];

    for (const file of fs.readdirSync(TEST_DIR).filter((name) => name.endsWith(".test.js"))) {
        const source = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
        for (const body of testBodies(source)) {
            if (body.complexity > MAX_COGNITIVE_COMPLEXITY) {
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
