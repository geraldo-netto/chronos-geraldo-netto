#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

"""Check native GTK settings boundaries with an in-memory backend and private X."""

import builtins
from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_cinnamon_imports import private_environment, run_session, verify_isolation


ROOT = Path(__file__).resolve().parents[1]
APPLET = ROOT / "files/chronos@geraldo-netto"


class MemorySettings:
    def __init__(self, schema, key, value):
        self.schema = schema
        self.values = {key: deepcopy(value)}
        self.listeners = {}
        self.writes = []

    def get_value(self, key):
        return self.values[key]

    def set_value(self, key, value):
        self.values[key] = value
        self.writes.append((key, deepcopy(value)))
        for callback in self.listeners.get(key, []):
            callback(key, value)

    def listen(self, key, callback):
        self.listeners.setdefault(key, []).append(callback)

    def has_property(self, key, name):
        return name in self.schema[key]

    def has_key(self, key):
        return key in self.schema

    def get_property(self, key, name):
        return self.schema[key][name]


def load_widgets():
    # Only called after the child has verified its private display and profile.
    sys.path[:0] = ["/usr/share/cinnamon/cinnamon-settings",
                    "/usr/share/cinnamon/cinnamon-settings/bin", str(APPLET)]
    builtins._ = lambda text: text
    import gi
    gi.require_version("Gtk", "3.0")
    from chronos_settings_widgets_weather import WeatherLocationEntry
    from chronos_settings_widgets_holidays import CountryComboBox
    from chronos_settings_widgets_worldclocks import ClocksList
    return WeatherLocationEntry, CountryComboBox, ClocksList


def check_weather(widget_type, schema, case):
    from gi.repository import Gdk
    key, raw = "weather-location", case["input"]
    settings = MemorySettings(schema, key, raw)
    widget = widget_type(schema[key], key, settings)
    try:
        assert widget.content_widget.get_text() == (raw if case["valid"] else "")
        assert settings.get_value(key) == raw and not settings.writes
        settings.set_value(key, "Plzeň")
        settings.set_value(key, raw)
        before = deepcopy(settings.writes)
        widget.content_widget.emit("activate")
        widget.content_widget.emit("focus-out-event", Gdk.Event.new(Gdk.EventType.FOCUS_CHANGE))
        assert settings.get_value(key) == raw and settings.writes == before
        description = widget.content_widget.get_accessible().get_description()
        description.encode("utf-8")
        if not case["valid"]:
            assert case.get("refusal", "invalid Unicode") in description
        widget.content_widget.set_text("Genoa 🏙")
        widget.content_widget.emit("activate")
        assert settings.get_value(key) == "Genoa 🏙"
    finally:
        widget.destroy()


def check_country(widget_type, schema, case):
    key, raw = "country", case["input"]
    settings = MemorySettings(schema, key, raw)
    widget = widget_type(schema[key], key, settings)
    try:
        message = widget.entry.get_accessible().get_description()
        assert case["diagnostic"] in message
        message.encode("utf-8")
        assert settings.get_value(key) == raw and not settings.writes
        settings.set_value(key, "ita")
        settings.set_value(key, raw)
        widget.entry.get_accessible().get_description().encode("utf-8")
        assert settings.get_value(key) == raw
    finally:
        widget.destroy()


def check_clocks(widget_type, schema, fixture):
    key = "worldclocks"
    settings = MemorySettings(schema, key, fixture["savedClocks"])
    widget = widget_type(schema[key], key, settings)
    try:
        assert settings.get_value(key) == fixture["selectedClocks"]
        settings.set_value(key, deepcopy(fixture["savedClocks"]))
        widget.on_setting_changed()
        assert settings.get_value(key) == fixture["selectedClocks"]
        rows = [dict(zip(widget.entry_serializer.column_ids, row)) for row in widget.model]
        assert rows == fixture["selectedClocks"], rows
        widget.list_changed()
        assert settings.get_value(key) == fixture["selectedClocks"]
    finally:
        widget.destroy()


def check_clock_timezones(widget_type, schema):
    # T1150: native model conversion and a subsequent list save preserve every
    # admitted identifier; a refused suffix must never become a different zone.
    fixture = json.loads((ROOT / "test/fixtures/timezone_nul_cases.json").read_text())
    valid = [{"label": zone, "timezone": zone} for zone in fixture["valid"]]
    invalid = [{"label": "Refused", "timezone": zone} for zone in fixture["invalid"]]
    check_clocks(widget_type, schema, {
        "savedClocks": [valid[0], *invalid, *valid[1:]], "selectedClocks": valid,
    })


def drain_events():
    from gi.repository import Gtk
    while Gtk.events_pending():
        Gtk.main_iteration_do(False)


