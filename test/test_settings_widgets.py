import builtins
import importlib.util
import json
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


APPLET_DIR = Path(__file__).resolve().parent.parent / "files" / "chronos@geraldo-netto"
COMMON_PATH = APPLET_DIR / "settings_widgets_common.py"

try:
    import pytz as _pytz
    HAS_PYTZ = _pytz is not None
except ImportError:
    HAS_PYTZ = False

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

    def set_placeholder_text(self, text):
        self.placeholder = text

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
        self.relationships.append((relation, target))


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

    def show_all(self):
        pass

    def set_margin_right(self, value):
        pass

    def set_margin_left(self, value):
        pass

    def set_margin_top(self, value):
        pass

    def set_margin_bottom(self, value):
        pass

    def set_shadow_type(self, value):
        pass

    def set_selection_mode(self, value):
        pass


class GtkLabel(GtkStub):
    instances = []

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        GtkLabel.instances.append(self)
        self.text = ""
        # a real Gtk.Label does not wrap unless told to, and a dialog sized to
        # its content is as wide as its widest unwrapped line
        self.line_wrap = False
        self.max_width_chars = -1

    def set_xalign(self, value):
        pass

    def set_line_wrap(self, wrap):
        self.line_wrap = wrap

    def set_max_width_chars(self, chars):
        self.max_width_chars = chars

    def set_text(self, text):
        self.text = text


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
        # the real json_settings_factory constructor never reads
        # properties['value']; the list content comes from settings later
        value = info.get("value")
        self.model = Model(len(value) if isinstance(value, list) else 0)
        self.add_button = AddButton()

    def update_button_sensitivity(self, *args):
        self.super_args = args

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

    def bind(self, key, bind_object, bind_prop, bind_dir, map_get, map_set):
        self.bound = (key, bind_object, bind_prop)
        bind_object.set_property(bind_prop, self.get_value(key))

    def has_property(self, key, prop):
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


STUBBED_MODULES = ("JsonSettingsWidgets", "xapp", "xapp.SettingsWidgets", "gi", "gi.repository")
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
    settings_widgets.SettingsWidget = SettingsWidget
    sys.modules["xapp"] = xapp
    sys.modules["xapp.SettingsWidgets"] = settings_widgets

    gi = types.ModuleType("gi")
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
        Label=GtkLabel,
        ListStore=GtkListStore,
        EntryCompletion=GtkEntryCompletion,
        ComboBox=GtkComboBoxWithEntry,
    )
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


def load_module(path, name, missing_pytz=False):
    install_stubs()
    sys.path.insert(0, str(APPLET_DIR))
    original_import = builtins.__import__

    def guarded_import(import_name, *args, **kwargs):
        if missing_pytz and import_name == "pytz":
            raise ImportError("pytz unavailable")
        return original_import(import_name, *args, **kwargs)

    builtins.__import__ = guarded_import
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # The dialog rejects a timezone that resolves to one the applet already
        # draws — including the machine's own zone. Reading the real
        # /etc/localtime would make every test below depend on where the test
        # ran: on a machine in Rome, "Europe/Rome" is correctly reserved.
        # local_timezone_name has its own tests; here it is a fixed answer.
        module.local_timezone_name = lambda: FIXED_LOCAL_TIMEZONE
        return module
    finally:
        builtins.__import__ = original_import
        # the 5.4 wrapper inserts the applet dir a second time; drop them all
        while str(APPLET_DIR) in sys.path:
            sys.path.remove(str(APPLET_DIR))


def tearDownModule():
    for stub_name, original in _original_modules.items():
        if original is None:
            sys.modules.pop(stub_name, None)
        else:
            sys.modules[stub_name] = original
    _original_modules.clear()


class SettingsWidgetsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module(COMMON_PATH, "settings_widgets_common_test")

    def setUp(self):
        GtkDialog.on_run = None
        GtkMessageDialog.instances.clear()
        BaseWidget.instances.clear()

    def test_list_edit_factory_combo_widget(self):
        widget = self.module.list_edit_factory({
            "title": "City",
            "options": [("Rome", "Rome")]
        })

        self.assertIsInstance(widget, ComboBox)
        self.assertEqual(widget.kwargs["label"], "City")
        self.assertEqual(widget.kwargs["valtype"], str)
        self.assertTrue(widget.handlers_connected)
        self.assertIsNone(widget.get_value())

        widget.set_widget_value("Rome")
        self.assertEqual(widget.get_widget_value(), "Rome")
        self.assertTrue(widget.changed)

    def test_list_edit_factory_entry_widget(self):
        widget = self.module.list_edit_factory({"title": "Label"})

        self.assertIsInstance(widget, Entry)
        self.assertEqual(widget.kwargs["label"], "Label")

        widget.set_widget_value("Home")
        self.assertEqual(widget.get_widget_value(), "Home")

    def test_the_column_widgets_are_declared_once_not_per_dialog(self):
        # PyGObject registers a GType for every subclass of a GObject type, and
        # GTypes are never unregistered. Declaring the widget classes inside the
        # factory leaked two of them - with their class structures and closures
        # - on every Add or Edit click, for the life of the settings process.
        first = self.module.list_edit_factory({"title": "Label"})
        second = self.module.list_edit_factory({"title": "Label"})
        self.assertIs(type(first), type(second))
        self.assertIs(type(first), self.module.ListEditEntry)

        combo = self.module.list_edit_factory({"title": "Zone", "options": {"a": "1"}})
        again = self.module.list_edit_factory({"title": "Zone", "options": {"a": "1"}})
        self.assertIs(type(combo), type(again))
        self.assertIs(type(combo), self.module.ListEditComboBox)

    def test_the_suggestion_store_is_built_once_not_per_dialog(self):
        # ~440 rows with pytz, rebuilt on the GTK main thread every time the
        # dialog opened; the list does not change while the process runs
        completions = [("Rome (Europe)", "Europe/Rome"), ("Tokyo (Asia)", "Asia/Tokyo")]

        first = self.module.list_edit_factory({"title": "Zone", "completions": completions})
        second = self.module.list_edit_factory({"title": "Zone", "completions": completions})

        self.assertIs(first.completion.model, second.completion.model)
        self.assertEqual(len(first.completion.model.rows), 2)

    def test_add_button_stops_at_the_clock_limit(self):
        clocks = self.module.ClocksList({
            "value": [{"label": "Rome", "timezone": "Europe/Rome"}]
        }, "worldclocks", object())

        self.assertTrue(clocks.add_button.sensitive)
        self.assertFalse(clocks.add_button.tooltip,
                         "a button that works needs no excuse")
        self.assertFalse(clocks.add_button.has_tooltip,
                         "an empty tooltip still pops an empty box on hover")

        clocks.model = Model(self.module.MAX_CLOCKS)
        clocks.update_button_sensitivity()
        self.assertFalse(clocks.add_button.sensitive)

        # The sentence explaining the cap fires from open_add_edit_dialog, which is
        # reached by a click the button can no longer receive: it was unreachable,
        # and the user got a dead button with no explanation anywhere. The button
        # says why it is dead.
        self.assertEqual(clocks.add_button.tooltip, self.module.CLOCK_LIMIT_MESSAGE)
        self.assertIn("8", clocks.add_button.tooltip)

        self.assertTrue(clocks.add_button.has_tooltip)

        # ...and removing one brings it back, with no stale excuse on it
        clocks.model = Model(self.module.MAX_CLOCKS - 1)
        clocks.update_button_sensitivity()
        self.assertTrue(clocks.add_button.sensitive)
        self.assertFalse(clocks.add_button.tooltip)
        self.assertFalse(clocks.add_button.has_tooltip)

    def test_constructor_survives_corrupt_saved_clocks(self):
        corrupt_values = [
            [{"label": "Rome"}],                      # missing timezone key
            [{"label": "Rome", "timezone": None}],    # null timezone
            [{"label": "Rome", "timezone": 42}],      # non-string timezone
            ["not-a-dict"],                           # entry is not an object
        ]

        for value in corrupt_values:
            with self.subTest(value=value):
                clocks = self.module.ClocksList({"value": value}, "worldclocks", object())
                self.assertTrue(clocks.add_button.sensitive)

    def test_constructor_survives_non_list_saved_value(self):
        # xlet-settings.py instantiates widgets outside its try block, so a
        # constructor exception breaks the whole settings window
        for info in [{"value": None}, {"value": 5}, {"value": "clocks"}, {}]:
            with self.subTest(info=info):
                clocks = self.module.ClocksList(dict(info), "worldclocks", object())
                self.assertTrue(clocks.add_button.sensitive)

    def test_clock_entry_serializer_owns_dialog_data_and_output_shape(self):
        serializer = self.module.ClockEntrySerializer()

        data, title = serializer.initial_dialog_data(None)
        self.assertEqual(data, {"label": None, "timezone": None})
        self.assertEqual(title, "Add new entry")

        data, title = serializer.initial_dialog_data(["Tokyo", "Asia/Tokyo"])
        self.assertEqual(data, {"label": "Tokyo", "timezone": "Asia/Tokyo"})
        self.assertEqual(title, "Edit entry")

        self.assertEqual(serializer.serialize("Home", "Europe/Rome"), ["Home", "Europe/Rome"])

    def test_clock_entry_serializer_matches_schema_column_order(self):
        schema = json.loads((APPLET_DIR / "5.4" / "settings-schema.json").read_text())
        column_ids = [column["id"] for column in schema["worldclocks"]["columns"]]

        serializer = self.module.ClockEntrySerializer()

        self.assertEqual(column_ids, ["label", "timezone"])
        self.assertEqual(
            dict(zip(column_ids, serializer.serialize("Home", "Europe/Rome"))),
            {"label": "Home", "timezone": "Europe/Rome"}
        )

    def test_timezone_resolver_builds_maps_and_normalizes_values(self):
        fake_pytz = types.SimpleNamespace(
            all_timezones=["Europe/Rome", "America/New_York", "UTC"],
            common_timezones=["Europe/Rome", "America/New_York", "UTC"]
        )

        resolver = self.module.TimezoneResolver(fake_pytz, None)

        self.assertTrue(resolver.has_timezone_data)
        self.assertEqual(resolver.split("Europe/Rome"), ("Europe", "Rome"))
        self.assertEqual(resolver.split("UTC"), ("Etc", "UTC"))
        self.assertEqual(resolver.split(None), ("Etc", ""))
        self.assertEqual(resolver.normalize(" europe/rome "), "Europe/Rome")
        self.assertEqual(resolver.normalize("new york"), "America/New_York")
        self.assertIsNone(resolver.normalize("UTC"))
        self.assertIsNone(resolver.normalize("local"))
        self.assertIsNone(resolver.normalize(""))
        self.assertIsNone(resolver.normalize("Not A Timezone"))
        self.assertEqual(
            resolver.completions,
            [
                ("New York (America)", "America/New_York"),
                ("Rome (Europe)", "Europe/Rome"),
                ("UTC", "UTC"),
            ])

    def test_timezone_resolver_finds_cities_nested_below_their_region(self):
        fake_pytz = types.SimpleNamespace(
            all_timezones=["America/Argentina/Buenos_Aires", "America/New_York"],
            common_timezones=["America/Argentina/Buenos_Aires", "America/New_York"]
        )

        resolver = self.module.TimezoneResolver(fake_pytz, None)

        self.assertEqual(
            resolver.normalize("buenos aires"), "America/Argentina/Buenos_Aires")
        self.assertEqual(
            resolver.normalize("Argentina/Buenos_Aires"), "America/Argentina/Buenos_Aires")
        self.assertEqual(
            resolver.completions,
            [
                ("Buenos Aires (America / Argentina)", "America/Argentina/Buenos_Aires"),
                ("New York (America)", "America/New_York"),
            ])

    def test_timezone_resolver_sorts_suggestions_by_city_name(self):
        fake_pytz = types.SimpleNamespace(
            all_timezones=["Europe/Rome", "Europe/Amsterdam", "Africa/Cairo"],
            common_timezones=["Europe/Rome", "Europe/Amsterdam", "Africa/Cairo"]
        )

        resolver = self.module.TimezoneResolver(fake_pytz, None)

        self.assertEqual(
            [display for display, timezone in resolver.completions],
            ["Amsterdam (Europe)", "Cairo (Africa)", "Rome (Europe)"])

    def test_timezone_resolver_keeps_the_first_zone_for_a_shared_city_name(self):
        fake_pytz = types.SimpleNamespace(
            all_timezones=["Asia/Nicosia", "Europe/Nicosia"],
            common_timezones=["Asia/Nicosia", "Europe/Nicosia"]
        )

        resolver = self.module.TimezoneResolver(fake_pytz, None)

        self.assertEqual(resolver.normalize("nicosia"), "Asia/Nicosia")
        self.assertEqual(resolver.normalize("Europe/Nicosia"), "Europe/Nicosia")

    def test_a_dialog_with_no_timezone_database_says_so_in_the_dialog(self):
        # the warning otherwise only reaches a log line nobody opening this
        # dialog will ever read
        module = load_module(COMMON_PATH, "settings_widgets_no_tz_hint", missing_pytz=True)
        clocks = module.ClocksList({"value": []}, "worldclocks", DialogSettings())
        clocks.timezone_resolver = module.TimezoneResolver(None, None)

        labels = []

        def script(dialog):
            labels.extend(
                child.text for child in dialog.content_area.children[0].children[0].children
                if isinstance(child, GtkLabel))
            return 0  # cancel

        GtkDialog.on_run = script
        clocks.open_add_edit_dialog()

        self.assertTrue(
            any("Install python3-pytz" in text for text in labels),
            "with no timezone database at all, the dialog has to say so: %r" % labels)

    def test_a_combo_column_keeps_the_value_it_is_given(self):
        # xapp's ComboBox calls set_value/get_value from connect_widget_handlers
        widget = self.module.list_edit_factory({"title": "Zone", "options": {"Rome": "eu"}})

        widget.set_value("eu")
        self.assertEqual(widget.get_value(), "eu")
        self.assertEqual(widget.get_widget_value(), "eu")

    def test_completion_match_refuses_a_row_it_cannot_read(self):
        match = self.module.timezone_completion_match
        model = self.module.timezone_completion_model([("Rome (Europe)", "Europe/Rome")])

        # GTK passes the key straight from the entry; an empty one would match
        # every row and pop the whole zone list open
        self.assertFalse(match(None, "", 0, model))
        self.assertFalse(match(None, "   ", 0, model))

    def test_local_timezone_name_reads_the_zoneinfo_link(self):
        # load_module stubs this out so the rest of the suite does not depend on
        # where it runs; the real one is exercised here, against a real
        # /etc/localtime and against the shapes it has to survive
        module = load_module(COMMON_PATH, "settings_widgets_common_localtime")
        real = module.__dict__["local_timezone_name"]
        # (load_module replaced the module attribute, so reach for the original
        # through a fresh import of the source)
        import importlib.util
        spec = importlib.util.spec_from_file_location("swc_localtime_real", COMMON_PATH)
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        del real

        name = fresh.local_timezone_name()
        # this machine has a real /etc/localtime; a container or a copied file
        # would answer None, which is the other half of the contract
        self.assertTrue(name is None or "/" in name or name.isalpha(), name)
        if name is not None:
            self.assertNotIn("zoneinfo", name)
            self.assertFalse(name.startswith("/"))

        # a path that is not inside a zoneinfo tree has no name to give
        original_resolve = Path.resolve
        try:
            Path.resolve = lambda self, strict=False: Path("/etc/localtime")
            self.assertIsNone(fresh.local_timezone_name())

            def explode(self, strict=False):
                raise OSError("no such file")

            Path.resolve = explode
            self.assertIsNone(fresh.local_timezone_name())
        finally:
            Path.resolve = original_resolve

    def test_the_local_zone_is_reserved_under_whatever_name_it_is_typed(self):
        # The applet draws a local-time row and drops any configured clock whose
        # zone resolves to the same one. The dialog blocked the word "local" but
        # happily validated, previewed and saved "America/Sao_Paulo" for a user
        # in São Paulo — and then the clock never appeared, with nothing said.
        fake_pytz = types.SimpleNamespace(
            all_timezones=["America/Sao_Paulo", "Europe/Rome"],
            common_timezones=["America/Sao_Paulo", "Europe/Rome"]
        )
        resolver = self.module.TimezoneResolver(
            fake_pytz, None, local_timezone="America/Sao_Paulo")

        for typed in ("America/Sao_Paulo", "america/sao_paulo", "Sao Paulo", "local"):
            self.assertTrue(resolver.is_reserved(typed), typed)
            self.assertIsNone(resolver.normalize(typed), typed)

        # a zone that is not a built-in is still perfectly fine
        self.assertFalse(resolver.is_reserved("Europe/Rome"))
        self.assertEqual(resolver.normalize("Europe/Rome"), "Europe/Rome")

    def test_the_dialog_says_why_a_built_in_zone_was_refused(self):
        fake_pytz = types.SimpleNamespace(
            all_timezones=["America/Sao_Paulo"], common_timezones=["America/Sao_Paulo"])
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        clocks.timezone_resolver = self.module.TimezoneResolver(
            fake_pytz, None, local_timezone="America/Sao_Paulo")

        values = {"label": "Home", "timezone": "Sao Paulo"}
        choice = clocks.resolve_timezone_choice(values)

        self.assertTrue(choice["reserved"])
        self.assertIsNone(choice["timezone"])
        self.assertEqual(
            clocks.format_timezone_preview(values),
            "UTC and local time are already shown as built-in clocks")

    def test_timezone_resolver_uses_zoneinfo_fallback_without_pytz(self):
        resolver = self.module.TimezoneResolver(
            None,
            lambda: {"Europe/Rome", "America/New_York"}
        )

        self.assertFalse(resolver.has_timezone_data)
        self.assertEqual(
            [timezone for display, timezone in resolver.completions],
            ["America/New_York", "Europe/Rome"])
        self.assertEqual(resolver.normalize(" europe/rome "), "Europe/Rome")
        self.assertEqual(resolver.normalize("AMERICA/NEW_YORK"), "America/New_York")
        self.assertEqual(resolver.normalize("new york"), "America/New_York")
        self.assertIsNone(resolver.normalize("UTC"))
        self.assertIsNone(resolver.normalize("local"))
        self.assertIsNone(resolver.normalize("Mars/Olympus"))

    def test_timezone_resolver_trusts_typed_values_when_no_timezone_source_exists(self):
        resolver = self.module.TimezoneResolver(None, None)

        self.assertFalse(resolver.has_timezone_data)
        self.assertEqual(resolver.completions, [])
        self.assertEqual(resolver.normalize(" Mars/Olympus "), "Mars/Olympus")
        self.assertIsNone(resolver.normalize("UTC"))
        self.assertIsNone(resolver.normalize("local"))
        self.assertIsNone(resolver.normalize(None))

    @requires_pytz
    def test_normalize_timezone_accepts_identifier_or_city(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())

        self.assertEqual(clocks.normalize_timezone(" europe/rome "), "Europe/Rome")
        self.assertEqual(clocks.normalize_timezone("new york"), "America/New_York")
        self.assertEqual(
            clocks.normalize_timezone("buenos aires"), "America/Argentina/Buenos_Aires")
        self.assertIn(
            ("Buenos Aires (America / Argentina)", "America/Argentina/Buenos_Aires"),
            clocks.completions)
        self.assertIsNone(clocks.normalize_timezone(""))
        self.assertIsNone(clocks.normalize_timezone("Not A Timezone"))

    @requires_pytz
    def test_normalize_timezone_fuzzes_case_and_spaces(self):
        random.seed(FUZZ_SEED)
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        samples = ["Europe/Rome", "America/New_York", "Asia/Tokyo", "Australia/Sydney"]

        for timezone in samples:
            for _ in range(10):
                noisy = "".join(
                    char.upper() if random.choice([True, False]) else char.lower()
                    for char in timezone
                )
                self.assertEqual(clocks.normalize_timezone(f" {noisy} "), timezone)

    @requires_pytz
    def test_normalize_timezone_uses_precomputed_maps(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        # the resolver is built on first use — which is what opening the World
        # Clocks page does — and the maps are precomputed then, once
        clocks.timezone_resolver  # noqa: B018

        class ExplodingTimezones:
            def __iter__(self):
                raise AssertionError("normalize_timezone should not scan pytz lists")

        original_all = self.module.pytz.all_timezones
        original_common = self.module.pytz.common_timezones
        try:
            self.module.pytz.all_timezones = ExplodingTimezones()
            self.module.pytz.common_timezones = ExplodingTimezones()

            self.assertEqual(clocks.normalize_timezone("europe/rome"), "Europe/Rome")
            self.assertEqual(clocks.normalize_timezone("new york"), "America/New_York")
            self.assertIsNone(clocks.normalize_timezone("Not A Timezone"))
        finally:
            self.module.pytz.all_timezones = original_all
            self.module.pytz.common_timezones = original_common

    @requires_pytz
    def test_timezone_choice_previews_saved_value(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())

        typed = {"label": "Work", "timezone": "Asia/Tokyo"}
        self.assertEqual(clocks.resolve_timezone_choice(typed), {
            "timezone": "Asia/Tokyo",
            "typed_invalid": False,
            "reserved": False
        })
        self.assertEqual(
            clocks.format_timezone_preview(typed),
            "Timezone to save: Asia/Tokyo"
        )

        city = {"label": "Work", "timezone": "buenos aires"}
        self.assertEqual(
            clocks.format_timezone_preview(city),
            "Timezone to save: America/Argentina/Buenos_Aires"
        )

        empty = {"label": "Work", "timezone": ""}
        self.assertEqual(clocks.format_timezone_preview(empty), "No timezone selected")

        missing = {"label": "Work", "timezone": "Not A Timezone"}
        self.assertEqual(clocks.resolve_timezone_choice(missing), {
            "timezone": None,
            "typed_invalid": True,
            "reserved": False
        })
        self.assertEqual(clocks.format_timezone_preview(missing), "Invalid timezone")

    @requires_pytz
    def test_timezone_choice_fuzzes_invalid_text(self):
        random.seed(FUZZ_SEED)
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 "

        for _ in range(40):
            text = "Invalid-" + "".join(random.choice(alphabet) for _ in range(12))

            choice = clocks.resolve_timezone_choice({"label": "Home", "timezone": text})

            self.assertIsNone(choice["timezone"])
            self.assertTrue(choice["typed_invalid"])

    @requires_pytz
    def test_timezone_choice_rejects_reserved_builtin_ids(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())

        for text in ("UTC", " utc ", "local", "Etc/UTC"):
            values = {"label": "Duplicate", "timezone": text}
            self.assertEqual(clocks.resolve_timezone_choice(values), {
                "timezone": None,
                "typed_invalid": True,
                "reserved": True
            })
            self.assertEqual(
                clocks.format_timezone_preview(values),
                "UTC and local time are already shown as built-in clocks"
            )

    def test_add_dialog_blocks_at_max_clocks(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings())
        clocks.model = Model(self.module.MAX_CLOCKS)

        result = clocks.open_add_edit_dialog()

        self.assertIsNone(result)
        self.assertEqual(len(GtkMessageDialog.instances), 1)
        message = GtkMessageDialog.instances[0]
        self.assertIn(str(self.module.MAX_CLOCKS), message.args[-1])
        self.assertTrue(message.ran)
        self.assertTrue(message.destroyed)

    @requires_pytz
    def test_add_dialog_gates_ok_and_returns_normalized_timezone(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings())

        def script(dialog):
            widgets = {w.kwargs["label"]: w for w in BaseWidget.instances}
            # nothing entered yet: OK must start insensitive
            self.assertEqual(dialog.sensitivity[-1], (1, False))

            label = widgets["Display name"]
            label.bind_object.set_property(label.bind_prop, "Home")
            label.bind_object.emit_changed()
            self.assertEqual(dialog.sensitivity[-1], (1, False))

            timezone = widgets["Timezone"]
            timezone.bind_object.set_property(timezone.bind_prop, " asia/tokyo ")
            timezone.bind_object.emit_changed()
            self.assertEqual(dialog.sensitivity[-1], (1, True))
            return 1  # ResponseType.OK

        GtkDialog.on_run = script
        result = clocks.open_add_edit_dialog()

        self.assertEqual(result, ["Home", "Asia/Tokyo"])

    @requires_pytz
    def test_edit_dialog_seeds_the_saved_timezone_and_keeps_it_on_ok(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings())

        seeded = {}

        def script(dialog):
            widgets = {w.kwargs["label"]: w for w in BaseWidget.instances}
            self.assertEqual(
                sorted(widgets),
                sorted(["Display name", "Timezone"]))

            timezone = widgets["Timezone"]
            seeded["timezone"] = timezone.get_widget_value()
            return 1  # ResponseType.OK

        GtkDialog.on_run = script
        result = clocks.open_add_edit_dialog(["Tokyo", "Asia/Tokyo"])

        self.assertEqual(seeded, {"timezone": "Asia/Tokyo"})
        self.assertEqual(result, ["Tokyo", "Asia/Tokyo"])

    @requires_pytz
    def test_timezone_entry_completes_a_typed_city_name(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings())

        completed = {}

        def script(dialog):
            widgets = {w.kwargs["label"]: w for w in BaseWidget.instances}
            timezone = widgets["Timezone"]
            completion = timezone.completion

            completed["matches"] = completion.matches("buenos ai")
            completion.select(completion.matches_index("America/Argentina/Buenos_Aires"))
            completed["text"] = timezone.get_widget_value()
            return 0  # ResponseType.CANCEL

        GtkDialog.on_run = script
        clocks.open_add_edit_dialog()

        self.assertEqual(completed["matches"], ["America/Argentina/Buenos_Aires"])
        # picking a suggestion writes the identifier, not the pretty label
        self.assertEqual(completed["text"], "America/Argentina/Buenos_Aires")

    def test_add_dialog_without_pytz_accepts_typed_timezone(self):
        module = load_module(COMMON_PATH, "settings_widgets_common_dialog_no_pytz", missing_pytz=True)
        clocks = module.ClocksList({"value": []}, "worldclocks", DialogSettings())

        def script(dialog):
            widgets = {w.kwargs["label"]: w for w in BaseWidget.instances}
            self.assertEqual(
                sorted(widgets),
                sorted(["Display name", "Timezone"]))

            label = widgets["Display name"]
            label.bind_object.set_property(label.bind_prop, "Somewhere")
            label.bind_object.emit_changed()

            timezone = widgets["Timezone"]
            # zoneinfo still validates typed entries without pytz
            timezone.bind_object.set_property(timezone.bind_prop, "Mars/Olympus")
            timezone.bind_object.emit_changed()
            self.assertEqual(dialog.sensitivity[-1], (1, False))

            timezone.bind_object.set_property(timezone.bind_prop, "europe/rome")
            timezone.bind_object.emit_changed()
            self.assertEqual(dialog.sensitivity[-1], (1, True))
            return 1  # ResponseType.OK

        GtkDialog.on_run = script
        result = clocks.open_add_edit_dialog()

        self.assertEqual(result, ["Somewhere", "Europe/Rome"])

    def test_dialog_reads_columns_from_its_own_settings_key(self):
        settings = DialogSettings()
        clocks = self.module.ClocksList({"value": []}, "renamed-clocks", settings)

        clocks.open_add_edit_dialog()  # default run() cancels

        self.assertEqual(settings.requested, [("renamed-clocks", "columns")])

    def test_missing_pytz_degrades_to_plain_timezone_entry(self):
        module = load_module(COMMON_PATH, "settings_widgets_common_no_pytz_test", missing_pytz=True)
        clocks = module.ClocksList({
            "value": [{"label": "Rome", "timezone": "Europe/Rome"}]
        }, "worldclocks", object())

        self.assertIsNone(module.pytz)
        self.assertFalse(clocks.timezone_resolver.has_timezone_data)
        # zoneinfo still feeds the suggestions and validates typed entries
        self.assertIn(
            ("Rome (Europe)", "Europe/Rome"), clocks.completions)
        self.assertEqual(clocks.normalize_timezone(" Europe/Rome "), "Europe/Rome")
        self.assertEqual(clocks.normalize_timezone("europe/rome"), "Europe/Rome")
        self.assertEqual(clocks.normalize_timezone("rome"), "Europe/Rome")
        self.assertIsNone(clocks.normalize_timezone("Mars/Olympus"))
        self.assertEqual(
            module.TIMEZONE_TEXT_HINT, "City or timezone (e.g. Buenos Aires)")

    def test_the_typing_hint_sits_in_the_field_not_in_its_label(self):
        # The hint was used as the field's *label*, so the dialog named the field
        # with a sentence while the column heading above it said "Timezone" - two
        # names for one thing. It was also already translated, and the factory
        # translated it again: the second lookup missed and handed it back
        # unchanged, which worked by accident.
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings())
        captured = {}

        def script(dialog):
            captured.update({widget.kwargs["label"]: widget for widget in BaseWidget.instances})
            return 0  # cancel

        GtkDialog.on_run = script
        clocks.open_add_edit_dialog()

        self.assertIn("Timezone", captured, "the column heading names the field")
        entry = captured["Timezone"]
        self.assertEqual(
            entry.content_widget.placeholder,
            "City or timezone (e.g. Buenos Aires)",
            "and the hint about what to type sits inside the empty field")

    def test_with_no_timezone_database_at_all_only_an_identifier_is_accepted(self):
        # neither pytz nor zoneinfo: anything typed used to be handed straight
        # back and saved, so the dialog accepted gibberish and the applet showed
        # an italic "Invalid timezone" row later, with nothing connecting the two
        module = load_module(COMMON_PATH, "settings_widgets_common_no_tzdata_test", missing_pytz=True)
        resolver = module.TimezoneResolver(None, None)

        self.assertFalse(resolver.any_timezone_data())
        self.assertEqual(resolver.normalize("America/Sao_Paulo"), "America/Sao_Paulo")
        self.assertEqual(resolver.normalize("America/Argentina/Buenos_Aires"),
                         "America/Argentina/Buenos_Aires")
        self.assertIsNone(resolver.normalize("gibberish"))
        self.assertIsNone(resolver.normalize("not a zone at all"))
        self.assertIsNone(resolver.normalize("a/b/c/d"))

    def test_the_dialog_says_which_field_is_missing(self):
        # OK is insensitive until both fields are right, and the preview only
        # ever spoke about the timezone: a valid timezone with an empty name gave
        # a happy preview and a dead OK button
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        dialog = GtkDialog()
        preview = GtkLabel()
        presenter = self.module.ClockDialogStatePresenter(clocks, dialog, preview)

        widgets = {
            "label": self.module.list_edit_factory({"title": "Display name"}),
            "timezone": self.module.list_edit_factory({"title": "Timezone"}),
        }
        widgets["timezone"].set_widget_value("Europe/Rome")

        presenter.update(widgets)
        self.assertEqual(preview.text, self.module.LABEL_MISSING_PREVIEW)
        self.assertIn((1, False), dialog.sensitivity)   # Gtk.ResponseType.OK

        widgets["label"].set_widget_value("Rome")
        presenter.update(widgets)
        self.assertEqual(preview.text, self.module.TIMEZONE_PREVIEW_TEMPLATE % "Europe/Rome")
        self.assertIn((1, True), dialog.sensitivity)

    def test_missing_pytz_logs_install_help(self):
        module = load_module(COMMON_PATH, "settings_widgets_common_no_pytz_log_test", missing_pytz=True)

        # Warned when the resolver is built, not at import: importing a module
        # should define things, not emit them. At import time cinnamon-settings
        # has not configured logging yet, so the warning landed on the whole
        # process's stderr or was dropped, depending on import order.
        with self.assertLogs("chronos@geraldo-netto.settings", level="WARNING") as logs:
            module.TimezoneResolver(None, None)

        message = "\n".join(logs.output)
        self.assertIn("python3-pytz is not installed", message)
        self.assertIn("sudo apt install python3-pytz", message)
        self.assertIn("python3 -m pip install pytz", message)


    def test_list_edit_factory_entry_gets_a_completion_when_offered(self):
        widget = self.module.list_edit_factory({
            "title": "City or timezone",
            "completions": [("Rome (Europe)", "Europe/Rome")],
        })

        self.assertIsInstance(widget, Entry)
        self.assertIs(widget.completion, widget.bind_object.completion)
        # the third column is the folded text the match function searches: GTK
        # calls that function for every row on every keystroke, so the folding
        # happens once, here, rather than 600 times per character
        self.assertEqual(
            widget.completion.model.rows,
            [["Rome (Europe)", "Europe/Rome", "rome (europe) europe/rome"]])

    def test_the_suggestion_model_is_shared_by_every_settings_page(self):
        # The memo was keyed by id(completions) and held a strong reference to the
        # list and its ListStore, with no eviction. Every ClocksList builds its own
        # resolver and therefore its own completions list, so the memo never hit
        # across instances: it accumulated one 439-row store per settings page ever
        # opened, for the life of the cinnamon-settings process. A cache that
        # cannot hit is a leak wearing a cache's clothes.
        self.module._COMPLETION_MODELS.clear()

        rome = self.module.timezone_completion_model([("Rome (Europe)", "Europe/Rome")])
        self.assertEqual(rome.rows[0][1], "Europe/Rome")

        # a *different list object* with the same contents — which is what the next
        # settings page builds — reads back the same model
        again = self.module.timezone_completion_model([("Rome (Europe)", "Europe/Rome")])
        self.assertIs(again, rome, "the store is built once for the whole process")
        self.assertEqual(len(self.module._COMPLETION_MODELS), 1)

        # and different suggestions are a different model, not a stranger's
        tokyo = self.module.timezone_completion_model([("Tokyo (Asia)", "Asia/Tokyo")])
        self.assertEqual(tokyo.rows[0][1], "Asia/Tokyo")
        self.assertEqual(len(self.module._COMPLETION_MODELS), 2)

    def test_version_wrappers_export_common_symbols(self):
        wrapper_52 = load_module(APPLET_DIR / "5.4" / "settings_widgets.py", "settings_widgets_52_test")

        # The shim exports the names the schema asks Cinnamon to instantiate —
        # exactly those. create_custom_widget does getattr(module, widget) and
        # dies on the whole settings window if the name is not there, so the
        # schema is what this has to be checked against, not a list written here.
        schema = json.loads((APPLET_DIR / "5.4" / "settings-schema.json").read_text())
        named = sorted({entry["widget"] for entry in schema.values()
                        if isinstance(entry, dict) and entry.get("type") == "custom"})
        self.assertEqual(sorted(wrapper_52.__all__), named)

        for widget in named:
            self.assertEqual(getattr(wrapper_52, widget).__module__,
                             "settings_widgets_common")

        # list_edit_factory was re-exported here and never imported from here
        self.assertFalse(hasattr(wrapper_52, "list_edit_factory"),
                         "the shim is the widgets Cinnamon names, and nothing else")


class BuildDialogContentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module(COMMON_PATH, "settings_widgets_common_builder_test")

    def test_dialog_state_presenter_updates_preview_and_ok_state(self):
        clocks = self.module.ClocksList({
            "value": [{"label": "Rome", "timezone": "Europe/Rome"}]
        }, "worldclocks", DialogSettings())
        dialog = GtkDialog()
        preview = GtkLabel()
        presenter = self.module.ClockDialogStatePresenter(clocks, dialog, preview)

        widgets = {
            "label": types.SimpleNamespace(get_widget_value=lambda: "Home"),
            "timezone": types.SimpleNamespace(get_widget_value=lambda: "Europe/Rome")
        }

        presenter.update(widgets)

        self.assertEqual(preview.text, "Timezone to save: Europe/Rome")
        self.assertEqual(dialog.sensitivity[-1], (1, True))

        widgets["label"] = types.SimpleNamespace(get_widget_value=lambda: "")
        presenter.update(widgets)

        self.assertEqual(dialog.sensitivity[-1], (1, False))

    def test_builder_returns_widgets_and_wires_preview(self):
        clocks = self.module.ClocksList({
            "value": [{"label": "Rome", "timezone": "Europe/Rome"}]
        }, "worldclocks", DialogSettings())
        dialog = GtkDialog()
        data = {"label": "Home", "timezone": "Europe/Rome"}

        widgets = clocks._build_dialog_content(dialog, data)

        self.assertIn("label", widgets)
        self.assertIn("timezone", widgets)
        self.assertEqual(widgets["label"].get_widget_value(), "Home")
        # initial validation pass ran: OK sensitivity was set at least once
        self.assertTrue(dialog.sensitivity)

    def test_collect_dialog_values_resolves_the_typed_timezone(self):
        clocks = self.module.ClocksList({
            "value": [{"label": "Rome", "timezone": "Europe/Rome"}]
        }, "worldclocks", DialogSettings())
        # the resolver is injected, so what the dialog resolves does not depend
        # on whether the machine running the tests happens to have pytz: this
        # assertion used to expect a different answer on a host without it, and
        # therefore asserted almost nothing on either
        fake_pytz = types.SimpleNamespace(
            all_timezones=["Europe/Rome"], common_timezones=["Europe/Rome"])
        clocks.timezone_resolver = self.module.TimezoneResolver(fake_pytz, None)
        dialog = GtkDialog()
        widgets = clocks._build_dialog_content(
            dialog, {"label": "Home", "timezone": "europe/rome"})

        label, timezone = clocks._collect_dialog_values(widgets)
        self.assertEqual(label, "Home")
        self.assertEqual(timezone, "Europe/Rome")

    def test_initial_dialog_data_add_and_edit_paths(self):
        clocks = self.module.ClocksList({
            "value": [{"label": "Rome", "timezone": "Europe/Rome"}]
        }, "worldclocks", DialogSettings())

        data, title = clocks._initial_dialog_data(None)
        self.assertEqual(data, {"label": None, "timezone": None})
        self.assertEqual(title, "Add new entry")

        data, title = clocks._initial_dialog_data(["Home", "Europe/Rome"])
        self.assertEqual(data, {"label": "Home", "timezone": "Europe/Rome"})
        self.assertEqual(title, "Edit entry")

        # an unknown timezone is still shown, so the user can correct it
        data, title = clocks._initial_dialog_data(["X", "Nowhere/Nada"])
        self.assertEqual(data["timezone"], "Nowhere/Nada")


