#!/usr/bin/python3

from __future__ import annotations

from JsonSettingsWidgets import JSONSettingsBackend, JSONSettingsList
from xapp.SettingsWidgets import ComboBox, Entry, SettingsLabel, SettingsWidget
import logging
from typing import Any, Callable, Iterable, Optional
try:
    import pytz
except ImportError:
    pytz = None
try:
    from zoneinfo import available_timezones
except ImportError:
    available_timezones = None
from gi.repository import Atk, GLib, Gtk
import gettext
from pathlib import Path

# i18n: bind the domain to a module-level name. Installing the translator
# globally would inject _ into builtins for the whole cinnamon-settings
# process and could shadow another xlet's translator.
#
# The applet can be installed per-user or system-wide, and the catalogs follow
# it. Binding only to $HOME meant a system-wide install silently fell back to
# NullTranslations - fallback=True - and the whole dialog reverted to English
# with nothing said. Try the user's catalog first, then the system's.
def _load_translation():
    domain = "chronos@geraldo-netto"
    for locale_dir in (str(Path.home() / ".local/share/locale"), "/usr/share/locale"):
        translation = gettext.translation(domain, locale_dir, fallback=True)
        if isinstance(translation, gettext.GNUTranslations):
            return translation.gettext

    return gettext.translation(domain, fallback=True).gettext


_ = _load_translation()

LOGGER = logging.getLogger("chronos@geraldo-netto.settings")

MISSING_PYTZ_WARNING = (
    "python3-pytz is not installed; world-clock timezone validation and "
    "city suggestions are limited. Install it with "
    "'sudo apt install python3-pytz' on Linux Mint/Debian/Ubuntu, or "
    "'python3 -m pip install pytz'."
)

TZ_NO_REGION = 'Etc'
RESERVED_TIMEZONES = {"utc", "etc/utc", "local"}
# user-configurable clocks; the applet always shows built-in UTC and local rows
MAX_CLOCKS = 8
# idles spent waiting for the settings window to be parented before giving up on
# centering it; without a bound this is a busy loop that never ends
MAX_CENTER_ATTEMPTS = 100
TIMEZONE_TEXT_HINT = _("City or timezone (e.g. Buenos Aires)")
TIMEZONE_PREVIEW_TEMPLATE = _("Timezone to save: %s")
TIMEZONE_INVALID_PREVIEW = _("Invalid timezone")
TIMEZONE_EMPTY_PREVIEW = _("No timezone selected")
TIMEZONE_RESERVED_PREVIEW = _("UTC and local time are already shown as built-in clocks")
LABEL_MISSING_PREVIEW = _("Enter a display name for this clock")
# Why the Add button is dead at the cap. It is the button's tooltip and the text
# of the dialog that open_add_edit_dialog still raises — the same sentence, so a
# user who reaches it by either route reads the same thing.
CLOCK_LIMIT_MESSAGE = _("No more than %d clocks can be added.") % MAX_CLOCKS

NO_TIMEZONE_DATA_HINT = _(
    "No timezone database found. Install python3-pytz to type a city name; "
    "without it, only a full identifier such as America/Sao_Paulo is accepted."
)

WEATHER_LOCATION_HINT = _("City or town (e.g. Lisbon)")
COUNTRY_HINT = _("Type a country name")

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


def local_timezone_name() -> Optional[str]:
    """The system's own IANA zone, as /etc/localtime names it.

    The applet always shows a local-time row, and it drops any configured clock
    whose zone resolves to the same one. The dialog therefore has to know what
    the local zone *is*, not just that the user typed the word "local".
    """
    try:
        target = Path("/etc/localtime").resolve()
        parts = target.parts
        index = len(parts) - 1 - parts[::-1].index("zoneinfo")
    # not a zoneinfo symlink (a copied file, a container, a stub /etc): there is
    # no name to compare against, and a missing name only costs the extra check
    except (OSError, ValueError):
        return None

    name = "/".join(parts[index + 1:])
    return name or None


