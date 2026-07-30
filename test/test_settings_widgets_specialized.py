from helpers.settings_widgets_fixture import (
    APPLET_DIR, WEATHER_PATH, HOLIDAYS_PATH, FIXED_LOCAL_TIMEZONE, BindObject, FakeSettings,
    Path, importlib, json, load_module,
    tearDownModule as teardown_fixture, unittest,
)


def tearDownModule():
    teardown_fixture()

class WeatherLocationCompletionTest(unittest.TestCase):
    """The weather location suggests cities, and suggests them from disk.

    The field used to be a bare entry: the user typed a name, saved, and learned
    from a warning marker on the panel — after a network round trip — that the
    geocoder had matched nothing. The suggestions come from the timezone database
    the world clocks already load, so no keystroke reaches the geocoder.
    """

    @classmethod
    def setUpClass(cls):
        cls.module = load_module(WEATHER_PATH, "settings_widgets_weather_completion")

    def entry(self, values=None):
        settings = FakeSettings(values or {"weather-location": ""})
        widget = self.module.WeatherLocationEntry(
            {"description": "Weather location", "tooltip": "a city"},
            "weather-location", settings)
        return widget, settings

    def test_city_names_are_cities_and_not_zones(self):
        resolver = self.module.common.TimezoneResolver(None, lambda: {
            "Europe/Lisbon", "America/Argentina/Buenos_Aires", "Etc/UTC", "UTC",
        })

        names = resolver.city_names()

        self.assertIn("Lisbon", names)
        # the region half of the world-clock label is noise on a geocoder field
        self.assertIn("Buenos Aires", names)
        for junk in ("UTC", "Etc/UTC", "Lisbon (Europe)"):
            self.assertNotIn(junk, names, "%s names no city" % junk)

    def test_city_names_are_sorted_case_insensitively(self):
        resolver = self.module.common.TimezoneResolver(None, lambda: {
            "Europe/Rome", "America/Anchorage", "Asia/Tokyo",
        })

        self.assertEqual(resolver.city_names(), ["Anchorage", "Rome", "Tokyo"])

    def test_the_entry_completes_on_a_typed_city(self):
        self.module.common._TIMEZONE_RESOLVER = None
        self.module._WEATHER_CITIES = None
        widget, _settings = self.entry()

        self.assertIsNone(widget.completion)
        self.assertIsNone(self.module.common._TIMEZONE_RESOLVER,
                          "building the settings page must not index every timezone")
        self.assertFalse(widget.ensure_completion())
        completion = widget.completion

        self.assertEqual(completion.text_column, 0)
        # two characters: one would pop the whole list on the first keystroke
        self.assertEqual(completion.minimum_key_length, 2)
        # the suggestion is the value, so completing it inline saves a keystroke
        self.assertTrue(completion.inline_completion)
        self.assertIs(widget.content_widget.completion, completion)
        self.assertEqual(widget.content_widget.placeholder,
                         self.module.WEATHER_LOCATION_HINT)
        self.assertFalse(widget.ensure_completion(), "a second focus does no work")

    def test_a_typed_fragment_matches_a_city_anywhere_in_the_name(self):
        model = self.module.city_completion_model(["Buenos Aires", "Rome"])
        match = self.module.common.plain_completion_match

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
        self.module.common._TIMEZONE_RESOLVER = None
        self.module._WEATHER_CITIES = None

        cities = self.module.weather_cities()
        self.assertIs(self.module.weather_cities(), cities,
                      "the timezone database is read on the first field, not on every page")
        resolver = self.module.common.shared_timezone_resolver()
        clocks = self.module.common.ClocksList({"value": []}, "worldclocks", object())
        self.assertIs(clocks.timezone_resolver, resolver,
                      "weather and clocks must share one timezone index")

    def test_the_field_shows_the_saved_location(self):
        widget, _settings = self.entry({"weather-location": "Lisbon"})

        self.assertEqual(widget.content_widget.get_text(), "Lisbon")

    def test_the_field_and_runtime_share_one_location_limit(self):
        widget, _settings = self.entry({"weather-location": "Lisbon"})
        maximum = self.module.MAX_WEATHER_LOCATION_LENGTH
        runtime_source = (APPLET_DIR / "weatherFormat.js").read_text()

        self.assertEqual(widget.content_widget.max_length, maximum)
        self.assertRegex(
            runtime_source,
            r"var MAX_WEATHER_LOCATION_LENGTH = %d;" % maximum)

    def test_exact_and_over_limit_locations_are_distinguished_before_trimming(self):
        widget, settings = self.entry({"weather-location": "Lisbon"})
        settings.writes.clear()
        maximum = self.module.MAX_WEATHER_LOCATION_LENGTH
        exact = "x" * maximum

        self.assertEqual(widget.commit(exact), exact)
        self.assertEqual(settings.values["weather-location"], exact)
        self.assertEqual(widget.commit("y" * (maximum + 1)), "")
        self.assertEqual(widget.commit(" " + exact), "",
                         "whitespace must not hide an over-limit raw value")
        self.assertEqual(settings.writes, [("weather-location", exact)])

    def test_the_location_limit_counts_unicode_characters(self):
        widget, settings = self.entry({"weather-location": "Lisbon"})
        settings.writes.clear()
        maximum = self.module.MAX_WEATHER_LOCATION_LENGTH
        exact = "🎉" * maximum

        self.assertEqual(widget.commit(exact), exact)
        self.assertEqual(widget.commit(exact + "🎉"), "")
        self.assertEqual(settings.writes, [("weather-location", exact)])

    def test_an_over_limit_hand_edited_value_is_not_shown_in_the_widget(self):
        maximum = self.module.MAX_WEATHER_LOCATION_LENGTH
        hand_edited = "z" * (maximum + 1)
        widget, settings = self.entry({"weather-location": hand_edited})

        self.assertEqual(widget.content_widget.get_text(), "")
        self.assertEqual(settings.values["weather-location"], hand_edited,
                         "opening settings does not silently rewrite the file")
        self.assertEqual(settings.writes, [])

    def test_typing_writes_nothing_until_the_edit_is_finished(self):
        widget, settings = self.entry({"weather-location": "Lisbon"})

        # every write of this key reaches the applet and geocodes what it finds
        # 750ms later. "Gen" is not a place, and Open-Meteo matching nothing sends
        # the fragment on to Nominatim, whose policy is one request a second.
        for fragment in ("G", "Ge", "Gen", "Geno", "Genoa"):
            widget.content_widget.set_text(fragment)
            widget.content_widget.emit_changed()

        self.assertEqual(settings.writes, [], "a half-typed name is not a location")

        # leaving the field ends the edit, and that is the one write
        widget.on_commit()
        self.assertEqual(settings.writes, [("weather-location", "Genoa")])

    def test_picking_a_suggestion_saves_it_at_once(self):
        widget, settings = self.entry({"weather-location": ""})
        settings.writes.clear()
        widget.ensure_completion()

        widget.completion.select(widget.completion.matches_index_for("Lisbon"))

        self.assertEqual(settings.values["weather-location"], "Lisbon")
        self.assertEqual(widget.content_widget.get_text(), "Lisbon")

    def test_committing_the_same_location_writes_nothing(self):
        widget, settings = self.entry({"weather-location": "Lisbon"})
        settings.writes.clear()

        # focus leaves the field and nothing was edited: a write here would
        # refetch the same place for nothing
        widget.on_commit()
        widget.content_widget.set_text("  Lisbon  ")
        widget.on_commit()

        self.assertEqual(settings.writes, [])

    def test_clearing_the_location_is_saved_once(self):
        widget, settings = self.entry({"weather-location": "Lisbon"})
        settings.writes.clear()

        self.assertEqual(widget.commit(None), "")
        self.assertEqual(settings.writes, [("weather-location", "")])

        self.assertEqual(widget.commit(None), "")
        self.assertEqual(settings.writes, [("weather-location", "")],
                         "an already-empty value is not written again")

    def test_closing_the_window_mid_edit_still_saves_the_name(self):
        widget, settings = self.entry({"weather-location": "Lisbon"})
        settings.writes.clear()

        # the user types a name and closes the settings window with the cursor
        # still in the field: focus-out never fires, and the edit would be lost
        widget.content_widget.set_text("Genoa")
        handlers = dict(widget.content_widget.handlers)
        self.assertIn("destroy", handlers, "the field commits when it is torn down")
        handlers["destroy"](widget.content_widget)

        self.assertEqual(settings.values["weather-location"], "Genoa")

    def test_a_location_changed_elsewhere_shows_up_in_the_field(self):
        widget, settings = self.entry({"weather-location": "Lisbon"})

        settings.set_value("weather-location", "Porto")

        self.assertEqual(widget.content_widget.get_text(), "Porto")


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
        cls.module = load_module(HOLIDAYS_PATH, "settings_widgets_holidays_country")

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