class NonNullableGtkArgumentTest(unittest.TestCase):
    """The settings window did not open at all, and no test here noticed.

    update_button_sensitivity cleared the Add button's tooltip with
    set_tooltip_text(None). That argument is annotated non-nullable, so it raised
    TypeError from inside create_custom_widget and took the whole xlet-settings
    process down before it drew a single widget — every preference in the applet
    unreachable from the UI. The AddButton double accepted None happily, so it
    stood in for an API that does not exist and the suite stayed green.

    The double refuses None now, which catches this exact call. This catches the
    next one: any Gtk setter in the module handed a bare None, in a branch no test
    happens to walk.
    """

    # Gtk string setters whose argument is annotated non-nullable: passing None
    # raises rather than clearing, and "" plus the matching unset call is the way
    # to clear them.
    NON_NULLABLE_SETTERS = [
        "set_tooltip_text",
        "set_tooltip_markup",
        "set_text",
        "set_label",
        "set_placeholder_text",
        "set_title",
    ]

    def test_no_gtk_string_setter_is_handed_none(self):
        source = COMMON_PATH.read_text()

        for setter in self.NON_NULLABLE_SETTERS:
            # the literal call, and the conditional form that hid this one:
            # set_tooltip_text(MESSAGE if full else None)
            for call in re.finditer(
                    rf"\.{setter}\(([^()]*(?:\([^()]*\)[^()]*)*)\)", source):
                argument = call.group(1)
                self.assertNotRegex(
                    argument, r"(^|\s)None(\s|$)",
                    f".{setter}({argument}) — None is not a value this setter "
                    "takes; it raises TypeError and takes the settings window "
                    'down with it. Clear it with "" instead.')
        # the cleared-tooltip behaviour itself is asserted in
        # test_add_button_stops_at_the_clock_limit, against a double that now
        # refuses None the way Gtk does


