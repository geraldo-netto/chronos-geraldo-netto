"""Native settings runner isolation, fixture dispatch, and private GTK regressions."""

import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/check_gtk_settings.py"
SPEC = importlib.util.spec_from_file_location("native_settings_test", SCRIPT)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class NativeSettingsHarnessTests(unittest.TestCase):
    def test_memory_backend_copies_input_and_notifies_only_the_changed_key(self):
        raw = [{"label": "Paris"}]
        settings = CHECK.MemorySettings({"clocks": {"columns": []}}, "clocks", raw)
        settings.get_value("clocks").append({"label": "Tokyo"})
        self.assertEqual(len(raw), 1)
        changed, other = mock.Mock(), mock.Mock()
        settings.listen("clocks", changed)
        settings.listen("other", other)
        settings.set_value("clocks", [])
        changed.assert_called_once_with("clocks", [])
        other.assert_not_called()
        self.assertEqual(settings.writes, [("clocks", [])])
        self.assertTrue(settings.has_property("clocks", "columns"))
        self.assertFalse(settings.has_property("clocks", "unknown"))
        self.assertTrue(settings.has_key("clocks"))
        self.assertFalse(settings.has_key("unknown"))
        self.assertEqual(settings.get_property("clocks", "columns"), [])

    def test_child_verifies_isolation_before_importing_native_widgets(self):
        with mock.patch.object(CHECK, "verify_isolation", side_effect=RuntimeError("shared display")), \
                mock.patch.object(CHECK, "load_widgets") as load:
            with self.assertRaisesRegex(RuntimeError, "shared display"):
                CHECK.run_isolated(Path("/private"))
        load.assert_not_called()

    def test_fixture_dispatch_covers_unicode_weather_country_and_clock_neighbors(self):
        with mock.patch.object(CHECK, "verify_isolation"), \
                mock.patch.object(CHECK, "load_widgets", return_value=("weather", "country", "clocks")), \
                mock.patch.object(CHECK, "check_weather") as weather, \
                mock.patch.object(CHECK, "check_country") as country, \
                mock.patch.object(CHECK, "check_teardown") as teardown, \
                mock.patch.object(CHECK, "check_plugin_filenames", return_value=6) as filenames, \
                mock.patch.object(CHECK, "check_import_status_widths", return_value=2) as import_widths, \
                mock.patch.object(CHECK, "check_country_dialog_types", return_value=21) as country_types, \
                mock.patch.object(CHECK, "check_clocks") as clocks, redirect_stdout(io.StringIO()):
            self.assertEqual(CHECK.run_isolated(Path("/private")), 0)
        self.assertEqual(weather.call_count, 22)
        self.assertEqual(country.call_count, 8)
        self.assertTrue(all(not call.args[2]["valid"] for call in country.call_args_list))
        self.assertEqual(clocks.call_count, 2)
        self.assertIn("\0", clocks.call_args.args[2]["savedClocks"][1]["timezone"])
        self.assertEqual(len(clocks.call_args.args[2]["selectedClocks"]), 5)
        self.assertEqual(teardown.call_count, 17)
        filenames.assert_called_once()
        import_widths.assert_called_once()
        country_types.assert_called_once()

    def test_missing_native_tools_fail_instead_of_skipping(self):
        with mock.patch.object(CHECK.shutil, "which", return_value=None), \
                mock.patch.object(CHECK, "run_session") as run, redirect_stderr(io.StringIO()):
            self.assertEqual(CHECK.main(), 1)
        run.assert_not_called()

    def test_native_diagnostics_fail_even_when_child_exits_successfully(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)

        def run(directory, environment, script):
            self.assertEqual(environment["G_DEBUG"], "fatal-criticals")
            self.assertEqual(script, SCRIPT)
            (directory / "session.log").write_text("UnicodeEncodeError: swallowed GTK callback\n")
            return 0

        with mock.patch.object(CHECK.shutil, "which", return_value="installed"), \
                mock.patch.object(CHECK.tempfile, "TemporaryDirectory", return_value=temporary), \
                mock.patch.object(CHECK, "run_session", side_effect=run), redirect_stderr(io.StringIO()):
            self.assertEqual(CHECK.main(), 1)
        self.assertFalse(Path(temporary.name).exists())


class NativeSettingsRegressionTests(unittest.TestCase):
    def test_t1160_import_status_fits_composed_page_and_preserves_accessible_text(self):
        result = subprocess.run(["/usr/bin/python3", str(SCRIPT)], capture_output=True,
                                text=True, timeout=115, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        reports = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        widths = next(report["T1160"] for report in reports if "T1160" in report)
        self.assertEqual([result["font"] for result in widths], ["Sans 10", "Sans 14"])
        self.assertTrue(all(result["after"] <= 960 for result in widths), widths)
