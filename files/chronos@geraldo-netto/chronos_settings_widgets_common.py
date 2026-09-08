#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.


from __future__ import annotations

from typing import Any, Optional
from zoneinfo import available_timezones
try:
    import pytz
except ImportError:
    pytz = None
from gi.repository import Atk, Gtk
from JsonSettingsWidgets import JSONSettingsBackend
from xapp.SettingsWidgets import ComboBox

# The gi-free half of the feature — timezone identity and city names — lives in a
# sibling with no Gtk/Atk/GLib. What is left here is what the three feature
# modules (weather, holidays, world clocks) genuinely share: the folded
# substring matcher, one process-wide timezone index, the completion wiring
# and their small reusable accessibility/error affordances.
from chronos_settings_i18n import report_pending_warnings
from chronos_text import diagnostic_text
from chronos_timezone_data import (
    completion_key,
    TimezoneResolver,
)



# The longest IANA identifier is 32 characters (America/Argentina/ComodRivadavia)
# and the longest country the dialog offers is 24 (United States of America), so
# this bounds both completion entries well clear of anything legitimate. Without
# it the entry accepted arbitrary text and every keystroke ran the match func
# once per row over it.
MAX_COMPLETION_INPUT_LENGTH = 64

_COMPLETION_KEYS: dict[str, str] = {}
MAX_COMPLETION_KEYS = 8

_DIAGNOSTICS_REPORTED = False


def report_startup_diagnostics() -> None:
    """Emit what loading this page's modules had to say, once.

    Every widget class this settings page can build calls this first. The
    diagnostics are collected at import and emitted here for the reason
    chronos_timezone_data states beside its own warning: importing a module
    should define things, not emit them, and at import time cinnamon-settings
    has not configured logging yet, so the line landed on the whole process's
    stderr or was dropped entirely, depending on import order.
    """
    global _DIAGNOSTICS_REPORTED
    if _DIAGNOSTICS_REPORTED:
        return

    _DIAGNOSTICS_REPORTED = True
    report_pending_warnings()


class OptionLabelComboBox(ComboBox, JSONSettingsBackend):
    """A JSON combobox whose accessible name matches its visible option.

    XApp stores the machine value in model column 0 and makes it the combo's ID
    column. GTK then exposes that ID as the accessible name (for example `si`
    or `global`) even though column 1 visibly says `SI (Celsius)` or
    `Nationwide only`. Keep XApp's persistence contract and explicitly name the
    control from the same display-label column its renderer uses.
    """

    bind_dir = None

    def __init__(self, info, key, settings):
        report_startup_diagnostics()
        self.backend = "json"
        self.key = key
        self.settings = settings
        self.default = info.get("default")
        options = [(value, label)
                   for label, value in info.get("options", {}).items()]

        ComboBox.__init__(
            self, label=info.get("description", ""), options=options,
            tooltip=info.get("tooltip", ""))
        self.attach()

    def _sync_accessible_name(self):
        tree_iter = self.content_widget.get_active_iter()
        label = self.model[tree_iter][1] if tree_iter is not None else ""
        accessible = self.content_widget.get_accessible()
        if accessible is not None and hasattr(accessible, "set_name"):
            accessible.set_name(label)

    def on_setting_changed(self, *args):
        value = self.get_value()
        if (not isinstance(value, str) or
                (value not in self.option_map and self.default in self.option_map)):
            self.set_value(self.default)
        ComboBox.on_setting_changed(self, *args)
        self._sync_accessible_name()

    def on_my_value_changed(self, widget):
        ComboBox.on_my_value_changed(self, widget)
        self._sync_accessible_name()


def folded_completion_key(key) -> str:
    """Fold the needle once per keystroke rather than once per row.

    GTK calls a match func for every row of the model with the same key, and
    completion_key() makes three fresh copies of it (strip, lower, replace) —
    so the timezone model's ~600 rows meant 1800 copies of the needle per
    character typed. Both matchers used to call it per row while their
    docstrings claimed "the needle is folded once by the caller"; this is the
    caller that makes that true.

    Eight recent keys let independently focused country, city and timezone
    fields reuse their folds without retaining an unbounded typing history.
    """
    if not isinstance(key, str) or len(key) > MAX_COMPLETION_INPUT_LENGTH:
        return completion_key(key)
    folded = _COMPLETION_KEYS.pop(key, None)
    if folded is None:
        folded = completion_key(key)
    _COMPLETION_KEYS[key] = folded
    if len(_COMPLETION_KEYS) > MAX_COMPLETION_KEYS:
        del _COMPLETION_KEYS[next(iter(_COMPLETION_KEYS))]
    return folded


