// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// Religious observances for the ten largest religions, computed locally — no
// network, no provider.
//
// Three kinds of date live here. Movable Christian feasts come from the
// Gregorian computus. The Hebrew observances come from hebrewCalendar.js, which
// is exact for any year: that calendar has been rule-based since the arithmetic
// rules were fixed, so there is nothing to observe and nothing to publish. The
// rest — Islamic, Hindu, Chinese, Badí' and so on — are bounded per-year tables
// of published dates, because those calendars are observational or
// astronomical: the observed date depends on a sighting, a locality, or an
// ephemeris, and an arithmetic approximation drifts a day either way — exactly
// the day the user looks at. If any table-backed observance lacks a date for
// the requested year, its entire religion calendar is hidden. Calendars with
// only fixed or computed dates remain available for the supported year range.

/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const AppletModules = IS_NODE ? null :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"];
const ReligiousCatalog = IS_NODE ?
    require("./religiousCatalog") :
    AppletModules.religiousCatalog;
const HebrewCalendar = IS_NODE ?
    require("./hebrewCalendar") :
    AppletModules.hebrewCalendar;
const HolidayConstants = IS_NODE ?
    require("./holidayConstants") :
    AppletModules.holidayConstants;
const TextUtils = IS_NODE ?
    require("./textUtils") :
    AppletModules.textUtils;
const HolidayRecord = IS_NODE ?
    require("./holidayRecord") :
    AppletModules.holidayRecord;
const joinHolidayEntry = HolidayRecord.joinHolidayEntry;
const monthHolidayEntry = HolidayConstants.monthHolidayEntry;

// Translation marker for observance names. Religion labels live in the shared
// catalogue; both are translated only when an observance is expanded.
const _ = (text) => text;

var RELIGIOUS_HOLIDAY_FLAG = HolidayConstants.RELIGIOUS_HOLIDAY_FLAG; // NOSONAR [S3504] -- GJS importer export
const PUBLIC_HOLIDAY_FLAG = HolidayConstants.PUBLIC_HOLIDAY_FLAG;
const OMER_DAY_COUNT = 49;

var RELIGIONS = ReligiousCatalog.RELIGIONS; // NOSONAR [S3504] -- GJS importer export
const RELIGION_IDS = ReligiousCatalog.RELIGION_IDS;

// Anonymous Gregorian computus (Meeus/Jones/Butcher): month/day of Easter
// Sunday for any Gregorian year.
function gregorianEaster(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);

    return {
        month: Math.floor((h + l - 7 * m + 114) / 31),
        day: ((h + l - 7 * m + 114) % 31) + 1
    };
}

// Naw-Rúz is the Tehran sunset-to-sunset day containing the March equinox, and
// it is emphatically not something to approximate. In 2026 the equinox falls
// within about a minute of Tehran sunset; Tehran's ~1190 m elevation moves that
// sunset five or six minutes on its own, and the Universal House of Justice has
// never published the sunset model it uses — so a correct textbook
// implementation lands on either side of that year depending on the refraction
// constant it happens to pick. These are the published dates instead.
//
// Before 2015 the Western convention fixed the year's start to the Gregorian
// calendar at 21 March. From 2015 the definition became astronomical, and the
// Bahá'í World Centre published the results for BE 172-221 as a table; those
// put Naw-Rúz on 21 March in exactly
// the years listed here and on 20 March in every other year of that window.
// Its last Naw-Rúz is in March 2064; the February 2065 dates on that final row
// describe Ayyám-i-Há. They do not authorize another Naw-Rúz in March 2065.
// https://bahai-library.com/pdf/uhj/uhj_bahai_dates_172-221.pdf
// https://guidelines.bahai.org.nz/wp-content/uploads/2022/07/GLSA-08-Holy-Days.pdf
const BAHAI_ERA_START = 1844;
const NAW_RUZ_ASTRONOMICAL_FROM = 2015;
const NAW_RUZ_TABLE_END = 2064;
const NAW_RUZ_ON_21_MARCH = new Set([2015, 2018, 2019, 2022, 2023, 2026, 2027,
    2031, 2035, 2039, 2043, 2047, 2051, 2055]);

function _nawRuzDay(year) {
    if (year < NAW_RUZ_ASTRONOMICAL_FROM) {
        return 21;
    }

    return NAW_RUZ_ON_21_MARCH.has(year) ? 21 : 20;
}

