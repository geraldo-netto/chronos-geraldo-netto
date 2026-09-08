# Holiday cache timestamps

`HolidayCache.recordFetch` accepts a provider's HTTP `Date` value only when it is
a parseable string at or before the local receive time. Missing, invalid, and
future values use the receive time instead. There is no clock-skew allowance:
even a timestamp one millisecond after receipt falls back. Validation uses the
recorded receive time, so processing delays cannot make a future header valid.
The HTTP loader captures that time when the complete response body arrives,
before JSON decoding, provider translation, validation, and event expansion.
The adapters and fallback chain preserve it, retaining milliseconds. Injected
providers that omit it use their callback's local time before processing.

For example, a response received at `2026-07-09T10:00:00Z` retains a provider
timestamp of `2026-07-09T09:59:00Z`. A missing header, `not a date`, or
`2026-07-09T10:00:01Z` records `2026-07-09T10:00:00Z` instead. An accepted older
header keeps its age and can therefore require an earlier refresh. A rejected
header does not discard otherwise valid holiday data.

The local clock supplies receive time; tests can inject it explicitly. This
rule validates cache freshness timestamps and does not authenticate the
provider or guarantee the correctness of the computer's clock.

## Gregorian date validation

Provider and cached holiday dates use Gregorian years 1–9999. Validation and
date-range expansion use UTC civil arithmetic, so a date skipped by the host
timezone remains valid for another country's calendar. Years 1–99 retain their
actual century, including spans crossing from year 99 into year 100.

Freshness metadata uses canonical year keys (`1` through `9999`, without leading
zeros or whitespace). Invalid year keys, arrays, and `__proto__`, `constructor`,
or `prototype` region keys are discarded. Metadata reads and writes use own
properties, so malformed cache keys cannot install inherited freshness or stop
the next successful fetch from repairing the cache.

## Cache file selection

The primary public calendar reads `holidays.json`. Additional country calendars
read their own `calendar-<country>-<region>.json` files. Missing or empty files
start with no snapshots and fetch current data. The obsolete `enrico.json` file
is never imported into either cache.

Country eviction accepts `savedAt` only as a finite numeric timestamp between
zero and the current repository clock. Invalid or future values have the oldest
priority, so correcting a clock that was years ahead cannot evict newly fetched
countries indefinitely.

## Response completeness

Provider responses must fit the 4,000-row expansion budget, counting both ends
of every holiday span. Over-budget responses are rejected before expansion so
the provider chain can try another source. If every source fails, prior rows and
their fetch timestamps remain intact; no truncated response is marked fresh or
persisted.

## Concurrent snapshots

A persisted update identifies each locally changed year and region and records
the response's local receive time. A save replaces all rows and freshness for
those snapshots only. Thus a 2027 fetch cannot restore stale 2026 rows after a
different applet instance corrected them, and an explicitly empty response
removes the old rows while retaining its freshness stamp.

The repository retains the receive time beside each snapshot. An older response
cannot overwrite a newer response merely because its disk write finishes later.
Equal receive times use write order. Provider HTTP `Date` remains the freshness
timestamp and does not order corrections. Queued saves combine independent
snapshots. A per-file queue in the shared root I/O module serializes each
read/merge/publication transaction across applet instances in one Cinnamon
process. The resulting country remains inside the persisted year window and
row limit.

Cache readers join that queue as well. On first creation, Gio may expose an
empty or partially written destination before completing the write; another
applet waits for publication before loading it. A second creator then reads and
merges the completed first snapshot, even though the original read had no etag.

Etags detect external changes made before Gio opens a replacement stream and
trigger a fresh merge. They do not provide an atomic compare-and-swap at
publication: separate processes writing the same cache concurrently are outside
the transaction guarantee. Independent Cinnamon sessions should use separate
`XDG_CACHE_HOME` directories. Cache cleanup refuses to run while Cinnamon is
active.

`HolidayCacheRepository.save(country, data)` requires `data.updates`, an array of
`{year, region, received}` descriptors. `HolidayCache.persist` supplies it from
recorded fetches and clears accepted descriptors; loading old rows does not mark
them as locally changed. Consumers receive the existing `{years, holidays}`
projection when reading the cache.

## Aggregate size limit

The complete serialized file must fit the I/O layer's 4 MiB UTF-8 limit, including
all retained countries and metadata. When needed, the repository evicts whole
country-years, least recently received first, together with their freshness and
receipt descriptors. A country's validated `savedAt` supplies priority when no
receipt is available. Every remaining year stays complete; live in-memory rows
are unaffected. A single year larger than the file budget is omitted entirely
and must be fetched again after restarting the applet.

The existing country and year-window bounds leave at most twelve eviction
candidates. The repository checks actual serialized byte length after each
eviction before handing the data to the asynchronous writer.

## Inactive scoped files

Additional calendar files remain on disk after a selection is removed so that
reselecting a calendar can reuse its cache. To clean inactive files explicitly,
run this maintenance command from the repository using the Node.js version in
the [repository runtime requirements](../README.md):

```sh
node scripts/cleanup-calendar-cache.mjs
```

This previews the canonical `calendar-<country>-<region>.json` files eligible for
removal. It preserves pairs configured in **every** saved applet profile,
including disabled configured rows and other instances' selections. If any
profile leaves its primary country unset for locale inference, it conservatively
keeps all scoped files. Primary `holidays.json`, plugin manifests, unrelated
files, and symlinks are outside the cleanup set.

To remove the previewed inactive files, log out of Cinnamon and run the command
from a text console with `--apply`. Do not start Cinnamon or change applet
profiles during cleanup. Apply refuses while a Cinnamon process for the current
user is present, rechecks profiles before each deletion, and stops if a candidate
file changed. Corrupt or unreadable profiles stop cleanup. No automatic cleanup
runs in the applet.

Paths default to `$XDG_CACHE_HOME/chronos@geraldo-netto` and
`$XDG_CONFIG_HOME/cinnamon/spices/chronos@geraldo-netto`, using `~/.cache` and
`~/.config` when those variables are unset. `--cache-dir` and `--settings-dir`
select explicit locations; both must describe the same user's installation.
