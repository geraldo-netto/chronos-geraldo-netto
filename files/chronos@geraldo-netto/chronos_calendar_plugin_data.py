#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

"""Local calendar manifests shared by the settings picker and import flow."""

from __future__ import annotations

from datetime import date
import heapq
import json
import os
from pathlib import Path
import re
import stat
import tempfile

from chronos_text import trim_text


MAX_FILE_BYTES = 1024 * 1024
MAX_PLUGINS = 32
MAX_EVENTS = 4096
MANIFEST_FIELDS = {"apiVersion", "id", "name", "category", "coverage", "source", "events"}
SOURCE_FIELDS = {"name", "url", "tradition", "location"}
EVENT_FIELDS = {"name", "month", "day", "year", "nonWorking"}
CONTROL_TEXT = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]")
CALENDAR_ID = re.compile(r"[a-z][a-z0-9]*(?:[.:-][a-z0-9]+(?:-[a-z0-9]+)*)+")
SOURCE_URL = re.compile(
    r"(?ai:https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?(?:[/?#][^\s\ufeff\\]*)?",
)


def _require(condition, field, expectation):
    if not condition:
        raise ValueError(f"Calendar plugin {field}: {expectation}")


def _fields(value, allowed, field):
    _require(type(value) is dict, field, "expected an object")
    _require(set(value) <= allowed, field, "unexpected field")
    return value


def _text(value, field, maximum):
    _require(isinstance(value, str), field, "expected text")
    try:
        size = len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError as error:
        raise ValueError(f"Calendar plugin {field}: invalid Unicode") from error
    _require(size <= maximum and bool(trim_text(value)), field, "invalid text length")
    _require(CONTROL_TEXT.search(value) is None, field, "control characters are not allowed")
    return trim_text(value)


def calendar_id(value):
    identifier = _text(value, "id", 96)
    _require(CALENDAR_ID.fullmatch(identifier) is not None, "id", "expected a lowercase namespaced identifier")
    parts = re.split(r"[.:-]", identifier)
    _require(not {"constructor", "prototype"}.intersection(parts), "id", "reserved identifier")
    return identifier


def _integer(value):
    return type(value) is int or (type(value) is float and value.is_integer())


def _year(value, field):
    _require(_integer(value) and 1 <= value <= 9999, field, "expected an integer year from 1 through 9999")
    return int(value)


def _coverage(raw):
    _fields(raw, {"from", "through"}, "coverage")
    start = _year(raw.get("from"), "coverage.from")
    end = _year(raw.get("through"), "coverage.through")
    _require(start <= end, "coverage", "from must not be later than through")
    return {"from": start, "through": end}


def _source(raw):
    _fields(raw, SOURCE_FIELDS, "source")
    source = {"name": _text(raw.get("name"), "source.name", 160)}
    for key in ("tradition", "location"):
        if key in raw:
            source[key] = _text(raw[key], f"source.{key}", 160)
    if "url" in raw:
        source["url"] = _text(raw["url"], "source.url", 2048)
        match = SOURCE_URL.fullmatch(source["url"])
        _require(match is not None, "source.url", "expected an HTTPS source URL without credentials")
        _require(match.group(1) is None or int(match.group(1)) <= 65535,
                 "source.url", "expected a port from 0 through 65535")
    return source


def _event_date(raw, event):
    month, day = raw.get("month"), raw.get("day")
    _require(_integer(month) and _integer(day), "event date", "expected integer month and day")
    try:
        date(event.get("year", 2000), int(month), int(day))
    except (ValueError, OverflowError) as error:
        raise ValueError("Calendar plugin event date: expected a real Gregorian date") from error
    event.update(month=int(month), day=int(day))


def _event(raw, coverage):
    _fields(raw, EVENT_FIELDS, "event")
    event = {"name": _text(raw.get("name"), "event.name", 160)}
    if "year" in raw:
        event["year"] = _year(raw["year"], "event.year")
        _require(coverage["from"] <= event["year"] <= coverage["through"], "event.year", "outside declared coverage")
    _event_date(raw, event)
    if "nonWorking" in raw:
        _require(type(raw["nonWorking"]) is bool, "event.nonWorking", "expected a boolean")
        event["nonWorking"] = raw["nonWorking"]
    return event


