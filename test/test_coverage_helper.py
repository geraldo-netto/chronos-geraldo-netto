import unittest
from types import SimpleNamespace

from helpers.coverage import instruction_line_map


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


if __name__ == "__main__":
    unittest.main()