def looks_like_iana(value: Any) -> bool:
    """Area/City, the shape of an IANA identifier.

    All the check there is when no timezone database is installed: it does not
    say the zone exists, only that it is not a word someone typed by accident.
    """
    if not isinstance(value, str):
        return False

    parts = value.strip().split("/")
    if len(parts) < 2 or len(parts) > 3:
        return False

    return all(part and all(ch.isalnum() or ch in "_+-" for ch in part) for part in parts)


def completion_key(text: Any) -> str:
    """Fold a typed word and a suggestion onto the same shape.

    "buenos aires", "Buenos_Aires" and "BUENOS AIRES" all have to hit the same
    suggestion, so underscores and case never decide a match.
    """
    if not isinstance(text, str):
        return ""
    return text.strip().lower().replace('_', ' ')


def timezone_completion_match(completion, key, tree_iter, model) -> bool:
    """Does this suggestion contain what the user has typed?

    GTK calls this for every one of the ~600 rows on every keystroke, so what it
    does per row is what decides whether typing feels instant. It used to build
    "%s %s" % (label, timezone) and fold it — lowercasing and replacing
    underscores — for each row, every time, which meant re-folding all 600
    suggestions on every character. Measured here with 599 zones: 2.76 ms per
    keystroke, against 1.13 ms once the folded text is precomputed into a third
    column of the model and the needle is folded once by the caller.

    Substring, not prefix: people type the city, and the city sits at the end of
    the identifier (America/Argentina/Buenos_Aires).
    """
    needle = completion_key(key)
    if not needle:
        return False

    return needle in model[tree_iter][2]


def timezone_completion_selected(completion, model, tree_iter) -> bool:
    # put the identifier in the entry, not the pretty label, so the value the
    # dialog saves is the value the applet reads back.
    entry = completion.get_entry()
    entry.set_text(model[tree_iter][1])
    entry.set_position(-1)
    return True


# Keyed by what the completions *are*, not by which list object they arrived in.
#
# This was keyed by id(completions), holding a strong reference to both the list
# and its Gtk.ListStore so the id could not be reused — with no eviction path at
# all. Every ClocksList builds its own TimezoneResolver and therefore its own
# completions list, so the memo never hit across instances: it simply accumulated
# one 439-row × 3-column ListStore, and ~1300 retained strings, per settings page
# ever constructed, for the life of the cinnamon-settings process. A cache that
# cannot hit is a leak wearing a cache's clothes.
#
# The content is a tuple of (display, timezone) pairs and is the same for every
# instance, so keying on it gives one entry for the whole process — which is what
# the memo was for.
_COMPLETION_MODELS: dict[tuple, Any] = {}


def timezone_completion_model(completions):
    """The suggestions as a Gtk.ListStore, built once per completion list.

    There are some 600 of them with pytz, and the whole store was rebuilt on the
    GTK main thread every time the add/edit dialog opened. The list never
    changes while the process runs.

    The third column is the folded text the match function searches. Folding it
    here — once per zone, at build time — is what keeps that function's per-row
    work down to a substring test.
    """
    key = tuple(completions)
    cached = _COMPLETION_MODELS.get(key)
    if cached is not None:
        return cached

    model = Gtk.ListStore(str, str, str)
    for display, timezone in completions:
        model.append([display, timezone, completion_key("%s %s" % (display, timezone))])

    _COMPLETION_MODELS[key] = model

    return model


def attach_timezone_completion(entry, completions):
    """Give a timezone Gtk.Entry a city-name autocompletion."""
    if not completions:
        return None

    model = timezone_completion_model(completions)

    completion = Gtk.EntryCompletion()
    completion.set_model(model)
    completion.set_text_column(0)
    completion.set_minimum_key_length(2)
    completion.set_popup_completion(True)
    # inline completion would type the label into the entry; the label is not a
    # timezone, so only an explicit pick fills the field
    completion.set_inline_completion(False)
    completion.set_match_func(timezone_completion_match, model)
    completion.connect('match-selected', timezone_completion_selected)
    entry.set_completion(completion)
    return completion