def plain_completion_match(completion, key, tree_iter, model) -> bool:
    """Does this suggestion contain what the user has typed?

    GTK calls this for every row of the model on every keystroke, so what it
    does per row is what decides whether typing feels instant. The timezone
    field's copy of it used to build "%s %s" % (label, timezone) and fold it for
    each of ~600 rows, every time. Measured with 599 zones: 2.76 ms per
    keystroke, against 1.13 ms once the folded text is precomputed into the
    model's last column and the needle is folded once by the caller.

    Substring, not prefix: people type the city, and the city sits at the end of
    the identifier (America/Argentina/Buenos_Aires).

    The last column, so one matcher serves a two-column model whose suggestion
    is the value — a city, a country — and a three-column one whose suggestion
    is a label for a value behind it.
    """
    needle = folded_completion_key(key)
    if not needle:
        return False

    return needle in model[tree_iter][-1]


# Keyed by what the rows *are*, not by which list object they arrived in, and by
# the transform itself rather than its address.
#
# There were two of these, one per feature. Both were keyed by the content, both
# lived for the process, and both had this history: the timezone one was keyed
# by id(completions), holding a strong reference to the list and its ListStore
# so the id could not be reused, with no eviction path at all. Every ClocksList
# builds its own resolver and therefore its own completions list, so the memo
# never hit across instances - it accumulated one 439-row store per settings page
# ever constructed. A cache that cannot hit is a leak wearing a cache's clothes.
#
# Half of that survived the merge as id(row_columns): the key kept the rows
# alive and nothing kept the *function* alive, so a freed callable's address was
# free to be handed to the next one. Two transforms over the same rows are not a
# hypothetical - CPython reuses the block immediately - and the second one was
# given the first one's columns.
_COMPLETION_MODELS: dict[tuple, Any] = {}


def completion_model(rows, row_columns):
    """The suggestions as a Gtk.ListStore, built once per distinct row list.

    `row_columns` turns one row into the model's columns, the last of which is
    the folded text plain_completion_match searches. Folding it here - once per
    row, at build time - is what keeps that function's per-row work to a
    substring test. The lists never change while cinnamon-settings runs, and
    every page that asks for one asks for the same one.
    """
    # the function, not its address: it is hashable, and holding it in the key
    # is what stops its identity being recycled under the memo
    key = (row_columns, tuple(rows))
    cached = _COMPLETION_MODELS.get(key)
    if cached is not None:
        return cached

    columns = [row_columns(row) for row in rows]
    model = Gtk.ListStore(*([str] * len(columns[0]))) if columns else Gtk.ListStore(str)
    for values in columns:
        model.append(values)

    _COMPLETION_MODELS[key] = model
    return model


def attach_completion(entry, model, text_column=0, minimum_key_length=2,
                      inline_completion=False, on_selected=None):
    """Give an entry a folded-substring autocompletion over `model`.

    This was written out three times, differing only in these three settings
    and in whether a 'match-selected' handler was connected.

    `inline_completion` is the one that is not a preference: it types the
    suggestion into the entry, which is safe only where the suggestion *is* the
    value. The timezone field's suggestion is a label for an identifier behind
    it, so completing it inline would write a label where a zone must go.
    """
    completion = Gtk.EntryCompletion()
    completion.set_model(model)
    completion.set_text_column(text_column)
    completion.set_minimum_key_length(minimum_key_length)
    completion.set_popup_completion(True)
    completion.set_inline_completion(inline_completion)
    completion.set_match_func(plain_completion_match, model)
    if on_selected is not None:
        completion.connect('match-selected', on_selected)
    entry.set_completion(completion)
    return completion


def attach_suggestions(entry, rows, row_columns, text_column=0,
                       minimum_key_length=2, inline_completion=False,
                       on_selected=None):
    """Suggestions for `entry`, built from `rows` through `row_columns`.

    The world-clock dialog and the weather page each wrote this out as a
    columns function, a model function over `completion_model` and an attach
    function over `attach_completion` - including the same "no rows, no
    completion" guard, which is what this shares. An empty suggestion list is a
    field with no completion at all, not a completion that matches nothing.

    The holiday country field does not come through here: its model is the
    combo's own, so it has rows without a row-columns transform of its own.
    """
    if not rows:
        return None

    return attach_completion(
        entry, completion_model(rows, row_columns), text_column=text_column,
        minimum_key_length=minimum_key_length,
        inline_completion=inline_completion, on_selected=on_selected)


