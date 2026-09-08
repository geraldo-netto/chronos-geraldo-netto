import os
from pathlib import Path
from unittest import mock

from helpers.settings_widgets_fixture import (
    APPLET_DIR, COMMON_PATH, WORLDCLOCKS_PATH, BaseWidget, DialogSettings, Entry, FakeSettings,
    FUZZ_SEED, GtkDialog, GtkLabel, GtkMessageDialog, Model,
    importlib, install_stubs, json, load_module, random, requires_pytz, sys,
    tearDownModule as teardown_fixture, types, unittest,
)


def tearDownModule():
    teardown_fixture()

class SettingsWidgetsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module(WORLDCLOCKS_PATH, "settings_widgets_common_test")

    def setUp(self):
        GtkDialog.on_run = None
        GtkMessageDialog.instances.clear()
        BaseWidget.instances.clear()

    def test_list_edit_factory_entry_widget(self):
        widget = self.module.list_edit_factory({"title": "Label", "max_length": 42})

        self.assertIsInstance(widget, Entry)
        self.assertEqual(widget.kwargs["label"], "Label")
        self.assertEqual(widget.bind_object.max_length, 42)

        widget.set_widget_value("Home")
        self.assertEqual(widget.get_widget_value(), "Home")

    def test_option_combobox_names_the_visible_label_not_the_stored_value(self):
        settings = FakeSettings({"weather-units": "si"})
        widget = self.module.common.OptionLabelComboBox({
            "description": "Weather units",
            "tooltip": "Scale",
            "default": "si",
            "options": {
                "SI (Celsius)": "si",
                "Imperial (Fahrenheit)": "imperial",
            },
        }, "weather-units", settings)

        accessible = widget.content_widget.get_accessible()
        self.assertEqual(accessible.name, "SI (Celsius)")
        self.assertEqual(widget.options, [
            ("si", "SI (Celsius)"),
            ("imperial", "Imperial (Fahrenheit)"),
        ], "stored values and visible labels keep XApp's column contract")

        widget.content_widget.set_active_iter(widget.option_map["imperial"])
        self.assertEqual(settings.values["weather-units"], "imperial")
        self.assertEqual(accessible.name, "Imperial (Fahrenheit)")

        settings.set_value("weather-units", "unknown")
        self.assertEqual(settings.values["weather-units"], "si")
        self.assertEqual(accessible.name, "SI (Celsius)",
                         "an invalid external value recovers visibly to its default")

        no_default_settings = FakeSettings({"unit": "unknown"})
        no_default = self.module.common.OptionLabelComboBox({
            "options": {"Known": "known"},
        }, "unit", no_default_settings)
        self.assertEqual(no_default_settings.values["unit"], "unknown",
                         "the widget cannot invent a fallback the schema omitted")
        self.assertEqual(no_default.content_widget.get_accessible().name, "")

    def test_the_column_widgets_are_declared_once_not_per_dialog(self):
        # PyGObject registers a GType for every subclass of a GObject type, and
        # GTypes are never unregistered. Declaring the widget classes inside the
        # factory leaked one of them - with its class structure and closures
        # - on every Add or Edit click, for the life of the settings process.
        first = self.module.list_edit_factory({"title": "Label"})
        second = self.module.list_edit_factory({"title": "Label"})
        self.assertIs(type(first), type(second))
        self.assertIs(type(first), self.module.ListEditEntry)

    def test_malformed_option_values_recover_on_load_and_external_updates(self):
        info = {"default": "si", "options": {"SI": "si", "Imperial": "imperial"}}
        for value in ([], {}, ["si"], {"unit": "si"}, None, False, 42, 1.5):
            with self.subTest(value=value):
                settings = FakeSettings({"weather-units": value})
                widget = self.module.common.OptionLabelComboBox(info, "weather-units", settings)
                self.assertEqual(settings.values["weather-units"], "si")
                self.assertEqual(widget.content_widget.get_active_iter(), widget.option_map["si"])
                self.assertEqual(widget.content_widget.get_accessible().name, "SI")
                settings.set_value("weather-units", "imperial")
                settings.set_value("weather-units", value)
                self.assertEqual(settings.values["weather-units"], "si")
                self.assertEqual(widget.content_widget.get_active_iter(), widget.option_map["si"])
                self.assertEqual(widget.content_widget.get_accessible().name, "SI")

    def test_error_state_tolerates_a_widget_without_style_context(self):
        self.assertIsNone(self.module.set_error_state(object(), True))

    def test_the_shared_error_affordance_survives_a_widget_that_answers_nothing(self):
        """T798: the error trio moved to common so all three feature dialogs can
        use it, and it is handed real GTK widgets in production and doubles in
        the suite - so every optional capability it probes for has to be
        optional. A plain object has no style context, no accessible and no
        bind_object."""
        common = self.module.common
        bare = object()

        self.assertIsNone(common.set_invalid(bare, True, "Invalid timezone"))
        self.assertIsNone(common.describe_widget(bare, bare, "text"))
        self.assertIsNone(common.describe_widget(None, bare, "text"))

        # an accessible that implements neither optional method is still fine
        class Accessible:
            pass

        class Entry:
            def get_accessible(self):
                return Accessible()

        self.assertIsNone(common.set_invalid(Entry(), True, "Invalid timezone"))
        self.assertIsNone(common.describe_widget(Entry(), bare, "text"))

    def test_no_feature_module_wires_its_own_completion_or_error_style(self):
        """T798: the EntryCompletion wiring was written out three times,
        differing only in the text column, the minimum key length and whether
        inline completion is safe; the process-wide ListStore memo existed
        twice; and the error affordance lived in the world-clock module, which
        is why it was the only one of the three dialogs that had one."""
        for name in ("chronos_settings_widgets_worldclocks.py",
                     "chronos_settings_widgets_weather.py",
                     "chronos_settings_widgets_holidays.py"):
            source = (APPLET_DIR / name).read_text()
            self.assertNotIn("Gtk.EntryCompletion()", source,
                             "%s must attach through common" % name)
            self.assertNotIn("_MODELS: dict", source,
                             "%s must memoize its suggestions through common" % name)
            self.assertNotIn('ERROR_STYLE_CLASS = "error"', source,
                             "%s must not name the error class itself" % name)

    def test_an_empty_suggestion_list_is_an_empty_store(self):
        # both attachers refuse to wire a completion with nothing to suggest, so
        # this is the shape of the memo rather than a path the dialog takes
        common = self.module.common
        common._COMPLETION_MODELS.clear()

        model = common.completion_model([], lambda row: [row])

        self.assertEqual(len(model.rows), 0)

    def test_two_transforms_over_the_same_rows_get_their_own_model(self):
        # T838: the key held id(row_columns) and kept the rows alive but not the
        # function, so a freed callable's address went straight to the next one.
        # Not hypothetical - CPython reuses the block immediately, and before
        # this the second call returned the first call's model, folded by the
        # wrong transform.
        common = self.module.common
        common._COMPLETION_MODELS.clear()
        rows = ["Rome", "Lisbon"]

        lowered = common.completion_model(rows, lambda row: [row, row.lower()])
        uppered = common.completion_model(rows, lambda row: [row, row.upper()])

        self.assertIsNot(lowered, uppered)
        self.assertEqual(uppered.rows, [["Rome", "ROME"], ["Lisbon", "LISBON"]])

    def test_the_same_transform_over_the_same_rows_is_built_once(self):
        # the memo still has to hit, which is the whole reason it exists
        common = self.module.common
        common._COMPLETION_MODELS.clear()

        def columns(row):
            return [row, row.lower()]

        self.assertIs(common.completion_model(["Rome"], columns),
                      common.completion_model(["Rome"], columns))
        self.assertIsNot(common.completion_model(["Rome"], columns),
                         common.completion_model(["Tokyo"], columns))

    def test_the_suggestion_store_is_built_once_not_per_dialog(self):
        # ~440 rows with pytz, rebuilt on the GTK main thread every time the
        # dialog opened; the list does not change while the process runs
        completions = [("Rome (Europe)", "Europe/Rome"), ("Tokyo (Asia)", "Asia/Tokyo")]

        first = self.module.list_edit_factory({"title": "Zone", "completions": completions})
        second = self.module.list_edit_factory({"title": "Zone", "completions": completions})

        self.assertIs(first.completion.model, second.completion.model)
        self.assertEqual(len(first.completion.model.rows), 2)

    def test_add_button_stops_at_the_clock_limit(self):
        clocks = self.module.ClocksList({
            "value": [{"label": "Rome", "timezone": "Europe/Rome"}]
        }, "worldclocks", object())

        self.assertTrue(clocks.add_button.sensitive)
        self.assertEqual(clocks.add_button.tooltip, "Add new entry",
                         "the icon-only control keeps its accessible label")
        self.assertTrue(clocks.add_button.has_tooltip)

        clocks.model = Model(self.module.MAX_CLOCKS)
        clocks.update_button_sensitivity()
        self.assertFalse(clocks.add_button.sensitive)

        # The sentence explaining the cap fires from open_add_edit_dialog, which is
        # reached by a click the button can no longer receive: it was unreachable,
        # and the user got a dead button with no explanation anywhere. The button
        # says why it is dead.
        self.assertEqual(clocks.add_button.tooltip, self.module.CLOCK_LIMIT_MESSAGE)
        self.assertIn("8", clocks.add_button.tooltip)

        self.assertTrue(clocks.add_button.has_tooltip)

        # ...and removing one restores the action label, with no stale excuse
        clocks.model = Model(self.module.MAX_CLOCKS - 1)
        clocks.update_button_sensitivity()
        self.assertTrue(clocks.add_button.sensitive)
        self.assertEqual(clocks.add_button.tooltip, "Add new entry")
        self.assertTrue(clocks.add_button.has_tooltip)

    def test_hidden_list_buttons_skip_add_button_updates(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        clocks.show_buttons = False
        clocks.model = Model(self.module.MAX_CLOCKS)

        clocks.update_button_sensitivity()

        self.assertTrue(clocks.add_button.sensitive,
                        "a hidden control needs no per-button state update")

    def test_add_button_without_tooltip_api_still_updates_sensitivity(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        sensitivity = []
        clocks.add_button = types.SimpleNamespace(set_sensitive=sensitivity.append)

        clocks.update_button_sensitivity()

        self.assertEqual(sensitivity, [True])

    def test_constructor_survives_corrupt_saved_clocks(self):
        value = [
            None,
            {"label": "Rome"},
            {"label": "Rome", "timezone": None},
            {"label": "Rome", "timezone": 42},
            {"label": 42, "timezone": "Europe/Rome"},
            {"label": " ", "timezone": "Europe/Rome"},
            {"label": " Tokyo ", "timezone": " Asia/Tokyo ", "junk": "drop"},
        ]
        settings = FakeSettings({"worldclocks": value})

        clocks = self.module.ClocksList({"value": []}, "worldclocks", settings)

        expected = [{"label": "Tokyo", "timezone": "Asia/Tokyo"}]
        self.assertEqual(settings.values["worldclocks"], expected)
        self.assertEqual(settings.writes, [("worldclocks", expected)])
        self.assertEqual(clocks.model.rows, expected,
                         "the typed inherited loader receives only valid rows")
        self.assertTrue(clocks.add_button.sensitive)

    def test_constructor_survives_non_list_saved_value(self):
        # xlet-settings.py instantiates widgets outside its try block, so a
        # constructor exception breaks the whole settings window
        for value in (None, 5, "clocks", {}):
            with self.subTest(value=value):
                settings = FakeSettings({"worldclocks": value})
                clocks = self.module.ClocksList({"value": []}, "worldclocks", settings)
                self.assertEqual(settings.values["worldclocks"], [])
                self.assertEqual(clocks.model.rows, [])
                self.assertTrue(clocks.add_button.sensitive)

    def test_a_reset_reopens_the_add_button(self):
        # T733: Cinnamon calls update_button_sensitivity from List.__init__,
        # List.list_changed and the tree selection's "changed" signal only. Its
        # on_setting_changed clears and repopulates the model and calls none of
        # them — and that is the path "Reset to defaults" and "Import from a
        # file" take, through JSONSettingsHandler.do_key_update. With the cap
        # reached and no row selected, the tree emptied while the Add button
        # stayed dead and still explained itself with the cap message, until the
        # settings window was closed and reopened.
        full = [{"label": "Clock %d" % i, "timezone": "Region/City_%d" % i}
                for i in range(self.module.MAX_CLOCKS)]
        settings = FakeSettings({"worldclocks": full})
        clocks = self.module.ClocksList({"value": full}, "worldclocks", settings)

        self.assertFalse(clocks.add_button.sensitive)
        self.assertEqual(clocks.add_button.tooltip, self.module.CLOCK_LIMIT_MESSAGE)

        # the overflow menu resets the key, and Cinnamon repopulates the tree
        settings.values["worldclocks"] = []
        clocks.on_setting_changed()

        self.assertEqual(clocks.model.rows, [])
        self.assertTrue(clocks.add_button.sensitive,
                        "a clock can be added again without reopening the window")
        self.assertEqual(clocks.add_button.tooltip, "Add new entry")

        # and importing a list that is full again closes it back up
        settings.values["worldclocks"] = full
        clocks.on_setting_changed()

        self.assertFalse(clocks.add_button.sensitive)
        self.assertEqual(clocks.add_button.tooltip, self.module.CLOCK_LIMIT_MESSAGE)

    def test_clock_entry_serializer_owns_dialog_data_and_output_shape(self):
        serializer = self.module.ClockEntrySerializer([{"id": "label"}, {"id": "timezone"}])

        data, title = serializer.initial_dialog_data(None)
        self.assertEqual(data, {"label": None, "timezone": None})
        self.assertEqual(title, "Add new entry")

        data, title = serializer.initial_dialog_data(["Tokyo", "Asia/Tokyo"])
        self.assertEqual(data, {"label": "Tokyo", "timezone": "Asia/Tokyo"})
        self.assertEqual(title, "Edit entry")

        self.assertEqual(serializer.serialize(" Home ", "Europe/Rome"), ["Home", "Europe/Rome"])
        self.assertEqual(serializer.serialize(" \t ", "Europe/Rome"), ["", "Europe/Rome"])
        long_label = "x" * (self.module.MAX_CLOCK_INPUT_LABEL_LENGTH + 20)
        saved = serializer.serialize(long_label, "Europe/Rome")[0]
        self.assertEqual(len(saved), self.module.MAX_CLOCK_INPUT_LABEL_LENGTH)
        self.assertTrue(saved.endswith("…"))

    def test_a_pasted_control_character_is_not_persisted(self):
        # T729: the dialog clamped and trimmed but never filtered, so a Display
        # name pasted with an embedded newline was written to the config
        # verbatim. The runtime now filters it on read; this stops it being
        # stored at all, and keeps the two sides agreeing about what a label is.
        serializer = self.module.ClockEntrySerializer([{"id": "label"}, {"id": "timezone"}])

        self.assertEqual(
            serializer.serialize("Home\nOffice", "Europe/Rome"),
            ["Home Office", "Europe/Rome"])
        # a run collapses to one space, and the edges still trim
        self.assertEqual(
            self.module.normalize_clock_label("\r\n Home\v\fOffice \t"), "Home Office")
        # C1 controls are invisible in the entry but not to Pango
        self.assertEqual(
            self.module.normalize_clock_label("HomeOffice"), "Home Office")
        # a label that is nothing but controls is no label at all
        self.assertEqual(self.module.normalize_clock_label("\u0085\u0000"), "")
        self.assertEqual(self.module.normalize_clock_label(None), "")
        # the clamp still applies after filtering
        long_label = "x\n" * self.module.MAX_CLOCK_INPUT_LABEL_LENGTH
        clamped = self.module.normalize_clock_label(long_label)
        self.assertEqual(len(clamped), self.module.MAX_CLOCK_INPUT_LABEL_LENGTH)
        self.assertNotIn("\n", clamped)

    def test_clock_label_whitespace_matches_the_runtime(self):
        cases = json.loads(
            (Path(__file__).parent / "fixtures" / "settings_whitespace_cases.json").read_text())
        for case in cases:
            with self.subTest(value=case["input"]):
                self.assertEqual(self.module.normalize_clock_label(case["input"]), case["clockLabel"])

    def test_the_sanitizer_matches_the_runtime_copy_of_the_rule(self):
        """T786: one rule for one string - a world clock's Display name, which
        this dialog persists and the applet reads back - written twice with no
        gate between the two. It had already drifted: the line separators (T783)
        and the bidi overrides (T833) were added to textUtils alone, so the
        dialog went on saving exactly what the runtime then had to strip. The JS
        suite asserts the same table."""
        cases = json.loads(
            (Path(__file__).parent / "fixtures" / "control_character_cases.json").read_text())
        sanitize = self.module.sanitize_control_characters

        for case in cases["removed"]:
            self.assertEqual(sanitize("a%sb" % chr(case["codePoint"])), "a b",
                             case["why"])
        for case in cases["kept"]:
            kept = "a%sb" % chr(case["codePoint"])
            self.assertEqual(sanitize(kept), kept, case["why"])
        for case in cases["runs"]:
            run = "".join(chr(code) for code in case["codePoints"])
            self.assertEqual(sanitize("a%sb" % run), "a b", case["why"])

    def test_clock_entry_serializer_matches_schema_column_order(self):
        schema = json.loads((APPLET_DIR / "6.0" / "settings-schema.json").read_text())
        columns = schema["worldclocks"]["columns"]
        expected = {"label": "Home", "timezone": "Europe/Rome"}
        for ordered in (columns, columns[::-1]):
            with self.subTest(order=[column["id"] for column in ordered]):
                clocks = self.module.ClocksList({"value": [], "columns": ordered}, "worldclocks", object())
                serializer = clocks.entry_serializer
                row = serializer.serialize(" Home ", "Europe/Rome")
                self.assertEqual(dict(zip([column["id"] for column in ordered], row)), expected)
                data, title = serializer.initial_dialog_data(row)
                self.assertEqual(data, expected)
                self.assertEqual(title, "Edit entry")
                clocks.model.rows = [expected]
                self.assertTrue(clocks._timezone_is_duplicate("Europe/Rome"))
                self.assertFalse(clocks._timezone_is_duplicate("Europe/Rome", "Europe/Rome"))

    def test_timezone_resolver_builds_maps_and_normalizes_values(self):
        fake_pytz = types.SimpleNamespace(
            all_timezones=["Europe/Rome", "America/New_York", "UTC"],
            common_timezones=["Europe/Rome", "America/New_York", "UTC"]
        )

        resolver = self.module.common.TimezoneResolver(fake_pytz, None)

        self.assertTrue(resolver.has_timezone_data)
        self.assertEqual(resolver.split("Europe/Rome"), ("Europe", "Rome"))
        self.assertEqual(resolver.split("UTC"), ("Etc", "UTC"))
        self.assertEqual(resolver.split(None), ("Etc", ""))
        self.assertEqual(resolver.normalize(" europe/rome "), "Europe/Rome")
        self.assertEqual(resolver.normalize("new york"), "America/New_York")
        self.assertTrue(resolver.any_timezone_data())
        self.assertIsNone(resolver.normalize("UTC"))
        self.assertIsNone(resolver.normalize("local"))
        self.assertIsNone(resolver.normalize(""))
        self.assertIsNone(resolver.normalize("Not A Timezone"))
        self.assertEqual(
            resolver.completions,
            [
                ("New York (America)", "America/New_York"),
                ("Rome (Europe)", "Europe/Rome"),
                ("UTC", "UTC"),
            ])

    def test_timezone_resolver_finds_cities_nested_below_their_region(self):
        fake_pytz = types.SimpleNamespace(
            all_timezones=["America/Argentina/Buenos_Aires", "America/New_York"],
            common_timezones=["America/Argentina/Buenos_Aires", "America/New_York"]
        )

        resolver = self.module.common.TimezoneResolver(fake_pytz, None)

        self.assertEqual(
            resolver.normalize("buenos aires"), "America/Argentina/Buenos_Aires")
        self.assertEqual(
            resolver.normalize("Argentina/Buenos_Aires"), "America/Argentina/Buenos_Aires")
        self.assertEqual(
            resolver.completions,
            [
                ("Buenos Aires (America / Argentina)", "America/Argentina/Buenos_Aires"),
                ("New York (America)", "America/New_York"),
            ])

    def test_timezone_resolver_sorts_suggestions_by_city_name(self):
        fake_pytz = types.SimpleNamespace(
            all_timezones=["Europe/Rome", "Europe/Amsterdam", "Africa/Cairo"],
            common_timezones=["Europe/Rome", "Europe/Amsterdam", "Africa/Cairo"]
        )

        resolver = self.module.common.TimezoneResolver(fake_pytz, None)

        self.assertEqual(
            [display for display, timezone in resolver.completions],
            ["Amsterdam (Europe)", "Cairo (Africa)", "Rome (Europe)"])

    def test_timezone_resolver_keeps_the_first_zone_for_a_shared_city_name(self):
        fake_pytz = types.SimpleNamespace(
            all_timezones=["Asia/Nicosia", "Europe/Nicosia"],
            common_timezones=["Asia/Nicosia", "Europe/Nicosia"]
        )

        resolver = self.module.common.TimezoneResolver(fake_pytz, None)

        self.assertEqual(resolver.normalize("nicosia"), "Asia/Nicosia")
        self.assertEqual(resolver.normalize("Europe/Nicosia"), "Europe/Nicosia")

    def test_a_dialog_with_no_timezone_database_says_so_in_the_dialog(self):
        # the warning otherwise only reaches a log line nobody opening this
        # dialog will ever read
        module = load_module(WORLDCLOCKS_PATH, "settings_widgets_no_tz_hint", missing_pytz=True)
        clocks = module.ClocksList(
            {"value": []}, "worldclocks", DialogSettings(),
            module.common.TimezoneResolver(None, None))

        labels = []

        def script(dialog):
            labels.extend(
                child.text for child in dialog.content_area.children[0].children[0].children
                if isinstance(child, GtkLabel))
            return 0  # cancel

        GtkDialog.on_run = script
        clocks.open_add_edit_dialog()

        self.assertTrue(
            any("Install python3-pytz" in text for text in labels),
            "with no timezone database at all, the dialog has to say so: %r" % labels)

    def test_completion_match_refuses_a_row_it_cannot_read(self):
        match = self.module.common.plain_completion_match
        model = self.module.timezone_completion_model([("Rome (Europe)", "Europe/Rome")])

        # GTK passes the key straight from the entry; an empty one would match
        # every row and pop the whole zone list open
        self.assertFalse(match(None, "", 0, model))
        self.assertFalse(match(None, "   ", 0, model))

    def test_local_timezone_name_reads_the_zoneinfo_link(self):
        # load_module stubs this out so the rest of the suite does not depend on
        # where it runs; the real one is exercised here, against a real
        # /etc/localtime and against the shapes it has to survive. It lives in
        # the gi-free chronos_timezone_data sibling, so a fresh exec of that source —
        # no stubs, no sys.path — is the unpatched function.
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "tzdata_localtime_real", APPLET_DIR / "chronos_timezone_data.py")
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)

        with mock.patch.dict(os.environ, {}, clear=True):
            with mock.patch.object(
                    os, "readlink",
                    return_value="/usr/share/zoneinfo/Asia/Calcutta"):
                self.assertEqual(fresh.local_timezone_name(), "Asia/Calcutta")

            with mock.patch.object(
                    os, "readlink",
                    return_value="../usr/share/zoneinfo/Europe/Rome"):
                self.assertEqual(fresh.local_timezone_name(), "Europe/Rome")

            with mock.patch.object(
                    os, "readlink", return_value="/etc/localtime"):
                self.assertIsNone(fresh.local_timezone_name())

            with mock.patch.object(os, "readlink", side_effect=OSError("missing")):
                self.assertIsNone(fresh.local_timezone_name())

    def test_tz_override_beats_the_localtime_link_for_reserved_clocks(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "tzdata_environment_identity", APPLET_DIR / "chronos_timezone_data.py")
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        fake_pytz = types.SimpleNamespace(
            all_timezones=["Asia/Calcutta", "Asia/Kolkata"],
            common_timezones=["Asia/Calcutta", "Asia/Kolkata"])

        with mock.patch.dict(os.environ, {"TZ": "Asia/Calcutta"}, clear=True):
            with mock.patch.object(os, "readlink") as readlink:
                resolver = fresh.TimezoneResolver(fake_pytz, None)
                self.assertIn("Asia/Calcutta", resolver.builtin_timezones)
                self.assertTrue(resolver.is_reserved("Asia/Calcutta"))
                self.assertFalse(resolver.is_reserved("Asia/Kolkata"))
                readlink.assert_not_called()

        with mock.patch.dict(
                os.environ,
                {"TZ": ":/usr/share/zoneinfo/America/New_York"}, clear=True):
            self.assertEqual(fresh.local_timezone_name(), "America/New_York")

    def test_the_local_zone_is_reserved_under_whatever_name_it_is_typed(self):
        # The applet draws a local-time row and drops any configured clock whose
        # zone resolves to the same one. The dialog blocked the word "local" but
        # happily validated, previewed and saved "America/Sao_Paulo" for a user
        # in São Paulo — and then the clock never appeared, with nothing said.
        fake_pytz = types.SimpleNamespace(
            all_timezones=["America/Sao_Paulo", "Europe/Rome"],
            common_timezones=["America/Sao_Paulo", "Europe/Rome"]
        )
        resolver = self.module.common.TimezoneResolver(
            fake_pytz, None, local_timezone="America/Sao_Paulo")

        for typed in ("America/Sao_Paulo", "america/sao_paulo", "Sao Paulo", "local"):
            self.assertTrue(resolver.is_reserved(typed), typed)
            self.assertIsNone(resolver.normalize(typed), typed)

        # a zone that is not a built-in is still perfectly fine
        self.assertFalse(resolver.is_reserved("Europe/Rome"))
        self.assertEqual(resolver.normalize("Europe/Rome"), "Europe/Rome")

    def test_the_cached_resolver_refreshes_the_local_builtin_identity(self):
        fake_pytz = types.SimpleNamespace(
            all_timezones=["America/Sao_Paulo", "Europe/Rome"],
            common_timezones=["America/Sao_Paulo", "Europe/Rome"]
        )
        local = ["America/Sao_Paulo"]
        resolver = self.module.common.TimezoneResolver(
            fake_pytz, None, local_timezone_provider=lambda: local[0])
        completions = resolver.completions

        self.assertTrue(resolver.is_reserved("America/Sao_Paulo"))
        self.assertFalse(resolver.is_reserved("Europe/Rome"))

        local[0] = "Europe/Rome"

        self.assertFalse(resolver.is_reserved("America/Sao_Paulo"))
        self.assertTrue(resolver.is_reserved("Europe/Rome"))
        self.assertIs(resolver.completions, completions,
                      "refreshing the built-ins must retain the static index")

    def test_the_dialog_says_why_a_built_in_zone_was_refused(self):
        fake_pytz = types.SimpleNamespace(
            all_timezones=["America/Sao_Paulo"], common_timezones=["America/Sao_Paulo"])
        clocks = self.module.ClocksList(
            {"value": []}, "worldclocks", object(),
            self.module.common.TimezoneResolver(
                fake_pytz, None, local_timezone="America/Sao_Paulo"))

        values = {"label": "Home", "timezone": "Sao Paulo"}
        choice = clocks.resolve_timezone_choice(values)

        self.assertTrue(choice["reserved"])
        self.assertIsNone(choice["timezone"])
        self.assertEqual(
            clocks.format_timezone_preview(values),
            "UTC and local time are already shown as built-in clocks")

    def test_timezone_resolver_uses_zoneinfo_fallback_without_pytz(self):
        with self.assertNoLogs("chronos@geraldo-netto.settings", level="WARNING"):
            resolver = self.module.common.TimezoneResolver(
                None,
                lambda: {"Europe/Rome", "America/New_York"}
            )

        self.assertFalse(resolver.has_timezone_data)
        self.assertEqual(
            [timezone for display, timezone in resolver.completions],
            ["America/New_York", "Europe/Rome"])
        self.assertEqual(resolver.normalize(" europe/rome "), "Europe/Rome")
        self.assertEqual(resolver.normalize("AMERICA/NEW_YORK"), "America/New_York")
        self.assertEqual(resolver.normalize("new york"), "America/New_York")
        self.assertIsNone(resolver.normalize("UTC"))
        self.assertIsNone(resolver.normalize("local"))
        self.assertIsNone(resolver.normalize("Mars/Olympus"))

    def test_timezone_resolver_trusts_typed_values_when_no_timezone_source_exists(self):
        resolver = self.module.common.TimezoneResolver(None, None)

        self.assertFalse(resolver.has_timezone_data)
        self.assertEqual(resolver.completions, [])
        # T814: the zone directory is tzdata's, not Python's, so it is there to
        # be asked even here - and a name it does not hold is not a zone.
        self.assertIsNone(resolver.normalize(" Mars/Olympus "))
        self.assertIsNone(resolver.normalize("UTC"))
        self.assertIsNone(resolver.normalize("local"))
        self.assertIsNone(resolver.normalize(None))

    def test_a_zone_shaped_sentence_is_not_a_zone_with_no_database(self):
        """With neither pytz nor zoneinfo, looks_like_iana is the *only* check a
        typed timezone gets before it is saved — and its character rule (letters,
        digits, _ + -) was never exercised: every no-db input in this file either
        passed both rules or was rejected by the segment-count rule first. Mutating
        the character rule to `return True` left the Python suite green, so a
        settings dialog with no tz database would have accepted "Area/City baz" and
        written it to the config, where the applet renders it as an italic
        "Invalid timezone" row with nothing connecting the two.
        """
        resolver = self.module.common.TimezoneResolver(None, None)

        # right shape, wrong characters: a space, and then the punctuation an
        # identifier never carries
        self.assertIsNone(resolver.normalize("Area/City baz"))
        self.assertIsNone(resolver.normalize("Europe/Rome; rm -rf"))
        self.assertIsNone(resolver.normalize("Europe/Ro me"))
        self.assertIsNone(resolver.normalize("Europe/Rome!"))
        self.assertIsNone(resolver.normalize("Europe//Rome"), "an empty segment is not a city")

        # and the shape that is an identifier still gets through, punctuation and
        # all: GMT+3 and Port-au-Prince are real
        self.assertEqual(resolver.normalize("Etc/GMT+3"), "Etc/GMT+3")
        self.assertEqual(resolver.normalize("America/Port-au-Prince"), "America/Port-au-Prince")
        self.assertEqual(resolver.normalize("America/Argentina/Buenos_Aires"),
                         "America/Argentina/Buenos_Aires")

    @requires_pytz
    def test_normalize_timezone_accepts_identifier_or_city(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())

        self.assertEqual(clocks.normalize_timezone(" europe/rome "), "Europe/Rome")
        self.assertEqual(clocks.normalize_timezone("new york"), "America/New_York")
        self.assertEqual(
            clocks.normalize_timezone("buenos aires"), "America/Argentina/Buenos_Aires")
        self.assertIn(
            ("Buenos Aires (America / Argentina)", "America/Argentina/Buenos_Aires"),
            clocks.completions)
        self.assertIsNone(clocks.normalize_timezone(""))
        self.assertIsNone(clocks.normalize_timezone("Not A Timezone"))

    @requires_pytz
    def test_normalize_timezone_fuzzes_case_and_spaces(self):
        random.seed(FUZZ_SEED)
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        samples = ["Europe/Rome", "America/New_York", "Asia/Tokyo", "Australia/Sydney"]

        for timezone in samples:
            for _ in range(10):
                noisy = "".join(
                    char.upper() if random.choice([True, False]) else char.lower()
                    for char in timezone
                )
                self.assertEqual(clocks.normalize_timezone(f" {noisy} "), timezone)

    @requires_pytz
    def test_normalize_timezone_uses_precomputed_maps(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        # the resolver is built on first use — which is what opening the World
        # Clocks page does — and the maps are precomputed then, once
        clocks.timezone_resolver  # noqa: B018

        class ExplodingTimezones:
            def __iter__(self):
                raise AssertionError("normalize_timezone should not scan pytz lists")

        original_all = self.module.common.pytz.all_timezones
        original_common = self.module.common.pytz.common_timezones
        try:
            self.module.common.pytz.all_timezones = ExplodingTimezones()
            self.module.common.pytz.common_timezones = ExplodingTimezones()

            self.assertEqual(clocks.normalize_timezone("europe/rome"), "Europe/Rome")
            self.assertEqual(clocks.normalize_timezone("new york"), "America/New_York")
            self.assertIsNone(clocks.normalize_timezone("Not A Timezone"))
        finally:
            self.module.common.pytz.all_timezones = original_all
            self.module.common.pytz.common_timezones = original_common

    @requires_pytz
    def test_timezone_choice_previews_saved_value(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())

        typed = {"label": "Work", "timezone": "Asia/Tokyo"}
        self.assertEqual(clocks.resolve_timezone_choice(typed), {
            "timezone": "Asia/Tokyo",
            "typed_invalid": False,
            "reserved": False,
            "duplicate": False
        })
        self.assertEqual(
            clocks.format_timezone_preview(typed),
            "Timezone to save: Asia/Tokyo"
        )

        city = {"label": "Work", "timezone": "buenos aires"}
        self.assertEqual(
            clocks.format_timezone_preview(city),
            "Timezone to save: America/Argentina/Buenos_Aires"
        )

        empty = {"label": "Work", "timezone": ""}
        self.assertEqual(clocks.format_timezone_preview(empty), "No timezone selected")

        missing = {"label": "Work", "timezone": "Not A Timezone"}
        self.assertEqual(clocks.resolve_timezone_choice(missing), {
            "timezone": None,
            "typed_invalid": True,
            "reserved": False,
            "duplicate": False
        })
        self.assertEqual(clocks.format_timezone_preview(missing), "Invalid timezone")

    @requires_pytz
    def test_timezone_choice_fuzzes_invalid_text(self):
        random.seed(FUZZ_SEED)
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 "

        for _ in range(40):
            text = "Invalid-" + "".join(random.choice(alphabet) for _ in range(12))

            choice = clocks.resolve_timezone_choice({"label": "Home", "timezone": text})

            self.assertIsNone(choice["timezone"])
            self.assertTrue(choice["typed_invalid"])

    @requires_pytz
    def test_timezone_choice_rejects_reserved_builtin_ids(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())

        for text in ("UTC", " utc ", "local", "Etc/UTC"):
            values = {"label": "Duplicate", "timezone": text}
            self.assertEqual(clocks.resolve_timezone_choice(values), {
                "timezone": None,
                "typed_invalid": True,
                "reserved": True,
                "duplicate": False
            })
            self.assertEqual(
                clocks.format_timezone_preview(values),
                "UTC and local time are already shown as built-in clocks"
            )

    def test_add_dialog_blocks_at_max_clocks(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings())
        clocks.model = Model(self.module.MAX_CLOCKS)

        result = clocks.open_add_edit_dialog()

        self.assertIsNone(result)
        self.assertEqual(len(GtkMessageDialog.instances), 1)
        message = GtkMessageDialog.instances[0]
        self.assertIn(str(self.module.MAX_CLOCKS), message.args[-1])
        self.assertTrue(message.ran)
        self.assertTrue(message.destroyed)

    def test_timezone_choice_rejects_a_saved_clock_but_allows_its_edit(self):
        saved = [
            {"label": "Tokyo", "timezone": "Asia/Tokyo"},
            {"label": "Rome", "timezone": "Europe/Rome"},
        ]
        fake_pytz = types.SimpleNamespace(
            all_timezones=["Asia/Tokyo", "Europe/Rome"],
            common_timezones=["Asia/Tokyo", "Europe/Rome"])
        clocks = self.module.ClocksList(
            {"value": saved}, "worldclocks", DialogSettings(),
            self.module.common.TimezoneResolver(fake_pytz, None))
        values = {"label": "Other Tokyo", "timezone": " asia/tokyo "}

        choice = clocks.resolve_timezone_choice(values)
        self.assertTrue(choice["duplicate"])
        self.assertTrue(choice["typed_invalid"])
        self.assertIsNone(choice["timezone"])
        self.assertEqual(
            clocks.format_timezone_preview(values, choice),
            self.module.TIMEZONE_DUPLICATE_PREVIEW)

        unchanged = clocks.resolve_timezone_choice(values, "Asia/Tokyo")
        self.assertFalse(unchanged["duplicate"])
        self.assertEqual(unchanged["timezone"], "Asia/Tokyo")
        changed = clocks.resolve_timezone_choice(
            {"label": "Tokyo", "timezone": "Europe/Rome"}, "Asia/Tokyo")
        self.assertTrue(changed["duplicate"],
                        "an edit may keep its own zone, not take another row's")

    def test_timezone_choice_compares_reduced_zoneinfo_identities(self):
        saved = [{"label": "Rome", "timezone": ":Europe/Rome"}]
        fake_pytz = types.SimpleNamespace(
            all_timezones=["Europe/Rome"],
            common_timezones=["Europe/Rome"])
        clocks = self.module.ClocksList(
            {"value": saved}, "worldclocks", DialogSettings(),
            self.module.common.TimezoneResolver(fake_pytz, None))
        values = {"label": "Other Rome", "timezone": "Europe/Rome"}

        choice = clocks.resolve_timezone_choice(values)
        self.assertTrue(choice["duplicate"],
                        "TZ-style and plain spellings are one runtime clock")
        self.assertIsNone(choice["timezone"])

        unchanged = clocks.resolve_timezone_choice(values, ":Europe/Rome")
        self.assertFalse(unchanged["duplicate"],
                         "an edit may normalize its own saved spelling")
        self.assertEqual(unchanged["timezone"], "Europe/Rome")

    @requires_pytz
    def test_add_dialog_gates_ok_and_returns_normalized_timezone(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings())

        def script(dialog):
            widgets = {w.kwargs["label"]: w for w in BaseWidget.instances}
            # nothing entered yet: OK must start insensitive
            self.assertEqual(dialog.sensitivity[-1], (1, False))

            label = widgets["Display name"]
            label.bind_object.set_property(label.bind_prop, "Home")
            label.bind_object.emit_changed()
            self.assertEqual(dialog.sensitivity[-1], (1, False))

            timezone = widgets["Timezone"]
            timezone.bind_object.set_property(timezone.bind_prop, " asia/tokyo ")
            timezone.bind_object.emit_changed()
            self.assertEqual(dialog.sensitivity[-1], (1, True))
            return 1  # ResponseType.OK

        GtkDialog.on_run = script
        result = clocks.open_add_edit_dialog()

        self.assertEqual(result, ["Home", "Asia/Tokyo"])

    @requires_pytz
    def test_edit_dialog_seeds_the_saved_timezone_and_keeps_it_on_ok(self):
        clocks = self.module.ClocksList({
            "value": [{"label": "Tokyo", "timezone": "Asia/Tokyo"}]
        }, "worldclocks", DialogSettings())

        seeded = {}

        def script(dialog):
            widgets = {w.kwargs["label"]: w for w in BaseWidget.instances}
            self.assertEqual(
                sorted(widgets),
                sorted(["Display name", "Timezone"]))

            timezone = widgets["Timezone"]
            seeded["timezone"] = timezone.get_widget_value()
            return 1  # ResponseType.OK

        GtkDialog.on_run = script
        result = clocks.open_add_edit_dialog(["Tokyo", "Asia/Tokyo"])

        self.assertEqual(seeded, {"timezone": "Asia/Tokyo"})
        self.assertEqual(result, ["Tokyo", "Asia/Tokyo"])

    def test_dialog_rechecks_local_timezone_and_accepts_a_corrected_choice(self):
        local = ["Antarctica/Troll"]
        zones = types.SimpleNamespace(all_timezones=["Europe/Rome", "Asia/Tokyo"],
                                      common_timezones=["Europe/Rome", "Asia/Tokyo"])
        resolver = self.module.common.TimezoneResolver(
            zones, None, local_timezone_provider=lambda: local[0])
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings(), resolver)
        runs = []

        def script(dialog):
            runs.append(dialog)
            widgets = {widget.kwargs["label"]: widget for widget in BaseWidget.instances}
            timezone = widgets["Timezone"]
            if len(runs) == 1:
                self.assertEqual(dialog.sensitivity[-1], (1, True))
                local[0] = "Europe/Rome"
                return 1
            self.assertEqual(len(runs), 2)
            self.assertFalse(dialog.destroyed)
            self.assertEqual(dialog.sensitivity[-1], (1, False))
            self.assertEqual(timezone.bind_object.get_accessible().description,
                             self.module.TIMEZONE_RESERVED_PREVIEW)
            timezone.set_widget_value("Asia/Tokyo")
            timezone.bind_object.emit_changed()
            return 1

        GtkDialog.on_run = script
        self.assertEqual(clocks.open_add_edit_dialog(["Home", "Europe/Rome"]), ["Home", "Asia/Tokyo"])
        self.assertEqual(len(runs), 2)
        self.assertTrue(runs[-1].destroyed)

    def test_dialog_rechecks_external_duplicates_and_allows_cancellation(self):
        zones = types.SimpleNamespace(all_timezones=["Europe/Rome"], common_timezones=["Europe/Rome"])
        resolver = self.module.common.TimezoneResolver(zones, None, local_timezone="Antarctica/Troll")
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings(), resolver)
        runs = []

        def script(dialog):
            runs.append(dialog)
            widgets = {widget.kwargs["label"]: widget for widget in BaseWidget.instances}
            if len(runs) == 1:
                widgets["Display name"].set_widget_value("Home")
                widgets["Timezone"].set_widget_value("Europe/Rome")
                widgets["Timezone"].bind_object.emit_changed()
                self.assertEqual(dialog.sensitivity[-1], (1, True))
                clocks.model.rows = [{"label": "Other", "timezone": "Europe/Rome"}]
                return 1
            self.assertEqual(len(runs), 2)
            self.assertFalse(dialog.destroyed)
            self.assertEqual(dialog.sensitivity[-1], (1, False))
            self.assertEqual(widgets["Timezone"].bind_object.get_accessible().description,
                             self.module.TIMEZONE_DUPLICATE_PREVIEW)
            return 0

        GtkDialog.on_run = script
        self.assertIsNone(clocks.open_add_edit_dialog())
        self.assertEqual(len(runs), 2)
        self.assertTrue(runs[-1].destroyed)

    @requires_pytz
    def test_timezone_entry_completes_a_typed_city_name(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings())

        completed = {}

        def script(dialog):
            widgets = {w.kwargs["label"]: w for w in BaseWidget.instances}
            timezone = widgets["Timezone"]
            completion = timezone.completion

            completed["matches"] = completion.matches("buenos ai")
            completion.select(completion.matches_index("America/Argentina/Buenos_Aires"))
            completed["text"] = timezone.get_widget_value()
            return 0  # ResponseType.CANCEL

        GtkDialog.on_run = script
        clocks.open_add_edit_dialog()

        # asserted as a membership, not as the whole list: this runs against the
        # real pytz, and a tzdata build that still carries the pre-1993
        # America/Buenos_Aires alias offers it here too. The city completing at all
        # is the behaviour; how many spellings of it the host knows is not.
        self.assertIn("America/Argentina/Buenos_Aires", completed["matches"])
        self.assertTrue(
            all("Buenos_Aires" in match for match in completed["matches"]),
            completed["matches"])
        # picking a suggestion writes the identifier, not the pretty label
        self.assertEqual(completed["text"], "America/Argentina/Buenos_Aires")

    def test_add_dialog_without_pytz_accepts_typed_timezone(self):
        module = load_module(WORLDCLOCKS_PATH, "settings_widgets_common_dialog_no_pytz", missing_pytz=True)
        module.common.available_timezones = lambda: {"Europe/Rome"}
        clocks = module.ClocksList({"value": []}, "worldclocks", DialogSettings())

        def script(dialog):
            widgets = {w.kwargs["label"]: w for w in BaseWidget.instances}
            self.assertEqual(
                sorted(widgets),
                sorted(["Display name", "Timezone"]))

            label = widgets["Display name"]
            label.bind_object.set_property(label.bind_prop, "Somewhere")
            label.bind_object.emit_changed()

            timezone = widgets["Timezone"]
            # zoneinfo still validates typed entries without pytz
            timezone.bind_object.set_property(timezone.bind_prop, "Mars/Olympus")
            timezone.bind_object.emit_changed()
            self.assertEqual(dialog.sensitivity[-1], (1, False))

            timezone.bind_object.set_property(timezone.bind_prop, "europe/rome")
            timezone.bind_object.emit_changed()
            self.assertEqual(dialog.sensitivity[-1], (1, True))
            return 1  # ResponseType.OK

        GtkDialog.on_run = script
        result = clocks.open_add_edit_dialog()

        self.assertEqual(result, ["Somewhere", "Europe/Rome"])

    def test_dialog_reads_columns_from_its_own_settings_key(self):
        settings = DialogSettings()
        clocks = self.module.ClocksList({"value": []}, "renamed-clocks", settings)

        clocks.open_add_edit_dialog()  # default run() cancels

        self.assertEqual(settings.requested, [("renamed-clocks", "columns")])

    def test_missing_pytz_degrades_to_plain_timezone_entry(self):
        module = load_module(WORLDCLOCKS_PATH, "settings_widgets_common_no_pytz_test", missing_pytz=True)
        module.common.available_timezones = lambda: {"Europe/Rome"}
        clocks = module.ClocksList({
            "value": [{"label": "Rome", "timezone": "Europe/Rome"}]
        }, "worldclocks", object())

        self.assertIsNone(module.common.pytz)
        self.assertFalse(clocks.timezone_resolver.has_timezone_data)
        # zoneinfo still feeds the suggestions and validates typed entries
        self.assertIn(
            ("Rome (Europe)", "Europe/Rome"), clocks.completions)
        self.assertEqual(clocks.normalize_timezone(" Europe/Rome "), "Europe/Rome")
        self.assertEqual(clocks.normalize_timezone("europe/rome"), "Europe/Rome")
        self.assertEqual(clocks.normalize_timezone("rome"), "Europe/Rome")
        self.assertIsNone(clocks.normalize_timezone("Mars/Olympus"))
        self.assertEqual(
            module.TIMEZONE_TEXT_HINT, "City or timezone (e.g. Buenos Aires)")

    def test_the_typing_hint_sits_in_the_field_not_in_its_label(self):
        # The hint was used as the field's *label*, so the dialog named the field
        # with a sentence while the column heading above it said "Timezone" - two
        # names for one thing. It was also already translated, and the factory
        # translated it again: the second lookup missed and handed it back
        # unchanged, which worked by accident.
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings())
        captured = {}

        def script(dialog):
            captured.update({widget.kwargs["label"]: widget for widget in BaseWidget.instances})
            return 0  # cancel

        GtkDialog.on_run = script
        clocks.open_add_edit_dialog()

        self.assertIn("Timezone", captured, "the column heading names the field")
        entry = captured["Timezone"]
        self.assertEqual(
            entry.content_widget.placeholder,
            "City or timezone (e.g. Buenos Aires)",
            "and the hint about what to type sits inside the empty field")

    def test_with_no_timezone_database_at_all_only_an_identifier_is_accepted(self):
        # neither pytz nor zoneinfo: anything typed used to be handed straight
        # back and saved, so the dialog accepted gibberish and the applet showed
        # an italic "Invalid timezone" row later, with nothing connecting the two
        module = load_module(WORLDCLOCKS_PATH, "settings_widgets_common_no_tzdata_test", missing_pytz=True)
        resolver = module.common.TimezoneResolver(None, None)

        self.assertFalse(resolver.any_timezone_data())
        self.assertEqual(resolver.normalize("America/Sao_Paulo"), "America/Sao_Paulo")
        self.assertEqual(resolver.normalize("America/Argentina/Buenos_Aires"),
                         "America/Argentina/Buenos_Aires")
        self.assertIsNone(resolver.normalize("gibberish"))
        self.assertIsNone(resolver.normalize("not a zone at all"))
        self.assertIsNone(resolver.normalize("a/b/c/d"))

    def test_the_dialog_says_which_field_is_missing(self):
        # OK is insensitive until both fields are right, and the preview only
        # ever spoke about the timezone: a valid timezone with an empty name gave
        # a happy preview and a dead OK button
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        dialog = GtkDialog()
        preview = GtkLabel()
        presenter = self.module.ClockDialogStatePresenter(clocks, dialog, preview)

        widgets = {
            "label": self.module.list_edit_factory({"title": "Display name"}),
            "timezone": self.module.list_edit_factory({"title": "Timezone"}),
        }
        widgets["timezone"].set_widget_value("Europe/Rome")

        presenter.update(widgets)
        self.assertEqual(preview.text, self.module.LABEL_MISSING_PREVIEW)
        self.assertIn((1, False), dialog.sensitivity)   # Gtk.ResponseType.OK

        widgets["label"].set_widget_value("Rome")
        presenter.update(widgets)
        self.assertEqual(preview.text, self.module.TIMEZONE_PREVIEW_TEMPLATE % "Europe/Rome")
        self.assertIn((1, True), dialog.sensitivity)

    def test_missing_timezone_data_logs_install_help(self):
        module = load_module(WORLDCLOCKS_PATH, "settings_widgets_common_no_pytz_log_test", missing_pytz=True)

        # Warned when the resolver is built, not at import: importing a module
        # should define things, not emit them. At import time cinnamon-settings
        # has not configured logging yet, so the warning landed on the whole
        # process's stderr or was dropped, depending on import order.
        with self.assertLogs("chronos@geraldo-netto.settings", level="WARNING") as logs:
            module.common.TimezoneResolver(None, None)

        message = "\n".join(logs.output)
        self.assertIn("No Python timezone database is available", message)
        self.assertIn("sudo apt install python3-pytz", message)
        self.assertIn("python3 -m pip install pytz", message)


    def test_list_edit_factory_entry_gets_a_completion_when_offered(self):
        widget = self.module.list_edit_factory({
            "title": "City or timezone",
            "completions": [("Rome (Europe)", "Europe/Rome")],
        })

        self.assertIsInstance(widget, Entry)
        self.assertIs(widget.completion, widget.bind_object.completion)
        # the third column is the folded text the match function searches: GTK
        # calls that function for every row on every keystroke, so the folding
        # happens once, here, rather than 600 times per character
        self.assertEqual(
            widget.completion.model.rows,
            [["Rome (Europe)", "Europe/Rome", "rome (europe) europe/rome"]])

    def test_the_suggestion_model_is_shared_by_every_settings_page(self):
        # The memo was keyed by id(completions) and held a strong reference to the
        # list and its ListStore, with no eviction. Every ClocksList builds its own
        # resolver and therefore its own completions list, so the memo never hit
        # across instances: it accumulated one 439-row store per settings page ever
        # opened, for the life of the cinnamon-settings process. A cache that
        # cannot hit is a leak wearing a cache's clothes.
        self.module.common._COMPLETION_MODELS.clear()

        rome = self.module.timezone_completion_model([("Rome (Europe)", "Europe/Rome")])
        self.assertEqual(rome.rows[0][1], "Europe/Rome")

        # a *different list object* with the same contents — which is what the next
        # settings page builds — reads back the same model
        again = self.module.timezone_completion_model([("Rome (Europe)", "Europe/Rome")])
        self.assertIs(again, rome, "the store is built once for the whole process")
        self.assertEqual(len(self.module.common._COMPLETION_MODELS), 1)

        # and different suggestions are a different model, not a stranger's
        tokyo = self.module.timezone_completion_model([("Tokyo (Asia)", "Asia/Tokyo")])
        self.assertEqual(tokyo.rows[0][1], "Asia/Tokyo")
        self.assertEqual(len(self.module.common._COMPLETION_MODELS), 2)

    def test_version_wrappers_export_common_symbols(self):
        wrapper_52 = load_module(APPLET_DIR / "6.0" / "settings_widgets.py", "settings_widgets_52_test")

        # The shim exports the names the schema asks Cinnamon to instantiate —
        # exactly those. create_custom_widget does getattr(module, widget) and
        # dies on the whole settings window if the name is not there, so the
        # schema is what this has to be checked against, not a list written here.
        schema = json.loads((APPLET_DIR / "6.0" / "settings-schema.json").read_text())
        named = sorted({entry["widget"] for entry in schema.values()
                        if isinstance(entry, dict) and entry.get("type") == "custom"})
        self.assertEqual(sorted(wrapper_52.__all__), named)

        # feature widgets stay in their feature modules; the option-label combo
        # is shared by weather and holiday-region settings
        homes = {
            "AdditionalCountryList": "chronos_settings_widgets_calendars",
            "AvailableReligionSwitch": "chronos_settings_widgets_calendars",
            "CalendarPluginChoices": "chronos_settings_widgets_calendars",
            "ClocksList": "chronos_settings_widgets_worldclocks",
            "CountryComboBox": "chronos_settings_widgets_holidays",
            "OptionLabelComboBox": "chronos_settings_widgets_common",
            "WeatherLocationEntry": "chronos_settings_widgets_weather",
        }
        for widget in named:
            self.assertEqual(getattr(wrapper_52, widget).__module__, homes[widget])

        # list_edit_factory was re-exported here and never imported from here
        self.assertFalse(hasattr(wrapper_52, "list_edit_factory"),
                         "the shim is the widgets Cinnamon names, and nothing else")

    def test_foreign_generic_modules_cannot_intercept_widget_imports(self):
        generic_names = [
            "timezone_data",
            "settings_i18n",
            "settings_widgets_common",
            "settings_widgets_holidays",
            "settings_widgets_weather",
            "settings_widgets_worldclocks",
        ]
        foreign = {name: types.ModuleType(name) for name in generic_names}
        wrapper = load_module(
            APPLET_DIR / "6.0" / "settings_widgets.py",
            "settings_widgets_52_collision_test",
            preload=foreign,
        )

        for widget in wrapper.__all__:
            self.assertTrue(getattr(wrapper, widget).__module__.startswith("chronos_"),
                            "a generic sys.modules entry intercepted Chronos")

    def test_the_shim_puts_the_applet_dir_on_the_path_when_it_is_missing(self):
        """The shim's whole job: cinnamon-settings imports it by the schema's
        name, with the applet directory nowhere on sys.path, and it has to make
        `from chronos_settings_widgets_common import …` resolve. Every other test loads it
        with the directory already on the path — the harness puts it there — so
        the one line that does the job never ran, and the coverage gate could not
        see it because it did not look inside 6.0/ at all.
        """
        install_stubs()
        applet_dir = str(APPLET_DIR)
        saved_path = list(sys.path)
        saved_modules = dict(sys.modules)
        sys.path = [entry for entry in sys.path if entry != applet_dir]
        try:
            spec = importlib.util.spec_from_file_location(
                "settings_widgets_52_path_test", APPLET_DIR / "6.0" / "settings_widgets.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            self.assertIn(applet_dir, sys.path,
                          "the shim did not make its own siblings importable")
            # appended, never inserted at 0: this runs inside the shared
            # cinnamon-settings process, and a directory at the front of sys.path
            # would shadow the standard library for everything else in it
            self.assertEqual(sys.path[-1], applet_dir)
            self.assertEqual(sorted(module.__all__),
                             ["AdditionalCountryList", "AvailableReligionSwitch", "CalendarPluginChoices", "ClocksList",
                              "CountryComboBox", "OptionLabelComboBox", "WeatherLocationEntry"])
        finally:
            sys.path = saved_path
            for name in set(sys.modules) - set(saved_modules):
                del sys.modules[name]


