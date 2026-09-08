"""Native-check isolation and cleanup without launching a desktop in the suite."""

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_cinnamon_imports.py"
SPEC = importlib.util.spec_from_file_location("check_cinnamon_imports_test", SCRIPT)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class NativeImportHarnessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def test_private_environment_precedes_session_start_and_keeps_parent_unchanged(self):
        with mock.patch.dict(os.environ, {"DISPLAY": ":0", "XDG_CONFIG_HOME": "/personal/config"}):
            environment = CHECK.private_environment(self.directory)
            self.assertEqual(os.environ["XDG_CONFIG_HOME"], "/personal/config")
        self.assertEqual(environment["CHRONOS_ORIGINAL_DISPLAY"], ":0")
        self.assertEqual(environment["GSETTINGS_BACKEND"], "keyfile")
        for key, name in CHECK.XDG_DIRECTORIES.items():
            self.assertEqual(environment[key], str(self.directory / name))
            self.assertEqual((self.directory / name).stat().st_mode & 0o777, 0o700)
        process = mock.Mock()
        process.wait.return_value = 0
        with mock.patch.object(CHECK.subprocess, "Popen", return_value=process) as start:
            self.assertEqual(CHECK.run_session(self.directory, environment), 0)
        args, kwargs = start.call_args
        self.assertEqual(args[0][:3], ["dbus-run-session", "--", "xvfb-run"])
        self.assertEqual(kwargs["env"], environment)
        self.assertTrue(kwargs["start_new_session"])

    def test_child_refuses_shared_profile_display_or_settings_backend(self):
        environment = CHECK.private_environment(self.directory)
        environment.update(DISPLAY=":105", CHRONOS_ORIGINAL_DISPLAY=":0")
        with mock.patch.dict(os.environ, environment, clear=True):
            CHECK.verify_isolation(self.directory)
        for override in ({"DISPLAY": ":0"}, {"DISPLAY": ""},
                         {"GSETTINGS_BACKEND": "dconf"}, {"XDG_DATA_HOME": "/personal/data"}):
            with self.subTest(override=override), mock.patch.dict(os.environ, environment | override, clear=True):
                with self.assertRaises(RuntimeError):
                    CHECK.verify_isolation(self.directory)

    def test_shared_runner_can_launch_a_native_settings_checker(self):
        child = self.directory / "settings.py"
        process = mock.Mock()
        process.wait.return_value = 0
        with mock.patch.object(CHECK.subprocess, "Popen", return_value=process) as start:
            self.assertEqual(CHECK.run_session(self.directory, {}, child), 0)
        self.assertEqual(start.call_args.args[0][-2], str(child))
        self.assertTrue(start.call_args.kwargs["start_new_session"])

    def test_copy_inventory_and_profile_are_private_and_disable_remote_providers(self):
        project = self.directory / "project"
        source = project / "files" / CHECK.UUID
        (source / "6.0").mkdir(parents=True)
        (source / "__pycache__").mkdir()
        (source / "__pycache__" / "stale.pyc").write_bytes(b"old")
        (source / "old.js~").write_text("backup")
        (source / "module.js").write_text("var value = 1;\n")
        (source / "6.0" / "applet.js").write_text("function main() {}\n")
        defaults = {"show-weather": True, "show-events": True, "country": "ita",
                    "show-religious-observances": True, "extra-country-calendars": [{"country": "ita"}],
                    "calendar-plugins": ["private.city"]}
        schema = {key: {"default": value} for key, value in defaults.items()}
        (source / "6.0" / "settings-schema.json").write_text(json.dumps(schema))
        audit = self.directory / "audit"
        audit.mkdir()
        CHECK.private_environment(audit)
        copied, inventory = CHECK.prepare_applet(audit, project)
        self.assertEqual(list(inventory), ["module.js", "6.0/applet.js"])
        self.assertEqual(inventory["module.js"], hashlib.sha256((source / "module.js").read_bytes()).hexdigest())
        self.assertFalse((copied / "__pycache__").exists())
        self.assertFalse((copied / "old.js~").exists())
        profile = json.loads((audit / "config" / "cinnamon" / "spices" / CHECK.UUID / "1.json").read_text())
        self.assertEqual(profile["country"]["value"], "none")
        self.assertFalse(profile["show-weather"]["value"])
        self.assertEqual(profile["calendar-plugins"]["value"], [])
        self.assertEqual(json.loads((source / "6.0" / "settings-schema.json").read_text()), schema)

    def test_failed_startup_stops_both_native_processes(self):
        CHECK.private_environment(self.directory)
        processes = [mock.Mock(), mock.Mock()]
        with mock.patch.object(CHECK, "verify_isolation"), \
                mock.patch.object(CHECK.subprocess, "Popen", side_effect=processes), \
                mock.patch.object(CHECK, "evaluator", side_effect=RuntimeError("no bus")), \
                mock.patch.object(CHECK, "stop_process") as stop:
            with self.assertRaisesRegex(RuntimeError, "no bus"):
                CHECK.run_isolated(self.directory)
        self.assertEqual(stop.call_args_list, [mock.call(processes[1]), mock.call(processes[0])])

    def test_enabling_the_applet_waits_for_the_managers_settings_listener(self):
        (self.directory / "inventory.json").write_text("{}")
        readiness_checks = []

        def evaluate(code):
            if "appletsLoaded" in code:
                readiness_checks.append(code)
                return len(readiness_checks) >= 3
            if "set_strv" in code:
                self.assertEqual(len(readiness_checks), 3,
                                 "DBus availability alone precedes the manager's settings listener")
            if "const namespace" in code:
                return {"failures": []}
            return True

        process = mock.Mock()
        process.poll.return_value = None
        with mock.patch.object(CHECK, "verify_isolation"), \
                mock.patch.object(CHECK.subprocess, "Popen", return_value=process), \
                mock.patch.object(CHECK.subprocess, "check_output", return_value="cjs 115.1"), \
                mock.patch.object(CHECK, "evaluator", return_value=evaluate), \
                mock.patch.object(CHECK.time, "sleep"), \
                mock.patch.object(CHECK, "stop_process"), redirect_stdout(io.StringIO()):
            self.assertEqual(CHECK.run_isolated(self.directory), 0)

    def test_timeout_terminates_the_whole_private_session_group(self):
        process = mock.Mock(pid=987654)
        process.wait.side_effect = [subprocess.TimeoutExpired("session", 100), 0]
        with mock.patch.object(CHECK.subprocess, "Popen", return_value=process), \
                mock.patch.object(CHECK.os, "killpg") as terminate:
            with self.assertRaises(subprocess.TimeoutExpired):
                CHECK.run_session(self.directory, {})
        terminate.assert_called_once_with(process.pid, signal.SIGTERM)

    def test_native_process_that_ignores_termination_is_killed(self):
        process = mock.Mock()
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("cinnamon", 5), 0]
        CHECK.stop_process(process)
        process.terminate.assert_called_once()
        process.kill.assert_called_once()

    def test_startup_wait_reports_an_exited_desktop_immediately(self):
        with self.assertRaisesRegex(RuntimeError, "exited"):
            CHECK.wait_for(mock.Mock(), "true", mock.Mock(poll=lambda: 1))
