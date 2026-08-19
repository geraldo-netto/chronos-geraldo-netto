#!/usr/bin/python3

# Cinnamon Chronos — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Reject shipped settings code Python 3.10 cannot parse or does not have.

Two checks, and neither is a substitute for running the suite on a real 3.10
interpreter. `ast.parse(feature_version=(3, 10))` constrains a handful of
grammar decisions and sees no runtime API use at all; the symbol table below
covers the newer stdlib names this project is plausibly reaching for, and
nothing more. The success line says exactly that.
"""

import ast
from pathlib import Path


RUNTIME_PYTHON = (3, 10)
RUNTIME_PYTHON_TEXT = ".".join(str(part) for part in RUNTIME_PYTHON)
PROJECT_ROOT = Path(__file__).resolve().parents[1]
APPLET_ROOT = PROJECT_ROOT / "files" / "chronos@geraldo-netto"


def python_sources(root):
    return sorted(
        path for path in root.rglob("*.py")
        if "__pycache__" not in path.parts
    )


def compatibility_error(source, filename="<string>", feature_version=RUNTIME_PYTHON):
    try:
        ast.parse(source, filename=filename, feature_version=feature_version)
    except SyntaxError as error:
        return error
    return None


def compatibility_errors(paths, feature_version=RUNTIME_PYTHON):
    errors = []
    for path in paths:
        error = compatibility_error(
            path.read_text(encoding="utf-8"), str(path), feature_version)
        if error is not None:
            errors.append(error)
    return errors


# Stdlib names a 3.10 parser accepts and a 3.10 interpreter does not have.
# `import tomllib` and `datetime.UTC` are syntactically ordinary, so the parse
# gate passes them and the declared floor raises ModuleNotFoundError or
# AttributeError at runtime. This is a list of the newer names worth naming,
# not an index of the stdlib.
MODULES_AFTER_RUNTIME = {
    "tomllib": "3.11",
}
MEMBERS_AFTER_RUNTIME = {
    ("asyncio", "TaskGroup"): "3.11",
    ("datetime", "UTC"): "3.11",
    ("enum", "ReprEnum"): "3.11",
    ("enum", "StrEnum"): "3.11",
    ("hashlib", "file_digest"): "3.11",
    ("itertools", "batched"): "3.12",
    ("math", "cbrt"): "3.11",
    ("math", "exp2"): "3.11",
    ("typing", "LiteralString"): "3.11",
    ("typing", "Never"): "3.11",
    ("typing", "Self"): "3.11",
    ("typing", "TypeAliasType"): "3.12",
    ("typing", "override"): "3.12",
}
BUILTINS_AFTER_RUNTIME = {
    "BaseExceptionGroup": "3.11",
    "ExceptionGroup": "3.11",
}


def _import_symbol(node):
    for alias in node.names:
        version = MODULES_AFTER_RUNTIME.get(alias.name.split(".")[0])
        if version is not None:
            return (alias.name, version)
    return None


def _import_from_symbol(node):
    module = (node.module or "").split(".")[0]
    version = MODULES_AFTER_RUNTIME.get(module)
    if version is not None:
        return (module, version)
    for alias in node.names:
        member = MEMBERS_AFTER_RUNTIME.get((module, alias.name))
        if member is not None:
            return (f"{module}.{alias.name}", member)
    return None


def _attribute_symbol(node):
    if not isinstance(node.value, ast.Name):
        return None
    version = MEMBERS_AFTER_RUNTIME.get((node.value.id, node.attr))
    return None if version is None else (f"{node.value.id}.{node.attr}", version)


def _name_symbol(node):
    version = BUILTINS_AFTER_RUNTIME.get(node.id)
    return None if version is None else (node.id, version)


_SYMBOL_CHECKS = (
    (ast.Import, _import_symbol),
    (ast.ImportFrom, _import_from_symbol),
    (ast.Attribute, _attribute_symbol),
    (ast.Name, _name_symbol),
)


def node_symbol(node):
    """The newer-than-runtime symbol this node names, or None."""
    for node_type, check in _SYMBOL_CHECKS:
        if isinstance(node, node_type):
            return check(node)
    return None


def runtime_symbol_errors(source, filename="<string>"):
    """Every reference in `source` to a stdlib name newer than the floor."""
    messages = []
    for node in ast.walk(ast.parse(source, filename=filename)):
        found = node_symbol(node)
        if found is not None:
            name, version = found
            messages.append(
                f"{filename}:{node.lineno}:{node.col_offset}: {name} needs "
                f"Python {version}; the declared floor is {RUNTIME_PYTHON_TEXT}")
    return messages


def main():
    paths = python_sources(APPLET_ROOT)
    messages = [
        f"{error.filename}:{error.lineno}:{error.offset}: {error.msg}"
        for error in compatibility_errors(paths)
    ]
    if not messages:
        # only once every file parses: walking a tree needs one
        for path in paths:
            messages.extend(
                runtime_symbol_errors(path.read_text(encoding="utf-8"), str(path)))

    for message in messages:
        print(message)
    if messages:
        return 1

    # Syntax and a name list, and it says so: `ast.parse(feature_version=...)`
    # cannot see runtime API use, and the table above is not the whole stdlib.
    # Running the suite on a real 3.10 interpreter is the only complete check.
    print(f"Python {RUNTIME_PYTHON_TEXT} syntax only: {len(paths)} shipped files "
          f"parse, and none names a stdlib symbol newer than {RUNTIME_PYTHON_TEXT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
