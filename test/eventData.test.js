const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");

const DAY_US = 24 * 3600 * 1000 * 1000;

// FakeDateTime carrying the subset of GLib.DateTime the data model uses.
class FakeDateTime {
    constructor(usec) {
        this.usec = usec;
    }

    to_unix() {
        return Math.floor(this.usec / 1000000);
    }

    difference(other) {
        return this.usec - other.usec;
    }

    compare(other) {
        return this.usec === other.usec ? 0 : (this.usec < other.usec ? -1 : 1);
    }

    add_seconds(seconds) {
        return new FakeDateTime(this.usec + seconds * 1000000);
    }

    add_days(days) {
        return new FakeDateTime(this.usec + days * DAY_US);
    }

    get_year() {
        return 2000;
    }

    get_month() {
        return 1;
    }

    get_day_of_month() {
        return Math.floor(this.usec / DAY_US);
    }
}

let monotonic = 1000;

global.imports = {
    gi: {
        GLib: {
            get_language_names: () => ["C"],
            TIME_SPAN_DAY: DAY_US,
            TIME_SPAN_MINUTE: 60 * 1000 * 1000,
            get_monotonic_time: () => monotonic++,
            DateTime: {
                // GLib.DateTime spans years 1 to 9999 and answers null for
                // anything outside that; the double has to say so too, or the
                // guard against it can never be tested
                new_from_unix_local: (unix) =>
                    (unix >= -62135596800 && unix <= 253402300799 ? new FakeDateTime(unix * 1000000) : null),
                // day encoding: the fake keeps day-of-month as usec/DAY_US, so
                // date_only(new_local(...)) round-trips through day * DAY_US
                new_local: (year, month, day) => new FakeDateTime(day * DAY_US),
                new_now_local: () => new FakeDateTime(50 * DAY_US + DAY_US / 2)
            }
        }
    }
};

const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "eventData.js");
const EventDataModule = require(modulePath);
const { EventData, EventDataList, date_only, dt_equals, month_year_only, js_date_to_gdatetime } =
    EventDataModule;

function makeVariant({ id = "ev1", color = "#ff0000", summary = "s", allDay = false,
    startUnix, endUnix, modTime = 1 }) {
    return {
        deep_unpack: () => [id, color, summary, allDay, startUnix, endUnix, modTime]
    };
}

const DAY_S = 24 * 3600;

test("date helpers: date_only truncates and dt_equals compares by unix", () => {
    const dt = new FakeDateTime(3 * DAY_US + 5000000);
    assert.equal(date_only(dt).usec, 3 * DAY_US);
    assert.ok(dt_equals(date_only(dt), new FakeDateTime(3 * DAY_US)));
    assert.ok(!dt_equals(dt, new FakeDateTime(3 * DAY_US)));
});

test("js_date_to_gdatetime converts epoch milliseconds", () => {
    const gdt = js_date_to_gdatetime(new Date(5000));
    assert.equal(gdt.to_unix(), 5);
});

// EventData used to carry a `span` field that nothing in the applet read. The
// day span it described is still a fact worth asserting, so the tests derive it
// from the dates rather than from a field kept alive for them.
function spanDays(event) {
    const days = (event.end_date.to_unix() - event.start_date.to_unix()) / DAY_S;
    return event.multi_day ? days : 1;
}

test("EventData: timed single-day event has span 1 and is not multi-day", () => {
    const ev = new EventData(makeVariant({ startUnix: 10 * DAY_S + 3600, endUnix: 10 * DAY_S + 7200 }), 42);
    assert.equal(ev.multi_day, false);
    assert.equal(spanDays(ev), 1);
    assert.equal(ev.last_update_timestamp, 42);
});

test("EventData: midnight-to-midnight all-day event stays on one day", () => {
    const ev = new EventData(makeVariant({
        allDay: true, startUnix: 10 * DAY_S, endUnix: 11 * DAY_S
    }), 0);
    assert.equal(ev.multi_day, false, "the -1s trim must keep it on the start day");
});

test("EventData: zero-length all-day event clamps end to start", () => {
    const ev = new EventData(makeVariant({
        allDay: true, startUnix: 10 * DAY_S, endUnix: 10 * DAY_S
    }), 0);
    assert.equal(ev.end.to_unix(), ev.start.to_unix());
    assert.equal(ev.multi_day, false);
});

test("EventData: multi-day event computes its day span", () => {
    const ev = new EventData(makeVariant({ startUnix: 10 * DAY_S, endUnix: 13 * DAY_S + 3600 }), 0);
    assert.equal(ev.multi_day, true);
    assert.equal(spanDays(ev), 3);
});

