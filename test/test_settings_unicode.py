"""Shared Unicode boundary cases and recoverable settings updates."""

from copy import deepcopy
import json
from pathlib import Path

from helpers.settings_widgets_fixture import (
    FakeSettings, HOLIDAYS_PATH, WEATHER_PATH, WORLDCLOCKS_PATH,
    load_module, tearDownModule as teardown_fixture, unittest,
)


FIXTURE = json.loads((Path(__file__).parent / "fixtures/settings_unicode_cases.json").read_text())


def tearDownModule():
    teardown_fixture()


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

    def assert_refused_weather(self, widget, settings, original):
        self.assertEqual(widget.content_widget.get_text(), "")
        self.assertIn("error", widget.bind_object.get_style_context().classes)
        self.assertIn("invalid Unicode", widget.bind_object.get_accessible().description)
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
