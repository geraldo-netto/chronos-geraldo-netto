const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { ESLint } = require("eslint");

// The lint config once extended no ruleset at all: three rules were on, and a
// file with unreachable code, a duplicate object key and `if (o = 3)` linted
// clean, exit 0. The one static gate in the project caught almost no correctness
// bug, and nothing said so. These lint real text through the real config, so
// dropping js.configs.recommended again fails here rather than in review.
const applet = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "gate-probe.js");

async function rulesFor(code) {
    const eslint = new ESLint({ cwd: path.join(__dirname, "..") });
    const [result] = await eslint.lintText(code, { filePath: applet });
    return result.messages.map((message) => message.ruleId);
}

test("the lint gate catches unreachable code", async () => {
    const rules = await rulesFor("function f() {\n    return 1;\n    f();\n}\nf();\n");
    assert.ok(rules.includes("no-unreachable"), `got ${JSON.stringify(rules)}`);
});

test("the lint gate catches a duplicate object key", async () => {
    const rules = await rulesFor("var o = { a: 1, a: 2 };\nlog(o);\n");
    assert.ok(rules.includes("no-dupe-keys"), `got ${JSON.stringify(rules)}`);
});

test("the lint gate catches an assignment where a comparison was meant", async () => {
    const rules = await rulesFor("var o = 1;\nif (o = 3) {\n    log(o);\n}\n");
    assert.ok(rules.includes("no-cond-assign"), `got ${JSON.stringify(rules)}`);
});

// The GJS dialect is the reason the config cannot simply be the recommended set:
// every module opens with `/* global imports */`, and the modules that bind
// gettext own a module-level `_`. Both must stay lintable.
test("the lint gate still accepts the GJS dialect it has to lint", async () => {
    const messages = await rulesFor(
        "/* global imports */\nconst _ = imports.gettext.gettext;\nvar name = _(\"x\");\nlog(name);\n");
    assert.deepEqual(messages, []);
});
