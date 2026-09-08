"use strict";

const assert = require("node:assert/strict");
const { makeRandom } = require("../helpers/prng");
const Plugins = require("../../files/chronos@geraldo-netto/calendarPluginData");
const { CalendarPluginLoader } = require("../../files/chronos@geraldo-netto/calendarPluginLoader");
const { createCancellable } = require("../helpers/pluginCancellable");
const Dates = require("../../files/chronos@geraldo-netto/holidayRecord");
const Astronomy = require("../../files/chronos@geraldo-netto/astronomy");

const TEXT_FIELDS = [["name", 100], ["category", 64], ["source.name", 160],
    ["source.location", 160], ["source.tradition", 160], ["events.0.name", 160]];
const INVALID_TEXT = [null, false, 0, [], {}, "", " ", "\ud800", "\udfff",
    "a\ud800b", "a\udfffb", "line\nbreak", "\0", "\u202e", "\u2066"];
const BAD_NUMBERS = [null, false, true, "", "1", [], {}, -1, 0, 0.5,
    Number.MAX_VALUE, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
const BAD_UTF8 = [[0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf],
    [0xf4, 0x90, 0x80, 0x80], [0xf0, 0x9f, 0x92], [0xff]];

function pick(random, values) {
    return values[Math.floor(random() * values.length)];
}

function integer(random, minimum, maximum) {
    return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function evidence(value) {
    return JSON.parse(JSON.stringify(value, (key, item) => {
        if (typeof item === "number" && !Number.isFinite(item)) {
            return { $number: String(item) };
        }
        return item === undefined ? { $undefined: true } : item;
    }));
}

function recorder(seed) {
    const report = { checks: 0, failureCount: 0, failures: [] };
    const seen = new Set();
    return { report, check(target, round, input, verify) {
        report.checks++;
        try {
            verify();
        } catch (error) {
            report.failureCount++;
            if (!seen.has(target)) {
                seen.add(target);
                report.failures.push({ target, seed, case: round,
                    input: evidence(input), message: String(error.message) });
            }
        }
    } };
}

function manifest(id = "example.audit") {
    return {
        apiVersion: 1, id, name: " Calendar 🌙 ", category: "custom",
        coverage: { from: 1, through: 9999 }, source: { name: " Fuzz fixture " },
        events: [{ name: " Good day ", month: 6, day: 24 }]
    };
}

function changed(field, value) {
    const raw = manifest();
    const parts = field.split(".");
    const parent = parts.slice(0, -1).reduce((object, key) => object[key], raw);
    parent[parts.at(-1)] = value;
    return raw;
}

function inRange(value, minimum, maximum) {
    return Number.isInteger(value) && value >= minimum && value <= maximum;
}

// Arithmetic oracle deliberately does not round-trip through JS Date, which
// is the production validator's mechanism (and treats years 1–99 specially).
function daysInMonth(year, month) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function realDate(value) {
    if (!value || typeof value !== "object") return false;
    return inRange(value.year, 1, 9999) && inRange(value.month, 1, 12) &&
        inRange(value.day, 1, daysInMonth(value.year, value.month));
}

function generatedDate(random, round) {
    const years = [1, 4, 99, 100, 400, 1900, 2000, 9999, 10000, ...BAD_NUMBERS];
    const months = [1, 2, 4, 12, 13, ...BAD_NUMBERS];
    const days = [1, 28, 29, 30, 31, 32, ...BAD_NUMBERS];
    const shaped = { year: pick(random, years), month: pick(random, months), day: pick(random, days) };
    return round % 5 ? shaped : pick(random, [null, true, 2026, "2026-01-01", [], {}]);
}

function checkDate(audit, random, round) {
    const raw = generatedDate(random, round);
    const before = evidence(raw);
    audit.check("calendar.date.acceptance", round, raw, () =>
        assert.equal(Dates.validDateParts(raw), realDate(raw)));
    audit.check("calendar.date.nonmutation", round, raw, () => assert.deepEqual(evidence(raw), before));
    const year = pick(random, [1, 4, 99, 100, 400, 1900, 2000, 9999, integer(random, 1, 9999)]);
    const month = integer(random, 1, 12);
    const good = { year, month, day: daysInMonth(year, month) };
    audit.check("calendar.date.boundaries", round, good, () => {
        assert.equal(Dates.validDateParts(good), true);
        assert.equal(Dates.validDateParts({ ...good, day: good.day + 1 }), false);
        assert.equal(Dates.validDateParts({ ...good, day: 0 }), false);
    });
}

function nextDate(value) {
    let { year, month, day } = value;
    day++;
    if (day > daysInMonth(year, month)) {
        day = 1;
        month++;
    }
    if (month > 12) {
        month = 1;
        year++;
    }
    return { year, month, day };
}

function dateSequence(first, count) {
    const dates = [first];
    for (let index = 0; index < count; index++) dates.push(nextDate(dates.at(-1)));
    return dates;
}

function checkSpan(audit, random, round) {
    const year = pick(random, [1, 4, 99, 100, 400, 1900, 2000, 9998]);
    const start = { year, month: integer(random, 1, 12), day: integer(random, 1, 28) };
    const length = pick(random, [0, 1, 27, 28, 365, 366, 367]);
    const expected = dateSequence(start, length);
    const holiday = { date: start, dateTo: expected.at(-1),
        name: [{ lang: "en", text: "Span" }], flags: [] };
    const contract = new Dates.HolidayRecordContract();
    audit.check("calendar.date.span-bound", round, holiday, () => {
        assert.equal(contract.validResponse([holiday], year), length <= 366);
        assert.equal(Dates.holidaySpanDays(start, expected.at(-1)), length);
    });
    if (length > 366) return;
    const before = evidence(holiday);
    audit.check("calendar.date.expansion", round, holiday, () => {
        const actual = contract.expandHoliday(holiday, "global")
            .map(({ year: y, month, day }) => ({ year: y, month, day }));
        assert.deepEqual(actual, expected);
        assert.deepEqual(evidence(holiday), before);
    });
}

function malformedManifest(random, round) {
    const [textField, maximum] = TEXT_FIELDS[Math.floor(round / 16) % TEXT_FIELDS.length];
    const factories = [
        () => pick(random, [null, false, 1, "", []]),
        () => changed("apiVersion", pick(random, [0, 2, "1", true, null, {}])),
        () => changed("id", pick(random, ["../bad", "x", "a..b", "A.b", "x.prototype",
            "x.constructor", "x." + "a".repeat(95), "x.\ud800"])),
        () => changed(textField, pick(random, [...INVALID_TEXT, "x".repeat(maximum + 1)])),
        () => changed("coverage.from", pick(random, [...BAD_NUMBERS, 10000])),
        () => changed("coverage.through", pick(random, [...BAD_NUMBERS, 10000])),
        () => changed("coverage", { from: 2027, through: 2026 }),
        () => changed("events.0.month", pick(random, [...BAD_NUMBERS, 13])),
        () => changed("events.0.day", pick(random, [...BAD_NUMBERS, 31, 32])),
        () => changed("events.0.year", pick(random, [...BAD_NUMBERS, 10000])),
        () => changed("events.0.nonWorking", pick(random, [0, 1, "true", null, [], {}])),
        () => changed("source.url", pick(random, ["http://example.org", "https://user@example.org",
            "https://example.org:65536", "https://example.org:99999", "https://example.org\\bad"])),
        () => changed("events", pick(random, [null, {}, "", [null], [true]])),
        () => ({ ...manifest(), unknown: true }),
        () => changed("coverage", { from: 2026, through: 2027, extra: false }),
        () => changed("events", [{ name: "Outside", year: 2028, month: 1, day: 1 }])
    ];
    const raw = factories[round % factories.length]();
    if (round % factories.length === 15) raw.coverage = { from: 2026, through: 2027 };
    return raw;
}

function loadPair(bad, round) {
    const good = manifest("example.good");
    const ids = round % 2 ? ["example.good", "example.audit"] : ["example.audit", "example.good"];
    let answer;
    let calls = 0;
    const loader = new CalendarPluginLoader({
        createCancellable,
        read: (id, cancellable, callback) => callback(id === "example.good" ? good : bad),
        report: () => {}
    });
    loader.load(ids, (rows) => { answer = rows; calls++; });
    loader.destroy();
    assert.equal(calls, 1);
    assert.deepEqual(answer.map((row) => row.id), ["example.good"]);
}

function checkMalformedManifest(audit, random, round) {
    const raw = malformedManifest(random, round);
    const before = evidence(raw);
    audit.check("calendar.plugin.rejection", round, raw, () =>
        assert.throws(() => Plugins.validateCalendarManifest(raw)));
    audit.check("calendar.plugin.nonmutation", round, raw, () => assert.deepEqual(evidence(raw), before));
    audit.check("calendar.plugin.valid-neighbor", round, raw, () => loadPair(raw, round));
}

function checkValidManifest(audit, random, round) {
    const raw = manifest();
    const [field, maximum] = TEXT_FIELDS[round % TEXT_FIELDS.length];
    const text = pick(random, ["é", "東", "x", "🌙"]);
    const bounded = text.repeat(Math.floor(maximum / text.length));
    Object.assign(raw, changed(field, bounded));
    const year = pick(random, [1, 99, 100, 400, 1900, 2000, 9999]);
    raw.events = [{ name: "Leap day", month: 2, day: 29 }, ...raw.events];
    const before = evidence(raw);
    audit.check("calendar.plugin.normalization", round, raw, () => {
        const normalized = Plugins.validateCalendarManifest(raw);
        assert.deepEqual(Plugins.validateCalendarManifest(normalized), normalized);
        assert.deepEqual(evidence(raw), before);
        assert.ok(Object.isFrozen(normalized.events[0]));
        assert.equal(Plugins.manifestMonthMap(normalized, year, 2).has("2/29"), daysInMonth(year, 2) === 29);
    });
    audit.check("calendar.plugin.coverage", round, { year, raw }, () => {
        const normalized = Plugins.validateCalendarManifest(raw);
        assert.equal(Plugins.manifestAvailable(normalized, year), true);
        for (const outside of [0, 10000, "2026", null, 1.5]) {
            assert.equal(Plugins.manifestAvailable(normalized, outside), false);
            assert.equal(Plugins.manifestMonthMap(normalized, outside, 6).size, 0);
        }
        assert.equal(Plugins.manifestMonthMap(normalized, year, pick(random, [0, 13, "6", null])).size, 0);
    });
}

function checkEventCount(audit, round) {
    const count = [0, 1, 4095, 4096, 4097, 4098][round % 6];
    const raw = manifest();
    raw.events = Array.from({ length: count }, () => ({ name: "Day", month: 6, day: 24 }));
    audit.check("calendar.plugin.event-count", round, { count, event: raw.events[0] }, () => {
        if (count > 4096) {
            assert.throws(() => Plugins.validateCalendarManifest(raw));
            return;
        }
        const normalized = Plugins.validateCalendarManifest(raw);
        assert.equal(normalized.events.length, count);
        assert.equal(Plugins.manifestMonthMap(normalized, 2026, 6).size, Number(count > 0));
    });
}

function checkSourcePorts(audit, round) {
    // Keep these boundaries in every case, including a one-case audit. The
    // random malformed corpus must not be the only way to find a bad port.
    for (const port of [0, 65535, 65536, 99999]) {
        const raw = changed("source.url", `https://example.org:${port}/calendar`);
        const target = port <= 65535 ? "calendar.plugin.source-port-control" :
            "calendar.plugin.source-port";
        audit.check(target, round, { port, url: raw.source.url }, () => {
            if (port > 65535) {
                assert.throws(() => Plugins.validateCalendarManifest(raw));
                return;
            }
            assert.equal(Plugins.validateCalendarManifest(raw).source.url, raw.source.url);
        });
    }
}

function byteStream(bytes, closed) {
    let offset = 0;
    return {
        read_bytes_async(limit, priority, cancel, done) {
            const chunk = bytes.slice(offset, offset + limit);
            offset += chunk.length;
            done(this, chunk);
        },
        read_bytes_finish: (chunk) => ({ get_data: () => chunk }),
        close_async(priority, cancel, done) { closed.push(true); done(this, null); },
        close_finish: () => true
    };
}

// Only the Gio transport is in memory: production readInstalledPlugin performs
// its own size checks, streaming UTF-8 decode, JSON parse, and manifest checks.
function byteRuntime(payloads, closed) {
    return { gi: {
        GLib: { PRIORITY_DEFAULT: 0, get_user_data_dir: () => "/virtual",
            path_is_absolute: value => value.startsWith("/"),
            build_filenamev: (parts) => parts.join("/") },
        Gio: { FileQueryInfoFlags: { NOFOLLOW_SYMLINKS: 1 }, FileType: { DIRECTORY: 2, REGULAR: 1 },
            file_new_for_path(path) {
                const bytes = payloads.get(path.split("/").at(-1));
                return {
                    query_info_async(attributes, flags, priority, cancel, done) { done(this, null); },
                    query_info_finish: () => ({ get_is_symlink: () => false,
                        get_file_type: () => bytes ? 1 : 2, get_size: () => bytes?.length || 0 }),
                    read_async(priority, cancel, done) { done(this, null); },
                    read_finish: () => byteStream(bytes, closed)
                };
            } }
    } };
}

function loadBytes(bytes) {
    const healthy = Buffer.from(JSON.stringify(manifest("example.good")));
    const payloads = new Map([["example.audit.json", bytes], ["example.good.json", healthy]]);
    const closed = [];
    const previous = Object.getOwnPropertyDescriptor(globalThis, "imports");
    let result;
    let calls = 0;
    const loader = new CalendarPluginLoader({ createCancellable, report: () => {} });
    try {
        globalThis.imports = byteRuntime(payloads, closed);
        loader.load(["example.audit", "example.good"], (rows) => { result = rows; calls++; });
    } finally {
        loader.destroy();
        if (previous) Object.defineProperty(globalThis, "imports", previous);
        else delete globalThis.imports;
    }
    assert.equal(calls, 1);
    assert.equal(closed.length, 2);
    return result.map((row) => row.id);
}

function encodedManifest(fragment) {
    const raw = manifest();
    raw.events[0].name = "ENCODING";
    const bytes = Buffer.from(JSON.stringify(raw));
    const offset = bytes.indexOf("ENCODING");
    return Buffer.concat([bytes.subarray(0, offset), Buffer.from(fragment), bytes.subarray(offset + 8)]);
}

function checkEncoding(audit, random, round) {
    const invalid = BAD_UTF8[round % BAD_UTF8.length];
    audit.check("calendar.plugin.utf8-rejection", round, { insertedBytes: invalid }, () =>
        assert.deepEqual(loadBytes(encodedManifest(invalid)), ["example.good"]));
    const text = pick(random, ["🌙", "é", "東", "𐀀"]);
    audit.check("calendar.plugin.utf8-control", round, { text }, () =>
        assert.deepEqual(loadBytes(encodedManifest(Buffer.from(text))), ["example.audit", "example.good"]));
    const invalidJson = pick(random, ["\\ud800", "\\udfff", "\\uZZZZ", "\\x00", "\n"]);
    audit.check("calendar.plugin.json-encoding", round, { insertedText: invalidJson }, () =>
        assert.deepEqual(loadBytes(encodedManifest(Buffer.from(invalidJson))), ["example.good"]));
}

function checkAstronomyBounds(audit, random, round) {
    const start = (round % 2 ? -1 : 1) * 2 ** integer(random, 54, 90);
    const end = start + 2 ** 22;
    audit.check("astronomy.unsupported-instants", round, { start, end }, () => {
        assert.equal(Astronomy.validDayBounds(start, end), false);
        assert.equal(Astronomy.calculateAstronomyEvents(start, end, 0, 0), null);
    });
}

function generationFixture(synchronous, rejected) {
    const pending = [];
    const errors = [];
    const tokens = [];
    const loader = new CalendarPluginLoader({
        createCancellable() {
            const token = createCancellable();
            token.cancel = () => {
                token.cancelled = true;
                if (synchronous) pending.filter(entry => entry.token === token)
                    .forEach(entry => entry.done(rejected));
            };
            tokens.push(token);
            return token;
        },
        read: (id, token, done) => pending.push({ id, token, done }),
        report: error => errors.push(error.message)
    });
    return { loader, pending, errors, tokens };
}

function exerciseGenerations(input) {
    const { loader, pending, errors, tokens } = generationFixture(input.synchronous, input.rejected);
    const answers = [];
    for (let generation = 0; generation < input.generations; generation++) {
        loader.load(["example.audit", "example.good"], rows =>
            answers.push({ generation, ids: rows.map(row => row.id) }));
    }
    if (input.mode === "destroy") loader.destroy();
    if (input.mode === "empty") loader.load([], rows => assert.deepEqual(rows, []));
    assert.ok(tokens.slice(0, -1).every(token => token.is_cancelled()));
    assert.equal(tokens.at(-1).is_cancelled(), input.mode !== "replace");
    const ordered = input.reverse ? pending.toReversed() : pending;
    ordered.forEach(entry => entry.done(entry.token.is_cancelled() ? input.rejected : manifest(entry.id)));
    assert.deepEqual(errors, []);
    assert.deepEqual(answers, input.mode === "replace" ? [
        { generation: input.generations - 1, ids: ["example.audit", "example.good"] }
    ] : []);
    loader.destroy();
    assert.ok(tokens.every(token => token.is_cancelled()));
}

function checkGenerations(audit, random, round) {
    const input = { generations: integer(random, 2, 5), mode: ["replace", "empty", "destroy"][round % 3],
        synchronous: random() < 0.5, reverse: random() < 0.5,
        rejected: pick(random, [null, {}, [], true, { apiVersion: 99 }]) };
    audit.check("calendar.plugin.cancelled-generation", round, input, () => exerciseGenerations(input));
}

function runCalendarInputs({ seed = 0xcafe2026, cases = 256 } = {}) {
    const audit = recorder(seed);
    for (let round = 0; round < cases; round++) {
        // A case has its own stream, so reproducing case N does not depend on
        // how many random choices an earlier case made.
        const random = makeRandom((seed + Math.imul(round + 1, 0x9e3779b1)) >>> 0);
        checkDate(audit, random, round);
        checkSpan(audit, random, round);
        checkMalformedManifest(audit, random, round);
        checkValidManifest(audit, random, round);
        checkEventCount(audit, round);
        checkSourcePorts(audit, round);
        checkEncoding(audit, random, round);
        checkAstronomyBounds(audit, random, round);
        checkGenerations(audit, random, round);
    }
    return audit.report;
}

module.exports = { runCalendarInputs };
