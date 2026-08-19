#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.


import gettext
import logging
from pathlib import Path


LOGGER = logging.getLogger("chronos@geraldo-netto.settings")

# Collected here and logged by report_pending_warnings(), which the first
# widget construction calls: importing a module should define things, not emit
# them. At import time cinnamon-settings has not configured logging yet, so the
# warning landed on the whole process's stderr or was dropped entirely,
# depending on import order — the rule chronos_timezone_data:305-311 states and
# follows for its own missing-database warning.
_PENDING_WARNINGS: list[str] = []


def load_translation():
    domain = "chronos@geraldo-netto"
    for locale_dir in (
        str(Path.home() / ".local/share/locale"),
        "/usr/share/locale",
    ):
        try:
            translation = gettext.translation(domain, locale_dir, fallback=True)
        except OSError:
            _PENDING_WARNINGS.append(locale_dir)
            continue
        if isinstance(translation, gettext.GNUTranslations):
            return translation.gettext

    return gettext.NullTranslations().gettext


def report_pending_warnings() -> int:
    """Log what loading the catalogs had to say, and say how much that was.

    Called once, from the first widget this settings page builds. Emptying the
    list here is what makes it once: a second page in the same
    cinnamon-settings process has nothing new to report.
    """
    reported = len(_PENDING_WARNINGS)
    for locale_dir in _PENDING_WARNINGS:
        LOGGER.warning("Ignoring unreadable translation catalog under %s", locale_dir)
    _PENDING_WARNINGS.clear()
    return reported


_ = load_translation()