def validate_manifest(raw):
    _fields(raw, MANIFEST_FIELDS, "manifest")
    _require(type(raw.get("apiVersion")) in (int, float) and raw["apiVersion"] == 1,
             "apiVersion", "unsupported version; expected 1")
    coverage = _coverage(raw.get("coverage"))
    events = raw.get("events")
    _require(type(events) is list and len(events) <= MAX_EVENTS, "events", "expected an array with at most 4096 events")
    return {
        "apiVersion": 1,
        "id": calendar_id(raw.get("id")),
        "name": _text(raw.get("name"), "name", 100),
        "category": _text(raw.get("category"), "category", 64),
        "coverage": coverage,
        "source": _source(raw.get("source")),
        "events": [_event(event, coverage) for event in events],
    }


def available(manifest, year):
    return _integer(year) and manifest["coverage"]["from"] <= year <= manifest["coverage"]["through"]


def plugin_directory():
    configured = Path(os.environ.get("XDG_DATA_HOME", ""))
    data_home = configured if configured.is_absolute() else Path.home() / ".local" / "share"
    return data_home / "chronos@geraldo-netto" / "calendars"


def _reject_constant(_value):
    raise ValueError("Calendar plugin: non-JSON numeric value")


def _read_json(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        _require(stat.S_ISREG(info.st_mode), "file", "expected a regular file")
        _require(info.st_size <= MAX_FILE_BYTES, "file", "larger than 1 MiB")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            contents = source.read(MAX_FILE_BYTES + 1)
    finally:
        os.close(descriptor)
    _require(len(contents) <= MAX_FILE_BYTES, "file", "larger than 1 MiB")
    try:
        return json.loads(contents.decode("utf-8"), parse_constant=_reject_constant)
    except RecursionError as error:
        raise ValueError("Calendar plugin file: JSON nesting is too deep") from error


def read_manifest(path):
    return validate_manifest(_read_json(path))


def discover_plugins(directory=None):
    directory = Path(directory) if directory is not None else plugin_directory()
    if not directory.exists():
        return [], []
    _require(not directory.is_symlink(), "directory", "symbolic links are not supported")
    paths = heapq.nsmallest(MAX_PLUGINS + 1, directory.glob("*.json"))
    errors = ["Only the first 32 installed calendar files are loaded."] if len(paths) > MAX_PLUGINS else []
    found = []
    for path in paths[:MAX_PLUGINS]:
        manifest = None
        try:
            manifest = read_manifest(path)
            _require(path.name == manifest["id"] + ".json", "file", "filename must match the calendar ID")
        except (OSError, ValueError, UnicodeError) as error:
            manifest = None
            errors.append(str(error))
        found.append({"manifest": manifest, "path": path})
    return found, errors


def import_plugin(source_path, directory=None):
    manifest = read_manifest(source_path)
    directory = Path(directory) if directory is not None else plugin_directory()
    directory.mkdir(parents=True, exist_ok=True)
    _require(not directory.is_symlink(), "directory", "symbolic links are not supported")
    destination = directory / (manifest["id"] + ".json")
    installed = heapq.nsmallest(MAX_PLUGINS, directory.glob("*.json"))
    _require(destination.exists() or len(installed) < MAX_PLUGINS, "directory", "at most 32 calendars can be installed")
    contents = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    if len(contents) > MAX_FILE_BYTES:
        contents = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    _require(len(contents) <= MAX_FILE_BYTES, "file", "larger than 1 MiB")
    with tempfile.NamedTemporaryFile(dir=directory, prefix=".calendar-import-", delete=False) as output:
        temporary = Path(output.name)
        try:
            output.write(contents)
            output.flush()
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
    return manifest


def remove_plugin(identifier, directory=None):
    identifier = calendar_id(identifier)
    directory = Path(directory) if directory is not None else plugin_directory()
    _require(not directory.is_symlink(), "directory", "symbolic links are not supported")
    path = directory / (identifier + ".json")
    manifest = read_manifest(path)
    _require(manifest["id"] == identifier, "file", "calendar ID does not match its filename")
    path.unlink()


def remove_plugin_file(filename, directory=None):
    """Remove a direct regular calendar file, including an invalid manifest."""
    _require(isinstance(filename, str) and Path(filename).name == filename
             and filename.endswith(".json"), "file", "expected a calendar filename")
    directory = Path(directory) if directory is not None else plugin_directory()
    _require(not directory.is_symlink(), "directory", "symbolic links are not supported")
    path = directory / filename
    _require(stat.S_ISREG(path.lstat().st_mode), "file", "expected a regular file")
    path.unlink()


def builtin_available(identifier, year=None, metadata_path=None):
    year = date.today().year if year is None else year
    path = Path(metadata_path) if metadata_path is not None else Path(__file__).with_name("religious-coverage.json")
    try:
        coverage = _coverage(_read_json(path)[identifier])
        return available({"coverage": coverage}, year)
    except (OSError, ValueError, UnicodeError, KeyError, TypeError):
        return False
