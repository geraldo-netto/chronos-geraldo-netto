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
from typing import Any, Optional
from gi.repository import Gtk

# the shared halves: one folded-substring matcher and one process-wide
# timezone index, both also used by the world-clock and country widgets
import chronos_settings_widgets_common as common
from chronos_timezone_data import completion_key, local_city_name
from chronos_settings_i18n import _

WEATHER_LOCATION_HINT = _("City or town (e.g. Lisbon)")
MAX_WEATHER_LOCATION_LENGTH = 256


def normalize_weather_location(text) -> str:
    """Trim a location only when its untrimmed value fits the network bound."""
    source = text if isinstance(text, str) else ""
    if len(source) > MAX_WEATHER_LOCATION_LENGTH:
        return ""
    return source.strip()


# One store per distinct city list, for the life of the process. Same reasoning
# as _COMPLETION_MODELS: the list never changes while cinnamon-settings runs, and
# every settings page that asks for it asks for the same one.
_CITY_MODELS: dict[tuple, Any] = {}


def city_completion_model(cities):
    key = tuple(cities)
    cached = _CITY_MODELS.get(key)
    if cached is not None:
        return cached

    model = Gtk.ListStore(str, str)
    for city in cities:
        model.append([city, completion_key(city)])

    _CITY_MODELS[key] = model

    return model


def attach_city_completion(entry, cities):
    """Give the weather-location Gtk.Entry city-name suggestions.

    The suggestions come from the timezone database that is already loaded for
    the world clocks — nothing is fetched, so no keystroke reaches the geocoder.
    That database is not a gazetteer: it names only a few hundred cities, so a small town
    will not be suggested. The field stays free text and any name still saves;
    the completion is a shortcut, not a whitelist.
    """
    if not cities:
        return None

    model = city_completion_model(cities)

    completion = Gtk.EntryCompletion()
    completion.set_model(model)
    completion.set_text_column(0)
    completion.set_minimum_key_length(2)
    completion.set_popup_completion(True)
    # the suggestion *is* the value here, so completing inline is safe — unlike
    # the timezone field, where the suggestion is a label and only the identifier
    # behind it may be saved
    completion.set_inline_completion(True)
    completion.set_match_func(common.plain_completion_match, model)
    entry.set_completion(completion)
    return completion



_WEATHER_CITIES: Optional[list[str]] = None


def weather_cities() -> list[str]:
    """The city names offered under the weather location, built on first use."""
    global _WEATHER_CITIES
    if _WEATHER_CITIES is None:
        _WEATHER_CITIES = common.shared_timezone_resolver().city_names()

    return _WEATHER_CITIES


class WeatherLocationEntry(Entry, JSONSettingsBackend):
    """The weather location, typed with city-name suggestions.

    A plain entry against a geocoder is a guessing game: the user types a name,
    saves, and finds out from a warning marker on the panel — minutes later,
    after a network round trip — that nothing matched. Suggesting the names the
    machine already knows turns the common case into a pick.

    An empty field is filled with the city of the machine's own timezone, so the
    weather has somewhere to look before the user has typed anything. It is put
    *in the field*, not resolved behind the user's back: the timezone names its
    region's reference city, which for a user in Genoa is Rome, and a wrong
    location the user can see and correct beats a wrong one they cannot.

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
        self.prefill_from_timezone()

    def on_setting_changed(self, *args):
        # the key changed under the dialog — another instance of the applet, or
        # the applet's own timezone prefill
        text = normalize_weather_location(self.get_value())
        if self.content_widget.get_text() != text:
            self.content_widget.set_text(text)

    def connect_widget_handlers(self, *args):
        self.content_widget.connect("focus-in-event", self.ensure_completion)
        # the ways an edit ends. Not "changed", which is every keystroke.
        self.content_widget.connect("activate", self.on_commit)
        self.content_widget.connect("focus-out-event", self.on_commit)
        # closing the settings window while the cursor is still in the field
        # never fires focus-out, and the name the user typed would go with it
        self.content_widget.connect("destroy", self.on_commit)

    def ensure_completion(self, *args) -> bool:
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

    def on_commit(self, *args) -> bool:
        self.commit(self.content_widget.get_text())
        # False: an "activate" or a focus change carries on as it would have
        return False

    def commit(self, text) -> str:
        if isinstance(text, str) and len(text) > MAX_WEATHER_LOCATION_LENGTH:
            return ""

        location = normalize_weather_location(text)
        if location == (self.get_value() or ""):
            return ""

        self.set_value(location)
        return location

    def prefill_from_timezone(self) -> str:
        # only an empty field: a location the user chose is never overwritten,
        # and clearing the field on purpose refills it — which is the point,
        # since an empty location is what the panel warns about
        if self.get_value():
            return ""

        city = local_city_name()
        if not city:
            return ""

        self.set_value(city)
        self.content_widget.set_text(city)
        return city
