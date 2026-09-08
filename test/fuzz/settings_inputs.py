#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

"""Deterministic settings input audit; stdin config and stdout report are JSON.

Each case exercises a boundary corpus and seeded JSON-shaped inputs against the
production modules. GTK is replaced by the ordinary settings test fixture; UTF-8
encoding checks enforce the native text boundary without a display. No desktop
settings, plugin directories, network services, or timezone database are used.
"""

from copy import deepcopy
from datetime import date
import json
from pathlib import Path
import random
import re
import sys


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
TEXT_BOUNDARIES = (
    "\ud800", "\udfff", "A\ud800B", "\U0001f600", "Genova", "Plzeň", "波士顿",
    None, False, True, 0, -1, 1.5, [], {}, ["Genova"], {"text": "Genova"},
    "", " \ufeff ", "A\x00B\nC\u202eD", "\U0001f600" * 64,
    *("a" * size for size in (63, 64, 65, 127, 128, 129, 255, 256, 257, 4096)),
)
REMOVED_CONTROLS = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]")
LEFT_CLOCK = {"label": "Auckland", "timezone": "Pacific/Auckland"}
RIGHT_CLOCK = {"label": "São Paulo", "timezone": "America/Sao_Paulo"}


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class Audit:
    def __init__(self, seed):
        self.seed = seed
        self.checks = 0
        self.failure_count = 0
        self.failures = {}

    def check(self, target, case, value, operation):
        self.checks += 1
        witness = deepcopy(value)
        try:
            operation(value)
        except Exception as error:  # An unexpected exception is a failed input, never a skip.
            self.failure_count += 1
            self.failures.setdefault(target, {
                "target": target, "seed": self.seed, "case": case, "input": witness,
                "message": f"{type(error).__name__}: {error}",
            })

    def report(self):
        return {"checks": self.checks, "failures": list(self.failures.values()),
                "failureCount": self.failure_count}


def load_targets():
    sys.path.insert(0, str(ROOT / "test"))
    from helpers import settings_widgets_fixture as fixture

    path = fixture.APPLET_DIR / "chronos_calendar_plugin_data.py"
    manifests = fixture.load_gi_free_module(path, "fuzz_calendar_data")
    clocks = fixture.load_module(fixture.WORLDCLOCKS_PATH, "fuzz_clocks", missing_pytz=True)
    weather = fixture.load_module(fixture.WEATHER_PATH, "fuzz_weather", missing_pytz=True)
    countries = fixture.load_module(fixture.HOLIDAYS_PATH, "fuzz_countries", missing_pytz=True)
    # The fixture pins timezone identity; avoid emitting the deliberately absent
    # optional-database warning when constructing fake country widgets.
    countries.common.report_startup_diagnostics = lambda: None
    return fixture, manifests, clocks, weather, countries


def base_manifest():
    return {"apiVersion": 1, "id": "example.community", "name": "Community",
            "category": "civic", "coverage": {"from": 1, "through": 9999},
            "source": {"name": "Community records", "url": "https://example.test/"},
            "events": [{"name": "Leap day", "month": 2, "day": 29}]}


def valid_manifest(rng, case):
    manifest = base_manifest()
    year = (1, 9999, 1900, 2000, 2024)[case % 5]
    if case >= 5:
        year = rng.randint(1, 9999)
    manifest["coverage"] = {"from": year, "through": min(9999, year + rng.randrange(6))}
    manifest["name"] = rng.choice(("Genova", "Plzeň", " Boston ", "\U0001f600" * 50, "a" * 100))
    manifest["category"] = "a" * rng.choice((1, 63, 64))
    manifest["source"]["name"] = "a" * rng.choice((1, 159, 160))
    manifest["source"]["url"] = rng.choice(("https://example.test/", "https://example.test:0/",
                                              "https://example.test:65535/"))
    if case == 1:
        manifest["events"] *= 4096
    elif case % 3 == 0:
        manifest["events"] = []
    else:
        ordinal = rng.randint(date(year, 1, 1).toordinal(), date(year, 12, 31).toordinal())
        occurrence = date.fromordinal(ordinal)
        manifest["events"].append({"name": "a" * 160, "year": year,
                                   "month": occurrence.month, "day": occurrence.day,
                                   "nonWorking": bool(rng.randrange(2))})
    if case == 2:
        prefix = "https://example.test/"
        manifest["source"]["url"] = prefix + "x" * (2048 - len(prefix))
    return manifest