def plain_completion_match(completion, key, tree_iter, model) -> bool:
    """Substring match against the folded text in the model's last column.

    Same contract as timezone_completion_match — the folding is precomputed at
    build time, so a keystroke costs one substring test per row — but for models
    whose suggestion is the value: a city name, a country name.
    """
    needle = completion_key(key)
    if not needle:
        return False

    return needle in model[tree_iter][-1]


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
    That database is not a gazetteer: it names about 440 cities, so a small town
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
    completion.set_match_func(plain_completion_match, model)
    entry.set_completion(completion)
    return completion


_WEATHER_CITIES: Optional[list[str]] = None


def weather_cities() -> list[str]:
    """The city names offered under the weather location, built on first use."""
    global _WEATHER_CITIES
    if _WEATHER_CITIES is None:
        _WEATHER_CITIES = TimezoneResolver(pytz, available_timezones).city_names()

    return _WEATHER_CITIES


def local_city_name(timezone: Optional[str] = None) -> str:
    """The city the machine's own timezone names, as a place a geocoder knows.

    Europe/Rome is "Rome", America/Argentina/Buenos_Aires is "Buenos Aires". A
    zone with no city in it — UTC, the Etc/ block, a /etc/localtime that is not a
    zoneinfo symlink — names no place, and answers "".
    """
    name = local_timezone_name() if timezone is None else timezone
    if not name or '/' not in name or name.startswith(TZ_NO_REGION + '/'):
        return ""

    return name.rsplit('/', maxsplit=1)[-1].replace('_', ' ')


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

        self.completion = attach_city_completion(self.content_widget, weather_cities())

        self.attach()
        self.prefill_from_timezone()

    def on_setting_changed(self, *args):
        # the key changed under the dialog — another instance of the applet, or
        # the applet's own timezone prefill
        text = self.get_value() or ""
        if self.content_widget.get_text() != text:
            self.content_widget.set_text(text)

    def connect_widget_handlers(self, *args):
        # the ways an edit ends. Not "changed", which is every keystroke.
        self.content_widget.connect("activate", self.on_commit)
        self.content_widget.connect("focus-out-event", self.on_commit)
        # closing the settings window while the cursor is still in the field
        # never fires focus-out, and the name the user typed would go with it
        self.content_widget.connect("destroy", self.on_commit)
        if self.completion is not None:
            self.completion.connect("match-selected", self.on_suggestion_picked)

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
        location = (text or "").strip()
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
        completion.set_match_func(plain_completion_match, self.model)
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


class ListEditComboBox(ComboBox):
    """A combo column of the add/edit dialog."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.bind_object = self.content_widget
        self.connect_widget_handlers()

    def get_value(self):
        return getattr(self, "widget_value", None)

    def set_value(self, value):
        self.widget_value = value

    def set_widget_value(self, value):
        self.widget_value = value
        self.on_setting_changed()

    def get_widget_value(self):
        return self.get_value()


class ListEditEntry(Entry):
    """A text column of the add/edit dialog, optionally autocompleting."""

    def __init__(self, completions=None, placeholder=None, **kwargs):
        super().__init__(**kwargs)
        self.bind_object = self.content_widget
        # A hint about what to type belongs *in* the empty field, not in the
        # label beside it: using it as the label left the dialog naming the
        # field with a sentence while the column heading above it said
        # "Timezone" - two names for one thing.
        if placeholder and hasattr(self.bind_object, "set_placeholder_text"):
            self.bind_object.set_placeholder_text(placeholder)
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

    The two classes above used to be declared inside this function, so every
    call defined a new PyGObject subclass - and PyGObject registers a GType per
    subclass, which is never unregistered. That leaked two GTypes, with their
    class structures and closures, on every Add or Edit click, for the life of
    the settings process.
    """
    # the title is a schema string, which is an English msgid: translate it once,
    # here. It used to be handed a string that had *already* been translated
    # (TIMEZONE_TEXT_HINT), so the second lookup missed and returned it unchanged
    # - working by accident, and only until a translated string collided with
    # another msgid.
    kwargs = {'label': _(params['title'])}

    if 'options' in params:
        kwargs['valtype'] = str
        kwargs['options'] = params['options']
        return ListEditComboBox(**kwargs)

    return ListEditEntry(completions=params.get('completions'),
                         placeholder=params.get('placeholder'), **kwargs)

