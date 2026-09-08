"""Local-calendar validation, installation, visibility, and settings wiring."""

from contextlib import ExitStack
from datetime import date
import importlib.util
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


APPLET_DIR = Path(__file__).resolve().parents[1] / "files" / "chronos@geraldo-netto"
DATA_PATH = APPLET_DIR / "chronos_calendar_plugin_data.py"
WIDGET_PATH = APPLET_DIR / "chronos_settings_widgets_calendars.py"


def load_python(path, name, modules=None):
    with mock.patch.dict(sys.modules, modules or {}):
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


DATA = load_python(DATA_PATH, "calendar_plugin_data_test")


def manifest(identifier="example.community", start=2025, end=2035):
    return {
        "apiVersion": 1, "id": identifier, "name": "Community calendar",
        "category": "community", "coverage": {"from": start, "through": end},
        "source": {"name": "Community association", "url": "https://example.org/calendar"},
        "events": [{"name": "Annual meeting", "month": 6, "day": 15}],
    }


def write_manifest(directory, value, filename=None):
    path = directory / (filename or value["id"] + ".json")
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def replace_field(value, field, replacement):
    copy = json.loads(json.dumps(value))
    owner = copy
    keys = field.split(".")
    for key in keys[:-1]:
        owner = owner[int(key)] if isinstance(owner, list) else owner[key]
    owner[keys[-1]] = replacement
    return copy


class ManifestValidationTests(unittest.TestCase):
    def test_normalizes_text_and_preserves_multiple_occurrences(self):
        value = manifest()
        value["name"] = "\ufeff Community calendar \ufeff"
        value["source"].update(tradition=" Local ", location=" Town ")
        value["events"] = [
            {"name": "Meeting", "year": 2030, "month": 1, "day": 1, "nonWorking": False},
            {"name": "Meeting", "year": 2030, "month": 12, "day": 31, "nonWorking": True},
            {"name": "Leap day", "month": 2, "day": 29},
        ]
        result = DATA.validate_manifest(value)
        self.assertEqual(result["name"], "Community calendar")
        self.assertEqual(result["source"]["tradition"], "Local")
        self.assertEqual(len(result["events"]), 3)
        self.assertTrue(result["events"][1]["nonWorking"])
        self.assertEqual(value["name"], "\ufeff Community calendar \ufeff")

    def test_declared_coverage_includes_an_empty_year(self):
        value = manifest()
        value["events"] = []
        del value["source"]["url"]
        parsed = DATA.validate_manifest(value)
        self.assertTrue(DATA.available(parsed, 2025))
        self.assertTrue(DATA.available(parsed, 2035))
        for year in (2024, 2036, True, None, 2025.5, float("inf")):
            self.assertFalse(DATA.available(parsed, year))

    def test_invalid_input_boundaries(self):
        cases = [
            ("apiVersion", True), ("apiVersion", 2), ("extra", "bad"),
            ("id", "../../outside"), ("id", "simple"), ("id", "x.prototype"),
            ("id", "x.constructor"), ("id", "x." + "a" * 96),
            ("name", ""), ("name", "x\n"), ("name", "a" * 101),
            ("name", "\ud800"), ("name", "\U0001f600" * 51), ("name", 4),
            ("category", "x" * 65), ("coverage", []),
            ("coverage.from", 2036), ("coverage.from", False),
            ("coverage.from", 0), ("coverage.through", 10000),
            ("source", {}), ("source.url", "http://example.org"),
            ("source.url", "https://name:password@example.org"),
            ("source.url", "https://example.org/\ufeffx"),
            ("source.tradition", ""), ("source.location", "\u202einvalid"),
            ("events", {}), ("events", [None]), ("events", [{}] * 4097),
            ("events.0.month", True), ("events.0.day", 31),
            ("events.0.year", 2024), ("events.0.nonWorking", 1),
            ("events.0.extra", 3),
        ]
        for field, replacement in cases:
            with self.subTest(field=field, replacement=repr(replacement)[:30]):
                with self.assertRaises(ValueError):
                    DATA.validate_manifest(replace_field(manifest(), field, replacement))

    def test_real_gregorian_dates_and_integral_json_numbers(self):
        value = manifest()
        value["apiVersion"] = 1.0
        value["events"][0].update(year=2028.0, month=2.0, day=29.0)
        self.assertEqual(DATA.validate_manifest(value)["events"][0]["year"], 2028)
        for year in (2027, float("inf"), float("nan")):
            value["events"][0]["year"] = year
            with self.assertRaises(ValueError):
                DATA.validate_manifest(value)

    def test_javascript_and_python_agree_on_external_manifests(self):
        rng = random.Random(20260908)
        values = [manifest(), replace_field(manifest(), "name", "\ufeff name \ufeff")]
        urls = ["https://K.example/calendar", "https://İ.example/calendar",
                "https://ı.example/calendar", "httpſ://example.org/calendar",
                "HTTPS://EXAMPLE.ORG/Plzeň/カレンダー", "https://example.org/\u2000calendar"]
        values.extend(replace_field(manifest(), "source.url", url) for url in urls)
        fields = ("name", "id", "coverage.from", "events.0.day", "events.0.nonWorking")
        replacements = [None, False, 0, 1, 29, 31, 2028, "", "x.y", "a\u202e", "\ud800"]
        for _unused in range(100):
            values.append(replace_field(manifest(), rng.choice(fields), rng.choice(replacements)))
        script = """
const fs = require('node:fs');
const {validateCalendarManifest} = require(process.argv[1]);
const values = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(values.map(value => {
    try { return validateCalendarManifest(value); } catch { return null; }
})));
"""
        result = subprocess.run(
            ["node", "-e", script, str(APPLET_DIR / "calendarPluginData.js")],
            input=json.dumps(values), capture_output=True, text=True, check=True,
        )
        expected = json.loads(result.stdout)
        for raw, js_result in zip(values, expected):
            try:
                actual = DATA.validate_manifest(raw)
            except ValueError:
                actual = None
            self.assertEqual(actual, js_result, repr(raw))


class ManifestFilesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.installed = self.root / "calendars"
        self.installed.mkdir()

    def test_user_data_directory_and_fallback(self):
        with mock.patch.dict(os.environ, {"XDG_DATA_HOME": str(self.root)}):
            self.assertEqual(DATA.plugin_directory(), self.root / "chronos@geraldo-netto" / "calendars")
        with mock.patch.dict(os.environ, {"XDG_DATA_HOME": "relative"}):
            self.assertEqual(DATA.plugin_directory(), Path.home() / ".local/share/chronos@geraldo-netto/calendars")

    def test_import_refresh_replace_and_remove_round_trip(self):
        source = write_manifest(self.root, manifest())
        imported = DATA.import_plugin(source, self.installed)
        choices, errors = DATA.discover_plugins(self.installed)
        self.assertEqual(errors, [])
        self.assertEqual(choices[0]["manifest"], imported)
        source.write_text(json.dumps(replace_field(manifest(), "name", "Updated")))
        DATA.import_plugin(source, self.installed)
        self.assertEqual(DATA.read_manifest(choices[0]["path"])["name"], "Updated")
        DATA.remove_plugin(imported["id"], self.installed)
        self.assertEqual(DATA.discover_plugins(self.installed), ([], []))
        self.assertTrue(source.exists())

    def test_default_directory_paths_and_missing_directory(self):
        source = write_manifest(self.root, manifest())
        with mock.patch.object(DATA, "plugin_directory", return_value=self.installed):
            DATA.import_plugin(source)
            self.assertEqual(len(DATA.discover_plugins()[0]), 1)
            DATA.remove_plugin("example.community")
        self.assertEqual(DATA.discover_plugins(self.root / "missing"), ([], []))

    def test_discovery_rejects_bad_names_bad_json_and_symbolic_links(self):
        write_manifest(self.installed, manifest(), "wrong.json")
        (self.installed / "bad.json").write_text("{")
        source = write_manifest(self.root, manifest("example.link"))
        (self.installed / "example.link.json").symlink_to(source)
        (self.installed / "nested.json").mkdir()
        found, errors = DATA.discover_plugins(self.installed)
        self.assertEqual(found, [])
        self.assertEqual(len(errors), 4)
        self.assertTrue(source.exists())

    def test_deep_json_preserves_valid_neighbors_and_existing_imported_calendar(self):
        original = manifest()
        installed = write_manifest(self.installed, original)
        before = installed.read_bytes()
        nested = "[" * 10000 + "0" + "]" * 10000
        source = self.root / "deep.json"
        source.write_text(nested, encoding="utf-8")
        (self.installed / "example.deep.json").write_text(nested, encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "nesting"):
            DATA.import_plugin(source, self.installed)
        self.assertEqual(installed.read_bytes(), before)
        found, errors = DATA.discover_plugins(self.installed)
        self.assertEqual([row["manifest"]["id"] for row in found], [original["id"]])
        self.assertEqual(len(errors), 1)
        self.assertIn("nesting", errors[0])
        self.assertFalse(DATA.builtin_available("christianity", metadata_path=source))

    def test_near_limit_import_survives_formatting_and_javascript_round_trip(self):
        value = manifest("example.large")
        value["events"] = [{"name": "界" * 160, "month": 6, "day": 15} for _ in range(1950)]
        compact = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.assertLess(len(compact), DATA.MAX_FILE_BYTES)
        source = self.root / "large.json"
        source.write_bytes(compact)
        DATA.import_plugin(source, self.installed)
        destination = self.installed / "example.large.json"
        self.assertLessEqual(destination.stat().st_size, DATA.MAX_FILE_BYTES)
        script = """
const fs = require('node:fs');
const {validateCalendarManifest} = require(process.argv[1]);
process.stdout.write(JSON.stringify(validateCalendarManifest(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')))));
"""
        result = subprocess.run(
            ["node", "-e", script, str(APPLET_DIR / "calendarPluginData.js"), str(destination)],
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(json.loads(result.stdout), DATA.read_manifest(destination))
        with mock.patch.object(DATA, "MAX_FILE_BYTES", len(compact)):
            DATA.import_plugin(source, self.installed)
        self.assertEqual(destination.read_bytes(), compact)

    def test_capped_read_rejects_non_json_numbers_invalid_utf8_and_oversize(self):
        path = self.root / "invalid.json"
        for contents in (b'NaN', b'Infinity', b'\xff', b'x' * (DATA.MAX_FILE_BYTES + 1)):
            path.write_bytes(contents)
            with self.assertRaises((ValueError, UnicodeError)):
                DATA.read_manifest(path)
        with self.assertRaises(ValueError):
            DATA.read_manifest(self.installed)

    def test_post_read_limit_catches_a_file_that_grows_after_stat(self):
        source = write_manifest(self.root, manifest())
        original = DATA.os.fstat
        with mock.patch.object(DATA, "MAX_FILE_BYTES", 20), mock.patch.object(
                DATA.os, "fstat", side_effect=lambda fd: types.SimpleNamespace(
                    st_mode=original(fd).st_mode, st_size=1)):
            with self.assertRaisesRegex(ValueError, "larger"):
                DATA.read_manifest(source)

    def test_install_limit_allows_replacement_and_discovery_reports_excess(self):
        first = write_manifest(self.installed, manifest("example.first"))
        write_manifest(self.installed, manifest("example.second"))
        source = write_manifest(self.root, manifest("example.third"))
        with mock.patch.object(DATA, "MAX_PLUGINS", 2):
            with self.assertRaises(ValueError):
                DATA.import_plugin(source, self.installed)
            DATA.import_plugin(first, self.installed)
            write_manifest(self.installed, manifest("example.third"))
            choices, errors = DATA.discover_plugins(self.installed)
        self.assertEqual(len(choices), 2)
        self.assertEqual(len(errors), 1)

    def test_import_failure_leaves_existing_source_and_cleans_temporary_file(self):
        source = write_manifest(self.root, manifest())
        with mock.patch.object(DATA.os, "replace", side_effect=OSError("disk failed")):
            with self.assertRaises(OSError):
                DATA.import_plugin(source, self.installed)
        self.assertEqual(list(self.installed.iterdir()), [])
        self.assertTrue(source.exists())

    def test_owned_directory_and_identifier_guards(self):
        source = write_manifest(self.root, manifest())
        link = self.root / "linked"
        link.symlink_to(self.installed, target_is_directory=True)
        for operation in (lambda: DATA.import_plugin(source, link),
                          lambda: DATA.discover_plugins(link),
                          lambda: DATA.remove_plugin("example.community", link)):
            with self.assertRaises(ValueError):
                operation()
        write_manifest(self.installed, manifest("other.calendar"), "example.community.json")
        with self.assertRaises(ValueError):
            DATA.remove_plugin("example.community", self.installed)
        with self.assertRaises(ValueError):
            DATA.remove_plugin("../../outside", self.installed)

    def test_builtin_coverage_is_read_lazily_and_fails_closed(self):
        metadata = self.root / "religious-coverage.json"
        metadata.write_text(json.dumps({"bounded": {"from": 2025, "through": 2027}}))
        self.assertTrue(DATA.builtin_available("bounded", 2027, metadata))
        self.assertFalse(DATA.builtin_available("bounded", 2028, metadata))
        self.assertFalse(DATA.builtin_available("missing", 2027, metadata))
        metadata.write_text("not JSON")
        self.assertFalse(DATA.builtin_available("bounded", metadata_path=metadata))
        self.assertFalse(DATA.builtin_available("missing"))


class WidgetNode:
    def __init__(self, **properties):
        self.properties = properties
        self.children = []
        self.handlers = {}
        self.parent = None
        self.active = False
        self.selected = None
        self.text = ""
        self.sensitive = True
        self.destroyed = False

    def connect(self, signal, callback, *args):
        self.handlers.setdefault(signal, []).append((callback, args))

    def emit(self, signal, *args):
        for callback, extra in self.handlers.get(signal, []):
            callback(self, *args, *extra)

    def add(self, child):
        self.children.append(child)
        child.parent = self

    def pack_start(self, child, *_args):
        self.add(child)

    def get_children(self):
        return self.children.copy()

    def destroy(self):
        self.destroyed = True
        if self.parent is not None:
            self.parent.children.remove(self)
            if self.parent.selected is self:
                self.parent.select_row(None)
        self.emit("destroy")

    def set_active(self, value):
        changed = self.active != value
        self.active = value
        if changed:
            self.emit("toggled")

    def get_active(self):
        return self.active

    def select_row(self, row):
        self.selected = row
        self.emit("row-selected", row)

    def get_selected_row(self):
        return self.selected

    def set_text(self, value):
        self.text = value

    def set_sensitive(self, value):
        self.sensitive = value

    def get_toplevel(self):
        return self

    def configure(self, *_args):
        pass

    set_orientation = set_spacing = set_tooltip_text = configure
    set_policy = set_min_content_height = set_max_content_height = configure
    set_line_wrap = show_all = configure


class FakeSettings:
    def __init__(self, selected=None):
        self.values = {"calendar-plugins": selected or [], "calendar-plugins-revision": 0}
        self.listeners = {}

    def get_value(self, key):
        return self.values[key]

    def set_value(self, key, value):
        self.values[key] = value
        for callback in self.listeners.get(key, []):
            callback(key, value)

    def listen(self, key, callback):
        self.listeners.setdefault(key, []).append(callback)


class FakeBackend:
    def attach(self):
        self._saving = False
        self.settings.listen(self.key, self._changed)
        self.on_setting_changed()
        self.connect_widget_handlers()

    def _changed(self, *args):
        if not self._saving:
            self.on_setting_changed(*args)

    def get_value(self):
        return self.settings.get_value(self.key)

    def set_value(self, value):
        self._saving = True
        self.settings.set_value(self.key, value)
        self._saving = False


class FakeChooser(WidgetNode):
    response = 0
    filename = None
    latest = None

    def __init__(self, **properties):
        super().__init__(**properties)
        FakeChooser.latest = self

    add_buttons = set_local_only = add_filter = WidgetNode.configure

    def run(self):
        return self.response

    def get_filename(self):
        return self.filename


class FakeCountryList(WidgetNode, FakeBackend):
    def __init__(self, key, settings, info):
        WidgetNode.__init__(self)
        self.key = key
        self.settings = settings
        self.columns = info["columns"]
        self.attach()

    def connect_widget_handlers(self):
        pass

    def on_setting_changed(self, *_args):
        types_by_column = {"boolean": bool, "string": str}
        self.rows = []
        for row in self.get_value():
            values = [row[column["id"]] for column in self.columns]
            for value, column in zip(values, self.columns):
                if type(value) is not types_by_column[column["type"]]:
                    raise TypeError("Native list received an invalid column value")
            self.rows.append(values)


def widget_modules(data):
    gtk = types.SimpleNamespace(
        ListBox=WidgetNode, ListBoxRow=WidgetNode, Box=WidgetNode,
        ScrolledWindow=WidgetNode, Label=WidgetNode, Button=WidgetNode,
        CheckButton=WidgetNode, FileChooserDialog=FakeChooser,
        FileFilter=lambda: types.SimpleNamespace(set_name=lambda *_args: None,
                                                add_pattern=lambda *_args: None),
        Orientation=types.SimpleNamespace(VERTICAL=1, HORIZONTAL=0),
        SelectionMode=types.SimpleNamespace(SINGLE=1),
        PolicyType=types.SimpleNamespace(NEVER=0, AUTOMATIC=1),
        FileChooserAction=types.SimpleNamespace(OPEN=0),
        ResponseType=types.SimpleNamespace(CANCEL=0, ACCEPT=1),
    )
    return {
        "chronos_calendar_plugin_data": data,
        "JsonSettingsWidgets": types.SimpleNamespace(
            JSONSettingsBackend=FakeBackend,
            JSONSettingsList=FakeCountryList,
            JSONSettingsSwitch=lambda *args: args,
        ),
        "gi": types.ModuleType("gi"),
        "gi.repository": types.SimpleNamespace(Gtk=gtk),
        "xapp": types.ModuleType("xapp"),
        "xapp.SettingsWidgets": types.SimpleNamespace(SettingsWidget=WidgetNode),
    }


class AdditionalCountrySettingsTests(unittest.TestCase):
    INFO = {"columns": [
        {"id": "enabled", "type": "boolean", "default": True},
        {"id": "country", "type": "string"},
        {"id": "region", "type": "string", "default": "global"},
    ]}

    def setUp(self):
        self.module = load_python(WIDGET_PATH, "country_widgets_test", widget_modules(DATA))
        self.settings = FakeSettings()

    def test_malformed_profiles_cannot_reach_the_native_list(self):
        for value in (None, [None], "Italy", {}, 42, [["ita"]]):
            with self.subTest(value=value):
                self.settings.values["extra-country-calendars"] = value
                widget = self.module.AdditionalCountryList(
                    self.INFO, "extra-country-calendars", self.settings)
                self.assertEqual(widget.rows, [])
                self.assertEqual(self.settings.get_value("extra-country-calendars"), [])
                self.settings.set_value("extra-country-calendars", value)
                self.assertEqual(widget.rows, [])
                self.assertEqual(self.settings.get_value("extra-country-calendars"), [])

    def test_valid_neighbors_survive_malformed_rows_and_missing_optional_fields(self):
        value = [None, {"country": "ita"}, {"country": ["cze"]},
                 {"country": "usa", "enabled": False, "region": "ma", "extra": "discard"},
                 {"country": "cze", "region": None}, {"country": "deu", "enabled": "yes"}]
        self.settings.values["extra-country-calendars"] = value
        widget = self.module.AdditionalCountryList(self.INFO, "extra-country-calendars", self.settings)
        self.assertEqual(widget.rows, [[True, "ita", "global"], [False, "usa", "ma"]])
        self.settings.set_value("extra-country-calendars", [{"country": "cze"}, None])
        self.assertEqual(widget.rows, [[True, "cze", "global"]])

    def test_country_row_normalization_is_bounded_and_idempotent(self):
        rng = random.Random(20260908)
        choices = [None, [], {}, "bad", {"country": "ita"},
                   {"country": "usa", "region": "ma", "enabled": False}]
        for _unused in range(100):
            rows = [rng.choice(choices) for _index in range(rng.randrange(150))]
            normalized = self.module.normalize_country_rows(rows)
            self.assertLessEqual(len(normalized), 64)
            self.assertEqual(self.module.normalize_country_rows(normalized), normalized)
        self.assertEqual(len(self.module.normalize_country_rows([{"country": "ita"}] * 65)), 64)


class CalendarChoicesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.installed = self.root / "calendars"
        self.installed.mkdir()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(DATA, "plugin_directory", return_value=self.installed))
        self.widget_module = load_python(WIDGET_PATH, "calendar_plugin_widgets_test", widget_modules(DATA))
        self.settings = FakeSettings(["example.expired"])
        self.current = date.today().year
        write_manifest(self.installed, manifest("example.expired", self.current - 2, self.current - 1))
        write_manifest(self.installed, manifest("example.current", self.current, self.current + 1))
        self.widget = self.widget_module.CalendarPluginChoices({}, "calendar-plugins", self.settings)

    def test_only_available_choices_are_shown_and_hidden_selections_survive(self):
        rows = self.widget.listbox.get_children()
        self.assertEqual([row.calendar_id for row in rows], ["example.current"])
        rows[0].children[0].set_active(True)
        self.assertEqual(self.settings.values["calendar-plugins"], ["example.expired", "example.current"])
        self.widget.listbox.get_children()[0].children[0].set_active(False)
        self.assertEqual(self.settings.values["calendar-plugins"], ["example.expired"])
        self.settings.set_value("calendar-plugins", ["example.current"])
        self.assertTrue(self.widget.listbox.get_children()[0].children[0].active)

    def test_refresh_reloads_modified_files_and_notifies_runtime(self):
        write_manifest(self.installed, manifest("example.current", self.current - 2, self.current - 1))
        self.widget._on_refresh()
        self.assertEqual(self.widget.listbox.get_children(), [])
        self.assertIn("No installed calendars", self.widget.status.text)
        self.assertEqual(self.settings.values["calendar-plugins-revision"], 1)
        for revision in ("bad", -1, 2147483647, True):
            self.settings.values["calendar-plugins-revision"] = revision
            self.widget._on_refresh()
            self.assertEqual(self.settings.values["calendar-plugins-revision"], 1)

    def test_selection_capacity_does_not_discard_hidden_selections(self):
        chosen = [f"example.hidden{index}" for index in range(DATA.MAX_PLUGINS)]
        self.settings.set_value("calendar-plugins", chosen)
        checkbox = self.widget.listbox.get_children()[0].children[0]
        checkbox.set_active(True)
        self.assertFalse(checkbox.active)
        self.assertEqual(self.settings.values["calendar-plugins"], chosen)
        self.assertIn("At most 32", self.widget.status.text)

    def test_javascript_selection_and_checkbox_state_agree_for_corrupt_settings(self):
        values = [None, "example.current", {}, [], [" example.current "],
                  ["example.current\n"], ["example.current\u2028"],
                  [None] * 32 + ["example.current"],
                  ["example.hidden"] * 40 + ["example.current"],
                  ["x.prototype", "x.constructor", "example.current"],
                  [False, 1, [], {}, "../bad", "EXAMPLE.current", "example.current"],
                  ["example." + "a" * 88, "example." + "a" * 89, "example.current"],
                  [f"example.hidden{index}" for index in range(32)] + ["example.current"]]
        script = """
const fs = require('node:fs');
const {selectedPluginIds} = require(process.argv[1]);
process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(0, 'utf8')).map(selectedPluginIds)));
"""
        result = subprocess.run(
            ["node", "-e", script, str(APPLET_DIR / "calendarPluginLoader.js")],
            input=json.dumps(values), capture_output=True, text=True, check=True,
        )
        for raw, runtime_ids in zip(values, json.loads(result.stdout)):
            with self.subTest(raw=raw):
                self.assertEqual(self.widget_module.selected_ids(raw), runtime_ids)
                self.settings.set_value("calendar-plugins", raw)
                checkbox = self.widget.listbox.get_children()[0].children[0]
                self.assertEqual(checkbox.active, "example.current" in runtime_ids)

    def test_repeated_toggle_notifications_keep_selections_unique(self):
        row = self.widget.listbox.get_children()[0]
        checkbox = row.children[0]
        checkbox.set_active(True)
        self.widget._on_toggled(checkbox, row)
        self.assertEqual(self.settings.values["calendar-plugins"].count("example.current"), 1)
        checkbox.set_active(False)
        self.widget._on_toggled(checkbox, row)
        self.assertEqual(self.settings.values["calendar-plugins"], ["example.expired"])

    def test_import_current_and_expired_manifests_and_cancel(self):
        source = write_manifest(self.root, manifest("example.imported", self.current - 1, self.current + 1))
        with mock.patch.object(self.widget, "_choose_import", return_value=str(source)):
            self.widget._on_import()
        self.assertEqual(len(self.widget.listbox.get_children()), 2)
        self.assertIn("Imported", self.widget.status.text)
        source = write_manifest(self.root, manifest("example.old", self.current - 2, self.current - 1))
        with mock.patch.object(self.widget, "_choose_import", return_value=str(source)):
            self.widget._on_import()
        self.assertEqual(len(self.widget.listbox.get_children()), 2)
        self.assertTrue((self.installed / "example.old.json").exists())
        revision = self.settings.values["calendar-plugins-revision"]
        with mock.patch.object(self.widget, "_choose_import", return_value=None):
            self.widget._on_import()
        self.assertEqual(self.settings.values["calendar-plugins-revision"], revision)

    def test_import_errors_do_not_change_files_or_selection(self):
        source = self.root / "bad.json"
        source.write_text("not JSON")
        with mock.patch.object(self.widget, "_choose_import", return_value=str(source)):
            self.widget._on_import()
        self.assertIn("could not be imported", self.widget.status.text)
        self.assertEqual(self.settings.values["calendar-plugins"], ["example.expired"])
        self.assertEqual(self.settings.values["calendar-plugins-revision"], 0)

    def test_removal_affects_only_selected_installed_calendar(self):
        self.widget._on_remove()
        row = self.widget.listbox.get_children()[0]
        row.children[0].set_active(True)
        self.assertTrue(self.widget.remove_button.sensitive)
        self.widget._on_remove()
        self.assertFalse((self.installed / "example.current.json").exists())
        self.assertTrue((self.installed / "example.expired.json").exists())
        self.assertEqual(self.settings.values["calendar-plugins"], ["example.expired"])
        self.assertFalse(self.widget.remove_button.sensitive)

    def test_removal_and_discovery_errors_stay_visible(self):
        self.widget.listbox.select_row(self.widget.listbox.get_children()[0])
        with mock.patch.object(DATA, "remove_plugin", side_effect=OSError("denied")):
            self.widget._on_remove()
        self.assertIn("could not be removed", self.widget.status.text)
        with mock.patch.object(DATA, "discover_plugins", side_effect=OSError("denied")):
            self.widget._on_refresh()
        self.assertIn("could not be loaded", self.widget.status.text)
        self.assertEqual(self.widget.listbox.get_children(), [])

    def test_destroyed_widget_ignores_settings_notifications(self):
        self.widget.destroy()
        with mock.patch.object(DATA, "discover_plugins") as discover:
            self.settings.set_value("calendar-plugins", [])
        discover.assert_not_called()

    def test_file_chooser_returns_local_file_and_always_destroys_dialog(self):
        FakeChooser.response = 0
        self.assertIsNone(self.widget._choose_import())
        self.assertTrue(FakeChooser.latest.destroyed)
        FakeChooser.response = 1
        FakeChooser.filename = "/tmp/test-calendar.json"
        self.assertEqual(self.widget._choose_import(), FakeChooser.filename)
        self.assertTrue(FakeChooser.latest.destroyed)

    def test_available_builtin_factory_and_selection_validation(self):
        with mock.patch.object(DATA, "builtin_available", return_value=False):
            self.assertIsNone(self.widget_module.AvailableReligionSwitch({}, "religion-islam", self.settings))
        with mock.patch.object(DATA, "builtin_available", return_value=True):
            widget = self.widget_module.AvailableReligionSwitch({}, "religion-islam", self.settings)
        self.assertEqual(widget, ("religion-islam", self.settings, {}))
        self.assertEqual(self.widget_module.selected_ids("bad"), [])
        self.assertEqual(self.widget_module.selected_ids(["example.ok", None, "../bad", "example.ok"]), ["example.ok"])


if __name__ == "__main__":
    unittest.main()