function _nawRuzDates() {
    const dates = {};
    for (let year = BAHAI_ERA_START; year <= NAW_RUZ_TABLE_END; year++) {
        dates[year] = [3, _nawRuzDay(year)];
    }

    return dates;
}

// Per-year first civil dates for observances tied to observational or
// astronomical calendars. The intentionally small window is sourced from:
// https://case.edu/studentlife/dean/interreligious-council-irc/religious-holidays-observances-calendar
// https://www.xavier.edu/jesuitresource/online-resources/calendar-religious-holidays-and-observances/multi-faith-calendar---next-year
// Dates can vary by community, location and moon sighting. Multi-day and
// sunset-starting observances are represented by the first listed civil day.
//
// The Hebrew observances used to be here too. They are computed now — see
// hebrewCalendar.js — which is why Judaism no longer has a coverage horizon.
const TABLES = {
    "islamic-new-year": { 2025: [6, 27], 2026: [6, 17], 2027: [6, 6] },
    "mawlid": { 2025: [9, 5], 2026: [8, 26], 2027: [8, 15] },
    "ramadan-start": { 2025: [3, 1], 2026: [2, 18], 2027: [2, 8] },
    "eid-al-fitr": { 2025: [3, 30], 2026: [3, 20], 2027: [3, 10] },
    "eid-al-adha": { 2025: [6, 7], 2026: [5, 27], 2027: [5, 17] },
    "maha-shivaratri": { 2025: [2, 26], 2026: [2, 15], 2027: [3, 6] },
    "holi": { 2025: [3, 14], 2026: [3, 4], 2027: [3, 22] },
    "krishna-janmashtami": { 2025: [8, 16], 2026: [9, 4], 2027: [8, 25] },
    "diwali": { 2025: [10, 20], 2026: [11, 8], 2027: [10, 29] },
    "vesak": { 2025: [5, 12], 2026: [5, 1], 2027: [5, 20] },
    "guru-gobind-singh-jayanti": { 2025: [1, 6], 2026: [1, 6], 2027: [1, 14] },
    "vaisakhi": { 2025: [4, 14], 2026: [4, 14], 2027: [4, 14] },
    "guru-nanak-jayanti": { 2025: [11, 5], 2026: [11, 24], 2027: [11, 14] },
    "naw-ruz": _nawRuzDates(),
    "mahavir-jayanti": { 2025: [4, 10], 2026: [3, 31], 2027: [4, 18] },
    "paryushana-start": { 2025: [8, 20], 2026: [9, 8], 2027: [8, 29] },
    "chinese-new-year": { 2025: [1, 29], 2026: [2, 17], 2027: [2, 6] },
    "qingming": { 2025: [4, 4], 2026: [4, 5], 2027: [4, 5] },
    "ghost-festival": { 2025: [9, 6], 2026: [8, 27], 2027: [8, 16] }
};

// The last year every table key can answer for. Individual calendar coverage
// controls visibility; this shared minimum remains available for diagnostics.
function _tableCoverageEnd() {
    return Math.min(...Object.values(TABLES).map(
        (dates) => Math.max(...Object.keys(dates).map(Number))));
}

var TABLE_COVERAGE_END = _tableCoverageEnd(); // NOSONAR [S3504] -- GJS importer export

