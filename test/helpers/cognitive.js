// Cognitive complexity, as SonarSource defines it: how hard a function is to
// follow, not how many paths it has. Every break in the linear flow costs 1, and
// a break *inside* nesting costs 1 more per level of nesting it sits under — so
// three ifs in a row cost 3, but an if inside an if inside a loop costs 6.
//
// The audit that found the five over-limit test bodies ran a walker like this one
// by hand. Hand-run means it drifts, so it lives here and the suite runs it.
//
// espree is eslint's parser, so it is already installed.
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

function childNodes(node) {
    const children = [];
    for (const key of Object.keys(node)) {
        if (key === "parent" || key === "loc" || key === "range") {
            continue;
        }

        const value = node[key];
        if (Array.isArray(value)) {
            value.forEach((entry) => {
                if (entry && typeof entry.type === "string") {
                    children.push(entry);
                }
            });
        } else if (value && typeof value.type === "string") {
            children.push(value);
        }
    }

    return children;
}

// `a && b && c` is one sequence, and costs 1; `a && b || c` alternates and costs 2
function logicalCost(node, parentOperator) {
    return node.operator === parentOperator ? 0 : 1;
}

function score(node, nesting, parentLogical) {
    let cost = 0;

    if (node.type === "IfStatement") {
        cost += 1 + nesting;
        // `else if` is not nested under the `if` it follows: it is a continuation
        if (node.alternate && node.alternate.type !== "IfStatement") {
            cost += 1;
        }
    } else if (NESTING.has(node.type)) {
        cost += 1 + nesting;
    } else if (node.type === "LogicalExpression") {
        cost += logicalCost(node, parentLogical);
    } else if (node.type === "BreakStatement" || node.type === "ContinueStatement") {
        // only a labelled jump breaks the flow enough to count
        cost += node.label ? 1 : 0;
    }

    const inner = NESTING.has(node.type) || FUNCTIONS.has(node.type) ? nesting + 1 : nesting;
    const logical = node.type === "LogicalExpression" ? node.operator : null;

    for (const child of childNodes(node)) {
        // an `else if` continues the chain rather than nesting inside it
        const childNesting = node.type === "IfStatement" && child === node.alternate &&
            child.type === "IfStatement" ? nesting : inner;
        cost += score(child, childNesting, logical);
    }

    return cost;
}

// The complexity of a function body, counted from inside it: the function itself
// costs nothing, what it does costs.
function complexityOf(functionNode) {
    let cost = 0;
    for (const child of childNodes(functionNode.body)) {
        cost += score(child, 0, null);
    }

    return cost;
}

// Every test(...) body in a file, with the name it was given.
function testBodies(source) {
    const tree = espree.parse(source, PARSE_OPTIONS);
    const found = [];

    const visit = (node) => {
        if (node.type === "CallExpression" && node.callee.type === "Identifier" &&
            node.callee.name === "test" && node.arguments.length >= 2 &&
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

module.exports = { complexityOf, testBodies, PARSE_OPTIONS };
