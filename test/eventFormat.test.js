const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");

const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "eventFormat.js");
const EventFormat = require(modulePath);

const HOUR_US = 3600 * 1000 * 1000;
const DAY_US = 24 * HOUR_US;

// Minimal stand-in for GLib.DateTime: microsecond epoch plus the methods the
// helpers touch. format() returns tagged tokens so tests can assert which
// format string was chosen without locale dependence.
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

    add_days(days) {
        return new FakeDateTime(this.usec + days * DAY_US);
    }

    format(fmt) {
        return `${fmt}|day${Math.floor(this.usec / DAY_US)}`;
    }
}

function dateOnly(dt) {
    return new FakeDateTime(Math.floor(dt.usec / DAY_US) * DAY_US);
}

// Mirrors the EventData day-comparison interface from 5.4/eventView.js.
function makeEvent({ startUs, endUs, allDay = false }) {
    const start = new FakeDateTime(startUs);
    const end = new FakeDateTime(endUs);
    const start_date = dateOnly(start);
    const end_date = dateOnly(end);
    return {
        start,
        end,
        start_date,
        end_date,
        all_day: allDay,
        multi_day: start_date.usec !== end_date.usec,
        starts_on_day(date) {
            return dateOnly(date).usec === start_date.usec;
        },
        starts_on_date_only(date) {
            return date.usec === start_date.usec;
        },
        ends_on_day(date) {
            return dateOnly(date).usec === end_date.usec;
        },
        ends_on_date_only(date) {
            return date.usec === end_date.usec;
        },
        started_before_day(date) {
            return dateOnly(date).usec > start_date.usec;
        },
        started_before_date_only(date) {
            return date.usec > start_date.usec;
        },
        ended_before_day(date) {
            return dateOnly(date).usec > end_date.usec;
        },
        ended_before_date_only(date) {
            return date.usec > end_date.usec;
        },
        ends_after_day(date) {
            return dateOnly(date).usec < end_date.usec;
        },
        ends_after_date_only(date) {
            return date.usec < end_date.usec;
        },
        started_after_day(date) {
            return dateOnly(date).usec < start_date.usec;
        },
        started_after_date_only(date) {
            return date.usec < start_date.usec;
        }
    };
}

const NOW = new FakeDateTime(1000 * DAY_US + 12 * HOUR_US); // day 1000, noon
const TODAY = dateOnly(NOW);

function classify(event) {
    return EventFormat.classifyEventDisplayState(event, NOW, TODAY);
}

test("dtEquals compares by unix time", () => {
    assert.equal(EventFormat.dtEquals(new FakeDateTime(5000000), new FakeDateTime(5000000)), true);
    assert.equal(EventFormat.dtEquals(new FakeDateTime(5000000), new FakeDateTime(6000000)), false);
});

test("classify: finished event is past with no countdown or highlight", () => {
    const event = makeEvent({ startUs: NOW.usec - 4 * HOUR_US, endUs: NOW.usec - 2 * HOUR_US });
    const state = classify(event);
    assert.equal(state.phase, EventFormat.EVENT_PHASE_PAST);
    assert.equal(state.show_countdown, false);
    assert.equal(state.is_current_or_next, false);
});

test("classify: timed event starting later today counts down and is next", () => {
    const event = makeEvent({ startUs: NOW.usec + 2 * HOUR_US, endUs: NOW.usec + 3 * HOUR_US });
    const state = classify(event);
    assert.equal(state.phase, EventFormat.EVENT_PHASE_UPCOMING);
    assert.equal(state.show_countdown, true);
    assert.equal(state.is_current_or_next, true);
    assert.equal(state.time_until_start, 2 * HOUR_US);
});

test("classify: all-day event starting today counts down but is never next", () => {
    const event = makeEvent({
        startUs: NOW.usec + 2 * HOUR_US,
        endUs: NOW.usec + 3 * HOUR_US,
        allDay: true
    });
    const state = classify(event);
    assert.equal(state.show_countdown, true);
    assert.equal(state.is_current_or_next, false);
});

test("classify: event starting on a future day shows no countdown", () => {
    const event = makeEvent({ startUs: NOW.usec + 2 * DAY_US, endUs: NOW.usec + 2 * DAY_US + HOUR_US });
    const state = classify(event);
    assert.equal(state.phase, EventFormat.EVENT_PHASE_UPCOMING);
    assert.equal(state.show_countdown, false);
    assert.equal(state.is_current_or_next, false);
});

