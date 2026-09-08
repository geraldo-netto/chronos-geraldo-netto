const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");
const root = path.join(__dirname, "..", "files", "chronos@geraldo-netto");
const { validateCalendarManifest, manifestAvailable, manifestMonthMap } =
    require(path.join(root, "calendarPluginData"));
const { CalendarRegistry } = require(path.join(root, "calendarRegistry"));
const { HOLIDAY_ERRORS, PUBLIC_HOLIDAY_FLAG } = require(path.join(root, "holidayConstants"));

function manifest(changes = {}) {
    return Object.assign({
        apiVersion: 1, id: "custom:family", name: "Family", category: "Personal dates",
        coverage: { from: 2025, through: 2030 }, source: { name: "My notes" },
        events: [{ name: "Birthday", month: 6, day: 24 }]
    }, changes);
}

test("calendar source ports obey shared Python and JavaScript boundaries", () => {
    for (const { url, valid } of require("./fixtures/calendar_source_ports.json")) {
        const raw = manifest({ source: { name: "Calendar", url } });
        if (valid) assert.equal(validateCalendarManifest(raw).source.url, url);
        else assert.throws(() => validateCalendarManifest(raw), /source.url/);
    }
});

function adapter(id, changes = {}) {
    return Object.assign({
        id, name: id, category: "custom", enabled: true,
        available: () => true,
        getHolidays: (year, month, callback) => callback(new Map(), "", id)
    }, changes);
}

function monthMap(name, month = 6, day = 24, flags = ["calendar_observance"]) {
    return new Map([[`${month}/${day}`, { name, flags }]]);
}

test("T1163 unsafe country answers cannot conceal a healthy same-day plugin", () => {
    const { publicCalendar, manifestCalendar } = require(path.join(root, "calendarSourceAdapters"));
    for (const name of require("./fixtures/unsafe_holiday_names.json")) {
        const registry = new CalendarRegistry();
        registry.register(publicCalendar("builtin:country", {
            active: true, destroy() {},
            getHolidays: (_year, _month, done) => done(monthMap(name), "", name)
        }));
        registry.register(manifestCalendar(validateCalendarManifest(manifest())));
        let result;
        registry.getHolidays(2026, 6, (...answer) => { result = answer; });
        assert.deepEqual(result[0], monthMap("Birthday (Family)"));
        assert.equal(result[1], HOLIDAY_ERRORS.INVALID_RESPONSE);
        assert.equal(result[2], "Public holidays");
        registry.destroy();
    }
});

test("T1163 adapter display metadata must be native-safe", () => {
    for (const text of require("./fixtures/unsafe_holiday_names.json")) {
        const registry = new CalendarRegistry();
        assert.throws(() => registry.register(adapter("custom:bad", { name: text })), /name text/);
        assert.throws(() => registry.register(adapter("custom:bad", { category: text })), /category text/);
    }
});

function mergedCalendarFlags(flagSets) {
    const registry = new CalendarRegistry();
    flagSets.forEach((flags, index) => registry.register(adapter(`source:${index}`, {
        getHolidays(year, month, callback) {
            callback(monthMap(`Source ${index}`, month, 24, flags), "", "");
        }
    })));
    let result;
    registry.getHolidays(2026, 6, (map) => { result = map.get("6/24").flags; });
    registry.destroy();
    return result;
}

test("ordinary calendar observances preserve a partial holiday in either merge order", () => {
    const partial = [PUBLIC_HOLIDAY_FLAG, "PART_DAY_HOLIDAY"];
    const civic = ["calendar_observance"];
    const religious = ["religious_holiday", "christianity"];
    const orders = [[partial, civic, religious], [partial, religious, civic],
        [civic, partial, religious], [civic, religious, partial],
        [religious, partial, civic], [religious, civic, partial]];
    for (const order of orders) {
        assert.ok(mergedCalendarFlags(order).includes("PART_DAY_HOLIDAY"));
    }
});

test("optional and unclassified rows do not turn a partial public holiday into a full day off", () => {
    const partial = [PUBLIC_HOLIDAY_FLAG, "PART_DAY_HOLIDAY"];
    for (const ordinary of [[], ["optional"], ["bank", "optional"]]) {
        assert.ok(mergedCalendarFlags([partial, ordinary]).includes("PART_DAY_HOLIDAY"));
        assert.ok(mergedCalendarFlags([ordinary, partial]).includes("PART_DAY_HOLIDAY"));
    }
});

