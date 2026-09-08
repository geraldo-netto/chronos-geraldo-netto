# TODO

## Open

| id | status | severity | effort | description |
| --- | --- | --- | --- | --- |
| T1109 | open | medium | m | Keep the popup usable when its natural size exceeds the real work area. Actual Cinnamon 6.6.9 at 1366×768, 2× display scale and 1.5× text scale allocates the horizontal menu at (-225,-598), size 1591×1286; headers and controls are offscreen. Constrain the popup/body to available space with accessible overflow/reflow, retain usable agenda height and keyboard access, and verify native allocations at both panel orientations. |
| T1108 | open | medium | s | Handle external additional-country settings changes while Add/Edit is open. If Reset/Import removes the edited row, _dialog_candidate calls existing.remove(original) and raises ValueError; native saved TreeModelRow/TreeIter references may also become invalid. Revalidate against current rows, keep or safely cancel the dialog with feedback, and cover removed/changed rows using the native list contract. |
| T1106 | open | low | s | Clear inline St styles with null rather than empty strings where Chronos triggers CSS parser criticals. Actual Cinnamon 6.6.9 startup/menu opening emits cr_parser_new_from_buf and cr_declaration_parse_list_from_buf failures; tracing _applyPanelFontScale confirms label.set_style(""). Locate the remaining applet-owned empty style assignments, fix them, and verify default/custom style resets in the actual runtime. |
| T1107 | open | medium | s | Check the weather retry generation before clearing its source ID. In WeatherRefreshScheduler, invoking a retired callback after a new schedule arms a retry resets the replacement _retry_id to zero, preventing stop()/succeeded() from cancelling it. Cover stale callbacks while a newer retry is active. |
| T1099 | open | medium | m | Merge concurrent holiday cache updates at the year/region snapshot level in holidayCacheRepository.js:289–292. Two applet instances loading the same country can overwrite one another: after B corrects 2026, A saves newly fetched 2027 plus its stale 2026 and restores the old dates. Etag retries merge whole countries and do not prevent this loss; preserve newer independent snapshots and explicit empty/removal updates with concurrent-instance regressions. |
| T1102 | open | low | m | Align runtime checks and support documentation with AGENTS.md's no-compatibility policy. scripts/check_python_compat.py still rejects post-3.10 APIs, CI maintains older-version matrix legs solely for floor coverage, and docs/mutation-testing.md justifies its dependency pin by the old Node floor. Verify the actual deployment/development runtimes, remove obsolete floor-only constraints and zoneinfo import shims, and reconcile stale minimum-version requirements in README.md and TODO.md. |
| T1074 | open | low | s | Clean up stale local dist/ deliverables and regenerate the intended Spices package from the committed index. dist/chronos@geraldo-netto and dist/working-tree/chronos@geraldo-netto omit 25 already tracked shipped files and differ in 66 others; the accompanying chronos-spices.tar and checksum also belong to the old output. |
| T1076 | open | medium | m | Bound aggregate holiday cache snapshots to the 4 MiB serialized write budget. Valid data within the country/year/row caps can exceed it (four countries with 1,095 permitted multilingual rows each serialize to about 6.6 MB); ioUtils.writeJsonFileAsync then skips the write while holidayCacheRepository._settleFlush discards pending data as if saved. Evict complete least-recent snapshots with their freshness stamps or preserve retryable updates, and cover byte limits in regressions. |
| T1080 | open | low | m | Define bounded retention or explicit cleanup for inactive calendar-<country>-<region>.json cache files. holidays.js creates a persistent file per visited pair, but removing a selection only releases memory; the four-country cap applies inside each file and does not bound the cache directory. Preserve active selections and files used by other applet instances when expiring unused caches. |

## Blocked / Deferred

| id | status | severity | effort | description |
| --- | --- | --- | --- | --- |
| T937 | blocked | medium | s | Exercise shipped JavaScript under Cinnamon 6.0's actual CJS runtime and import the versioned loaders. Current checks compile under installed CJS 115 and reproduce imports in a VM; real imports need Cinnamon GI/UI modules plus a pinned 6.0 runtime or live session. |
| T935 | blocked | medium | m | Verify the responsive popup on live Cinnamon at 1366×768, 2× scale, 1.5 text scale, long de/ru strings, and both panel orientations. Confirm layout choice, minimum agenda height, keyboard order, and stacked spacing; arithmetic tests cannot establish the rendered pixels. |
| T1028 | deferred | — | — | Decide whether weatherScheduler's one-shot retry callback should catch and log refresh exceptions like the periodic callback, or deliberately let retry failures escape and document that asymmetry. |
| T1029 | deferred | — | — | Decide whether weather reading and geocode caches intentionally share a cap. If independent, derive the reading cap from the maximum clocks plus the panel location and pin that relation in a test. |
| T1030 | deferred | — | — | Decide whether WeatherProvider's first request-generation increment is required to invalidate an in-flight answer before an injected scheduler eventually refreshes, or whether the synchronous double increment should be removed. |
| T1031 | deferred | — | — | Defer consolidation of the four event-range formatters to preserve the current prefix/suffix wording and branch-order behavior around the four-day window. Revisit only if the maintainer requests the refactor or revised labels. |
| T1032 | deferred | — | — | Confirm how Cinnamon 6.0 and current GJS treat an exception from a gboolean GLib source callback. If it is not guaranteed to remove the source, make eventMutationStream return SOURCE_REMOVE in a finally block so recovery cannot leave an orphan idle. |
| T1033 | deferred | — | — | Instrument a live Cinnamon theme whose dot-box width follows content and determine whether requesting a full calendar render from the allocation callback can oscillate. Static reasoning says it converges but cannot prove the toolkit behavior. |
| T1034 | deferred | — | — | Confirm whether a post-resync calendar fetch always emits at least one add. If an empty fetch is possible, fetch-complete must bypass eventMutationStream's resync drop so reconciliation and GC are still scheduled. |
| T1035 | deferred | — | — | Decide whether production should continue writing HolidayService status through last_error and last_provider accessors or write directly to HolidayStatusLedger and leave read-only getters for tests. |
| T1036 | deferred | — | — | Choose one IS_NODE bootstrap-comment convention across the six holiday modules: keep the full explanation everywhere, or keep bare expressions and one canonical explanation. |
| T1037 | deferred | — | — | Decide whether the 26 two-line guarded applet handlers should remain individually greppable and breakpointable or become a dispatch table that removes about fifty lines of boilerplate. |
| T1038 | deferred | — | — | Decide whether DesktopSettings belongs in a separate facade from the AppletSettings wrappers. Splitting clarifies different lifetimes but requires a version shim and two call-site edits. |

## Rejected / Won't fix

| id | status | severity | effort | description |
| --- | --- | --- | --- | --- |
| T1016 | wont_fix | medium | xs | Keep the current gettext catalog selection without per-message fallback from user to system catalogs; the maintainer declined translation changes. |
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