class GettextIsolationTest(unittest.TestCase):
    def test_the_widget_module_keeps_its_translator_to_itself(self):
        # gettext.install() injects _ into builtins for the whole
        # cinnamon-settings process and can shadow another xlet's translator
        source = COMMON_PATH.read_text()
        self.assertNotIn("gettext.install", source)

        module = load_module(COMMON_PATH, "settings_widgets_common_gettext_test")
        self.assertTrue(callable(module._))
        self.assertEqual(module._("Invalid timezone"), "Invalid timezone")


class FakeWindow:
    def __init__(self, size=(800, 694), workarea=(0, 1080, 3840, 2160), broken=False,
                 toplevel=True):
        self.size = size
        self.workarea = workarea
        self.broken = broken
        self.toplevel = toplevel
        self.moved_to = None

    def is_toplevel(self):
        return self.toplevel

    def get_size(self):
        return self.size

    def get_window(self):
        return object()

    def get_display(self):
        if self.broken:
            # what pygobject raises out of a Gtk call on a display that will
            # not answer; a bare RuntimeError would mean a programming error,
            # which centering must not swallow
            raise GLibError("no display")
        x, y, width, height = self.workarea
        area = types.SimpleNamespace(x=x, y=y, width=width, height=height)
        monitor = types.SimpleNamespace(get_workarea=lambda: area)
        return types.SimpleNamespace(get_monitor_at_window=lambda _window: monitor)

    def move(self, x, y):
        self.moved_to = (x, y)


class CenterWindowTest(unittest.TestCase):
    def setUp(self):
        self.module = load_module(COMMON_PATH, "settings_widgets_common_center")

    def test_window_is_centered_on_its_monitor_workarea(self):
        window = FakeWindow()

        self.assertTrue(self.module.center_window(window))
        # (3840-800)/2 = 1520; the monitor starts 1080px down, (2160-694)/2 = 733
        self.assertEqual(window.moved_to, (1520, 1080 + 733))

    def test_a_window_wider_than_the_workarea_is_not_pushed_off_screen(self):
        window = FakeWindow(size=(5000, 4000), workarea=(0, 0, 1920, 1080))

        self.assertTrue(self.module.center_window(window))
        self.assertEqual(window.moved_to, (0, 0))

    def test_a_display_that_cannot_be_measured_leaves_placement_to_the_wm(self):
        window = FakeWindow(broken=True)

        self.assertFalse(self.module.center_window(window))
        self.assertIsNone(window.moved_to)
        self.assertFalse(self.module.center_window(None))


class CompletionMatchingTest(unittest.TestCase):
    """completion_key / timezone_completion_match / timezone_completion_selected."""

    @classmethod
    def setUpClass(cls):
        cls.module = load_module(COMMON_PATH, "settings_widgets_common_completion")

    def model_with(self, *rows):
        # built by the production builder: the match function searches a folded
        # column the builder computes, so a hand-rolled two-column model would
        # be testing a shape that never exists
        return self.module.timezone_completion_model(list(rows))

    def test_completion_key_folds_case_and_underscores(self):
        key = self.module.completion_key

        # the three spellings a user can type all have to fold onto one shape
        self.assertEqual(key("Buenos_Aires"), "buenos aires")
        self.assertEqual(key("  BUENOS AIRES  "), "buenos aires")
        self.assertEqual(key("buenos aires"), "buenos aires")

    def test_completion_key_returns_empty_for_non_strings(self):
        # Gtk hands the match func whatever is in the entry; a None or a stray
        # non-string must not blow up the completion popup
        key = self.module.completion_key

        for junk in (None, 42, 3.5, b"Rome", ["Rome"], {"tz": "Rome"}, object()):
            with self.subTest(junk=junk):
                self.assertEqual(key(junk), "")

    def test_completion_match_is_a_substring_search_over_label_and_id(self):
        match = self.module.timezone_completion_match
        model = self.model_with(
            ("Buenos Aires (America / Argentina)", "America/Argentina/Buenos_Aires"),
            ("Rome (Europe)", "Europe/Rome"),
        )

        # the city sits at the end of the identifier, so a prefix search misses it
        self.assertTrue(match(None, "buenos", 0, model))
        self.assertTrue(match(None, "BUENOS_AI", 0, model))
        self.assertTrue(match(None, "argentina", 0, model))
        self.assertFalse(match(None, "buenos", 1, model))
        self.assertTrue(match(None, "europe/rome", 1, model))

    def test_completion_match_refuses_an_empty_key(self):
        # an empty or whitespace key would match every row and pop the whole
        # zone list open
        match = self.module.timezone_completion_match
        model = self.model_with(("Rome (Europe)", "Europe/Rome"))

        for key in ("", "   ", "\t", None, 7):
            with self.subTest(key=key):
                self.assertFalse(match(None, key, 0, model))

    def test_completion_selected_writes_the_identifier(self):
        model = self.model_with(
            ("Buenos Aires (America / Argentina)", "America/Argentina/Buenos_Aires"))
        completion = GtkEntryCompletion()
        entry = BindObject()
        entry.set_completion(completion)

        self.assertTrue(self.module.timezone_completion_selected(completion, model, 0))

        # regression: the entry used to receive the pretty label, and a label is
        # not a timezone, so the saved value was unusable
        self.assertEqual(entry.props["text"], "America/Argentina/Buenos_Aires")
        self.assertEqual(entry.position, -1)

    def test_attach_completion_configures_the_entry(self):
        entry = BindObject()

        completion = self.module.attach_timezone_completion(
            entry, [("Rome (Europe)", "Europe/Rome")])

        self.assertIs(entry.completion, completion)
        self.assertEqual(completion.text_column, 0)
        self.assertEqual(completion.minimum_key_length, 2)
        self.assertTrue(completion.popup_completion)
        # inline completion would type the label into the entry
        self.assertFalse(completion.inline_completion)
        self.assertIs(completion.match_func[0], self.module.timezone_completion_match)
        self.assertEqual(completion.matches("rome"), ["Europe/Rome"])

    def test_attach_completion_does_nothing_without_suggestions(self):
        # neither pytz nor zoneinfo: there is nothing to suggest, and an empty
        # completion popup is worse than none
        entry = BindObject()

        for completions in (None, [], ()):
            with self.subTest(completions=completions):
                self.assertIsNone(
                    self.module.attach_timezone_completion(entry, completions))
                self.assertFalse(hasattr(entry, "completion"))


