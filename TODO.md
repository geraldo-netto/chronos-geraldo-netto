# chronos@geraldo-netto TODO

Audit ledger for this applet. Full-source rescan on 2026-07-12 (fresh pass) against every `0domains/` review category **including the special ones — wiring gaps, unused functions/methods, legacy/deprecation, and variable/function scope**. Run blind: eight parallel scanners (security/data-governance, reliability/state-machines, wiring-gaps/dead-code/scope, architecture/duplication, testing/fuzzing, UI/accessibility/i18n, performance/memory, docs/packaging/release) each read the source **without this ledger**, and their findings were merged and deduplicated afterwards.

**This pass discovered the ledger it inherited was written against a different repository.** The previous TODO described "the 131-commit batch that closed T269–T350" and a Critical (T351) about `.github/workflows/chronos-geraldo-netto.yml`. Neither exists: `git log` is **13 commits** ("Initial commit" plus a fresh feature history), and `.github/` has **never** been added in any commit (`git log --all --diff-filter=A -- '.github/**'` is empty). The repo was re-initialised since the old ledger was written, so its line numbers and several premises were stale. The stale CI cluster is reconciled below.

**Findings verified by running or mutating the code are marked [verified]**, each naming the experiment.

Baseline: `npm test` green (JS coverage per-file 98/90/100, Python 98 %+), `npm run lint` clean — and CI runs both on every push and pull request (T440), so the green baseline is no longer a local fact.

A batch on 2026-07-12 closed 27 of the findings (see `git log`): the six README fixes, the makepot `cd`, the single-sourced constants, the i18n trio, the dead `_urlForLog`, the lazy city Soup session, the tooltip-key seconds, the locale-subprocess reap, the chunked-response cap, the geocode fan-out pool, the JS/Python timezone-city parity, the logind resume, the holiday refetch-storm, the C→F unification, the five complexity splits, the `updateFormatString` table, the calendar-server proxy encapsulation, the EventList seam, the coverage-gate honesty fix, and the ATK-description fix. Five of that batch's targets were **parked** rather than done — the heavy reorganizations, all Medium and none a live bug. All five have since landed (T442, T444, T445, T446, T448).

Open items: 10 (Critical 0, High 0, Medium 3, Low 7).

## Findings

### High

None open.

### Medium

| ID | Category | Severity | Status | Effort | Description | Notes |
|----|----------|----------|--------|--------|-------------|-------|
| T434 | testing / host-dependence | Medium | open | S | **[verified]** 16 tests are `@requires_pytz`-skipped; on a host without `python3-pytz` the suite reports `OK (skipped=16)` and the line gate stays green because other tests touch those lines — so whether the primary timezone-resolution path is tested at all depends on an optional package. Separately, `test_settings_widgets.py:1186` asserts the completion for `"buenos ai"` is **exactly** `["America/Argentina/Buenos_Aires"]`, which fails on a tzdata build that still carries the `America/Buenos_Aires` alias. | Verified: blocking `import pytz` → `OK (skipped=16)`, gate still green; a zoneinfo-backed pytz with the legacy alias → the exact-list assert fails. Fix: feed these tests a fixed fake `pytz` (the pattern at `:936`) so they run unconditionally, or hard-require pytz. (Supersedes the old T358, whose "red in CI" premise assumed a CI that does not exist.) |
| T439 | packaging | Medium | open | S | **[verified]** `5.4/icon.png` is committed as a git **symlink** (mode `120000` → `../icon.png`), not a file. Symlinks are fragile in a published xlet: zip/tarball delivery and some install paths do not preserve them, leaving the applet iconless. There is also no `icon.png` at the applet root. | Verified: `git ls-files -s` → `120000 …`. (This is the "duplicate icon" the old ledger waved off as convention — it is a symlink, which is the actual risk.) Fix: replace with a real copy, and place a root `icon.png`. |
| T449 | test complexity | Medium | open | M | **[verified]** Five test bodies exceed the forbidden 15 (the rule applies to tests): `holidays.test.js:1970/2058/2164` = 22 each, `schema_static.test.js:399` = 17, `eventData.test.js:355` = 16. Each fuzz body re-derives the expected classification inline, so its oracle is a second hand-rolled copy of the validator it tests — both can be wrong the same way. | Verified: espree + SonarSource walker. Fix: hoist the junk-payload tables to module scope and extract the per-row expectation into a named pure helper, leaving the body a loop + one assert. |