class WeatherLocationPrefillTest(unittest.TestCase):
    """An empty weather location fills itself from the machine's own timezone.

    The location is the one setting the applet can answer for itself: /etc/localtime
    already names a city. Nothing is asked of the network to find out where the
    user is — no IP reaches a geolocation service — and the answer is written into
    the field rather than resolved behind the user's back, because a timezone names
    its region's reference city: a user in Genoa is told "Rome", and has to be able
    to see that and correct it.
    """

    @classmethod
    def setUpClass(cls):
        cls.module = load_module(WEATHER_PATH, "settings_widgets_weather_prefill")

    def entry(self, saved="", local_zone="Europe/Rome"):
        def fixed_zone():
            return local_zone
        # local_city_name and TimezoneResolver live in the gi-free sibling and
        # read its copy of local_timezone_name; reach it through the imported
        # function's globals so the prefill sees this zone, not the machine's own
        self.module.local_city_name.__globals__["local_timezone_name"] = fixed_zone
        settings = FakeSettings({"weather-location": saved})
        widget = self.module.WeatherLocationEntry(
            {"description": "Weather location"}, "weather-location", settings)
        return widget, settings

    def test_the_city_comes_out_of_the_timezone(self):
        city = self.module.local_city_name

        self.assertEqual(city("Europe/Rome"), "Rome")
        self.assertEqual(city("America/Argentina/Buenos_Aires"), "Buenos Aires")
        # a zone that names no place: UTC, an offset-only zone, the Etc/ block,
        # and a /etc/localtime that is not a zoneinfo symlink at all
        for nowhere in ("UTC", "+02", "Etc/UTC", ""):
            self.assertEqual(city(nowhere), "", "%r names no city" % (nowhere,))

        # no argument at all reads the machine's own zone, which is the whole point
        self.assertEqual(city(), "Rome")

    def test_local_city_name_matches_the_js_timezone_city_name(self):
        # the shared parity fixture the JS worldclocks suite also asserts against:
        # local_city_name and worldclockData.timezoneCityName write the same
        # weather-location key, so they must agree on every case
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "timezone_city_cases.json").read_text())
        city = self.module.local_city_name
        for case in fixture["cases"]:
            self.assertEqual(city(case["timezone"]), case["city"],
                             "%r must be %r" % (case["timezone"], case["city"]))

    def test_an_empty_field_is_filled_from_the_timezone(self):
        widget, settings = self.entry(saved="")

        self.assertEqual(settings.values["weather-location"], "Rome")
        self.assertEqual(widget.content_widget.get_property("text"), "Rome",
                         "the user reads the place the weather will be fetched for")

    def test_a_location_the_user_chose_is_never_overwritten(self):
        widget, settings = self.entry(saved="Genoa")

        self.assertEqual(settings.values["weather-location"], "Genoa")
        self.assertEqual(settings.writes, [], "nothing was written over it")
        self.assertEqual(widget.prefill_from_timezone(), "")

    def test_a_machine_whose_timezone_names_no_city_is_left_alone(self):
        _widget, settings = self.entry(saved="", local_zone="UTC")

        # the panel already says "Set a weather location"; guessing is worse
        self.assertEqual(settings.values["weather-location"], "")
        self.assertEqual(settings.writes, [])


