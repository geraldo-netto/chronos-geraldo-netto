#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

"""The weather-location settings widget and its city suggestions.

One feature per module: the holiday country combo and the world-clock stack are
siblings. chronos_settings_widgets_common owns their completion matcher and
shared timezone resolver; chronos_settings_i18n owns the translation binding.
"""

from __future__ import annotations

from JsonSettingsWidgets import JSONSettingsBackend
from xapp.SettingsWidgets import Entry
from typing import Optional

# the shared halves: one folded-substring matcher and one process-wide
# timezone index, both also used by the world-clock and country widgets
import chronos_settings_widgets_common as common
from chronos_timezone_data import completion_key, local_city_name
from chronos_settings_i18n import _

WEATHER_LOCATION_HINT = _("City or town (e.g. Lisbon)")
WEATHER_LOCATION_TOO_LONG = _("This location is too long to save")
MAX_WEATHER_LOCATION_LENGTH = 256


def refuses_weather_location(text) -> bool:
    """Over the network bound, which is the one thing this field will not save.

    Named, because the refusal and the message about it have to test the same
    thing: a whitespace-only value also normalizes to "", and calling that "too
    long" would be a lie.
    """
    return isinstance(text, str) and len(text) > MAX_WEATHER_LOCATION_LENGTH


def normalize_weather_location(text) -> str:
    """Trim a location only when its untrimmed value fits the network bound."""
    source = text if isinstance(text, str) else ""
    if refuses_weather_location(source):
        return ""
    return source.strip()


def _city_completion_columns(city):
    """the city, and the folded text the matcher searches."""
    return [city, completion_key(city)]


def city_completion_model(cities):
    return common.completion_model(cities, _city_completion_columns)


def attach_city_completion(entry, cities):
    """Give the weather-location Gtk.Entry city-name suggestions.

    The suggestions come from the timezone database that is already loaded for
    the world clocks — nothing is fetched, so no keystroke reaches the geocoder.
    That database is not a gazetteer: it names only a few hundred cities, so a small town
    will not be suggested. The field stays free text and any name still saves;
    the completion is a shortcut, not a whitelist.
    """
    # the suggestion *is* the value here, so completing inline is safe — unlike
    # the timezone field, where the suggestion is a label and only the identifier
    # behind it may be saved
    return common.attach_suggestions(
        entry, cities, _city_completion_columns, inline_completion=True)



_WEATHER_CITIES: Optional[list[str]] = None


def weather_cities() -> list[str]:
    """The city names offered under the weather location, built on first use."""
    global _WEATHER_CITIES
    if _WEATHER_CITIES is None:
        _WEATHER_CITIES = common.shared_timezone_resolver().city_names()

    return _WEATHER_CITIES


