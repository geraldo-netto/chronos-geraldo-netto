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
from TreeListWidgets import list_edit_factory
from gi.repository import Gtk, Pango
from xapp.SettingsWidgets import SettingsWidget

import chronos_calendar_plugin_data as plugin_data
from chronos_text import filename_display_text, trim_text


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
        self._settings_revision = 0
        self.columns = info["columns"]
        countries = next(column["options"].values() for column in self.columns
                         if column["id"] == "country")
        self.regions = {country: self._regions_for(country) for country in countries}
        self._normalize_setting()
        super().__init__(key, settings, info)
        self.status = Gtk.Label(label="Enable at most 16 country/region pairs. Use global for nationwide holidays.",
                                xalign=0)
        self.status.set_line_wrap(True)
        self.pack_start(self.status, False, False, 0)

    def _regions_for(self, country):
        key = "region_" + country
        if self.settings.has_key(key) and self.settings.has_property(key, "options"):
            return set(self.settings.get_property(key, "options").values()) | {"global"}
        return {"global"}

    def _canonical_row(self, raw):
        row = _country_row(raw)
        if row is None or row["country"] not in self.regions:
            return None
        row["region"] = trim_text(row["region"]).lower() or "global"
        return row if row["region"] in self.regions[row["country"]] else None

    def _normalized_rows(self, raw):
        result, seen, active = [], set(), 0
        for item in normalize_country_rows(raw):
            row = self._canonical_row(item)
            if row is None:
                continue
            pair = (row["country"], row["region"])
            if pair in seen:
                continue
            seen.add(pair)
            row["enabled"] = row["enabled"] and active < 16
            active += row["enabled"]
            result.append(row)
        return result

    def _normalize_setting(self):
        raw = self.settings.get_value(self.key)
        normalized = self._normalized_rows(raw)
        if normalized != raw:
            self.set_value(normalized)

    def on_setting_changed(self, *args):
        self._settings_revision += 1
        self._normalize_setting()
        super().on_setting_changed(*args)

    def _row_values(self, values):
        return {column["id"]: value for column, value in zip(self.columns, values)}

    def _selection_error(self, rows):
        if len(rows) > 64:
            return "At most 64 country/region pairs can be stored. Remove a pair first."
        if any(self._canonical_row(row) is None for row in rows):
            return "Choose a supported country and region code; use global for nationwide holidays."
        pairs = {(row["country"], row["region"]) for row in rows}
        if len(pairs) != len(rows):
            return "This country/region pair is already listed. Edit the existing pair."
        if sum(row["enabled"] for row in rows) > 16:
            return "At most 16 country/region pairs can be enabled. Disable another pair first."
        return ""

    def list_changed(self, *args):
        error = self._selection_error([self._row_values(row) for row in self.model])
        if error:
            self.on_setting_changed()
            self.status.set_text(error)
            return
        self.status.set_text("")
        super().list_changed(*args)

    def _dialog_fields(self, dialog, info):
        fields = []
        for index, column in enumerate(self.columns):
            field = list_edit_factory(column)
            value = info[index] if info is not None else column.get("default")
            if value is not None:
                field.set_widget_value(value)
            dialog.get_content_area().pack_start(field, False, False, 0)
            fields.append(field)
        return fields

    def _dialog_candidate(self, fields, info):
        row = self._canonical_row(self._row_values([field.get_widget_value() for field in fields]))
        if row is None:
            return None, "Choose a supported country and region code; use global for nationwide holidays."
        existing = [self._row_values(value) for value in self.model]
        if info is not None:
            existing.remove(self._row_values(info))
        return row, self._selection_error(existing + [row])

    def open_add_edit_dialog(self, info=None):
        # A GTK TreeModelRow and its caller's iterator become invalid if an
        # external settings update rebuilds the model while this modal runs.
        revision = self._settings_revision
        info = list(info) if info is not None else None
        dialog = Gtk.Dialog(title="Add country calendar" if info is None else "Edit country calendar",
                            transient_for=self.get_toplevel(), modal=True)
        dialog.add_buttons("Cancel", Gtk.ResponseType.CANCEL, "Save", Gtk.ResponseType.OK)
        fields = self._dialog_fields(dialog, info)
        status = Gtk.Label(xalign=0)
        status.set_line_wrap(True)
        dialog.get_content_area().pack_start(status, False, False, 0)
        dialog.show_all()
        try:
            while dialog.run() == Gtk.ResponseType.OK:
                if revision != self._settings_revision:
                    self.status.set_text("Country calendars changed while this dialog was open. Reopen Add or Edit to continue.")
                    return None
                row, error = self._dialog_candidate(fields, info)
                if not error:
                    return [row[column["id"]] for column in self.columns]
                status.set_text(error)
            return None
        finally:
            dialog.destroy()


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
        self._build_unavailable()
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

    def _build_unavailable(self):
        expander = Gtk.Expander(label="Unavailable calendars")
        self.unavailable_list = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_min_content_height(100)
        scroll.set_max_content_height(240)
        scroll.add(self.unavailable_list)
        expander.add(scroll)
        self.pack_start(expander, False, False, 0)

    def _add_unavailable(self, identifier, filename, name, detail, chosen):
        row = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        row.calendar_id, row.calendar_filename = identifier, filename
        label = Gtk.Label(label=f"{name} · {detail}", xalign=0)
        label.set_line_wrap(True)
        label.set_max_width_chars(60)
        label.set_ellipsize(Pango.EllipsizeMode.END)
        row.pack_start(label, False, False, 0)
        actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        row.remove_button = row.clear_button = None
        if filename is not None:
            row.remove_button = Gtk.Button(label="Remove file")
            row.remove_button.connect("clicked", self._on_unavailable_remove, row)
            actions.pack_start(row.remove_button, False, False, 0)
        if identifier in chosen:
            row.clear_button = Gtk.Button(label="Clear selection")
            row.clear_button.connect("clicked", self._on_clear_selection, identifier)
            actions.pack_start(row.clear_button, False, False, 0)
        row.pack_start(actions, False, False, 0)
        self.unavailable_list.pack_start(row, False, False, 0)

    def _unavailable_file(self, entry, chosen):
        path, manifest = entry["path"], entry["manifest"]
        identifier = path.stem if path.stem in selected_ids([path.stem]) else None
        if manifest is None:
            name, detail = filename_display_text(path.name), "Invalid calendar file"
        else:
            name = manifest["name"]
            coverage = manifest["coverage"]
            detail = f'Coverage: {coverage["from"]}–{coverage["through"]}'
        self._add_unavailable(identifier, path.name, name, detail, chosen)

    def _show_unavailable(self, found, available, chosen):
        for row in self.unavailable_list.get_children():
            row.destroy()
        active = {manifest["id"] for manifest in available}
        installed = {entry["path"].stem for entry in found}
        for entry in found:
            if entry["manifest"] is None or entry["manifest"]["id"] not in active:
                self._unavailable_file(entry, chosen)
        for identifier in chosen:
            if identifier not in installed:
                self._add_unavailable(identifier, None, identifier, "Not loaded", chosen)
        self.unavailable_list.show_all()

    def _on_clear_selection(self, _button, identifier):
        self._forget_selection(identifier)
        self.on_setting_changed()

    def _forget_selection(self, identifier):
        self.set_value([value for value in selected_ids(self.get_value()) if value != identifier])

    def _on_unavailable_remove(self, _button, row):
        self._remove_calendar(lambda: plugin_data.remove_plugin_file(row.calendar_filename), row.calendar_id)

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
                self.status.set_text("At most 32 calendars can be selected. Disable a calendar or clear a selection under Unavailable calendars.")
                return
            chosen.append(identifier)
        elif not checkbox.get_active() and identifier in chosen:
            chosen.remove(identifier)
        self.set_value(chosen)

    def _add_choice(self, manifest, chosen):
        row = Gtk.ListBoxRow()
        row.calendar_id = manifest["id"]
        checkbox = Gtk.CheckButton(label=manifest["name"])
        label = checkbox.get_child()
        label.set_max_width_chars(40)
        label.set_ellipsize(Pango.EllipsizeMode.END)
        checkbox.set_active(manifest["id"] in chosen)
        checkbox.set_tooltip_text(f'{manifest["name"]}\n{manifest["category"]} · {manifest["source"]["name"]}')
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
                     if entry["manifest"] is not None and plugin_data.available(entry["manifest"], current)]
        for manifest in available:
            self._add_choice(manifest, chosen)
        self._show_unavailable(found, available, chosen)
        self.status.set_text(self._availability_message(available, errors))
        self.listbox.show_all()

    def _availability_message(self, available, errors):
        if errors:
            return "Some installed calendars could not be loaded. Check Unavailable calendars to manage their files and selections."
        if not available:
            return "No installed calendars cover this year. Import a calendar to add choices, or manage files under Unavailable calendars."
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
            self.status.set_text("The calendar could not be imported. Choose a valid calendar JSON file and ensure fewer than 32 files are installed; Unavailable calendars lets you remove old files.")
            return
        self._on_refresh()
        self.status.set_text(f'Imported {manifest["name"]}. Calendars without coverage for this year stay hidden.')

    def _on_remove(self, *_args):
        row = self.listbox.get_selected_row()
        if row is None:
            return
        self._remove_calendar(lambda: plugin_data.remove_plugin(row.calendar_id), row.calendar_id)

    def _remove_calendar(self, remove, identifier):
        try:
            remove()
        except (OSError, ValueError, UnicodeError) as error:
            LOGGER.warning("Calendar removal failed: %s", error)
            self.status.set_text("The calendar could not be removed. Refresh the choices and try again.")
            return
        self._forget_selection(identifier)
        self._on_refresh()
