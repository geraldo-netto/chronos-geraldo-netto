# cinnamon-chronos TODO

Audit ledger for this applet. Full-source rescan on 2026-07-16 against every `agent-instructions/` review category **including the special ones — wiring gaps, unused functions/methods, legacy/deprecation, and variable/function scope**. The scan covered all tracked source, tests, CI, documentation, packaging scripts, catalogs and assets. It excluded generated or cached material: `.git/`, `node_modules/`, `dist/`, `build/`, `coverage/`, `.cache/`, Python/tool caches, bytecode and compiled catalogs. Candidates were reproduced where possible, checked against the current source and deduplicated against this ledger and `git log --oneline` before inclusion. A focused god-object/file and dependency-boundary follow-up on the same date measured class surfaces, traced imports and ownership, and rejected size-only candidates that still had one coherent responsibility.

**Findings verified by running or mutating the code are marked [verified]**, each naming the experiment. Live provider responses or policies were consulted only where the current external contract was itself under review; source conclusions were checked locally.

Baseline: `npm test` green (748 JS tests, JS coverage per-file 98/90/100; Python 115 tests, 98 %+ lines), `npm run lint` clean, CI runs both on every push and PR. `npm audit --omit=dev` reports zero vulnerabilities. The gates are real — what this pass found is largely what they do not look at.

Open items: 3 (Critical 0, High 1, Medium 0, Low 2).

## Findings

### High

| ID | Category | Severity | Status | Effort | Description | Notes |
|----|----------|----------|--------|--------|-------------|-------|
| T439 | packaging | High | open | S | **[verified]** `5.4/icon.png` is committed as a git **symlink** (mode `120000` → `../icon.png`), not a file. Zip delivery (the Spices "Download" tab) and several install paths do not preserve symlinks: the entry lands as a broken link or a 12-byte file containing the literal text `../icon.png` — a corrupt PNG, so the applet is iconless. | Verified: `git ls-files -s` → `120000 …`. The rescan also found it **unnecessary**: the Spices spec puts the icon at `files/UUID/icon.png`, which already exists as a real 48×48 file; Cinnamon only adds `5.4/` to the icon *theme* search path. Fix: delete the symlink (or replace it with a real copy). Raised from Medium — the previous ledger had not established that zip delivery is the shipping path. |

### Medium

| ID | Category | Severity | Status | Effort | Description | Notes |
|----|----------|----------|--------|--------|-------------|-------|

### Low

| ID | Category | Severity | Status | Effort | Description | Notes |
|----|----------|----------|--------|--------|-------------|-------|
| T522 | CI / supply chain | Low | open | S | **[verified]** Three hardening gaps in `.github/workflows/ci.yml`: no `permissions:` block anywhere (`grep -c permissions` → `0`), so `GITHUB_TOKEN` inherits the repo default, which on many repos is `contents: write` — and the job runs `npm ci` + `npm test`, i.e. repository and dependency code; `:32` installs pyflakes with `--upgrade` and no pin or hash, while the JS side is lockfile-pinned; `:16,20,25` pin `actions/checkout@v4`, `setup-node@v4`, `setup-python@v5` to mutable major tags. | Fork PRs are safe (GitHub forces a read-only token), which is what keeps this Low. Fix: `permissions: contents: read`, pin pyflakes, pin the actions to SHAs. |
| T343 | packaging | Low | open | S | **[verified]** `calendar.png` is a tracked 48×48 orphan at the repo root; nothing references it (grep across js/json/md/py/css is empty) and it is not the icon (different md5 from `files/chronos@geraldo-netto/icon.png`). It would ship in a Spices submission as dead weight. | Inherited from `calendar@ccprog`. Fix: delete. |

## Suggested order

1. **T439** — remove the committed delivery-fragile icon symlink.
2. **T522** — reduce and pin the CI supply-chain authority.
3. **T343** — remove the orphaned root image.

## Clean categories

Verified on the 2026-07-16 rescan; caveats point to the corresponding open row:

- **Secrets, TLS, injection.** No credential in the tree; all external services are keyless. Every runtime endpoint is `https://`, and `ioUtils.js:347` cancels a request *before* a redirect to plain `http` goes out, because the query string carries the user's location. No `set_markup`/`use_markup` anywhere; Cinnamon's own `Tooltip.set_text` calls `set_use_markup(false)`. Both inline-`style` sinks pass through `styleUtils.safeCssColor` — **fuzzed with 11 payloads** (`red; background-image: url(…)`, `)}*{background:red}`, `expression(alert(1))`, newline smuggling): every one returned `"transparent"`. Every subprocess is argv-form; `launchUuid` writes `"--uuid=" + uuid` as one argument so a feed-supplied UID beginning with `-` cannot be parsed as an option. No `eval`/`Function`/dynamic import; no SQL.
- **Untrusted-input bounds.** Body size capped twice (declared `Content-Length` refused before the read; the stream aborted at 4 MiB, which closes the chunked-transfer hole). Non-object JSON coerced to `null`. Every provider normalizer checks `Number.isFinite`/`Array.isArray` before use. Prototype pollution **tested**: a cache file containing `{"__proto__":{…}}` leaves `Object.prototype` untouched; the event list already uses `Object.create(null)` for feed-supplied UIDs. The disk loader also caps accepted holiday rows before expanding or indexing them.
- **Cache file safety.** Fixed filename under `GLib.get_user_cache_dir()`; no user or remote input in the path; dir `0700`; `REPLACE_DESTINATION` unlinks-and-recreates rather than writing *through* a planted symlink; etag-guarded merge with a bounded retry loop; every row re-validated on load, including the future-stamp check.
- **Egress containment and disclosure.** Weather is off by default; holidays may auto-enable from the local timezone and can be disabled with `None`. The world-clock **display name never leaves the machine**: only the IANA-derived city is geocoded, so a clock labelled "Mom's place" stays local. Calendar event summaries and hostnames never leave. Every log line is stripped of its query string (`_urlForLog`). README's egress list is an **exact** match for the 8 hosts in the source.
- **Timers, signals and teardown *of resources*.** Drove both weather providers through `destroy()` with requests in flight and retries armed, under a fake GLib loop tracking every id: zero leftover sources, zero `source_remove` on an unknown id, zero late callbacks. Generation counters abandon superseded work. Cinnamon's `XletSettingsBase.finalize()` covers the settings signals. (What teardown does **not** do is release the *data* — T463.)
- **Backoff and retry.** 24 h of simulated total failure: 54 attempts, no runaway; `backoffDelay` caps at the refresh period and adds jitter on top of the cap; `MAX_RETRY_ATTEMPTS = 8`; every HTTP path sets `timeout` + `idle_timeout` = 30 s. The holiday state machine never wedges: 20 rapid `_update()`s after a total failure issue 0 extra fetches.
- **Main-loop hygiene.** Startup tzdata inference is deferred out of applet construction. No sub-minute periodic timer: `notify::clock` fires only when the rendered string changes (0 emissions in 10 s with `%H:%M`). The idle tick is **1.3 µs, zero allocations**. The 42 grid cells are built once and mutated; dots are diffed by key; every label write has an equality guard. Heap delta after 200k `_update()` calls: **98 KiB** (flat). No `Intl.DateTimeFormat` in any loop.
- **Settings-schema → runtime parity.** All 17 keys are bound and acted on; all 60 locally declared countries agree across schema, `SUPPORTED_COUNTRIES` and `COUNTRY_TO_ISO2`; `has_region`'s 10 entries match `REGION_TO_SUBDIVISION`; every region option has a subdivision mapping and there are no orphan table entries; `MAX_CLOCKS = 8` agrees across `worldclockData.js`, `cityWeather.js` and `settings_widgets_common.py`; every `dependency` in the schema is honoured by Cinnamon for custom widgets too.
- **Keyboard navigation of the day grid.** Roving focus (one tab stop), arrows/PageUp/PageDown/Home, RTL mirroring of Left/Right, focus moved into the grid on menu open, focus rings for every focusable actor. Genuinely good.
- **The gates themselves.** The JS coverage gate holds every file to 98/90/100 *and* globs the shipped tree from disk to fail any `.js` no test loads — a hole was looked for and not found. The eslint gate lints real text through the real config to prove `no-unreachable`/`no-dupe-keys`/`no-cond-assign` fire. `lint:py` genuinely exits 1 when pyflakes is missing. The `.pot`'s **msgid set is complete** (zero missing across all JS, the schema and both Python files). No `Lang.bind`, `imports.byteArray`, `toLocaleFormat`, `Soup.SessionAsync` or `queue_message` anywhere.
- **Not applicable**: database / migrations, multi-tenancy, Electron, Rust, ML / retrieval / RAG, vectorization, CLI surface, SQL injection, CORS/CSRF, prompt injection.

## Rejected

