import builtins
import importlib.util
import json
import os
import random
import re

# seeded so fuzz failures reproduce; hypothesis is unavailable on this rig
FUZZ_SEED = 20260709
import sys
import types
import unittest
from pathlib import Path

# the suite imports the widget module straight out of the applet tree. Letting
# python drop .pyc files in there leaves bytecode behind that a later run can
# import instead of the edited source, and the shipped applet grows a
# __pycache__ nobody asked for.
sys.dont_write_bytecode = True


APPLET_DIR = Path(__file__).resolve().parent.parent.parent / "files" / "chronos@geraldo-netto"
COMMON_PATH = APPLET_DIR / "chronos_settings_widgets_common.py"
WEATHER_PATH = APPLET_DIR / "chronos_settings_widgets_weather.py"
HOLIDAYS_PATH = APPLET_DIR / "chronos_settings_widgets_holidays.py"
WORLDCLOCKS_PATH = APPLET_DIR / "chronos_settings_widgets_worldclocks.py"

# The reserved built-ins live in the gi-free sibling, and the widget module no
# longer re-exports them: it never read them, and naming them there existed only
# so the tests could reach them through it.
_tzdata_spec = importlib.util.spec_from_file_location(
    "chronos_timezone_data_for_tests", APPLET_DIR / "chronos_timezone_data.py")
_tzdata = importlib.util.module_from_spec(_tzdata_spec)
_tzdata_spec.loader.exec_module(_tzdata)
RESERVED_TIMEZONES = _tzdata.RESERVED_TIMEZONES

try:
    import pytz as _pytz
    HAS_PYTZ = _pytz is not None
except ImportError:
    _pytz = None
    HAS_PYTZ = False

# The skip is for a contributor who has not installed pytz; it was also what CI
# did, on every push, and neither suite count nor coverage number moved when
# sixteen tests took themselves out of the run. CI sets this, so there the
# missing dependency is a build failure rather than a quiet skip.
if os.environ.get("CHRONOS_REQUIRE_PYTZ") == "1" and not HAS_PYTZ:
    raise RuntimeError(
        "CHRONOS_REQUIRE_PYTZ=1 but pytz is not importable: the timezone tests "
        "would skip themselves and the gates would still report green. "
        "pip install pytz")

requires_pytz = unittest.skipUnless(HAS_PYTZ, "pytz is not installed")


class BindObject:
    """Stands in for the Gtk.Entry behind a settings widget."""

    def __init__(self):
        self.props = {}
        self.handlers = []
        self._style_context = StyleContext()
        self._accessible = AtkObject()

    def get_style_context(self):
        return self._style_context

    def get_accessible(self):
        return self._accessible

    def set_property(self, prop, value):
        self.props[prop] = value

    def get_property(self, prop):
        return self.props.get(prop)

    def get_active_id(self):
        return self.props.get("active-id")

    def set_completion(self, completion):
        self.completion = completion
        completion.entry = self

    def set_text(self, text):
        self.props["text"] = text

    def get_text(self):
        return self.props.get("text", "")

    def set_placeholder_text(self, text):
        self.placeholder = text

    def set_max_length(self, max_length):
        self.max_length = max_length

    def set_position(self, position):
        self.position = position

    def connect(self, signal, callback):
        self.handlers.append((signal, callback))

    def emit_changed(self):
        for signal, callback in self.handlers:
            if signal == "changed":
                callback(self)


class BaseWidget:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.content_widget = BindObject()
        self.bind_prop = "text"
        self.handlers_connected = False
        self.changed = False
        BaseWidget.instances.append(self)

    def connect_widget_handlers(self):
        self.handlers_connected = True

    def on_setting_changed(self):
        self.changed = True


class ComboBox(BaseWidget):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.options = kwargs.get("options")

    def set_options(self, options):
        self.options = options


class Entry(BaseWidget):
    pass


class GtkListStore:
    def __init__(self, *column_types):
        self.column_types = column_types
        self.rows = []

    def append(self, row):
        self.rows.append(row)
        # the real Gtk.ListStore hands back the row's iter, which the country
        # widget keeps so it can set that row active later
        return len(self.rows) - 1

    def __getitem__(self, index):
        return self.rows[index]