class ClockEntrySerializer:
    def initial_dialog_data(
        self,
        info: Optional[list[str]],
    ) -> tuple[dict[str, Optional[str]], str]:
        if info is None:
            return { "label": None, "timezone": None }, _("Add new entry")

        return { "label": info[0], "timezone": info[1] }, _("Edit entry")

    def serialize(self, label: str, timezone: str) -> list[str]:
        return [label, timezone]

class TimezoneResolver:
    def __init__(
        self,
        pytz_module: Any,
        available_timezones_func: Optional[Callable[[], Iterable[str]]],
        local_timezone: Optional[str] = None,
    ) -> None:
        self.has_timezone_data = pytz_module is not None
        self.timezone_map = {}
        self.city_map = {}
        self.fallback_timezone_map = {}
        self.completions = []

        # the zones the applet already draws a row for: a clock on any of these
        # is a clock the popup will never show
        local = local_timezone if local_timezone is not None else local_timezone_name()
        self.builtin_timezones = {"UTC", "Etc/UTC"}
        if local:
            self.builtin_timezones.add(local)

        # Warned here rather than at import: importing a module should define
        # things, not emit them. At import time cinnamon-settings has not
        # configured logging yet, so the warning landed on the whole process's
        # stderr or was dropped entirely, depending on import order.
        if pytz_module is None:
            LOGGER.warning(MISSING_PYTZ_WARNING)

        if self.has_timezone_data:
            self.timezone_map = {tz.lower(): tz for tz in pytz_module.all_timezones}
            self.build_completions(pytz_module.common_timezones)
        elif available_timezones_func is not None:
            self.fallback_timezone_map = {
                tz.lower(): tz for tz in available_timezones_func()
            }
            self.build_completions(self.fallback_timezone_map.values())

    def build_completions(self, timezones: Iterable[str]) -> None:
        for tz in timezones:
            self.index_city(self.split(tz)[1], tz)
            self.completions.append((self.suggestion_label(tz), tz))
        self.completions.sort(key=lambda row: row[0].casefold())

    def index_city(self, city: str, tz: str) -> None:
        # A zone such as America/Argentina/Buenos_Aires keeps two path segments
        # below its region. Index the whole tail and the bare city name, so
        # typing "Buenos Aires" resolves. First zone wins, so a name shared by
        # two regions (Nicosia) keeps the one listed first.
        for key in {city.lower(), city.rsplit('/', maxsplit=1)[-1].lower()}:
            self.city_map.setdefault(key, tz)

    def suggestion_label(self, tz: str) -> str:
        """Name the city first: 'Buenos Aires (America/Argentina)'.

        People type the city, so the city is what the suggestion list has to
        sort and read by; the region only disambiguates.
        """
        # No _() here: these are IANA path segments split at runtime, so
        # xgettext never sees them and none of them are msgids. The calls
        # looked like translation and did nothing but return their argument.
        parts = [part.replace('_', ' ') for part in tz.split('/')]
        if len(parts) == 1:
            return parts[0]
        return "%s (%s)" % (parts[-1], " / ".join(parts[:-1]))

    def split(self, tz: Any) -> tuple[str, str]:
        if not isinstance(tz, str):
            return TZ_NO_REGION, ""
        try:
            region, city = tz.split('/', maxsplit=1)
        except ValueError:
            region = TZ_NO_REGION
            city = tz
        return region, city

    def city_names(self) -> list[str]:
        """Just the cities, for a field that wants a place and not a zone.

        The weather location is a place name sent to a geocoder, so the region
        half of the suggestion label ("(America / Argentina)") is noise there.
        Zones with no region at all — UTC, GMT, the Etc/ block — name no city and
        are dropped: a geocoder has nothing to do with them.
        """
        names = {
            label.split(' (')[0]
            for label, timezone in self.completions
            if '/' in timezone and not timezone.startswith(TZ_NO_REGION + '/')
        }
        return sorted(names, key=str.casefold)

    def any_timezone_data(self) -> bool:
        """pytz, or zoneinfo, or nothing at all."""
        return self.has_timezone_data or bool(self.fallback_timezone_map)

    def is_reserved(self, value: Any) -> bool:
        """Would this clock be dropped for colliding with a built-in row?

        The literal words are only half of it. The applet shows UTC and local
        time itself and silently drops any configured clock whose zone resolves
        to one of those, so for a user in São Paulo the string
        "America/Sao_Paulo" is every bit as reserved as "local" — and the dialog
        used to validate it, preview it, save it, and let it disappear with
        nothing said.
        """
        if not isinstance(value, str):
            return False

        text = value.strip()
        if not text:
            return False
        if text.lower() in RESERVED_TIMEZONES:
            return True

        resolved = self._resolve(text)
        return bool(resolved) and resolved in self.builtin_timezones

    def normalize(self, value: Any) -> Optional[str]:
        # accept a full IANA identifier or a plain city name, case-insensitively
        if not value:
            return None

        value = value.strip()
        if not value:
            return None
        if self.is_reserved(value):
            return None

        return self._resolve(value)

    def _resolve(self, value: str) -> Optional[str]:
        """Text to IANA identifier. No built-in check: is_reserved needs this."""
        lower = value.lower()
        city_token = lower.replace(' ', '_')

        if not self.has_timezone_data:
            # No timezone database at all - neither pytz nor zoneinfo. Anything
            # typed used to be handed straight back and saved, so the dialog
            # accepted gibberish and the applet showed an italic "Invalid
            # timezone" row later, with nothing connecting the two. An IANA
            # identifier is the one shape that can still be checked without a
            # database: Area/City.
            if not self.fallback_timezone_map:
                return value if looks_like_iana(value) else None
            return (self.fallback_timezone_map.get(lower)
                    or self.city_map.get(city_token))

        timezone = self.timezone_map.get(lower)
        if timezone:
            return timezone

        timezone = self.city_map.get(city_token)
        if timezone:
            return timezone

        return None