test("a full public holiday still overrides a partial holiday plus ordinary observances", () => {
    const ordinary = [["calendar_observance"], [PUBLIC_HOLIDAY_FLAG, "PART_DAY_HOLIDAY"],
        ["religious_holiday"]];
    for (let position = 0; position <= ordinary.length; position++) {
        const rows = ordinary.slice();
        rows.splice(position, 0, [PUBLIC_HOLIDAY_FLAG]);
        assert.equal(mergedCalendarFlags(rows).includes("PART_DAY_HOLIDAY"), false);
    }
});

test("bounded calendar merges retain day classifications ahead of auxiliary flags", () => {
    const vendors = ["a", "b", "c", "d", "e", "f", "g"];
    const publicDay = [PUBLIC_HOLIDAY_FLAG, ...vendors];
    const observances = [["calendar_observance"], ["religious_holiday", "christianity"]];
    const expected = ["a", "b", "c", "calendar_observance", "christianity", "d",
        PUBLIC_HOLIDAY_FLAG, "religious_holiday"];
    assert.deepEqual(mergedCalendarFlags([publicDay, ...observances]), expected);
    assert.deepEqual(mergedCalendarFlags([...observances, publicDay]), expected);

    const partialDay = [PUBLIC_HOLIDAY_FLAG, "PART_DAY_HOLIDAY", ...vendors.slice(0, 6)];
    const partial = mergedCalendarFlags([partialDay, ...observances]);
    assert.equal(partial.length, 8);
    assert.ok(partial.includes("PART_DAY_HOLIDAY"));
    assert.ok(partial.includes(PUBLIC_HOLIDAY_FLAG));
    assert.deepEqual(partial, partial.slice().sort());
});

test("calendar manifests preserve data provenance, normalize text and freeze every nested value", () => {
    const raw = manifest({
        name: "  Family  ",
        source: {
            name: " My notes ", url: " https://example.org/calendar?year=2026 ",
            location: " Genoa, Italy ", tradition: " Family celebrations "
        }
    });
    const validated = validateCalendarManifest(raw);
    assert.equal(validated.name, "Family");
    assert.deepEqual(validated.source, {
        name: "My notes", url: "https://example.org/calendar?year=2026",
        location: "Genoa, Italy", tradition: "Family celebrations"
    });
    for (const object of [validated, validated.source, validated.coverage,
        validated.events, validated.events[0]]) {
        assert.ok(Object.isFrozen(object));
    }
    raw.events[0].name = "Changed after registration";
    raw.coverage.through = 9999;
    assert.equal(validated.events[0].name, "Birthday");
    assert.equal(validated.coverage.through, 2030);
});

test("coverage is inclusive and declares valid empty years without inventing dates", () => {
    const validated = validateCalendarManifest(manifest({ events: [] }));
    for (const year of [2025, 2026, 2030]) {
        assert.equal(manifestAvailable(validated, year), true);
        assert.deepEqual(manifestMonthMap(validated, year, 1), new Map());
    }
    for (const year of [2024, 2031, 2025.5, "2025", NaN, Infinity, null]) {
        assert.equal(manifestAvailable(validated, year), false);
        assert.deepEqual(manifestMonthMap(validated, year, 1), new Map());
    }
});

test("a plugin merges repeated and one-time same-day events with source attribution and neutral flags", () => {
    const validated = validateCalendarManifest(manifest({ events: [
        { name: "Birthday", month: 6, day: 24 },
        { name: "Birthday", month: 6, day: 24 },
        { name: "Town feast", month: 6, day: 24, year: 2026, nonWorking: true },
        { name: "Visit", month: 6, day: 25, year: 2026, nonWorking: false },
        { name: "Visit", month: 6, day: 26, year: 2026 }
    ] }));
    assert.deepEqual(manifestMonthMap(validated, 2026, 6), new Map([
        ["6/24", { name: "Birthday (Family)\nTown feast (Family)",
            flags: ["calendar_observance", PUBLIC_HOLIDAY_FLAG] }],
        ["6/25", { name: "Visit (Family)", flags: ["calendar_observance"] }],
        ["6/26", { name: "Visit (Family)", flags: ["calendar_observance"] }]
    ]));
    assert.deepEqual(manifestMonthMap(validated, 2027, 6),
        monthMap("Birthday (Family)"));
    for (const month of [0, 13, 6.5, "6", null, NaN, 5]) {
        assert.deepEqual(manifestMonthMap(validated, 2026, month), new Map());
    }
});

