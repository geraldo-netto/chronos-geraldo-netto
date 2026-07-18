#!/usr/bin/python3

from pathlib import Path
import unittest

from helpers.python_cognitive import (
    complexity_offenders,
    function_complexities,
)


ROOT = Path(__file__).resolve().parent.parent
APPLET_DIR = ROOT / "files" / "chronos@geraldo-netto"
TEST_DIR = ROOT / "test"
# The documented ceiling is 10, so 11 is the first rejected score.
FORBIDDEN_COGNITIVE_COMPLEXITY = 11


def python_sources():
    sources = list(APPLET_DIR.rglob("*.py"))
    sources.extend(TEST_DIR.rglob("*.py"))
    return sorted(
        path for path in sources
        if "__pycache__" not in path.parts
    )


class PythonComplexityGateTest(unittest.TestCase):
    def test_every_python_function_stays_below_the_forbidden_line(self):
        offenders = complexity_offenders(
            python_sources(),
            FORBIDDEN_COGNITIVE_COMPLEXITY,
        )

        self.assertEqual(
            offenders,
            [],
            "extract nested decisions into named helpers:\n  " +
            "\n  ".join(offenders),
        )

    def test_the_gate_rejects_an_injected_named_helper(self):
        source = """
def hidden(value):
    if value:
        for item in value:
            if item:
                while item:
                    return item
    if value:
        return value
"""

        self.assertEqual(
            complexity_offenders(
                ["test/injected_helper.py"],
                FORBIDDEN_COGNITIVE_COMPLEXITY,
                read=lambda _path: source,
            ),
            ["test/injected_helper.py:2 — 11 — hidden"],
        )

    def test_the_walker_keeps_elif_flat_and_counts_boolean_sequences(self):
        source = """
def choose(a, b, c):
    if a and b:
        return 1
    elif a or c:
        return 2
    else:
        return 3
"""

        self.assertEqual(
            function_complexities(source),
            [(2, "choose", 5)],
        )


if __name__ == "__main__":
    unittest.main()
