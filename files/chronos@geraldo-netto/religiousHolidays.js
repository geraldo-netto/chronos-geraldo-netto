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

/* eslint camelcase: "off" */

var RELIGIOUS_HOLIDAY_FLAG = "religious_holiday"; // NOSONAR [S3504] -- GJS importer export

// ordered by number of adherents; the ids double as settings-key suffixes
// (religion-<id>) and as the second flag on every row this module emits
var RELIGIONS = [ // NOSONAR [S3504] -- GJS importer export
    { id: "christianity", label: "Christianity" },
    { id: "islam", label: "Islam" },
    { id: "hinduism", label: "Hinduism" },
    { id: "buddhism", label: "Buddhism" },
    { id: "sikhism", label: "Sikhism" },
    { id: "judaism", label: "Judaism" },
    { id: "bahai", label: "Bahá'í Faith" },
    { id: "jainism", label: "Jainism" },
    { id: "shinto", label: "Shinto" },
    { id: "taoism", label: "Taoism" }
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
        { name: "Epiphany", fixed: [1, 6] },
        { name: "Good Friday", easter: -2 },
        { name: "Easter Sunday", easter: 0 },
        { name: "Pentecost", easter: 49 },
        { name: "All Saints' Day", fixed: [11, 1] },
        { name: "Christmas Day", fixed: [12, 25] }
    ],
    islam: [
        { name: "Islamic New Year", table: "islamic-new-year" },
        { name: "Mawlid", table: "mawlid" },
        { name: "Ramadan begins", table: "ramadan-start" },
        { name: "Eid al-Fitr", table: "eid-al-fitr" },
        { name: "Eid al-Adha", table: "eid-al-adha" }
    ],
    hinduism: [
        { name: "Makar Sankranti", fixed: [1, 14] },
        { name: "Maha Shivaratri", table: "maha-shivaratri" },
        { name: "Holi", table: "holi" },
        { name: "Krishna Janmashtami", table: "krishna-janmashtami" },
        { name: "Diwali", table: "diwali" }
    ],
    buddhism: [
        { name: "Parinirvana Day", fixed: [2, 15] },
        { name: "Vesak", table: "vesak" },
        { name: "Bodhi Day", fixed: [12, 8] }
    ],
    sikhism: [
        { name: "Guru Gobind Singh Jayanti", table: "guru-gobind-singh-jayanti" },
        { name: "Vaisakhi", table: "vaisakhi" },
        { name: "Guru Nanak Jayanti", table: "guru-nanak-jayanti" }
    ],
    judaism: [
        { name: "Purim", table: "purim" },
        { name: "Passover begins", table: "passover-start" },
        { name: "Shavuot", table: "shavuot" },
        { name: "Rosh Hashanah", table: "rosh-hashanah" },
        { name: "Yom Kippur", table: "yom-kippur" },
        { name: "Hanukkah begins", table: "hanukkah-start" }
    ],
    bahai: [
        { name: "Naw-Rúz", table: "naw-ruz" },
        { name: "Ridván begins", table: "ridvan-start" }
    ],
    jainism: [
        { name: "Mahavir Jayanti", table: "mahavir-jayanti" },
        { name: "Paryushana begins", table: "paryushana-start" }
    ],
    shinto: [
        { name: "Shōgatsu", fixed: [1, 1] },
        { name: "Hinamatsuri", fixed: [3, 3] },
        { name: "Tanabata", fixed: [7, 7] },
        { name: "Shichi-Go-San", fixed: [11, 15] }
    ],
    taoism: [
        { name: "Chinese New Year", table: "chinese-new-year" },
        { name: "Qingming", table: "qingming" },
        { name: "Ghost Festival", table: "ghost-festival" }
    ]
};

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
function holidaysForYear(year, enabledIds = religionIds()) {
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
                    name: `${entry.name} (${_religionLabel(id)})`,
                    flags: [RELIGIOUS_HOLIDAY_FLAG, id]
                });
            }
        }
    }

    return rows;
}

// the month map the calendar grid consumes: "month/day" -> [name, flags],
// same-day observances joined the way the holiday cache joins them
function monthMap(year, month, enabledIds = religionIds()) {
    const map = new Map();
    const numericMonth = Number(month);
    if (!Number.isInteger(numericMonth) || numericMonth < 1 || numericMonth > 12) {
        return map;
    }

    for (const row of holidaysForYear(Number(year), enabledIds)) {
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
    const merged = new Map(base);
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