// entry kinds: {fixed: [month, day]} | {easter: offsetDays} | {table: "key"} |
// {fromTable: "key", offset: days} | {hebrew: "key"} | {series: "omer"}
const OBSERVANCES = {
    christianity: [
        { name: _("Epiphany"), fixed: [1, 6] },
        { name: _("Good Friday"), easter: -2 },
        { name: _("Easter Sunday"), easter: 0 },
        { name: _("Pentecost"), easter: 49 },
        { name: _("All Saints' Day"), fixed: [11, 1] },
        { name: _("Christmas Day"), fixed: [12, 25] }
    ],
    islam: [
        { name: _("Islamic New Year"), table: "islamic-new-year" },
        { name: _("Mawlid"), table: "mawlid" },
        { name: _("Ramadan begins"), table: "ramadan-start" },
        { name: _("Eid al-Fitr"), table: "eid-al-fitr" },
        { name: _("Eid al-Adha"), table: "eid-al-adha" }
    ],
    hinduism: [
        { name: _("Makar Sankranti"), fixed: [1, 14] },
        { name: _("Maha Shivaratri"), table: "maha-shivaratri" },
        { name: _("Holi"), table: "holi" },
        { name: _("Krishna Janmashtami"), table: "krishna-janmashtami" },
        { name: _("Diwali"), table: "diwali" }
    ],
    buddhism: [
        { name: _("Parinirvana Day"), fixed: [2, 15] },
        { name: _("Vesak"), table: "vesak" },
        { name: _("Bodhi Day"), fixed: [12, 8] }
    ],
    sikhism: [
        { name: _("Guru Gobind Singh Jayanti"), table: "guru-gobind-singh-jayanti" },
        { name: _("Vaisakhi"), table: "vaisakhi" },
        { name: _("Guru Nanak Jayanti"), table: "guru-nanak-jayanti" }
    ],
    judaism: [
        { name: _("Purim"), hebrew: "purim" },
        { name: _("Passover begins"), hebrew: "passover-start" },
        { name: _("Sefirat HaOmer — Day %s"), series: "omer" },
        { name: _("Shavuot"), hebrew: "shavuot" },
        { name: _("Rosh Hashanah"), hebrew: "rosh-hashanah" },
        { name: _("Yom Kippur"), hebrew: "yom-kippur" },
        { name: _("Hanukkah begins"), hebrew: "hanukkah-start" }
    ],
    bahai: [
        { name: _("Naw-Rúz"), table: "naw-ruz" },
        // Ridván day 1 is 13 Jalál, and Badí' months are 19 days each, so it is
        // day 32 of the year — always Naw-Rúz + 31. Derived rather than
        // tabulated: the table it replaced had Ridván on 21 April every year
        // against a Naw-Rúz of 20 March, an offset of 32, so 2025 was a day
        // late. An arithmetic relation should not be re-typed once a year.
        { name: _("Ridván begins"), fromTable: "naw-ruz", offset: 31 }
    ],
    jainism: [
        { name: _("Mahavir Jayanti"), table: "mahavir-jayanti" },
        { name: _("Paryushana begins"), table: "paryushana-start" }
    ],
    shinto: [
        { name: _("Shōgatsu"), fixed: [1, 1] },
        { name: _("Hinamatsuri"), fixed: [3, 3] },
        { name: _("Tanabata"), fixed: [7, 7] },
        { name: _("Shichi-Go-San"), fixed: [11, 15] }
    ],
    taoism: [
        { name: _("Chinese New Year"), table: "chinese-new-year" },
        { name: _("Qingming"), table: "qingming" },
        { name: _("Ghost Festival"), table: "ghost-festival" }
    ]
};

// the catalogue is shared module state every consumer reads for the applet's
// lifetime; frozen, an accidental write is a no-op or TypeError instead of
// silently corrupting every later month
function _deepFreeze(value) {
    if (value && typeof value === "object") {
        Object.values(value).forEach(_deepFreeze);
        Object.freeze(value);
    }
    return value;
}
_deepFreeze(TABLES);
_deepFreeze(OBSERVANCES);

function religionIds() {
    return RELIGION_IDS.slice();
}

function _validYear(year) {
    return Number.isInteger(year) && year >= 1 && year <= 9999;
}

// the known, deduplicated subset of the requested ids, in request order —
// the one validation gate between stored settings and the catalogue
function enabledReligionIds(enabledIds) {
    if (!Array.isArray(enabledIds)) {
        return [];
    }

    const known = religionIds();
    return enabledIds.filter((id, index) =>
        typeof id === "string" &&
        known.includes(id) &&
        enabledIds.indexOf(id) === index);
}

function _religionLabel(id) {
    const religion = RELIGIONS.find((entry) => entry.id === id);
    return religion ? religion.label : id;
}

function _easterDate(year, offset) {
    const easter = gregorianEaster(year);
    const date = new Date(year, easter.month - 1, easter.day + offset, 12);

    return [date.getMonth() + 1, date.getDate()];
}

// holidaysForYear asks for each observance separately and monthMap calls it
// once per month, so a grid render asks for the same year dozens of times. The
// arithmetic is cheap but not free, and one slot is all the locality it needs.
let _hebrewYear = 0;
let _hebrewDates = null;

