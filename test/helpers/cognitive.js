// Cognitive complexity, as SonarSource defines it: how hard a function is to
// follow, not how many paths it has. Every break in the linear flow costs 1, and
// a break *inside* nesting costs 1 more per level of nesting it sits under — so
// three ifs in a row cost 3, but an if inside an if inside a loop costs 6.
//
// The audit that found the five over-limit test bodies ran a walker like this one
// by hand. Hand-run means it drifts, so it lives here and the suite runs it.
//
// espree is a direct development dependency because this helper imports it.
const espree = require("espree");

const PARSE_OPTIONS = { ecmaVersion: 2022, sourceType: "script", loc: true };

// the structures that both cost and nest
const NESTING = new Set([
    "IfStatement", "ForStatement", "ForInStatement", "ForOfStatement",
    "WhileStatement", "DoWhileStatement", "SwitchStatement", "CatchClause",
    "ConditionalExpression"
]);

// a function boundary raises the nesting for what is inside it, but the function
// itself is scored on its own
const FUNCTIONS = new Set([
    "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"
]);

const NON_CHILD_KEYS = new Set(["parent", "loc", "range"]);

function childValueNodes(value) {
    if (Array.isArray(value)) {
        return value.filter((entry) => entry && typeof entry.type === "string");
    }
    return value && typeof value.type === "string" ? [value] : [];
}

function childNodes(node) {
    return Object.entries(node)
        .filter(([key]) => !NON_CHILD_KEYS.has(key))
        .flatMap(([, value]) => childValueNodes(value));
}

// `a && b && c` is one sequence, and costs 1; `a && b || c` alternates and costs 2
function logicalCost(node, parentOperator) {
    return node.operator === parentOperator ? 0 : 1;
}

function directCost(node, nesting, parentLogical) {
    switch (node.type) {
    case "IfStatement":
        return 1 + nesting +
            (node.alternate && node.alternate.type !== "IfStatement" ? 1 : 0);
    case "LogicalExpression":
        return logicalCost(node, parentLogical);
    case "BreakStatement":
    case "ContinueStatement":
        // only a labelled jump breaks the flow enough to count
        return node.label ? 1 : 0;
    default:
        return NESTING.has(node.type) ? 1 + nesting : 0;
    }
}

function childNesting(node, child, nesting) {
    // an `else if` continues the chain rather than nesting inside it
    if (node.type === "IfStatement" && child === node.alternate &&
        child.type === "IfStatement") {
        return nesting;
    }
    return NESTING.has(node.type) || FUNCTIONS.has(node.type) ? nesting + 1 : nesting;
}

function score(node, nesting, parentLogical) {
    let cost = directCost(node, nesting, parentLogical);
    const logical = node.type === "LogicalExpression" ? node.operator : null;
    for (const child of childNodes(node)) {
        cost += score(child, childNesting(node, child, nesting), logical);
    }
    return cost;
}

// The complexity of a function body, counted from inside it: the function itself
// costs nothing, what it does costs.
function complexityOf(functionNode) {
    let cost = 0;
    for (const parameter of functionNode.params) {
        cost += score(parameter, 0, null);
    }
    for (const child of childNodes(functionNode.body)) {
        cost += score(child, 0, null);
    }

    return cost;
}

function isTestCallee(callee) {
    if (callee.type === "Identifier") {
        return callee.name === "test";
    }
    if (callee.type !== "MemberExpression" || callee.computed ||
        callee.object.type !== "Identifier" || callee.property.type !== "Identifier") {
        return false;
    }
    return callee.object.name === "test" || callee.property.name === "test";
}

// Every test(...), test.skip(...), test.only(...) and t.test(...) body in a file,
// with the name it was given.
function testBodies(source) {
    const tree = espree.parse(source, PARSE_OPTIONS);
    const found = [];

    const visit = (node) => {
        if (node.type === "CallExpression" && isTestCallee(node.callee) &&
            node.arguments.length >= 2 &&
            node.arguments[0].type === "Literal" &&
            FUNCTIONS.has(node.arguments[1].type)) {
            found.push({
                name: node.arguments[0].value,
                line: node.loc.start.line,
                complexity: complexityOf(node.arguments[1])
            });
        }

        childNodes(node).forEach(visit);
    };

    visit(tree);
    return found;
}

// Every function, method and closure a source file declares, with the complexity
// of each — the production counterpart of testBodies. A method is scored whole,
// so the closures inside it count towards it and are not also reported alone:
// that is what makes an eight-arm table of arrow steps read as one function, and
// it is the number the limit is about.
function functionBodies(source, sourceType = "script") {
    const tree = espree.parse(source, { ...PARSE_OPTIONS, sourceType });
    const found = [];

    const visit = (node, parent) => {
        const isMethod = node.type === "MethodDefinition" || node.type === "PropertyDefinition";
        const target = isMethod ? node.value : node;

        if ((isMethod && target && FUNCTIONS.has(target.type)) || FUNCTIONS.has(node.type)) {
            found.push({
                name: nameOf(node, parent),
                line: node.loc.start.line,
                complexity: complexityOf(target)
            });

            // scored whole: what is inside it is part of it
            return;
        }

        childNodes(node).forEach((child) => visit(child, node));
    };

    visit(tree, null);
    return found;
}

function nameOf(node, parent) {
    if (node.id && node.id.name) { // NOSONAR [S6582] -- deliberate test seam
        return node.id.name;
    }
    if (node.key && node.key.name) { // NOSONAR [S6582] -- deliberate test seam
        return node.key.name;
    }
    if (parent && parent.type === "VariableDeclarator" && parent.id && parent.id.name) { // NOSONAR [S6582] -- deliberate test seam
        return parent.id.name;
    }
    if (parent && parent.type === "Property" && parent.key && parent.key.name) { // NOSONAR [S6582] -- deliberate test seam
        return parent.key.name;
    }

    return "<anonymous>";
}

module.exports = { complexityOf, testBodies, functionBodies, PARSE_OPTIONS };