def check_teardown(widget_type, schema, key, case):
    from gi.repository import Gtk
    settings = MemorySettings(schema, key, case["stored"])
    widget = widget_type(schema[key], key, settings)
    entry = getattr(widget, "entry", widget.content_widget)
    window = Gtk.Window()
    window.add(widget)
    try:
        window.show_all()
        entry.grab_focus()
        drain_events()
        assert window.get_focus() == entry
        for action in case["actions"]:
            if "external" in action:
                settings.set_value(key, action["external"])
            else:
                entry.set_text(action["edit"])
        before = len(settings.writes)
        observed = []
        entry.connect("destroy", lambda child: observed.append(child.get_text()))
        window.destroy()
        drain_events()
        window.destroy()
        assert observed == [""], (key, case["name"], observed)
        assert settings.get_value(key) == case["expected"], (key, case["name"], settings.values)
        assert settings.writes[before:] == [(key, value) for value in case["writes"]], (
            key, case["name"], settings.writes[before:])
    finally:
        window.destroy()


def check_filename_removal(widget, directory, case, remaining):
    row = next(row for row in widget.unavailable_list.get_children()
               if row.calendar_filename == case["filename"])
    label = row.get_children()[0]
    assert label.get_text() == case["display"] + " · Invalid calendar file"
    label.get_text().encode("utf-8")
    assert label.get_max_width_chars() == 60
    row.remove_button.emit("clicked")
    remaining.remove(case["filename"])
    assert not (directory / case["filename"]).exists()
    assert all((directory / name).exists() for name in remaining)
    assert [item.calendar_id for item in widget.listbox.get_children()] == ["example.native"]


def prepare_filename_plugins(directory):
    import chronos_calendar_plugin_data as data
    installed = data.plugin_directory()
    assert installed.resolve().is_relative_to(directory.resolve())
    installed.mkdir(parents=True)
    cases = json.loads((ROOT / "test/fixtures/calendar_filename_cases.json").read_text())
    for case in cases:
        (installed / case["filename"]).write_bytes(b"not JSON")
    manifest = {"apiVersion": 1, "id": "example.native", "name": "Native test calendar",
                "category": "civic", "coverage": {"from": 1, "through": 9999},
                "source": {"name": "Native regression fixture"}, "events": []}
    neighbor = installed / "example.native.json"
    neighbor.write_text(json.dumps(manifest))
    return installed, cases, neighbor


def check_plugin_filenames(directory, schema):
    from gi.repository import Gtk
    import chronos_settings_widgets_calendars as calendars
    installed, cases, neighbor = prepare_filename_plugins(directory)
    key = "calendar-plugins"
    settings = MemorySettings(schema, key, ["example.native"])
    settings.values["calendar-plugins-revision"] = 0
    with mock.patch.object(calendars.LOGGER, "warning"):
        widget = calendars.CalendarPluginChoices(schema[key], key, settings)
        window = Gtk.Window()
        window.set_default_size(640, 480)
        window.add(widget)
        try:
            expander = next(child for child in widget.get_children() if isinstance(child, Gtk.Expander))
            expander.set_expanded(True)
            window.show_all()
            drain_events()
            assert window.get_allocated_width() <= 960, window.get_allocated_width()
            remaining = {case["filename"] for case in cases}
            for case in cases:
                check_filename_removal(widget, installed, case, remaining)
            assert neighbor.exists()
            assert settings.get_value(key) == ["example.native"]
        finally:
            window.destroy()
    return len(cases)


def check_import_status_width(directory, schema, font):
    # T1160: importing the maximum allowed name must fit a composed settings
    # page, including its margins, while assistive technology retains the name.
    from gi.repository import GLib, Gtk
    from xapp.SettingsWidgets import SettingsPage
    import chronos_calendar_plugin_data as data
    import chronos_settings_widgets_calendars as calendars
    key = "calendar-plugins"
    settings = MemorySettings(schema, key, [])
    settings.values["calendar-plugins-revision"] = 0
    manifest = {"apiVersion": 1, "id": "example.long-name", "name": "W" * 100,
                "category": "civic", "coverage": {"from": 1, "through": 9999},
                "source": {"name": "Native regression fixture"}, "events": []}
    source = directory / "long-name.json"
    source.write_text(json.dumps(manifest))
    gtk_settings = Gtk.Settings.get_default()
    previous_font = gtk_settings.get_property("gtk-font-name")
    gtk_settings.set_property("gtk-font-name", font)
    widget = calendars.CalendarPluginChoices(schema[key], key, settings)
    page = SettingsPage()
    page.add_section("Calendar plugins").add_row(widget)
    window = Gtk.Window()
    window.set_default_size(720, 480)
    window.add(page)
    try:
        window.show_all()
        drain_events()
        before = window.get_allocated_width()
        with mock.patch.object(widget, "_choose_import", return_value=str(source)):
            widget._on_import()
        loop = GLib.MainLoop()
        GLib.timeout_add(100, loop.quit)
        loop.run()
        after = window.get_allocated_width()
        expected = f'Imported {manifest["name"]}. Calendars without coverage for this year stay hidden.'
        assert widget.status.get_text() == expected
        assert widget.status.get_accessible().get_text(0, -1) == expected
        assert [row.calendar_id for row in widget.listbox.get_children()].count(manifest["id"]) == 1
        assert settings.get_value("calendar-plugins-revision") == 1
        return {"font": font, "before": before, "after": after,
                "minimum": window.get_preferred_width().minimum_width}
    finally:
        window.destroy()
        data.remove_plugin(manifest["id"])
        gtk_settings.set_property("gtk-font-name", previous_font)


