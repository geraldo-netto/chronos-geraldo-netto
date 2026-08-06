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
# What the field used to say when it refused a name: nothing. See mark_refused.
COUNTRY_NOT_LISTED = _("%s is not in the list, so the holiday country is unchanged")


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
        # the name the field last refused, so the mark can be taken off again
        # and a second refusal of the same name is not re-announced
        self.refused = ""

        SettingsWidget.__init__(self)

        self.model = Gtk.ListStore(str, str, str)
        self.option_map = {}
        # the same rows keyed by their folded label, so a name typed in full can
        # be matched on focus-out without walking the model
        self.typed_map = {}
        for value, label in country_options(info.get("options", {})):
            folded = completion_key(label)
            tree_iter = self.model.append([value, label, folded])
            self.option_map[value] = tree_iter
            self.typed_map[folded] = tree_iter

        self.label = SettingsLabel(info.get("description", ""))
        self.content_widget = Gtk.ComboBox.new_with_model_and_entry(self.model)
        self.content_widget.set_entry_text_column(1)
        self.content_widget.set_id_column(0)

        self.entry = self.content_widget.get_child()
        self.entry.set_placeholder_text(COUNTRY_HINT)
        # the longest country offered is 24 characters; without a bound the
        # entry took arbitrary text and the match func scanned it once per row
        # of the model on every keystroke, on the GTK main thread
        self.entry.set_max_length(common.MAX_COMPLETION_INPUT_LENGTH)
        self.completion = self.attach_completion()

        self.pack_start(self.label, False, False, 0)
        self.pack_end(self.content_widget, False, False, 0)
        self.set_tooltip_text(info.get("tooltip", ""))

        self.attach()

    def attach_completion(self):
        # the combo's own model: the row the user picks is a row the combo can be
        # set active on, which is what saves the value
        return common.attach_completion(
            self.entry, self.model, text_column=1, minimum_key_length=1,
            inline_completion=True, on_selected=self.on_completion_selected)

    def on_completion_selected(self, completion, model, tree_iter) -> bool:
        # setting the row active fills the entry from the model and emits
        # 'changed', which is what writes the value
        self.content_widget.set_active_iter(tree_iter)
        return True

    def on_setting_changed(self, *args):
        self.value = self.get_value()
        self.content_widget.set_active_iter(self.option_map.get(self.value))

    def mark_refused(self, typed):
        """Say that a typed name was refused, or take the mark back off.

        `restore_entry_text` records what saying nothing cost: the country
        snapped back "with no error text, no error style and no message
        anywhere, unlike the sibling widgets". This is that message, and it is
        the shared affordance the world-clock dialog uses, so the field is
        marked for a theme and described for a screen reader in one call.
        """
        self.refused = typed or ""
        common.set_invalid(self.entry, bool(self.refused),
                           COUNTRY_NOT_LISTED % self.refused if self.refused else "")

    def connect_widget_handlers(self, *args):
        self.content_widget.connect('changed', self.on_combo_changed)
        # the mark describes text that is no longer on screen once the user
        # starts answering it
        self.entry.connect('changed', self.on_entry_edited)
        # the ways an edit ends. Not 'changed', which is every keystroke and
        # which get_active_iter() answers None for while a name is half-typed.
        self.entry.connect('activate', self.on_entry_commit)
        self.entry.connect('focus-out-event', self.on_entry_commit)
        # closing the settings window while the cursor is still in the field
        # never fires focus-out, and the country the user typed would go with it
        self.entry.connect('destroy', self.on_entry_commit)

    def on_entry_edited(self, *args):
        if self.refused:
            self.mark_refused(None)

    def on_combo_changed(self, widget):
        tree_iter = widget.get_active_iter()
        # None while the user is typing: half a country name is not a choice
        if tree_iter is None:
            return

        # a row went active, so the refused name is gone from the field —
        # before the early return below, which a re-pick of the current country
        # would otherwise take with the mark still on
        self.mark_refused(None)
        value = self.model[tree_iter][0]
        if value == self.value:
            return

        self.value = value
        self.set_value(value)

    def on_entry_commit(self, *args) -> bool:
        self.restore_entry_text()
        # False: an 'activate', a focus change or a teardown carries on as it
        # would have
        return False

    def restore_entry_text(self):
        # A country typed out in full used to be thrown away. GtkComboBox's
        # entry-contents-changed handler sets the active item to -1 on every
        # edit, so get_active_iter() is None while typing and on_combo_changed
        # returns early; then focus-out rewrote the entry from self.value.
        # Typing "Brazil" over "Portugal" and pressing Tab snapped back to
        # Portugal, the key was never written, and holidays kept coming from
        # Portugal — with no error text, no error style and no message anywhere,
        # unlike the sibling widgets, which either commit on focus-out
        # (WeatherLocationEntry.on_commit) or say why the input was refused
        # (TIMEZONE_INVALID_PREVIEW). Restore only when nothing matches, and say
        # so: the restore is the whole reason a message is needed, because after
        # it the field reads as if the user had never typed anything.
        text = self.entry.get_text()
        typed = self.typed_map.get(completion_key(text))
        if typed is not None:
            # set_active_iter fills the entry from the model and emits 'changed',
            # which is what writes the value
            self.content_widget.set_active_iter(typed)
            return

        tree_iter = self.option_map.get(self.value)
        # "" and not None: set_text is annotated non-nullable, and None raises
        # out of the focus handler and takes the settings window with it
        if tree_iter is None:
            self.entry.set_text("")
        else:
            self.entry.set_text(self.model[tree_iter][1])
        # after the restore, so the entry's own 'changed' does not take the mark
        # straight back off. An empty field is not a wrong one, it is an
        # unfinished one — the same rule the clock dialog states.
        self.mark_refused(text.strip())
