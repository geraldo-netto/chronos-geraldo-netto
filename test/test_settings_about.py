#!/usr/bin/python3

import json
import re
from unittest import mock

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


ABOUT_PATH = APPLET_DIR / "6.0" / "settings_about.py"
SCHEMA_PATH = APPLET_DIR / "6.0" / "settings-schema.json"


def tearDownModule():
    teardown_fixture()


class AboutPageTests(unittest.TestCase):
    def setUp(self):
        GtkLabel.instances.clear()
        GtkLinkButton.instances.clear()
        GtkImage.instances.clear()
        GtkWindow.instances.clear()
        self.module = load_module(ABOUT_PATH, "settings_about_test")

    def page_and_metadata(self):
        return (
            self.module.AboutPage({}, object()),
            json.loads((APPLET_DIR / "metadata.json").read_text()),
        )

    def test_about_content_remains_available_outside_configuration(self):
        schema = json.loads(SCHEMA_PATH.read_text())
        for key in schema["layout"]["pages"]:
            self.assertNotEqual(schema["layout"][key]["title"], "About")
            self.assertNotEqual(schema["layout"][key].get("widget"), "AboutPage")

        page, _metadata = self.page_and_metadata()
        self.assertEqual(
            [section.title for section in page.sections],
            [
                "About Chronos",
                "Weather and location services",
                "Holiday services",
            ],
        )

    def test_page_shows_identity_and_all_service_links(self):
        self.assertNotIn("openstreetmap-attribution", json.loads(SCHEMA_PATH.read_text()))
        _page, metadata = self.page_and_metadata()
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

    def test_only_copyable_identity_text_enters_the_label_tab_order(self):
        _page, metadata = self.page_and_metadata()
        selectable = [label for label in GtkLabel.instances if label.selectable]

        self.assertEqual(len(selectable), 1)
        self.assertIn(metadata["uuid"], selectable[0].text)
        self.assertEqual(
            [label.can_focus for label in GtkLabel.instances],
            [label is selectable[0] for label in GtkLabel.instances],
        )

    def test_identity_and_credits_use_compact_horizontal_layout(self):
        page, metadata = self.page_and_metadata()
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
        identity_links = identity.children[1].children[1]
        self.assertEqual(identity_links.kwargs["orientation"], 2)
        self.assertEqual(
            [child.label for child in identity_links.children],
            [
                "Project website and source code",
                "License: GPL 2.0 or later",
            ],
        )
        credits = page.sections[0].rows[1].content_widget
        self.assertEqual(len(credits.children), 2)
        contributor_links = credits.children[1]
        self.assertEqual(contributor_links.kwargs["orientation"], 2)
        self.assertEqual(
            [child.label for child in contributor_links.children],
            [name for name, _uri in self.module.CONTRIBUTOR_LINKS],
        )
        self.assertEqual(
            [name for name, _uri in self.module.CONTRIBUTOR_LINKS],
            [
                contributor.strip()
                for contributor in metadata["contributors"].split(",")
            ],
        )

    def test_service_and_attribution_links_have_separate_rows(self):
        page, _metadata = self.page_and_metadata()
        for section, services in (
            (page.sections[1], self.module.WEATHER_SERVICES),
            (page.sections[2], self.module.HOLIDAY_SERVICES),
        ):
            rows = iter(section.rows)
            for _runtime_name, name, _uri, description, attribution in services:
                children = next(rows).content_widget.children
                self.assertEqual(len(children), 1)
                summary = children[0]
                self.assertEqual(summary.kwargs["orientation"], 2)
                self.assertEqual(summary.children[0].label, name)
                self.assertEqual(summary.children[1].text, "— %s" % description)
                if attribution:
                    credit = next(rows).content_widget.children
                    self.assertEqual(len(credit), 1)
                    self.assertIsInstance(credit[0], GtkLinkButton)
                    self.assertEqual((credit[0].label, credit[0].uri), attribution)
            self.assertEqual(list(rows), [])

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
            for _runtime_name, _name, uri, _description, _attribution
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

    def test_disclosures_have_exact_runtime_registry_parity(self):
        def registry_names(filename, export_name):
            source = (APPLET_DIR / filename).read_text()
            match = re.search(
                r"var %s = \{(?P<body>.*?)\n\};" % export_name,
                source,
                re.DOTALL,
            )
            self.assertIsNotNone(match, "%s is not exported" % export_name)
            return tuple(re.findall(
                r'^\s*[A-Z_]+:\s*"([^"]+)"',
                match.group("body"),
                re.MULTILINE,
            ))

        disclosures = (
            (
                self.module.WEATHER_SERVICES,
                registry_names(
                    "weatherServiceAdapters.js", "WEATHER_PROVIDER_NAMES"
                ),
            ),
            (
                self.module.HOLIDAY_SERVICES,
                registry_names("holidayConstants.js", "HOLIDAY_PROVIDER_NAMES"),
            ),
        )
        for services, runtime_names in disclosures:
            self.assertEqual(
                tuple(service[0] for service in services),
                runtime_names,
                "About provider names/order diverged from the runtime registry",
            )

        aliases = {
            runtime_name: display_name
            for services, _runtime_names in disclosures
            for runtime_name, display_name, _uri, _description, _attribution
            in services
            if runtime_name != display_name
        }
        self.assertEqual(
            aliases,
            {
                "Aviation Weather": "Aviation Weather Center",
                "OpenHolidays": "OpenHolidays API",
            },
            "display-name aliases must remain explicit",
        )

    def test_standalone_window_reuses_the_complete_settings_page(self):
        window = self.module.show_about_window()
        metadata = json.loads((APPLET_DIR / "metadata.json").read_text())

        self.assertIs(window, GtkWindow.instances[-1])
        self.assertEqual(window.title, metadata["name"])
        self.assertEqual(window.default_size, (800, -1))
        self.assertEqual(window.position, 1)
        self.assertEqual(window.icon_path, str(APPLET_DIR / "icon.png"))
        self.assertTrue(window.shown)
        self.assertEqual(window.scroller.policy, (0, 1))
        self.assertTrue(window.scroller.propagate_natural_height)
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
        self.assertIs(dict(window.handlers)["destroy"], self.module.Gtk.main_quit)

    def test_about_window_disables_maximize_and_keeps_other_window_actions(self):
        window = self.module.AboutWindow()
        native = mock.Mock()
        with mock.patch.object(window, "get_window", return_value=native, create=True):
            dict(window.handlers)["realize"](window)
        native.set_functions.assert_called_once()
        functions = native.set_functions.call_args.args[0]
        self.assertFalse(functions & self.module.Gdk.WMFunction.MAXIMIZE)
        self.assertFalse(functions & self.module.Gdk.WMFunction.ALL)
        for action in ("MOVE", "RESIZE", "MINIMIZE", "CLOSE"):
            self.assertTrue(functions & getattr(self.module.Gdk.WMFunction, action))


if __name__ == "__main__":
    unittest.main()