class TimezoneDataStandsAloneTest(unittest.TestCase):
    """timezone_data.py is the gi-free half of the feature — no Gtk/Atk/GLib and
    no widgets. It has to import and answer with none of them present, which is
    the whole reason the split exists: the timezone logic can be exercised
    without a settings-dialog environment.
    """

    def load_gi_free(self):
        # deliberately no install_stubs(): timezone_data reaches for nothing in
        # gi.repository, so it execs against the bare standard library. A future
        # edit that imports gi here would make this raise instead.
        spec = importlib.util.spec_from_file_location(
            "timezone_data_standalone", APPLET_DIR / "timezone_data.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_the_source_reaches_for_no_gtk_atk_or_glib(self):
        source = (APPLET_DIR / "timezone_data.py").read_text()
        for forbidden in ("import gi", "gi.repository", "from xapp", "JsonSettingsWidgets"):
            self.assertNotIn(forbidden, source,
                             "timezone_data must stay free of the widget toolkit: %r" % forbidden)

    def test_it_resolves_and_folds_without_the_toolkit(self):
        module = self.load_gi_free()

        # neither pytz nor zoneinfo: the resolver still checks IANA shape. A
        # fixed local zone keeps the built-in set off the machine's own, so
        # "Europe/Rome" is not reserved wherever this runs.
        resolver = module.TimezoneResolver(None, None, local_timezone=FIXED_LOCAL_TIMEZONE)
        self.assertFalse(resolver.any_timezone_data())
        self.assertEqual(resolver.normalize("Europe/Rome"), "Europe/Rome")
        self.assertIsNone(resolver.normalize("not a zone"))

        self.assertEqual(module.completion_key("Buenos_Aires"), "buenos aires")
        self.assertEqual(module.local_city_name("Europe/Rome"), "Rome")
        self.assertEqual(module.local_city_name("Etc/UTC"), "")
        self.assertTrue(module.looks_like_iana("America/Sao_Paulo"))
        # the non-string guard: junk off a settings file is not an identifier
        self.assertFalse(module.looks_like_iana(None))
        self.assertIn("utc", module.RESERVED_TIMEZONES)

    def test_builtin_rules_match_the_js_clock_selector(self):
        module = self.load_gi_free()
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "timezone_builtin_cases.json").read_text())
        resolver = module.TimezoneResolver(
            None, None, local_timezone=fixture["local_timezone"])

        self.assertEqual(
            sorted(resolver.builtin_timezones), fixture["builtin_identities"])
        self.assertEqual(
            sorted(module.RESERVED_TIMEZONES),
            sorted(value.lower() for value in fixture["reserved_inputs"]))
        for timezone in fixture["reserved_inputs"]:
            self.assertTrue(resolver.is_reserved(timezone), timezone)
        self.assertFalse(resolver.is_reserved(fixture["ordinary_timezone"]))
