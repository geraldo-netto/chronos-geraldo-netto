import js from "@eslint/js";

// The applet runs under GJS (Cinnamon) and the tests under Node; both dialects
// live in this tree, so the config declares each set of globals where it applies.
const gjsGlobals = {
    imports: "readonly",
    global: "readonly",
    log: "readonly",
    logError: "readonly",
    _: "readonly",
    globalThis: "readonly",
    module: "writable",
    require: "readonly",
    // the applet asks whether it is running under Node — Cinnamon's cjs has no
    // `process`, and that is exactly what the question is for
    process: "readonly",
    TextDecoder: "readonly",
    TextEncoder: "readonly",
    Date: "readonly",
    Math: "readonly",
    JSON: "readonly",
    Map: "readonly",
    Set: "readonly",
    Number: "readonly",
    Object: "readonly",
    Array: "readonly",
    String: "readonly",
    Boolean: "readonly",
    Error: "readonly",
    Promise: "readonly",
    console: "readonly"
};

// Every config object below carries a `files` restriction, and ESLint applies
// no rules to a file no object matches. `dist/` is the packager's own output —
// a copy of `files/`, invisible to ESLint because it only reads `.gitignore`
// for its default patterns — so without this the run lints it twice and reports
// it clean whatever it contains.
const IGNORED = { ignores: ["dist/**"] };

// The recommended set, the module dialect and the Node globals are the same for
// `scripts/**/*.mjs` and for the root-level `.mjs` files (this config among
// them, which no `files` entry used to match: it linted with zero rules).
function nodeModuleConfig(files) {
    return {
        files,
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: { process: "readonly" }
        },
        rules: {
            ...js.configs.recommended.rules,
            "no-unused-vars": ["error", { args: "none" }]
        }
    };
}

export default [
    IGNORED,
    {
        files: ["files/**/*.js"],
        // The config used to list three rules and extend nothing, so unreachable
        // code, a duplicate object key and `if (o = 3)` all linted clean: the one
        // static gate in the project caught almost no correctness bug. The
        // recommended set is what makes it a gate; the rules below it are the
        // deliberate exceptions this dialect needs.
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: gjsGlobals
        },
        rules: {
            ...js.configs.recommended.rules,
            // Duplicate declarations still error; redeclaring a *global* does not.
            // Every module opens with `/* global imports */` — its own record of
            // the dialect it is read in — and the GJS files that bind gettext own
            // a module-level `_`. Both are the config's globals, not real
            // redeclarations, and both are deliberate.
            "no-redeclare": ["error", { builtinGlobals: false }],
            "no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_" }],
            "no-undef": "error",
            // A shadowed name is one rename away from a live bug: the async
            // callbacks in this tree take a `source` that used to be called
            // `session`, and it only worked because the two were the same
            // object. Nothing warned.
            "no-shadow": "error",
            "no-var": "off",
            camelcase: "off",
            eqeqeq: "off",
            "prefer-const": "off"
        }
    },
    nodeModuleConfig(["scripts/**/*.mjs"]),
    nodeModuleConfig(["*.mjs"]),
    {
        files: ["test/**/*.js"],
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: { ...gjsGlobals, __dirname: "readonly", Buffer: "readonly", process: "readonly" }
        },
        rules: {
            ...js.configs.recommended.rules,
            "no-unused-vars": ["error", { args: "none" }]
        }
    }
];
