# Calendar plugins

Chronos combines public holidays, built-in religious observances, and installed
plugins through one calendar registry. Overlapping dates combine their names
within the existing 300-character limit per calendar day; excess text is truncated.
Non-working holidays take precedence over ordinary observances for day styling.
An ordinary observance does not turn a part-day public holiday into a full day off.
Country providers retain their classifications: optional, bank-only, and
unclassified dates stay ordinary observances unless `public_holiday` is explicit.
Names and provider credits use a fixed order: primary country, additional
countries, religions, personal plugins, then other registered adapters. Within
each group, IDs sort lexicographically. Reapplying settings or reloading plugins
therefore preserves the same order and which names fit the display limit.
The registry identifies these groups by `builtin:country`, `country:`,
`religion:`, and `plugin:` IDs; all other IDs follow them.

Names must contain usable Unicode without embedded NUL or unpaired surrogates.
Unsafe translations are ignored when a valid translation remains; a provider
without a usable name falls through to the next service. Invalid cached rows
are discarded and their snapshot becomes stale so it can be fetched again.
An adapter returning unsafe names is isolated from healthy calendars, and an
unsafe provider credit falls back to the adapter's validated name. Intentional
line breaks between same-day names are preserved.

## Select and install calendars

The existing country selector remains the primary public-holiday calendar.
**Additional country calendars** adds independently enabled countries and regions.
Use `global` for nationwide holidays or the region token from that country's
existing selector, such as `ma` for Massachusetts or `by` for Bavaria. Each
country/region pair has its own provider and cache. Up to 16 additional pairs are
accepted; duplicates are ignored. Holiday services receive each enabled country
and, where supported, its region.

Imported rows use the same strict rules in the applet and settings. `enabled`
must be a boolean and defaults to true only when omitted; `region` must be text
and defaults to `global` only when omitted or blank. Regions are trimmed and
lowercased; country codes must match a supported code exactly. Invalid rows are
discarded. The first valid country/region pair wins, including a disabled row.
Only the first 64 stored rows are inspected; settings retain disabled rows and
disable enabled rows beyond the 16-active limit. Opening settings preserves the
same effective calendar selection.

**Installed calendars** lists personal JSON plugins. **Import JSON** validates
and copies a file into the user's calendar directory. Importing does not enable
it: tick the calendar to show its entries. **Refresh** reloads file changes
without restarting Cinnamon. **Remove selected** removes that personal plugin
and its selection. Plugins do not execute code or make network requests, and
selections remain in the local applet profile.

**Unavailable calendars** is a separate management area for expired or invalid
files and selections that are no longer loaded. **Clear selection** releases a
selection slot while keeping the file. **Remove file** deletes that file and its
selection, including an invalid JSON file. These actions reclaim the 32 file or
selection slots without adding unavailable calendars to the choices. Updating a
retained calendar's coverage and refreshing restores its selected choice.
Displayed filenames replace malformed Unicode and line or directional controls,
and shorten to 100 characters. Long labels ellipsize within the settings window.
Available choices retain their full calendar names in tooltips and accessible labels.
Removal always uses the original filename, even when two display labels match.

The default directory is `~/.local/share/chronos@geraldo-netto/calendars/`, or
`$XDG_DATA_HOME/chronos@geraldo-netto/calendars/` when `XDG_DATA_HOME` is an
absolute path. Files copied manually must be named `<id>.json`; refresh the
choices after copying. Personal city calendars belong here, not in Chronos's
source tree or platform defaults.

Calendars outside their declared year range are hidden from the choices.
Selections are retained so updated data can make a calendar available again.
Rendering also checks the requested year: covered historical dates remain
available, while entries outside coverage are omitted. A built-in religion
missing required dates is hidden as a whole, including its fixed-date entries.
Other calendars and the main month panel remain usable.

## JSON format, version 1

