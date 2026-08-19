import gettext
from unittest import mock

from helpers.settings_widgets_fixture import (
    COMMON_PATH, WEATHER_PATH, HOLIDAYS_PATH, WORLDCLOCKS_PATH, FUZZ_SEED, RESERVED_TIMEZONES, BaseWidget, BindObject,
    DialogSettings, GLibError, GLibStub, GtkDialog, GtkEntryCompletion, GtkLabel,
    GtkStub, _pytz, load_module, random, re, requires_pytz,
    tearDownModule as teardown_fixture, types, unittest,
)


def tearDownModule():
    teardown_fixture()

class BuildDialogContentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module(WORLDCLOCKS_PATH, "settings_widgets_common_builder_test")

    def test_dialog_state_presenter_updates_preview_and_ok_state(self):
        clocks = self.module.ClocksList({
            "value": []
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

        widgets["label"] = types.SimpleNamespace(get_widget_value=lambda: " \t ")
        presenter.update(widgets)

        self.assertEqual(preview.text, self.module.LABEL_MISSING_PREVIEW)
        self.assertEqual(dialog.sensitivity[-1], (1, False))

    def test_one_keystroke_resolves_the_timezone_once(self):
        """T812: update() computed the choice, discarded it and called
        format_timezone_preview, which resolved the same text again. Each
        resolve_timezone_choice ran is_reserved twice - once directly, once
        inside normalize() - and is_reserved re-reads the OS zone before
        deciding, deliberately, so that is an os.readlink of /etc/localtime.
        Four of them and six _resolve() calls for one unchanged value, per
        character, on the GTK main thread - and both entries are connected to
        the same handler, so typing in the *Display name* field ran the whole
        timezone pipeline too. The two resolves could also observe different
        local zones, leaving the OK button and the preview disagreeing."""
        clocks = self.module.ClocksList({
            "value": [{"label": "Rome", "timezone": "Europe/Rome"}]
        }, "worldclocks", DialogSettings())
        presenter = self.module.ClockDialogStatePresenter(
            clocks, GtkDialog(), GtkLabel())
        resolver = clocks.timezone_resolver
        reads = []
        original = resolver.refresh_builtin_timezones

        def counted():
            reads.append(True)
            original()

        resolver.refresh_builtin_timezones = counted
        widgets = {
            "label": types.SimpleNamespace(get_widget_value=lambda: "Home"),
            "timezone": types.SimpleNamespace(get_widget_value=lambda: "Europe/Rome")
        }

        presenter.update(widgets)

        self.assertEqual(len(reads), 1,
                         "one keystroke asks the operating system once")

        # ...and typing in the display name costs the same one, not four
        reads.clear()
        widgets["label"] = types.SimpleNamespace(get_widget_value=lambda: "Hom")
        presenter.update(widgets)
        self.assertEqual(len(reads), 1)

    def test_classify_answers_both_questions_from_one_resolve(self):
        # normalize() no longer takes the caller's is_reserved() answer: one
        # classify() pass gives the flag and the identifier together, so the two
        # cannot be computed from separate readings of the OS zone
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings())
        resolver = clocks.timezone_resolver

        self.assertEqual(resolver.classify(" europe/rome "), (False, "Europe/Rome"))
        self.assertEqual(resolver.classify("local"), (True, None))
        self.assertEqual(resolver.classify("UTC"), (True, None))
        self.assertEqual(resolver.classify("Not A Timezone"), (False, None))
        self.assertEqual(resolver.classify("   "), (False, None))
        self.assertEqual(resolver.classify(None), (False, None))

        self.assertIsNone(resolver.normalize("local"))
        self.assertIsNone(resolver.normalize("UTC"))
        self.assertEqual(resolver.normalize("europe/rome"), "Europe/Rome")

    def test_an_untouched_dialog_is_not_marked_invalid(self):
        # T732: build_content ends by validating with both entries still empty,
        # and the empty case fell through to _report(..., invalid="timezone").
        # So Add opened with the untouched Timezone entry and the preview drawn
        # in the theme's error colour and a generic "Invalid timezone" ATK
        # description on the entry, while the equally empty Display name was
        # left clean — the user and a screen reader were told they had entered
        # something wrong before entering anything.
        clocks = self.module.ClocksList({"value": []}, "worldclocks", DialogSettings())
        dialog = GtkDialog()
        preview = GtkLabel()
        presenter = self.module.ClockDialogStatePresenter(clocks, dialog, preview)
        entries = {
            "label": BindObject(),
            "timezone": BindObject()
        }

        def widgets_for(label, timezone):
            return {
                "label": types.SimpleNamespace(
                    get_widget_value=lambda: label, bind_object=entries["label"],
                    set_tooltip_text=lambda text: None),
                "timezone": types.SimpleNamespace(
                    get_widget_value=lambda: timezone, bind_object=entries["timezone"],
                    set_tooltip_text=lambda text: None)
            }

        presenter.update(widgets_for(None, None))
        self.assertEqual(preview.text, self.module.TIMEZONE_EMPTY_PREVIEW)
        self.assertNotIn("error", preview.get_style_context().classes)
        self.assertEqual(dialog.sensitivity[-1], (1, False),
            "OK is still held closed; it just does not accuse anyone")

        # text that resolves to nothing *is* wrong, and still says so
        presenter.update(widgets_for("Home", "Nowhere/Atlantis"))
        self.assertEqual(preview.text, self.module.TIMEZONE_INVALID_PREVIEW)
        self.assertIn("error", preview.get_style_context().classes)

        # and clearing the field again takes the accusation back
        presenter.update(widgets_for("Home", ""))
        self.assertEqual(preview.text, self.module.TIMEZONE_EMPTY_PREVIEW)
        self.assertNotIn("error", preview.get_style_context().classes)

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
        # the resolver is injected, so what the dialog resolves does not depend
        # on whether the machine running the tests happens to have pytz: this
        # assertion used to expect a different answer on a host without it, and
        # therefore asserted almost nothing on either
        fake_pytz = types.SimpleNamespace(
            all_timezones=["Europe/Rome"], common_timezones=["Europe/Rome"])
        clocks = self.module.ClocksList(
            {"value": []}, "worldclocks", DialogSettings(),
            self.module.common.TimezoneResolver(fake_pytz, None))
        dialog = GtkDialog()
        widgets = clocks._build_dialog_content(
            dialog, {"label": " Home ", "timezone": "europe/rome"})

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
        source = "\n".join(module_path.read_text() for module_path in (
            COMMON_PATH, WEATHER_PATH, HOLIDAYS_PATH, WORLDCLOCKS_PATH))

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
        for module_path in (
                COMMON_PATH, WEATHER_PATH, HOLIDAYS_PATH, WORLDCLOCKS_PATH):
            self.assertNotIn("gettext.install", module_path.read_text())

        module = load_module(WORLDCLOCKS_PATH, "settings_widgets_common_gettext_test")
        self.assertTrue(callable(module._))
        self.assertEqual(module._("Invalid timezone"), "Invalid timezone")

    def test_the_first_installed_gnu_catalog_is_used(self):
        class Translation(gettext.GNUTranslations):
            def __init__(self): # NOSONAR [S1186] -- deliberate test seam
                pass

            def gettext(self, message):
                return "translated: " + message

        with mock.patch.object(gettext, "translation", return_value=Translation()):
            module = load_module(
                WORLDCLOCKS_PATH, "settings_widgets_common_gnu_translation_test")

        self.assertEqual(module._("Invalid timezone"),
                         "translated: Invalid timezone")

    def test_missing_catalogs_use_gettext_fallback(self):
        with mock.patch.object(
                gettext, "translation",
                return_value=gettext.NullTranslations()):
            module = load_module(
                WORLDCLOCKS_PATH, "settings_widgets_common_null_translation_test")

        self.assertEqual(module._("Invalid timezone"), "Invalid timezone")

    def test_a_corrupt_user_catalog_falls_through_to_the_system_catalog(self):
        class Translation(gettext.GNUTranslations):
            def __init__(self): # NOSONAR [S1186] -- deliberate test seam
                pass

            def gettext(self, message):
                return "system: " + message

        with self.assertLogs("chronos@geraldo-netto.settings", level="WARNING") as logs:
            with mock.patch.object(
                    gettext, "translation",
                    side_effect=[OSError("Bad magic number"), Translation()]):
                module = load_module(
                    WORLDCLOCKS_PATH, "settings_widgets_common_corrupt_user_catalog_test")

        self.assertEqual(module._("Invalid timezone"), "system: Invalid timezone")
        self.assertEqual(len(logs.output), 1)
        self.assertIn(".local/share/locale", logs.output[0])
        self.assertNotIn("Bad magic number", logs.output[0])

    def test_corrupt_catalogs_fall_back_to_source_text(self):
        with self.assertLogs("chronos@geraldo-netto.settings", level="WARNING") as logs:
            with mock.patch.object(
                    gettext, "translation", side_effect=OSError("Bad magic number")):
                module = load_module(
                    WORLDCLOCKS_PATH, "settings_widgets_common_corrupt_catalogs_test")

        self.assertEqual(module._("Invalid timezone"), "Invalid timezone")
        self.assertEqual(len(logs.output), 2)
        self.assertIn(".local/share/locale", logs.output[0])
        self.assertIn("/usr/share/locale", logs.output[1])

    def test_non_catalog_translation_failures_still_propagate(self):
        with mock.patch.object(
                gettext, "translation", side_effect=RuntimeError("programming error")):
            with self.assertRaisesRegex(RuntimeError, "programming error"):
                load_module(
                    WORLDCLOCKS_PATH, "settings_widgets_common_translation_bug_test")


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
        self.module = load_module(WORLDCLOCKS_PATH, "settings_widgets_common_center")

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
    """completion_key / the shared matcher / timezone_completion_selected."""

    @classmethod
    def setUpClass(cls):
        cls.module = load_module(WORLDCLOCKS_PATH, "settings_widgets_common_completion")

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
        match = self.module.common.plain_completion_match
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
        match = self.module.common.plain_completion_match
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
        self.assertIs(completion.match_func[0], self.module.common.plain_completion_match)
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
        cls.module = load_module(WORLDCLOCKS_PATH, "settings_widgets_common_center_idle")

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
        cls.module = load_module(WORLDCLOCKS_PATH, "settings_widgets_common_regression")

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
        cls.module = load_module(WORLDCLOCKS_PATH, "settings_widgets_common_fuzz")

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
                 if tz.lower() not in RESERVED_TIMEZONES]
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
        match = self.module.common.plain_completion_match
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
        match = self.module.common.plain_completion_match
        resolver = self.module.common.TimezoneResolver(_pytz, None)
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
        resolver = self.module.common.TimezoneResolver(_pytz, None)
        padding = ["", " ", "  ", "\t", "\n", " \t "]

        for timezone in self.sample_zones(120):
            noisy = "%s%s%s" % (random.choice(padding),
                                self.scramble_case(timezone),
                                random.choice(padding))
            with self.subTest(timezone=timezone, noisy=noisy):
                self.assertEqual(resolver.normalize(noisy), timezone)

    @requires_pytz
    def test_normalize_round_trips_the_bare_city_name_of_real_zones(self):
        resolver = self.module.common.TimezoneResolver(_pytz, None)

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
        resolver = self.module.common.TimezoneResolver(None, None)

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
                    ["duplicate", "reserved", "timezone", "typed_invalid"])
                self.assertIsInstance(choice["typed_invalid"], bool)
                self.assertIsInstance(choice["reserved"], bool)
                self.assertIsInstance(choice["duplicate"], bool)
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
        self.module = load_module(WORLDCLOCKS_PATH, "settings_widgets_common_mutation")

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
        self.module = load_module(WORLDCLOCKS_PATH, "settings_widgets_lazy_test")

    def test_the_timezone_map_is_not_built_until_the_page_needs_it(self):
        built = []
        original = self.module.common.TimezoneResolver

        class CountingResolver(original):
            def __init__(self, *args, **kwargs):
                built.append(True)
                super().__init__(*args, **kwargs)

        self.module.common.TimezoneResolver = CountingResolver
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
            self.module.common.TimezoneResolver = original


