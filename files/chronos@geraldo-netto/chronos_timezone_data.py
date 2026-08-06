#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.


"""The gi-free half of the world-clock settings.

Timezone identity and city names, with no Gtk/Atk/GLib and no widgets — the
numbers-and-words half of the dialog, the way weatherFormat is to weather.js.
chronos_settings_widgets_common re-exports these so the dialog code and the tests reach
the whole feature through one import.
"""

from __future__ import annotations

import logging
import os
import re
import unicodedata
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

LOGGER = logging.getLogger("chronos@geraldo-netto.settings")

MISSING_PYTZ_WARNING = (
    "python3-pytz is not installed; world-clock timezone validation and "
    "city suggestions are limited. Install it with "
    "'sudo apt install python3-pytz' on Linux Mint/Debian/Ubuntu, or "
    "'python3 -m pip install pytz'."
)

TZ_NO_REGION = 'Etc'
RESERVED_TIMEZONES = {"utc", "etc/utc", "local"}
ZONEINFO_DIRECTORY = Path("/usr/share/zoneinfo")


def zoneinfo_name(target: Path) -> Optional[str]:
    """Return a lexical zoneinfo path without resolving an IANA alias."""
    normalized = Path(os.path.normpath(str(target)))
    parts = normalized.parts
    try:
        index = len(parts) - 1 - parts[::-1].index("zoneinfo")
    except ValueError:
        return None

    name = "/".join(parts[index + 1:])
    return name or None


def zoneinfo_identifier(value: str) -> str:
    """A TZ-style identifier reduced to a plain zoneinfo name.

    TZ takes a POSIX colon prefix and an absolute path, so one zone reaches a
    comparison as "Europe/Rome", ":Europe/Rome" or
    "/usr/share/zoneinfo/Europe/Rome" depending only on how the session was
    started. GLib does not canonicalize either — get_identifier() answers the
    string it was given — so the runtime needs the same reduction, and
    worldclockData.zoneinfoIdentifier is this rule in JavaScript.
    """
    identifier = value.strip()
    if identifier.startswith(":"):
        identifier = identifier[1:]
    if identifier.startswith("/"):
        return zoneinfo_name(Path(identifier)) or identifier
    return identifier


def local_timezone_name() -> Optional[str]:
    """The runtime's local-zone identity, preserving overrides and aliases.

    The applet always shows a local-time row, and it drops any configured clock
    whose zone resolves to the same one. The dialog therefore has to know what
    the local zone *is*, not just that the user typed the word "local".
    """
    configured = os.environ.get("TZ", "").strip()
    if configured:
        return zoneinfo_identifier(configured)

    try:
        localtime = Path("/etc/localtime")
        target = Path(os.readlink(localtime))
        if not target.is_absolute():
            target = localtime.parent / target
    # not a zoneinfo symlink (a copied file, a container, a stub /etc): there is
    # no name to compare against, and a missing name only costs the extra check
    except OSError:
        return None

    return zoneinfo_name(target)


def runtime_local_timezone() -> str:
    """The local zone, in the form is_runtime_builtin_timezone's parameter takes.

    Resolving it costs a $TZ read or an os.readlink of /etc/localtime, and the
    function below falls back to doing that once per call. A caller with a list
    of rows resolves it here, once, and hands the answer down.

    "" and not None: the parameter reads None as "resolve it yourself", so a
    machine whose zone has no zoneinfo name would otherwise pay the lookup again
    for every row — the exact cost this exists to avoid.
    """
    return local_timezone_name() or ""


def is_runtime_builtin_timezone(
    value: Any,
    local_timezone: Optional[str] = None,
) -> bool:
    """Would the runtime omit this row because it already draws that zone?

    Keep this deliberately lighter than TimezoneResolver.is_reserved(): saved
    rows already contain identifiers, and opening the settings page must not
    build the full timezone index merely to migrate its JSON list.
    """
    if not isinstance(value, str):
        return False

    identifier = value.strip()
    if not identifier:
        return False
    if identifier == "local":
        return True

    local = local_timezone if local_timezone is not None else local_timezone_name()
    builtin_identities = {"UTC", "Etc/UTC"}
    if local:
        builtin_identities.add(zoneinfo_identifier(local))
    # both sides of the comparison, so a saved row spelled the way TZ spells it
    # is the same zone as the built-in row the runtime draws from it
    return zoneinfo_identifier(identifier) in builtin_identities


