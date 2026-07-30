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
const HolidayConstants = IS_NODE ?
    require("./holidayConstants") :
    AppletModules.holidayConstants;
const translate = IS_NODE ? (text) => text : AppletModules.localeText.translate;

// Translation marker: retain stable English catalogue data, then translate at
// expansion time. This lets a locale change affect newly-rendered months while
// still giving xgettext literal msgids to extract.
const _ = (text) => text;

var RELIGIOUS_HOLIDAY_FLAG = HolidayConstants.RELIGIOUS_HOLIDAY_FLAG; // NOSONAR [S3504] -- GJS importer export
const PUBLIC_HOLIDAY_FLAG = HolidayConstants.PUBLIC_HOLIDAY_FLAG;

// ordered by number of adherents; the ids double as settings-key suffixes
// (religion-<id>) and as the second flag on every row this module emits
var RELIGIONS = [ // NOSONAR [S3504] -- GJS importer export
    { id: "christianity", label: _("Christianity") },
    { id: "islam", label: _("Islam") },
    { id: "hinduism", label: _("Hinduism") },
    { id: "buddhism", label: _("Buddhism") },
    { id: "sikhism", label: _("Sikhism") },
    { id: "judaism", label: _("Judaism") },
    { id: "bahai", label: _("Bahá'í Faith") },
    { id: "jainism", label: _("Jainism") },
    { id: "shinto", label: _("Shinto") },
    { id: "taoism", label: _("Taoism") }
];

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
    "purim": { 2025: [3, 14], 2026: [3, 3], 2027: [3, 23] },
    "passover-start": { 2025: [4, 13], 2026: [4, 2], 2027: [4, 22] },
    "shavuot": { 2025: [6, 2], 2026: [5, 22], 2027: [6, 11] },
    "rosh-hashanah": { 2025: [9, 23], 2026: [9, 12], 2027: [10, 2] },
    "yom-kippur": { 2025: [10, 2], 2026: [9, 21], 2027: [10, 11] },
    "hanukkah-start": { 2025: [12, 15], 2026: [12, 5], 2027: [12, 25] },
    "naw-ruz": { 2025: [3, 20], 2026: [3, 20], 2027: [3, 20] },
    "ridvan-start": { 2025: [4, 21], 2026: [4, 21], 2027: [4, 21] },
    "mahavir-jayanti": { 2025: [4, 10], 2026: [3, 31], 2027: [4, 18] },
    "paryushana-start": { 2025: [8, 20], 2026: [9, 8], 2027: [8, 29] },
    "chinese-new-year": { 2025: [1, 29], 2026: [2, 17], 2027: [2, 6] },
    "qingming": { 2025: [4, 4], 2026: [4, 5], 2027: [4, 5] },
    "ghost-festival": { 2025: [9, 6], 2026: [8, 27], 2027: [8, 16] }
};

// entry kinds: {fixed: [month, day]} | {easter: offsetDays} | {table: "key"}
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
_deepFreeze(RELIGIONS);
_deepFreeze(TABLES);
_deepFreeze(OBSERVANCES);

function religionIds() {
    return RELIGIONS.map((religion) => religion.id);
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

// expanded rows in the shape the holiday cache emits: the religion's label is
// part of the display name, which is what "split by religion" means on a grid
// cell that shows one tooltip
function holidaysForYear(year, enabledIds = religionIds(), translateName = translate) {
    if (!_validYear(year)) {
        return [];
    }

    const rows = [];
    for (const id of enabledReligionIds(enabledIds)) {
        for (const entry of OBSERVANCES[id] || []) {
            const date = _dateOf(entry, year);
            if (date) {
                rows.push({
                    year,
                    month: date[0],
                    day: date[1],
                    name: `${translateName(entry.name)} (${translateName(_religionLabel(id))})`,
                    flags: [RELIGIOUS_HOLIDAY_FLAG, id]
                });
            }
        }
    }

    return rows;
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
function monthMap(year, month, enabledIds = religionIds()) {
    const map = new Map();
    const numericMonth = _numericInput(month);
    if (!Number.isInteger(numericMonth) || numericMonth < 1 || numericMonth > 12) {
        return map;
    }

    for (const row of holidaysForYear(_numericInput(year), enabledIds)) {
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
        mergeMonthMaps
    };
}
