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
const root = path.join(__dirname, "..");

async function rulesAt(filePath, code) {
    const eslint = new ESLint({ cwd: root });
    const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
    return result ? result.messages.map((message) => message.ruleId) : null;
}

async function rulesFor(code) {
    return rulesAt(applet, code);
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

// Every config object carries a `files` restriction, and the root-level config
// file matched none of them: the one file that defines the project's only static
// gate linted with an empty rule set, so an undefined identifier in it was
// unlintable.
test("the lint gate lints the root-level config file it is defined in", async () => {
    const rules = await rulesAt(path.join(root, "eslint.config.mjs"),
        "const unused = 1;\nexport default totallyUndefinedIdentifier;\n");
    assert.ok(rules.includes("no-undef"), `got ${JSON.stringify(rules)}`);
    assert.ok(rules.includes("no-unused-vars"), `got ${JSON.stringify(rules)}`);
});

test("CJS tooling receives correctness rules and runtime globals", async () => {
    const tooling = path.join(root, "scripts", "check_cjs_syntax.js");
    const rules = await rulesAt(tooling, "definitelyUndefined();\n");
    assert.ok(rules.includes("no-undef"), `got ${JSON.stringify(rules)}`);
    assert.deepEqual(await rulesAt(tooling,
        "print(imports.system.version);\nprinterr(new TextDecoder().decode());\n"), []);
});

// `eslint .` walks the packager's output, which ESLint cannot know is ignored:
// it reads `.gitignore` for nothing. Without an explicit ignore the run
// enumerates every shipped module a second time and reports the copy clean
// whatever it contains.
test("the lint gate ignores the packager's dist output", async () => {
    const eslint = new ESLint({ cwd: root });
    assert.equal(
        await eslint.isPathIgnored(
            path.join(root, "dist", "chronos@geraldo-netto", "files",
                "chronos@geraldo-netto", "utils.js")),
        true);
    assert.equal(await eslint.isPathIgnored(applet), false);
});