test("EventData: three-day all-day event trims its end into the last day", () => {
    const ev = new EventData(makeVariant({
        allDay: true, startUnix: 10 * DAY_S, endUnix: 13 * DAY_S
    }), 0);
    assert.equal(ev.multi_day, true);
    assert.equal(spanDays(ev), 2, "the -1s trim pulls the end date back one day");
    assert.equal(ev.end.to_unix(), 13 * DAY_S - 1);
});

test("EventData: timed event crossing midnight is multi-day with span 1", () => {
    const ev = new EventData(makeVariant({
        startUnix: 10 * DAY_S + 23 * 3600, endUnix: 11 * DAY_S + 3600
    }), 0);
    assert.equal(ev.multi_day, true);
    assert.equal(spanDays(ev), 1);
});

test("EventData rejects UTC endpoints the local zone cannot represent", () => {
    const clock = global.imports.gi.GLib.DateTime;
    const convert = clock.new_from_unix_local;
    const minimum = -62135596800;
    const maximum = 253402300799;

    try {
        for (const [startUnix, endUnix, rejected] of [
            [maximum, maximum - 1, maximum],
            [minimum + 1, minimum, minimum]
        ]) {
            const calls = [];
            clock.new_from_unix_local = (unix) => {
                calls.push(unix);
                return unix === rejected ? null : new FakeDateTime(unix * 1000000);
            };
            assert.throws(() => new EventData(makeVariant({
                startUnix, endUnix
            }), 0), /no usable start or end time/);
            assert.deepEqual(calls, [startUnix, endUnix],
                "each local endpoint is constructed exactly once");
        }
    } finally {
        clock.new_from_unix_local = convert;
    }
});

test("EventData rejects an all-day end whose inclusive second underflows", () => {
    const addSeconds = FakeDateTime.prototype.add_seconds;
    FakeDateTime.prototype.add_seconds = () => null;

    try {
        assert.throws(() => new EventData(makeVariant({
            allDay: true,
            startUnix: -62135596800,
            endUnix: -62135596800
        }), 0), /no usable start or end time/);
        assert.doesNotThrow(() => new EventData(makeVariant({
            startUnix: 10 * DAY_S,
            endUnix: 10 * DAY_S + 60
        }), 0), "timed events perform no inclusive-end adjustment");
    } finally {
        FakeDateTime.prototype.add_seconds = addSeconds;
    }
});

// The UID comes off whatever ICS or CalDAV feed the user subscribed to, so it
// is the one string here an outsider chooses. On a plain object, "toString"
// reads back as an inherited function rather than undefined, and "__proto__"
// swallows the assignment whole.
test("EventDataList: an event named after an Object property is still an event", () => {
    const list = new EventDataList(new FakeDateTime(10 * DAY_US));

    for (const id of ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"]) {
        const ev = new EventData(makeVariant({ id, startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 }), 1);
        assert.equal(list.add_or_update(ev, 1), true, `${id} is added`);
    }

    assert.equal(list.length, 5, "the count keeps step with the entries it holds");
    assert.deepEqual(list.get_event_list().map((ev) => ev.id).sort(),
        ["__proto__", "constructor", "hasOwnProperty", "toString", "valueOf"]);

    // and the count still tracks removals, which is what decides whether an
    // emptied day is dropped from the grid
    list.delete("toString");
    list.delete("__proto__");
    assert.equal(list.length, 3);
});

test("EventDataList: add, update, delete and cull drive length and change flags", () => {
    const list = new EventDataList(new FakeDateTime(10 * DAY_US));
    const ev = new EventData(makeVariant({ startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 }), 1);

    assert.equal(list.add_or_update(ev, 1), true);
    assert.equal(list.length, 1);

    // identical event: no change, timestamp refreshed
    const same = new EventData(makeVariant({ startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 }), 2);
    assert.equal(list.add_or_update(same, 2), false);
    assert.equal(list._events["ev1"].last_update_timestamp, 2);

    // same id+mod but new color: change reported
    const recolored = new EventData(makeVariant({
        color: "#00ff00", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60
    }), 3);
    assert.equal(list.add_or_update(recolored, 3), true);
    assert.equal(list._events["ev1"].color, "#00ff00");

    assert.equal(list.delete("missing"), false);
    assert.equal(list.delete("ev1"), true);
    assert.equal(list.length, 0);
});