function _hebrewObservances(year) {
    if (_hebrewYear !== year) {
        _hebrewYear = year;
        _hebrewDates = HebrewCalendar.hebrewObservances(year);
    }

    return _hebrewDates;
}

// [month, day] for the entry in the given year, or null when a table-backed
// observance has no published date for that year
function _dateOf(entry, year) {
    if (entry.fixed) {
        return entry.fixed;
    }
    if (entry.hebrew) {
        return _hebrewObservances(year)[entry.hebrew];
    }
    if (entry.table) {
        const dates = TABLES[entry.table];
        return dates?.[year] || null;
    }
    if (entry.fromTable) {
        const anchor = TABLES[entry.fromTable][year];
        return anchor ? _dateAtOffset(year, anchor, entry.offset) : null;
    }

    return _easterDate(year, entry.easter);
}

// The count begins on 16 Nisan, the civil day after the first day of Passover,
// and runs through 5 Sivan; Shavuot follows on day 50. These rules and the
// published civil-date anchors are documented at:
// https://www.chabad.org/library/article_cdo/aid/130631/jewish/Sefirat-HaOmer.htm
// https://www.hebcal.com/holidays/days-of-the-omer
//
// UTC civil arithmetic makes every result independent of the host timezone and
// of the daylight-saving transition that can fall inside the seven-week span.
function _dateAtOffset(year, [month, day], offset) {
    const date = new Date(0);
    date.setUTCHours(12, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day + offset);
    return [date.getUTCMonth() + 1, date.getUTCDate()];
}

// The two anchors used to be hand-typed rows, so this guarded them against an
// editing mistake by re-deriving Shavuot from Passover and refusing the series
// when they disagreed. They are computed now, and 15 Nisan + 50 = 6 Sivan is a
// consequence of the fixed month lengths rather than a coincidence of two
// tables — Nisan is always 30 days and Iyyar always 29. The check moved to
// hebrewCalendar's suite, which asserts it across 1800-2100 where a real
// calendar bug would show, instead of on a path no test can now reach.
function _omerDates(year) {
    const passover = _hebrewObservances(year)["passover-start"];

    return Array.from({ length: OMER_DAY_COUNT }, (unused, index) =>
        [_dateAtOffset(year, passover, index + 1), index + 1]);
}

// A derived entry shares its table anchor's published range. Omer is computed.
function _tableBacked(entry) {
    return Boolean(entry.table || entry.fromTable);
}

function _datesOf(entry, year) {
    if (entry.series === "omer") {
        return _omerDates(year);
    }

    const date = _dateOf(entry, year);
    return date ? [[date, null]] : [];
}

function _nameOf(entry, count, translateName) {
    const name = translateName(entry.name);
    return count === null ? name :
        TextUtils.fillTemplate(name, [String(count)]);
}

// expanded rows in the shape the holiday cache emits: the religion's label is
// part of the display name, which is what "split by religion" means on a grid
// cell that shows one tooltip
// One slot, like _hebrewObservances above and for the same reason. The 42-day
// grid spans two months, so one repaint asked for the same year twice, and
// each ask expanded every enabled religion twice over — once for the rows and
// once for the coverage report — rebuilding all 49 omer dates every time and
// then discarding eleven twelfths of the result by month filter.
//
// The expansion memoized here is name-free: which dates an observance falls on
// does not depend on the display language, so the memo survives a locale
// change and the (cheap) name formatting stays per call. It also yields the
// coverage answer from the same walk, because "this table ran out of years" is
// just "this entry produced no dates".
let _expansionKey = "";
let _expansion = null;

// The two memos above are module scope, so they are shared by every applet
// instance in the process and would otherwise outlive the last one for the
// login session -- every other cache in this subsystem (HolidayCache.release,
// HolidayCacheRepository.release, CalendarHolidayAnnotator.release) has an
// explicit release for exactly that reason. Both are pure memos, so a release
// while another instance is still running costs one recomputation and nothing
// else; there is no refcount to keep.
function releaseMemos() {
    _hebrewYear = 0;
    _hebrewDates = null;
    _expansionKey = "";
    _expansion = null;
}