// the selected date is not an input to the classification, and used to be:
// whether the event is over does not depend on which day the user is looking at
test("classify: the state does not depend on the selected date", () => {
    const event = makeEvent({ startUs: NOW.usec + 2 * HOUR_US, endUs: NOW.usec + 3 * HOUR_US });
    assert.equal(EventFormat.classifyEventDisplayState.length, 3);
    assert.deepEqual(
        EventFormat.classifyEventDisplayState(event, NOW, TODAY),
        classify(event));
});

test("classify: in-progress timed event that started today is current", () => {
    const event = makeEvent({ startUs: NOW.usec - HOUR_US, endUs: NOW.usec + HOUR_US });
    const state = classify(event);
    assert.equal(state.phase, EventFormat.EVENT_PHASE_CURRENT);
    assert.equal(state.is_current_or_next, true);
});

test("classify uses date-only start predicate when available", () => {
    const event = makeEvent({ startUs: NOW.usec - HOUR_US, endUs: NOW.usec + HOUR_US });
    let dateOnlyCalls = 0;
    event.starts_on_day = () => {
        throw new Error("date_only path should not run");
    };
    event.starts_on_date_only = (date) => {
        dateOnlyCalls++;
        return date.usec === event.start_date.usec;
    };

    const state = classify(event);

    assert.equal(dateOnlyCalls, 1);
    assert.equal(state.is_current_or_next, true);
});

test("formatEventTimeRange asks the event only for date-only comparisons", () => {
    const event = makeEvent({ startUs: NOW.usec - HOUR_US, endUs: NOW.usec + HOUR_US });
    let startDateOnlyCalls = 0;
    event.starts_on_date_only = (date) => {
        startDateOnlyCalls++;
        return date.usec === event.start_date.usec;
    };

    const label = EventFormat.formatEventTimeRange(event, TODAY, TODAY, OPTS);

    assert.equal(startDateOnlyCalls, 1);
    assert.equal(label, "%H:%M|day1000" + EventFormat.ARROW_SEPARATOR + "%H:%M|day1000");
});

test("classify: in-progress multi-day event that started earlier is not next", () => {
    const event = makeEvent({ startUs: NOW.usec - 2 * DAY_US, endUs: NOW.usec + DAY_US });
    const state = classify(event);
    assert.equal(state.phase, EventFormat.EVENT_PHASE_CURRENT);
    assert.equal(state.is_current_or_next, false);
});

test("classify: in-progress all-day event is never current-or-next", () => {
    const event = makeEvent({ startUs: TODAY.usec, endUs: TODAY.usec + DAY_US - 1000000, allDay: true });
    const state = classify(event);
    assert.equal(state.phase, EventFormat.EVENT_PHASE_CURRENT);
    assert.equal(state.is_current_or_next, false);
});

test("fuzz: classify invariants over randomized event windows", () => {
    const rand = makeRandom(20260709);
    for (let i = 0; i < 500; i++) {
        const startOffset = Math.floor((rand() - 0.5) * 10 * DAY_US);
        const duration = Math.floor(rand() * 3 * DAY_US) + 1000000;
        const allDay = rand() < 0.3;

        const event = makeEvent({
            startUs: NOW.usec + startOffset,
            endUs: NOW.usec + startOffset + duration,
            allDay
        });
        const state = EventFormat.classifyEventDisplayState(event, NOW, TODAY);

        if (event.end.difference(NOW) < 0) {
            assert.equal(state.phase, EventFormat.EVENT_PHASE_PAST);
            assert.equal(state.show_countdown, false);
            assert.equal(state.is_current_or_next, false);
        } else if (event.start.difference(NOW) > 0) {
            assert.equal(state.phase, EventFormat.EVENT_PHASE_UPCOMING);
            // an upcoming event counts down exactly when it starts today. This
            // used to compare show_countdown with the state's own starts_today
            // field, which is the same value under a different name: it asserted
            // the output against itself and would have held for any input.
            assert.equal(state.show_countdown, event.starts_on_day(TODAY));
        } else {
            assert.equal(state.phase, EventFormat.EVENT_PHASE_CURRENT);
            assert.equal(state.show_countdown, false);
        }

        if (allDay) {
            assert.equal(state.is_current_or_next, false);
        }
        assert.equal(state.time_until_start, event.start.difference(NOW));
    }
});