class GtkEntryCompletion:
    def __init__(self):
        self.model = None
        self.text_column = None
        self.minimum_key_length = None
        self.popup_completion = None
        self.inline_completion = None
        self.match_func = None
        self.handlers = []
        self.entry = None

    def set_model(self, model):
        self.model = model

    def set_text_column(self, column):
        self.text_column = column

    def set_minimum_key_length(self, length):
        self.minimum_key_length = length

    def set_popup_completion(self, value):
        self.popup_completion = value

    def set_inline_completion(self, value):
        self.inline_completion = value

    def set_match_func(self, func, data):
        self.match_func = (func, data)

    def connect(self, signal, callback):
        self.handlers.append((signal, callback))

    def get_entry(self):
        return self.entry

    def matches(self, key):
        func, model = self.match_func
        return [
            model[index][1]
            for index in range(len(model.rows))
            if func(self, key, index, model)
        ]

    def matches_index(self, timezone):
        for index, row in enumerate(self.model.rows):
            if row[1] == timezone:
                return index
        raise AssertionError("%s is not in the suggestions" % timezone)

    def matches_index_for(self, city):
        # the city model's suggestion *is* its value, so it is the first column
        for index, row in enumerate(self.model.rows):
            if row[0] == city:
                return index
        raise AssertionError("%s is not in the suggestions" % city)

    def select(self, index):
        for signal, callback in self.handlers:
            if signal == "match-selected":
                callback(self, self.model, index)


class GLibError(Exception):
    """stands in for GLib.Error, which pygobject raises out of Gtk calls"""


class GLibStub:
    idles = []


class AtkObject:
    def __init__(self):
        self.description = None
        self.relationships = []

    def set_description(self, text):
        self.description = text

    def add_relationship(self, relation, target):
        # atk_object_add_relationship appends to the existing relation's target
        # list; it does not replace or de-duplicate. Modelled, because that
        # append is what a per-keystroke caller turns into a growing list.
        self.relationships.append((relation, target))

    def remove_relationship(self, relation, target):
        before = len(self.relationships)
        self.relationships = [
            pair for pair in self.relationships if pair != (relation, target)]
        return len(self.relationships) != before


class StyleContext:
    def __init__(self):
        self.classes = set()

    def add_class(self, name):
        self.classes.add(name)

    def remove_class(self, name):
        self.classes.discard(name)


class GtkStub:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs
        self.children = []
        self._style_context = StyleContext()
        self._accessible = AtkObject()

    def get_style_context(self):
        return self._style_context

    def get_accessible(self):
        return self._accessible

    def add(self, child):
        self.children.append(child)

    def pack_start(self, child, *args):
        self.children.append(child)

    def show_all(self): # NOSONAR [S1186] -- deliberate test seam
        pass

    def set_margin_right(self, value): # NOSONAR [S1186] -- deliberate test seam
        pass

    def set_margin_left(self, value): # NOSONAR [S1186] -- deliberate test seam
        pass

    def set_margin_top(self, value): # NOSONAR [S1186] -- deliberate test seam
        pass

    def set_margin_bottom(self, value): # NOSONAR [S1186] -- deliberate test seam
        pass

    def set_shadow_type(self, value): # NOSONAR [S1186] -- deliberate test seam
        pass

    def set_selection_mode(self, value): # NOSONAR [S1186] -- deliberate test seam
        pass

    def set_policy(self, horizontal, vertical):
        self.policy = (horizontal, vertical)


class GtkLabel(GtkStub):
    instances = []

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        GtkLabel.instances.append(self)
        self.text = kwargs.get("label", args[0] if args else "")
        # a real Gtk.Label does not wrap unless told to, and a dialog sized to
        # its content is as wide as its widest unwrapped line
        self.line_wrap = False
        self.max_width_chars = -1
        self.selectable = False
        self.can_focus = False

    def set_xalign(self, value): # NOSONAR [S1186] -- deliberate test seam
        pass

    def set_line_wrap(self, wrap):
        self.line_wrap = wrap

    def set_max_width_chars(self, chars):
        self.max_width_chars = chars

    def set_selectable(self, selectable):
        self.selectable = selectable
        # Gtk.Label makes selectable text keyboard-focusable. Mirror that
        # coupling so a test cannot accidentally add static prose to the tab
        # order while asserting only the selection state.
        self.can_focus = selectable

    def set_text(self, text):
        self.text = text


