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
_REMOVED_RANGES = ((0x00, 0x1F), (0x7F, 0x9F), (0x2028, 0x2029),
                   (0x202A, 0x202E), (0x2066, 0x2069))
MAX_FILENAME_DISPLAY_LENGTH = 100


def valid_unicode(value: str) -> bool:
    """Whether a string consists of Unicode scalar values accepted by GTK."""
    return _INVALID_UNICODE.search(value) is None


def diagnostic_text(value: str) -> str:
    """Keep a refused value readable without passing invalid Unicode to ATK."""
    return _INVALID_UNICODE.sub("\ufffd", value)


def _is_removed_control(code):
    return any(first <= code <= last for first, last in _REMOVED_RANGES)


def sanitize_control_characters(value):
    """Collapse line-breaking and directional controls using textUtils.js's set."""
    sanitized = []
    replacing = False
    for character in value:
        if _is_removed_control(ord(character)):
            if not replacing:
                sanitized.append(" ")
                replacing = True
        else:
            sanitized.append(character)
            replacing = False
    return "".join(sanitized)


# ECMAScript trim() includes BOM and excludes Python's extra C0/C1 whitespace.
TEXT_WHITESPACE = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def trim_text(value: str) -> str:
    """Trim a validated string with the runtime's whitespace policy."""
    return value.strip(TEXT_WHITESPACE)


def filename_display_text(value) -> str:
    """Project an opaque filesystem name safely; never use the result for I/O."""
    if not isinstance(value, str):
        return ""
    normalized = trim_text(sanitize_control_characters(diagnostic_text(value)))
    if len(normalized) <= MAX_FILENAME_DISPLAY_LENGTH:
        return normalized
    return normalized[:MAX_FILENAME_DISPLAY_LENGTH - 1].rstrip(TEXT_WHITESPACE) + "…"