class CompletionInputBoundsTest(unittest.TestCase):
    """T734: the timezone entry was unbounded and the needle was folded per row."""

    @classmethod
    def setUpClass(cls):
        cls.module = load_module(WORLDCLOCKS_PATH, "settings_widgets_bounds_test")
        cls.common = load_module(COMMON_PATH, "settings_widgets_bounds_common_test")

    def test_the_timezone_entry_is_bounded_like_the_label_column(self):
        # The label column has always carried a max_length and this one did not,
        # so ListEditEntry's `if max_length` guard skipped set_max_length and the
        # entry accepted arbitrary text — which the match func then scanned once
        # per row of the several-hundred-row model, per keystroke, on the GTK
        # main thread. No IANA identifier exceeds a few dozen characters.
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings())
        lengths = {}

        def script(dialog):
            for widget in BaseWidget.instances:
                lengths[widget.kwargs["label"]] = widget.bind_object.max_length
            return 0  # ResponseType.CANCEL

        GtkDialog.on_run = script
        clocks.open_add_edit_dialog()

        self.assertEqual(lengths["Timezone"], self.common.MAX_COMPLETION_INPUT_LENGTH)
        self.assertEqual(lengths["Display name"], self.module.MAX_CLOCK_INPUT_LABEL_LENGTH)
        # comfortably clear of the longest real identifier
        self.assertGreater(
            self.common.MAX_COMPLETION_INPUT_LENGTH,
            len("America/Argentina/ComodRivadavia"))

    def test_the_needle_is_folded_once_per_keystroke_not_once_per_row(self):
        # Both matchers' docstrings claimed "the needle is folded once by the
        # caller" while calling completion_key() per row — three fresh copies of
        # the whole key for each of ~600 rows, on every character typed.
        folds = []
        original = self.common.completion_key

        def counting_fold(text):
            folds.append(text)
            return original(text)

        with mock.patch.object(self.common, "completion_key", counting_fold):
            self.common._COMPLETION_KEYS.clear()
            model = [["Rome", "Europe/Rome", "rome europe/rome"]] * 600
            for row in range(len(model)):
                self.common.plain_completion_match(None, "rom", row, model)

            self.assertEqual(folds, ["rom"], "600 rows, one fold")

            # a new keystroke folds again
            self.common.plain_completion_match(None, "rome", 0, model)
            self.assertEqual(folds, ["rom", "rome"])

        # and the result is unchanged either way
        self.common._COMPLETION_KEYS.clear()
        model = [["Rome", "Europe/Rome", "rome europe/rome"]]
        self.assertTrue(self.common.plain_completion_match(None, "ROM", 0, model))
        self.assertFalse(self.common.plain_completion_match(None, "oslo", 0, model))
        self.assertFalse(self.common.plain_completion_match(None, "   ", 0, model))
        self.assertFalse(self.common.plain_completion_match(None, None, 0, model))

    def test_interleaved_completion_fields_share_a_bounded_recent_key_cache(self):
        self.common._COMPLETION_KEYS.clear()
        with mock.patch.object(self.common, "completion_key", wraps=self.common.completion_key) as fold:
            for _row in range(100):
                self.assertEqual(self.common.folded_completion_key("Rome"), "rome")
                self.assertEqual(self.common.folded_completion_key("Italy"), "italy")
            self.assertEqual(fold.call_count, 2)
            for index in range(self.common.MAX_COMPLETION_KEYS):
                self.common.folded_completion_key(str(index))
            self.assertEqual(len(self.common._COMPLETION_KEYS), self.common.MAX_COMPLETION_KEYS)
            self.assertNotIn("Rome", self.common._COMPLETION_KEYS)
            self.common.folded_completion_key("0")
            self.common.folded_completion_key("new")
            self.assertIn("0", self.common._COMPLETION_KEYS)
            self.assertNotIn("1", self.common._COMPLETION_KEYS)
        self.common.folded_completion_key("x" * 1000)
        self.common.folded_completion_key(None)
        self.assertEqual(len(self.common._COMPLETION_KEYS), self.common.MAX_COMPLETION_KEYS)
