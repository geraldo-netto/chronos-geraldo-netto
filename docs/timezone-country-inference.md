# Timezone-to-country inference

Investigation checked on 2026-09-08 against installed tzdata 2026c and IANA's
published table specifications. Keep the existing exact `zone.tab` lookup and
skip-and-log handling. Neither a broader parser nor the newer timezone tables
can reliably recover a single holiday country from ambiguous or damaged data.
An explicit country selection remains the authoritative setting.

## Source alternatives

| Source | Meaning and implication |
| --- | --- |
| [`zone.tab`](https://data.iana.org/time-zones/tzdb/zone.tab) | IANA marks this format deprecated. It nevertheless supplies one country per timezone spelling and includes country-specific aliases. Chronos uses that country-specific information, rather than retaining an old API or runtime. |
| [`zone1970.tab`](https://data.iana.org/time-zones/tzdb/zone1970.tab) | The recommended timezone-selection table groups places whose clocks agree since 1970. Its first column can contain multiple countries; choosing the first would choose the representative city's country, not establish where the user lives. |
| [`zonenow.tab`](https://data.iana.org/time-zones/tzdb/zonenow.tab) | Groups clocks expected to agree in the future. Its first column is explicitly irrelevant, so it cannot supply holiday countries. |

The installed files contain 418 `zone.tab` rows, 312 `zone1970.tab` rows
(34 with multiple countries), and 90 `zonenow.tab` rows. None has duplicate
timezone keys. Examples from these local files:

| Timezone | `zone.tab` | `zone1970.tab` |
| --- | --- | --- |
| Europe/Rome | IT | IT,SM,VA |
| Europe/Prague | CZ | CZ,SK |
| Europe/Zurich | CH | CH,DE,LI |
| America/New_York | US | US |

These are timezone hints, not geolocation. IANA deliberately groups clocks
across country boundaries and uses representative locations in timezone names.
That makes offset matching, city-name guessing, and canonicalizing aliases
before trying the original spelling unsuitable country disambiguators.
See [IANA's naming rationale](https://data.iana.org/time-zones/tzdb/theory.html#naming).

## Formats and damaged data

Tab-separated fields, an optional comment, and coordinates with or without
seconds already fit the parser. `zone1970.tab` permits UTF-8 comments and
comma-separated country codes; that is a distinct data model, not permission
to reinterpret a malformed `zone.tab` row. Treating spaces as tabs, dropping
invalid fields, or taking the first comma-separated code could silently change
the selected country's holidays.

Identical duplicate mappings add no information. Conflicting duplicates have
no reliable winner in the file itself. The accepted first-valid-row rule is
deterministic; skipping later duplicates and logging the source problem keeps
unrelated mappings usable. A malformed first row does not prevent a later valid
mapping. Repairing a damaged operating-system tzdata installation, or choosing
the country explicitly, is more reliable than inferring which duplicate was
intended.

## Decision

Keep the current parser and behavior. Replacing it with `zone1970.tab` would
require exposing country ambiguity, including ordinary Rome and Prague setups,
without repairing malformed input. Combining tables or adding another bundled
territory database introduces precedence and update work without an accuracy
gain for exact country-specific matches. The no-compatibility policy allows a
replacement, but does not make a less specific source preferable. No source
fallback, format migration, network lookup, or additional dependency is needed.