const OPTS = {
    timeFormat: "%H:%M",
    dayFormat: "%A",
    translate: (str) => `t(${str})`
};

function prefix(event, selected = TODAY) {
    return EventFormat.formatRangePrefix(event, selected, TODAY, OPTS);
}

test("localeCap uppercases the first character only", () => {
    assert.equal(EventFormat.localeCap("wednesday"), "Wednesday");
    assert.equal(EventFormat.localeCap(""), "");
});

test("prefix, today selected: timed event starting today shows its start time", () => {
    const event = makeEvent({ startUs: NOW.usec - HOUR_US, endUs: NOW.usec + DAY_US });
    assert.equal(prefix(event), event.start.format("%H:%M"));
});

test("prefix, today selected: all-day event starting today shows Today", () => {
    const event = makeEvent({ startUs: TODAY.usec, endUs: TODAY.usec + 2 * DAY_US, allDay: true });
    assert.equal(prefix(event), "t(Today)");
});

test("prefix, today selected: recent start shows capitalized weekday", () => {
    const event = makeEvent({ startUs: TODAY.usec - 2 * DAY_US, endUs: TODAY.usec + DAY_US });
    assert.equal(prefix(event), EventFormat.localeCap(event.start_date.format("%A")));
});

test("prefix, today selected: old start shows the locale date", () => {
    const event = makeEvent({ startUs: TODAY.usec - 10 * DAY_US, endUs: TODAY.usec + DAY_US });
    assert.equal(prefix(event), event.start_date.format("%x"));
});

test("prefix, today selected: future start yields an empty prefix", () => {
    const event = makeEvent({ startUs: TODAY.usec + 2 * DAY_US, endUs: TODAY.usec + 3 * DAY_US });
    assert.equal(prefix(event), "");
});

test("prefix, other day selected: recent past start shows capitalized weekday", () => {
    const selected = dateOnly(new FakeDateTime(TODAY.usec + 2 * DAY_US));
    const event = makeEvent({ startUs: TODAY.usec - DAY_US, endUs: TODAY.usec + 3 * DAY_US });
    assert.equal(prefix(event, selected), EventFormat.localeCap(event.start_date.format("%A")));
});

test("prefix, other day selected: timed start on the selected day shows its time", () => {
    const selected = dateOnly(new FakeDateTime(TODAY.usec - 5 * DAY_US));
    const event = makeEvent({ startUs: selected.usec + 9 * HOUR_US, endUs: TODAY.usec + 3 * DAY_US });
    assert.equal(prefix(event, selected), event.start.format("%H:%M"));
});

test("prefix, other day selected: old all-day start shows the locale date", () => {
    const selected = dateOnly(new FakeDateTime(TODAY.usec - 5 * DAY_US));
    const event = makeEvent({
        startUs: selected.usec, endUs: TODAY.usec + 3 * DAY_US, allDay: true
    });
    assert.equal(prefix(event, selected), event.start_date.format("%x"));
});

test("prefix, other day selected: timed event starting today shows time plus Today", () => {
    const selected = dateOnly(new FakeDateTime(TODAY.usec + 2 * DAY_US));
    const event = makeEvent({ startUs: NOW.usec + HOUR_US, endUs: TODAY.usec + 3 * DAY_US });
    // one msgid with a placeholder, not a time glued to a translated word: a
    // translator has to be able to write "Heute 14:30"
    assert.equal(prefix(event, selected), `t(${event.start.format("%H:%M")} Today)`);
});

test("prefix, other day selected: all-day event starting today shows Today", () => {
    const selected = dateOnly(new FakeDateTime(TODAY.usec + 2 * DAY_US));
    const event = makeEvent({
        startUs: TODAY.usec, endUs: TODAY.usec + 3 * DAY_US, allDay: true
    });
    assert.equal(prefix(event, selected), "t(Today)");
});