test("annual leap dates occur only on Gregorian leap years without making covered years unavailable", () => {
    const validated = validateCalendarManifest(manifest({
        coverage: { from: 1, through: 9999 },
        events: [{ name: "Leap birthday", month: 2, day: 29 }]
    }));
    for (const year of [4, 96, 400, 2000, 2028, 2400]) {
        assert.equal(manifestMonthMap(validated, year, 2).size, 1);
    }
    for (const year of [1, 100, 1900, 2026, 2100, 9999]) {
        assert.equal(manifestAvailable(validated, year), true);
        assert.equal(manifestMonthMap(validated, year, 2).size, 0);
    }
});

test("manifest validation rejects malformed fields and unsafe identifiers", () => {
    const invalid = [
        { apiVersion: 2 }, { apiVersion: true }, { apiVersion: "1" },
        { id: "family" }, { id: "../family" }, { id: "Custom:family" },
        { id: "custom:constructor" }, { id: "prototype:family" },
        { id: "custom:" + "a".repeat(90) }, { id: 12 },
        { name: "" }, { name: "  " }, { name: "a".repeat(101) },
        { name: "bad\nname" }, { name: "bad\u202ename" }, { name: "bad\ud800" },
        { name: "\udc00bad" }, { name: null }, { category: [] },
        { category: "a".repeat(65) }, { unexpected: "ignored?" }
    ];
    for (const changes of invalid) {
        assert.throws(() => validateCalendarManifest(manifest(changes)), /Calendar plugin/);
    }
    for (const value of [null, [], new Date(), 1, "{}", true, Object.create({ apiVersion: 1 })]) {
        assert.throws(() => validateCalendarManifest(value), /plain object/);
    }
});

test("manifest text boundaries allow multilingual text and well-formed surrogate pairs", () => {
    const validated = validateCalendarManifest(manifest({
        id: "private.family:birth-days", name: "a".repeat(100), category: "b".repeat(64),
        source: { name: "c".repeat(160), tradition: "d".repeat(160), location: "Plzeň" },
        events: [{ name: "Žluťoučký 🗓️ ".repeat(10), month: 1, day: 1 }]
    }));
    assert.equal(validated.name.length, 100);
    assert.equal(validated.source.location, "Plzeň");
    assert.equal(manifestMonthMap(validated, 2026, 1).size, 1);
    const nullPrototype = Object.assign(Object.create(null), manifest());
    assert.equal(validateCalendarManifest(nullPrototype).id, "custom:family");
});

test("manifest validation never executes accessor fields or admits JSON prototype keys", () => {
    let called = false;
    const accessor = manifest();
    Object.defineProperty(accessor, "name", { get() { called = true; return "Name"; } });
    assert.throws(() => validateCalendarManifest(accessor), /accessor/);
    assert.equal(called, false);
    const symbolField = manifest();
    symbolField[Symbol("hidden")] = 1;
    assert.throws(() => validateCalendarManifest(symbolField), /symbol/);
    for (const field of ["__proto__", "constructor", "prototype"]) {
        const raw = JSON.parse(JSON.stringify(manifest()).slice(0, -1) + `,"${field}":{}}`);
        assert.throws(() => validateCalendarManifest(raw), /unexpected field/);
    }
});

test("manifest coverage and dated event validation reject booleans, impossible dates and unsupported years", () => {
    const badCoverage = [null, [], {}, { from: 0, through: 2026 },
        { from: 2026, through: 10000 }, { from: 2027, through: 2026 },
        { from: true, through: 2026 }, { from: 2026, through: 2026.5 },
        { from: "2026", through: 2026 }];
    for (const coverage of badCoverage) {
        assert.throws(() => validateCalendarManifest(manifest({ coverage })), /coverage/);
    }
    const invalidEvents = [
        null, [], { name: "" }, { name: "x", month: 2, day: 30 },
        { name: "x", month: 4, day: 31 }, { name: "x", month: 1, day: 0 },
        { name: "x", month: 13, day: 1 }, { name: "x", month: 1.5, day: 1 },
        { name: "x", month: 1, day: true }, { name: "x", month: "1", day: 1 },
        { name: "x", month: 2, day: 29, year: 2026 },
        { name: "x", month: 1, day: 1, year: true },
        { name: "x", month: 1, day: 1, year: 2024 },
        { name: "x", month: 1, day: 1, year: 2031 },
        { name: "x", month: 1, day: 1, nonWorking: 1 },
        { name: "x", month: 1, day: 1, source: "unsupported" }
    ];
    for (const event of invalidEvents) {
        assert.throws(() => validateCalendarManifest(manifest({ events: [event] })), /event/);
    }
});

