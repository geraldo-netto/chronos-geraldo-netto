#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

"""Available calendar choices and local manifest installation."""

from datetime import date
import logging

import JsonSettingsWidgets
from JsonSettingsWidgets import JSONSettingsBackend, JSONSettingsList
from gi.repository import Gtk
from xapp.SettingsWidgets import SettingsWidget

import chronos_calendar_plugin_data as plugin_data


LOGGER = logging.getLogger("chronos@geraldo-netto.settings")
REVISION_KEY = "calendar-plugins-revision"


def _country_row(raw):
    if not isinstance(raw, dict):
        return None
    country = raw.get("country")
    region = raw.get("region", "global")
    enabled = raw.get("enabled", True)
    if not isinstance(country, str) or not isinstance(region, str) or type(enabled) is not bool:
        return None
    return {"enabled": enabled, "country": country, "region": region}


def normalize_country_rows(raw):
    if not isinstance(raw, list):
        return []
    return [row for row in map(_country_row, raw[:64]) if row is not None]


class AdditionalCountryList(JSONSettingsList):
    def __init__(self, info, key, settings):
        self.key = key
        self.settings = settings
        self._normalize_setting()
        super().__init__(key, settings, info)

    def _normalize_setting(self):
        raw = self.settings.get_value(self.key)
        normalized = normalize_country_rows(raw)
        if normalized != raw:
            self.set_value(normalized)

    def on_setting_changed(self, *args):
        self._normalize_setting()
        super().on_setting_changed(*args)


def AvailableReligionSwitch(info, key, settings):
    if not plugin_data.builtin_available(key.removeprefix("religion-")):
        return None
    return JsonSettingsWidgets.JSONSettingsSwitch(key, settings, info)


def selected_ids(raw):
    if not isinstance(raw, list):
        return []
    valid = (value for value in raw if isinstance(value, str) and len(value) <= 96
             and plugin_data.CALENDAR_ID.fullmatch(value))
    return list(dict.fromkeys(valid))[:plugin_data.MAX_PLUGINS]