class GtkLinkButton(GtkStub):
    instances = []

    def __init__(self, uri, label):
        super().__init__()
        self.uri = uri
        self.label = label
        self.halign = None
        GtkLinkButton.instances.append(self)

    @classmethod
    def new_with_label(cls, uri, label):
        return cls(uri, label)

    def set_halign(self, alignment):
        self.halign = alignment


class GtkImage(GtkStub):
    instances = []

    def __init__(self, path):
        super().__init__()
        self.path = path
        self.valign = None
        GtkImage.instances.append(self)

    @classmethod
    def new_from_file(cls, path):
        return cls(path)

    def set_valign(self, alignment):
        self.valign = alignment


class GtkWindow(GtkStub):
    instances = []

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.title = kwargs.get("title")
        self.default_size = None
        self.position = None
        self.icon_path = None
        self.handlers = []
        self.shown = False
        GtkWindow.instances.append(self)

    def set_default_size(self, width, height):
        self.default_size = (width, height)

    def set_position(self, position):
        self.position = position

    def set_icon_from_file(self, path):
        self.icon_path = path

    def connect(self, signal, callback):
        self.handlers.append((signal, callback))

    def show_all(self):
        self.shown = True


class GtkMessageDialog(GtkStub):
    instances = []

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.ran = False
        self.destroyed = False
        GtkMessageDialog.instances.append(self)

    def run(self):
        self.ran = True

    def destroy(self):
        self.destroyed = True


class GtkDialog(GtkStub):
    on_run = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.content_area = GtkStub()
        self.sensitivity = []
        self.destroyed = False

    def get_content_area(self):
        return self.content_area

    def set_response_sensitive(self, response, value):
        self.sensitivity.append((response, value))

    def run(self):
        if GtkDialog.on_run is not None:
            return GtkDialog.on_run(self)
        return 0  # ResponseType.CANCEL

    def destroy(self):
        self.destroyed = True


class DialogSettings:
    def __init__(self):
        self.requested = []

    def get_property(self, key, prop):
        self.requested.append((key, prop))
        # both columns, as the real schema declares them: the dialog takes its
        # headings from there rather than inventing one
        return [
            {"id": "label", "title": "Display name", "type": "string"},
            {"id": "timezone", "title": "Timezone", "type": "string"},
        ]


class AddButton:
    def __init__(self):
        self.sensitive = None
        self.tooltip = None
        self.has_tooltip = True

    def set_sensitive(self, value):
        self.sensitive = value

    def set_tooltip_text(self, text):
        # Real Gtk.Widget.set_tooltip_text is annotated non-nullable, and passing
        # None raises. The double used to accept it, so it stood in for an API
        # that does not exist and the settings window died on open while this
        # test stayed green. It refuses None now, as the real one does.
        if text is None:
            raise TypeError("Argument 1 does not allow None as a value")
        self.tooltip = text
        # Gtk sets has-tooltip for any non-NULL text, "" included — which is why
        # clearing the tooltip takes both calls.
        self.has_tooltip = True

    def set_has_tooltip(self, value):
        self.has_tooltip = value


class Model:
    def __init__(self, count):
        self.count = count

    def iter_n_children(self, _parent):
        return self.count


class JSONSettingsList:
    def __init__(self, key, settings, info):
        self.key = key
        self.settings = settings
        self.info = info
        self.show_buttons = True
        # The real widget loads the saved JSON through typed schema columns.
        # Do that here too: malformed rows must be repaired before this point,
        # not hidden by a double that only counts an arbitrary list.
        getter = getattr(settings, "get_value", None)
        value = getter(key) if callable(getter) else info.get("value")
        if not isinstance(value, list):
            raise TypeError("JSONSettingsList value must be a list")
        for row in value:
            if not isinstance(row, dict):
                raise TypeError("JSONSettingsList row must be an object")
            if not isinstance(row.get("label"), str):
                raise TypeError("JSONSettingsList label must be a string")
            if not isinstance(row.get("timezone"), str):
                raise TypeError("JSONSettingsList timezone must be a string")
        self.model = Model(len(value))
        self.model.rows = value
        self.add_button = AddButton()

    def update_button_sensitivity(self, *args):
        self.super_args = args

    # Cinnamon's List.on_setting_changed clears and repopulates the model and
    # calls update_button_sensitivity for none of it — which is the whole reason
    # a reset left the Add button judging a tree that no longer existed. The
    # double has to have the same hole, or the override that fills it is
    # asserted against a base class that never needed one.
    def on_setting_changed(self, *args):
        getter = getattr(self.settings, "get_value", None)
        rows = getter(self.key) if callable(getter) else []
        self.model.rows = list(rows if isinstance(rows, list) else [])
        self.model.count = len(self.model.rows)

    def get_toplevel(self):
        return None


