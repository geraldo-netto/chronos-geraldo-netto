#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

"""The world-clocks settings stack: the list, its add/edit dialog, and the
timezone suggestions they share.

One feature per module, beside chronos_settings_widgets_weather and
chronos_settings_widgets_holidays; chronos_settings_widgets_common keeps only what the
features share — the folded-substring matcher and the process-wide timezone
resolver.
"""

from __future__ import annotations

from JsonSettingsWidgets import JSONSettingsList
from xapp.SettingsWidgets import Entry
import logging
from typing import Optional
from gi.repository import GLib, Gtk

import chronos_settings_widgets_common as common
from chronos_text import TEXT_WHITESPACE, sanitize_control_characters, trim_text, valid_unicode
from chronos_timezone_data import (
    completion_key,
    is_runtime_builtin_timezone,
    runtime_local_timezone,
    zoneinfo_identifier,
)
from chronos_settings_i18n import _

# i18n: bind the domain to a module-level name. Installing the translator
# globally would inject _ into builtins for the whole cinnamon-settings
# process and could shadow another xlet's translator.
#
# The applet can be installed per-user or system-wide, and the catalogs follow
# it. Binding only to $HOME meant a system-wide install silently fell back to
# NullTranslations - fallback=True - and the whole dialog reverted to English.
# chronos_settings_i18n keeps the same lookup available to the standalone About window
# without importing this module's Cinnamon settings dependencies.

LOGGER = logging.getLogger("chronos@geraldo-netto.settings")

# user-configurable clocks; the applet always shows built-in UTC and local rows.
# Kept here, not in chronos_timezone_data: schema_static reads this file for the cap and
# the world-clock list height is checked against it.
MAX_CLOCKS = 8
# Rows *examined*, which is not the same bound as rows kept: normalize_saved_clocks
# stops once MAX_CLOCKS rows have been accepted, so a list whose entries are all
# rejected — every one of them spelling a zone the applet already draws, say —
# never fills that quota and walks the whole array before the settings page is
# drawn. The dialog cannot write more than MAX_CLOCKS rows, so anything past
# this came from a hand-edited instance file, and eight rejects for every row
# that could be kept is already more tolerance than a real list needs.
MAX_SAVED_CLOCK_ROWS = MAX_CLOCKS * 8
MAX_CLOCK_INPUT_LABEL_LENGTH = 128
MAX_CLOCK_TIMEZONE_LENGTH = common.MAX_COMPLETION_INPUT_LENGTH
# idles spent waiting for the settings window to be parented before giving up on
# centering it; without a bound this is a busy loop that never ends
MAX_CENTER_ATTEMPTS = 100
TIMEZONE_TEXT_HINT = _("City or timezone (e.g. Buenos Aires)")
TIMEZONE_PREVIEW_TEMPLATE = _("Timezone to save: %s")
TIMEZONE_INVALID_PREVIEW = _("Invalid timezone")
TIMEZONE_EMPTY_PREVIEW = _("No timezone selected")
TIMEZONE_RESERVED_PREVIEW = _("UTC and local time are already shown as built-in clocks")
TIMEZONE_DUPLICATE_PREVIEW = _("This timezone is already in the list")
LABEL_MISSING_PREVIEW = _("Enter a display name for this clock")
# Why the Add button is dead at the cap. It is the button's tooltip and the text
# of the dialog that open_add_edit_dialog still raises — the same sentence, so a
# user who reaches it by either route reads the same thing.
CLOCK_LIMIT_MESSAGE = _("No more than %d clocks can be added.") % MAX_CLOCKS

NO_TIMEZONE_DATA_HINT = _(
    "No timezone database found. Install python3-pytz to type a city name; "
    "without it, only a full identifier such as America/Sao_Paulo is accepted."
)


