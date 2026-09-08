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

## Select and install calendars

The existing country selector remains the primary public-holiday calendar.
**Additional country calendars** adds independently enabled countries and regions.
Use `global` for nationwide holidays or the region token from that country's
existing selector, such as `ma` for Massachusetts or `by` for Bavaria. Each
country/region pair has its own provider and cache. Up to 16 additional pairs are
accepted; duplicates are ignored. Holiday services receive each enabled country
and, where supported, its region.

**Installed calendars** lists personal JSON plugins. **Import JSON** validates
and copies a file into the user's calendar directory. Importing does not enable
it: tick the calendar to show its entries. **Refresh** reloads file changes
without restarting Cinnamon. **Remove selected** removes that personal plugin
and its selection. Plugins do not execute code or make network requests, and
selections remain in the local applet profile.

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
personal plugins can be installed. Files must be regular files, not symbolic
links. An invalid plugin does not prevent other calendars from rendering.

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