test("prefix, other day selected: start in next few days shows uncapitalized weekday", () => {
    const selected = dateOnly(new FakeDateTime(TODAY.usec + 5 * DAY_US));
    const event = makeEvent({ startUs: TODAY.usec + 2 * DAY_US, endUs: TODAY.usec + 6 * DAY_US });
    assert.equal(prefix(event, selected), event.start_date.format("%A"));
});

test("prefix, other day selected: distant future start shows the locale date", () => {
    const selected = dateOnly(new FakeDateTime(TODAY.usec + 8 * DAY_US));
    const event = makeEvent({ startUs: TODAY.usec + 6 * DAY_US, endUs: TODAY.usec + 9 * DAY_US });
    assert.equal(prefix(event, selected), event.start_date.format("%x"));
});

test("fuzz: prefix always returns a string and never throws", () => {
    const rand = makeRandom(97);
    for (let i = 0; i < 500; i++) {
        const startOffset = Math.floor((rand() - 0.5) * 12 * DAY_US);
        const duration = Math.floor(rand() * 4 * DAY_US) + 1000000;
        const selected = dateOnly(new FakeDateTime(NOW.usec + Math.floor((rand() - 0.5) * 10) * DAY_US));
        const event = makeEvent({
            startUs: NOW.usec + startOffset,
            endUs: NOW.usec + startOffset + duration,
            allDay: rand() < 0.3
        });
        const result = EventFormat.formatRangePrefix(event, selected, TODAY, OPTS);
        assert.equal(typeof result, "string");
        if (event.starts_on_day(selected) && event.all_day && selected.usec === TODAY.usec) {
            assert.equal(result, "t(Today)");
        }
    }
});

function suffix(event, selected = TODAY) {
    return EventFormat.formatRangeSuffix(event, selected, TODAY, OPTS);
}

function range(event, selected = TODAY) {
    return EventFormat.formatEventTimeRange(event, selected, TODAY, OPTS);
}

test("suffix, today selected: timed event ending today shows its end time", () => {
    const event = makeEvent({ startUs: TODAY.usec - DAY_US, endUs: NOW.usec + HOUR_US });
    assert.equal(suffix(event), event.end.format("%H:%M"));
});

test("suffix, today selected: all-day event ending today shows Today", () => {
    const event = makeEvent({
        startUs: TODAY.usec - 2 * DAY_US, endUs: TODAY.usec + HOUR_US, allDay: true
    });
    assert.equal(suffix(event), "t(Today)");
});

test("suffix, today selected: distant end shows the locale date", () => {
    const event = makeEvent({ startUs: TODAY.usec - DAY_US, endUs: TODAY.usec + 8 * DAY_US });
    assert.equal(suffix(event), event.end_date.format("%x"));
});

test("suffix, today selected: near end shows capitalized weekday", () => {
    const event = makeEvent({ startUs: TODAY.usec - DAY_US, endUs: TODAY.usec + 2 * DAY_US });
    assert.equal(suffix(event), EventFormat.localeCap(event.end_date.format("%A")));
});

test("suffix, other day selected: timed event ending today shows time plus Today", () => {
    const selected = dateOnly(new FakeDateTime(TODAY.usec - 2 * DAY_US));
    const event = makeEvent({ startUs: TODAY.usec - 3 * DAY_US, endUs: NOW.usec + HOUR_US });
    assert.equal(suffix(event, selected), `t(${event.end.format("%H:%M")} Today)`);
});

test("suffix, other day selected: all-day event ending today shows Today", () => {
    const selected = dateOnly(new FakeDateTime(TODAY.usec - 2 * DAY_US));
    const event = makeEvent({
        startUs: TODAY.usec - 3 * DAY_US, endUs: TODAY.usec + HOUR_US, allDay: true
    });
    assert.equal(suffix(event, selected), "t(Today)");
});

test("suffix, other day selected: timed end on selected day shows its time", () => {
    const selected = dateOnly(new FakeDateTime(TODAY.usec + 2 * DAY_US));
    const event = makeEvent({ startUs: TODAY.usec, endUs: selected.usec + 9 * HOUR_US });
    assert.equal(suffix(event, selected), event.end.format("%H:%M"));
});

test("suffix, other day selected: distant end shows the locale date", () => {
    const selected = dateOnly(new FakeDateTime(TODAY.usec + DAY_US));
    const event = makeEvent({
        startUs: TODAY.usec, endUs: TODAY.usec + 9 * DAY_US, allDay: true
    });
    assert.equal(suffix(event, selected), event.end_date.format("%x"));
});

