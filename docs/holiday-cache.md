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