test("manifest source URLs are optional HTTPS citations with bounded public metadata", () => {
    const invalidSources = [null, [], {}, { name: "x", url: "http://example.org" },
        { name: "x", url: "https://user:password@example.org" },
        { name: "x", url: "https://example.org\\fake" },
        { name: "x", url: "https://example.org/a b" },
        { name: "x", url: "https://example.org/" + "a".repeat(2048) },
        { name: "x", tradition: "" }, { name: "x", location: false },
        { name: "x", unknown: 1 }];
    for (const source of invalidSources) {
        assert.throws(() => validateCalendarManifest(manifest({ source })), /source/);
    }
    const url = "https://example.org:443/" + "a".repeat(2024);
    assert.equal(url.length, 2048);
    assert.equal(validateCalendarManifest(manifest({ source: { name: "x", url } })).source.url, url);
});

test("manifest event cap, dense array validation and tooltip bounds prevent amplification", () => {
    const events = Array.from({ length: 4096 }, (value, index) =>
        ({ name: `Event ${index}`, month: 1, day: 1 }));
    const validated = validateCalendarManifest(manifest({ events }));
    const entry = manifestMonthMap(validated, 2026, 1).get("1/1");
    assert.equal(entry.flags.length, 1);
    assert.ok(entry.name.length <= 300);
    assert.throws(() => validateCalendarManifest(manifest({ events: events.concat(events[0]) })), /4096/);
    for (const value of [null, {}, new Array(1)]) {
        assert.throws(() => validateCalendarManifest(manifest({ events: value })), /events/);
    }
    const accessors = [];
    Object.defineProperty(accessors, "0", { get() { throw new Error("must never execute"); } });
    assert.throws(() => validateCalendarManifest(manifest({ events: accessors })), /dense JSON array/);
    const extraField = [];
    extraField.unexpected = true;
    assert.throws(() => validateCalendarManifest(manifest({ events: extraField })), /JSON array/);
    const extraSymbol = [];
    extraSymbol[Symbol("hidden")] = true;
    assert.throws(() => validateCalendarManifest(manifest({ events: extraSymbol })), /JSON array/);
    class CustomArray extends Array {}
    assert.throws(() => validateCalendarManifest(manifest({ events: new CustomArray() })), /JSON array/);
});

function gregorianDate(year, month, day) {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;
}

test("fuzz: explicit Gregorian dates agree with civil Date arithmetic across the supported range", () => {
    const random = makeRandom(0xca1e);
    for (let round = 0; round < 600; round++) {
        const year = 1 + Math.floor(random() * 9999);
        const month = Math.floor(random() * 14);
        const day = Math.floor(random() * 34);
        const raw = manifest({ coverage: { from: 1, through: 9999 },
            events: [{ name: "Date", year, month, day }] });
        if (gregorianDate(year, month, day)) {
            const validated = validateCalendarManifest(raw);
            assert.equal(manifestMonthMap(validated, year, month).size, 1);
        } else {
            assert.throws(() => validateCalendarManifest(raw), /date/);
        }
    }
});

test("registry lists covered disabled sources, tracks live enabled getters and rejects collisions", () => {
    const registry = new CalendarRegistry();
    let enabled = false;
    const live = adapter("country:ita");
    Object.defineProperty(live, "enabled", { get: () => enabled });
    registry.register(live);
    registry.register(adapter("religion:expired", { available: (year) => year <= 2027 }));
    assert.deepEqual(registry.list(2028), [live]);
    assert.equal(registry.active, true);
    registry.unregister("religion:expired");
    assert.equal(registry.active, false);
    enabled = true;
    assert.equal(registry.active, true);
    assert.throws(() => registry.register(live), /already registered/);
    assert.equal(registry.unregister("missing:id"), false);
    registry.destroy();
    assert.equal(registry.active, false);
    assert.deepEqual(registry.list(2026), []);
    assert.throws(() => registry.register(live), /destroyed/);
});