# The dialog is modal and sized to its content, so a label that will not wrap is
# a label that decides how wide the window is.
DIALOG_LABEL_WIDTH_CHARS = 52


def wrap_label(label):
    label.set_line_wrap(True)
    label.set_max_width_chars(DIALOG_LABEL_WIDTH_CHARS)


# GTK's own name for "this widget is holding something wrong". Themes draw it;
# assistive technologies report it.
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


def set_invalid(widget, is_invalid):
    """Mark the entry itself, which is what an assistive technology asks about."""
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
            atk.set_description(TIMEZONE_INVALID_PREVIEW if is_invalid else "")


def describe_widget(widget, label, text):
    """Tie the message to the field it is about, for a screen reader."""
    if widget is None:
        return

    entry = getattr(widget, "bind_object", widget)
    accessible = getattr(entry, "get_accessible", None)
    if not accessible:
        return

    atk = accessible()
    if hasattr(atk, "set_description"):
        atk.set_description(text)
    if hasattr(label, "get_accessible") and hasattr(atk, "add_relationship"):
        # ATK_RELATION_DESCRIBED_BY: "the thing that explains me is that label"
        atk.add_relationship(Atk.RelationType.DESCRIBED_BY, label.get_accessible())


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

    def __init__(self, clocks_list, dialog, preview_label):
        self.clocks_list = clocks_list
        self.dialog = dialog
        self.preview_label = preview_label

    def values_from_widgets(self, widgets):
        return {key: widget.get_widget_value() for key, widget in widgets.items()}

    def update(self, widgets):
        values = self.values_from_widgets(widgets)
        has_label = bool(values.get('label'))
        choice = self.clocks_list.resolve_timezone_choice(values)

        # OK stays insensitive until both fields are right, and the preview only
        # ever spoke about the timezone: someone with a valid timezone and an
        # empty display name saw a perfectly happy preview and a dead OK button,
        # with nothing saying which field was the problem.
        if choice["timezone"] and not has_label:
            self._report(widgets, LABEL_MISSING_PREVIEW, invalid="label")
        elif choice["timezone"]:
            self._report(widgets, self.clocks_list.format_timezone_preview(values))
        else:
            self._report(widgets, self.clocks_list.format_timezone_preview(values),
                         invalid="timezone")

        self.dialog.set_response_sensitive(
            Gtk.ResponseType.OK,
            has_label and bool(choice["timezone"]))

    def _report(self, widgets, text, invalid=None):
        self.preview_label.set_text(text)

        # the message is about a field, so a screen reader has to read it *with*
        # that field rather than as a stray line of text somewhere in the dialog
        described = widgets.get(invalid) if invalid else None
        describe_widget(described, self.preview_label, text)

        # ...and it has to be visible as well as sayable: an error style on the
        # label, and the entry marked as holding something invalid
        set_error_state(self.preview_label, bool(invalid))
        for field, widget in widgets.items():
            set_invalid(widget, field == invalid)

