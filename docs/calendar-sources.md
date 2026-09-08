# Religious calendar sources and coverage

Chronos hides a religion's entire calendar for a requested year when any of
its table-backed observances lacks a published date. This includes otherwise
fixed entries: after 2027, Hinduism does not show Makar Sankranti alone and
Buddhism does not show only Parinirvana and Bodhi Day. A calendar with complete
coverage remains available alongside calendars that are hidden.

The engine derives availability from the actual observances.
`availableReligionIds(year, enabledIds)` returns complete calendars;
`uncoveredReligions(year, enabledIds)` retains the missing-coverage diagnostic.
Both reject invalid years. The settings interface uses
[`religious-coverage.json`](../files/chronos@geraldo-netto/religious-coverage.json),
whose inclusive ranges are checked against the engine for every supported
year by the religious-holiday suite. Update the metadata and the dated
observances together when verified coverage changes.

| Built-in calendar | Complete supported years | Date basis |
| --- | --- | --- |
| Christianity | 1–9999 | Existing fixed Gregorian dates and Gregorian computus |
| Judaism | 1–9999 | Existing arithmetic Hebrew calendar and Omer calculation |
| Shinto | 1–9999 | Existing fixed Gregorian observances |
| Islam, Hinduism, Buddhism, Sikhism, Jainism, Taoism | 2025–2027 | Bounded published dates |
| Bahá'í Faith | 1844–2064 | Existing pre-2015 Western convention, then published Naw-Rúz dates; Ridván derived from Naw-Rúz |

These are the shipped calendars' computational and data limits. They do not
claim to cover every historical practice, locality, or tradition represented
by their broad labels. Expiration is handled by hiding the affected calendar;
the test suite verifies this behavior instead of failing merely because the
wall clock has passed a publication's last year.

Computed Hebrew observances retain their complete Gregorian dates and all
occurrences in the requested year. For example, Hanukkah has no start in 3031
and starts on both 1 January and 19 December 3032. A year with no occurrence of
an observance still has complete coverage. Tests check the civil-year mapping
for every year in the declared range, including the 9999 boundary.

## Shipped sources

The 2025–2027 tables were assembled from the
[Case Western Reserve University observance calendar](https://case.edu/studentlife/dean/interreligious-council-irc/religious-holidays-observances-calendar)
and [Xavier University multi-faith calendar](https://www.xavier.edu/jesuitresource/online-resources/calendar-religious-holidays-and-observances/multi-faith-calendar---next-year).
These are institutional accommodation guides. Dates can vary by community,
location, and moon sighting; their listings do not establish a universal
religious convention. Existing multi-day and sunset-starting observances
retain the encoded civil-day representation.

The [Bahá'í World Centre table for 172–221 BE](https://bahai-library.com/pdf/uhj/uhj_bahai_dates_172-221.pdf),
available through the Bahá'í Library mirror, ends its Naw-Rúz column at
**20 March 2064**. The February 2065 dates in that final row are Ayyám-i-Há,
not Naw-Rúz in 222 BE. The
[New Zealand Bahá'í guidance](https://guidelines.bahai.org.nz/wp-content/uploads/2022/07/GLSA-08-Holy-Days.pdf)
also describes the publication as extending through February 2065.
Chronos therefore stops Naw-Rúz and its derived Ridván at 2064.

## Replacement-source research

Sources checked on 8 September 2026 provide candidates for future calendars
that identify their tradition, locality, and intended observances. This
review did not verify a complete replacement for any of the generic
calendars that end in 2027. No post-2027 dates were added to those calendars.

| Candidate | Verified publication | Limits for adoption |
| --- | --- | --- |
| [Fiqh Council of North America](https://fiqhcouncil.org/calendar/) | Calculation-calendar month starts from 11 September 2018 through 12 October 2045, AH 1440–1467. For 2028, Ramadan begins 28 January and Eid al-Fitr is 26 February. | Suitable for an explicitly named FCNA calendar. Eid al-Adha follows the Saudi Supreme Court's determination and cannot be inferred as an authoritative future observance from month starts. A Mawlid convention would also need to be specified. |
| [Kauai monastery panchangams](https://minimela.org/panchang/) | City-specific calendars in PDF and ICS; latest checked period is 21 April 2027–8 May 2028. [Chennai ICS](https://minimela.org/wp-content/uploads/panchangam/2027-2028/world/chennai_india.ics) is one published locality. | South Indian monastery tradition, with standard-time calculations. Covers only part of Gregorian 2028 and includes daily material beyond festivals. It cannot replace a complete generic Hindu year. |
| [BAPS annual festival list](https://www.baps.org/Calendar/2026/FestivalList.aspx) | Verified 2026 publication from a named Hindu community. | No complete 2028 publication verified in this search. |
| [SGPC](https://sgpc.net/) | Nanakshahi calendar publication for 2026–2027. | No 2028 replacement verified. The previous decision against choosing a Sikh reckoning remains in effect. |
| [Shrimad Rajchandra Mission Dharampur](https://www.srmd.org/paryushan) | Paryushan publication for 8–15 September 2026. | No 2028 replacement verified. The previous decision against choosing a Jain sect remains in effect. |
| [Hong Kong Observatory conversion tables](https://www.hko.gov.hk/en/gts/time/conversion.htm) | Government astronomy tables in text/PDF for 1901–2100. | A conversion table does not select every festival convention. The previous decision against implementing Chinese astronomical-calendar machinery remains in effect. [Publication reuse conditions](https://www.weather.gov.hk/en/publica/non-commercialuse.htm) require separate consideration before bundling material. |
| [Drik Panchang](https://www.drikpanchang.com/calendars/hindu/hinducalendar.html?year=2028) | Locality-specific 2028 Hindu calculations, including named variants. | Independent calculator; each candidate must identify locality and tradition. Its [ISKCON calendar](https://www.drikpanchang.com/iskcon/iskcon-month-calendar.html?date=02%2F08%2F2028&lang=en) explicitly describes independent generation rather than issuance by ISKCON. |

No complete post-2027 replacement from an issuing Buddhist organization was
verified. University guides extend farther, including the
[Universities of Wisconsin 2028 PDF](https://www.wisconsin.edu/academic-calendars/download/2028-Universities-of-Wisconsin-religious-and-spiritual-calendar-%281%29.pdf),
[USC Buddhist calendar through academic 2028–2029](https://orsl.usc.edu/life/buddhist-holy-days-calendar/),
and [Elon multi-faith calendar through 2030](https://www.elon.edu/u/truitt-center/events-and-programs/multifaith-calendar/).
These remain planning guides, with tradition or location differences that
must be resolved before using their dates for a named calendar.

A future calendar must declare its actual scope and coverage, retain source
URLs, and distinguish calculated dates from dates awaiting an observation
or issuing authority. Multiple occurrences in one Gregorian year must be
preserved: FCNA publishes Ramadan starts on both 5 January and 26 December
2030. A single year-to-date slot would lose one occurrence. A downloadable
file alone does not establish permission to redistribute its compilation;
no general open redistribution licence was established by this review.