// The index asks this to decide whether the open event column still shows the
// event it is registering, so a false negative strands a stale row and a false
// positive rebuilds the column for nothing. A plain object would answer an
// inherited function for "toString", which is why the backing store has no
// prototype — assert the membership test inherits that guarantee.
test("EventDataList: has() reports membership without inheriting Object properties", () => {
    const list = new EventDataList(new FakeDateTime(10 * DAY_US));

    assert.equal(list.has("ev1"), false, "an empty list holds nothing");
    for (const id of ["toString", "__proto__", "hasOwnProperty"]) {
        assert.equal(list.has(id), false, `${id} is not an event`);
    }

    const ev = new EventData(makeVariant({ startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 }), 1);
    list.add_or_update(ev, 1);
    assert.equal(list.has("ev1"), true);
    assert.equal(list.has("ev2"), false, "a sibling id is not this one");

    list.delete("ev1");
    assert.equal(list.has("ev1"), false, "a deleted event is gone");
});

// The index rebuild wants the day's contents, not its reading order, and
// get_event_list() charges a sort plus two GLib.DateTimes per bucket to supply
// an order the rebuild discards.
test("EventDataList: get_stored_events yields every event and no ordering work", () => {
    const list = new EventDataList(new FakeDateTime(10 * DAY_US));
    assert.deepEqual(list.get_stored_events(), [], "an empty day stores nothing");

    for (const id of ["b", "a", "__proto__"]) {
        list.add_or_update(new EventData(makeVariant({
            id, startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60
        }), 1), 1);
    }

    const stored = list.get_stored_events();
    assert.deepEqual(stored.map((ev) => ev.id).sort(), ["__proto__", "a", "b"],
        "every stored event is yielded, whatever its UID");
    assert.equal(stored.every((ev) => ev instanceof EventData), true,
        "the events themselves, not their ids");
    assert.equal(stored.length, list.length);

    list.delete("a");
    assert.deepEqual(list.get_stored_events().map((ev) => ev.id).sort(),
        ["__proto__", "b"], "a deleted event is not stored any more");
});

test("EventDataList: cull removes only stale events", () => {
    const list = new EventDataList(new FakeDateTime(10 * DAY_US));
    const oldEv = new EventData(makeVariant({ id: "old", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 }), 1);
    const newEv = new EventData(makeVariant({ id: "new", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 }), 5);
    list.add_or_update(oldEv, 1);
    list.add_or_update(newEv, 5);

    assert.equal(list.cull_removed_events(3), true);
    assert.equal(list.length, 1);
    assert.equal(list._events["new"].id, "new");
    assert.equal(list.cull_removed_events(3), false);
});

test("EventDataList: get_colors caches until data changes", () => {
    const list = new EventDataList(new FakeDateTime(10 * DAY_US));
    list.add_or_update(new EventData(makeVariant({ startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60 }), 1), 1);
    const first = list.get_colors();
    assert.deepEqual(first, ["#ff0000"]);
    assert.equal(list.get_colors(), first, "cached array identity");
    list.add_or_update(new EventData(makeVariant({
        id: "ev2", color: "#0000ff", startUnix: 10 * DAY_S, endUnix: 10 * DAY_S + 60
    }), 2), 2);
    assert.notEqual(list.get_colors(), first);
});

test("EventData day comparisons agree with the event window", () => {
    const ev = new EventData(makeVariant({ startUnix: 10 * DAY_S + 3600, endUnix: 12 * DAY_S + 3600 }), 0);
    const day9 = new FakeDateTime(9 * DAY_US);
    const day10 = new FakeDateTime(10 * DAY_US);
    const day11 = new FakeDateTime(11 * DAY_US);
    const day12 = new FakeDateTime(12 * DAY_US);
    const day13 = new FakeDateTime(13 * DAY_US);

    assert.ok(ev.starts_on_date_only(day10));
    assert.ok(!ev.starts_on_date_only(day11));
    assert.ok(ev.ends_on_date_only(day12));
    assert.ok(!ev.ends_on_date_only(day11));
    assert.ok(ev.started_before_date_only(day11));
    assert.ok(!ev.started_before_date_only(day10));
    assert.ok(ev.ended_before_date_only(day13));
    assert.ok(!ev.ended_before_date_only(day12));
    assert.ok(ev.ends_after_date_only(day11));
    assert.ok(!ev.ends_after_date_only(day12));
    assert.ok(ev.started_after_date_only(day9));
    assert.ok(!ev.started_after_date_only(day10));
});

test("month_year_only truncates to the first of the month", () => {
    const dt = new FakeDateTime(7 * DAY_US + 999);
    // fake new_local keeps only the day argument, which must be 1
    assert.equal(month_year_only(dt).usec, DAY_US);
});