class ClockDialogBuilder:
    def __init__(self, clocks_list):
        self.clocks_list = clocks_list

    def initial_data(self, info):
        return self.clocks_list.entry_serializer.initial_dialog_data(info)

    def build_content(self, dialog, data):
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

        # both columns come from the schema, which is where the list's column
        # headings already live; the dialog adds what only it needs
        schema_columns = self.clocks_list.settings.get_property(
            self.clocks_list.key, 'columns')
        timezone_column = dict(schema_columns[1])
        timezone_column["completions"] = self.clocks_list.completions
        timezone_column["placeholder"] = TIMEZONE_TEXT_HINT

        columns = [schema_columns[0], timezone_column]

        widgets = {}
        preview_label = Gtk.Label()
        preview_label.set_xalign(0)
        # A Gtk.Label does not wrap unless it is told to, and these two carry
        # sentences: the invalid-timezone preview, and the 140-character hint
        # below. Without a wrap the modal stretched to fit one very wide line —
        # on a 1366 px screen, or in any language whose translation runs longer,
        # the dialog ran off the monitor.
        wrap_label(preview_label)
        presenter = ClockDialogStatePresenter(self.clocks_list, dialog, preview_label)

        def on_widget_changed(bind_object):
            presenter.update(widgets)

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

        if len(widgets) != 0:
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

        on_widget_changed(None)

        return widgets

    def collect_values(self, widgets):
        label = widgets['label'].get_widget_value()
        values = {key: widget.get_widget_value() for key, widget in widgets.items()}
        timezone = self.clocks_list.resolve_timezone_choice(values)["timezone"]

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

    def start(self) -> None:
        GLib.idle_add(self.center)

    def center(self, *args) -> bool:
        if self.centered:
            return False

        # An idle that keeps asking to be run again is a busy loop: it pins a
        # core for the life of the settings process, silently. Centering is a
        # nicety - if the window never gets parented, or the display will not
        # answer, give up and let the window manager place it.
        self.attempts += 1
        if self.attempts > MAX_CENTER_ATTEMPTS:
            LOGGER.debug("gave up centering the settings window")
            return False

        widget = self.widget
        window = widget.get_toplevel() if hasattr(widget, "get_toplevel") else None
        if window is None or not getattr(window, "is_toplevel", lambda: False)():
            # not parented yet: come back on the next idle
            return True

        # a failure here is terminal, not something to retry: center_window()
        # only returns False when the display itself would not answer
        self.centered = True
        center_window(window)
        return False