class CenterSettingsWindowTest(unittest.TestCase):
    """SettingsWindowCenterer keeps retrying until the window is parented."""

    @classmethod
    def setUpClass(cls):
        cls.module = load_module(COMMON_PATH, "settings_widgets_common_center_idle")

    def setUp(self):
        GLibStub.idles.clear()

    def test_the_constructor_schedules_the_centering_on_an_idle(self):
        # the World Clocks page lives in a stack and is not mapped until the
        # user opens it, so "map" is no use; an idle runs whichever page shows
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())

        self.assertEqual(
            [callback for callback, args in GLibStub.idles],
            [clocks.window_centerer.center])
        self.assertFalse(clocks.window_centerer.centered)

    def test_an_unparented_widget_asks_for_another_idle(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())

        # the stub JSONSettingsList has no window yet
        self.assertTrue(clocks.window_centerer.center())

        # parented, but to something that is not a toplevel: still not ready
        clocks.get_toplevel = lambda: FakeWindow(toplevel=False)
        self.assertTrue(clocks.window_centerer.center())
        self.assertFalse(clocks.window_centerer.centered)

    def test_the_idle_centers_once_the_window_exists_and_then_stops(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        window = FakeWindow()
        clocks.get_toplevel = lambda: window

        # returning False removes the idle: the window is placed, we are done
        self.assertFalse(clocks.window_centerer.center())
        self.assertTrue(clocks.window_centerer.centered)
        self.assertEqual(window.moved_to, (1520, 1080 + 733))

        # a second pass must not move a window the user may have since dragged
        window.moved_to = None
        self.assertFalse(clocks.window_centerer.center())
        self.assertIsNone(window.moved_to)

    def test_a_window_that_cannot_be_measured_is_left_where_it_is(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        window = FakeWindow(broken=True)
        clocks.get_toplevel = lambda: window

        # The display will not answer. Centering is a nicety: retrying it
        # forever is a busy loop that pins a core for the life of the settings
        # process, so the idle gives up and the window manager places it.
        self.assertFalse(clocks.window_centerer.center())
        self.assertIsNone(window.moved_to)

    def test_waiting_for_the_window_to_be_parented_does_not_wait_forever(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        clocks.get_toplevel = lambda: None

        # not parented yet: the idle asks to be run again...
        self.assertTrue(clocks.window_centerer.center())

        # ...but not indefinitely, or it is a busy loop with no window to show
        # for it
        for _ in range(self.module.MAX_CENTER_ATTEMPTS + 1):
            armed = clocks.window_centerer.center()

        self.assertFalse(armed)


class RegressionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module(COMMON_PATH, "settings_widgets_common_regression")

    @requires_pytz
    def test_a_city_nested_below_its_region_is_findable_by_its_own_name(self):
        # bug: the old region/city split indexed America/Argentina/Buenos_Aires
        # by its first path segment, so the city was buried under a region combo
        # named "A(merica)" and typing "buenos aires" found nothing
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())

        self.assertEqual(
            clocks.normalize_timezone("buenos aires"),
            "America/Argentina/Buenos_Aires")
        self.assertEqual(
            clocks.normalize_timezone("BUENOS_AIRES"),
            "America/Argentina/Buenos_Aires")
        # and it is offered by the city's own name, with the region only as a hint
        self.assertIn(
            ("Buenos Aires (America / Argentina)", "America/Argentina/Buenos_Aires"),
            clocks.completions)

        entry = BindObject()
        completion = self.module.attach_timezone_completion(entry, clocks.completions)
        self.assertIn(
            "America/Argentina/Buenos_Aires", completion.matches("buenos aires"))

    @requires_pytz
    def test_picking_a_suggestion_saves_the_identifier_not_the_label(self):
        # bug: the entry was filled with the suggestion's display label
        # ("Buenos Aires (America / Argentina)"), which is not a timezone, so the
        # applet could not read the saved clock back
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        entry = BindObject()
        completion = self.module.attach_timezone_completion(entry, clocks.completions)

        completion.select(completion.matches_index("America/Argentina/Buenos_Aires"))

        self.assertEqual(entry.props["text"], "America/Argentina/Buenos_Aires")
        self.assertEqual(
            clocks.normalize_timezone(entry.props["text"]),
            "America/Argentina/Buenos_Aires")

    @requires_pytz
    def test_reserved_builtin_clocks_are_still_refused(self):
        # bug: UTC and local time could be added as user clocks, duplicating the
        # two rows the applet always shows itself
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())

        for text in ("UTC", "utc", " Etc/UTC ", "etc/utc", "local", "LOCAL"):
            with self.subTest(text=text):
                values = {"label": "Duplicate", "timezone": text}
                choice = clocks.resolve_timezone_choice(values)

                self.assertTrue(choice["reserved"])
                self.assertIsNone(choice["timezone"])
                self.assertIsNone(clocks.normalize_timezone(text))
                self.assertEqual(
                    clocks.format_timezone_preview(values),
                    "UTC and local time are already shown as built-in clocks")


class FuzzTest(unittest.TestCase):
    """Seeded fuzzing; hypothesis is unavailable on this rig."""

    @classmethod
    def setUpClass(cls):
        cls.module = load_module(COMMON_PATH, "settings_widgets_common_fuzz")

    def setUp(self):
        random.seed(FUZZ_SEED)

    ALPHABET = "abcXYZ 0/_-éü北京\U0001f600'\"\\%\n\t"

    def junk_strings(self, count):
        return [
            "".join(random.choice(self.ALPHABET)
                    for _ in range(random.randint(0, 24)))
            for _ in range(count)
        ]

    def scramble_case(self, text):
        return "".join(
            char.upper() if random.choice([True, False]) else char.lower()
            for char in text)

    def sample_zones(self, count):
        # skip the reserved built-ins: normalize() is meant to refuse those
        zones = [tz for tz in _pytz.common_timezones
                 if tz.lower() not in self.module.RESERVED_TIMEZONES]
        return random.sample(zones, count)

    def test_completion_key_never_throws_on_junk(self):
        key = self.module.completion_key
        junk = self.junk_strings(200) + [
            None, 0, 42, -1.5, True, b"", b"Rome", [], ["Rome"], {}, {"a": 1},
            (), object(), "", "   ", "Ünïcødé", "\U0001f600",
        ]

        for value in junk:
            with self.subTest(value=repr(value)[:40]):
                result = key(value)
                self.assertIsInstance(result, str)
                # underscores and case never decide a match
                self.assertEqual(result, result.lower())
                self.assertNotIn("_", result)

    def test_completion_match_never_throws_on_junk(self):
        match = self.module.timezone_completion_match
        model = self.module.timezone_completion_model([
            ("Rome (Europe)", "Europe/Rome"),
            (None, 42),  # a row is whatever the model holds
        ])

        for key in self.junk_strings(200) + [None, 42, b"x", [], "", "  "]:
            for index in range(len(model.rows)):
                with self.subTest(key=repr(key)[:40], index=index):
                    self.assertIsInstance(match(None, key, index, model), bool)

    @requires_pytz
    def test_completion_match_ignores_case_and_underscores(self):
        match = self.module.timezone_completion_match
        resolver = self.module.TimezoneResolver(_pytz, None)
        model = self.module.timezone_completion_model(resolver.completions)

        for timezone in self.sample_zones(60):
            index = next(i for i, row in enumerate(model.rows) if row[1] == timezone)
            city = timezone.rsplit("/", maxsplit=1)[-1]

            for typed in (city, city.replace("_", " "), self.scramble_case(city),
                          self.scramble_case(city.replace("_", " ")),
                          "  %s  " % city.replace("_", " ")):
                with self.subTest(timezone=timezone, typed=typed):
                    self.assertTrue(match(None, typed, index, model))

    @requires_pytz
    def test_normalize_round_trips_real_zones_through_random_case_and_spacing(self):
        resolver = self.module.TimezoneResolver(_pytz, None)
        padding = ["", " ", "  ", "\t", "\n", " \t "]

        for timezone in self.sample_zones(120):
            noisy = "%s%s%s" % (random.choice(padding),
                                self.scramble_case(timezone),
                                random.choice(padding))
            with self.subTest(timezone=timezone, noisy=noisy):
                self.assertEqual(resolver.normalize(noisy), timezone)

    @requires_pytz
    def test_normalize_round_trips_the_bare_city_name_of_real_zones(self):
        resolver = self.module.TimezoneResolver(_pytz, None)

        for timezone in self.sample_zones(120):
            city = timezone.rsplit("/", maxsplit=1)[-1]
            typed = self.scramble_case(city.replace("_", " "))

            with self.subTest(timezone=timezone, typed=typed):
                resolved = resolver.normalize(typed)
                # a city name shared by two regions (Nicosia) keeps the zone
                # listed first, so only the city itself is guaranteed to match
                self.assertIsNotNone(resolved)
                self.assertEqual(
                    resolved.rsplit("/", maxsplit=1)[-1].lower(), city.lower())

    def test_normalize_refuses_blank_and_whitespace_only_values(self):
        resolver = self.module.TimezoneResolver(None, None)

        for value in ("", "   ", "\t\n", None, 0, False, []):
            with self.subTest(value=repr(value)):
                self.assertIsNone(resolver.normalize(value))

    @requires_pytz
    def test_resolve_timezone_choice_never_throws_on_random_values(self):
        # the timezone field is a Gtk.Entry, so its value is always a string (or
        # None before the widget is filled); those are the shapes fuzzed here.
        # See the report: a non-string timezone raises AttributeError.
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        pool = self.junk_strings(120) + [
            None, "", "   ", "UTC", "local", "Europe/Rome", "buenos aires",
            "Ünïcødé", "\U0001f600", "Etc/UTC",
        ]

        for _iteration in range(200):
            values = {}
            if random.choice([True, False]):
                values["label"] = random.choice(pool)
            if random.choice([True, True, False]):
                values["timezone"] = random.choice(pool)

            with self.subTest(values=repr(values)[:60]):
                choice = clocks.resolve_timezone_choice(values)

                self.assertEqual(
                    sorted(choice),
                    ["reserved", "timezone", "typed_invalid"])
                self.assertIsInstance(choice["typed_invalid"], bool)
                self.assertIsInstance(choice["reserved"], bool)
                if choice["timezone"] is not None:
                    self.assertIsInstance(choice["timezone"], str)
                    self.assertFalse(choice["typed_invalid"])
                # the preview is derived from the choice and must never throw
                self.assertIsInstance(clocks.format_timezone_preview(values), str)


if __name__ == "__main__":
    unittest.main()


class MutationGapTest(unittest.TestCase):
    """Written against surviving mutants: paths the suite ran but never checked."""

    def setUp(self):
        self.module = load_module(COMMON_PATH, "settings_widgets_common_mutation")

    def test_a_window_that_cannot_be_measured_is_left_to_the_window_manager(self):
        # cinnamon-settings hands this widget whatever toplevel it has; something
        # without get_size() is not a window we can place, and reaching for its
        # size anyway would raise inside an idle callback
        self.assertFalse(self.module.center_window(None))
        self.assertFalse(self.module.center_window(object()))
        self.assertFalse(self.module.center_window(types.SimpleNamespace()))

    def test_a_toplevel_that_cannot_say_it_is_one_is_not_treated_as_one(self):
        # get_toplevel() returns the widget itself while it is still unparented,
        # so "no is_toplevel method" must mean "not ready", not "go ahead"
        clocks = self.module.ClocksList({"value": []}, "worldclocks", object())
        # a widget that is not in a window yet answers get_toplevel() with itself,
        # and a plain widget has no is_toplevel at all
        clocks.get_toplevel = lambda: types.SimpleNamespace()

        self.assertTrue(clocks.window_centerer.center(), "unready: come back on the next idle")
        self.assertFalse(clocks.window_centerer.centered)

    def test_separators_divide_the_dialog_rows_but_never_lead_it(self):
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings())
        dialog = GtkDialog()

        clocks._build_dialog_content(dialog, {"label": None, "timezone": None})

        # content = [label row, separator, timezone row, separator, preview]: a
        # leading separator would draw a line above the first field
        frame = dialog.content_area.children[0]
        content = frame.children[0]
        kinds = ["separator" if isinstance(child, GtkStub) and not hasattr(child, "text")
                 and child.kwargs.get("orientation") == 2 else "row"
                 for child in content.children]
        self.assertEqual(kinds[0], "row", "the first row stands on its own")
        self.assertEqual(kinds.count("separator"), 2)