class CommitOnEditEnd:
    """The edit-end lifecycle the two free-text settings fields share.

    An edit in a Gtk.Entry ends in three ways, and both the weather location and
    the holiday country have to answer all three: Enter (`activate`), leaving the
    field (`focus-out-event`), and the settings window closing with the cursor
    still in the field - which fires no focus-out at all, so what the user typed
    would go with it - which is `destroy`. `changed` is not one of them: it is
    every keystroke, and a combo answers `get_active_iter()` None for it while a
    name is half-typed.

    A user of this mixin supplies `commit_edit()`, which is what ending an edit
    means for it, and `on_entry_edited()`, which is what a keystroke does to a
    standing refusal mark. The mark itself stays per widget: the two say
    different things about different targets, and only the shape below was ever
    the same.
    """

    def connect_edit_end_handlers(self, entry):
        # the mark describes text that is no longer on screen once the user
        # starts answering it
        entry.connect("changed", self.on_entry_edited)
        entry.connect("activate", self.on_edit_end)
        entry.connect("focus-out-event", self.on_edit_end)
        # Gtk.Entry clears its text before its destroy signal. The enclosing
        # settings widget still owns the live entry during its own destruction.
        self.connect("destroy", self.on_edit_end)

    def on_edit_end(self, *args) -> bool:
        self.commit_edit()
        # False: an 'activate', a focus change or a teardown carries on as it
        # would have
        return False


# GTK's own name for "this widget is holding something wrong". Themes draw it;
# assistive technologies report it.
#
# The trio below lived in the world-clock module, which is why it was the only
# one of the three feature dialogs that had an error affordance at all: the
# holiday widget records in its own comment that "the key was never written, and
# holidays kept coming from Portugal, with no error text, no error style and no
# message anywhere, unlike the sibling widgets", and the weather field had none
# either.
ERROR_STYLE_CLASS = "error"


def _style_context(widget):
    getter = getattr(widget, "get_style_context", None)
    return getter() if getter else None


def set_error_state(label, is_error):
    """Colour is not a cue on its own, but its absence is not one either."""
    style = _style_context(label)
    if style is None:
        return

    if is_error:
        style.add_class(ERROR_STYLE_CLASS)
    else:
        style.remove_class(ERROR_STYLE_CLASS)


def set_invalid(widget, is_invalid, description=""):
    """Mark the entry itself, which is what an assistive technology asks about.

    `description` is the generic message for the field, and it is the caller's:
    "Invalid timezone" is not what a country combo or a city field would say.
    """
    entry = getattr(widget, "bind_object", widget)
    style = _style_context(entry)
    if style is not None:
        if is_invalid:
            style.add_class(ERROR_STYLE_CLASS)
        else:
            style.remove_class(ERROR_STYLE_CLASS)

    accessible = getattr(entry, "get_accessible", None)
    if accessible:
        atk = accessible()
        if hasattr(atk, "set_description"):
            atk.set_description(diagnostic_text(description) if is_invalid else "")


def _relate(atk, label, described):
    """At most one DESCRIBED_BY target, and only while the message is about it.

    atk_object_add_relationship appends to the existing relation's target list
    rather than replacing it, so removing first is what makes calling this twice
    the same as calling it once. Removing a relation that is not there is a
    no-op, which is also how the "stop describing this field" case is served.
    """
    target = label.get_accessible() if hasattr(label, "get_accessible") else None
    if target is None or not hasattr(atk, "remove_relationship"):
        return

    # ATK_RELATION_DESCRIBED_BY: "the thing that explains me is that label"
    atk.remove_relationship(Atk.RelationType.DESCRIBED_BY, target)
    if described and hasattr(atk, "add_relationship"):
        atk.add_relationship(Atk.RelationType.DESCRIBED_BY, target)


def describe_widget(widget, label, text):
    """Tie the message to the field it is about, for a screen reader.

    Empty `text` means "the message is not about this field", and takes the tie
    off again. Nothing used to: the only caller runs on every keystroke, so an
    invalid field stacked the same DESCRIBED_BY target once per character, and a
    field that stopped being the invalid one kept pointing at a preview label
    that had since started explaining the *other* field. A valid timezone with
    an empty display name announced "Enter a display name for this clock" on the
    timezone entry. set_invalid clears the widgets it is not marking; this now
    does the same.
    """
    if widget is None:
        return

    entry = getattr(widget, "bind_object", widget)
    accessible = getattr(entry, "get_accessible", None)
    if not accessible:
        return

    atk = accessible()
    if hasattr(atk, "set_description"):
        atk.set_description(text)
    _relate(atk, label, bool(text))



_TIMEZONE_RESOLVER: Optional[TimezoneResolver] = None


def shared_timezone_resolver() -> TimezoneResolver:
    """Build the settings process's timezone index on its first real use."""
    global _TIMEZONE_RESOLVER
    if _TIMEZONE_RESOLVER is None:
        _TIMEZONE_RESOLVER = TimezoneResolver(pytz, available_timezones)

    return _TIMEZONE_RESOLVER