def looks_like_iana(value: Any) -> bool:
    """Area/City, the shape of an IANA identifier.

    Says only that the text is not a word someone typed by accident: it does
    not say the zone exists, and it is case-blind where the runtime is not.
    """
    if not isinstance(value, str):
        return False

    parts = value.strip().split("/")
    if len(parts) < 2 or len(parts) > 3:
        return False

    return all(part and all(ch.isalnum() or ch in "_+-" for ch in part) for part in parts)


def zoneinfo_spelling_exists(value: str) -> bool:
    """Is there a zone file spelled exactly this way?

    The zoneinfo directory ships with tzdata, not with Python, so it is there
    on hosts where neither pytz nor zoneinfo is importable. This asks it the
    same question the runtime will: GLib.TimeZone.new_identifier looks a zone
    up in that directory case-sensitively, so "america/sao_paulo" is not a zone
    to the applet however plausible its shape.

    Only reached for text looks_like_iana has already accepted, whose segments
    are alphanumerics, '_', '+' and '-' — no '.' and so no traversal.
    """
    try:
        return ZONEINFO_DIRECTORY.joinpath(*value.split("/")).is_file()
    except (OSError, ValueError):
        return False


def accepts_undatabased_timezone(value: Any) -> bool:
    """Everything a typed zone can be checked against with no Python tzdata.

    The shape rule alone let a correctly-spelled zone in the wrong case through
    — "america/sao_paulo" — and the dialog then previewed it, went sensitive
    and saved it, while the applet's case-sensitive lookup rendered an italic
    "Invalid timezone" row with nothing connecting the two. That is the outcome
    the shape rule exists to prevent.

    A host with no zone directory either has nothing left to ask, and keeps the
    shape rule as its only answer.
    """
    if not looks_like_iana(value):
        return False
    if not ZONEINFO_DIRECTORY.is_dir():
        return True
    return zoneinfo_spelling_exists(value.strip())


# The port of weatherServiceAdapters.foldPlaceName, kept level with it by
# test/fixtures/place_name_fold_cases.json. Only the marks a writer routinely
# omits are stripped - Latin, Greek and Cyrillic accents, Cyrillic titlo, Hebrew
# points, Arabic harakat - while Indic vowel signs and the Japanese dakuten are
# letters and are left alone, or names that differ only by one would collide.
_OPTIONAL_DIACRITICS = frozenset(
    list(range(0x0300, 0x0370)) + list(range(0x0483, 0x048A)) +
    list(range(0x0591, 0x05BE)) + [0x05BF, 0x05C1, 0x05C2, 0x05C4, 0x05C5, 0x05C7] +
    list(range(0x064B, 0x0660)) + [0x0670])
# letters that carry the accent in the code point and have no decomposition,
# which is exactly why a keyboard without them produces the spelling on the right
_UNDECOMPOSED_LETTERS = {
    'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o',
    'đ': 'd', 'ð': 'd', 'þ': 'th', 'ł': 'l',
    'ħ': 'h', 'ı': 'i', 'ŋ': 'n', 'ĸ': 'k',
    'ς': 'σ',
}
# an apostrophe is decoration and arrives in five shapes (Hawaiʻi, Coeur
# d'Alene, N'Djamena); a space, a hyphen and an underscore are one joint
_PLACE_NAME_PUNCTUATION = frozenset("'\u2018\u2019\u02bb\u02bc\u00b4`")
_PLACE_NAME_GAPS = re.compile(r"[\s_-]+")