class FakeSettings:
    """The settings handler a JSON-backed widget reads and writes through."""

    def __init__(self, values=None):
        self.values = dict(values or {})
        self.listeners = []
        self.writes = []

    def get_value(self, key):
        return self.values.get(key)

    def set_value(self, key, value):
        self.values[key] = value
        self.writes.append((key, value))
        for listened_key, callback in self.listeners:
            if listened_key == key:
                callback()

    def listen(self, key, callback):
        self.listeners.append((key, callback))

    def bind(self, key, bind_object, bind_prop, bind_dir, map_get, map_set): # NOSONAR [S1172] -- deliberate test seam
        self.bound = (key, bind_object, bind_prop)
        bind_object.set_property(bind_prop, self.get_value(key))

    def has_property(self, key, prop): # NOSONAR [S1172] -- deliberate test seam
        return False


class JSONSettingsBackend:
    """The half of a Cinnamon settings widget that talks to the settings file.

    Same contract as the real one: a widget with bind_dir binds its content
    widget to the key, and one without listens and drives itself.
    """

    def attach(self):
        self._saving = False
        bind_object = getattr(self, "bind_object", self.content_widget)
        if self.bind_dir is not None:
            self.settings.bind(self.key, bind_object, self.bind_prop,
                               self.bind_dir, None, None)
        else:
            self.settings.listen(self.key, self._settings_changed_callback)
            self.on_setting_changed()
            self.connect_widget_handlers()

    def set_value(self, value):
        self._saving = True
        self.settings.set_value(self.key, value)
        self._saving = False

    def get_value(self):
        return self.settings.get_value(self.key)

    def _settings_changed_callback(self, *args):
        if not self._saving:
            self.on_setting_changed(*args)


class JSONSettingsEntry(Entry):
    """What json_settings_factory builds out of xapp's Entry."""

    bind_prop = "text"
    bind_dir = 1

    def __init__(self, key, settings, properties):
        super().__init__(label=properties.get("description", ""),
                         tooltip=properties.get("tooltip", ""))
        self.key = key
        self.settings = settings
        self.settings.bind(key, self.content_widget, self.bind_prop,
                           self.bind_dir, None, None)


class SettingsLabel:
    def __init__(self, text=""):
        self.text = text


class SettingsWidget:
    """xapp's base: a Gtk.Box the widget packs its label and content into."""

    def __init__(self, dep_key=None):
        self.dep_key = dep_key
        self.children = []
        self.tooltip = None

    def pack_start(self, child, *args):
        self.children.append(child)

    def pack_end(self, child, *args):
        self.children.append(child)

    def set_tooltip_text(self, text):
        self.tooltip = text


class SettingsSection:
    def __init__(self, title=None, subtitle=None):
        self.title = title
        self.subtitle = subtitle
        self.rows = []

    def add_row(self, row):
        self.rows.append(row)


class SettingsPage:
    def __init__(self):
        self.sections = []

    def add_section(self, title=None, subtitle=None):
        section = SettingsSection(title, subtitle)
        self.sections.append(section)
        return section


