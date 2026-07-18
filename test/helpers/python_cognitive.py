"""Small dependency-free cognitive-complexity walker for Python gates."""

import ast
from pathlib import Path


FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
LOOP_NODES = (ast.For, ast.AsyncFor, ast.While)
COMPREHENSION_NODES = (
    ast.ListComp,
    ast.SetComp,
    ast.DictComp,
    ast.GeneratorExp,
)


def _score_sequence(nodes, nesting):
    return sum(_score_node(node, nesting) for node in nodes)


def _score_default(node, nesting, _parent_bool):
    if isinstance(node, FUNCTION_NODES + (ast.ClassDef,)):
        return 0
    return _score_sequence(ast.iter_child_nodes(node), nesting)


def _score_if(node, nesting, _parent_bool):
    cost = 1 + nesting
    cost += _score_node(node.test, nesting)
    cost += _score_sequence(node.body, nesting + 1)
    if len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
        return cost + _score_if(node.orelse[0], nesting, None)
    if node.orelse:
        cost += 1 + _score_sequence(node.orelse, nesting + 1)
    return cost


def _score_loop(node, nesting, _parent_bool):
    cost = 1 + nesting
    for child in (getattr(node, "target", None),
                  getattr(node, "iter", None),
                  getattr(node, "test", None)):
        if child is not None:
            cost += _score_node(child, nesting)
    cost += _score_sequence(node.body, nesting + 1)
    if node.orelse:
        cost += 1 + _score_sequence(node.orelse, nesting + 1)
    return cost


def _score_if_expression(node, nesting, _parent_bool):
    return (
        1 + nesting +
        _score_node(node.test, nesting) +
        _score_node(node.body, nesting + 1) +
        _score_node(node.orelse, nesting + 1)
    )


def _score_bool(node, nesting, parent_bool):
    operator = type(node.op)
    cost = 0 if operator is parent_bool else 1
    return cost + sum(
        _score_node(value, nesting, operator) for value in node.values)


def _score_try(node, nesting, _parent_bool):
    cost = _score_sequence(node.body, nesting)
    for handler in node.handlers:
        cost += 1 + nesting
        cost += _score_sequence(handler.body, nesting + 1)
    return cost + _score_sequence(node.orelse + node.finalbody, nesting)


def _score_comprehension(node, nesting, _parent_bool):
    cost = 0
    inner = nesting
    for generator in node.generators:
        cost += 1 + inner
        inner += 1
        cost += _score_node(generator.iter, nesting)
        cost += _score_sequence(generator.ifs, inner)
    return cost + _score_sequence(
        [child for child in ast.iter_child_nodes(node)
         if not isinstance(child, ast.comprehension)],
        inner,
    )


def _score_match(node, nesting, _parent_bool):
    cost = 1 + nesting + _score_node(node.subject, nesting)
    for case in node.cases:
        if case.guard is not None:
            cost += _score_node(case.guard, nesting + 1)
        cost += _score_sequence(case.body, nesting + 1)
    return cost


SCORERS = {
    ast.If: _score_if,
    ast.For: _score_loop,
    ast.AsyncFor: _score_loop,
    ast.While: _score_loop,
    ast.IfExp: _score_if_expression,
    ast.BoolOp: _score_bool,
    ast.Try: _score_try,
}
for node_type in COMPREHENSION_NODES:
    SCORERS[node_type] = _score_comprehension
if hasattr(ast, "Match"):
    SCORERS[ast.Match] = _score_match


def _score_node(node, nesting=0, parent_bool=None):
    scorer = SCORERS.get(type(node), _score_default)
    return scorer(node, nesting, parent_bool)


def cognitive_complexity(function_node):
    defaults = list(function_node.args.defaults)
    defaults.extend(
        default for default in function_node.args.kw_defaults
        if default is not None
    )
    if isinstance(function_node, ast.Lambda):
        return _score_sequence(defaults, 0) + _score_node(function_node.body)
    return _score_sequence(defaults + function_node.body, 0)


def function_complexities(source, filename="<string>"):
    tree = ast.parse(source, filename=filename)
    findings = []
    for node in ast.walk(tree):
        if isinstance(node, FUNCTION_NODES):
            name = getattr(node, "name", "<lambda>")
            findings.append(
                (node.lineno, name, cognitive_complexity(node)))
    return sorted(findings)


def complexity_offenders(paths, forbidden=15, read=None):
    reader = read or (lambda item: Path(item).read_text(encoding="utf-8"))
    offenders = []
    for source_path in paths:
        source = reader(source_path)
        for line, name, complexity in function_complexities(
                source, filename=str(source_path)):
            if complexity >= forbidden:
                offenders.append(
                    f"{source_path}:{line} — {complexity} — {name}")
    return offenders
