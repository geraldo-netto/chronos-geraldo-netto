"""The ordinary Python lint gate uses the verified interpreter's syntax."""

import subprocess
import sys
import tempfile
from pathlib import Path
import unittest


class PythonRuntimeTests(unittest.TestCase):
    def lint_source(self, source):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "runtime_probe.py"
            path.write_text(source, encoding="utf-8")
            return subprocess.run([sys.executable, "-m", "pyflakes", str(path)],
                                  capture_output=True, text=True, check=False)

    def test_current_syntax_and_stdlib_are_accepted(self):
        result = self.lint_source(
            "from datetime import UTC\n"
            "import tomllib\n"
            "type Setting = str | None\n"
            "try:\n    print(tomllib.loads(''), UTC)\n"
            "except* ValueError:\n    pass\n")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_syntax_errors_still_fail_the_ordinary_gate(self):
        result = self.lint_source("def broken(:\n    pass\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid syntax", result.stderr)
