#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

"""The holiday-country settings widget.

One feature per module, beside chronos_settings_widgets_weather and the world-clock
stack; chronos_settings_widgets_common keeps only what the features share.
"""

from __future__ import annotations

from JsonSettingsWidgets import JSONSettingsBackend
from xapp.SettingsWidgets import SettingsLabel, SettingsWidget
from gi.repository import Gtk

import chronos_settings_widgets_common as common
from chronos_timezone_data import completion_key
from chronos_settings_i18n import _

COUNTRY_HINT = _("Type a country name")


def country_options(options: dict) -> list[tuple[str, str]]:
    """The schema's {label: value} map as (value, label) rows, schema order kept.

    Schema order puts "None (disable holidays)" first and the countries after it
    alphabetically. Sorting here would bury the off switch in the C's.
    """
    return [(value, label) for label, value in options.items()]


class CountryComboBox(SettingsWidget, JSONSettingsBackend):
    """The holiday country, picked from the list or typed into.

    The list is ~100 countries deep. A plain Gtk.ComboBox has no type-ahead at
    all, so choosing Zimbabwe meant scrolling to it; and the one key GTK does
    honour on a closed combo cycles the *value*, which on this widget silently
    saves a different country and fires a holiday lookup for it. An entry with a
    completion makes typing the fast path and leaves the dropdown intact.

    Typed text that names no country is never saved: the value changes only when
    a row is chosen, and the field is put back to the current country when focus
    leaves it, so the dialog cannot sit there showing a country the applet is not
    using.
    """

    bind_dir = None

    def __init__(self, info, key, settings):
        self.backend = "json"
        self.key = key
        self.settings = settings
        self.value = None

        SettingsWidget.__init__(self)

        self.model = Gtk.ListStore(str, str, str)
        self.option_map = {}
        for value, label in country_options(info.get("options", {})):
            self.option_map[value] = self.model.append(
                [value, label, completion_key(label)])

        self.label = SettingsLabel(info.get("description", ""))
        self.content_widget = Gtk.ComboBox.new_with_model_and_entry(self.model)
        self.content_widget.set_entry_text_column(1)
        self.content_widget.set_id_column(0)

        self.entry = self.content_widget.get_child()
        self.entry.set_placeholder_text(COUNTRY_HINT)
        self.completion = self.attach_completion()

        self.pack_start(self.label, False, False, 0)
        self.pack_end(self.content_widget, False, False, 0)
        self.set_tooltip_text(info.get("tooltip", ""))

        self.attach()

    def attach_completion(self):
        completion = Gtk.EntryCompletion()
        # the combo's own model: the row the user picks is a row the combo can be
        # set active on, which is what saves the value
        completion.set_model(self.model)
        completion.set_text_column(1)
        completion.set_minimum_key_length(1)
        completion.set_popup_completion(True)
        completion.set_inline_completion(True)
        completion.set_match_func(common.plain_completion_match, self.model)
        completion.connect('match-selected', self.on_completion_selected)
        self.entry.set_completion(completion)
        return completion

    def on_completion_selected(self, completion, model, tree_iter) -> bool:
        # setting the row active fills the entry from the model and emits
        # 'changed', which is what writes the value
        self.content_widget.set_active_iter(tree_iter)
        return True

    def on_setting_changed(self, *args):
        self.value = self.get_value()
        self.content_widget.set_active_iter(self.option_map.get(self.value))

    def connect_widget_handlers(self, *args):
        self.content_widget.connect('changed', self.on_combo_changed)
        self.entry.connect('focus-out-event', self.on_entry_focus_out)

    def on_combo_changed(self, widget):
        tree_iter = widget.get_active_iter()
        # None while the user is typing: half a country name is not a choice
        if tree_iter is None:
            return

        value = self.model[tree_iter][0]
        if value == self.value:
            return

        self.value = value
        self.set_value(value)

    def on_entry_focus_out(self, *args) -> bool:
        self.restore_entry_text()
        # False: let GTK carry on with the focus change
        return False

    def restore_entry_text(self):
        tree_iter = self.option_map.get(self.value)
        # "" and not None: set_text is annotated non-nullable, and None raises
        # out of the focus handler and takes the settings window with it
        if tree_iter is None:
            self.entry.set_text("")
            return

        self.entry.set_text(self.model[tree_iter][1])
