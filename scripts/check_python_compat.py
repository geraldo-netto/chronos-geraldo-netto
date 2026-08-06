#!/usr/bin/python3

# Cinnamon Chronos — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Reject shipped settings code that Python 3.10 cannot parse."""

import ast
from pathlib import Path


RUNTIME_PYTHON = (3, 10)
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


def main():
    paths = python_sources(APPLET_ROOT)
    errors = compatibility_errors(paths)
    for error in errors:
        print(f"{error.filename}:{error.lineno}:{error.offset}: {error.msg}")
    if errors:
        return 1
    print(f"Python 3.10 syntax: {len(paths)} shipped files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
