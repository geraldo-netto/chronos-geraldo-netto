#!/usr/bin/python3

import json

from helpers.settings_widgets_fixture import (
    APPLET_DIR,
    GtkLabel,
    GtkLinkButton,
    load_module,
    tearDownModule as teardown_fixture,
    unittest,
)


ABOUT_PATH = APPLET_DIR / "5.4" / "settings_about.py"
SCHEMA_PATH = APPLET_DIR / "5.4" / "settings-schema.json"


def tearDownModule():
    teardown_fixture()


class AboutPageTests(unittest.TestCase):
    def setUp(self):
        GtkLabel.instances.clear()
        GtkLinkButton.instances.clear()
        self.module = load_module(ABOUT_PATH, "settings_about_test")

    def test_schema_loads_a_complete_about_page(self):
        schema = json.loads(SCHEMA_PATH.read_text())

        self.assertEqual(schema["layout"]["pages"], ["page1", "page2", "page3"])
        self.assertEqual(
            schema["layout"]["page3"],
            {
                "type": "custom",
                "title": "About",
                "file": "settings_about.py",
                "widget": "AboutPage",
            },
        )

        page = self.module.AboutPage({}, object())
        metadata = json.loads((APPLET_DIR / "metadata.json").read_text())

        self.assertEqual(
            [section.title for section in page.sections],
            [
                "About Chronos",
                "Authors and credits",
                "Weather and location services",
                "Holiday services",
            ],
        )

        visible_text = "\n".join(label.text for label in GtkLabel.instances)
        for expected in (
            metadata["name"],
            metadata["uuid"],
            metadata["version"],
            metadata["description"],
            metadata["license"],
            "Geraldo Netto",
            "Claus Colloseus (ccprog)",
            "Simon Wiles (simonwiles)",
        ):
            self.assertIn(expected, visible_text)

        links = {button.label: button.uri for button in GtkLinkButton.instances}
        self.assertEqual(
            links,
            {
                "Project website and source code":
                    "https://github.com/geraldo-netto/cinnamon-chronos",
                "Open-Meteo": "https://open-meteo.com/",
                "Nominatim": "https://nominatim.org/",
                "© OpenStreetMap contributors":
                    "https://www.openstreetmap.org/copyright",
                "Aviation Weather Center": "https://aviationweather.gov/",
                "MET Norway": "https://www.met.no/en",
                "Enrico": "https://kayaposoft.com/enrico/",
                "OpenHolidays API": "https://www.openholidaysapi.org/",
                "Nager.Date": "https://date.nager.at/",
            },
        )
        self.assertTrue(all(button.halign == 0 for button in GtkLinkButton.instances))
        self.assertIn("does not download map tiles or other map assets", visible_text)
        self.assertTrue(all(label.line_wrap for label in GtkLabel.instances))
        self.assertTrue(all(label.selectable for label in GtkLabel.instances))

    def test_about_inventory_matches_the_live_service_adapters(self):
        weather = (APPLET_DIR / "weatherServiceAdapters.js").read_text()
        holidays = (APPLET_DIR / "holidayServiceAdapters.js").read_text()

        for host in (
            "geocoding-api.open-meteo.com",
            "api.open-meteo.com",
            "nominatim.openstreetmap.org",
            "aviationweather.gov",
            "api.met.no",
        ):
            self.assertIn(host, weather)

        for host in (
            "kayaposoft.com",
            "openholidaysapi.org",
            "date.nager.at",
        ):
            self.assertIn(host, holidays)

        credited = " ".join(
            uri
            for _name, uri, _description, _attribution
            in self.module.WEATHER_SERVICES + self.module.HOLIDAY_SERVICES
        )
        for provider_domain in (
            "open-meteo.com",
            "nominatim.org",
            "aviationweather.gov",
            "met.no",
            "kayaposoft.com",
            "openholidaysapi.org",
            "date.nager.at",
        ):
            self.assertIn(provider_domain, credited)


if __name__ == "__main__":
    unittest.main()
