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

export default [
    {
        files: ["files/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: gjsGlobals
        },
        rules: {
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
    {
        files: ["test/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: { ...gjsGlobals, __dirname: "readonly", Buffer: "readonly", process: "readonly" }
        },
        rules: {
            "no-unused-vars": ["error", { args: "none" }]
        }
    }
];