def fold_place_name(text: Any) -> str:
    """Fold a place name so two spellings of it meet.

    The settings completion list used to fold with strip/lower/replace('_',' ')
    alone, so it would not offer "São Paulo" for a typed "Sao" nor
    "Saint-Étienne" for "saint etienne" - while the runtime geocode matcher
    folded both. The user was shown a narrower set of suggestions than the
    thing that actually answers accepts.
    """
    if not isinstance(text, str):
        return ""

    kept = []
    for character in unicodedata.normalize("NFKD", text.lower()):
        if ord(character) in _OPTIONAL_DIACRITICS or character in _PLACE_NAME_PUNCTUATION:
            continue
        kept.append(_UNDECOMPOSED_LETTERS.get(character, character))

    return _PLACE_NAME_GAPS.sub(" ", "".join(kept)).strip()


def completion_key(text: Any) -> str:
    """Fold a typed word and a suggestion onto the same shape.

    "buenos aires", "Buenos_Aires" and "BUENOS AIRES" all have to hit the same
    suggestion, so neither case, nor an underscore, nor an accent the typist
    left off decides a match.
    """
    return fold_place_name(text)


def local_city_name(timezone: Optional[str] = None) -> str:
    """The city the machine's own timezone names, as a place a geocoder knows.

    Europe/Rome is "Rome", America/Argentina/Buenos_Aires is "Buenos Aires". A
    zone with no city in it — UTC, the Etc/ block, a /etc/localtime that is not a
    zoneinfo symlink — names no place, and answers "".
    """
    name = local_timezone_name() if timezone is None else timezone
    if not name or '/' not in name or name.startswith(TZ_NO_REGION + '/'):
        return ""

    city_timezone = name
    try:
        source = ZONEINFO_DIRECTORY.joinpath(*name.split('/'))
        if source.is_symlink():
            resolved = source.resolve(strict=True)
            city_timezone = resolved.relative_to(ZONEINFO_DIRECTORY).as_posix()
    except (OSError, RuntimeError, ValueError):
        return ""

    return city_timezone.rsplit('/', maxsplit=1)[-1].replace('_', ' ')


class TimezoneResolver:
    def __init__(
        self,
        pytz_module: Any,
        available_timezones_func: Optional[Callable[[], Iterable[str]]],
        local_timezone: Optional[str] = None,
        local_timezone_provider: Optional[Callable[[], Optional[str]]] = None,
    ) -> None:
        self.has_timezone_data = pytz_module is not None
        self.timezone_map = {}
        self.city_map = {}
        self.fallback_timezone_map = {}
        self.completions = []

        # Keep the expensive timezone index for the process, but not the one
        # piece of it the operating system can change underneath that process.
        # An explicitly supplied zone is a stable test/embedding override;
        # production instances re-read the local identity before validation.
        self._local_timezone_provider = (
            (lambda: local_timezone)
            if local_timezone is not None
            else (local_timezone_provider or local_timezone_name)
        )
        self.builtin_timezones = set()
        self.refresh_builtin_timezones()

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

    def refresh_builtin_timezones(self) -> None:
        """Refresh the dynamic local row without rebuilding the zone index."""
        local = self._local_timezone_provider()
        self.builtin_timezones = {"UTC", "Etc/UTC"}
        if local:
            self.builtin_timezones.add(local)

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

        self.refresh_builtin_timezones()
        resolved = self._resolve(text)
        return bool(resolved) and resolved in self.builtin_timezones

    def normalize(self, value: Any, reserved: Optional[bool] = None) -> Optional[str]:
        """Accept a full IANA identifier or a plain city name, case-insensitively.

        `reserved` is is_reserved()'s answer when the caller has already asked.
        It is not a micro-optimization: is_reserved re-reads the OS zone before
        deciding, deliberately, so asking it twice for one value can get two
        different answers - and the dialog's OK-button sensitivity and its
        preview text were computed from separate calls.
        """
        if not value:
            return None

        value = value.strip()
        if not value:
            return None
        if reserved is None:
            reserved = self.is_reserved(value)
        if reserved:
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
                return value if accepts_undatabased_timezone(value) else None
            return (self.fallback_timezone_map.get(lower)
                    or self.city_map.get(city_token))

        timezone = self.timezone_map.get(lower)
        if timezone:
            return timezone

        timezone = self.city_map.get(city_token)
        if timezone:
            return timezone

        return None