class GtkComboBoxWithEntry:
    """Gtk.ComboBox.new_with_model_and_entry: a combo whose child is an entry."""

    def __init__(self, model):
        self.model = model
        self.entry = BindObject()
        self.active_iter = None
        self.entry_text_column = None
        self.id_column = None
        self.handlers = []

    @classmethod
    def new_with_model_and_entry(cls, model):
        return cls(model)

    def get_child(self):
        return self.entry

    def set_entry_text_column(self, column):
        self.entry_text_column = column

    def set_id_column(self, column):
        self.id_column = column

    def set_active_iter(self, tree_iter):
        self.active_iter = tree_iter
        # the real combo fills its entry from the model when a row goes active
        if tree_iter is not None:
            self.entry.set_text(self.model[tree_iter][self.entry_text_column])
        for signal, callback in self.handlers:
            if signal == "changed":
                callback(self)

    def get_active_iter(self):
        return self.active_iter

    def connect(self, signal, callback):
        self.handlers.append((signal, callback))

    def type_text(self, text):
        """The user typing: text changes, nothing is chosen."""
        self.entry.set_text(text)
        self.active_iter = None
        for signal, callback in self.handlers:
            if signal == "changed":
                callback(self)


STUBBED_MODULES = ("JsonSettingsWidgets", "xapp", "xapp.SettingsWidgets", "gi", "gi.repository") # NOSONAR [S1192] -- deliberate test seam
_original_modules = {}


def install_stubs():
    # remember whatever was importable before so tearDownModule can put it
    # back; other test files in the same process must see the real modules
    for stub_name in STUBBED_MODULES:
        if stub_name not in _original_modules:
            _original_modules[stub_name] = sys.modules.get(stub_name)

    json_settings = types.ModuleType("JsonSettingsWidgets")
    json_settings.JSONSettingsList = JSONSettingsList
    json_settings.JSONSettingsBackend = JSONSettingsBackend
    json_settings.JSONSettingsEntry = JSONSettingsEntry
    sys.modules["JsonSettingsWidgets"] = json_settings

    xapp = types.ModuleType("xapp")
    settings_widgets = types.ModuleType("xapp.SettingsWidgets")
    settings_widgets.ComboBox = ComboBox
    settings_widgets.Entry = Entry
    settings_widgets.SettingsLabel = SettingsLabel
    settings_widgets.SettingsPage = SettingsPage
    settings_widgets.SettingsWidget = SettingsWidget
    sys.modules["xapp"] = xapp
    sys.modules["xapp.SettingsWidgets"] = settings_widgets

    gi = types.ModuleType("gi")
    gi.require_version = lambda *_args: None
    repository = types.ModuleType("gi.repository")
    gtk = types.SimpleNamespace(
        MessageDialog=GtkMessageDialog,
        DialogFlags=types.SimpleNamespace(MODAL=1),
        MessageType=types.SimpleNamespace(INFO=1),
        ButtonsType=types.SimpleNamespace(OK=1),
        Dialog=GtkDialog,
        STOCK_CANCEL="cancel",
        STOCK_OK="ok",
        ResponseType=types.SimpleNamespace(CANCEL=0, OK=1),
        Frame=GtkStub,
        ShadowType=types.SimpleNamespace(IN=1),
        Box=GtkStub,
        Orientation=types.SimpleNamespace(VERTICAL=1, HORIZONTAL=2),
        Separator=GtkStub,
        ListBox=GtkStub,
        SelectionMode=types.SimpleNamespace(NONE=0),
        Align=types.SimpleNamespace(START=0),
        PolicyType=types.SimpleNamespace(NEVER=0, AUTOMATIC=1),
        WindowPosition=types.SimpleNamespace(CENTER=1),
        Label=GtkLabel,
        LinkButton=GtkLinkButton,
        Image=GtkImage,
        Window=GtkWindow,
        ScrolledWindow=GtkStub,
        ListStore=GtkListStore,
        EntryCompletion=GtkEntryCompletion,
        ComboBox=GtkComboBoxWithEntry,
    )
    gtk.main_calls = 0
    gtk.main = lambda: setattr(gtk, "main_calls", gtk.main_calls + 1)
    gtk.main_quit = lambda: None
    repository.Gtk = gtk
    # the accessibility layer every GTK widget answers through; the dialog uses it
    # to tie its validation message to the field the message is about
    repository.Atk = types.SimpleNamespace(
        RelationType=types.SimpleNamespace(DESCRIBED_BY="described-by"))
    # the settings window centers itself from an idle; record the callbacks
    # instead of running a main loop
    repository.GLib = types.SimpleNamespace(
        idle_add=lambda callback, *args: GLibStub.idles.append((callback, args)) or 1,
        # the real GLib.Error, which centering catches alongside the Gtk errors
        Error=GLibError,
    )
    gi.repository = repository
    sys.modules["gi"] = gi
    sys.modules["gi.repository"] = repository


