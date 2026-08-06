#!/usr/bin/python3

# Cinnamon Chronos — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
#
# SPDX-License-Identifier: GPL-2.0-or-later

import tempfile
import unittest
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
