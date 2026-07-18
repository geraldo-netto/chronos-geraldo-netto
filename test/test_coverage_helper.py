import dis
import unittest
from types import SimpleNamespace

from helpers.coverage import branch_edges_for_code, instruction_line_map


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


if __name__ == "__main__":
    unittest.main()