test("registry bounds and validates its adapter contract", () => {
    const registry = new CalendarRegistry();
    const invalid = [null, {}, adapter("bad"), adapter("private:" + "a".repeat(128)),
        adapter("private:a", { name: "" }), adapter("private:a", { category: null }),
        adapter("private:a", { name: "x".repeat(161) }),
        adapter("private:a", { enabled: 1 }), adapter("private:a", { available: false }),
        adapter("private:a", { getHolidays: null }), adapter("private:a", { destroy: true })];
    for (const value of invalid) {
        assert.throws(() => registry.register(value), /Calendar adapter/);
    }
    for (let index = 0; index < 64; index++) {
        registry.register(adapter(`private:calendar-${index}`));
    }
    assert.equal(registry.list(2026).length, 64);
    assert.throws(() => registry.register(adapter("private:overflow")), /at most 64/);
});

test("registry names and credits follow fixed source groups and ID order", () => {
    const expected = ["builtin:country", "country:a", "country:z", "religion:a",
        "plugin:a", "plugin:z", "other:custom"];
    for (const ids of [expected, expected.slice().reverse()]) {
        const registry = new CalendarRegistry();
        for (const id of ids) {
            registry.register(adapter(id, { getHolidays(year, month, callback) {
                callback(monthMap(id), "", id);
            } }));
        }
        assert.deepEqual(registry.list(2026).map((source) => source.id), expected);
        registry.getHolidays(2026, 6, (map, error, credits) => {
            assert.equal(map.get("6/24").name, expected.join("\n"));
            assert.equal(error, "");
            assert.equal(credits, expected.join(", "));
        });
    }
});

test("registry waits for every initial answer and merges later updates without changing previous results", () => {
    const registry = new CalendarRegistry();
    const callbacks = {};
    for (const id of ["country:ita", "custom:city"]) {
        registry.register(adapter(id, { getHolidays(year, month, callback) { callbacks[id] = callback; } }));
    }
    const answers = [];
    registry.getHolidays(2026, 6, (...answer) => answers.push(answer));
    callbacks["custom:city"](monthMap("City feast"), "", "City");
    assert.equal(answers.length, 0);
    callbacks["country:ita"](monthMap("Country feast", 6, 24, [PUBLIC_HOLIDAY_FLAG]), "", "Italy");
    assert.equal(answers.length, 1);
    assert.deepEqual(answers[0], [monthMap("Country feast\nCity feast", 6, 24,
        ["calendar_observance", PUBLIC_HOLIDAY_FLAG]), "", "Italy, City"]);
    callbacks["custom:city"](monthMap("Updated city feast"), "", "City");
    assert.equal(answers.length, 2);
    assert.equal(answers[1][0].get("6/24").name, "Country feast\nUpdated city feast");
    assert.equal(answers[0][0].get("6/24").name, "Country feast\nCity feast");
});

test("registry handles synchronous repeated provider answers and empty or entirely disabled registries", () => {
    const registry = new CalendarRegistry();
    let result;
    registry.getHolidays(2026, 6, (...answer) => { result = answer; });
    assert.deepEqual(result, [new Map(), "", ""]);
    registry.register(adapter("custom:disabled", { enabled: false,
        getHolidays() { assert.fail("disabled source requested"); } }));
    registry.register(adapter("custom:expired", { available: () => false,
        getHolidays() { assert.fail("expired source requested"); } }));
    registry.getHolidays(2026, 6, (...answer) => { result = answer; });
    assert.deepEqual(result, [new Map(), "", ""]);
    registry.register(adapter("custom:sync", { getHolidays(year, month, callback) {
        callback(monthMap("First"), "", "Local");
        callback(monthMap("Second"), "", "Local");
    } }));
    const answers = [];
    registry.getHolidays(2026, 6, (...answer) => answers.push(answer));
    assert.deepEqual(answers, [[monthMap("Second"), "", "Local"]]);
});

test("concurrent month requests receive their own asynchronous provider updates", () => {
    const registry = new CalendarRegistry();
    const callbacks = new Map();
    registry.register(adapter("custom:async", {
        getHolidays(year, month, callback) { callbacks.set(`${year}/${month}`, callback); }
    }));
    const june = [];
    const july = [];
    registry.getHolidays(2026, 6, (map) => june.push(map));
    registry.getHolidays(2026, 7, (map) => july.push(map));
    callbacks.get("2026/7")(monthMap("July", 7), "", "");
    callbacks.get("2026/6")(monthMap("June"), "", "");
    callbacks.get("2026/7")(monthMap("Updated July", 7), "", "");
    assert.deepEqual(june, [monthMap("June")]);
    assert.deepEqual(july, [monthMap("July", 7), monthMap("Updated July", 7)]);
});

