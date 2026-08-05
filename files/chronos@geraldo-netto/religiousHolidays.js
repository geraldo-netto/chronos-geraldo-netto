// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// Religious observances for the ten largest religions, computed locally — no
// network, no provider. Movable Christian feasts come from the Gregorian
// computus; lunar and lunisolar calendars (Islamic, Hebrew, Hindu, Chinese,
// Badí' and the rest) are bounded per-year tables of published dates, because
// those calendars are observational or astronomical and an arithmetic
// approximation drifts a day either way — exactly the day the user looks at.
// Outside the table window a table-backed observance is simply absent; the
// fixed and computed ones still render for any year.

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
const HolidayConstants = IS_NODE ?
    require("./holidayConstants") :
    AppletModules.holidayConstants;

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

// Per-year first civil dates for observances tied to observational or
// astronomical calendars. The intentionally small window is sourced from:
// https://case.edu/studentlife/dean/interreligious-council-irc/religious-holidays-observances-calendar
// https://www.xavier.edu/jesuitresource/online-resources/calendar-religious-holidays-and-observances/multi-faith-calendar---next-year
// https://www.hebcal.com/holidays/
// Dates can vary by community, location and moon sighting. Multi-day and
// sunset-starting observances are represented by the first listed civil day.
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
    // The Hebrew rows run further than the rest because they are the ones with
    // a reference implementation to check against: 2028-2030 come from Hebcal,
    // whose answers reproduce the published 2025-2027 rows above exactly, and
    // hanukkah-start is 25 Kislev — the first daytime civil day, per this
    // table's convention — not the evening the first candle is lit. The omer
    // invariant below (passover + 50 = shavuot) holds for all six years, which
    // is a second independent check on the added anchors.
    "purim": { 2025: [3, 14], 2026: [3, 3], 2027: [3, 23], 2028: [3, 12], 2029: [3, 1], 2030: [3, 19] },
    "passover-start": { 2025: [4, 13], 2026: [4, 2], 2027: [4, 22], 2028: [4, 11], 2029: [3, 31], 2030: [4, 18] },
    "shavuot": { 2025: [6, 2], 2026: [5, 22], 2027: [6, 11], 2028: [5, 31], 2029: [5, 20], 2030: [6, 7] },
    "rosh-hashanah": { 2025: [9, 23], 2026: [9, 12], 2027: [10, 2], 2028: [9, 21], 2029: [9, 10], 2030: [9, 28] },
    "yom-kippur": { 2025: [10, 2], 2026: [9, 21], 2027: [10, 11], 2028: [9, 30], 2029: [9, 19], 2030: [10, 7] },
    "hanukkah-start": { 2025: [12, 15], 2026: [12, 5], 2027: [12, 25], 2028: [12, 13], 2029: [12, 2], 2030: [12, 21] },
    "naw-ruz": { 2025: [3, 20], 2026: [3, 20], 2027: [3, 20] },
    "ridvan-start": { 2025: [4, 21], 2026: [4, 21], 2027: [4, 21] },
    "mahavir-jayanti": { 2025: [4, 10], 2026: [3, 31], 2027: [4, 18] },
    "paryushana-start": { 2025: [8, 20], 2026: [9, 8], 2027: [8, 29] },
    "chinese-new-year": { 2025: [1, 29], 2026: [2, 17], 2027: [2, 6] },
    "qingming": { 2025: [4, 4], 2026: [4, 5], 2027: [4, 5] },
    "ghost-festival": { 2025: [9, 6], 2026: [8, 27], 2027: [8, 16] }
};

// The last year every table key can answer for. Below this the tables are
// exhausted and a table-backed religion silently renders nothing, which is
// indistinguishable from "no observances this month" — so the horizon is
// asserted by the suite and reported to the user rather than left to expire
// quietly. Computed rather than written down: an added row moves it by itself.
function _tableCoverageEnd() {
    return Math.min(...Object.values(TABLES).map(
        (dates) => Math.max(...Object.keys(dates).map(Number))));
}

var TABLE_COVERAGE_END = _tableCoverageEnd(); // NOSONAR [S3504] -- GJS importer export