| id | finding | why rejected |
|----|---------|--------------|
| R01 | `dtEquals` duplicated between `eventData.js` and `eventFormat.js`. | Deliberate boundary: `eventFormat.js` stays free of GJS imports so it is Node-pure. Centralizing re-couples the modules for a one-line function. (Re-raised by the 2026-07-13 architecture scan; re-rejected.) |
| R05 | Barrel re-exports as the GJS `var` bindings importers need. | The re-exports **are** the import mechanism; tests reach the modules through them. |
| R06 | `eventView.js:70`: commented-out `Util.trySpawn(["gnome-calendar"])`. | Deliberate documented switch with a maintainer note directly above it. |
| R08 | No watchdog/metrics/circuit-breakers/health surface. | For a panel applet these are reasonable omissions; the three-provider failover with last-success ordering plus a per-year freshness gate is a coherent substitute. |
| R09 | Per-calendar colour strip conveys calendar identity by colour alone. | Not actionable here: `cinnamon-calendar-server` sends the calendar's colour and never its display name, so there is no name to announce. The strip is `Atk.Role.SEPARATOR` so a screen reader skips it. Needs an upstream change. |
| R10 | Panel label written with no compare-before-assign. | **[verified]** The tick is not 1 Hz: `WallClock` emits `notify::clock` only when the rendered string changes (0 emissions in 10 s with `%H:%M`), so the handler never sees the same string twice. |
| R11 | `validDateParts`' **year** and **day** integer guards look unasserted (both mutants survive). | **Equivalent mutants.** An exhaustive witness search over 15 hostile value types found no distinguishing input: `d.getFullYear() === parts.year` and `d.getDate() === parts.day` compare strictly against the raw value, so the roundtrip check subsumes them. Only the **month** guard, whose comparison coerces (`"5" - 1`), is load-bearing — that one is T470. |
| R12 | The suite depends on the host timezone. | Ran the full JS suite under `TZ=Pacific/Auckland`, `TZ=America/Sao_Paulo`, `TZ=UTC`: 738/738 in all three. `test/helpers/clock.js` freezes the wall clock and the tests pin `LOCAL_TIMEZONE` explicitly. |
| R13 | `metadata.json` is missing `icon` / `author`. | Cinnamon's `requiredProperties` for an applet are `uuid`, `name`, `description`; `author` belongs in `info.json` per the Spices spec, and is there. `max-instances: -1` is valid. |
| R14 | The `5.4/` shims are indirection; the root modules "depend on files that only exist in the parent". | Intended and correct on every declared version: `appletManager.js:61` roots `imports.ui.appletManager.applets[uuid]` at the *applets folder*, so `[uuid]` is the parent dir. The seven-line shims work, and `gjs_import.test.js` pins them. (The forward-compat risk is T464, which is about `require`, not the shims.) |
| R15 | `settings_widgets_common.py` at 991 lines is a god module. | Many concerns, but they are all "the settings dialog"; the gi-free half is already extracted into `timezone_data.py`, and no change was identified that becomes dangerous because of the co-location. |
| R16 | `metadata.json` omits Cinnamon 6.6, so the applet is incompatible with the installed desktop. | Rejected after checking Cinnamon 6.6.7's loader: `cinnamon-version` entries are minimum compatible versions, and the declared 5.4 entry admits 6.6. The compatibility test now models that loader rule directly. |

## Recorded decisions

| id | decision |
|----|----------|
| D01 | Keep the third-party endpoints rather than a bundled data set or a single vendor. A bundled table goes stale and covers fewer countries; a single provider breaks whenever it is down — the fallback chain exists because the primary is a hobbyist service. Risk accepted with mitigations (weather opt-in; one-time local-tzdata holiday default with visible third-party disclosure and explicit disable/override; size caps; bounded spans; shape checks in and out of cache; colour filtering; no URL logging). |
| D02 | **Keep the widened export surface.** ~80 exported names have no cross-module consumer — used inside their own file and otherwise only by `test/`. The applet runs inside a compositor where a bug costs the whole session; testing only through the composition root would be slow and flaky. **This does not license the inverse:** production must not bend to a test double's shape. |
| D03 | **`author` is the display name "Geraldo Netto", not the GitHub handle.** `info.json`/`package.json` use "Geraldo Netto"; `schema_static.test.js` asserts it. The Spices convention prefers the handle, but the display name is the maintainer's explicit choice. |

## Resolved merge choices

Decisions from the calendar@ccprog / Simon Wiles merge. Kept so future audits do not re-pick them.

| id | resolution |
|----|------------|
| G01 | Kept the `calendar@ccprog` world-clock settings workflow (Cinnamon-native settings, up to 8 user clocks plus built-in UTC/local, region/city selection, IANA/city entry, timezone validation, inherited coverage). Simon Wiles' separate GTK editor remains unported. |
| G02 | Kept `calendar@ccprog` locale-aware weekend behaviour (locale-derived work weeks plus a configurable one- or two-day weekend length). |
| G03 | Kept the copied `calendar@ccprog` visual assets as the initial merged set. The Chronos screenshot was refreshed on 2026-07-16; the unrelated root `calendar.png` remains tracked for removal under T343. |
