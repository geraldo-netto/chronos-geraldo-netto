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


def load_translation():
    domain = "chronos@geraldo-netto"
    for locale_dir in (
        str(Path.home() / ".local/share/locale"),
        "/usr/share/locale",
    ):
        try:
            translation = gettext.translation(domain, locale_dir, fallback=True)
        except OSError:
            LOGGER.warning("Ignoring unreadable translation catalog under %s", locale_dir)
            continue
        if isinstance(translation, gettext.GNUTranslations):
            return translation.gettext

    return gettext.NullTranslations().gettext


_ = load_translation()