test("registry structural changes and destruction invalidate callbacks before cleanup can deliver them", () => {
    const registry = new CalendarRegistry();
    const pending = [];
    const source = adapter("custom:async", {
        getHolidays(year, month, callback) { pending.push(callback); },
        destroy() { pending.forEach((callback) => callback(monthMap("Cleanup"))); }
    });
    registry.register(source);
    registry.getHolidays(2026, 6, () => assert.fail("old registration callback delivered"));
    registry.register(adapter("custom:new"));
    pending[0](monthMap("Old"));
    registry.getHolidays(2026, 6, () => assert.fail("unregistered callback delivered"));
    assert.equal(registry.unregister("custom:async"), true);
    registry.register(source);
    registry.getHolidays(2026, 6, () => assert.fail("destroyed callback delivered"));
    registry.destroy();
    pending.forEach((callback) => callback(monthMap("Late")));
    registry.getHolidays(2026, 6, () => assert.fail("destroyed registry called back"));
    registry.destroy();
});

test("throwing providers and availability checks cannot hide healthy calendar results or leak diagnostics", () => {
    const registry = new CalendarRegistry();
    registry.register(adapter("custom:availability", {
        available() { throw new Error("private path"); }
    }));
    registry.register(adapter("custom:throw", {
        getHolidays() { throw new Error("private credential"); }
    }));
    registry.register(adapter("custom:healthy", {
        getHolidays(year, month, callback) { callback(monthMap("Healthy"), "", "Healthy"); }
    }));
    assert.equal(registry.list(2026).length, 2);
    let result;
    registry.getHolidays(2026, 6, (...answer) => { result = answer; });
    assert.deepEqual(result, [monthMap("Healthy"), HOLIDAY_ERRORS.SERVICE_UNAVAILABLE,
        "custom:availability, Healthy, custom:throw"]);
});

test("a live enabled getter failure cannot hide a healthy calendar or break active checks", () => {
    const registry = new CalendarRegistry();
    let broken = false;
    let healthyEnabled = true;
    registry.register({
        id: "custom:broken", name: "Broken", category: "custom",
        get enabled() {
            if (broken) throw new Error("private getter diagnostic");
            return true;
        },
        available: () => true,
        getHolidays() { assert.fail("a failed enabled getter must not dispatch"); }
    });
    registry.register({
        id: "custom:healthy", name: "Healthy", category: "custom",
        get enabled() { return healthyEnabled; },
        available: () => true,
        getHolidays(year, month, callback) { callback(monthMap("Healthy"), "", ""); }
    });
    broken = true;
    assert.equal(registry.active, true);
    let answer;
    registry.getHolidays(2026, 6, (...values) => { answer = values; });
    assert.deepEqual(answer[0], monthMap("Healthy"));
    assert.equal(answer[1], HOLIDAY_ERRORS.SERVICE_UNAVAILABLE);
    healthyEnabled = false;
    assert.equal(registry.active, false);
});

test("registry keeps stale data with canonical errors and normalizes unsafe error values", () => {
    const registry = new CalendarRegistry();
    let answer;
    registry.register(adapter("custom:cache", { getHolidays(year, month, callback) { answer = callback; } }));
    const results = [];
    registry.getHolidays(2026, 6, (...result) => results.push(result));
    answer(monthMap("Cached"), HOLIDAY_ERRORS.SERVICE_UNAVAILABLE, "Cache");
    answer(monthMap("Cached"), "Secret provider diagnostic", null);
    answer(monthMap("Current"), "", "Cache");
    assert.deepEqual(results.map((result) => result[1]), [
        HOLIDAY_ERRORS.SERVICE_UNAVAILABLE, HOLIDAY_ERRORS.INVALID_RESPONSE, ""
    ]);
    assert.equal(results[0][0].get("6/24").name, "Cached");
    assert.equal(results[1][2], "custom:cache");
});