### Low

| ID | Category | Severity | Status | Effort | Description | Notes |
|----|----------|----------|--------|--------|-------------|-------|
| T455 | dead code | Low | open | S | **[verified]** `cityWeather.js:34` `CITY_STALE_AFTER_SECONDS` is computed at load and exported, but production reads none of it — `CityWeatherProvider` computes its own threshold at `:54`. Only `cityWeather.test.js` reads it. | Verified by grep. Fix: delete the constant and its `module.exports` entry. |
| T461 | testing / validation | Low | open | S | **[verified]** `settings_widgets_common.py:818` `looks_like_iana`'s character-class check (`ch.isalnum() or ch in "_+-"`) is never exercised — it is the only validation of a typed timezone when no tz database is present, and every no-db test input passes both checks or is rejected by the length check first. A garbage value shaped `Area/City baz` would be accepted and saved as a timezone. | Verified: mutating the return to `True` left all Python tests passing; mutating the length guard was killed. Fix: add a no-db `normalize()` case with a 2–3 segment value containing spaces/punctuation, assert `None`. |
| T343 | packaging | Low | open | S | **[verified]** `calendar.png` is a tracked 48×48 orphan at the repo root; nothing references it (grep across js/json/md/py/css is empty) and it is not the icon (different md5 from `files/chronos@geraldo-netto/icon.png`). It would ship in a Spices submission as dead weight. | Inherited from `calendar@ccprog`. Fix: delete, or promote to the root `icon.png` T439 needs. |
| T411 | testing | Low | open | S | `test/calendar.test.js:369,523,1504` and `test/holidays.test.js:638,684,814,863` use `new Date()`/`Date.now()` with no injected clock; the holiday-cache freshness tests recompute `new Date().getFullYear()` **in the assertion**, so a run straddling New Year's Eve can disagree with the code under test. | Overlaps T434's determinism theme. Fix: inject a fixed clock. |
| T412 | testing | Low | open | S | `test/calendar.test.js:30`: the `ScrollDirection` double `{UP:0,LEFT:1,DOWN:2,RIGHT:3}` does not match Clutter's ordering and **omits `SMOOTH`** — what a touchpad emits — so the default branch of `_onScroll` is never exercised with the value a real device sends. | Another double that does not match its API. See T374. |
| T413 | testing | Low | open | S | `weather.js:193` `Math.min(this._retry_attempts + 1, MAX_RETRY_ATTEMPTS)` can be replaced with a bare increment and the suite stays green (equivalent mutant, but the exhaustion clamp itself has no test). | Fix: assert the clamp at the boundary. |
| T414 | testing | Low | open | M | `test/applet_static.test.js` and `test/schema_static.test.js`: a large share are `assert.match(sourceText, /regex/)` over the source file — they lock text, not behaviour, and sit outside the coverage gate. | They do catch the GJS `var`-export rule (a real, otherwise-untestable constraint); the rest should be behavioural. |

## Suggested order

The 2026-07-12 batch closed the live defects, the i18n regressions and the docs/packaging quick wins. What remains:

1. **T434, T449** — the tests that lie; each is a bug free to come back. (The gates themselves are real now: CI runs them, T440.)
2. **T439** — the last packaging blocker to a first release or Spices submission (the icon symlink).
3. Everything else, severity order.

## Clean categories

Verified with no findings on the 2026-07-12 fresh rescan:

- **Secrets, TLS, injection.** No API key, token or credential in the tree. Every endpoint `https://`. No `set_markup`/`use_markup` anywhere — every remote and EDS string reaches a non-parsing St sink. Both inline-`style` sinks pass through `styleUtils.safeCssColor`, whose anchored allowlist admits no `;` and no `url(`. Every subprocess is argv-form (`trySpawn` prefixes `--uuid=` to defuse option injection); the two `spawnCommandLine` calls are static strings. No `eval`/`Function`/dynamic import; no SQL. Every query parameter is `encodeURIComponent`'d and query strings are stripped from all log lines. `joinPhrases`/`_fillTemplate` are hardened against `%s`/`$&` replacement-pattern injection.
- **Untrusted-input bounds** (except the chunked-encoding gap, T452): declared *and* actual body size capped at 4 MiB (the gap is chunked responses with no Content-Length); non-object JSON coerced to `null`; holiday names clamped to 300 chars, event summaries to 300, clock labels to 24, panel suffix to 48; geocode cache 16, month memo 32, cached countries 4, holiday spans 366 days.
- **Cache file safety.** Fixed filename under `GLib.get_user_cache_dir()` — no user or remote input in the path; dir created `0700`; writers pass `REPLACE_DESTINATION`, so a planted symlink is replaced, not followed; every row re-validated on load, including the future-stamp check in `stale()`. `Object.create(null)` for the UID index defuses a `__proto__` UID.
- **Consent and egress defaults.** Both networked features are off by default (`show-weather: false`, `country: "none"`), unknown countries re-asserted to `none` at startup, and the world-clock **display name never leaves the machine** — only the IANA-derived city is geocoded. README fully discloses what leaves the machine and the retention bounds.
- **Teardown and generation guards.** Every `timeout_add`/`idle_add` id is stored and removed on a path reachable from `on_applet_removed_from_panel`; all Soup sessions `abort()`ed; signal connect/disconnect is symmetric across enable/disable/reload; each teardown step is isolated so one throw does not strand the rest. Generation counters (`_request_generation`, `_isCurrent`, `_isCurrentPlace`, the fallback liveness check, `_holiday_update_generation`) all abandon superseded async work. The three teardown methods score 11–18 on the cognitive-complexity walker but that is a Sonar artefact of counting nested arrows — self-complexity is 1–2; the `[...steps]; for step try step()` pattern is deliberate, not a finding.
- **Backoff and retry.** A 6-hour virtual-clock simulation under permanent failure did 30→60→…→1800 s capped backoff then settled to the refresh period (18 calls in 6 h, no runaway). Jitter is present for lockstep on the backoff path (the initial geocode fan-out is the one gap — T454). Every HTTP path sets `timeout`+`idle_timeout`=30 s.
- **DST and date math.** `_buildDays`, `expandHoliday`, `_formatJsDate` all anchor at 12:00 before day arithmetic; staleness uses wall-clock `Date.now()` so it survives suspend and marks post-sleep readings ⚠. The Rome spring-forward and fall-back are tested through a real `Intl` conversion in `worldclocks.test.js` (T374).
- **Settings-schema → runtime.** Every current schema key is read and acted on; `format-button` resolves to `on_custom_format_button_pressed`; `has_region`'s default matches `ENRICO_REGION_TO_COUNTY` and the country combobox matches `SUPPORTED_COUNTRIES`; `region_*`/`has_region` are reached at runtime via `REGION_KEY_PREFIX + country` concatenation (grep-false-positives, not gaps). The ten `5.4/*.js` shims are whole-module pass-throughs, so no per-symbol drift is possible.
- **Signal wiring, including the calendar nav buttons (T359).** Renaming/breaking the signals — `enter-event`, `start-pass-events`, day-cell `clicked`, country `changed::`, `open-state-changed`, `view-event`, calendar-server `connect`, Soup `restarted`, the label clamp — each failed the suite. The month/year nav buttons now fail it too; scroll is still tested by direct call.
- **Not applicable**: database / migrations, multi-tenancy, Electron, Rust, ML / retrieval / RAG, vectorization, CLI surface, SQL injection, CORS/CSRF, prompt injection.

## Rejected