class CalendarPluginChoices(SettingsWidget, JSONSettingsBackend):
    bind_dir = None

    def __init__(self, info, key, settings):
        self.backend = "json"
        self.key = key
        self.settings = settings
        self._destroyed = False
        SettingsWidget.__init__(self)
        self.set_orientation(Gtk.Orientation.VERTICAL)
        self.set_spacing(8)
        self.set_tooltip_text(info.get("tooltip", ""))
        self.listbox = Gtk.ListBox(selection_mode=Gtk.SelectionMode.SINGLE)
        self.content_widget = self.listbox
        self.listbox.connect("row-selected", self._on_row_selected)
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_min_content_height(160)
        scroll.set_max_content_height(280)
        scroll.add(self.listbox)
        self.pack_start(scroll, True, True, 0)
        self._build_actions()
        self.status = Gtk.Label(xalign=0)
        self.status.set_line_wrap(True)
        self.pack_start(self.status, False, False, 0)
        self.connect("destroy", self._on_destroy)
        self.attach()

    def _build_actions(self):
        actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        buttons = (
            ("Import JSON", self._on_import),
            ("Remove selected", self._on_remove),
            ("Refresh", self._on_refresh),
        )
        for label, callback in buttons:
            button = Gtk.Button(label=label)
            button.connect("clicked", callback)
            actions.pack_start(button, False, False, 0)
            if label == "Remove selected":
                self.remove_button = button
        self.remove_button.set_sensitive(False)
        self.pack_start(actions, False, False, 0)

    def connect_widget_handlers(self, *args):
        pass

    def _on_destroy(self, *_args):
        self._destroyed = True

    def _on_row_selected(self, _listbox, row):
        self.remove_button.set_sensitive(row is not None)

    def _on_toggled(self, checkbox, row):
        self.listbox.select_row(row)
        chosen = selected_ids(self.get_value())
        identifier = row.calendar_id
        if checkbox.get_active() and identifier not in chosen:
            if len(chosen) >= plugin_data.MAX_PLUGINS:
                checkbox.set_active(False)
                self.status.set_text("At most 32 calendars can be selected. Disable a calendar before enabling another.")
                return
            chosen.append(identifier)
        elif not checkbox.get_active() and identifier in chosen:
            chosen.remove(identifier)
        self.set_value(chosen)

    def _add_choice(self, manifest, chosen):
        row = Gtk.ListBoxRow()
        row.calendar_id = manifest["id"]
        checkbox = Gtk.CheckButton(label=manifest["name"])
        checkbox.set_active(manifest["id"] in chosen)
        checkbox.set_tooltip_text(f'{manifest["category"]} · {manifest["source"]["name"]}')
        checkbox.connect("toggled", self._on_toggled, row)
        row.add(checkbox)
        self.listbox.add(row)

    def _load_choices(self):
        try:
            found, errors = plugin_data.discover_plugins()
        except (OSError, ValueError) as error:
            found, errors = [], [str(error)]
        for error in errors:
            LOGGER.warning("Calendar import: %s", error)
        return found, errors

    def on_setting_changed(self, *_args):
        if self._destroyed:
            return
        for row in self.listbox.get_children():
            row.destroy()
        self.remove_button.set_sensitive(False)
        chosen = selected_ids(self.get_value())
        found, errors = self._load_choices()
        current = date.today().year
        available = [entry["manifest"] for entry in found
                     if plugin_data.available(entry["manifest"], current)]
        for manifest in available:
            self._add_choice(manifest, chosen)
        self.status.set_text(self._availability_message(available, errors))
        self.listbox.show_all()

    def _availability_message(self, available, errors):
        if errors:
            return "Some installed calendars could not be loaded. Check the calendar files and refresh."
        if not available:
            return "No installed calendars cover this year. Import a calendar to add choices."
        return "Calendars unavailable for this year are hidden."

    def _bump_revision(self):
        revision = self.settings.get_value(REVISION_KEY)
        revision = revision if type(revision) is int and 0 <= revision < 2147483647 else 0
        self.settings.set_value(REVISION_KEY, revision + 1)

    def _on_refresh(self, *_args):
        self.on_setting_changed()
        self._bump_revision()

    def _choose_import(self):
        dialog = Gtk.FileChooserDialog(
            title="Import calendar", transient_for=self.get_toplevel(),
            action=Gtk.FileChooserAction.OPEN,
        )
        dialog.add_buttons("Cancel", Gtk.ResponseType.CANCEL, "Import", Gtk.ResponseType.ACCEPT)
        dialog.set_local_only(True)
        file_filter = Gtk.FileFilter()
        file_filter.set_name("JSON calendar files")
        file_filter.add_pattern("*.json")
        dialog.add_filter(file_filter)
        try:
            return dialog.get_filename() if dialog.run() == Gtk.ResponseType.ACCEPT else None
        finally:
            dialog.destroy()

    def _on_import(self, *_args):
        filename = self._choose_import()
        if filename is None:
            return
        try:
            manifest = plugin_data.import_plugin(filename)
        except (OSError, ValueError, UnicodeError) as error:
            LOGGER.warning("Calendar import failed: %s", error)
            self.status.set_text("The calendar could not be imported. Choose a valid calendar JSON file.")
            return
        self._on_refresh()
        self.status.set_text(f'Imported {manifest["name"]}. Calendars without coverage for this year stay hidden.')

    def _on_remove(self, *_args):
        row = self.listbox.get_selected_row()
        if row is None:
            return
        try:
            plugin_data.remove_plugin(row.calendar_id)
        except (OSError, ValueError, UnicodeError) as error:
            LOGGER.warning("Calendar removal failed: %s", error)
            self.status.set_text("The calendar could not be removed. Refresh the choices and try again.")
            return
        self.set_value([identifier for identifier in selected_ids(self.get_value())
                        if identifier != row.calendar_id])
        self._on_refresh()