class ClocksList(JSONSettingsList):
    def __init__(self, info, key, settings):
        # Built on first use, not at page construction.
        #
        # Opening the applet's settings — any page of them — used to build a
        # 594-entry timezone map, a city map and a 439-entry completions list,
        # and casefold-sort the last of them, on the GTK main thread, for a user
        # who may never open the World Clocks page at all.
        self._timezone_resolver = None

        JSONSettingsList.__init__(self, key, settings, info)

        self.entry_serializer = ClockEntrySerializer()
        self.dialog_builder = ClockDialogBuilder(self)

        self.update_button_sensitivity()

        # hosted, not owned: see SettingsWindowCenterer
        self.window_centerer = SettingsWindowCenterer(self)
        self.window_centerer.start()

    @property
    def timezone_resolver(self):
        if self._timezone_resolver is None:
            self._timezone_resolver = TimezoneResolver(pytz, available_timezones)

        return self._timezone_resolver

    @timezone_resolver.setter
    def timezone_resolver(self, resolver):
        self._timezone_resolver = resolver

    @property
    def completions(self):
        return self.timezone_resolver.completions

    def update_button_sensitivity(self, *args):
        super().update_button_sensitivity(*args)
        if not self.show_buttons:
            return

        # At the cap the Add button goes insensitive — and it had no tooltip, so
        # the sentence that explains why ("No more than 8 clocks can be added.")
        # was unreachable: it fires from open_add_edit_dialog(), which is reached
        # by a click the button can no longer receive. The user got a dead button
        # and no explanation anywhere.
        full = self.model.iter_n_children(None) >= MAX_CLOCKS
        self.add_button.set_sensitive(not full)
        if not hasattr(self.add_button, "set_tooltip_text"):
            return

        # Gtk.Widget.set_tooltip_text is annotated non-nullable here, so clearing
        # the tooltip with None raises TypeError and takes the whole settings
        # window down with it. Clear it with "" and drop has-tooltip, which is
        # what None would have done: "" on its own leaves has-tooltip set and
        # pops an empty box on hover.
        if full:
            self.add_button.set_tooltip_text(CLOCK_LIMIT_MESSAGE)
        else:
            self.add_button.set_tooltip_text("")
            if hasattr(self.add_button, "set_has_tooltip"):
                self.add_button.set_has_tooltip(False)

    def normalize_timezone(self, value):
        return self.timezone_resolver.normalize(value)

    def resolve_timezone_choice(self, values):
        timezone_text = values.get('timezone')
        has_timezone_text = bool(timezone_text and timezone_text.strip())
        if self.timezone_resolver.is_reserved(timezone_text):
            return {
                "timezone": None,
                "typed_invalid": True,
                "reserved": True
            }

        timezone = self.normalize_timezone(timezone_text)

        if timezone is not None:
            return {
                "timezone": timezone,
                "typed_invalid": False,
                "reserved": False
            }

        return {
            "timezone": None,
            "typed_invalid": has_timezone_text,
            "reserved": False
        }

    def format_timezone_preview(self, values):
        choice = self.resolve_timezone_choice(values)

        if choice["reserved"]:
            return TIMEZONE_RESERVED_PREVIEW

        if choice["timezone"] is None:
            if choice["typed_invalid"]:
                return TIMEZONE_INVALID_PREVIEW
            return TIMEZONE_EMPTY_PREVIEW

        return TIMEZONE_PREVIEW_TEMPLATE % choice["timezone"]

    def _build_dialog_content(self, dialog, data):
        return self.dialog_builder.build_content(dialog, data)

    def _collect_dialog_values(self, widgets):
        return self.dialog_builder.collect_values(widgets)

    def _initial_dialog_data(self, info):
        return self.dialog_builder.initial_data(info)

    def open_add_edit_dialog(self, info=None):
        if info is None and self.model.iter_n_children(None) >= MAX_CLOCKS:
            message = Gtk.MessageDialog(self.get_toplevel(), Gtk.DialogFlags.MODAL,
                                        Gtk.MessageType.INFO, Gtk.ButtonsType.OK,
                                        CLOCK_LIMIT_MESSAGE)
            message.run()
            message.destroy()
            return None

        data, title = self._initial_dialog_data(info)

        dialog = Gtk.Dialog(title, self.get_toplevel(), Gtk.DialogFlags.MODAL,
                            (Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
                             Gtk.STOCK_OK, Gtk.ResponseType.OK))

        # the dialog is modal and holds the grab: if building its contents or
        # reading them back raises, a dialog that is never destroyed leaves the
        # settings window unusable
        try:
            widgets = self._build_dialog_content(dialog, data)

            dialog.get_content_area().show_all()
            response = dialog.run()

            result = None
            if response == Gtk.ResponseType.OK:
                result = self._collect_dialog_values(widgets)
        finally:
            dialog.destroy()

        return result