# somewhere no other test names, so "the local zone is reserved" and "Europe/Rome
# is accepted" can both be true wherever the suite runs
FIXED_LOCAL_TIMEZONE = "Antarctica/Troll"


def _pin_local_timezone(preloaded):
    # The dialog rejects a timezone that resolves to one the applet already
    # draws — including the machine's own zone. Reading the real
    # /etc/localtime would make every test depend on where the test ran: on a
    # machine in Rome, "Europe/Rome" is correctly reserved. local_timezone_name
    # has its own tests; here it is a fixed answer, and it is patched where it
    # lives: TimezoneResolver and local_city_name call the gi-free sibling's
    # copy, not a re-export.
    for cached_name in set(sys.modules) - preloaded:
        cached = sys.modules.get(cached_name)
        cached_file = getattr(cached, "__file__", None)
        if (cached_file and str(APPLET_DIR) in str(cached_file)
                and hasattr(cached, "local_timezone_name")):
            cached.local_timezone_name = lambda: FIXED_LOCAL_TIMEZONE


def _purge_applet_modules(preloaded, preload):
    # drop any applet-dir sibling exec pulled into the module cache
    for cached_name in set(sys.modules) - preloaded:
        cached = sys.modules.get(cached_name)
        cached_file = getattr(cached, "__file__", None)
        if cached_file and str(APPLET_DIR) in str(cached_file):
            del sys.modules[cached_name]
    for preload_name in (preload or {}):
        sys.modules.pop(preload_name, None)


def load_module(path, name, missing_pytz=False, missing_zoneinfo=False, preload=None):
    install_stubs()
    sys.path.insert(0, str(APPLET_DIR))
    # a sibling already loaded by a previous call, handed in so this module
    # imports that exact instance — how the shim behaves in cinnamon-settings,
    # where every feature module sees one chronos_settings_widgets_common
    for preload_name, preload_module in (preload or {}).items():
        sys.modules[preload_name] = preload_module
    original_import = builtins.__import__
    # anything already imported stays; a sibling the module pulls in during exec
    # (e.g. a gi-free chronos_timezone_data split out of the widget module) is imported
    # by name off the applet dir and would otherwise linger in sys.modules, so a
    # later load would import that cached copy instead of the edited source — the
    # same stale-source trap the .pyc guard at the top of this file avoids.
    preloaded = set(sys.modules)

    def guarded_import(import_name, *args, **kwargs):
        if missing_pytz and import_name == "pytz":
            raise ImportError("pytz unavailable")
        if missing_zoneinfo and import_name == "zoneinfo":
            raise ImportError("zoneinfo unavailable")
        return original_import(import_name, *args, **kwargs)

    builtins.__import__ = guarded_import
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _pin_local_timezone(preloaded)
        return module
    finally:
        builtins.__import__ = original_import
        # the 6.0 wrapper inserts the applet dir a second time; drop them all
        while str(APPLET_DIR) in sys.path:
            sys.path.remove(str(APPLET_DIR))
        _purge_applet_modules(preloaded, preload)


def tearDownModule():
    for stub_name, original in _original_modules.items():
        if original is None:
            sys.modules.pop(stub_name, None)
        else:
            sys.modules[stub_name] = original
    _original_modules.clear()


__all__ = [
    "APPLET_DIR", "COMMON_PATH", "WEATHER_PATH", "HOLIDAYS_PATH", "WORLDCLOCKS_PATH", "RESERVED_TIMEZONES", "requires_pytz",
    "BindObject", "GtkEntryCompletion", "GtkDialog", "GtkMessageDialog",
    "GtkLabel", "BaseWidget", "ComboBox", "Entry", "Model", "DialogSettings",
    "FakeSettings", "GLibError", "GLibStub", "GtkStub",
    "GtkLinkButton", "GtkImage", "GtkWindow", "FIXED_LOCAL_TIMEZONE",
    "load_module", "install_stubs", "tearDownModule", "FUZZ_SEED",
    "unittest", "types", "json", "random", "re", "sys", "importlib", "Path",
    "_pytz"
]