test("suffix, other day selected: near end shows capitalized weekday", () => {
    const selected = dateOnly(new FakeDateTime(TODAY.usec + DAY_US));
    const event = makeEvent({
        startUs: TODAY.usec, endUs: TODAY.usec + 3 * DAY_US, allDay: true
    });
    assert.equal(suffix(event, selected), EventFormat.localeCap(event.end_date.format("%A")));
});

test("range: single-day all-day event on the selected day reads All day", () => {
    const event = makeEvent({
        startUs: TODAY.usec, endUs: TODAY.usec + DAY_US - 1000000, allDay: true
    });
    assert.equal(range(event), "t(All day)");
});

test("range: single-day timed event shows start arrow end", () => {
    const event = makeEvent({ startUs: NOW.usec + HOUR_US, endUs: NOW.usec + 2 * HOUR_US });
    assert.equal(range(event),
        event.start.format("%H:%M") + EventFormat.ARROW_SEPARATOR + event.end.format("%H:%M"));
});

test("range: past multi-day event shows date arrow date", () => {
    const event = makeEvent({ startUs: TODAY.usec - 6 * DAY_US, endUs: TODAY.usec - 3 * DAY_US });
    assert.equal(range(event),
        event.start_date.format("%x") + EventFormat.ARROW_SEPARATOR + event.end_date.format("%x"));
});

test("range: active multi-day event composes prefix and suffix", () => {
    const event = makeEvent({ startUs: TODAY.usec - 2 * DAY_US, endUs: TODAY.usec + 2 * DAY_US });
    assert.equal(range(event),
        EventFormat.formatRangePrefix(event, TODAY, TODAY, OPTS) +
        EventFormat.ARROW_SEPARATOR +
        EventFormat.formatRangeSuffix(event, TODAY, TODAY, OPTS));
});

test("fuzz: range/suffix always return strings; multi-day ranges keep the arrow", () => {
    const rand = makeRandom(31337);
    for (let i = 0; i < 500; i++) {
        const startOffset = Math.floor((rand() - 0.5) * 12 * DAY_US);
        const duration = Math.floor(rand() * 4 * DAY_US) + 1000000;
        const selected = dateOnly(new FakeDateTime(NOW.usec + Math.floor((rand() - 0.5) * 10) * DAY_US));
        const event = makeEvent({
            startUs: NOW.usec + startOffset,
            endUs: NOW.usec + startOffset + duration,
            allDay: rand() < 0.3
        });

        const suffixResult = EventFormat.formatRangeSuffix(event, selected, TODAY, OPTS);
        assert.equal(typeof suffixResult, "string");
        assert.notEqual(suffixResult, "");

        const rangeResult = EventFormat.formatEventTimeRange(event, selected, TODAY, OPTS);
        assert.equal(typeof rangeResult, "string");
        assert.notEqual(rangeResult, "");
        const singleAllDay = event.starts_on_day(selected) && !event.multi_day && event.all_day;
        if (!singleAllDay) {
            assert.ok(rangeResult.includes(EventFormat.ARROW_SEPARATOR),
                `expected arrow in "${rangeResult}"`);
        }
    }
});

