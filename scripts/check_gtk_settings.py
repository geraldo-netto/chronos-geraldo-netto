#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

"""Check native GTK settings boundaries with an in-memory backend and private X."""

import builtins
from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_cinnamon_imports import private_environment, run_session, verify_isolation


ROOT = Path(__file__).resolve().parents[1]
APPLET = ROOT / "files/chronos@geraldo-netto"


class MemorySettings:
    def __init__(self, schema, key, value):
        self.schema = schema
        self.values = {key: deepcopy(value)}
        self.listeners = {}
        self.writes = []

    def get_value(self, key):
        return self.values[key]

    def set_value(self, key, value):
        self.values[key] = value
        self.writes.append((key, deepcopy(value)))
        for callback in self.listeners.get(key, []):
            callback(key, value)

    def listen(self, key, callback):
        self.listeners.setdefault(key, []).append(callback)

    def has_property(self, key, name):
        return name in self.schema[key]

    def get_property(self, key, name):
        return self.schema[key][name]


def load_widgets():
    # Only called after the child has verified its private display and profile.
    sys.path[:0] = ["/usr/share/cinnamon/cinnamon-settings",
                    "/usr/share/cinnamon/cinnamon-settings/bin", str(APPLET)]
    builtins._ = lambda text: text
    import gi
    gi.require_version("Gtk", "3.0")
    from chronos_settings_widgets_weather import WeatherLocationEntry
    from chronos_settings_widgets_holidays import CountryComboBox
    from chronos_settings_widgets_worldclocks import ClocksList
    return WeatherLocationEntry, CountryComboBox, ClocksList


def check_weather(widget_type, schema, case):
    from gi.repository import Gdk
    key, raw = "weather-location", case["input"]
    settings = MemorySettings(schema, key, raw)
    widget = widget_type(schema[key], key, settings)
    try:
        assert widget.content_widget.get_text() == (raw if case["valid"] else "")
        assert settings.get_value(key) == raw and not settings.writes
        settings.set_value(key, "Plzeň")
        settings.set_value(key, raw)
        before = deepcopy(settings.writes)
        widget.content_widget.emit("activate")
        widget.content_widget.emit("focus-out-event", Gdk.Event.new(Gdk.EventType.FOCUS_CHANGE))
        assert settings.get_value(key) == raw and settings.writes == before
        description = widget.content_widget.get_accessible().get_description()
        description.encode("utf-8")
        if not case["valid"]:
            assert case.get("refusal", "invalid Unicode") in description
        widget.content_widget.set_text("Genoa 🏙")
        widget.content_widget.emit("activate")
        assert settings.get_value(key) == "Genoa 🏙"
    finally:
        widget.destroy()


def check_country(widget_type, schema, case):
    key, raw = "country", case["input"]
    settings = MemorySettings(schema, key, raw)
    widget = widget_type(schema[key], key, settings)
    try:
        message = widget.entry.get_accessible().get_description()
        assert case["diagnostic"] in message
        message.encode("utf-8")
        assert settings.get_value(key) == raw and not settings.writes
        settings.set_value(key, "ita")
        settings.set_value(key, raw)
        widget.entry.get_accessible().get_description().encode("utf-8")
        assert settings.get_value(key) == raw
    finally:
        widget.destroy()


def check_clocks(widget_type, schema, fixture):
    key = "worldclocks"
    settings = MemorySettings(schema, key, fixture["savedClocks"])
    widget = widget_type(schema[key], key, settings)
    try:
        assert settings.get_value(key) == fixture["selectedClocks"]
        settings.set_value(key, deepcopy(fixture["savedClocks"]))
        widget.on_setting_changed()
        assert settings.get_value(key) == fixture["selectedClocks"]
    finally:
        widget.destroy()


def run_isolated(directory):
    verify_isolation(directory)
    weather, country, clocks = load_widgets()
    schema = json.loads((APPLET / "6.0/settings-schema.json").read_text())
    fixture = json.loads((ROOT / "test/fixtures/settings_unicode_cases.json").read_text())
    checks = 0
    for case in fixture["text"]:
        check_weather(weather, schema, case)
        checks += 1
        if not case["valid"]:
            check_country(country, schema, case)
            checks += 1
    check_clocks(clocks, schema, fixture)
    for case in fixture["weatherNul"]:
        check_weather(weather, schema, case)
        checks += 1
    print(json.dumps({"checks": checks + 1, "failures": []}), flush=True)
    return 0


def main():
    missing = [name for name in ("dbus-run-session", "xvfb-run") if shutil.which(name) is None]
    if missing:
        print("Missing native-check tools: " + ", ".join(missing), file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory(prefix="chronos-native-settings-") as temporary:
        directory = Path(temporary)
        environment = private_environment(directory)
        environment.update(G_DEBUG="fatal-criticals", TZ="Antarctica/Troll", LC_ALL="C.UTF-8")
        try:
            status = run_session(directory, environment, Path(__file__).resolve())
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            status = 1
        diagnostic = (directory / "session.log").read_text(errors="replace")
        if diagnostic:
            print(diagnostic[-8000:], file=sys.stderr)
        return int(bool(status or diagnostic))


if __name__ == "__main__":
    raise SystemExit(main())
