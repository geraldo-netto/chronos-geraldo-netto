# TODO

## Open

| id | status | severity | effort | description |
| --- | --- | --- | --- | --- |

## Blocked / Deferred

| id | status | severity | effort | description |
| --- | --- | --- | --- | --- |
| T937 | blocked | medium | s | Exercise shipped JavaScript under Cinnamon 6.0's actual CJS runtime and import the versioned loaders. Current checks compile under installed CJS 115 and reproduce imports in a VM; real imports need Cinnamon GI/UI modules plus a pinned 6.0 runtime or live session. |
| T938 | blocked | medium | l | The maintainer must decide whether the repository carries a mutation runner. An assistant may add a runner, configuration, and scope selector, but mutation campaigns and survivor decisions remain maintainer-only. |
| T935 | blocked | medium | m | Verify the responsive popup on live Cinnamon at 1366×768, 2× scale, 1.5 text scale, long de/ru strings, and both panel orientations. Confirm layout choice, minimum agenda height, keyboard order, and stacked spacing; arithmetic tests cannot establish the rendered pixels. |
| T995 | blocked | low | xs | Decide whether HolidayCache.recordFetch judges a provider Date header against receive time strictly, allows a specified future-skew window, or keeps wall-clock validation. The choice changes the pinned future-header behavior. |
| T1013 | blocked | low | xs | Decide whether one malformed zone.tab row aborts country inference or is skipped. Logging is implemented; skipping preserves other valid rows, while aborting treats the whole table as untrusted. |
| T1016 | blocked | medium | xs | Chain per-user and system gettext catalogs so a stale user catalog can fall back to newer system messages. This remains blocked while i18n is out of scope; test a msgid present only in the second catalog. |
| T740 | deferred | — | — | Publish post-2027 dates for non-Hebrew religious observances only when a named tradition and authoritative calendar are chosen. Islamic, Baha'i, Hindu, Jain, Buddhist, Sikh, and Chinese conventions diverge; do not extrapolate one civil date as universal. |
| T1027 | deferred | — | — | Decide whether ioUtils.readTextFileCapped must preflight file size before reading root-owned /etc/timezone and zone.tab, or whether the no-unbounded-read rule applies only to attacker-influenceable paths and should say so. |
| T1028 | deferred | — | — | Decide whether weatherScheduler's one-shot retry callback should catch and log refresh exceptions like the periodic callback, or deliberately let retry failures escape and document that asymmetry. |
| T1029 | deferred | — | — | Decide whether weather reading and geocode caches intentionally share a cap. If independent, derive the reading cap from the maximum clocks plus the panel location and pin that relation in a test. |
| T1030 | deferred | — | — | Decide whether WeatherProvider's first request-generation increment is required to invalidate an in-flight answer before an injected scheduler eventually refreshes, or whether the synchronous double increment should be removed. |
| T1031 | deferred | — | — | Specify the intended prefix and suffix wording for event ranges before consolidating four near-duplicate formatters; their branch order differs and a blind merge changes multi-day labels around the four-day window. |
| T1032 | deferred | — | — | Confirm how Cinnamon 6.0 and current GJS treat an exception from a gboolean GLib source callback. If it is not guaranteed to remove the source, make eventMutationStream return SOURCE_REMOVE in a finally block so recovery cannot leave an orphan idle. |
| T1033 | deferred | — | — | Instrument a live Cinnamon theme whose dot-box width follows content and determine whether requesting a full calendar render from the allocation callback can oscillate. Static reasoning says it converges but cannot prove the toolkit behavior. |
| T1034 | deferred | — | — | Confirm whether a post-resync calendar fetch always emits at least one add. If an empty fetch is possible, fetch-complete must bypass eventMutationStream's resync drop so reconciliation and GC are still scheduled. |
| T1035 | deferred | — | — | Decide whether production should continue writing HolidayService status through last_error and last_provider accessors or write directly to HolidayStatusLedger and leave read-only getters for tests. |
| T1036 | deferred | — | — | Choose one IS_NODE bootstrap-comment convention across the six holiday modules: keep the full explanation everywhere, or keep bare expressions and one canonical explanation. |
| T1037 | deferred | — | — | Decide whether the 26 two-line guarded applet handlers should remain individually greppable and breakpointable or become a dispatch table that removes about fifty lines of boilerplate. |
| T1038 | deferred | — | — | Decide whether DesktopSettings belongs in a separate facade from the AppletSettings wrappers. Splitting clarifies different lifetimes but requires a version shim and two call-site edits; T1003 must still be fixed either way. |
| T1039 | deferred | — | — | Decide whether SettingsWindowCenterer should retain and cancel its GLib idle source on widget destruction. The current source is bounded to 100 attempts but keeps the destroyed widget tree alive until it stops. |
| T1040 | deferred | — | — | Confirm whether cinnamon-settings can rebuild an xlet page while its JSONSettingsHandler survives. If so, add teardown for widget listeners so callbacks cannot target finalized GTK objects. |
| T1041 | deferred | — | — | Decide whether the single global completion memo is sufficient when weather and country matchers coexist, or replace it with a small per-key map; also align WeatherLocationEntry with attach_completion's on_selected convention. |
| T1042 | deferred | — | — | Decide whether ClockEntrySerializer should derive column order from the schema instead of hard-coding CLOCK_COLUMN_IDS. A schema column reorder currently breaks positional writes while the dialog still renders. |

