#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.


import sys
from pathlib import Path

# Appended, not inserted at 0: this runs inside the shared cinnamon-settings
# process, and a directory at the front of sys.path shadows the standard library
# for everything else in it — a file here called logging.py or types.py would
# win over the real one.
_APPLET_DIR = str(Path(__file__).resolve().parent.parent)
if _APPLET_DIR not in sys.path:
    sys.path.append(_APPLET_DIR)

# Cinnamon's create_custom_widget instantiates only the name the schema's
# "widget" field gives it. list_edit_factory was re-exported here too and nothing
# outside settings_widgets_common has ever called it: the tests import that
# module directly.
from settings_widgets_holidays import CountryComboBox
from settings_widgets_weather import WeatherLocationEntry
from settings_widgets_worldclocks import ClocksList

__all__ = ["ClocksList", "CountryComboBox", "WeatherLocationEntry"]