test("registry rejects malformed month-map answers without dropping a healthy source", () => {
    const registry = new CalendarRegistry();
    let answer;
    registry.register(adapter("custom:bad", { getHolidays(year, month, callback) { answer = callback; } }));
    registry.register(adapter("custom:good", {
        getHolidays(year, month, callback) { callback(monthMap("Good")); }
    }));
    const results = [];
    registry.getHolidays(2026, 6, (...result) => results.push(result));
    const invalid = [null, [], {}, new Map([["7/24", { name: "Wrong month", flags: [] }]]),
        new Map([["6/31", { name: "Impossible date", flags: [] }]]),
        new Map([[12, { name: "Wrong key", flags: [] }]]),
        new Map([["6/24", { name: "x", flags: "not a list" }]]),
        new Map([["6/24", null]]),
        new Map(Array.from({ length: 32 }, (value, index) => [String(index), {}]))];
    for (const map of invalid) {
        answer(map, "", "x".repeat(161));
        assert.deepEqual(results.at(-1).slice(0, 2), [monthMap("Good"), HOLIDAY_ERRORS.INVALID_RESPONSE]);
    }
});

test("registry cleans every adapter once even when one cleanup throws", () => {
    const registry = new CalendarRegistry();
    const cleaned = [];
    registry.register(adapter("custom:bad", { destroy() {
        cleaned.push("bad");
        throw new Error("Cleanup failed");
    } }));
    registry.register(adapter("custom:good", { destroy() { cleaned.push("good"); } }));
    registry.destroy();
    registry.destroy();
    assert.deepEqual(cleaned, ["bad", "good"]);
});

test("registry rejects invalid requested dates without invoking any adapter", () => {
    const registry = new CalendarRegistry();
    registry.register(adapter("custom:no-call", {
        getHolidays() { assert.fail("invalid request reached provider"); }
    }));
    for (const [year, month] of [[0, 1], [10000, 1], [2026.5, 1], [true, 1], [2026, 0],
        [2026, 13], [2026, 1.5], [2026, "1"]]) {
        let result;
        registry.getHolidays(year, month, (...answer) => { result = answer; });
        assert.deepEqual(result, [new Map(), HOLIDAY_ERRORS.INVALID_RESPONSE, ""]);
    }
});

test("consumer callback exceptions are not misreported as synchronous adapter failures", () => {
    const registry = new CalendarRegistry();
    registry.register(adapter("custom:sync"));
    let calls = 0;
    assert.throws(() => registry.getHolidays(2026, 6, () => {
        calls++;
        throw new Error("Consumer failed");
    }), /Consumer failed/);
    assert.equal(calls, 1);
});

test("registry stops dispatching when a synchronous adapter changes registration", () => {
    const registry = new CalendarRegistry();
    registry.register(adapter("custom:change", { getHolidays() {
        registry.register(adapter("custom:new"));
    } }));
    registry.register(adapter("custom:old", {
        getHolidays() { assert.fail("stale request reached remaining provider"); }
    }));
    registry.getHolidays(2026, 6, () => assert.fail("stale request completed"));
});

test("fuzz: arbitrary provider completion order produces the same merged result", () => {
    const random = makeRandom(0x50a7ce);
    for (let round = 0; round < 80; round++) {
        const registry = new CalendarRegistry();
        const pending = [];
        for (let index = 0; index < 8; index++) {
            registry.register(adapter(`custom:source-${index}`, {
                getHolidays(year, month, callback) {
                    pending.push(() => callback(monthMap(`Event ${index}`), "", "Common source"));
                }
            }));
        }
        const results = [];
        registry.getHolidays(2026, 6, (...answer) => results.push(answer));
        while (pending.length) {
            pending.splice(Math.floor(random() * pending.length), 1)[0]();
        }
        const names = Array.from({ length: 8 }, (value, index) => `Event ${index}`).join("\n");
        assert.deepEqual(results, [[monthMap(names), "", "Common source"]]);
        registry.destroy();
    }
});

test("both calendar plugin modules load through the Cinnamon sibling-import convention", () => {
    const siblings = {
        holidayRecord: require(path.join(root, "holidayRecord")),
        holidayConstants: require(path.join(root, "holidayConstants")),
        textUtils: require(path.join(root, "textUtils"))
    };
    for (const [file, expression] of [["calendarPluginData", "typeof validateCalendarManifest"],
        ["calendarRegistry", "typeof CalendarRegistry"]]) {
        const context = vm.createContext({ imports: { ui: { appletManager: {
            applets: { "chronos@geraldo-netto": siblings }
        } } } });
        vm.runInContext(fs.readFileSync(path.join(root, `${file}.js`), "utf8"), context);
        assert.equal(vm.runInContext(expression, context), "function");
    }
});
