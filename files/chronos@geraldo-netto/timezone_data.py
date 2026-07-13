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
settings_widgets_common re-exports these so the dialog code and the tests reach
the whole feature through one import.
"""

from __future__ import annotations

import logging
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