def invalid_manifest_cases():
    fields = {
        "apiVersion": [None, False, True, 0, 2, "1", [], {}],
        "id": [None, 1, "", "plain", "../outside", "a.constructor", "a.prototype", "a." + "x" * 95],
        "name": [None, [], "", "a" * 101, "\U0001f600" * 51, "A\x00B", "\ud800"],
        "category": [None, {}, "", "a" * 65],
        "coverage": [None, [], {}, {"from": 2028, "through": 2027}],
        "coverage.from": [None, False, True, 0, -1, 10000, 1.5, "2028", [], {}],
        "coverage.through": [None, False, 0, 10000, "9999"],
        "source": [None, [], {}, {"name": "Source", "extra": True}],
        "source.name": [None, False, "", "a" * 161, "A\u202eB", "\udfff"],
        "source.url": [None, "", "http://example.test", "https://u:p@example.test",
                       "https://example.test/" + "x" * 2048, "https://example.test/\ud800",
                       "https://example.test:65536/", "https://example.test:99999/"],
        "events": [None, {}, [None], [[]], [{}]],
        "events.0.name": [None, True, "", "a" * 161, "\ud800"],
        "events.0.month": [None, False, True, 0, -1, 13, 1.5, "2", [], {}],
        "events.0.day": [None, False, 0, -1, 30, 32, 1.5, "29", [], {}],
        "events.0.year": [None, False, 0, 10000, 2023, "2024"],
        "events.0.nonWorking": [None, 0, 1, "false", [], {}],
        "unexpected": [True], "source.tradition": ["a" * 161],
        "source.location": ["\ud800"], "events.0.unexpected": [True],
    }
    corpus = [(field, value) for field, values in fields.items() for value in values]
    return corpus + [("", value) for value in (None, False, 1, "calendar", [], [{}])]


def replace_field(raw, field, value):
    result = deepcopy(raw)
    parts = field.split(".")
    cursor = result
    for part in parts[:-1]:
        cursor = cursor[int(part)] if isinstance(cursor, list) else cursor[part]
    cursor[parts[-1]] = deepcopy(value)
    return result


def invalid_manifest(rng, case, corpus):
    if case == len(corpus):
        raw = base_manifest()
        raw["events"] *= 4097
        return raw
    field, value = corpus[case] if case < len(corpus) else rng.choice(corpus)
    if not field:
        return deepcopy(value)
    return replace_field(base_manifest(), field, value)


def check_valid_manifest(module, raw):
    before = deepcopy(raw)
    normalized = module.validate_manifest(raw)
    require(raw == before, "validation changed the caller's input")
    require(module.validate_manifest(normalized) == normalized, "validation is not idempotent")
    json.dumps(normalized, ensure_ascii=False).encode("utf-8")
    first, last = normalized["coverage"]["from"], normalized["coverage"]["through"]
    require(module.available(normalized, first), "declared first year is unavailable")
    require(module.available(normalized, last), "declared last year is unavailable")
    require(not module.available(normalized, first - 1), "year before coverage is available")
    require(not module.available(normalized, last + 1), "year after coverage is available")


def check_invalid_manifest(module, raw):
    before = deepcopy(raw)
    try:
        module.validate_manifest(raw)
    except ValueError as error:
        require(bool(str(error)), "validation error has no explanation")
        require(raw == before, "refusing an invalid manifest changed the input")
        return
    raise AssertionError("invalid manifest was accepted")


def json_value(rng, depth=0):
    if depth >= 3:
        return deepcopy(rng.choice(TEXT_BOUNDARIES[:19]))
    factories = (
        lambda: deepcopy(rng.choice(TEXT_BOUNDARIES)),
        lambda: rng.randint(-10001, 10001),
        lambda: [json_value(rng, depth + 1) for _ in range(rng.randrange(5))],
        lambda: {key: json_value(rng, depth + 1) for key in rng.sample(
            ["label", "timezone", "enabled", "name", "country", "region"], rng.randrange(4))},
        lambda: "".join(rng.choices("abZé\U0001f600\ud800\udfff\x00\n\u202e ", k=rng.randrange(258))),
    )
    return rng.choice(factories)()


def ui_text(text, maximum):
    require(isinstance(text, str), "UI text is not a string")
    require(len(text) <= maximum, f"UI text exceeds {maximum} characters")
    text.encode("utf-8")


def check_label(module, value):
    require(module.normalize_clock_label("Genova") == "Genova", "valid clock label was lost")
    normalized = module.normalize_clock_label(value)
    ui_text(normalized, 128)
    require(REMOVED_CONTROLS.search(normalized) is None, "clock label retains a display control")
    require(module.normalize_clock_label(normalized) == normalized, "clock label is not idempotent")
    if not isinstance(value, str):
        require(normalized == "", "non-text label was coerced into display text")


def check_weather(module, value):
    require(module.normalize_weather_location("Genova") == "Genova", "valid weather location was lost")
    normalized = module.normalize_weather_location(value)
    ui_text(normalized, 256)
    require("\0" not in normalized, "weather location retains a NUL that GTK truncates")
    require(module.normalize_weather_location(normalized) == normalized, "weather text is not idempotent")
    if not isinstance(value, str):
        require(normalized == "", "non-text location was coerced into display text")
    elif len(value) > 256:
        require(normalized == "", "oversized weather location was accepted")


