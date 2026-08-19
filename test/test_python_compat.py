#!/usr/bin/python3

# Cinnamon Chronos — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
#
# SPDX-License-Identifier: GPL-2.0-or-later

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = PROJECT_ROOT / "scripts" / "check_python_compat.py"
SPEC = spec_from_file_location("check_python_compat", MODULE_PATH)
COMPAT = module_from_spec(SPEC)
SPEC.loader.exec_module(COMPAT)


class PythonCompatibilityTests(unittest.TestCase):
    def test_every_shipped_python_file_parses_as_python_310(self):
        paths = COMPAT.python_sources(COMPAT.APPLET_ROOT)

        self.assertTrue(paths)
        self.assertEqual(COMPAT.compatibility_errors(paths), [])
        self.assertEqual(COMPAT.RUNTIME_PYTHON, (3, 10))

    def test_python_311_only_syntax_is_rejected(self):
        source = "try:\n    pass\nexcept* ValueError:\n    pass\n"

        error = COMPAT.compatibility_error(source, "new-syntax.py")

        self.assertIsInstance(error, SyntaxError)
        self.assertEqual(error.filename, "new-syntax.py")

    # T1026: the parse gate constrains a handful of grammar decisions and sees
    # no runtime API use at all, so `datetime.UTC`, `tomllib` and
    # `itertools.batched` all parsed clean and would have failed on the floor.
    def test_symbols_newer_than_the_floor_are_rejected(self):
        cases = {
            "import tomllib\n": "tomllib",
            "import tomllib.parser\n": "tomllib",
            "from tomllib import loads\n": "tomllib",
            "from datetime import UTC\n": "datetime.UTC",
            "import datetime\nstamp = datetime.UTC\n": "datetime.UTC",
            "from typing import Self\n": "typing.Self",
            "import itertools\nrows = itertools.batched([], 2)\n": "itertools.batched",
            "raise ExceptionGroup('x', [])\n": "ExceptionGroup",
        }

        for source, name in cases.items():
            messages = COMPAT.runtime_symbol_errors(source, "shipped.py")

            self.assertEqual(len(messages), 1, source)
            self.assertIn(name, messages[0])
            self.assertIn("the declared floor is 3.10", messages[0])

    def test_symbols_the_floor_already_has_are_accepted(self):
        source = (
            "import datetime\n"
            "from typing import Optional\n"
            "from pathlib import Path\n"
            "stamp = datetime.timezone.utc\n"
            "value: Optional[str] = None\n"
            "here = Path('.').resolve()\n"
        )

        self.assertEqual(COMPAT.runtime_symbol_errors(source, "shipped.py"), [])

    def test_no_shipped_file_names_a_symbol_newer_than_the_floor(self):
        for path in COMPAT.python_sources(COMPAT.APPLET_ROOT):
            self.assertEqual(
                COMPAT.runtime_symbol_errors(
                    path.read_text(encoding="utf-8"), str(path)), [])

    # ...and the success line says what was checked. It used to read
    # "Python 3.10 syntax: N shipped files", which claims the whole floor.
    def test_the_success_line_claims_only_what_was_checked(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            status = COMPAT.main()

        self.assertEqual(status, 0)
        self.assertIn("syntax only", buffer.getvalue())

    def test_source_discovery_ignores_cache_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shipped = root / "settings.py"
            cached = root / "__pycache__" / "generated.py"
            cached.parent.mkdir()
            shipped.write_text("value = 1\n", encoding="utf-8")
            cached.write_text("value = 2\n", encoding="utf-8")

            self.assertEqual(COMPAT.python_sources(root), [shipped])


if __name__ == "__main__":
    unittest.main()
