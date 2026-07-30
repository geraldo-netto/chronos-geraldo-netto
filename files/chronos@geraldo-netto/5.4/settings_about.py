#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.


import json
import sys
from pathlib import Path

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
from xapp.SettingsWidgets import SettingsPage, SettingsWidget


APPLET_DIR = Path(__file__).resolve().parent.parent
if str(APPLET_DIR) not in sys.path:
    sys.path.append(str(APPLET_DIR))

from chronos_settings_i18n import _  # noqa: E402


PROJECT_URL = "https://github.com/geraldo-netto/cinnamon-chronos"
LICENSE_URL = "https://www.gnu.org/licenses/old-licenses/gpl-2.0.html"
CONTRIBUTOR_LINKS = (
    ("Geraldo Netto", "https://github.com/geraldo-netto"),
    ("Claus Colloseus (ccprog)", "https://github.com/ccprog"),
    ("Simon Wiles (simonwiles)", "https://github.com/simonwiles"),
)
OPENSTREETMAP_ATTRIBUTION = (
    _("© OpenStreetMap contributors"),
    "https://www.openstreetmap.org/copyright",
)

WEATHER_SERVICES = (
    (
        "Open-Meteo",
        "Open-Meteo",
        "https://open-meteo.com/",
        _("Primary place search and weather forecast service."),
        None,
    ),
    (
        "Nominatim",
        "Nominatim",
        "https://nominatim.org/",
        _(
            "Fallback place search using OpenStreetMap data. "
            "Chronos does not download map tiles or other map assets."
        ),
        OPENSTREETMAP_ATTRIBUTION,
    ),
    (
        "Aviation Weather",
        "Aviation Weather Center",
        "https://aviationweather.gov/",
        _("First fallback weather service, using nearby METAR observations."),
        None,
    ),
    (
        "MET Norway",
        "MET Norway",
        "https://www.met.no/en",
        _("Final fallback weather forecast service."),
        None,
    ),
)

HOLIDAY_SERVICES = (
    (
        "Enrico",
        "Enrico",
        "https://kayaposoft.com/enrico/",
        _("Primary public-holiday service."),
        None,
    ),
    (
        "OpenHolidays",
        "OpenHolidays API",
        "https://www.openholidaysapi.org/",
        _("First fallback public-holiday service."),
        None,
    ),
    (
        "Nager.Date",
        "Nager.Date",
        "https://date.nager.at/",
        _("Final fallback public-holiday service."),
        None,
    ),
)


def read_metadata():
    return json.loads((APPLET_DIR / "metadata.json").read_text(encoding="utf-8"))


def text_label(text, selectable=False):
    label = Gtk.Label(label=text, xalign=0)
    label.set_line_wrap(True)
    label.set_max_width_chars(72)
    label.set_selectable(selectable)
    return label


def content_row(*children):
    row = SettingsWidget()
    content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
    for child in children:
        content.pack_start(child, False, False, 0)

    row.content_widget = content
    row.pack_start(content, True, True, 0)
    return row


def horizontal_group(*children):
    group = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
    for child in children:
        group.pack_start(child, False, False, 0)

    return group


def identity_row(metadata):
    row = SettingsWidget()
    content = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
    icon = Gtk.Image.new_from_file(str(APPLET_DIR / "icon.png"))
    icon.set_valign(Gtk.Align.START)
    details = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
    identity = "\n".join(
        (
            "%s (%s)" % (_(metadata["name"]), metadata["uuid"]),
            _("Version %s") % metadata["version"],
            _(metadata["description"]),
        )
    )
    details.pack_start(text_label(identity, selectable=True), False, False, 0)
    details.pack_start(
        horizontal_group(
            link_button(_("Project website and source code"), PROJECT_URL),
            link_button(_("License: GPL 2.0 or later"), LICENSE_URL),
        ),
        False,
        False,
        0,
    )
    content.pack_start(icon, False, False, 0)
    content.pack_start(details, True, True, 0)
    row.content_widget = content
    row.pack_start(content, True, True, 0)
    return row


def link_button(label, uri):
    link = Gtk.LinkButton.new_with_label(uri, label)
    link.set_halign(Gtk.Align.START)
    return link


def service_row(name, uri, description, attribution):
    summary = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
    summary.pack_start(link_button(name, uri), False, False, 0)
    summary.pack_start(text_label("— %s" % description), True, True, 0)
    children = [summary]
    if attribution:
        children.append(link_button(*attribution))

    return content_row(*children)


class AboutPage(SettingsPage):
    def __init__(self, _info, _settings):
        super().__init__()
        metadata = read_metadata()
        self._add_identity(metadata)
        self._add_services(
            _("Weather and location services"),
            _(
                "Used only when weather is enabled. A place name is sent to a "
                "geocoder, then its coordinates are sent to a weather provider."
            ),
            WEATHER_SERVICES,
        )
        self._add_services(
            _("Holiday services"),
            _(
                "Used only when holidays are enabled. The selected country, "
                "region, and requested year may be sent to these providers."
            ),
            HOLIDAY_SERVICES,
        )

    def _add_identity(self, metadata):
        section = self.add_section(_("About Chronos"))
        section.add_row(identity_row(metadata))
        section.add_row(
            content_row(
                text_label(_("Authors and credits")),
                horizontal_group(
                    *(
                        link_button(name, uri)
                        for name, uri in CONTRIBUTOR_LINKS
                    )
                ),
            )
        )

    def _add_services(self, title, subtitle, services):
        section = self.add_section(title, subtitle)
        for _runtime_name, display_name, uri, description, attribution in services:
            section.add_row(service_row(
                display_name, uri, description, attribution
            ))


class AboutWindow(Gtk.Window):
    def __init__(self):
        metadata = read_metadata()
        super().__init__(title=_(metadata["name"]))
        self.set_default_size(800, 650)
        self.set_position(Gtk.WindowPosition.CENTER)
        self.set_icon_from_file(str(APPLET_DIR / "icon.png"))

        self.scroller = Gtk.ScrolledWindow()
        self.scroller.set_policy(
            Gtk.PolicyType.NEVER,
            Gtk.PolicyType.AUTOMATIC,
        )
        self.page = AboutPage({}, None)
        self.scroller.add(self.page)
        self.add(self.scroller)
        self.connect("destroy", Gtk.main_quit)


def show_about_window():
    window = AboutWindow()
    window.show_all()
    Gtk.main()
    return window


if __name__ == "__main__":
    show_about_window()
