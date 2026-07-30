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
from timezone_data import (
    completion_key,
    TimezoneResolver,
)



def plain_completion_match(completion, key, tree_iter, model) -> bool:
    """Substring match against the folded text in the model's last column.

    Same contract as timezone_completion_match — the folding is precomputed at
    build time, so a keystroke costs one substring test per row — but for models
    whose suggestion is the value: a city name, a country name.
    """
    needle = completion_key(key)
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






