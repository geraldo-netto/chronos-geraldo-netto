import dis
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from helpers.coverage import (
    branch_edges_for_code,
    discover_python_tests,
    gate_failures,
    instruction_line_map,
    load_test_suite,
    measurable_code_objects,
)


class CoverageGateTests(unittest.TestCase):
    def test_coverage_floors_accept_80_percent(self):
        coverage = {
            "shown": Path("sample.py"),
            "line_percent": 80.0,
            "branch_percent": 80.0,
            "function_percent": 80.0,
        }

        self.assertEqual(gate_failures(coverage), [])
        for metric, label in (
            ("line", "lines"),
            ("branch", "branches"),
            ("function", "functions"),
        ):
            coverage[f"{metric}_percent"] = 79.99
            self.assertEqual(
                gate_failures(coverage),
                [f"sample.py: 79.99 % {label} is under the 80.0 % gate"],
            )
            coverage[f"{metric}_percent"] = 80.0


class CoverageInstructionLineTests(unittest.TestCase):
    def test_starts_line_is_carried_on_python_before_311(self):
        instructions = [
            SimpleNamespace(offset=0, starts_line=10),
            SimpleNamespace(offset=2, starts_line=None),
            SimpleNamespace(offset=4, starts_line=12),
        ]

        self.assertEqual(instruction_line_map(instructions), {0: 10, 2: 10, 4: 12})

    def test_position_lines_take_precedence_when_available(self):
        instructions = [
            SimpleNamespace(
                offset=0, starts_line=10, positions=SimpleNamespace(lineno=11)),
            SimpleNamespace(
                offset=2, starts_line=None, positions=SimpleNamespace(lineno=11)),
        ]

        self.assertEqual(instruction_line_map(instructions), {0: 11, 2: 11})

    def test_extended_jump_prefix_is_the_traced_branch_source(self):
        jump_name = next(name for name in dis.opmap if "JUMP" in name and "IF_FALSE" in name)
        instructions = [
            SimpleNamespace(offset=0, opname="EXTENDED_ARG",
                            opcode=dis.opmap["EXTENDED_ARG"], argval=1),
            SimpleNamespace(offset=2, opname=jump_name,
                            opcode=dis.opmap[jump_name], argval=8),
            SimpleNamespace(offset=4, opname="LOAD_CONST",
                            opcode=dis.opmap["LOAD_CONST"], argval=None),
        ]
        code = SimpleNamespace(co_qualname="example", co_name="example", co_firstlineno=1)

        self.assertEqual(
            set(branch_edges_for_code(code, instructions)),
            {(("example", 1), 0, 8), (("example", 1), 0, 4)},
        )

    def test_python_314_not_taken_marker_is_not_a_branch_destination(self):
        jump_name = next(name for name in dis.opmap if "JUMP" in name and "IF_FALSE" in name)
        instructions = [
            SimpleNamespace(offset=0, opname=jump_name,
                            opcode=dis.opmap[jump_name], argval=8),
            SimpleNamespace(offset=2, opname="NOT_TAKEN", opcode=-1, argval=None),
            SimpleNamespace(offset=4, opname="LOAD_CONST",
                            opcode=dis.opmap["LOAD_CONST"], argval=None),
        ]
        code = SimpleNamespace(co_qualname="example", co_name="example", co_firstlineno=1)

        self.assertEqual(
            set(branch_edges_for_code(code, instructions)),
            {(("example", 1), 0, 8), (("example", 1), 0, 4)},
        )

    def test_python_314_annotation_helpers_are_not_source_functions(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "annotations.py"
            path.write_text(
                "def __annotate__():\n"
                "    return {'value': int}\n"
                "def source_function():\n"
                "    return 1\n",
                encoding="utf8",
            )

            names = {code.co_name for code in measurable_code_objects(path)}

        self.assertNotIn("__annotate__", names)
        self.assertIn("source_function", names)


class RecursiveDiscoveryTests(unittest.TestCase):
    def test_nested_python_tests_are_discovered_and_executed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            nested = root / "widgets"
            nested.mkdir()
            test_path = nested / "test_nested.py"
            test_path.write_text(
                "import unittest\n"
                "class NestedTest(unittest.TestCase):\n"
                "    def test_sentinel(self):\n"
                "        self.assertTrue(True)\n",
                encoding="utf8",
            )
            (nested / "helper.py").write_text(
                "raise RuntimeError('must not load')\n", encoding="utf8")

            self.assertEqual(discover_python_tests(root), [test_path])
            result = unittest.TextTestRunner(stream=io.StringIO()).run(
                load_test_suite(root))
            self.assertTrue(result.wasSuccessful())
            self.assertEqual(result.testsRun, 1)


if __name__ == "__main__":
    unittest.main()