function listEvent(id, startUnix, endUnix, allDay = false) {
    return new EventData(makeVariant({ id, allDay, startUnix, endUnix }), 1);
}

test("get_event_list: plain chronological order for a non-current day", () => {
    const list = new EventDataList(new FakeDateTime(10 * DAY_US));
    list.add_or_update(listEvent("b", 10 * DAY_S + 7200, 10 * DAY_S + 7300), 1);
    list.add_or_update(listEvent("a", 10 * DAY_S + 3600, 10 * DAY_S + 3700), 1);
    assert.deepEqual(list.get_event_list().map((e) => e.id), ["a", "b"]);
});

test("get_event_list: today keeps all-day events above the first pending event", () => {
    // fake "now" is day 50 at 12:00
    const today = new FakeDateTime(50 * DAY_US);
    const list = new EventDataList(today);
    const past = listEvent("past", 50 * DAY_S + 3600, 50 * DAY_S + 7200); // 01:00-02:00
    const pending = listEvent("pending", 50 * DAY_S + 20 * 3600, 50 * DAY_S + 21 * 3600); // 20:00
    const allday = listEvent("allday", 50 * DAY_S, 51 * DAY_S, true);
    list.add_or_update(allday, 1);
    list.add_or_update(past, 1);
    list.add_or_update(pending, 1);

    assert.deepEqual(list.get_event_list().map((e) => e.id), ["past", "allday", "pending"]);
});

module.exports = { FakeDateTime, makeVariant, DAY_S, DAY_US };

test("get_event_list: multiple all-day events keep insertion above first pending", () => {
    const today = new FakeDateTime(50 * DAY_US);
    const list = new EventDataList(today);
    list.add_or_update(listEvent("allday2", 50 * DAY_S, 51 * DAY_S, true), 1);
    list.add_or_update(listEvent("past1", 50 * DAY_S + 3600, 50 * DAY_S + 7200), 1);
    list.add_or_update(listEvent("past2", 50 * DAY_S + 8000, 50 * DAY_S + 9000), 1);
    list.add_or_update(listEvent("allday1", 50 * DAY_S, 51 * DAY_S - 60, true), 1);
    list.add_or_update(listEvent("pending", 50 * DAY_S + 20 * 3600, 50 * DAY_S + 21 * 3600), 1);

    const ids = list.get_event_list().map((e) => e.id);
    const pendingIdx = ids.indexOf("pending");
    assert.ok(ids.indexOf("allday1") < pendingIdx && ids.indexOf("allday2") < pendingIdx,
        `all-day events precede pending: ${ids}`);
    assert.ok(ids.indexOf("past1") < ids.indexOf("allday1"), `past events precede all-day: ${ids}`);
});

// This is the one place data from another process reaches the applet: the
// calendar server hands over a DBus variant repeating whatever an ICS or CalDAV
// feed told it. Every other parser here is fuzzed; this one carries the times
// the whole grid is built from.
test("fuzz: a hostile DBus event either builds or is refused, and never half-builds", () => {
    const rand = makeRandom(0x5eed1);
    const times = [
        0, 1, -1, 10 * DAY_S,
        253402300799, 253402300800,      // the last second GLib knows, and one past it
        -62135596800, -62135596801,
        Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER,
        2 ** 53, 1e300, Infinity, -Infinity, NaN,
        null, undefined, "1700000000", "later", {}, [], true
    ];
    const strings = ["ok", "", null, undefined, 42, {}, [], true];
    const pick = (pool) => pool[Math.floor(rand() * pool.length)];

    for (let round = 0; round < 400; round++) {
        const unpacked = [pick(strings), pick(strings), pick(strings), rand() < 0.5,
            pick(times), pick(times), pick(times)];
        // a short tuple: the server is free to change shape on us
        const payload = rand() < 0.1 ? unpacked.slice(0, Math.floor(rand() * 7)) : unpacked;
        const variant = { deep_unpack: () => (rand() < 0.05 ? null : payload) };

        let event;
        try {
            event = new EventData(variant, 1);
        } catch (e) {
            // refusing is a fine answer, as long as it says why — and never
            // by quoting the hostile payload back into the log
            assert.match(String(e), /usable start or end time|unusable id/);
            continue;
        }

        // if it built, it is whole: a null GLib.DateTime here is what used to
        // throw two lines later, inside a DBus signal handler
        assert.ok(event.start && event.end, "an event that exists has both ends");
        assert.equal(typeof event.id, "string");
        assert.ok(EventDataModule.validEventUid(event.id),
            "an admitted UID is inside the contract");
        assert.equal(typeof event.summary, "string");
        assert.ok(event.summary.length <= EventDataModule.MAX_EVENT_SUMMARY_LENGTH,
            "the summary lands in a wrapping label on the compositor thread");
        assert.equal(typeof event.color, "string");
        assert.ok(spanDays(event) >= 1, "an event never ends on a day before it starts");
        assert.ok(event.end.to_unix() >= event.start.to_unix(), "and it does not end before it starts");
    }
});