// Roll back only this religion's rows if a required published date is absent.
function _expandReligion(id, year, dated) {
    const firstRow = dated.length;
    for (const entry of OBSERVANCES[id] || []) {
        const dates = _datesOf(entry, year);
        if (dates.length === 0 && _tableBacked(entry)) {
            dated.length = firstRow;
            return true;
        }
        for (const [date, count] of dates) {
            dated.push({ id, entry, date, count });
        }
    }

    return false;
}

function _expandYear(year, ids) {
    const key = `${year}|${ids.join(",")}`;
    if (_expansionKey === key && _expansion) {
        return _expansion;
    }

    const dated = [];
    const uncovered = [];
    for (const id of ids) {
        if (_expandReligion(id, year, dated)) {
            uncovered.push(id);
        }
    }

    _expansionKey = key;
    _expansion = { dated, uncovered };
    return _expansion;
}

function holidaysForYear(year, enabledIds = religionIds(), translateName = _) {
    if (!_validYear(year)) {
        return [];
    }

    return _expandYear(year, enabledReligionIds(enabledIds)).dated
        .map(({ id, entry, date, count }) => ({
            year,
            month: date[0],
            day: date[1],
            name: `${_nameOf(entry, count, translateName)} ` +
                `(${translateName(_religionLabel(id))})`,
            // The flag, and only the flag. The religion used to ride along in
            // flags[1] and no reader anywhere took it: "split by religion" is
            // served by the label already inside `name` above, and every flag
            // consumer -- holidayRecord, holidayCache, the grid annotator, the
            // event view -- asks whether a sentinel is present, never what
            // sits beside it. Carrying it made the annotator's positional flag
            // diff sensitive to a value nothing draws.
            flags: [RELIGIOUS_HOLIDAY_FLAG]
        }));
}

// Hidden calendars retain a diagnostic even when their fixed rows are hidden
// too. Calendars containing only fixed or computed observances remain covered.
function uncoveredReligions(year, enabledIds = religionIds()) {
    if (!_validYear(year)) {
        return [];
    }

    // Same walk as the rows: the memo answers both, so the coverage report no
    // longer re-expands the year (and the omer series) on its own.
    return _expandYear(year, enabledReligionIds(enabledIds)).uncovered.slice();
}

function availableReligionIds(year, enabledIds = religionIds()) {
    if (!_validYear(year)) {
        return [];
    }

    const ids = enabledReligionIds(enabledIds);
    const { uncovered } = _expandYear(year, ids);
    return ids.filter((id) => !uncovered.includes(id));
}

// the month map the calendar grid consumes: "month/day" -> {name, flags},
// same-day observances joined by the one shared join
function monthMap(year, month, enabledIds = religionIds(), translateName = _) {
    const map = new Map();
    const numericMonth = TextUtils.numericInput(month);
    if (!Number.isInteger(numericMonth) || numericMonth < 1 || numericMonth > 12) {
        return map;
    }

    for (const row of holidaysForYear(TextUtils.numericInput(year), enabledIds, translateName)) {
        if (row.month !== numericMonth) {
            continue;
        }

        const key = `${row.month}/${row.day}`;
        map.set(key, joinHolidayEntry(map.get(key), row.name, row.flags));
    }

    return map;
}

// merge locally-computed rows into a provider month map without mutating
// either: the provider's names come first, as they do in the cache, and the
// join is the cache's own — bounded name, no repeated name, one flag order.
//
// A provider row is *tagged* public rather than merged with a public row, so
// the part-day rule does not apply to it and Enrico's half-day stays a half day.
function mergeMonthMaps(base, extra) {
    const merged = new Map();
    for (const [key, { name, flags }] of base.entries()) {
        merged.set(key, monthHolidayEntry(name,
            HolidayRecord.withHolidayFlag(flags, PUBLIC_HOLIDAY_FLAG)));
    }
    for (const [key, { name, flags }] of extra.entries()) {
        merged.set(key, joinHolidayEntry(merged.get(key), name, flags));
    }

    return merged;
}

if (typeof module !== "undefined") {
    module.exports = {
        RELIGIOUS_HOLIDAY_FLAG,
        RELIGIONS,
        gregorianEaster,
        religionIds,
        enabledReligionIds,
        availableReligionIds,
        holidaysForYear,
        monthMap,
        mergeMonthMaps,
        uncoveredReligions,
        releaseMemos,
        TABLE_COVERAGE_END
    };
}
