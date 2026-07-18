#!/usr/bin/python3

import json

from helpers.settings_widgets_fixture import (
    APPLET_DIR,
    GtkImage,
    GtkLabel,
    GtkLinkButton,
    GtkWindow,
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
        GtkImage.instances.clear()
        GtkWindow.instances.clear()
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
            "Authors and credits",
        ):
            self.assertIn(expected, visible_text)

        links = {button.label: button.uri for button in GtkLinkButton.instances}
        self.assertEqual(
            links,
            {
                "Project website and source code":
                    "https://github.com/geraldo-netto/cinnamon-chronos",
                "License: GPL 2.0 or later":
                    "https://www.gnu.org/licenses/old-licenses/gpl-2.0.html",
                "Geraldo Netto": "https://github.com/geraldo-netto",
                "Claus Colloseus (ccprog)": "https://github.com/ccprog",
                "Simon Wiles (simonwiles)": "https://github.com/simonwiles",
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
        self.assertNotIn(metadata["license"], visible_text)
        self.assertIn("does not download map tiles or other map assets", visible_text)
        self.assertTrue(all(label.line_wrap for label in GtkLabel.instances))
        self.assertTrue(all(label.selectable for label in GtkLabel.instances))
        self.assertEqual(
            [image.path for image in GtkImage.instances],
            [str(APPLET_DIR / "icon.png")],
        )
        self.assertEqual(GtkImage.instances[0].valign, 0)
        identity = page.sections[0].rows[0].content_widget
        self.assertIs(identity.children[0], GtkImage.instances[0])
        self.assertIn(
            metadata["description"],
            "\n".join(
                child.text
                for child in identity.children[1].children
                if isinstance(child, GtkLabel)
            ),
        )
        self.assertEqual(
            [name for name, _uri in self.module.CONTRIBUTOR_LINKS],
            [
                contributor.strip()
                for contributor in metadata["contributors"].split(",")
            ],
        )

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

    def test_standalone_window_reuses_the_complete_settings_page(self):
        window = self.module.show_about_window()
        metadata = json.loads((APPLET_DIR / "metadata.json").read_text())

        self.assertIs(window, GtkWindow.instances[-1])
        self.assertEqual(window.title, metadata["name"])
        self.assertEqual(window.default_size, (800, 650))
        self.assertEqual(window.position, 1)
        self.assertEqual(window.icon_path, str(APPLET_DIR / "icon.png"))
        self.assertTrue(window.shown)
        self.assertEqual(window.scroller.policy, (0, 1))
        self.assertIs(window.scroller.children[0], window.page)
        self.assertIs(window.children[0], window.scroller)
        self.assertEqual(
            [section.title for section in window.page.sections],
            [
                "About Chronos",
                "Weather and location services",
                "Holiday services",
            ],
        )
        self.assertEqual(window.handlers, [("destroy", self.module.Gtk.main_quit)])


if __name__ == "__main__":
    unittest.main()