// entry kinds: {fixed: [month, day]} | {easter: offsetDays} |
// {table: "key"} | {series: "omer"}
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
        { name: _("Purim"), table: "purim" },
        { name: _("Passover begins"), table: "passover-start" },
        { name: _("Sefirat HaOmer — Day %s"), series: "omer" },
        { name: _("Shavuot"), table: "shavuot" },
        { name: _("Rosh Hashanah"), table: "rosh-hashanah" },
        { name: _("Yom Kippur"), table: "yom-kippur" },
        { name: _("Hanukkah begins"), table: "hanukkah-start" }
    ],
    bahai: [
        { name: _("Naw-Rúz"), table: "naw-ruz" },
        { name: _("Ridván begins"), table: "ridvan-start" }
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
        known.indexOf(id) !== -1 &&
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

// [month, day] for the entry in the given year, or null when a table-backed
// observance has no published date for that year
function _dateOf(entry, year) {
    if (entry.fixed) {
        return entry.fixed;
    }
    if (entry.table) {
        const dates = TABLES[entry.table];
        return (dates && dates[year]) || null;
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

function _sameDate(left, right) {
    return left[0] === right[0] && left[1] === right[1];
}

function _omerDates(year) {
    const passover = TABLES["passover-start"][year];
    const shavuot = TABLES.shavuot[year];
    if (!passover || !shavuot) {
        return [];
    }

    // Both published anchors must agree with the mandated count. If either
    // table is edited incorrectly, omitting the series is safer than displaying
    // a confident but wrong religious count.
    if (!_sameDate(_dateAtOffset(year, passover, OMER_DAY_COUNT + 1), shavuot)) {
        return [];
    }

    return Array.from({ length: OMER_DAY_COUNT }, (unused, index) =>
        [_dateAtOffset(year, passover, index + 1), index + 1]);
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
    return count === null ? name : name.replace("%s", String(count));
}

// expanded rows in the shape the holiday cache emits: the religion's label is
// part of the display name, which is what "split by religion" means on a grid
// cell that shows one tooltip
function holidaysForYear(year, enabledIds = religionIds(), translateName = _) {
    if (!_validYear(year)) {
        return [];
    }

    const rows = [];
    for (const id of enabledReligionIds(enabledIds)) {
        for (const entry of OBSERVANCES[id] || []) {
            for (const [date, count] of _datesOf(entry, year)) {
                rows.push({
                    year,
                    month: date[0],
                    day: date[1],
                    name: `${_nameOf(entry, count, translateName)} ` +
                        `(${translateName(_religionLabel(id))})`,
                    flags: [RELIGIOUS_HOLIDAY_FLAG, id]
                });
            }
        }
    }

    return rows;
}

// Which of the enabled religions lose observances in this year because their
// tables do not reach it. A religion whose entries are all fixed or computus-
// derived (Christianity) is never affected; one whose entries are entirely
// table-backed (Islam, Judaism, Sikhism, Bahá'í, Jainism, Taoism) renders an
// empty year, which the grid cannot distinguish from a month with nothing in
// it. Reported rather than rendered blank.
function uncoveredReligions(year, enabledIds = religionIds()) {
    if (!_validYear(year)) {
        return [];
    }

    return enabledReligionIds(enabledIds).filter((id) =>
        (OBSERVANCES[id] || []).some((entry) =>
            (entry.table || entry.series) && _datesOf(entry, year).length === 0));
}

// the calendar hands over the strings its "year/month" keys split into, so
// numbers and numeric strings coerce; anything else (booleans, arrays) would
// coerce too, and true reading as January is not a conversion anyone asked for
function _numericInput(value) {
    return typeof value === "number" || typeof value === "string" ?
        Number(value) : NaN;
}

// the month map the calendar grid consumes: "month/day" -> [name, flags],
// same-day observances joined the way the holiday cache joins them
function monthMap(year, month, enabledIds = religionIds(), translateName = _) {
    const map = new Map();
    const numericMonth = _numericInput(month);
    if (!Number.isInteger(numericMonth) || numericMonth < 1 || numericMonth > 12) {
        return map;
    }

    for (const row of holidaysForYear(_numericInput(year), enabledIds, translateName)) {
        if (row.month !== numericMonth) {
            continue;
        }

        const key = `${row.month}/${row.day}`;
        map.set(key, _joinEntry(map.get(key), row.name, row.flags));
    }

    return map;
}

function _mergeFlags(known, extra) {
    return known.concat(extra.filter((flag) => known.indexOf(flag) === -1)); // NOSONAR [S7765] -- accepted compatible form
}

// joined the way the holiday cache joins same-day rows: earlier names first,
// duplicate flags dropped
function _joinEntry(known, name, flags) {
    return known ?
        [known[0] + "\n" + name, _mergeFlags(known[1], flags)] :
        [name, flags];
}

// merge locally-computed rows into a provider month map without mutating
// either: the provider's names come first, as they do in the cache
function mergeMonthMaps(base, extra) {
    const merged = new Map();
    for (const [key, [name, flags]] of base.entries()) {
        merged.set(key, [name, _mergeFlags(flags, [PUBLIC_HOLIDAY_FLAG])]);
    }
    for (const [key, [name, flags]] of extra.entries()) {
        merged.set(key, _joinEntry(merged.get(key), name, flags));
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
        holidaysForYear,
        monthMap,
        mergeMonthMaps,
        uncoveredReligions,
        TABLE_COVERAGE_END
    };
}
