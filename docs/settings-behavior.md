# Settings behavior

## Settings window lifetime

Cinnamon 6.6.9's `xlet-settings.py` creates each instance's settings handler and
widget pages once, in `load_instances()` during window construction. Switching
pages or applet instances reuses those widgets. Reset and Import call the
existing handler's value-update methods; they do not rebuild the pages. Closing
the window destroys its widgets and immediately exits the GTK main loop.

Chronos therefore uses Cinnamon's listener lifetime for these pages. It does
not modify the handler's private listener or property-binding collections;
the handler exposes no public detach operation. A future host that rebuilds
pages while retaining their handler will need a supported teardown contract.
Chronos-owned work has its own teardown: pending window-centering idles cancel
when their widget is destroyed.

If an external reset or import updates country calendars while Add or Edit is
open, saving closes that stale dialog and asks the user to reopen it. The
external choices stay intact, including when the original edited row was
removed or the list was rebuilt with identical values.

## Weather location

An empty saved weather location stays empty when the applet starts, reloads,
or the settings dialog opens. If the operating-system timezone names a city,
that city appears as placeholder text in the empty field. For example,
`Europe/Rome` suggests Rome, even though someone using that timezone may live
in Genoa. The suggestion does not change the setting or trigger a weather
lookup for that location.

To save a location, type a city and press Enter or leave the field, or select a
city from the completion list. Closing the dialog also saves text the user has
entered. Opening and closing the dialog, focusing the untouched field, or
pressing Enter while it is still empty does not accept the placeholder.
Clearing an existing location saves an empty value, which stays empty on the
next opening or applet reload.

When weather is enabled and this location is empty, the panel retains the
weather setup warning. The local suggestion uses timezone data and does not
query an IP geolocation service. Weather beside enabled world clocks continues
to use those clocks' own timezone cities independently of this setting.

## Scheduled weather failures

Unexpected exceptions during scheduled weather retries are logged and end
that one retry. The normal periodic refresh remains active, so the next
period can recover without a settings change. An exception during a periodic
refresh is also logged and keeps that periodic source active. Logging failures
do not interrupt either timer's cleanup or continuation.

Direct calls to schedule an immediate refresh still propagate exceptions to
their caller after securing the periodic timer. Ordinary provider failures
continue to use the existing bounded retry schedule.

Rescheduling invalidates the previous weather request immediately, before the
scheduler starts the replacement refresh. The refresh then claims its own
request generation. These two steps deliberately protect the gap when a
scheduler delays or cannot start the replacement; an old location's answer
cannot become current during that gap.

## Holiday country inferred from system timezone data

For an initially unset holiday country, Chronos looks for an exact timezone
mapping in the operating system's `zone.tab`. A malformed row is skipped and
logged; unrelated valid rows remain usable. For example, a valid
`Europe/Rome` → `IT` mapping still works when another row contains invalid
coordinates. A malformed row never supplies a country code.

If a timezone appears more than once, the first valid row is retained and later
duplicates are logged and skipped. A malformed earlier row does not reserve the
timezone: a later valid row may supply its mapping. Diagnostic row text is
limited to 200 characters and escaped before logging. Missing or oversized
tables, or a timezone without a valid match, still yield no inferred country.
Manual country choices remain available. The [source investigation](timezone-country-inference.md)
explains why the current exact lookup and skip-and-log behavior are retained.

## Trusted system files and size checks

`ioUtils.readTextFileCapped` intentionally reads `/etc/timezone` and
`/usr/share/zoneinfo/zone.tab` before checking their size. These paths are
assumed to be controlled by the administrator and supplied by the operating
system. The accepted limits are 1 KiB for `/etc/timezone` and 256 KiB for
`zone.tab`; oversized contents are rejected after the read.

This is an explicit exception for these trusted system inputs: **the size
check does not bound memory allocated by the read**. An unexpectedly large
file is already in the Cinnamon process's memory before it is rejected. The
current behavior does not perform a size preflight.

If future packaging, permissions, path selection, symlink handling, containers,
or another feature makes these paths or their contents influenceable by an
untrusted party, that party could use a large file to cause memory exhaustion
or disrupt the desktop session. Revisit this assumption before extending the
helper to such inputs. A size check before reading can reject an already-large
file; enforcing a strict allocation limit also requires bounded reads because
a file can grow between the check and the read.

This exception does not apply to imported calendar manifests or holiday cache
files. Their own input validation and size limits remain separate.