class LazySettingsPageTest(unittest.TestCase):
    """Opening the settings must not pay for a page the user has not opened."""

    def setUp(self):
        self.module = load_module(COMMON_PATH, "settings_widgets_lazy_test")

    def test_the_timezone_map_is_not_built_until_the_page_needs_it(self):
        built = []
        original = self.module.TimezoneResolver

        class CountingResolver(original):
            def __init__(self, *args, **kwargs):
                built.append(True)
                super().__init__(*args, **kwargs)

        self.module.TimezoneResolver = CountingResolver
        try:
            clocks = self.module.ClocksList({"value": []}, "worldclocks", object())

            # The settings dialog has several pages, and this is one widget on one
            # of them. Constructing it used to build a 594-entry timezone map, a
            # city map and a 439-entry completions list — and casefold-sort the
            # last of them — on the GTK main thread, whether or not the user ever
            # looked at the World Clocks page.
            self.assertEqual(built, [], "nothing is built until something asks")

            # ...and the first thing that asks gets it, once
            self.assertTrue(clocks.completions)
            self.assertEqual(len(built), 1)
            clocks.normalize_timezone("europe/rome")
            self.assertEqual(len(built), 1, "and it is built once, not per lookup")
        finally:
            self.module.TimezoneResolver = original


class DialogSizingTest(unittest.TestCase):
    """A modal sized to its content is as wide as its widest unwrapped line."""

    def setUp(self):
        self.module = load_module(COMMON_PATH, "settings_widgets_wrap_test")

    def test_the_dialog_labels_wrap_instead_of_widening_the_window(self):
        clocks = self.module.ClocksList({
            "value": [{"label": "Rome", "timezone": "Europe/Rome"}]
        }, "worldclocks", DialogSettings())
        # no timezone database: the dialog carries the 140-character hint that
        # says what to install
        clocks.timezone_resolver = self.module.TimezoneResolver(None, None)

        dialog = GtkDialog()
        GtkLabel.instances.clear()
        clocks._build_dialog_content(dialog, {"label": "Home", "timezone": ""})

        labels = [w for w in GtkLabel.instances if w.text]
        hint = next(w for w in labels if "python3-pytz" in w.text)

        self.assertGreater(len(hint.text), 100,
                           "the hint is a sentence, not a word")
        self.assertTrue(hint.line_wrap,
                        "an unwrapped 140-character label runs the modal off a 1366px screen")
        self.assertGreater(hint.max_width_chars, 0,
                           "and a wrap with no width to wrap against does nothing")

        preview = next(w for w in labels if w is not hint)
        self.assertTrue(preview.line_wrap,
                        "the preview carries whole sentences too")


class DialogValidationFeedbackTest(unittest.TestCase):
    """A validation message nobody can hear is not validation feedback."""

    def setUp(self):
        self.module = load_module(COMMON_PATH, "settings_widgets_a11y_test")
        BaseWidget.instances.clear()

    def _dialog(self, data):
        clocks = self.module.ClocksList({
            "value": [{"label": "Rome", "timezone": "Europe/Rome"}]
        }, "worldclocks", DialogSettings())
        fake_pytz = types.SimpleNamespace(
            all_timezones=["Europe/Rome"], common_timezones=["Europe/Rome"])
        clocks.timezone_resolver = self.module.TimezoneResolver(fake_pytz, None)

        dialog = GtkDialog()
        widgets = clocks._build_dialog_content(dialog, data)
        return dialog, widgets

    def test_an_invalid_timezone_is_announced_and_shown(self):
        # The only feedback was a text swap on a plain label with no ATK relation
        # to either entry, no error role, and no colour: a screen-reader user
        # typing an invalid zone heard nothing, and found out only that the OK
        # button would not activate — with no announcement of which field was
        # wrong.
        dialog, widgets = self._dialog({"label": "Home", "timezone": "Not A Zone"})

        self.assertFalse(dialog.sensitivity[-1][1], "OK stays dead")

        entry = widgets["timezone"].bind_object
        self.assertEqual(entry.get_accessible().description, "Invalid timezone",
                         "the field says what is wrong with it")
        self.assertIn("error", entry.get_style_context().classes,
                      "and it is marked, not merely described")

        described_by = entry.get_accessible().relationships
        self.assertTrue(described_by,
                        "the message is tied to the field it is about")

    def test_a_missing_label_points_at_the_label_field(self):
        # a valid timezone and an empty name showed a perfectly happy preview and
        # a dead OK button, with nothing saying which field was the problem
        dialog, widgets = self._dialog({"label": "", "timezone": "Europe/Rome"})

        self.assertFalse(dialog.sensitivity[-1][1])
        self.assertIn("error", widgets["label"].bind_object.get_style_context().classes)
        self.assertNotIn(
            "error", widgets["timezone"].bind_object.get_style_context().classes,
            "the timezone is fine; do not mark it")

    def test_a_valid_clock_clears_every_mark(self):
        dialog, widgets = self._dialog({"label": "Home", "timezone": "Europe/Rome"})

        self.assertTrue(dialog.sensitivity[-1][1], "OK is live")
        for field in ("label", "timezone"):
            self.assertNotIn(
                "error", widgets[field].bind_object.get_style_context().classes)


