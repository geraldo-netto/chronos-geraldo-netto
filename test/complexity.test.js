const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { functionBodies } = require("./helpers/cognitive");

// The limit the project holds its code to, and the rule applies to tests: a test
// nobody can follow is not a specification of anything, and a fuzz body that
// re-derives its own expected answer inline is a second implementation that can be
// wrong in the same way as the first — and then they agree, and the suite is green.
//
// The project rule is "at or below 10". This constant is the first forbidden
// score: a body at 11 fails, not just one above it.
const FORBIDDEN_COGNITIVE_COMPLEXITY = 11;

const TEST_DIR = __dirname;
const APPLET_DIR = path.join(__dirname, "..", "files", "chronos@geraldo-netto");
const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");

test("T1165 concise and block arrows count the same expression decisions", () => {
    for (const [expression, expected] of [
        ["a", 0], ["a && b && c", 1], ["a && b || c", 2],
        ["a ? b : c", 1],
        ["a ? b ? c ? d ? e ? 1 : 2 : 3 : 4 : 5 : 6", 15]
    ]) {
        const sources = [
            `const choose = () => ${expression};`,
            `const choose = () => { return ${expression}; };`
        ];
        assert.deepEqual(sources.map(source => functionBodies(source)[0].complexity),
            [expected, expected], expression);
    }
});

test("T1165 concise arrows are rejected at the configured complexity limit", () => {
    const expression = "a ? b ? c ? d ? 1 : 2 : 3 : 4 : 5";
    const file = "test/injected-arrow.js";
    assert.deepEqual(complexityOffenders([[file, "script"]],
        () => `const choose = () => ${expression};`), []);
    assert.deepEqual(complexityOffenders([[file, "script"]],
        () => `const choose = () => (${expression}) && e;`),
    ["test/injected-arrow.js:1 — 11 — choose"]);
});

// The walker is the gate, so the walker is checked: a shape it under-counts is a
// body it would let through. Nesting is what separates this from a path count —
// three ifs in a row cost 3, but an if inside an if inside a loop costs 6.
test("the cognitive-complexity walker counts nesting, not just branches", () => {
    const {
        complexityOf, functionBodies: functions, testBodies: bodies, PARSE_OPTIONS
    } = require("./helpers/cognitive");
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
    assert.equal(complexity("function f(a = b ? c ? d : e : f, g = h && i || j) {}"), 5,
        "default parameter branches count like branches in the body");

    const members = bodies([
        'test.skip("skip", () => { if (a) {} });',
        'test.only("only", () => { while (a) {} });',
        't.test("subtest", () => { a && b; });'
    ].join("\n"));
    assert.deepEqual(members.map(({ name, complexity: value }) => [name, value]), [
        ["skip", 1],
        ["only", 1],
        ["subtest", 1]
    ], "member-expression test bodies are measured too");
    assert.deepEqual(functions("export function f(a) { if (a) {} }", "module")
        .map(({ name, complexity: value }) => [name, value]), [["f", 1]],
    "module functions are measured too");
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

function testSources(dir = TEST_DIR) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return testSources(full);
        }
        return entry.isFile() && entry.name.endsWith(".js") ? [[full, "script"]] : [];
    });
}

function productionSources() {
    return [
        ...appletSources().map((file) => [file, "script"]),
        ...fs.readdirSync(SCRIPTS_DIR)
            .filter((name) => name.endsWith(".mjs"))
            .map((name) => [path.join(SCRIPTS_DIR, name), "module"])
    ];
}

function sourceText(file) {
    return fs.readFileSync(file, "utf8").replace(/^#![^\n]*(?:\n|$)/, "");
}

function complexityOffenders(sources, read = sourceText) {
    const offenders = [];
    for (const [file, sourceType] of sources) {
        const source = read(file);
        for (const body of functionBodies(source, sourceType)) {
            if (body.complexity >= FORBIDDEN_COGNITIVE_COMPLEXITY) {
                offenders.push(
                    `${path.relative(path.join(__dirname, ".."), file)}:${body.line} — ` +
                    `${body.complexity} — ${body.name}`);
            }
        }
    }
    return offenders;
}

test("every JavaScript test function stays below the forbidden line", () => {
    const offenders = complexityOffenders(testSources());
    assert.deepEqual(offenders, [],
        "extract the test's decisions into named helpers:\n  " + offenders.join("\n  "));
});

test("the JavaScript gate rejects a named helper at the forbidden line", () => {
    const source = "function hidden(value) {" +
        "if (value) { for (;;) { if (value) { while (value) {} } } }" +
        "if (value) {}" +
        "}";

    assert.deepEqual(
        complexityOffenders([["test/injected-helper.js", "script"]], () => source),
        ["test/injected-helper.js:1 — 11 — hidden"]
    );
});

test("no function in production tooling is too complex to follow", () => {
    const offenders = complexityOffenders(productionSources());
    assert.deepEqual(offenders, [],
        "extract the steps into named helpers; the limit is the same one the tests " +
        "are held to:\n  " + offenders.join("\n  "));
});
