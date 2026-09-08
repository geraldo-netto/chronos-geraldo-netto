# Settings behavior

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
Manual country choices remain available. Improvements to source compatibility
and conflicting duplicate handling remain a separate investigation.