// T08a: full classification matrix — event shape x selected day x phase.
const OTHER_DAY = dateOnly(new FakeDateTime(TODAY.usec + 3 * DAY_US));
const CLASSIFY_MATRIX = [
    { name: "single timed past", startUs: NOW.usec - 3 * HOUR_US, endUs: NOW.usec - HOUR_US, allDay: false, selected: TODAY, phase: "past", next: false, countdown: false },
    { name: "single timed current", startUs: NOW.usec - HOUR_US, endUs: NOW.usec + HOUR_US, allDay: false, selected: TODAY, phase: "current", next: true, countdown: false },
    { name: "single timed upcoming today", startUs: NOW.usec + HOUR_US, endUs: NOW.usec + 2 * HOUR_US, allDay: false, selected: TODAY, phase: "upcoming", next: true, countdown: true },
    { name: "single timed upcoming other day", startUs: OTHER_DAY.usec + HOUR_US, endUs: OTHER_DAY.usec + 2 * HOUR_US, allDay: false, selected: OTHER_DAY, phase: "upcoming", next: false, countdown: false },
    { name: "single all-day current", startUs: TODAY.usec, endUs: TODAY.usec + DAY_US - 1000000, allDay: true, selected: TODAY, phase: "current", next: false, countdown: false },
    { name: "single all-day upcoming other day", startUs: OTHER_DAY.usec, endUs: OTHER_DAY.usec + DAY_US - 1000000, allDay: true, selected: OTHER_DAY, phase: "upcoming", next: false, countdown: false },
    { name: "multi-day timed spanning today", startUs: TODAY.usec - DAY_US, endUs: TODAY.usec + 2 * DAY_US, allDay: false, selected: TODAY, phase: "current", next: false, countdown: false },
    { name: "multi-day timed starting today viewed elsewhere", startUs: NOW.usec - HOUR_US, endUs: TODAY.usec + 2 * DAY_US, allDay: false, selected: OTHER_DAY, phase: "current", next: true, countdown: false },
    { name: "multi-day all-day past", startUs: TODAY.usec - 6 * DAY_US, endUs: TODAY.usec - 3 * DAY_US, allDay: true, selected: TODAY, phase: "past", next: false, countdown: false },
    { name: "multi-day all-day upcoming starting today", startUs: NOW.usec + HOUR_US, endUs: TODAY.usec + 3 * DAY_US, allDay: true, selected: OTHER_DAY, phase: "upcoming", next: false, countdown: true }
];

for (const c of CLASSIFY_MATRIX) {
    test(`classify matrix: ${c.name}`, () => {
        const event = makeEvent({ startUs: c.startUs, endUs: c.endUs, allDay: c.allDay });
        const state = EventFormat.classifyEventDisplayState(event, NOW, TODAY);
        assert.equal(state.phase, c.phase);
        assert.equal(state.is_current_or_next, c.next);
        assert.equal(state.show_countdown, c.countdown);
    });
}

// T08b: the injected time format must flow through to every timed label,
// and date-vs-weekday selection must key off the 4-day window.
const OPTS_12H = { ...OPTS, timeFormat: "%l:%M %p" };

test("formatters honor the 12-hour time format end to end", () => {
    const single = makeEvent({ startUs: NOW.usec + HOUR_US, endUs: NOW.usec + 2 * HOUR_US });
    assert.equal(EventFormat.formatEventTimeRange(single, TODAY, TODAY, OPTS_12H),
        single.start.format("%l:%M %p") + EventFormat.ARROW_SEPARATOR + single.end.format("%l:%M %p"));

    const multi = makeEvent({ startUs: NOW.usec - HOUR_US, endUs: TODAY.usec + DAY_US + 9 * HOUR_US });
    const label = EventFormat.formatEventTimeRange(multi, TODAY, TODAY, OPTS_12H);
    assert.ok(label.startsWith(multi.start.format("%l:%M %p")), label);
    assert.ok(label.includes("%l:%M %p|"), label);
    assert.ok(!label.includes("%H:%M"), label);
});

test("prefix flips from weekday to %x exactly at the 4-day window", () => {
    const inside = makeEvent({ startUs: TODAY.usec - 3 * DAY_US, endUs: TODAY.usec + DAY_US });
    assert.equal(prefix(inside), EventFormat.localeCap(inside.start_date.format("%A")));

    const outside = makeEvent({ startUs: TODAY.usec - 4 * DAY_US, endUs: TODAY.usec + DAY_US });
    assert.equal(prefix(outside), outside.start_date.format("%x"));
});

test("suffix flips from weekday to %x exactly at the 4-day window", () => {
    const inside = makeEvent({ startUs: TODAY.usec - DAY_US, endUs: TODAY.usec + 4 * DAY_US });
    assert.equal(suffix(inside), EventFormat.localeCap(inside.end_date.format("%A")));

    const outside = makeEvent({ startUs: TODAY.usec - DAY_US, endUs: TODAY.usec + 5 * DAY_US });
    assert.equal(suffix(outside), outside.end_date.format("%x"));
});

module.exports = { FakeDateTime, dateOnly, makeEvent, DAY_US, HOUR_US, NOW, TODAY, OPTS };