```json
{
  "apiVersion": 1,
  "id": "example.team",
  "name": "Team calendar",
  "category": "custom",
  "coverage": { "from": 2026, "through": 2027 },
  "source": { "name": "Team-maintained calendar" },
  "events": [
    { "name": "Team anniversary", "month": 6, "day": 12 },
    { "name": "Office holiday", "year": 2026, "month": 12, "day": 28, "nonWorking": true }
  ]
}
```

`coverage.from` and `coverage.through` are inclusive Gregorian years from 1 to
9999. The author declares the calendar's stated scope complete within this
interval. A covered year may legitimately have no entries. A partial-year
publication must not be described as full-year coverage. A documented annual
rule may use a broad range; that describes a recurrence rule, not a published
table of future observations.

Each event has a `name`, `month`, and `day`. With `year`, it occurs once in that
year; without it, it recurs annually within coverage. Annual February 29 entries
are omitted in non-leap years. Arrays support several occurrences of the same
observance within a Gregorian year. `nonWorking` defaults to false; set it true
only when the source supports that classification. Category alone never makes
an event a day off.

`category` is descriptive text: country, religious, municipal, school, team, or
another category. `source.name` is required. Optional `source.url` is an HTTPS
provenance link, not an endpoint fetched by the applet. `source.tradition` and
`source.location` identify the actual community and locality. Religious sources
should name their convention rather than claim to represent every community.
The [source research](calendar-sources.md) describes coverage limits and
candidates for separately named calendars.

IDs use lowercase namespaced segments, such as `example.team` or
`org-example:observances`, and are limited to 96 characters. Unknown fields,
invalid dates, control characters, unsafe IDs, and malformed documents are
rejected. Calendar names are limited to 100 characters, event names to 160,
categories to 64, source names/traditions/locations to 160, and source URLs to
2048. A file may contain at most 4096 events and is limited to 1 MiB. Up to 32
personal plugins can be installed. Only regular JSON files consume those
slots. Symbolic links and directories are reported as unsupported and left
untouched. An invalid plugin does not prevent other calendars from rendering.

Refreshing, changing the selection, clearing it, or removing the applet cancels
the previous load. Once retired, remaining decoding and validation are skipped,
and its results do not replace the current calendars. Each load shares one Gio
cancellable across its directory checks, file opens, and bounded chunk reads.
Completed I/O callbacks are always finished and acquired streams are closed,
including when cancellation races with a successful operation.

For injected transports, `CalendarPluginLoader` requires
`read(id, cancellable, callback)`. The callback receives the decoded document
or `null` after cleanup; cancelled generations never reach the public load
callback. Pure tests inject `createCancellable()`; the runtime factory creates
a real `Gio.Cancellable`. Stream closure uses no cancellable so retiring the
load cannot interrupt resource cleanup. Expected cancellations are silent.

## Provider extension contract

`calendarRegistry.js` exports `CalendarRegistry`. Register an adapter with an
`id`, `name`, `category`, boolean `enabled` (a live getter is supported),
`available(year)`, and `getHolidays(year, month, callback)`. Optional `destroy()`
releases resources. `register()` rejects duplicate IDs; `unregister(id)`
releases that adapter. `list(year)` returns available adapters, including
disabled ones. The registry supports up to 64 adapters.

Callbacks receive a `Map` keyed by `"month/day"`, a canonical holiday error code
or an empty string, and provider attribution. Entries have `{ name, flags }`.
Month maps contain at most 31 valid day entries. Each entry accepts up to eight
flags of at most 64 characters each. Merging retains day-classification flags
before trimming auxiliary flags to this limit, then orders them consistently.
`public_holiday` marks a non-working holiday; `religious_holiday` and
`calendar_observance` mark ordinary observances. Providers may deliver updates;
simultaneous month requests remain independent, and stale answers after
structural changes or destruction are ignored. JSON plugins use this same
contract through `calendarSourceAdapters.js` and `calendarPluginLoader.js`.

Adding JSON calendars requires no platform code change. Adding an executable
provider kind requires an adapter and composition-root wiring in `holidays.js`;
the personal importer deliberately accepts data rather than arbitrary code.