## Rejected / Won't fix

| id | status | severity | effort | description |
| --- | --- | --- | --- | --- |
| T774 | wont_fix | — | — | The shipped paryushana-start dates do not consistently match a Jain tradition, and the key names no sect. The maintainer declined choosing one; revisit only when the encoded tradition is named. |
| T775 | wont_fix | — | — | Guru Gobind Singh Jayanti cannot fit one Gregorian date per year without choosing a Sikh reckoning; active calendars can produce zero or two dates. The maintainer declined choosing one. |
| T776 | wont_fix | — | — | Do not implement Chinese observances without an in-tree ephemeris and a bounded authoritative range. ICU disagrees with validated civil dates near midnight, historical time standards differ, and future delta-T makes some dates undecidable; carrying that machinery was declined. |
| T816 | wont_fix | — | — | Do not duplicate every Python coverage percentage and override in contributor prose; the executable coverage gate remains authoritative. |
| R05 | rejected | — | — | GJS var barrel re-exports are the module import mechanism, not unused indirection, and tests reach modules through them. |
| R06 | rejected | — | — | The commented gnome-calendar spawn is a documented compatibility switch with an adjacent maintainer note. |
| R08 | rejected | — | — | A panel applet does not require watchdogs, metrics, circuit breakers, or a health surface; provider failover and freshness checks are proportionate. |
| R09 | wont_fix | — | — | The calendar color strip cannot announce a calendar name because cinnamon-calendar-server publishes only color. It is exposed as a separator so screen readers skip it; an upstream contract change is required. |
| R12 | rejected | — | — | The surviving religiousHolidays mutants are equivalent: exhaustive witnesses distinguish none, the hour never reaches the returned date, and the month guard is subsumed by row filtering. |
| R11 | rejected | — | — | The surviving validDateParts year/day guard mutants are equivalent because strict Date round-trip comparisons subsume them; only the coercing month guard is independently load-bearing. |
| R23 | rejected | — | — | The suite is not host-timezone dependent: its clock is frozen, LOCAL_TIMEZONE is explicit, and the full gate passes under widely separated timezones. |
| R13 | rejected | — | — | metadata.json need not contain icon or author; Cinnamon requires uuid, name, and description, while the Spices author belongs in info.json. |
| R14 | rejected | — | — | The 5.4 shims correctly import root modules through Cinnamon's applet-folder namespace; they are required compatibility indirection and covered by import tests. |
| R16 | rejected | — | — | Cinnamon-version entries are minimum versions, so the declared floor admits Cinnamon 6.6; loader-compatible tests pin that rule. |
| R17 | rejected | — | — | icon-size is a valid St theme property used by Cinnamon itself, so Sonar's browser-CSS warning is a false positive. |
| R18 | rejected | — | — | Sonar's tooltip, lexical-sort, optional-path regex, and reduce findings are false positives: lifecycle callbacks retain tooltips and the other behaviors are deliberate and tested. |
| R19 | rejected | — | — | Sonar's reported test-helper vulnerabilities are not shipped boundaries: /tmp/cache is an in-memory double value and the harness invokes the already-trusted Node executable. |
| R20 | rejected | — | — | The mass var and modern-syntax findings are compatibility-sensitive GJS bindings, deliberate test doubles, or local style; wholesale rewriting would risk the runtime floor without changing behavior. |
| R21 | rejected | — | — | The two end-whitespace regexes receive bounded inputs, so their theoretical backtracking does not create an unbounded workload and a separate rewrite adds no mitigation. |
| R24 | rejected | — | — | An empty holiday response is trusted only when every provider agrees. Preferring one empty response over another provider's failure would cache unsupported countries as holiday-free and make results depend on runtime provider order. |
| R25 | rejected | — | — | Applying the Open-Meteo population floor per candidate fixes Malmo but misroutes Genova to Guatemala. The current primary refusal plus typed-name-ranked Nominatim fallback resolves both correctly. |
| R22 | wont_fix | — | — | The maintainer declined replacing SonarCloud automatic analysis with scoped CI analysis; local and CI coverage gates remain authoritative. |
| R27 | rejected | — | — | Enumerating requested versus inflight locale queries is equivalent for reachable state because both maps are written and cleared together and cancellation guards on the inflight record. |
| R28 | rejected | — | — | EventIndex event-id and day maps are synchronized by register, remove, clear, and rebuild; their only temporary difference is inside one synchronous call and cannot be observed. |
| R29 | rejected | — | — | A resync retry cannot inherit a temporary overflow warning because the reload idle retires and publishes the marker before any retry runs. |
| R30 | rejected | — | — | Holiday annotation passes do not share live counters: every render advances a generation and stale callbacks return before mutating counters, credit, status, or cells. |
| R31 | rejected | — | — | The reported scan measured cyclomatic complexity, not the documented cognitive limit; JavaScript and Python cognitive-complexity gates already fail at 11. |
| R26 | wont_fix | — | — | Opening world-clock settings normalizes and rewrites saved rows, potentially discarding invalid, built-in, or ninth-and-later entries. The maintainer knowingly declined changing that behavior; reverse only by a new decision. |