| id | finding | why rejected |
|----|---------|--------------|
| R01 | `dtEquals` duplicated between `eventData.js` and `eventFormat.js`. | Deliberate boundary: `eventFormat.js` stays free of GJS imports so it is Node-pure. Centralizing re-couples the modules for a one-line function. |
| R05 | Barrel re-exports as the GJS `var` bindings importers need (`utils.js` `readJsonFile`/`writeJsonFile`; alias-only weather re-exports). | The re-exports **are** the import mechanism; tests reach the modules through them. Narrowing trades a real mechanism for cosmetic surface reduction. (Does **not** cover T455/T456, which are genuinely unread.) |
| R06 | `eventView.js:70`: commented-out `Util.trySpawn(["gnome-calendar"])`. | Deliberate documented switch with a maintainer note directly above it. |
| R08 | No watchdog/metrics/circuit-breakers/health surface. | For a panel applet these are reasonable omissions; the three-provider failover with last-success ordering plus per-year freshness gate is a coherent substitute. |
| R09 | Per-calendar colour strip and event dots convey calendar identity by colour alone. | Not actionable in the applet: `cinnamon-calendar-server` sends the calendar's colour and never its display name, so there is no name here to announce. The colour strip is marked `Atk.Role.SEPARATOR` so a screen reader stops announcing it. A real fix needs an upstream calendar-server change. |
| R10 | Panel label written with no compare-before-assign → wasted `St.Label` relayouts. | **[verified] The tick is not 1 Hz.** `CinnamonDesktop.WallClock` emits `notify::clock` only when the string it renders changes: measured 0 emissions in 10 s with `%H:%M`, 11 with `%H:%M:%S`. Seconds are in the format only when `clock-show-seconds` is set, so the handler never sees the same string twice — no redundant writes for a guard to skip. (The tooltip key, T451, is the real residual, and it is JS-only waste.) |

## Recorded decisions

| id | decision |
|----|----------|
| D01 | Keep the six third-party endpoints (three holiday providers, two forecast providers, two geocoders) rather than a bundled data set or single vendor. A bundled table goes stale and covers fewer countries; a single provider breaks whenever it is down — the fallback chain exists because the primary is a hobbyist service. Risk accepted with mitigations (opt-in + default-off, size caps, bounded spans, shape checks in and out of cache, colour filtering, no URL logging). Residual gaps are T452/T454. |
| D02 | **Keep the widened export surface.** ~80 exported names have no cross-module consumer — used inside their own file and otherwise only by `test/`. None is dead: every one is alive at runtime. The applet runs inside a compositor where a bug costs the whole session and its collaborators are DBus, six holiday/forecast/geocode services, a settings dialog in another process and a locale subprocess; testing that through the composition root alone would be slow and flaky. Revisit only if exports get consumed outside tests. **This does not license the inverse:** a production field or fallback branch that exists only to fit a mock's shape is the code bending to the test, which D02 never covered. |
| D03 | **`author` is the display name "Geraldo Netto", not the GitHub handle.** `info.json`/`package.json` use "Geraldo Netto"; `schema_static.test.js` asserts it. The Spices convention prefers the handle `geraldo-netto` (used in the repo/bugs/homepage URLs and the package author URL), but the display name is the maintainer's explicit choice. The missing `uuid` key (T437) is a separate, real gap. |

## Resolved merge choices

Decisions from the calendar@ccprog / Simon Wiles merge. Kept so future audits do not re-pick them.

| id | resolution |
|----|------------|
| G01 | Kept the `calendar@ccprog` world-clock settings workflow (Cinnamon-native settings, up to 8 user clocks plus built-in UTC/local, region/city selection, IANA/city entry, timezone validation, inherited coverage). Simon Wiles' separate GTK editor remains unported. |
| G02 | Kept `calendar@ccprog` locale-aware weekend behaviour (locale-derived work weeks plus a configurable one- or two-day weekend length). |
| G03 | Kept the copied `calendar@ccprog` visual assets (icon, screenshot, calendar image) as the complete existing set for the merged applet. |