def center_window(window) -> bool:
    """Put a settings window in the middle of the monitor it opened on.

    cinnamon-settings leaves placement to the window manager, which drops the
    xlet dialog wherever the last one landed. set_position() is a no-op once a
    window is realized, so measure the work area and move it.
    """
    if window is None or not hasattr(window, "get_size"):
        return False

    try:
        width, height = window.get_size()
        display = window.get_display()
        monitor = display.get_monitor_at_window(window.get_window())
        area = monitor.get_workarea()
    # a headless or unusual display: leave the WM to place it. Narrow, because
    # `except Exception` here also swallowed the AttributeError from a typo or a
    # Gtk API change, and a programming error would then be indistinguishable
    # from a display that cannot answer.
    except (AttributeError, TypeError, ValueError, GLib.Error):
        LOGGER.debug("could not center the settings window", exc_info=True)
        return False

    window.move(
        area.x + max((area.width - width) // 2, 0),
        area.y + max((area.height - height) // 2, 0),
    )
    return True


def timezone_completion_selected(completion, model, tree_iter) -> bool:
    # put the identifier in the entry, not the pretty label, so the value the
    # dialog saves is the value the applet reads back.
    entry = completion.get_entry()
    entry.set_text(model[tree_iter][1])
    entry.set_position(-1)
    return True


def _timezone_completion_columns(row):
    """label, identifier, and the folded text the matcher searches."""
    display, timezone = row
    return [display, timezone, completion_key("%s %s" % (display, timezone))]


def timezone_completion_model(completions):
    return common.completion_model(completions, _timezone_completion_columns)


def attach_timezone_completion(entry, completions):
    """Give a timezone Gtk.Entry a city-name autocompletion."""
    # not inline: the suggestion is a label, and the field must hold the
    # identifier behind it, so only an explicit pick fills it
    return common.attach_suggestions(
        entry, completions, _timezone_completion_columns,
        on_selected=timezone_completion_selected)


class ListEditEntry(Entry):
    """A text column of the add/edit dialog, optionally autocompleting."""

    def __init__(self, completions=None, placeholder=None, max_length=None, **kwargs):
        super().__init__(**kwargs)
        self.bind_object = self.content_widget
        # A hint about what to type belongs *in* the empty field, not in the
        # label beside it: using it as the label left the dialog naming the
        # field with a sentence while the column heading above it said
        # "Timezone" - two names for one thing.
        if placeholder and hasattr(self.bind_object, "set_placeholder_text"):
            self.bind_object.set_placeholder_text(placeholder)
        if max_length and hasattr(self.bind_object, "set_max_length"):
            self.bind_object.set_max_length(max_length)
        if completions:
            self.completion = attach_timezone_completion(self.bind_object, completions)

    # get_value/set_value are xapp's ComboBox contract, which its
    # connect_widget_handlers() calls. An Entry has no such caller — this class
    # never calls connect_widget_handlers(), xapp's Entry base does not, and
    # ClockDialogBuilder uses only get_widget_value/set_widget_value — so the
    # pair that used to sit here was dead.
    def set_widget_value(self, value):
        self.bind_object.set_property(self.bind_prop, value)

    def get_widget_value(self):
        return self.bind_object.get_property(self.bind_prop)


def list_edit_factory(params):
    """Build one column widget for the add/edit dialog.

    The class above used to be declared inside this function, so every call
    defined a new PyGObject subclass - and PyGObject registers a GType per
    subclass, which is never unregistered. That leaked a GType, with its class
    structure and closures, on every Add or Edit click, for the life of the
    settings process.
    """
    # the title is a schema string, which is an English msgid: translate it once,
    # here. It used to be handed a string that had *already* been translated
    # (TIMEZONE_TEXT_HINT), so the second lookup missed and returned it unchanged
    # - working by accident, and only until a translated string collided with
    # another msgid.
    kwargs = {'label': _(params['title'])}

    return ListEditEntry(completions=params.get('completions'),
                         placeholder=params.get('placeholder'),
                         max_length=params.get('max_length'), **kwargs)

def normalize_clock_label(value):
    if not isinstance(value, str) or not valid_unicode(value):
        return ""
    normalized = trim_text(sanitize_control_characters(value))
    if len(normalized) <= MAX_CLOCK_INPUT_LABEL_LENGTH:
        return normalized
    return normalized[:MAX_CLOCK_INPUT_LABEL_LENGTH - 1].rstrip(TEXT_WHITESPACE) + "…"


def normalize_saved_clock(row, local_timezone=None) -> Optional[dict[str, str]]:
    if not isinstance(row, dict):
        return None
    label = normalize_clock_label(row.get("label"))
    timezone = row.get("timezone")
    if not label or not isinstance(timezone, str) or not valid_unicode(timezone):
        return None
    timezone = trim_text(timezone)
    if (not timezone or len(timezone) > MAX_CLOCK_TIMEZONE_LENGTH or
            is_runtime_builtin_timezone(timezone, local_timezone)):
        return None
    return {"label": label, "timezone": timezone}


def normalize_saved_clocks(value) -> list[dict[str, str]]:
    """Project saved JSON onto the runtime's effective user-clock list."""
    if not isinstance(value, list):
        return []

    # Resolved once and passed down. is_runtime_builtin_timezone falls back to
    # local_timezone_name() per call, and that re-reads $TZ or re-follows the
    # /etc/localtime symlink — one syscall per saved row, on the GTK main thread
    # inside ClocksList.__init__, before the page is drawn. The JS twin
    # (worldclockData.selectUserClocks) resolves its built-in keys once outside
    # the loop for the same reason.
    local_timezone = runtime_local_timezone()

    normalized = []
    seen_timezones = set()
    for row in value[:MAX_SAVED_CLOCK_ROWS]:
        clock = normalize_saved_clock(row, local_timezone)
        if clock is None:
            continue
        identity = zoneinfo_identifier(clock["timezone"])
        if identity in seen_timezones:
            continue
        seen_timezones.add(identity)
        normalized.append(clock)
        if len(normalized) >= MAX_CLOCKS:
            break

    return normalized


def normalize_stored_clocks(key, settings, fallback=None) -> list[dict[str, str]]:
    """Project what is stored under `key` and write the projection back.

    Every path that puts rows in front of the user goes through here, not just
    page construction: "Reset to defaults" and "Import from a file" reach the
    list through JSONSettingsHandler.do_key_update, which repopulates from the
    stored value directly. Normalising only in __init__ left those two drawing
    raw JSON — twenty rows, duplicate zones, a 5000-character label — that the
    applet would never show.
    """
    getter = getattr(settings, "get_value", None)
    value = getter(key) if callable(getter) else fallback
    normalized = normalize_saved_clocks(value)
    setter = getattr(settings, "set_value", None)
    if normalized != value and callable(setter):
        setter(key, normalized)
    return normalized


def normalize_clock_setting(info, key, settings):
    prepared = dict(info)
    prepared["value"] = normalize_stored_clocks(key, settings, info.get("value"))
    return prepared


class ClockEntrySerializer:
    """Use the native list's schema order for every positional row boundary."""

    def __init__(self, columns):
        self.column_ids = tuple(column["id"] for column in columns)

    def initial_dialog_data(
        self,
        info: Optional[list[str]],
    ) -> tuple[dict[str, Optional[str]], str]:
        if info is None:
            return dict.fromkeys(self.column_ids), _("Add new entry")

        data = dict(zip(self.column_ids, info))
        data["label"] = normalize_clock_label(data.get("label"))
        return data, _("Edit entry")

    def serialize(self, label: str, timezone: str) -> list[str]:
        values = {"label": normalize_clock_label(label), "timezone": timezone}
        return [values[column] for column in self.column_ids]

# The dialog is modal and sized to its content, so a label that will not wrap is
# a label that decides how wide the window is.
DIALOG_LABEL_WIDTH_CHARS = 52


def wrap_label(label):
    label.set_line_wrap(True)
    label.set_max_width_chars(DIALOG_LABEL_WIDTH_CHARS)


# The error affordance is chronos_settings_widgets_common's: it is the same
# widget-marking for any dialog field, and living here was why this was the only
# one of the three feature dialogs that had one. The generic ATK description is
# this field's, which is why it is an argument.
set_error_state = common.set_error_state
describe_widget = common.describe_widget


def set_invalid(widget, is_invalid):
    common.set_invalid(widget, is_invalid, TIMEZONE_INVALID_PREVIEW)


class ClockDialogStatePresenter:
    """What the dialog says about what the user has typed, and to whom.

    The only feedback was a text swap on a plain Gtk.Label. It had no ATK relation
    to either entry, no error role, and no non-text cue — so a screen-reader user
    typing an invalid zone heard nothing at all, and discovered the failure as an
    OK button that would not activate, with no announcement of which field was
    wrong. A colour-blind user had nothing either, because there was no colour.

    Three things now. The preview *describes* the entry it is about, so a screen
    reader reads it with the field. It takes an error style when the field is
    wrong, so it is visible without reading it. And the entry itself is marked
    invalid, which is what an assistive technology asks about.
    """

    def __init__(self, clocks_list, dialog, preview_label, original_timezone=None):
        self.clocks_list = clocks_list
        self.dialog = dialog
        self.preview_label = preview_label
        self.original_timezone = original_timezone

    def values_from_widgets(self, widgets):
        return {key: widget.get_widget_value() for key, widget in widgets.items()}

    def update(self, widgets):
        values = self.values_from_widgets(widgets)
        has_label = bool(normalize_clock_label(values.get('label')))
        choice = self.clocks_list.resolve_timezone_choice(
            values, self.original_timezone)

        # OK stays insensitive until both fields are right, and the preview only
        # ever spoke about the timezone: someone with a valid timezone and an
        # empty display name saw a perfectly happy preview and a dead OK button,
        # with nothing saying which field was the problem.
        if choice["timezone"] and not has_label:
            self._report(widgets, LABEL_MISSING_PREVIEW, invalid="label")
        elif choice["timezone"]:
            self._report(widgets,
                         self.clocks_list.format_timezone_preview(values, choice))
        else:
            # An empty field is not a wrong one. build_content ends by calling
            # this with both entries still untouched, so the dialog opened with
            # the Timezone entry and the preview drawn in the theme's error
            # colour and a generic "Invalid timezone" ATK description on the
            # entry — telling the user, and a screen reader, that they had
            # entered something wrong before entering anything, while the
            # equally empty Display name was left clean. Only text that resolves
            # to nothing, or a reserved built-in, is invalid; `reserved` already
            # implies `typed_invalid`.
            self._report(widgets,
                         self.clocks_list.format_timezone_preview(values, choice),
                         invalid="timezone" if choice["typed_invalid"] else None)

        self.dialog.set_response_sensitive(
            Gtk.ResponseType.OK,
            has_label and bool(choice["timezone"]))

    def _report(self, widgets, text, invalid=None):
        self.preview_label.set_text(text)

        # the visible cue first: an error style on the label, and the offending
        # entry marked invalid. set_invalid writes a generic "Invalid timezone"
        # ATK description on that entry, so describe_widget has to run *after* it
        # — a valid timezone with an empty name is not an invalid timezone, and
        # the screen reader must hear the real reason, not the generic one.
        #
        # Both, per widget, in one pass. describe_widget used to be called once
        # for the offending field alone, which meant the field that stopped
        # being the offending one was never told: it kept a DESCRIBED_BY
        # relation to a preview label that had moved on to explaining its
        # neighbour. The message is about a field, so a screen reader reads it
        # *with* that field — and only with that field.
        set_error_state(self.preview_label, bool(invalid))
        for field, widget in widgets.items():
            offending = field == invalid
            set_invalid(widget, offending)
            describe_widget(widget, self.preview_label, text if offending else "")

class ClockDialogBuilder:
    def __init__(self, clocks_list):
        self.clocks_list = clocks_list

    def initial_data(self, info):
        return self.clocks_list.entry_serializer.initial_dialog_data(info)

    def build_content(self, dialog, data):
        content = self._build_frame(dialog)
        columns = self._decorate_columns()

        preview_label = self._build_preview_label()
        presenter = ClockDialogStatePresenter(
            self.clocks_list, dialog, preview_label, data.get("timezone"))
        widgets = {}

        def on_widget_changed(bind_object):
            presenter.update(widgets)

        self._add_field_rows(content, columns, data, widgets, on_widget_changed)
        self._add_footer(content, preview_label, bool(widgets))

        on_widget_changed(None)

        return widgets, presenter

    def _build_frame(self, dialog):
        """Dialog chrome only: margins, the framed view, and the box inside it."""
        content_area = dialog.get_content_area()
        content_area.set_margin_right(30)
        content_area.set_margin_left(30)
        content_area.set_margin_top(20)
        content_area.set_margin_bottom(20)

        frame = Gtk.Frame()
        frame.set_shadow_type(Gtk.ShadowType.IN)
        frame_style = frame.get_style_context()
        frame_style.add_class("view")
        content_area.add(frame)

        content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        frame.add(content)
        return content

    def _decorate_columns(self):
        """The schema's columns plus the three decorations only the dialog needs.

        Both columns come from the schema, which is where the list's column
        headings already live; the dialog adds what only it needs.

        By id, not by position: this used to decorate schema_columns[0] and
        [1], so reordering the schema would have put the timezone completions
        and the city placeholder on the Display name field. A missing id is
        skipped rather than raised: the schema is pinned by the suite, and a
        modal that opens with an undecorated entry beats one that cannot open.
        """
        schema_columns = self.clocks_list.settings.get_property(
            self.clocks_list.key, 'columns')
        by_id = {column["id"]: dict(column) for column in schema_columns}
        if "label" in by_id:
            by_id["label"]["max_length"] = MAX_CLOCK_INPUT_LABEL_LENGTH
        if "timezone" in by_id:
            by_id["timezone"]["completions"] = self.clocks_list.completions
            by_id["timezone"]["placeholder"] = TIMEZONE_TEXT_HINT
            # the label column has always been bounded and this one was not, so
            # ListEditEntry's `if max_length` guard skipped set_max_length and
            # the entry accepted arbitrary text — which the match func then
            # scanned once per row of the several-hundred-row completion model,
            # per keystroke, on the GTK main thread
            by_id["timezone"]["max_length"] = common.MAX_COMPLETION_INPUT_LENGTH

        # ...but the schema's order still decides which entry is on top, so the
        # dialog reads in the same order as the list's own headings
        return [by_id[column["id"]] for column in schema_columns]

    def _build_preview_label(self):
        preview_label = Gtk.Label()
        preview_label.set_xalign(0)
        # A Gtk.Label does not wrap unless it is told to, and these two carry
        # sentences: the invalid-timezone preview, and the 140-character hint
        # below. Without a wrap the modal stretched to fit one very wide line —
        # on a 1366 px screen, or in any language whose translation runs longer,
        # the dialog ran off the monitor.
        wrap_label(preview_label)
        return preview_label

    def _add_field_rows(self, content, columns, data, widgets, on_widget_changed):
        for col in columns:
            if len(widgets) != 0:
                content.add(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

            widget = list_edit_factory(col)
            widget.bind_object.connect('changed', on_widget_changed)

            widgets[col['id']] = widget

            settings_box = Gtk.ListBox()
            settings_box.set_selection_mode(Gtk.SelectionMode.NONE)

            content.pack_start(settings_box, True, True, 0)
            settings_box.add(widget)

            if data[col['id']] is not None:
                widget.set_widget_value(data[col['id']])

    def _add_footer(self, content, preview_label, has_fields):
        if has_fields:
            content.add(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        content.add(preview_label)

        # With no timezone database at all there are no suggestions and no city
        # names: say so here, where the user is typing. The warning otherwise
        # only went to a log line nobody opening this dialog will ever read.
        if not self.clocks_list.timezone_resolver.any_timezone_data():
            hint = Gtk.Label()
            hint.set_xalign(0)
            wrap_label(hint)
            hint.set_text(NO_TIMEZONE_DATA_HINT)
            content.add(hint)

    def collect_values(self, widgets, original_timezone=None):
        label = widgets['label'].get_widget_value()
        values = {key: widget.get_widget_value() for key, widget in widgets.items()}
        timezone = self.clocks_list.resolve_timezone_choice(
            values, original_timezone)["timezone"]

        return self.clocks_list.entry_serializer.serialize(label, timezone)

class SettingsWindowCenterer:
    """Centers the settings window, given any widget inside it.

    This used to live inside ClocksList, which made the clock list quietly
    load-bearing: renaming or removing the widget would have taken window
    centering with it, and the idle loop ran for every settings session whether
    or not the user ever opened the World Clocks page. It is not a property of a
    clock list. It is here, on its own, and ClocksList merely hosts it — because
    a widget is the only foothold an xlet has in that window.

    A widget's own "map" is no use: the World Clocks page lives in a stack and is
    not mapped until the user opens that page. An idle runs once the window is
    built and sized, whichever page is showing.
    """

    def __init__(self, widget) -> None:
        self.widget = widget
        self.centered = False
        self.attempts = 0
        self.source_id = 0
        widget.connect("destroy", self.stop)

    def start(self) -> None:
        if self.widget is not None and not self.source_id:
            self.source_id = GLib.idle_add(self.center)

    def stop(self, *_args) -> None:
        if self.source_id:
            GLib.source_remove(self.source_id)
        self._finish()

    def _finish(self) -> bool:
        self.source_id = 0
        self.widget = None
        return False

    def center(self, *args) -> bool:
        if self.widget is None:
            return False

        # An idle that keeps asking to be run again is a busy loop: it pins a
        # core for the life of the settings process, silently. Centering is a
        # nicety - if the window never gets parented, or the display will not
        # answer, give up and let the window manager place it.
        self.attempts += 1
        if self.attempts > MAX_CENTER_ATTEMPTS:
            LOGGER.debug("gave up centering the settings window")
            return self._finish()

        widget = self.widget
        window = widget.get_toplevel() if hasattr(widget, "get_toplevel") else None
        if window is None or not getattr(window, "is_toplevel", lambda: False)():
            # not parented yet: come back on the next idle
            return True

        # a failure here is terminal, not something to retry: center_window()
        # only returns False when the display itself would not answer
        self.centered = True
        center_window(window)
        return self._finish()


class ClocksList(JSONSettingsList):
    def __init__(self, info, key, settings, resolver=None):
        # Built on first use, not at page construction.
        #
        # Opening the applet's settings — any page of them — used to build a
        # 594-entry timezone map, a city map and a 439-entry completions list,
        # and casefold-sort the last of them, on the GTK main thread, for a user
        # who may never open the World Clocks page at all.
        #
        # `resolver` is constructor injection for a caller that already has one;
        # production passes nothing and gets the shared lazy one.
        common.report_startup_diagnostics()
        self._timezone_resolver = resolver
        self._settings_revision = 0

        normalized_info = normalize_clock_setting(info, key, settings)
        JSONSettingsList.__init__(self, key, settings, normalized_info)

        self.entry_serializer = ClockEntrySerializer(self.columns)
        self.dialog_builder = ClockDialogBuilder(self)
        self.status = Gtk.Label(xalign=0)
        self.status.set_line_wrap(True)
        self.pack_start(self.status, False, False, 0)

        self.update_button_sensitivity()

        # hosted, not owned: see SettingsWindowCenterer
        self.window_centerer = SettingsWindowCenterer(self)
        self.window_centerer.start()

    @property
    def timezone_resolver(self):
        if self._timezone_resolver is None:
            self._timezone_resolver = common.shared_timezone_resolver()

        return self._timezone_resolver

    @property
    def completions(self):
        return self.timezone_resolver.completions

    def on_setting_changed(self, *args):
        """Repopulate the tree, then re-judge the Add button against it.

        Cinnamon calls update_button_sensitivity only from List.__init__,
        List.list_changed and the tree selection's "changed" signal. Its
        on_setting_changed clears and repopulates the model and calls none of
        them — and that is the path "Reset to defaults" and "Import from a
        file" take, through JSONSettingsHandler.do_key_update. With eight
        clocks saved and no row selected, a reset emptied the tree while the Add
        button stayed insensitive and still tooltipped "No more than 8 clocks
        can be added.", so no clock could be added until the settings window was
        closed and reopened.

        The projection runs first, for the same reason: the base repopulates
        straight from the stored value, so without it those two entry points
        drew rows the applet drops at runtime, and the Add button and the
        dialog's duplicate check then judged a list that does not exist.
        """
        self._settings_revision += 1
        normalize_stored_clocks(self.key, self.settings)
        super().on_setting_changed(*args)
        self.update_button_sensitivity()

    def update_button_sensitivity(self, *args):
        super().update_button_sensitivity(*args)
        if not self.show_buttons:
            return

        # At the cap the Add button goes insensitive, so replace Cinnamon's
        # stock icon label with the sentence explaining why it cannot be used.
        # Below the cap, restore that label so assistive technology can name the
        # otherwise icon-only control.
        full = self.model.iter_n_children(None) >= MAX_CLOCKS
        self.add_button.set_sensitive(not full)
        if not hasattr(self.add_button, "set_tooltip_text"):
            return

        if full:
            self.add_button.set_tooltip_text(CLOCK_LIMIT_MESSAGE)
        else:
            self.add_button.set_tooltip_text(_("Add new entry"))

    def normalize_timezone(self, value):
        return self.timezone_resolver.normalize(value)

    # One resolve and one OS-zone read per call, through the resolver's
    # classify(), and the answer is passed on rather than recomputed.
    #
    # is_reserved() re-reads the OS zone before deciding (d554f04), so it is the
    # expensive half: an os.readlink of /etc/localtime, on the GTK main thread.
    # It used to run twice here - once directly, once inside normalize() - and
    # the presenter then threw the whole result away and called
    # format_timezone_preview, which resolved again. Four readlinks and six
    # _resolve() calls for one unchanged value, per character typed in *either*
    # entry, since both are connected to the same handler. The two resolves
    # could also observe different local zones, which is how the OK button and
    # the preview came to disagree.
    def _timezone_is_duplicate(self, timezone, original_timezone=None):
        identity = zoneinfo_identifier(timezone)
        column = self.entry_serializer.column_ids.index("timezone")
        occurrences = sum(
            1 for row in self.model
            if zoneinfo_identifier(row[column]) == identity)
        original_identity = (
            zoneinfo_identifier(original_timezone)
            if isinstance(original_timezone, str) else None)
        allowed = 1 if original_identity == identity else 0
        return occurrences > allowed

    def resolve_timezone_choice(self, values, original_timezone=None):
        timezone_text = values.get('timezone')
        has_timezone_text = bool(timezone_text and trim_text(timezone_text))
        reserved, timezone = self.timezone_resolver.classify(timezone_text)
        if reserved:
            return {
                "timezone": None,
                "typed_invalid": True,
                "reserved": True,
                "duplicate": False
            }

        if timezone is not None:
            duplicate = self._timezone_is_duplicate(
                timezone, original_timezone)
            return {
                "timezone": None if duplicate else timezone,
                "typed_invalid": duplicate,
                "reserved": False,
                "duplicate": duplicate
            }

        return {
            "timezone": None,
            "typed_invalid": has_timezone_text,
            "reserved": False,
            "duplicate": False
        }

    def format_timezone_preview(self, values, choice=None):
        """What the dialog says about the timezone as typed.

        `choice` is resolve_timezone_choice()'s answer when the caller already
        has one: the presenter computes it to decide the OK button, and this
        used to resolve the same text over again to describe it.
        """
        if choice is None:
            choice = self.resolve_timezone_choice(values)

        if choice["reserved"]:
            return TIMEZONE_RESERVED_PREVIEW

        if choice["duplicate"]:
            return TIMEZONE_DUPLICATE_PREVIEW

        if choice["timezone"] is None:
            if choice["typed_invalid"]:
                return TIMEZONE_INVALID_PREVIEW
            return TIMEZONE_EMPTY_PREVIEW

        return TIMEZONE_PREVIEW_TEMPLATE % choice["timezone"]

    def _build_dialog_content(self, dialog, data):
        return self.dialog_builder.build_content(dialog, data)

    def _collect_dialog_values(self, widgets, original_timezone=None):
        return self.dialog_builder.collect_values(widgets, original_timezone)

    def _initial_dialog_data(self, info):
        return self.dialog_builder.initial_data(info)

    def _dialog_state_error(self, revision, adding):
        if revision != self._settings_revision:
            return "World clocks changed while this dialog was open. Reopen Add or Edit to continue."
        if adding and self.model.iter_n_children(None) >= MAX_CLOCKS:
            return CLOCK_LIMIT_MESSAGE
        return ""

    def _run_dialog(self, dialog, widgets, presenter, original_timezone, revision, adding):
        while dialog.run() == Gtk.ResponseType.OK:
            error = self._dialog_state_error(revision, adding)
            if error:
                self.status.set_text(error)
                return None
            result = self._collect_dialog_values(widgets, original_timezone)
            if all(result):
                return result
            presenter.update(widgets)
        return None

    def open_add_edit_dialog(self, info=None):
        revision = self._settings_revision
        info = list(info) if info is not None else None
        self.status.set_text("")
        if info is None and self.model.iter_n_children(None) >= MAX_CLOCKS:
            message = Gtk.MessageDialog(self.get_toplevel(), Gtk.DialogFlags.MODAL,
                                        Gtk.MessageType.INFO, Gtk.ButtonsType.OK,
                                        CLOCK_LIMIT_MESSAGE)
            message.run()
            message.destroy()
            return None

        data, title = self._initial_dialog_data(info)
        original_timezone = data.get("timezone") if info is not None else None

        dialog = Gtk.Dialog(title, self.get_toplevel(), Gtk.DialogFlags.MODAL,
                            (Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
                             Gtk.STOCK_OK, Gtk.ResponseType.OK))

        # the dialog is modal and holds the grab: if building its contents or
        # reading them back raises, a dialog that is never destroyed leaves the
        # settings window unusable
        try:
            widgets, presenter = self._build_dialog_content(dialog, data)

            dialog.get_content_area().show_all()
            return self._run_dialog(dialog, widgets, presenter, original_timezone, revision, info is None)
        finally:
            dialog.destroy()
