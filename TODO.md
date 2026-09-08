# TODO

## Open

| id | status | severity | effort | description |
| --- | --- | --- | --- | --- |
| T1123 | open | medium | s | Preserve event-index overflow uncertainty until missing events can be reconciled in eventIndex.js:425–431. A native GLib reproduction distributes 2,001 events across 42 days, exceeding the 2,000-event admission limit; removing one indexed event drops the index to 1,999 and clears overflow while the final day's only event remains omitted. Ordinary removal through EventMutationStream does not refetch. Retain the warning until an authoritative refresh or refill freed capacity before clearing it; cover overflow across multiple calendar days, where the per-day display limit does not mask the missing event. |
| T1122 | open | medium | s | Reflow the popup on actual work-area changes in 6.0/appletLifecycle.js:456–469. Cinnamon 6.6.9 emits global.display workareas-changed when panel sizes change, while Main.layoutManager monitors-changed does not fire. In an isolated 1366×768 session at text scale 1.5, changing from a 40px bottom panel to supported 60px top/bottom panels leaves the open menu 655px tall in a 648px work area, extending above its boundary with stale viewport limits. Own and disconnect the workareas-changed signal, reflow after geometry settles, and retain the monitor signal for actual monitor changes. |
| T1121 | open | medium | m | Preserve keyboard focus during structural agenda updates in 6.0/eventView.js:98,644–645. In isolated native Cinnamon, focusing surviving event Meeting1 and receiving another event triggers a full row rebuild, destroys the focused actor, moves focus to MetaStage, and closes the popup even though Meeting1 remains. Reconcile surviving row actors or transfer focus without transient escape from the menu; verify additions/removals while a surviving event has keyboard focus. The unchanged-revision time-reorder preservation does not cover this path. |
| T1117 | open | medium | s | Normalize both event-fetch civil-day boundaries independently in eventWindow.js:40–43. With America/Asuncion, Monday week start, and October 2023, the real GLib midnight gap makes the request run from September 25 at 01:00 through November 6 at 00:59:59. A September 25 00:15–00:45 event in the visible grid is omitted, and the range spills into a 43rd day. Normalize the derived first day and the day after the final cell before subtracting one second; cover midnight-transition months with native date behavior. |
| T1116 | open | medium | s | Align additional-country validation and duplicate handling between calendarSourceAdapters.js:23–38 and chronos_settings_widgets_calendars.py:29–37,75–87. Runtime enables Italy for a numeric region or enabled:0, while opening settings rejects and rewrites these rows. A disabled Italy row followed by an enabled duplicate is active in JavaScript but becomes disabled after Python normalization. Adopt one strict type/default/deduplication policy and share malformed-input and disabled-duplicate fixtures across runtimes. |
| T1114 | open | medium | m | Provide management/removal and deselection of unavailable personal calendar plugins separately from available calendar choices. chronos_settings_widgets_calendars.py:296–305 hides expired plugins and disables Remove, while chronos_calendar_plugin_data.py:210–211 counts their files toward the 32-plugin limit. With 32 expired manifests the list is empty and importing a current replacement is refused; 32 retained hidden selection IDs can also prevent enabling replacements. Preserve automatic hiding of invalid ranges while allowing their occupied slots to be reclaimed through settings. |
| T1113 | open | medium | s | Guard world-clock Add/Edit dialogs against external list changes in chronos_settings_widgets_worldclocks.py:640,774–784. Editing Paris, importing/resetting the list to Tokyo while the modal is open, then saving makes Cinnamon's native TreeListWidgets.edit_item reuse an invalid iterator and emit gtk_list_store_set_value assertions; the edit disappears. Opening Add before an external update fills eight slots also allows saving a ninth clock through native add_item. Track list revisions and revalidate acceptance/capacity before native mutation, preserving the external list as AdditionalCountryList already does. |

## Blocked / Deferred

| id | status | severity | effort | description |
| --- | --- | --- | --- | --- |

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
| R14 | rejected | — | — | The 6.0 versioned loaders import root modules through Cinnamon's applet-folder namespace; the deployed Cinnamon 6.6 desktop requires this module mechanism, covered by import tests. |
| R16 | rejected | — | — | Cinnamon-version entries control minimum admission independently of versioned-directory selection; metadata admits the verified Cinnamon 6.6 series while its loader selects 6.0/. |
| R17 | rejected | — | — | icon-size is a valid St theme property used by Cinnamon itself, so Sonar's browser-CSS warning is a false positive. |
| R18 | rejected | — | — | Sonar's tooltip, lexical-sort, optional-path regex, and reduce findings are false positives: lifecycle callbacks retain tooltips and the other behaviors are deliberate and tested. |
| R19 | rejected | — | — | Sonar's reported test-helper vulnerabilities are not shipped boundaries: /tmp/cache is an in-memory double value and the harness invokes the already-trusted Node executable. |
| R20 | rejected | — | — | GJS export bindings, deliberate test doubles, and local style are not defects by themselves; change them for a concrete behavior or maintenance benefit. |
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