class WeatherLocationEntry(common.CommitOnEditEnd, Entry, JSONSettingsBackend):
    """The weather location, typed with city-name suggestions.

    A plain entry against a geocoder is a guessing game: the user types a name,
    saves, and finds out from a warning marker on the panel — minutes later,
    after a network round trip — that nothing matched. Suggesting the names the
    machine already knows turns the common case into a pick.

    The timezone's city is a placeholder in an empty field. It stays unsaved:
    the timezone may name Rome while the user lives in Genoa. The user chooses
    the actual location by typing a city or selecting a completion.

    The field saves when the edit is *finished* — a suggestion picked, Enter
    pressed, focus left — and not on every keystroke, which is what Cinnamon's
    bound entry does. Every write of this key reaches the applet and, 750ms
    later, geocodes whatever the key now holds. Typing "Genoa" with a pause in
    it therefore used to geocode "Gen": a fragment that matches nothing at
    Open-Meteo, so the resolver fell through to Nominatim — whose usage policy is
    one request a second — and cached the failure. Nothing half-typed is a place,
    and no fragment is worth a round trip.
    """

    bind_prop = "text"
    # None: this widget writes the key itself. With a direction, xapp binds the
    # entry's "text" property to the key and every keystroke is a write.
    bind_dir = None

    def __init__(self, info, key, settings):
        common.report_startup_diagnostics()
        self.backend = "json"
        self.key = key
        self.settings = settings

        Entry.__init__(self, label=info.get("description", ""),
                       expand_width=True, tooltip=info.get("tooltip", ""))
        self.bind_object = self.content_widget

        if hasattr(self.content_widget, "set_placeholder_text"):
            self.content_widget.set_placeholder_text(WEATHER_LOCATION_HINT)
        if hasattr(self.content_widget, "set_max_length"):
            self.content_widget.set_max_length(MAX_WEATHER_LOCATION_LENGTH)

        self.completion = None
        self._completion_loaded = False

        self.attach()
        self.suggest_from_timezone()

    def mark_refused(self, refused):
        """Mark the field, and say why, when a location will not be saved.

        The entry caps typing at MAX_WEATHER_LOCATION_LENGTH, so the usual way
        in is not the keyboard: it is a key holding a longer value — written by
        another settings instance, or by hand — which normalizes to "" and blanks
        the field on load. Silently showing an empty box for a key that is not
        empty is the failure this reports.
        """
        common.set_invalid(self, refused,
                           WEATHER_LOCATION_TOO_LONG if refused else "")

    def on_setting_changed(self, *args):
        # The key changed under the dialog, for example in another settings window.
        stored = self.get_value()
        text = normalize_weather_location(stored)
        if self.content_widget.get_text() != text:
            self.content_widget.set_text(text)
        # Gtk.Entry.set_text() emits "changed". Mark the rejected stored value
        # after that signal so the empty normalization above cannot clear the
        # reason the key itself was refused.
        self.mark_refused(refuses_weather_location(stored))

    def on_entry_edited(self, *args):
        # This changes only the field state. Saving still belongs to commit(), so
        # typing a replacement neither writes the key nor starts geocoding it.
        self.mark_refused(
            refuses_weather_location(self.content_widget.get_text()))

    def connect_widget_handlers(self, *args):
        self.content_widget.connect("focus-in-event", self.ensure_completion)
        # 'changed', 'activate', 'focus-out-event' and 'destroy': the shared
        # edit-end lifecycle, which the holiday country field answers too
        self.connect_edit_end_handlers(self.content_widget)

    def ensure_completion(self, *args) -> bool:  # NOSONAR [S3516] -- False propagates the GTK focus event
        if self._completion_loaded:
            return False

        self._completion_loaded = True
        self.completion = attach_city_completion(self.content_widget, weather_cities())
        if self.completion is not None:
            self.completion.connect("match-selected", self.on_suggestion_picked)
        return False

    def on_suggestion_picked(self, completion, model, tree_iter) -> bool:
        # a picked suggestion is a finished edit: save it without waiting for the
        # user to leave the field
        city = model[tree_iter][0]
        self.content_widget.set_text(city)
        self.content_widget.set_position(-1)
        self.commit(city)
        return True

    def commit_edit(self):
        self.commit(self.content_widget.get_text())

    def commit(self, text) -> str:
        if refuses_weather_location(text):
            self.mark_refused(True)
            return ""

        location = normalize_weather_location(text)
        # The blank field is a *projection* of a stored value too long to save,
        # not an edit of it — on_setting_changed puts it there and marks it
        # refused. Every way an edit can end reaches here, including the
        # `destroy` that fires when the settings window closes, so committing
        # that blank meant opening the page and closing it again wrote "" over
        # the key the widget had just finished explaining it could not show.
        # Clearing the field on purpose still works once there is a savable
        # value in it; the sibling CountryComboBox restores rather than writes
        # for the same case.
        if not location and refuses_weather_location(self.get_value()):
            self.mark_refused(True)
            return ""

        self.mark_refused(False)
        if self.content_widget.get_text() != location:
            self.content_widget.set_text(location)
            self.content_widget.set_position(-1)
        if location == (self.get_value() or ""):
            return ""

        self.set_value(location)
        return location

    def suggest_from_timezone(self) -> str:
        if self.get_value():
            return ""

        city = local_city_name()
        if not city:
            return ""

        self.content_widget.set_placeholder_text(city)
        return city
