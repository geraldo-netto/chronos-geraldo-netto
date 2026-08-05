#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.


from __future__ import annotations

from typing import Optional
try:
    import pytz
except ImportError:
    pytz = None
try:
    from zoneinfo import available_timezones
except ImportError:
    available_timezones = None
# The gi-free half of the feature — timezone identity and city names — lives in a
# sibling with no Gtk/Atk/GLib. What is left here is what the three feature
# modules (weather, holidays, world clocks) genuinely share: the folded
# substring matcher and one process-wide timezone index.
from chronos_timezone_data import (
    completion_key,
    TimezoneResolver,
)



# The longest IANA identifier is 32 characters (America/Argentina/ComodRivadavia)
# and the longest country the dialog offers is 24 (United States of America), so
# this bounds both completion entries well clear of anything legitimate. Without
# it the entry accepted arbitrary text and every keystroke ran the match func
# once per row over it.
MAX_COMPLETION_INPUT_LENGTH = 64

_LAST_COMPLETION_KEY: tuple[Optional[str], str] = (None, "")


def folded_completion_key(key) -> str:
    """Fold the needle once per keystroke rather than once per row.

    GTK calls a match func for every row of the model with the same key, and
    completion_key() makes three fresh copies of it (strip, lower, replace) —
    so the timezone model's ~600 rows meant 1800 copies of the needle per
    character typed. Both matchers used to call it per row while their
    docstrings claimed "the needle is folded once by the caller"; this is the
    caller that makes that true.
    """
    global _LAST_COMPLETION_KEY  # NOSONAR [S3827] -- one memo shared by both matchers
    cached_key, cached_folded = _LAST_COMPLETION_KEY
    if cached_key is not None and cached_key == key:
        return cached_folded

    folded = completion_key(key)
    _LAST_COMPLETION_KEY = (key if isinstance(key, str) else None, folded)
    return folded


def plain_completion_match(completion, key, tree_iter, model) -> bool:
    """Substring match against the folded text in the model's last column.

    Same contract as timezone_completion_match — the folding is precomputed at
    build time, so a keystroke costs one substring test per row — but for models
    whose suggestion is the value: a city name, a country name.
    """
    needle = folded_completion_key(key)
    if not needle:
        return False

    return needle in model[tree_iter][-1]



_TIMEZONE_RESOLVER: Optional[TimezoneResolver] = None


def shared_timezone_resolver() -> TimezoneResolver:
    """Build the settings process's timezone index on its first real use."""
    global _TIMEZONE_RESOLVER
    if _TIMEZONE_RESOLVER is None:
        _TIMEZONE_RESOLVER = TimezoneResolver(pytz, available_timezones)

    return _TIMEZONE_RESOLVER