def check_import_status_widths(directory, schema):
    from gi.repository import Gdk
    display_width = Gdk.Display.get_default().get_monitor(0).get_geometry().width
    assert display_width == 1366, display_width
    widths = [check_import_status_width(directory, schema, font) for font in ("Sans 10", "Sans 14")]
    print(json.dumps({"T1160": widths, "displayWidth": display_width}), flush=True)
    assert all(result["after"] <= 960 and result["minimum"] <= 960 for result in widths), widths
    return len(widths)


def widget_type_names(parent):
    from gi.repository import GObject
    names = set()
    for child in GObject.type_children(parent):
        names.add(child.name)
        names.update(widget_type_names(child))
    return names


def country_dialog_cycle(widget):
    from gi.repository import Gtk
    dialog = Gtk.Dialog()
    try:
        fields = widget._dialog_fields(dialog, None)
        assert [field.get_widget_value() for field in fields] == [True, None, "global"]
        enabled, country, region = fields
        enabled.content_widget.set_active(False)
        country.content_widget.set_active_iter(country.option_map["usa"])
        region.content_widget.set_text(" MA ")
        assert widget._dialog_candidate(fields, None) == (
            {"enabled": False, "country": "usa", "region": "ma"}, "")
    finally:
        dialog.destroy()
        drain_events()


def check_country_dialog_types(schema):
    # T1156: GTypes survive destruction; repeat actual native field construction
    # after lazy GTK initialization has completed, with no real settings writes.
    from xapp.SettingsWidgets import SettingsWidget
    from chronos_settings_widgets_calendars import AdditionalCountryList
    key = "extra-country-calendars"
    settings = MemorySettings(schema, key, [])
    widget = AdditionalCountryList(schema[key], key, settings)
    try:
        country_dialog_cycle(widget)
        baseline = widget_type_names(SettingsWidget.__gtype__)
        for _index in range(20):
            country_dialog_cycle(widget)
        assert widget_type_names(SettingsWidget.__gtype__) == baseline, "T1156: native widget types grew"
        assert settings.get_value(key) == [] and settings.writes == []
    finally:
        widget.destroy()
    return 21


def run_isolated(directory):
    verify_isolation(directory)
    weather, country, clocks = load_widgets()
    schema = json.loads((APPLET / "6.0/settings-schema.json").read_text())
    fixture = json.loads((ROOT / "test/fixtures/settings_unicode_cases.json").read_text())
    checks = 0
    for case in fixture["text"]:
        check_weather(weather, schema, case)
        checks += 1
        if not case["valid"]:
            check_country(country, schema, case)
            checks += 1
    check_clocks(clocks, schema, fixture)
    check_clock_timezones(clocks, schema)
    for case in fixture["weatherNul"]:
        check_weather(weather, schema, case)
        checks += 1
    teardown = json.loads((ROOT / "test/fixtures/settings_teardown_cases.json").read_text())
    for key, widget in (("weather-location", weather), ("country", country)):
        for case in teardown[key]:
            check_teardown(widget, schema, key, case)
            checks += 1
    checks += check_plugin_filenames(directory, schema)
    checks += check_import_status_widths(directory, schema)
    checks += check_country_dialog_types(schema)
    print(json.dumps({"checks": checks + 2, "failures": []}), flush=True)
    return 0


def main():
    missing = [name for name in ("dbus-run-session", "xvfb-run") if shutil.which(name) is None]
    if missing:
        print("Missing native-check tools: " + ", ".join(missing), file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory(prefix="chronos-native-settings-") as temporary:
        directory = Path(temporary)
        environment = private_environment(directory)
        environment.update(G_DEBUG="fatal-criticals", TZ="Antarctica/Troll", LC_ALL="C.UTF-8")
        try:
            status = run_session(directory, environment, Path(__file__).resolve())
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            status = 1
        diagnostic = (directory / "session.log").read_text(errors="replace")
        if diagnostic:
            print(diagnostic[-8000:], file=sys.stderr)
        return int(bool(status or diagnostic))


if __name__ == "__main__":
    raise SystemExit(main())