def clock_candidate(value, case):
    choices = (value, {"label": value, "timezone": "Europe/Paris"},
               {"label": "Paris", "timezone": value})
    return choices[case % len(choices)]


def check_clock_rows(module, rows):
    before = deepcopy(rows)
    normalized = module.normalize_saved_clocks(rows)
    require(rows == before, "clock normalization changed the caller's input")
    require(isinstance(normalized, list) and len(normalized) <= 8, "clock list exceeds eight rows")
    require(module.normalize_saved_clocks(normalized) == normalized, "clock rows are not idempotent")
    for row in normalized:
        ui_text(row["label"], 128)
        ui_text(row["timezone"], 64)


def check_clock_neighbors(module, candidate):
    rows = [deepcopy(LEFT_CLOCK), candidate, deepcopy(RIGHT_CLOCK)]
    normalized = module.normalize_saved_clocks(rows)
    require(LEFT_CLOCK in normalized, "input discarded the valid preceding clock")
    require(RIGHT_CLOCK in normalized, "input discarded the valid following clock")


def check_clock_bounds(module, count):
    rows = [None] * count + [deepcopy(LEFT_CLOCK)]
    expected = [LEFT_CLOCK] if count < 64 else []
    require(module.normalize_saved_clocks(rows) == expected, "64-row input scan bound is incorrect")
    rows = [{"label": f"Clock {index}", "timezone": f"Audit/Zone{index}"} for index in range(count)]
    require(module.normalize_saved_clocks(rows) == rows[:8], "eight-clock output bound is incorrect")


def check_country(fixture, module, value, external=False):
    settings = fixture.FakeSettings({"country": "bra" if external else value})
    widget = module.CountryComboBox({"description": "Country", "default": "",
                                    "options": {"None": "none", "Brazil": "bra"}},
                                   "country", settings)
    if external:
        settings.set_value("country", value)
    widget.entry.get_text().encode("utf-8")
    (widget.entry.get_accessible().description or "").encode("utf-8")
    if not isinstance(value, str):
        require(settings.values["country"] == "", "malformed country did not recover to the default")
    settings.set_value("country", "bra")
    require(widget.entry.get_text() == "Brazil", "valid update after a refused country was lost")


def run_case(audit, modules, rng, case, corpus):
    fixture, manifests, clocks, weather, countries = modules
    value = deepcopy(TEXT_BOUNDARIES[case]) if case < len(TEXT_BOUNDARIES) else json_value(rng)
    candidate = clock_candidate(value, case)
    name = "Genova" + "é" * rng.randrange(20)
    offset = rng.randrange(len(name) + 1)
    nul_location = name[:offset] + "\0" + name[offset:]
    checks = (
        ("manifest.valid", valid_manifest(rng, case), lambda raw: check_valid_manifest(manifests, raw)),
        ("manifest.invalid", invalid_manifest(rng, case, corpus), lambda raw: check_invalid_manifest(manifests, raw)),
        ("clock.label", value, lambda raw: check_label(clocks, raw)),
        ("weather.location", value, lambda raw: check_weather(weather, raw)),
        ("weather.nul-location", nul_location, lambda raw: check_weather(weather, raw)),
        ("clock.rows", [candidate], lambda raw: check_clock_rows(clocks, raw)),
        ("clock.neighbors", candidate, lambda raw: check_clock_neighbors(clocks, raw)),
        ("clock.bounds", (0, 1, 7, 8, 9, 63, 64, 65)[case % 8], lambda raw: check_clock_bounds(clocks, raw)),
        ("country.initial", value, lambda raw: check_country(fixture, countries, raw)),
        ("country.external", value, lambda raw: check_country(fixture, countries, raw, external=True)),
    )
    for target, raw, operation in checks:
        audit.check(target, case, raw, operation)


def read_config():
    raw = sys.stdin.read(4097)
    require(len(raw) <= 4096, "configuration exceeds 4096 characters")
    config = json.loads(raw)
    require(type(config) is dict and set(config) == {"seed", "cases"}, "expected only seed and cases")
    require(type(config["seed"]) is int and 0 <= config["seed"] <= 0xffffffff, "seed must be uint32")
    require(type(config["cases"]) is int and 1 <= config["cases"] <= 10000, "cases must be 1..10000")
    return config


def main():
    audit = Audit(None)
    modules = None
    try:
        config = read_config()
        audit.seed = config["seed"]
        modules = load_targets()
        rng = random.Random(config["seed"])
        corpus = invalid_manifest_cases()
        for case in range(config["cases"]):
            run_case(audit, modules, rng, case, corpus)
    except Exception as error:
        message = f"{type(error).__name__}: {error}"
        audit.check("settings.harness", None, None, lambda _raw: require(False, message))
    finally:
        if modules is not None:
            modules[0].tearDownModule()
    print(json.dumps(audit.report(), ensure_ascii=True, separators=(",", ":")))
    return int(audit.failure_count > 0)


if __name__ == "__main__":
    sys.exit(main())