// the summary is whatever the subscribed feed put in SUMMARY, and it reaches a
// wrapping, non-ellipsizing label laid out on the compositor thread
test("a huge event summary is clamped, not laid out", () => {
    const max = EventDataModule.MAX_EVENT_SUMMARY_LENGTH;
    assert.equal(max, 300, "the compositor-facing summary cap is a product limit");
    const times = { startUnix: 50 * 24 * 3600, endUnix: 50 * 24 * 3600 + 3600 };
    const event = new EventData(
        makeVariant(Object.assign({ summary: "x".repeat(500 * 1024) }, times)), 1);

    assert.equal(event.summary.length, max);
    assert.ok(event.summary.endsWith("…"), "and it says it was cut");

    // a summary that fits is untouched, and a missing one is still a string
    assert.equal(new EventData(makeVariant(Object.assign({ summary: "Team sync" }, times)), 1).summary,
        "Team sync");
    assert.equal(new EventData(makeVariant(Object.assign({ summary: null }, times)), 1).summary, "");

    // REGRESSION: the clamp sliced UTF-16 units, so a feed whose SUMMARY carried
    // an emoji at the 300th code point had it cut in half and handed the lone
    // surrogate to Pango. It counts code points now.
    const astral = new EventData(makeVariant(Object.assign(
        { summary: "x".repeat(max - 1) + "🎉" }, times)), 1);
    assert.equal(Array.from(astral.summary).length, max);
    assert.doesNotMatch(astral.summary, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("calendar colors are validated before EventData retains them", () => {
    const times = { startUnix: 50 * DAY_S, endUnix: 50 * DAY_S + 3600 };
    const max = require(path.join(__dirname, "..", "files", "chronos@geraldo-netto",
        "styleUtils.js")).MAX_CSS_COLOR_LENGTH;

    assert.equal(new EventData(makeVariant(Object.assign(
        { color: " rgb(1, 2, 3) " }, times)), 1).color, "rgb(1, 2, 3)");
    assert.equal(new EventData(makeVariant(Object.assign(
        { color: "a".repeat(max) }, times)), 1).color, "a".repeat(max));
    assert.equal(new EventData(makeVariant(Object.assign(
        { color: "a".repeat(max + 1) }, times)), 1).color, "");
    assert.equal(new EventData(makeVariant(Object.assign(
        { color: "a".repeat(200000) }, times)), 1).color, "");
});

// A day's worth of events as the calendar server might deliver them. All-day
// events always start at midnight — that is the server's shape, and the
// today-ordering early-break depends on it.
function fuzzDayOfEvents(rand, list, dayBase, count) {
    for (let n = 0; n < count; n++) {
        const allDay = rand() < 0.3;
        const start = allDay ? dayBase * DAY_S :
            dayBase * DAY_S + 60 + Math.floor(rand() * (DAY_S - 7300));
        const end = allDay ? (dayBase + 1) * DAY_S : start + 60 + Math.floor(rand() * 7200);

        list.add_or_update(listEvent(`e${n}`, start, end, allDay), 1);
    }
}

function assertChronological(events) {
    for (let i = 1; i < events.length; i++) {
        assert.ok(events[i - 1].start.to_unix() <= events[i].start.to_unix(),
            "chronological for non-current days");
    }
}

test("fuzz: get_event_list is always a chronologically-consistent permutation", () => {
    const rand = makeRandom(12345);

    for (let round = 0; round < 100; round++) {
        // half the rounds target today (day 50 in the fake clock), half another day
        const dayBase = round % 2 === 0 ? 50 : 20;
        const list = new EventDataList(new FakeDateTime(dayBase * DAY_US));
        const count = 1 + Math.floor(rand() * 8);
        fuzzDayOfEvents(rand, list, dayBase, count);

        const result = list.get_event_list();
        assert.equal(result.length, count, "permutation: nothing lost");
        assert.equal(new Set(result.map((event) => event.id)).size, count);

        // today's list leads with what is on now, so only the other days are
        // plainly chronological
        if (dayBase !== 50) {
            assertChronological(result);
        }
    }
});
