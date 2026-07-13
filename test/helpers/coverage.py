#!/usr/bin/python3
"""Line coverage for the Python half, with no third-party dependency.

The JS suite has carried coverage thresholds all along; the Python suite — which
is the whole settings dialog, including a parser fed by user-typed text — had
none, and "99 % covered" in the README described half the shipped code. coverage
.py is the obvious tool and it is not installable everywhere (PEP 668 externally
managed environments), so this uses what the standard library already offers:
sys.settrace for the lines that ran, and the compiled code objects for the lines
that could have.

Run it the way the suite runs: python3 test/helpers/coverage.py
"""

from __future__ import annotations

import dis
import sys
import types
import unittest
from pathlib import Path

APPLET_DIR = Path(__file__).resolve().parent.parent.parent
SOURCES = sorted((APPLET_DIR / "files" / "chronos@geraldo-netto").rglob("*.py"))

# The dialog is the user-facing half and is held to the JS suite's line gate.
# The 5.4 shim is three lines of sys.path plumbing and is measured with it — it
# lives in a subdirectory, and the glob here was non-recursive, so the one file
# Cinnamon's create_custom_widget actually loads was the one file the gate did
# not look at, while the comment above claimed it did.
LINE_THRESHOLD = 98.0


def executable_lines(path: Path) -> set[int]:
    """Every line the interpreter could stop on, from the compiled code."""
    code = compile(path.read_text(encoding="utf8"), str(path), "exec")
    lines: set[int] = set()
    pending = [code]

    while pending:
        current = pending.pop()
        for _, line in dis.findlinestarts(current):
            if line is not None:
                lines.add(line)
        for constant in current.co_consts:
            if isinstance(constant, types.CodeType):
                pending.append(constant)

    # 3.12 emits a line 0 for the module code object's implicit RESUME. It is not
    # a line anyone can execute or cover, and on an eight-line file it is an eighth
    # of the score.
    lines.discard(0)

    return lines


def main() -> int:
    watched = {str(path): path for path in SOURCES}
    executed: dict[str, set[int]] = {name: set() for name in watched}

    def trace(frame, event, _arg):
        filename = frame.f_code.co_filename
        if filename in executed:
            if event == "line":
                executed[filename].add(frame.f_lineno)
            return trace
        return None

    loader = unittest.TestLoader()
    suite = loader.discover(str(APPLET_DIR / "test"), pattern="*.py")

    sys.settrace(trace)
    try:
        result = unittest.TextTestRunner(verbosity=1).run(suite)
    finally:
        sys.settrace(None)

    if not result.wasSuccessful():
        return 1

    print()
    failures = []
    for name, path in watched.items():
        can_run = executable_lines(path)
        # the import-time lines run before the tracer is installed; the module is
        # already imported by the test harness, so count only what can be reached
        # from a test
        did_run = executed[name] & can_run
        percent = 100.0 * len(did_run) / len(can_run) if can_run else 100.0

        missed = sorted(can_run - did_run)
        shown = path.relative_to(APPLET_DIR / "files" / "chronos@geraldo-netto")
        print(f"{str(shown):32} {percent:6.2f} %  ({len(did_run)}/{len(can_run)})")
        if missed:
            print(f"{'':32} missed: {', '.join(str(line) for line in missed[:12])}"
                  + (" …" if len(missed) > 12 else ""))

        if percent + 1e-9 < LINE_THRESHOLD:
            failures.append(f"{shown}: {percent:.2f} % is under the {LINE_THRESHOLD} % gate")

    if failures:
        print("\npython coverage below the gate:\n")
        for failure in failures:
            print("  " + failure)
        return 1

    print(f"\npython coverage: every file meets {LINE_THRESHOLD} % lines")
    return 0


if __name__ == "__main__":
    sys.exit(main())
