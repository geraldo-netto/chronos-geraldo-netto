# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

"""Text boundaries shared by the Python settings and JavaScript runtime."""

import re


_INVALID_UNICODE = re.compile(r"[\ud800-\udfff]")


def valid_unicode(value: str) -> bool:
    """Whether a string consists of Unicode scalar values accepted by GTK."""
    return _INVALID_UNICODE.search(value) is None


def diagnostic_text(value: str) -> str:
    """Keep a refused value readable without passing invalid Unicode to ATK."""
    return _INVALID_UNICODE.sub("\ufffd", value)


# ECMAScript trim() includes BOM and excludes Python's extra C0/C1 whitespace.
TEXT_WHITESPACE = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def trim_text(value: str) -> str:
    """Trim a validated string with the runtime's whitespace policy."""
    return value.strip(TEXT_WHITESPACE)