class WeatherLocationCompletionTest(unittest.TestCase):
    """The weather location suggests cities, and suggests them from disk.

    The field used to be a bare entry: the user typed a name, saved, and learned
    from a warning marker on the panel — after a network round trip — that the
    geocoder had matched nothing. The suggestions come from the timezone database
    the world clocks already load, so no keystroke reaches the geocoder.
    """

    @classmethod
    def setUpClass(cls):
        cls.module = load_module(COMMON_PATH, "settings_widgets_common_weather")

    def entry(self, values=None):
        settings = FakeSettings(values or {"weather-location": ""})
        widget = self.module.WeatherLocationEntry(
            {"description": "Weather location", "tooltip": "a city"},
            "weather-location", settings)
        return widget, settings

    def test_city_names_are_cities_and_not_zones(self):
        resolver = self.module.TimezoneResolver(None, lambda: {
            "Europe/Lisbon", "America/Argentina/Buenos_Aires", "Etc/UTC", "UTC",
        })

        names = resolver.city_names()

        self.assertIn("Lisbon", names)
        # the region half of the world-clock label is noise on a geocoder field
        self.assertIn("Buenos Aires", names)
        for junk in ("UTC", "Etc/UTC", "Lisbon (Europe)"):
            self.assertNotIn(junk, names, "%s names no city" % junk)

    def test_city_names_are_sorted_case_insensitively(self):
        resolver = self.module.TimezoneResolver(None, lambda: {
            "Europe/Rome", "America/Anchorage", "Asia/Tokyo",
        })

        self.assertEqual(resolver.city_names(), ["Anchorage", "Rome", "Tokyo"])

    def test_the_entry_completes_on_a_typed_city(self):
        widget, _settings = self.entry()
        completion = widget.completion

        self.assertEqual(completion.text_column, 0)
        # two characters: one would pop the whole list on the first keystroke
        self.assertEqual(completion.minimum_key_length, 2)
        # the suggestion is the value, so completing it inline saves a keystroke
        self.assertTrue(completion.inline_completion)
        self.assertIs(widget.content_widget.completion, completion)
        self.assertEqual(widget.content_widget.placeholder,
                         self.module.WEATHER_LOCATION_HINT)

    def test_a_typed_fragment_matches_a_city_anywhere_in_the_name(self):
        model = self.module.city_completion_model(["Buenos Aires", "Rome"])
        match = self.module.plain_completion_match

        # substring, not prefix: people type the distinctive half of a name
        self.assertTrue(match(None, "aires", 0, model))
        self.assertTrue(match(None, "BUENOS", 0, model))
        self.assertFalse(match(None, "aires", 1, model))
        # an empty needle matches nothing rather than everything
        self.assertFalse(match(None, "", 0, model))

    def test_the_city_store_is_built_once_per_process(self):
        first = self.module.city_completion_model(["Rome"])
        again = self.module.city_completion_model(["Rome"])

        self.assertIs(again, first, "the store is built once for the whole process")

        other = self.module.city_completion_model(["Tokyo"])
        self.assertIsNot(other, first)

    def test_no_timezone_database_means_no_completion_and_a_usable_field(self):
        # the entry still takes any name the user types; the suggestions are a
        # shortcut, not a whitelist, so losing them must not lose the field
        self.assertIsNone(self.module.attach_city_completion(BindObject(), []))

    def test_the_cities_are_built_once_and_reused(self):
        self.module._WEATHER_CITIES = None

        cities = self.module.weather_cities()
        self.assertIs(self.module.weather_cities(), cities,
                      "the timezone database is read on the first field, not on every page")

    def test_the_field_saves_what_the_user_typed(self):
        widget, settings = self.entry({"weather-location": "Lisbon"})

        # the entry is bound to the key, so what it holds is what the applet reads
        self.assertEqual(settings.bound[0], "weather-location")
        self.assertIs(settings.bound[1], widget.content_widget)
        self.assertEqual(widget.content_widget.get_property("text"), "Lisbon")


class CountryComboBoxTest(unittest.TestCase):
    """The holiday country can be typed into, and only a real country saves.

    ~100 countries in a dropdown with no type-ahead meant scrolling to Zimbabwe.
    """

    OPTIONS = {
        "None (disable holidays)": "none",
        "Brazil": "bra",
        "Portugal": "prt",
        "United Kingdom": "gbr",
    }

    @classmethod
    def setUpClass(cls):
        cls.module = load_module(COMMON_PATH, "settings_widgets_common_country")

    def combo(self, value="none"):
        settings = FakeSettings({"country": value})
        widget = self.module.CountryComboBox(
            {"description": "Country", "tooltip": "holidays", "options": self.OPTIONS},
            "country", settings)
        return widget, settings

    def row_of(self, widget, value):
        return widget.option_map[value]

    def test_the_off_switch_stays_at_the_top(self):
        # schema order, not alphabetical: sorting buries "None" among the C's
        self.assertEqual(
            self.module.country_options(self.OPTIONS)[0], ("none", "None (disable holidays)"))

    def test_the_current_country_is_the_row_that_opens_selected(self):
        widget, _settings = self.combo("bra")

        self.assertEqual(widget.value, "bra")
        self.assertEqual(widget.content_widget.get_active_iter(), self.row_of(widget, "bra"))
        self.assertEqual(widget.entry.get_property("text"), "Brazil")

    def test_picking_a_suggestion_saves_that_country(self):
        widget, settings = self.combo("none")

        widget.completion.select(self.row_of(widget, "prt"))

        self.assertEqual(settings.values["country"], "prt")
        self.assertEqual(widget.entry.get_property("text"), "Portugal")

    def test_typing_half_a_country_name_saves_nothing(self):
        widget, settings = self.combo("bra")

        # a holiday lookup fires on every write of this key: half a name is not
        # a choice, and must not reach the settings file
        widget.content_widget.type_text("Portu")

        self.assertEqual(settings.writes, [])
        self.assertEqual(widget.value, "bra")

    def test_text_that_names_no_country_is_put_back_when_focus_leaves(self):
        widget, settings = self.combo("bra")
        widget.content_widget.type_text("Atlantis")

        kept_open = widget.on_entry_focus_out()

        # the field cannot sit there showing a country the applet is not using
        self.assertEqual(widget.entry.get_property("text"), "Brazil")
        self.assertFalse(kept_open, "the focus change carries on")
        self.assertEqual(settings.writes, [])

    def test_a_country_the_schema_does_not_list_selects_nothing(self):
        # a settings file written by an older version, or by hand
        widget, _settings = self.combo("atlantis")

        self.assertIsNone(widget.content_widget.get_active_iter())
        widget.restore_entry_text()
        self.assertEqual(widget.entry.get_property("text"), "",
                         "an unknown country names no row, so the field is empty")

    def test_choosing_the_country_that_is_already_set_writes_nothing(self):
        widget, settings = self.combo("bra")

        widget.completion.select(self.row_of(widget, "bra"))

        self.assertEqual(settings.writes, [],
                         "re-picking the same country must not fire a holiday lookup")

    def test_a_country_changed_elsewhere_moves_the_widget(self):
        widget, settings = self.combo("none")

        # another page, or the applet itself, writes the key
        settings.values["country"] = "gbr"
        widget.on_setting_changed()

        self.assertEqual(widget.entry.get_property("text"), "United Kingdom")

    def test_the_completion_matches_any_part_of_a_country_name(self):
        widget, _settings = self.combo()
        match, model = widget.completion.match_func

        self.assertTrue(match(widget.completion, "kingdom", self.row_of(widget, "gbr"), model))
        self.assertTrue(match(widget.completion, "BRA", self.row_of(widget, "bra"), model))
        self.assertFalse(match(widget.completion, "kingdom", self.row_of(widget, "bra"), model))
        # one character is enough here: the list is short and the names are long
        self.assertEqual(widget.completion.minimum_key_length, 1)
