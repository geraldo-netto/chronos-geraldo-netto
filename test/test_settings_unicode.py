"""Shared Unicode boundary cases and recoverable settings updates."""

from copy import deepcopy
import json
from pathlib import Path

from helpers.settings_widgets_fixture import (
    APPLET_DIR, FakeSettings, HOLIDAYS_PATH, WEATHER_PATH, WORLDCLOCKS_PATH,
    load_gi_free_module, load_module, tearDownModule as teardown_fixture, unittest,
)


FIXTURE = json.loads((Path(__file__).parent / "fixtures/settings_unicode_cases.json").read_text())


def tearDownModule():
    teardown_fixture()


class FilenameDisplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = load_gi_free_module(APPLET_DIR / "chronos_text.py", "filename_text")

    def test_T1150_native_text_refusal_preserves_unicode_scalar_validity(self):
        fixture = json.loads((Path(__file__).parent / "fixtures/timezone_nul_cases.json").read_text())
        for value in fixture["invalid"]:
            self.assertTrue(self.text.valid_unicode(value))
            self.assertFalse(self.text.valid_native_text(value))
        for value in fixture["valid"]:
            self.assertTrue(self.text.valid_native_text(value))
        for value in (None, False, 1, [], {}, "\ud800", "\udfff"):
            self.assertFalse(self.text.valid_native_text(value))
        for value in ("", "🏙", "a\nb", "\ufeffa\ufeff"):
            self.assertTrue(self.text.valid_native_text(value))

    def test_shared_filename_projection_is_bounded_and_utf8_encodable(self):
        cases = json.loads((Path(__file__).parent / "fixtures/calendar_filename_cases.json").read_text())
        for case in cases:
            normalized = self.text.filename_display_text(case["filename"])
            self.assertEqual(normalized, case["display"])
            normalized.encode("utf-8")
            self.assertLessEqual(len(normalized), 100)

    def test_filename_boundaries_preserve_valid_text_and_refuse_nontext(self):
        for value in (None, [], {}, False, 0):
            self.assertEqual(self.text.filename_display_text(value), "")
        for length in (0, 1, 99, 100, 101, 255, 4096):
            source = "🏙" * length
            expected = source if length <= 100 else "🏙" * 99 + "…"
            self.assertEqual(self.text.filename_display_text(source), expected)
        self.assertEqual(self.text.filename_display_text("\ufeff a\n\r\u202eb \ufeff"), "a b")

    def test_filename_controls_follow_the_shared_runtime_policy(self):
        cases = json.loads((Path(__file__).parent / "fixtures/control_character_cases.json").read_text())
        for case in cases["removed"]:
            self.assertEqual(self.text.filename_display_text("a" + chr(case["codePoint"]) + "b"), "a b")
        for case in cases["kept"]:
            source = "a" + chr(case["codePoint"]) + "b"
            self.assertEqual(self.text.filename_display_text(source), source)


class SettingsUnicodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.clocks = load_module(WORLDCLOCKS_PATH, "unicode_clocks")
        cls.weather = load_module(WEATHER_PATH, "unicode_weather")
        cls.countries = load_module(HOLIDAYS_PATH, "unicode_countries")

    def test_shared_text_cases_preserve_valid_scalars_and_refuse_surrogates(self):
        for case in FIXTURE["text"]:
            with self.subTest(case=case):
                raw = case["input"]
                expected = raw if case["valid"] else ""
                self.assertEqual(self.clocks.valid_unicode(raw), case["valid"])
                self.assertEqual(self.clocks.normalize_clock_label(raw), expected)
                self.assertEqual(self.weather.normalize_weather_location(raw), expected)
                diagnostic = self.countries.common.diagnostic_text(raw)
                self.assertEqual(diagnostic, case["diagnostic"])
                diagnostic.encode("utf-8")

    def weather_entry(self, value):
        settings = FakeSettings({"weather-location": value})
        widget = self.weather.WeatherLocationEntry({}, "weather-location", settings)
        set_text = widget.content_widget.set_text

        def change_text(text):
            set_text(text)
            widget.content_widget.emit_changed()

        widget.content_widget.set_text = change_text
        return widget, settings

    def assert_refused_weather(self, widget, settings, original, reason="invalid Unicode"):
        self.assertEqual(widget.content_widget.get_text(), "")
        self.assertIn("error", widget.bind_object.get_style_context().classes)
        self.assertIn(reason, widget.bind_object.get_accessible().description)
        widget.on_edit_end()
        self.assertEqual(settings.get_value("weather-location"), original)

    def test_weather_refusal_survives_load_and_updates_until_a_valid_replacement(self):
        for case in FIXTURE["text"]:
            if case["valid"]:
                continue
            with self.subTest(value=case["input"]):
                raw = case["input"]
                widget, settings = self.weather_entry(raw)
                self.assert_refused_weather(widget, settings, raw)
                self.assertEqual(settings.writes, [])
                widget.content_widget.set_text("Genoa 🏙")
                widget.on_edit_end()
                self.assertEqual(settings.writes, [("weather-location", "Genoa 🏙")])
                self.assertNotIn("error", widget.bind_object.get_style_context().classes)
                settings.set_value("weather-location", raw)
                before = deepcopy(settings.writes)
                self.assert_refused_weather(widget, settings, raw)
                self.assertEqual(settings.writes, before)
                settings.set_value("weather-location", "Plzeň")
                self.assertEqual(widget.content_widget.get_text(), "Plzeň")

    def test_invalid_direct_commit_preserves_the_previous_location(self):
        widget, settings = self.weather_entry("Genova")
        self.assertEqual(widget.commit("\ud800"), "")
        self.assertEqual(settings.get_value("weather-location"), "Genova")
        self.assertEqual(settings.writes, [])
        self.assertIn("invalid Unicode", widget.bind_object.get_accessible().description)

    def assert_edit_end_preserves_weather(self, widget, settings, raw):
        before = deepcopy(settings.writes)
        handlers = dict(widget.content_widget.handlers)
        for signal in ("activate", "focus-out-event"):
            self.assertFalse(handlers[signal](widget.content_widget, None))
            self.assertEqual(settings.get_value("weather-location"), raw)
            self.assertEqual(settings.writes, before)

    def test_nul_locations_are_refused_on_load_updates_and_both_edit_end_signals(self):
        for case in FIXTURE["weatherNul"]:
            raw = case["input"]
            self.assertEqual(self.weather.normalize_weather_location(raw), raw if case["valid"] else "")
            if case["valid"]:
                continue
            widget, settings = self.weather_entry(raw)
            self.assert_refused_weather(widget, settings, raw, case["refusal"])
            self.assert_edit_end_preserves_weather(widget, settings, raw)
            self.assertEqual(settings.writes, [])
            settings.set_value("weather-location", "Genova")
            settings.set_value("weather-location", raw)
            self.assert_refused_weather(widget, settings, raw, case["refusal"])
            self.assert_edit_end_preserves_weather(widget, settings, raw)
            before = len(settings.writes)
            widget.content_widget.set_text("Plzeň")
            widget.on_edit_end()
            self.assertEqual(settings.writes[before:], [("weather-location", "Plzeň")])
            self.assertNotIn("error", widget.bind_object.get_style_context().classes)

    def test_direct_nul_commit_refuses_without_changing_the_stored_location(self):
        widget, settings = self.weather_entry("Genova")
        self.assertEqual(widget.commit("Gen\0ova"), "")
        self.assertEqual(settings.get_value("weather-location"), "Genova")
        self.assertEqual(settings.writes, [])
        self.assertIn("null character", widget.bind_object.get_accessible().description)

    def test_clock_construction_and_external_updates_keep_valid_neighbors(self):
        raw = deepcopy(FIXTURE["savedClocks"])
        settings = FakeSettings({"worldclocks": raw})
        widget = self.clocks.ClocksList({"value": raw}, "worldclocks", settings)
        self.assertEqual(settings.get_value("worldclocks"), FIXTURE["selectedClocks"])
        self.assertEqual(widget.model.rows, FIXTURE["selectedClocks"])
        settings.set_value("worldclocks", deepcopy(raw))
        widget.on_setting_changed()
        self.assertEqual(settings.get_value("worldclocks"), FIXTURE["selectedClocks"])
        self.assertEqual(widget.model.rows, FIXTURE["selectedClocks"])
        self.assertEqual(raw, FIXTURE["savedClocks"])

    def test_T1150_saved_timezone_nul_never_reaches_the_clock_model(self):
        fixture = json.loads((Path(__file__).parent / "fixtures/timezone_nul_cases.json").read_text())
        valid = [{"label": zone, "timezone": zone} for zone in fixture["valid"]]
        invalid = [{"label": "Refused", "timezone": zone} for zone in fixture["invalid"]]
        raw = [valid[0], *invalid, *valid[1:]]
        original = deepcopy(raw)
        settings = FakeSettings({"worldclocks": raw})
        widget = self.clocks.ClocksList({"value": raw}, "worldclocks", settings)
        self.assertEqual(settings.get_value("worldclocks"), valid)
        self.assertEqual(widget.model.rows, valid)
        settings.set_value("worldclocks", deepcopy(raw))
        widget.on_setting_changed()
        self.assertEqual(settings.get_value("worldclocks"), valid)
        self.assertEqual(widget.model.rows, valid)
        self.assertEqual(raw, original)

    def test_T1150_timezone_nul_is_refused_at_saved_length_boundaries(self):
        for length in (1, 12, 63, 64, 65, 254, 255, 256):
            prefix = "a" * length
            row = {"label": "Boundary", "timezone": prefix}
            expected = row if length <= 64 else None
            self.assertEqual(self.clocks.normalize_saved_clock(row), expected)
            row["timezone"] += "\0UTC"
            self.assertIsNone(self.clocks.normalize_saved_clock(row))

    def test_country_diagnostics_are_encodable_without_rewriting_the_refused_key(self):
        info = {"default": "", "options": {"None": "none", "Italy": "ita"}}
        for case in FIXTURE["text"]:
            if case["valid"]:
                continue
            with self.subTest(value=case["input"]):
                settings = FakeSettings({"country": case["input"]})
                widget = self.countries.CountryComboBox(info, "country", settings)
                diagnostic = widget.entry.get_accessible().description
                self.assertIn(case["diagnostic"], diagnostic)
                diagnostic.encode("utf-8")
                self.assertEqual(settings.writes, [])
                settings.set_value("country", "ita")
                self.assertEqual(widget.entry.get_text(), "Italy")
                settings.set_value("country", case["input"])
                widget.entry.get_accessible().description.encode("utf-8")
                self.assertEqual(settings.get_value("country"), case["input"])


if __name__ == "__main__":
    unittest.main()
