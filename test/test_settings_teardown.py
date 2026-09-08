"""Entry teardown clears native text after the owner has committed the edit."""

import json
from pathlib import Path

from helpers.settings_widgets_fixture import (
    APPLET_DIR, FakeSettings, HOLIDAYS_PATH, WEATHER_PATH, load_module,
    tearDownModule as teardown_fixture, unittest,
)


FIXTURE = json.loads((Path(__file__).parent / "fixtures/settings_teardown_cases.json").read_text())
SCHEMA = json.loads((APPLET_DIR / "6.0/settings-schema.json").read_text())


def tearDownModule():
    teardown_fixture()


class SettingsTeardownTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.weather = load_module(WEATHER_PATH, "teardown_weather")
        cls.country = load_module(HOLIDAYS_PATH, "teardown_country")

    def apply_actions(self, settings, key, entry, actions):
        for action in actions:
            if "external" in action:
                settings.set_value(key, action["external"])
            else:
                entry.set_text(action["edit"])
                entry.emit_changed()

    def check_teardown(self, key, case):
        settings = FakeSettings({key: case["stored"]})
        kind = self.weather.WeatherLocationEntry if key == "weather-location" else self.country.CountryComboBox
        widget = kind(SCHEMA[key], key, settings)
        entry = getattr(widget, "entry", widget.content_widget)
        self.apply_actions(settings, key, entry, case["actions"])
        before = len(settings.writes)
        observed = []
        entry.connect("destroy", lambda child: observed.append(child.get_text()))
        widget.destroy()
        widget.destroy()
        self.assertEqual(observed, [""], "child text must be cleared during teardown")
        self.assertEqual(settings.get_value(key), case["expected"])
        self.assertEqual(settings.writes[before:], [(key, value) for value in case["writes"]])

    def test_owner_teardown_preserves_values_and_commits_each_pending_edit_once(self):
        for key, cases in FIXTURE.items():
            for case in cases:
                with self.subTest(key=key, case=case["name"]):
                    self.check_teardown(key, case)


if __name__ == "__main__":
    unittest.main()