class DialogSizingTest(unittest.TestCase):
    """A modal sized to its content is as wide as its widest unwrapped line."""

    def setUp(self):
        self.module = load_module(WORLDCLOCKS_PATH, "settings_widgets_wrap_test")

    def test_the_dialog_labels_wrap_instead_of_widening_the_window(self):
        # no timezone database: the dialog carries the 140-character hint that
        # says what to install
        clocks = self.module.ClocksList(
            {"value": [{"label": "Rome", "timezone": "Europe/Rome"}]},
            "worldclocks", DialogSettings(),
            self.module.common.TimezoneResolver(None, None))

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
        self.module = load_module(WORLDCLOCKS_PATH, "settings_widgets_a11y_test")
        BaseWidget.instances.clear()

    def _dialog(self, data):
        fake_pytz = types.SimpleNamespace(
            all_timezones=["Europe/Rome"], common_timezones=["Europe/Rome"])
        clocks = self.module.ClocksList(
            {"value": []}, "worldclocks", DialogSettings(),
            self.module.common.TimezoneResolver(fake_pytz, None))

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
        # the label field says the real reason, not the generic "Invalid
        # timezone" that set_invalid writes and describe_widget must overwrite
        self.assertEqual(
            widgets["label"].bind_object.get_accessible().description,
            "Enter a display name for this clock",
            "a screen reader hears the real problem with the field")

    def test_the_message_follows_the_field_it_is_about(self):
        # T835: describe_widget was called for the offending field alone, and
        # nothing ever removed a relation. Fix the timezone and leave the name
        # empty and the timezone entry still pointed at a preview label that had
        # moved on to explaining the name field, so a screen reader on the
        # timezone announced the other field's problem.
        _dialog, widgets = self._dialog({"label": "Home", "timezone": "Not A Zone"})
        timezone = widgets["timezone"].bind_object.get_accessible()
        self.assertTrue(timezone.relationships, "the timezone is the problem")

        # the user fixes the zone and clears the name
        widgets["timezone"].set_widget_value("Europe/Rome")
        widgets["label"].set_widget_value("")
        widgets["timezone"].bind_object.emit_changed()

        self.assertFalse(timezone.relationships,
                         "the timezone is no longer what the preview is about")
        self.assertEqual(timezone.description, "",
                         "and it says nothing rather than the wrong thing")
        self.assertTrue(widgets["label"].bind_object.get_accessible().relationships,
                        "the name field is")

    def test_typing_does_not_stack_the_same_relation(self):
        # add_relationship appends to the relation's target list, and update()
        # runs on every keystroke: an invalid zone grew one duplicate target per
        # character typed.
        _dialog, widgets = self._dialog({"label": "Home", "timezone": "Nope"})
        entry = widgets["timezone"].bind_object

        for text in ("Nope1", "Nope12", "Nope123"):
            widgets["timezone"].set_widget_value(text)
            entry.emit_changed()

        self.assertEqual(len(entry.get_accessible().relationships), 1)

    def test_a_valid_clock_clears_every_mark(self):
        dialog, widgets = self._dialog({"label": "Home", "timezone": "Europe/Rome"})

        self.assertTrue(dialog.sensitivity[-1][1], "OK is live")
        for field in ("label", "timezone"):
            self.assertNotIn(
                "error", widgets[field].bind_object.get_style_context().classes)
