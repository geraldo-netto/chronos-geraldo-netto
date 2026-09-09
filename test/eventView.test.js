const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");

const APPLET_DIR = path.join(__dirname, "..", "files", "chronos@geraldo-netto");

// The view no longer keeps a field pointing at each Tooltip it constructs: the
// fields were written and never read, and a test asserting through one was the
// only thing that made them look load-bearing. The double records what was
// constructed against which actor, which is what the assertions actually want.
class TooltipDouble {
    static instances = [];

    constructor(actor, text) {
        this.actor = actor;
        this.text = text;
        TooltipDouble.instances.push(this);
    }

    set_text(text) { this.text = text; }

    static forActor(actor) {
        return TooltipDouble.instances.find((tooltip) => tooltip.actor === actor);
    }
}

const DAY_US = 24 * 3600 * 1000 * 1000;
const DAY_S = 24 * 3600;

class FakeDateTime {
    constructor(usec) {
        this.usec = usec;
    }

    to_unix() {
        return Math.floor(this.usec / 1000000);
    }

    get_utc_offset() { return 0; }

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

    add_hours(hours) {
        return new FakeDateTime(this.usec + hours * 3600 * 1000000);
    }

    get_hour() {
        return Math.floor((this.usec % DAY_US) / (3600 * 1000000));
    }

    get_year() {
        return this.civil_date().getUTCFullYear();
    }

    get_month() {
        return this.civil_date().getUTCMonth() + 1;
    }

    get_day_of_month() {
        return this.civil_date().getUTCDate();
    }

    civil_date() {
        return new Date(Date.UTC(1999, 11, 31) + this.usec / 1000);
    }

    format(fmt) {
        const hour = this.get_hour();
        const minute = String(Math.floor(
            (this.usec % (3600 * 1000000)) / (60 * 1000000))).padStart(2, "0");
        if (fmt === "%H:%M") {
            return `${String(hour).padStart(2, "0")}:${minute}`;
        }
        if (fmt === "%-l:%M %p") {
            return `${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"}`;
        }
        return `${fmt}|day${Math.floor(this.usec / DAY_US)}`;
    }
}

const NOW = new FakeDateTime(50 * DAY_US + 12 * 3600 * 1000000);

function selectDate(list, date) {
    list.set_date({ year: date.get_year(), month: date.get_month(),
        day: date.get_day_of_month() }, date);
}

class MockActor {
    constructor(options = {}) {
        this.options = options;
        this.children = [];
        this.handlers = {};
        this.style_class = options.style_class || "";
        this.style = options.style || "";
        this.text = options.text || "";
        this.visible = options.visible;
        this.can_focus = options.can_focus;
        this.pseudo_classes = new Set();
    }

    connect(name, cb) {
        (this.handlers[name] = this.handlers[name] || []).push(cb);
        return this.handlers[name].length;
    }

    fire(name, ...args) {
        (this.handlers[name] || []).forEach((cb) => cb(this, ...args));
    }

    add(child) {
        this.children.push(child);
        child.parent = this;
    }

    add_actor(child) {
        this.children.push(child);
        child.parent = this;
    }

    set_child_at_index(child, index) {
        const previous = this.children.indexOf(child);
        assert.notEqual(previous, -1, "only an existing child can be reordered");
        this.children.splice(previous, 1);
        this.children.splice(index, 0, child);
    }

    get_children() {
        return this.children.slice();
    }

    show() {
        this.visible = true;
    }

    hide() {
        this.visible = false;
    }

    get visible() { return this._visible; }

    set visible(value) {
        this._visible = value;
        if (value === false && global.stage && this.contains(global.stage.get_key_focus())) {
            global.stage.set_key_focus(null);
        }
    }

    destroy() {
        if (global.stage && this.contains(global.stage.get_key_focus())) {
            global.stage.set_key_focus(null);
        }
        this.destroyed = true;
        if (this.parent) {
            this.parent.children = this.parent.children.filter((child) => child !== this);
        }
    }

    contains(actor) {
        return this === actor || this.children.some(child => child.contains(actor));
    }

    grab_key_focus() {
        global.stage.set_key_focus(this);
    }

    get_vscroll_bar() {
        if (!this.vscroll) {
            this.vscroll = {
                handlers: {},
                adjustment: {
                    page_size: 200,
                    values: [],
                    set_value(value) {
                        this.values.push(value);
                    }
                },
                connect(name, cb) {
                    this.handlers[name] = cb;
                    return Object.keys(this.handlers).length;
                },
                get_adjustment() {
                    return this.adjustment;
                }
            };
        }
        return this.vscroll;
    }

    add_style_pseudo_class(name) {
        this.pseudo_classes.add(name);
    }

    remove_style_pseudo_class(name) {
        this.pseudo_classes.delete(name);
    }

    set_style_pseudo_class(name) {
        this.pseudo_classes = new Set(name ? [name] : []);
    }

    set_style_class_name(name) {
        this.style_class = name;
    }

    set_text(text) {
        this.text = text;
    }

    set_accessible_name(name) {
        this.accessible_name = name;
    }

    set_accessible_role(role) {
        this.accessible_role = role;
    }

    // one text object per actor, so what production writes to it can be read
    // back — a fresh object per call silently swallowed every assignment
    get_clutter_text() {
        if (!this._clutter_text) {
            this._clutter_text = { line_wrap: false, ellipsize: null };
        }
        return this._clutter_text;
    }
}

global.log = () => {};

// GJS installs a printf-style String.prototype.format
if (!String.prototype.format) {
    Object.defineProperty(String.prototype, "format", {
        value: function(...args) {
            let i = 0;
            return this.replace(/%[ds]/g, () => String(args[i++]));
        }
    });
}
global.imports = {
    gi: {
        Clutter: { ActorAlign: { START: 0, END: 1, CENTER: 2 }, BUTTON_PRIMARY: 1, EVENT_STOP: true,
            EVENT_PROPAGATE: false, KEY_Return: 65293, KEY_KP_Enter: 65421, KEY_space: 32 },
        GLib: {
            get_language_names: () => ["C"],
            SOURCE_REMOVE: false,
            TIME_SPAN_MINUTE: 60 * 1000 * 1000,
            TIME_SPAN_DAY: DAY_US,
            get_home_dir: () => "/home/x",
            get_monotonic_time: () => 1,
            get_user_cache_dir: () => "/tmp/cache",
            build_filenamev: (parts) => parts.join("/"),
            find_program_in_path: () => null,
            TimeType: { STANDARD: 0, DAYLIGHT: 1 },
            TimeZone: { new_local: () => ({ find_interval: () => -1 }) },
            DateTime: {
                new(timezone, ...args) { return this.new_local(...args); },
                new_from_unix_local: (unix) => new FakeDateTime(unix * 1000000),
                new_local: (y, m, day) => new FakeDateTime(
                    (Date.UTC(y, m - 1, day) - Date.UTC(1999, 11, 31)) * 1000),
                new_utc(y, m, day) { return this.new_local(y, m, day); },
                new_now_local: () => NOW
            }
        },
        St: { BoxLayout: MockActor, Bin: MockActor, Label: MockActor, Widget: MockActor,
            ScrollView: MockActor, Button: MockActor, Icon: MockActor,
            IconType: { SYMBOLIC: 1 } },
        // the real enum, which has no NEVER: the stub used to invent one, so
        // production's Pango.EllipsizeMode.NEVER — undefined under GJS, and
        // only coerced to NONE by luck — looked deliberate here
        Pango: { EllipsizeMode: { NONE: 0, START: 1, MIDDLE: 2, END: 3 } },
        Cinnamon: {},
        Atk: { Role: { LIST: 1, LIST_ITEM: 2, PUSH_BUTTON: 3, LABEL: 4 } },
        Gtk: { PolicyType: { NEVER: 0, AUTOMATIC: 1 } },
        Gio: {},
        Soup: { MAJOR_VERSION: 3, Session: class {} },
        CinnamonDesktop: { WallClock: { lctime_format: (d, f) => f } }
    },
    lang: {
        bind: (self, fn, ...args) => fn.bind(self, ...args)
    },
    byteArray: {},
    signals: {
        addSignalMethods(proto) {
            proto.connect = function() { return 1; };
            proto.emit = function(name, ...args) {
                this._emitted = this._emitted || [];
                this._emitted.push({ name, args });
            };
        }
    },
    mainloop: { timeout_add_seconds: () => 1, idle_add: () => 1, source_remove: () => {},
        timeout_add: () => 1 },
    gettext: {
        bindtextdomain: () => {},
        dgettext: (domain, str) => str,
        dngettext: (domain, s, p, n) => (n === 1 ? s : p)
    },
    ui: {
        separator: { Separator: class { constructor() { this.actor = new MockActor(); } } },
        tooltips: { Tooltip: TooltipDouble },
        appletManager: { applets: { "chronos@geraldo-netto": {} } }
    },
    misc: { util: {} }
};

// the root modules read global.imports at require time, so load them after
// the mock exists and then expose them through the native-importer path
const rootModules = global.imports.ui.appletManager.applets["chronos@geraldo-netto"];
rootModules.dateMath = require(path.join(APPLET_DIR, "dateMath.js"));
rootModules.civilTime = require(path.join(APPLET_DIR, "civilTime.js"));
rootModules.dateFormats = require(path.join(APPLET_DIR, "dateFormats.js"));
rootModules.localeText = require(path.join(APPLET_DIR, "localeText.js"));
rootModules.styleUtils = require(path.join(APPLET_DIR, "styleUtils.js"));
rootModules.eventData = require(path.join(APPLET_DIR, "eventData.js"));
rootModules.eventFormat = require(path.join(APPLET_DIR, "eventFormat.js"));
rootModules.calendarServerConnection = require(path.join(APPLET_DIR, "calendarServerConnection.js"));
rootModules.eventIndex = require(path.join(APPLET_DIR, "eventIndex.js"));
rootModules.eventWindow = require(path.join(APPLET_DIR, "eventWindow.js"));
rootModules.eventsManager = require(path.join(APPLET_DIR, "eventsManager.js"));
rootModules.worldclockData = require(path.join(APPLET_DIR, "worldclockData.js"));
rootModules.holidayConstants = require(path.join(APPLET_DIR, "holidayConstants.js"));

const EventView = require(path.join(APPLET_DIR, "6.0", "eventView.js"));
const LauncherModule = require(path.join(APPLET_DIR, "6.0", "calendarLauncher.js"));
const CoordinatorModule = require(path.join(APPLET_DIR, "6.0", "appletCoordinators.js"));

// A row's launcher is the list's: EventRow used to default to a fresh
// CalendarLauncher, which quietly gave every row its own memo of
// find_program_in_path — the one thing the class exists to prevent.
// the desktop-settings facade: the applet reads use24h off it rather than
// passing a raw "clock-use-24h" string to Gio
function desktopSettings(use24h = true) {
    return { use24h, showSeconds: false, connect: () => 1, disconnect: () => {} };
}

function rowParams(overrides = {}) {
    return Object.assign(
        { use_24h: true, launcher: new LauncherModule.CalendarLauncher() },
        overrides);
}
const EventFormat = require(path.join(APPLET_DIR, "eventFormat.js"));
const { EventData, EventDataList } = require(path.join(APPLET_DIR, "eventData.js"));

function makeRowEvent({ id = "id1", summary = "Team sync",
    startUnix, endUnix, allDay = false, color = "#123456" }) {
    return new EventData({
        deep_unpack: () => [id, color, summary, allDay, startUnix, endUnix, 1]
    }, 0);
}

const TODAY = new FakeDateTime(50 * DAY_US);

test("selected-day agenda composes each holiday kind without another data source", () => {
    const calendarEvent = makeRowEvent({
        startUnix: 50 * DAY_S + 14 * 3600,
        endUnix: 50 * DAY_S + 15 * 3600
    });
    const events = {
        timestamp: 7,
        length: 1,
        get_event_list: () => [calendarEvent]
    };
    const cases = [
        [{ name: "Republic Day", flags: ["public_holiday"] }, "Public holiday"],
        [{ name: "Shavuot", flags: ["religious_holiday", "judaism"] }, "Religious observance"],
        [{ name: "Team anniversary", flags: ["calendar_observance"] }, "Calendar observance"],
        [{ name: "Republic Day\nShavuot", flags: ["public_holiday", "religious_holiday", "judaism"] },
            "Public holiday and religious observance"]
    ];

    for (const [holiday, type] of cases) {
        const agenda = EventView.composeSelectedDayAgenda(events, holiday);
        assert.equal(agenda.length, 2);
        assert.equal(agenda.hasHolidays, true);
        assert.equal(agenda.get_event_list()[0].summary, holiday.name);
        assert.equal(EventView.holidayAgendaType(holiday.flags), type);
        assert.equal(agenda.get_event_list()[1], calendarEvent);
        assert.deepEqual(agenda.holidaysOnly().get_event_list().map((event) => event.summary),
            [holiday.name]);
    }

    // T797: this used to answer the raw EventDataList on a day with no holiday
    // and a SelectedDayAgenda on a day with one — two unrelated types chosen by
    // data, so a renderer reading a member only EventDataList carries would
    // have worked every day except on holidays. One shape whenever there is a
    // shape at all.
    const holidayFree = EventView.composeSelectedDayAgenda(events, null);
    assert.notEqual(holidayFree, events, "the calendar-server model is wrapped");
    assert.equal(holidayFree.hasHolidays, false);
    assert.equal(holidayFree.length, 1);
    assert.deepEqual(holidayFree.get_event_list(), [calendarEvent]);

    // nothing to draw stays nothing to draw: that is what raises the "no
    // events" box, and the renderer branches on presence rather than on type
    assert.equal(EventView.composeSelectedDayAgenda(null, null), null);
});

test("holiday agenda rows are all-day information, not calendar launch controls", () => {
    const event = EventView.composeSelectedDayAgenda(null,
        { name: "Shavuot", flags: ["religious_holiday", "judaism"] }).get_event_list()[0];
    const row = new EventView.EventRow(event, TODAY, rowParams());

    assert.equal(row.event_time.text, "Religious observance");
    assert.ok(row.event_time.pseudo_classes.has("all-day"));
    assert.equal(row.actor.options.reactive, false);
    assert.equal(row.actor.options.can_focus, false);
    assert.equal(row.actor.accessible_name, "Religious observance — Shavuot");
});

test("EventRow renders the formatted time range into its label", () => {
    const event = makeRowEvent({ startUnix: 50 * DAY_S + 14 * 3600, endUnix: 50 * DAY_S + 15 * 3600 });
    const row = new EventView.EventRow(event, TODAY, rowParams());

    const expected = EventFormat.formatEventTimeRange(event, TODAY, TODAY, {
        timeFormat: "%H:%M",
        dayFormat: rootModules.dateFormats.DAY_FORMAT,
        translate: (s) => s
    });
    assert.equal(row.event_time.text, expected);
    assert.equal(row.event_time.style_class, "calendar-event-time-future");
    assert.ok(row.countdown_label.text.length > 0, "upcoming-today event shows a countdown");
    assert.equal(row.is_current_or_next, true);
});

// the rows sit in a box that declares itself a list, and they were plain
// focusable boxes holding three separate labels: a list with no items, whose
// items had no names
test("an event row says its time, its summary and its countdown as one thing", () => {
    const event = makeRowEvent({ startUnix: 50 * DAY_S + 14 * 3600, endUnix: 50 * DAY_S + 15 * 3600 });
    const row = new EventView.EventRow(event, TODAY, rowParams());

    assert.equal(row.actor.accessible_role, global.imports.gi.Atk.Role.LIST_ITEM);
    assert.equal(row.actor.accessible_name,
        [row.event_time.text, "Team sync", row.countdown_label.text].join(" — "));

    // a past event says its state instead of relying on the time colour alone
    const past = new EventView.EventRow(
        makeRowEvent({ startUnix: 50 * DAY_S + 3600, endUnix: 50 * DAY_S + 7200 }),
        TODAY, rowParams());
    assert.equal(past.actor.accessible_name, `${past.event_time.text} — Team sync — Ended`);
});

test("EventRow marks past events with a visible and accessible state", () => {
    const event = makeRowEvent({ startUnix: 50 * DAY_S + 3600, endUnix: 50 * DAY_S + 7200 });
    const row = new EventView.EventRow(event, TODAY, rowParams());
    assert.equal(row.event_time.style_class, "calendar-event-time-past");
    assert.equal(row.countdown_label.text, "Ended");
    assert.deepEqual([...row.countdown_label.pseudo_classes], ["ended"]);
    assert.match(row.actor.accessible_name, / — Ended$/);
    assert.equal(row.is_current_or_next, false);
});

test("EventRow shows In progress for a current timed event", () => {
    const event = makeRowEvent({ startUnix: 50 * DAY_S + 11 * 3600, endUnix: 50 * DAY_S + 13 * 3600 });
    const row = new EventView.EventRow(event, TODAY, rowParams());
    assert.equal(row.countdown_label.text, "In progress");
    assert.equal(row.event_time.style_class, "calendar-event-time-present");
});

test("EventRow colors its strip from the event and toggles hover", () => {
    const event = makeRowEvent({
        startUnix: 50 * DAY_S + 14 * 3600, endUnix: 50 * DAY_S + 15 * 3600, color: "#abcdef"
    });
    const row = new EventView.EventRow(event, TODAY, rowParams());
    const strip = row.actor.children[0];
    assert.ok(strip.options.style.includes("#abcdef"));

    const hostile = makeRowEvent({
        startUnix: 50 * DAY_S + 14 * 3600, endUnix: 50 * DAY_S + 15 * 3600,
        color: "red; background-image: url(http://evil)"
    });
    const hostileRow = new EventView.EventRow(hostile, TODAY, rowParams());
    const hostileStrip = hostileRow.actor.children[0];
    assert.ok(!hostileStrip.options.style.includes("url("), hostileStrip.options.style);
    assert.ok(hostileStrip.options.style.includes("transparent"));

    // hover only means something on a row that can be opened, so the row under
    // test needs a calendar app to open
    const launcher = { isAvailable: () => true, launchDate: () => true, launchUuid: () => true };
    const live = new EventView.EventRow(event, TODAY, { use_24h: true, launcher });
    live.actor.fire("enter-event");
    assert.ok(live.actor.pseudo_classes.has("hover"));
    live.actor.fire("leave-event");
    assert.ok(!live.actor.pseudo_classes.has("hover"));
});

// T26: format_timespan thresholds (fake now is day 50 at 12:00)
const MIN_US = 60 * 1000 * 1000;

test("format_timespan: under 10 minutes is imminent", () => {
    const [pclass, text] = EventView.format_timespan(9 * MIN_US);
    assert.equal(pclass, "imminent");
    assert.equal(text, "Starting in a few minutes");
});

test("format_timespan: under an hour counts minutes", () => {
    const [pclass, text] = EventView.format_timespan(45 * MIN_US);
    assert.equal(pclass, "soon");
    assert.equal(text, "Starting in 45 minutes");
});

test("format_timespan: whole hours use the plural form", () => {
    assert.deepEqual(EventView.format_timespan(60 * MIN_US), ["", "In 1 hour"]);
    assert.deepEqual(EventView.format_timespan(3 * 3600 * 1000 * 1000), ["", "In 3 hours"]);
    assert.deepEqual(EventView.format_timespan(6 * 3600 * 1000 * 1000), ["", "In 6 hours"]);
});

// more than six hours out, the wording stops counting and names the time of day
test("format_timespan: past six hours it names the part of the day", () => {
    const GLibStub = global.imports.gi.GLib;
    const original = GLibStub.DateTime.new_now_local;
    const at = (hour) => new FakeDateTime(50 * DAY_US + hour * 3600 * 1000000);

    try {
        // noon plus seven hours is 19:00
        GLibStub.DateTime.new_now_local = () => at(12);
        assert.deepEqual(EventView.format_timespan(7 * 3600 * 1000 * 1000),
            ["", "This evening"]);

        // ...and the same seven hours from 06:00 is 13:00, which is not
        GLibStub.DateTime.new_now_local = () => at(6);
        assert.deepEqual(EventView.format_timespan(7 * 3600 * 1000 * 1000),
            ["", "Starting later today"]);
    } finally {
        GLibStub.DateTime.new_now_local = original;
    }
});

// a holiday with no flags at all is still a holiday
test("holidayAgendaType names an unflagged holiday", () => {
    assert.equal(EventView.holidayAgendaType([]), "Holiday");
    assert.equal(EventView.holidayAgendaType(), "Holiday");
});

test("format_timespan uses UUID-domain plural translations when present", () => {
    const original = global.imports.gettext.dngettext;
    global.imports.gettext.dngettext = (domain, singular, plural, n) =>
        domain === "chronos@geraldo-netto" ? "Translated %d" : (n === 1 ? singular : plural);
    assert.deepEqual(EventView.format_timespan(2 * 3600 * 1000 * 1000), ["", "Translated 2"]);
    global.imports.gettext.dngettext = original;
});

test("format_timespan: beyond six hours becomes evening or later today", () => {
    // now is 12:00; +7h lands at 19:00 (> 18) => evening
    assert.deepEqual(EventView.format_timespan(7 * 3600 * 1000 * 1000), ["", "This evening"]);
    // the boundary: +6h at 18:00 is not > 18, but 6h is not > 6 either => plural hours
    assert.deepEqual(EventView.format_timespan(6.5 * 3600 * 1000 * 1000), ["", "In 6 hours"]);
});

test("fuzz: format_timespan always returns a class and non-empty text", () => {
    const rand = makeRandom(999);
    for (let i = 0; i < 400; i++) {
        const span = Math.floor(rand() * 12 * 3600 * 1000 * 1000);
        const [pclass, text] = EventView.format_timespan(span);
        assert.ok(["imminent", "soon", ""].includes(pclass));
        assert.equal(typeof text, "string");
        assert.ok(text.length > 0);
    }
});

test("EventRow is keyboard-focusable and activates on Return/space", () => {
    // rows only wire activation when gnome-calendar is installed
    global.imports.gi.GLib.find_program_in_path = () => "/usr/bin/gnome-calendar";
    const event = makeRowEvent({ startUnix: 50 * DAY_S + 14 * 3600, endUnix: 50 * DAY_S + 15 * 3600 });
    const row = new EventView.EventRow(event, TODAY, rowParams());
    global.imports.gi.GLib.find_program_in_path = () => null;

    assert.equal(row.actor.options.can_focus, true);

    const emitted = [];
    row.emit = (name, id) => emitted.push([name, id]);
    row.actor.fire("key-press-event", { get_key_symbol: () => 65293 }); // Return
    row.actor.fire("key-press-event", { get_key_symbol: () => 32 });    // space
    row.actor.fire("key-press-event", { get_key_symbol: () => 999 });   // ignored
    assert.deepEqual(emitted, [["view-event", "id1"], ["view-event", "id1"]]);
});

test("EventList launches calendar only when available", () => {
    const spawned = [];
    const logged = [];
    global.log = (message) => logged.push(message);
    global.imports.misc.util.trySpawn = (args) => spawned.push(args);

    // no gnome-calendar on this box
    const without = new EventView.EventList(desktopSettings());
    without.launch_calendar(TODAY);
    assert.deepEqual(spawned, []);

    global.imports.gi.GLib.find_program_in_path = () => "/usr/bin/gnome-calendar";
    const with_ = new EventView.EventList(desktopSettings());
    global.imports.gi.GLib.find_program_in_path = () => null;

    with_.launch_calendar(TODAY);
    assert.deepEqual(spawned, [["gnome-calendar", "--date", TODAY.format("%x")]]);
    assert.equal(with_._emitted.at(-1).name, "launched-calendar");

    const emittedBeforeFailure = with_._emitted.length;
    global.imports.misc.util.trySpawn = () => {
        throw new Error("process failed with date argv");
    };
    with_.launch_calendar(TODAY);
    assert.equal(with_._emitted.length, emittedBeforeFailure,
        "a failed spawn must not report a launched calendar");
    assert.equal(logged.at(-1),
        "Chronos: gnome-calendar could not open the requested date");
    assert.doesNotMatch(logged.at(-1), /argv|day50/);
    global.log = () => {};
});

test("CalendarLauncher owns date and uuid launch commands", () => {
    const spawned = [];
    global.imports.misc.util.trySpawn = (args) => spawned.push(args);
    const logged = [];
    global.log = (message) => logged.push(message);

    // gnome-calendar does not come and go while the shell runs, so a launcher
    // asks $PATH once and keeps the answer: a launcher built without it stays
    // unavailable, one built with it stays available
    global.imports.gi.GLib.find_program_in_path = () => null;
    const missing = new LauncherModule.CalendarLauncher();
    assert.equal(missing.isAvailable(), false);
    assert.equal(missing.launchDate(TODAY), false);
    assert.equal(missing.launchUuid("uuid-1"), false);

    let scans = 0;
    global.imports.gi.GLib.find_program_in_path = () => {
        scans++;
        return "/usr/bin/gnome-calendar";
    };
    const present = new LauncherModule.CalendarLauncher();
    assert.equal(present.isAvailable(), true);
    assert.equal(present.launchDate(TODAY), true);
    assert.equal(present.launchUuid("uuid-1"), true);
    assert.equal(scans, 1, "the PATH is scanned once, not once per event row");
    global.imports.gi.GLib.find_program_in_path = () => null;

    // the uid comes off a subscribed feed, so one that starts with a dash must
    // reach gnome-calendar as a value, not as an option
    assert.deepEqual(spawned, [
        ["gnome-calendar", "--date", TODAY.format("%x")],
        ["gnome-calendar", "--uuid=uuid-1"]
    ]);

    present.launchUuid("--version");
    assert.deepEqual(spawned.at(-1), ["gnome-calendar", "--uuid=--version"]);

    const max = LauncherModule.MAX_EVENT_UID_LENGTH;
    assert.equal(present.launchUuid("x".repeat(max)), true);
    assert.equal(spawned.at(-1)[1].length, "--uuid=".length + max);
    assert.equal(present.launchUuid("x".repeat(max + 1)), false);
    assert.equal(present.launchUuid(null), false);
    assert.equal(logged.length, 2);
    assert.ok(logged.every((message) => !message.includes("x".repeat(100))));

    global.imports.misc.util.trySpawn = () => {
        throw new Error("E2BIG with feed-controlled argv");
    };
    assert.equal(present.launchUuid("still-safe"), false);
    assert.doesNotMatch(logged.at(-1), /feed-controlled|still-safe/);
    global.log = () => {};
});

test("an oversized event UID cannot make a row look activatable", () => {
    global.imports.gi.GLib.find_program_in_path = () => "/usr/bin/gnome-calendar";
    // the data contract refuses such a UID at admission (T579); forge one past
    // it so the row's own guard stays pinned as defense in depth
    const event = makeRowEvent({
        id: "x",
        startUnix: 50 * DAY_S + 14 * 3600,
        endUnix: 50 * DAY_S + 15 * 3600
    });
    event.id = "x".repeat(LauncherModule.MAX_EVENT_UID_LENGTH + 1);
    const row = new EventView.EventRow(event, TODAY, rowParams());
    global.imports.gi.GLib.find_program_in_path = () => null;

    assert.equal(LauncherModule.eventUidCanLaunch(event.id), false);
    assert.equal(row.actor.options.reactive, false);
    assert.equal(row.actor.options.can_focus, false);
    assert.equal(Object.keys(row.actor.handlers).length, 0);
});

test("the selected-date label is reachable from the keyboard and explains itself", () => {
    global.imports.gi.GLib.find_program_in_path = () => "/usr/bin/gnome-calendar";
    const list = new EventView.EventList(desktopSettings());
    global.imports.gi.GLib.find_program_in_path = () => null;

    const launched = [];
    list.launch_calendar = (date) => launched.push(date);

    assert.equal(list.selected_date_label.options.can_focus, true);
    assert.equal(TooltipDouble.forActor(list.selected_date_label).text, "Open the calendar app");

    // An explicit ATK name replaces the label's own text, so naming this only
    // "Open the calendar app" made the selected date - which this heading is
    // the only place to read - unsayable. The date leads; what clicking it does
    // comes after.
    selectDate(list, new FakeDateTime(10 * DAY_US));
    const dateText = list.selected_date_label.text;
    assert.ok(dateText, "the heading shows the selected date");
    assert.equal(list.selected_date_label.accessible_name, `${dateText} — Open the calendar app`);
    assert.equal(list.selected_date_label.accessible_role,
        global.imports.gi.Atk.Role.PUSH_BUTTON);

    const originalFormat = FakeDateTime.prototype.format;
    let failedPrimary = false;
    FakeDateTime.prototype.format = function (format) {
        if (!failedPrimary) {
            failedPrimary = true;
            return null;
        }
        return originalFormat.call(this, format);
    };
    selectDate(list, new FakeDateTime(11 * DAY_US));
    assert.match(list.selected_date_label.text,
        new RegExp(rootModules.dateFormats.DATE_FORMAT_FULL_FALLBACK.replace(
            /[.*+?^${}()|[\]\\]/g, "\\$&")));
    FakeDateTime.prototype.format = originalFormat;

    // Enter, KP_Enter and space activate it; anything else is left alone
    const press = (symbol) =>
        list.selected_date_label.handlers["key-press-event"][0](
            list.selected_date_label, { get_key_symbol: () => symbol });

    for (const symbol of [65293, 65421, 32]) {
        assert.equal(press(symbol), true);
    }
    assert.equal(press(999), false);
    assert.equal(launched.length, 3);
});

test("the selected-date label is inert without a calendar app", () => {
    // gnome-calendar is absent in this harness by default
    const list = new EventView.EventList(desktopSettings());

    assert.equal(list.selected_date_label.options.reactive, false);
    assert.equal(list.selected_date_label.options.can_focus, false);
    assert.equal((list.selected_date_label.handlers["key-press-event"] || []).length, 0);
});

test("set_unavailable swaps the placeholder text and blocks event rendering", () => {
    const list = new EventView.EventList(desktopSettings());

    list.set_unavailable(true);
    // "unavailable" on its own leaves the user with nothing to do about it
    assert.match(list.no_events_label.text, /^Calendar events are unavailable/);
    assert.match(list.no_events_label.text, /Evolution Data Server/,
        "the message says what is missing and what would fix it");
    assert.equal(list.no_events_button.accessible_name, list.no_events_label.text,
        "the button says what the label under it says, and no more");
    assert.doesNotMatch(list.no_events_button.accessible_name, /Add an event/,
        "and it no longer claims it adds an event");
    assert.equal(list.no_events_box.visible, true);

    // events that arrive while no service is available must not overwrite it
    list.set_events(null, false);
    assert.match(list.no_events_label.text, /^Calendar events are unavailable/);

    list.set_unavailable(false);
    assert.equal(list.no_events_label.text, "No Events");
    list.set_unavailable(false);
});

test("holidays remain visible without a calendar service, and so does the remedy", () => {
    const list = new EventView.EventList(desktopSettings());
    const agenda = EventView.composeSelectedDayAgenda(null,
        { name: "Republic Day", flags: ["public_holiday"] });

    list.set_events(agenda, false);
    list.set_unavailable(true);
    assert.deepEqual(list.rows.map((row) => row.event.summary), ["Republic Day"]);
    // Dropping the notice here rendered precisely what a healthy service
    // renders on a day whose only entry is that holiday, while the footer went
    // on reporting the outage — the column contradicting its own status.
    assert.equal(list.no_events_box.visible, true);
    assert.match(list.no_events_label.text, /^Calendar events are unavailable/);

    list.set_events(null, false);
    assert.equal(list.rows.length, 0);
    assert.equal(list.no_events_box.visible, true);
    assert.match(list.no_events_label.text, /^Calendar events are unavailable/);

    list.set_unavailable(false);
    list.set_events(agenda, false);
    assert.deepEqual(list.rows.map((row) => row.event.summary), ["Republic Day"],
        "and a healthy service shows the same day without the notice");
    assert.equal(list.no_events_box.visible, false);
});

// an explicit ATK name replaces the button's child text, so a name fixed at
// construction meant neither "Loading…" nor "No Events" was ever announced
test("the empty state's name follows the words under it", () => {
    const launcher = { isAvailable: () => true, launchDate: () => true, launchUuid: () => true };
    const list = new EventView.EventList(desktopSettings(), launcher);

    assert.match(list.no_events_button.accessible_name, /^No Events — /);

    const pending = [];
    const originalTimeout = global.imports.mainloop.timeout_add;
    global.imports.mainloop.timeout_add = (delay, cb) => {
        pending.push(cb);
        return pending.length;
    };

    list.set_events(null, true);
    assert.equal(list.no_events_label.text, "Loading…");
    assert.match(list.no_events_button.accessible_name, /^Loading… — /,
        "a screen reader must hear the column is still loading, not 'Add an event'");

    pending.forEach((cb) => cb());
    global.imports.mainloop.timeout_add = originalTimeout;

    assert.equal(list.no_events_label.text, "No Events");
    assert.match(list.no_events_button.accessible_name, /^No Events — /);
});

// the unavailable message is a whole sentence, and an St.Label ellipsizes:
// the half that says what to do about it was the half that got cut
test("the empty-state message wraps instead of being cut off", () => {
    const list = new EventView.EventList(desktopSettings());
    const text = list.no_events_label.get_clutter_text();

    assert.equal(text.line_wrap, true);
    assert.equal(text.ellipsize, 0, "Pango.EllipsizeMode.NONE");

    // and the label has a width to wrap against: the column itself has a
    // min-width and no max, so without this the popup just grows
    const css = fs.readFileSync(
        path.join(APPLET_DIR, "6.0", "stylesheet.css"), "utf8");
    assert.match(css, /\.calendar-events-no-events-label\s*\{[^}]*max-width/);
});

// arming "Loading…" and then answering before the 600ms timer fires cancels the
// timer that would have written "No Events" — the column stayed on "Loading…"
test("an undelayed empty answer clears a pending Loading… state", () => {
    const list = new EventView.EventList(desktopSettings());

    const pending = [];
    const originalTimeout = global.imports.mainloop.timeout_add;
    global.imports.mainloop.timeout_add = (delay, cb) => {
        pending.push(cb);
        return pending.length;
    };

    list.set_events(null, true);
    assert.equal(list.no_events_label.text, "Loading…");

    // EDS answers "nothing here" before the timer fires: setEvents cancels it
    list.set_events(null, false);
    global.imports.mainloop.timeout_add = originalTimeout;

    assert.equal(list.no_events_label.text, "No Events",
        "the column must not sit on Loading… for a fetch that already answered");
    assert.equal(list.no_events_box.visible, true);
});

test("the empty state is not a button when there is no calendar app to open", () => {
    // gnome-calendar is absent in this harness by default
    const list = new EventView.EventList(desktopSettings());

    assert.equal(list.no_events_button.options.reactive, false);
    assert.equal(list.no_events_button.options.can_focus, false);
    assert.equal(list.no_events_button.options.style_class, "",
        "no themed button chrome: it would look clickable and do nothing");
    assert.equal((list.no_events_button.handlers["clicked"] || []).length, 0);
});

test("an event row is not a button when there is no calendar app to open", () => {
    // gnome-calendar is absent in this harness by default, so connectActivation
    // wires nothing: a focusable, hovering row that ignores Enter is a lie
    const event = makeRowEvent({ startUnix: 50 * DAY_S + 14 * 3600, endUnix: 50 * DAY_S + 15 * 3600 });
    const row = new EventView.EventRow(event, TODAY, rowParams());

    assert.equal(row.actor.options.reactive, false);
    assert.equal(row.actor.options.can_focus, false);
    assert.equal((row.actor.handlers["key-press-event"] || []).length, 0);
    assert.equal((row.actor.handlers["enter-event"] || []).length, 0,
        "and it does not light up on hover either");
});

test("EventList constructor wires clickable labels, buttons, and scroll pass-through", () => {
    global.imports.gi.GLib.find_program_in_path = () => "/usr/bin/gnome-calendar";
    const list = new EventView.EventList(desktopSettings());
    global.imports.gi.GLib.find_program_in_path = () => null;
    const launched = [];
    list.launch_calendar = (date) => launched.push(date);

    assert.equal(
        list.selected_date_label.fire("button-press-event", { get_button: () => 1 }),
        undefined
    );
    list.no_events_button.fire("clicked");
    assert.equal(launched.length, 2);

    list.events_scroll_box.vscroll.handlers["scroll-start"]();
    list.events_scroll_box.vscroll.handlers["scroll-stop"]();
    assert.deepEqual(list._emitted.map((event) => event.name), [
        "start-pass-events", "stop-pass-events"
    ]);
});

test("EventList set_date skips unchanged dates and updates changed dates", () => {
    const list = new EventView.EventList(desktopSettings());
    selectDate(list, TODAY);
    const first = list.selected_date_label.text;
    selectDate(list, TODAY);
    assert.equal(list.selected_date_label.text, first);

    const tomorrow = TODAY.add_days(1);
    selectDate(list, tomorrow);
    assert.notEqual(list.selected_date_label.text, first);
    assert.equal(list.selected_date, tomorrow);
});

test("EventList set_events covers empty, delayed, reuse, and scroll paths", () => {
    const removed = [];
    const idleCallbacks = [];
    global.imports.mainloop.source_remove = (id) => removed.push(id);
    global.imports.mainloop.timeout_add = (delay, cb) => {
        idleCallbacks.push(cb);
        return 10 + idleCallbacks.length;
    };
    global.imports.mainloop.idle_add = (cb) => {
        idleCallbacks.push(cb);
        return 20 + idleCallbacks.length;
    };

    const list = new EventView.EventList(desktopSettings());
    list._renderer._scroll_to_idle_id = 42;
    list._renderer._no_events_timeout_id = 43;
    list.events_box.children.push(new MockActor(), new MockActor());
    list.set_events(null, true);
    assert.ok(removed.includes(42));
    assert.ok(removed.includes(43));
    assert.ok(list.events_box.children.every((actor) => actor.destroyed));

    // the events may still be on their way from a slow calendar server: the
    // column used to sit blank and then jump to "No Events", asserting an empty
    // state before it was known to be true
    assert.equal(list.no_events_box.visible, true);
    assert.equal(list.no_events_label.text, "Loading…");

    idleCallbacks.shift()();
    assert.equal(list.no_events_box.visible, true);
    assert.equal(list.no_events_label.text, "No Events", "and now it really is empty");

    list.set_events(null, false);
    assert.equal(list.no_events_box.visible, true);

    const event = makeRowEvent({
        startUnix: 50 * DAY_S + 14 * 3600,
        endUnix: 50 * DAY_S + 15 * 3600
    });
    const dataList = {
        timestamp: 99,
        get_event_list: () => [event]
    };
    list.set_events(dataList, false);
    assert.equal(list.no_events_box.visible, false);
    assert.equal(list._rows.length, 1);
    assert.ok(list.events_box.children.length >= 1);
    idleCallbacks.pop()();

    const beforeRows = list._rows.slice();
    list.set_events(dataList, false);
    assert.equal(list._rows[0], beforeRows[0], "same timestamp refreshes row variations");

    let timeRefreshes = 0;
    list._rows[0].update_variations = () => timeRefreshes++;
    list.refresh_time_state();
    assert.equal(timeRefreshes, 1, "clock ticks repaint rows through a no-fetch seam");

    // destroying the list tears down every source the renderer armed: the class
    // that arms a timer is the class that removes it
    list._renderer._no_events_timeout_id = 31;
    list._renderer._scroll_to_idle_id = 32;
    list._renderer._build_rows_idle_id = 33;
    const renderedActors = list.events_box.get_children();
    list.destroy();
    assert.ok(removed.includes(31));
    assert.ok(removed.includes(32));
    assert.ok(removed.includes(33));
    assert.deepEqual(list._rows, [], "the retained applet keeps no row models");
    assert.equal(list._eventDataList, null,
        "the selected day's source model is released too");
    assert.equal(list._renderer._eventDataList, null,
        "the renderer releases the effective agenda used for ordering");
    assert.ok(renderedActors.every((actor) => actor.destroyed),
        "rendered row and separator actors are disposed");
});

test("agenda scrolling centers the row in the visible viewport", (t) => {
    const callbacks = [];
    const idleAdd = global.imports.mainloop.idle_add;
    global.imports.mainloop.idle_add = (callback) => callbacks.push(callback);
    t.after(() => { global.imports.mainloop.idle_add = idleAdd; });
    const list = new EventView.EventList(desktopSettings());
    list.events_box.height = 1000;
    const adjustment = list.events_scroll_box.get_vscroll_bar().get_adjustment();
    const row = { actor: { y: 400, height: 40 } };

    for (const [viewport, expected] of [[200, 320], [400, 220]]) {
        adjustment.page_size = viewport;
        list._renderer._queueScroll(row);
        assert.equal(callbacks.pop()(), global.imports.gi.GLib.SOURCE_REMOVE);
        assert.equal(adjustment.values.at(-1), expected);
        assert.equal(list._renderer._scroll_to_idle_id, 0);
    }
    list._renderer._queueScroll(null);
    callbacks.pop()();
    assert.equal(adjustment.values.at(-1), 0);
    list.destroy();
});

test("desktop clock-format changes repaint existing event rows", () => {
    const settings = desktopSettings(true);
    const list = new EventView.EventList(settings);
    const event = makeRowEvent({
        startUnix: 50 * DAY_S + 14 * 3600,
        endUnix: 50 * DAY_S + 15 * 3600
    });
    list.set_events({ timestamp: 91, get_event_list: () => [event] }, false);
    const row = list._rows[0];
    const actor = row.actor;
    const selections = [];
    const coordinator = new CoordinatorModule.AppletEventListCoordinator({
        manager: {
            is_active: () => true,
            disableIfOff: () => {},
            select_date: (...args) => selections.push(args)
        },
        eventList: () => list,
        selectedDate: () => TODAY,
        guard: (_source, callback) => callback()
    });

    coordinator.apply(true);
    assert.equal(row.event_time.text, "14:00  →  15:00");

    settings.use24h = false;
    coordinator.apply(true);

    assert.equal(row.event_time.text, "2:00 PM  →  3:00 PM");
    assert.equal(list._rows[0], row);
    assert.equal(row.actor, actor, "format changes repaint instead of rebuilding the list");
    assert.equal(selections.length, 1,
        "an unchanged show-events setting does not refetch the selected date");
});

// Every row in the column shows the same selected day, so the day is the
// column's value and not each row's. Identity is the assertion: two equal
// GLib.DateTimes would render the same and still be the per-row construction
// this exists to remove.
test("the selected day is derived once per refresh and shared by every row", () => {
    const list = new EventView.EventList(desktopSettings(true));
    const events = [11, 13, 15].map((hour) => makeRowEvent({
        id: `ev-${hour}`,
        startUnix: 50 * DAY_S + hour * 3600,
        endUnix: 50 * DAY_S + (hour + 1) * 3600
    }));
    list.set_events({ timestamp: 92, get_event_list: () => events }, false);
    assert.equal(list._rows.length, 3, "three rows to share the value");

    const seen = [];
    for (const row of list._rows) {
        const real = row.update_variations.bind(row);
        row.update_variations = (now, today, selectedDay) => {
            seen.push({ now, today, selectedDay });
            real(now, today, selectedDay);
        };
    }

    list.refresh_time_state();
    assert.equal(seen.length, 3);
    for (const pass of seen) {
        assert.ok(pass.selectedDay, "the day is passed in, not left to the row's default");
        assert.equal(pass.selectedDay, seen[0].selectedDay, "one day object for the column");
        assert.equal(pass.now, seen[0].now);
        assert.equal(pass.today, seen[0].today);
    }
    assert.equal(seen[0].selectedDay.to_unix(),
        rootModules.eventData.date_only(list.selected_date).to_unix(),
        "and it is the selected day, not some other date");

    // a format change takes the same shared values rather than each row's
    // defaults, and skips the walk entirely when no row is stale
    seen.length = 0;
    list.desktop_settings.use24h = false;
    list.refresh_time_format();
    assert.equal(seen.length, 3, "every row is repainted for a real format change");
    assert.equal(seen[2].selectedDay, seen[0].selectedDay);

    seen.length = 0;
    list.refresh_time_format();
    assert.equal(seen.length, 0, "an unchanged format repaints nothing");

    // Browsing away from today is what separates the selected day from today:
    // an event that starts on the selected day renders as a plain time range,
    // and the same event judged against today does not.
    const browsed = new EventView.EventList(desktopSettings(true));
    selectDate(browsed, new FakeDateTime(52 * DAY_US));
    browsed.set_events({
        timestamp: 93,
        get_event_list: () => [makeRowEvent({
            startUnix: 52 * DAY_S + 14 * 3600,
            endUnix: 52 * DAY_S + 15 * 3600
        })]
    }, false);
    browsed.refresh_time_state();
    assert.equal(browsed._rows[0].event_time.text, "14:00  →  15:00",
        "the range is read against the selected day, not against today");
});

test("same-tick list mutations rebuild all event rows", () => {
    // This suite's monotonic clock is deliberately frozen at 1. The renderer
    // and data list must still agree that adding a second event is a new
    // structural state, rather than taking the equal-revision refresh path.
    const dataList = new EventDataList(TODAY);
    dataList.add_or_update(makeRowEvent({
        id: "first",
        startUnix: 50 * DAY_S + 14 * 3600,
        endUnix: 50 * DAY_S + 15 * 3600
    }), 1);

    const list = new EventView.EventList(desktopSettings());
    list.set_events(dataList, false);
    const firstRevision = dataList.timestamp;
    assert.equal(list._rows.length, 1);

    dataList.add_or_update(makeRowEvent({
        id: "second",
        startUnix: 50 * DAY_S + 16 * 3600,
        endUnix: 50 * DAY_S + 17 * 3600
    }), 2);
    assert.ok(dataList.timestamp > firstRevision);

    list.set_events(dataList, false);
    assert.deepEqual(list._rows.map((row) => row.event.id), ["first", "second"]);
});

function agendaAcrossMeetingEnd() {
    const data = new EventDataList(TODAY);
    for (const spec of [
        { id: "all-day", allDay: true, startUnix: 50 * DAY_S, endUnix: 51 * DAY_S },
        { id: "meeting", startUnix: 50 * DAY_S + 11 * 3600, endUnix: 50 * DAY_S + 12 * 3600 + 30 },
        { id: "next", startUnix: 50 * DAY_S + 15 * 3600, endUnix: 50 * DAY_S + 16 * 3600 }
    ]) {
        data.add_or_update(makeRowEvent(spec), 1);
    }
    return EventView.composeSelectedDayAgenda(data, { name: "Observance", flags: [] });
}

test("minute ticks and reopening reorder all-day rows without replacing actors", (t) => {
    let now = NOW;
    t.mock.method(global.imports.gi.GLib.DateTime, "new_now_local", () => now);
    const agenda = agendaAcrossMeetingEnd();
    const list = new EventView.EventList(desktopSettings());
    t.after(() => list.destroy());
    selectDate(list, TODAY);
    list.set_events(agenda, false);
    const rows = list.rows.slice();
    const children = list.events_box.get_children();
    assert.deepEqual(rows.map((row) => row.event.id), [null, "all-day", "meeting", "next"]);
    const reorder = t.mock.method(list.events_box, "set_child_at_index");
    const coordinator = new CoordinatorModule.AppletEventListCoordinator({
        manager: { select_date() {} },
        eventList: () => list,
        selectedDate: () => TODAY
    });

    now = NOW.add_seconds(60);
    coordinator.tick();

    assert.deepEqual(list.rows, [rows[0], rows[2], rows[1], rows[3]]);
    assert.deepEqual(list.events_box.get_children(), [
        rows[0].actor, children[1], rows[2].actor, children[3],
        rows[1].actor, children[5], rows[3].actor
    ], "row actors move while separators keep alternating");
    const moves = reorder.mock.callCount();
    coordinator.tick();
    assert.equal(reorder.mock.callCount(), moves, "unchanged ordering touches no actors");

    now = NOW.add_hours(5);
    list.set_events(agenda, false);
    assert.deepEqual(list.rows, [rows[0], rows[2], rows[3], rows[1]],
        "the unchanged model is reordered when the menu is reopened");
    assert.ok(rows.every((row) => !row.actor.destroyed));
});

function orderedAgendaWithTimedRows(count) {
    const data = new EventDataList(TODAY);
    data.add_or_update(makeRowEvent({
        id: "all-day", allDay: true, startUnix: 50 * DAY_S, endUnix: 51 * DAY_S
    }), 1);
    for (let index = 0; index < count; index++) {
        data.add_or_update(makeRowEvent({
            id: `timed-${index}`,
            startUnix: 50 * DAY_S + 11 * 3600,
            endUnix: 50 * DAY_S + 12 * 3600 + 30
        }), 1);
    }
    return data;
}

function captureRowIdles(t) {
    const pending = new Map();
    let sequence = 0;
    t.mock.method(global.imports.mainloop, "idle_add", (callback) => {
        pending.set(++sequence, callback);
        return sequence;
    });
    t.mock.method(global.imports.mainloop, "source_remove", (id) => pending.delete(id));
    return pending;
}

function finishRowBuild(list, pending) {
    for (let turn = 0; turn < 20 && list._renderer._build_rows_idle_id > 0; turn++) {
        const id = list._renderer._build_rows_idle_id;
        const callback = pending.get(id);
        pending.delete(id);
        callback();
    }
    assert.equal(list._renderer._build_rows_idle_id, 0, "the bounded row build settles");
}

function focusFixture(t) {
    const list = new EventView.EventList(desktopSettings(), { isAvailable: () => true });
    selectDate(list, TODAY);
    const menu = new MockActor();
    menu.add_actor(list.actor);
    const footer = new MockActor();
    menu.add_actor(footer);
    const previousStage = global.stage;
    const stage = {
        focus: null, menuOpen: true, history: [],
        get_key_focus() { return this.focus; },
        set_key_focus(actor) {
            const previous = this.focus;
            this.focus = actor;
            previous?.fire("key-focus-out");
            this.history.push(actor);
            if (!menu.contains(actor)) {
                this.menuOpen = false;
            }
        }
    };
    global.stage = stage;
    t.after(() => { list.destroy(); global.stage = previousStage; });
    return { list, stage, footer };
}

function focusAgenda(ids, timestamp) {
    const events = ids.map(id => makeRowEvent({
        id, startUnix: 50 * DAY_S + 14 * 3600, endUnix: 50 * DAY_S + 15 * 3600
    }));
    return { timestamp, length: events.length, get_event_list: () => events };
}

test("T1161 event arrivals preserve focus and popup from empty and loading states", (t) => {
    const { list, stage } = focusFixture(t);
    for (const delay of [false, true]) {
        list.set_events(null, delay);
        list.no_events_button.grab_key_focus();
        list.set_events(focusAgenda(["arrived"], delay ? 2 : 1), false);
        assert.equal(stage.menuOpen, true);
        assert.equal(stage.focus, list.rows[0].actor);
        assert.equal(list.no_events_box.visible, false);
        assert.equal(list._renderer._scroll_to_idle_id, 0);
    }
});

test("T1161 holiday-only arrivals leave focus on the date heading", (t) => {
    const { list, stage } = focusFixture(t);
    list.set_events(null, false);
    list.no_events_button.grab_key_focus();
    list.set_events(EventView.composeSelectedDayAgenda(null,
        { name: "Holiday", flags: ["public_holiday"] }), false);
    assert.equal(stage.menuOpen, true);
    assert.equal(stage.focus, list.selected_date_label);
    assert.equal(list.rows.length, 1);
});

test("T1161 repeated empty updates and external focus are left alone", (t) => {
    const { list, stage, footer } = focusFixture(t);
    list.set_events(null, true);
    list.no_events_button.grab_key_focus();
    list.set_events(null, false);
    assert.equal(stage.focus, list.no_events_button);
    footer.grab_key_focus();
    list.set_events(focusAgenda(["arrived"], 1), false);
    assert.equal(stage.focus, footer);
    assert.equal(stage.menuOpen, true);
});

test("T1161 chunked arrivals retain focus through replacement and respect user departure", (t) => {
    const pending = captureRowIdles(t);
    const { list, stage, footer } = focusFixture(t);
    const ids = Array.from({ length: 65 }, (_unused, index) => `meeting-${index}`);
    list.set_events(null, true);
    list.no_events_button.grab_key_focus();
    list.set_events(focusAgenda(ids, 1), false);
    assert.equal(stage.focus, list.selected_date_label);
    const abandoned = pending.get(list._renderer._build_rows_idle_id);
    list.set_events(focusAgenda(["new", ...ids], 2), false);
    abandoned();
    finishRowBuild(list, pending);
    assert.equal(stage.focus, list.rows[0].actor);
    assert.equal(stage.menuOpen, true);
    assert.equal(list._renderer._scroll_to_idle_id, 0);
    list.set_events(null, true);
    list.no_events_button.grab_key_focus();
    list.set_events(focusAgenda(ids, 3), false);
    footer.grab_key_focus();
    list.selected_date_label.grab_key_focus();
    finishRowBuild(list, pending);
    assert.equal(stage.focus, list.selected_date_label);
    assert.equal(stage.menuOpen, true);
});

test("structural updates park focus before destruction and restore the surviving event", (t) => {
    const { list, stage } = focusFixture(t);
    list.set_events(focusAgenda(["a", "b", "c"], 1), false);
    const old = list.rows[1];
    old.event_time.grab_key_focus();
    const updated = focusAgenda(["new", "a", "b", "c"], 2);
    updated.get_event_list()[2].summary = "Revised meeting";
    list.set_events(updated, false);
    assert.equal(stage.menuOpen, true, "focus must never transiently escape the menu");
    assert.equal(stage.focus, list.rows[2].actor);
    assert.equal(list.rows[2].event.summary, "Revised meeting");
    assert.equal(old.actor.destroyed, true);
    assert.equal(list._renderer._scroll_to_idle_id, 0, "auto-scroll must not override the focused row");
    list.set_events(focusAgenda(["b", "c"], 3), false);
    assert.equal(stage.focus, list.rows[0].actor);
    assert.equal(stage.menuOpen, true);
});

test("removing the focused event chooses next, then previous, then the date heading", (t) => {
    const { list, stage } = focusFixture(t);
    list.set_events(focusAgenda(["a", "b", "c"], 1), false);
    list.rows[1].actor.grab_key_focus();
    list.set_events(focusAgenda(["a", "c"], 2), false);
    assert.equal(stage.focus, list.rows[1].actor);
    list.set_events(focusAgenda(["a"], 3), false);
    assert.equal(stage.focus, list.rows[0].actor);
    list.set_events(EventView.composeSelectedDayAgenda(null,
        { name: "Holiday", flags: ["public_holiday"] }), false);
    assert.equal(stage.focus, list.selected_date_label, "information rows are not focus targets");
    list.set_events(focusAgenda(["a"], 4), false);
    list.rows[0].actor.grab_key_focus();
    list.set_events(null, false);
    assert.equal(stage.focus, list.selected_date_label);
    assert.equal(stage.menuOpen, true);
});

test("chunked replacement preserves its bookmark and rejects a cancelled build callback", (t) => {
    const pending = captureRowIdles(t);
    const { list, stage } = focusFixture(t);
    const ids = Array.from({ length: 65 }, (_unused, index) => `meeting-${index}`);
    list.set_events(focusAgenda(ids, 1), false);
    finishRowBuild(list, pending);
    list.rows[60].actor.grab_key_focus();
    list.set_events(focusAgenda(ids, 2), false);
    assert.equal(stage.focus, list.selected_date_label);
    const abandoned = pending.get(list._renderer._build_rows_idle_id);
    list.set_events(focusAgenda(["new", ...ids], 3), false);
    const replacementId = list._renderer._build_rows_idle_id;
    abandoned();
    assert.equal(list._renderer._build_rows_idle_id, replacementId);
    assert.equal(list.rows.length, 20);
    finishRowBuild(list, pending);
    assert.equal(stage.focus, list.rows[61].actor);
    assert.equal(list.rows[61].event.id, "meeting-60");
    assert.equal(stage.menuOpen, true);
    assert.equal(list._renderer._scroll_to_idle_id, 0);
});

test("user movement and day changes cancel pending focus restoration", (t) => {
    const pending = captureRowIdles(t);
    const { list, stage, footer } = focusFixture(t);
    const ids = Array.from({ length: 45 }, (_unused, index) => `meeting-${index}`);
    list.set_events(focusAgenda(ids, 1), false);
    finishRowBuild(list, pending);
    list.rows[40].actor.grab_key_focus();
    list.set_events(focusAgenda(ids, 2), false);
    footer.grab_key_focus();
    list.selected_date_label.grab_key_focus();
    finishRowBuild(list, pending);
    assert.equal(stage.focus, list.selected_date_label, "returning to the heading is an explicit choice");
    assert.equal(list._renderer._scroll_to_idle_id, 0);

    list.rows[40].actor.grab_key_focus();
    list.set_events(focusAgenda(ids, 3), false);
    selectDate(list, TODAY.add_days(1));
    list.set_events(focusAgenda(ids, 4), false);
    finishRowBuild(list, pending);
    assert.equal(stage.focus, list.selected_date_label, "a new day cannot inherit the old row bookmark");

    footer.grab_key_focus();
    list.set_events(focusAgenda(["single"], 5), false);
    assert.equal(stage.focus, footer, "background updates do not acquire focus");
    assert.equal(stage.menuOpen, true);
});

test("date-before-events signals retain old row focus identity across a day change", (t) => {
    const { list, stage } = focusFixture(t);
    list.set_events(focusAgenda(["old"], 1), false);
    list.rows[0].actor.grab_key_focus();
    selectDate(list, TODAY.add_days(1));
    assert.equal(stage.focus, list.selected_date_label,
        "focus parks before the selected day can be assigned to old rows");
    list.set_events(focusAgenda(["unrelated"], 2), false);
    assert.equal(stage.focus, list.selected_date_label,
        "the next day must not inherit an unrelated event focus");
    assert.equal(stage.menuOpen, true);

    list.rows[0].actor.grab_key_focus();
    const civil = { ...list.selectedCivilDate };
    list.set_date(civil, list.selectedDate.add_seconds(3600));
    list.set_events(focusAgenda(["unrelated"], 3), false);
    assert.equal(stage.focus, list.rows[0].actor,
        "a timezone re-projection of the same civil date retains focus");
});

test("an omitted date disables and restores both calendar launch controls", (t) => {
    const launched = [];
    const list = new EventView.EventList(desktopSettings(), {
        isAvailable: () => true, launchDate: date => launched.push(date)
    });
    t.after(() => list.destroy());
    const civil = { year: 2011, month: 12, day: 30 };
    const projection = new FakeDateTime(10 * DAY_US);
    list.set_date(civil, projection);
    list.set_events(null, false);
    list.set_date(civil, null);
    list.set_unavailable(false);
    for (const actor of [list.selected_date_label, list.no_events_button]) {
        assert.equal(actor.can_focus, false);
        assert.equal(actor.reactive, false);
    }
    assert.equal(list.no_events_button.style_class, "");
    assert.equal(list.no_events_button.accessible_name, list.no_events_label.text);
    list.launch_calendar(null);
    assert.deepEqual(launched, []);
    list.set_events(EventView.composeSelectedDayAgenda(null,
        { name: "Retained civil holiday", flags: [] }), false);
    list.refresh_time_state();
    assert.equal(list.rows[0].event.summary, "Retained civil holiday");
    list.set_unavailable(true);
    list.set_unavailable(false);
    assert.equal(list.no_events_button.can_focus, false,
        "service transitions cannot restore a missing projection");
    list.set_date(civil, projection);
    for (const actor of [list.selected_date_label, list.no_events_button]) {
        assert.equal(actor.can_focus, true);
        assert.equal(actor.reactive, true);
    }
    assert.match(list.no_events_button.accessible_name, /Add an event/);
    list.launch_calendar(projection);
    assert.equal(launched.length, 1);
});

test("a row outside the rendered prefix falls back within it and teardown cancels handover", (t) => {
    const pending = captureRowIdles(t);
    const { list, stage } = focusFixture(t);
    const ids = Array.from({ length: 200 }, (_unused, index) => `meeting-${index}`);
    list.set_events(focusAgenda(ids, 1), false);
    finishRowBuild(list, pending);
    list.rows[199].actor.grab_key_focus();
    list.set_events(focusAgenda(["new", ...ids], 2), false);
    finishRowBuild(list, pending);
    assert.equal(stage.focus, list.rows[199].actor);
    assert.equal(list.rows[199].event.id, "meeting-198");
    list.set_events(focusAgenda(ids, 3), false);
    const abandoned = pending.get(list._renderer._build_rows_idle_id);
    list.destroy();
    const historyLength = stage.history.length;
    abandoned();
    assert.equal(stage.history.length, historyLength, "a destroyed renderer cannot restore focus");
    assert.equal(list.rows.length, 0);
    assert.equal(list._rowFocus, null);
});

test("an event boundary crossed during row chunking is reconciled when the build settles", (t) => {
    let now = NOW;
    t.mock.method(global.imports.gi.GLib.DateTime, "new_now_local", () => now);
    const pending = captureRowIdles(t);
    const list = new EventView.EventList(desktopSettings());
    t.after(() => list.destroy());
    selectDate(list, TODAY);
    list.set_events(orderedAgendaWithTimedRows(40), false);
    const allDayRow = list.rows[0];
    assert.ok(list._renderer._build_rows_idle_id > 0);

    now = NOW.add_seconds(60);
    list.refresh_time_state();
    finishRowBuild(list, pending);

    assert.equal(list.rows.length, 41);
    assert.equal(list.rows.at(-1), allDayRow);
    assert.equal(list.events_box.get_children().at(-1), allDayRow.actor);
    assert.ok(!allDayRow.actor.destroyed);
});

test("time-based ordering replaces a changed visible prefix through the bounded row builder", (t) => {
    let now = NOW;
    t.mock.method(global.imports.gi.GLib.DateTime, "new_now_local", () => now);
    const pending = captureRowIdles(t);
    const list = new EventView.EventList(desktopSettings());
    t.after(() => list.destroy());
    selectDate(list, TODAY);
    list.set_events(orderedAgendaWithTimedRows(EventView.MAX_RENDERED_EVENT_ROWS), false);
    finishRowBuild(list, pending);
    const previousRows = list.rows.slice();
    const oldScroll = list._renderer._scroll_to_idle_id;
    assert.equal(previousRows[0].event.id, "all-day");
    assert.equal(previousRows.at(-1).event.id, "timed-198");

    now = NOW.add_seconds(60);
    list.refresh_time_state();

    assert.equal(pending.has(oldScroll), false, "a queued scroll cannot retain a discarded row");
    assert.ok(list.rows.length < EventView.MAX_RENDERED_EVENT_ROWS,
        "replacement rows still yield between bounded chunks");
    finishRowBuild(list, pending);
    assert.equal(list.rows.length, EventView.MAX_RENDERED_EVENT_ROWS);
    assert.equal(list.rows[0].event.id, "timed-0");
    assert.equal(list.rows.at(-1).event.id, "timed-199");
    assert.equal(list.events_overflow_label.visible, true);
    assert.ok(previousRows.every((row) => row.actor.destroyed));
});

// A row is ~6 actors plus a separator, and the count is whatever the user's
// CalDAV or ICS feed puts on the day. A 200-event day built ~1,400 actors in one
// main-loop turn, on the thread that draws every window on the desktop.
test("a huge day is built across turns, not in one burst", () => {
    const idles = [];
    const originalIdle = global.imports.mainloop.idle_add;
    global.imports.mainloop.idle_add = (cb) => {
        idles.push(cb);
        return idles.length;
    };

    const list = new EventView.EventList(desktopSettings());
    const events = Array.from({ length: 55 }, (_unused, index) => makeRowEvent({
        startUnix: 50 * DAY_S + index * 60,
        endUnix: 50 * DAY_S + index * 60 + 30
    }));

    list.set_events({ timestamp: 7, get_event_list: () => events }, false);

    const built = () => list._rows.length;
    assert.ok(built() > 0, "the column is never empty while there is something to show");
    assert.ok(built() < events.length, "and the rest is not built in the same turn");

    // drain the idles the build queued
    for (let i = 0; i < idles.length && built() < events.length; i++) {
        idles[i]();
    }
    global.imports.mainloop.idle_add = originalIdle;

    assert.equal(built(), events.length, "every event is on screen when it settles");
    assert.equal(list._renderer._build_rows_idle_id, 0, "and nothing is left armed");
});

test("an oversized day renders a bounded prefix and explains the omission", () => {
    const idles = [];
    const originalIdle = global.imports.mainloop.idle_add;
    global.imports.mainloop.idle_add = (cb) => {
        idles.push(cb);
        return idles.length;
    };

    const list = new EventView.EventList(desktopSettings());
    const limit = EventView.MAX_RENDERED_EVENT_ROWS;
    const events = Array.from({ length: limit + 25 }, (_unused, index) =>
        makeRowEvent({
            id: `visible-${index}`,
            startUnix: 50 * DAY_S + index * 60,
            endUnix: 50 * DAY_S + index * 60 + 30
        }));

    list.set_events({
        timestamp: 700,
        length: events.length,
        get_event_list: () => events
    }, false);
    for (let index = 0; index < idles.length && list._rows.length < limit; index++) {
        idles[index]();
    }
    global.imports.mainloop.idle_add = originalIdle;

    assert.equal(limit, 200, "the actor ceiling is a pinned product limit");
    assert.equal(list._rows.length, limit);
    assert.equal(list.events_overflow_label.visible, true);
    assert.match(list.events_overflow_label.text, /events were hidden/);
    assert.equal(
        list.events_overflow_label.get_clutter_text().ellipsize,
        global.imports.gi.Pango.EllipsizeMode.NONE);

    list.set_events({
        timestamp: 701,
        length: 1,
        get_event_list: () => events.slice(0, 1)
    }, false);
    assert.equal(list.events_overflow_label.visible, false,
        "a later bounded result clears the warning");
});

test("an ingest overflow is visible even when the selected day is empty", () => {
    const list = new EventView.EventList(desktopSettings());
    list.set_events(null, false, true);

    assert.equal(list.events_overflow_label.visible, true);
    assert.equal(list.no_events_box.visible, true);
});

test("event failures share the footer and disabled events clear their issues", () => {
    const issues = new Map();
    const list = new EventView.EventList(
        desktopSettings(), undefined,
        (source, message) => issues.set(source, message));

    list.setOverflowed(true);
    list.set_refresh_failed(true);
    assert.match(issues.get("events-overflow"), /events were hidden/);
    assert.match(issues.get("events-refresh"), /could not be refreshed/);

    list.set_unavailable(true);
    assert.match(issues.get("calendar-service"), /no calendar service/);
    assert.equal(issues.get("events-overflow"), "",
        "service loss clears the stale rendered-data warning");

    list.set_reporting_enabled(false);
    assert.deepEqual([...issues.values()], ["", "", ""],
        "a feature the user switched off reports no issue");

    list.set_reporting_enabled(true);
    list.setOverflowed(false);
    list.set_refresh_failed(false);
    list.set_unavailable(false);
    assert.deepEqual([...issues.values()], ["", "", ""],
        "bounded data, a successful fetch and a live service clear every source");
});

test("a day that changes mid-build abandons the build", () => {
    const idles = [];
    const removed = [];
    const originalIdle = global.imports.mainloop.idle_add;
    const originalRemove = global.imports.mainloop.source_remove;
    global.imports.mainloop.idle_add = (cb) => {
        idles.push(cb);
        return idles.length;
    };
    global.imports.mainloop.source_remove = (id) => removed.push(id);

    const list = new EventView.EventList(desktopSettings());
    const events = Array.from({ length: 55 }, (_unused, index) => makeRowEvent({
        startUnix: 50 * DAY_S + index * 60,
        endUnix: 50 * DAY_S + index * 60 + 30
    }));

    list.set_events({ timestamp: 7, get_event_list: () => events }, false);
    const afterFirstChunk = list._rows.length;

    // the user picks another day: the chunks still queued belong to the old one
    list._current_event_data_list_timestamp = 9;
    idles.forEach((cb) => cb());

    assert.equal(list._rows.length, afterFirstChunk,
        "the abandoned build must not interleave two days' rows");
    assert.equal(list._renderer._build_rows_idle_id, 0);

    // and a fresh build cancels whatever was still armed
    list._renderer._build_rows_idle_id = 42;
    list.set_events(null, false);
    assert.ok(removed.includes(42));

    global.imports.mainloop.idle_add = originalIdle;
    global.imports.mainloop.source_remove = originalRemove;
});

test("EventList set_events builds separators for multiple rows", () => {
    const list = new EventView.EventList(desktopSettings());
    const first = makeRowEvent({
        startUnix: 50 * DAY_S + 14 * 3600,
        endUnix: 50 * DAY_S + 15 * 3600
    });
    const second = makeRowEvent({
        startUnix: 51 * DAY_S + 9 * 3600,
        endUnix: 51 * DAY_S + 10 * 3600
    });
    list.set_events({
        timestamp: 123,
        get_event_list: () => [first, second]
    }, false);
    assert.equal(list._rows.length, 2);
    assert.equal(list.events_box.children.length, 3, "row, separator, row");
});

test("EventList bridges row view-event signals to calendar launch by uuid", () => {
    const originalConnect = EventView.EventRow.prototype.connect;
    let viewCallback = null;
    EventView.EventRow.prototype.connect = function(name, cb) {
        if (name === "view-event") {
            viewCallback = cb;
        }
        return 1;
    };
    const spawned = [];
    global.imports.misc.util.trySpawn = (args) => spawned.push(args);
    global.imports.gi.GLib.find_program_in_path = () => "/usr/bin/gnome-calendar";
    const list = new EventView.EventList(desktopSettings());
    const event = makeRowEvent({
        startUnix: 51 * DAY_S + 9 * 3600,
        endUnix: 51 * DAY_S + 10 * 3600
    });
    list.set_events({ timestamp: 777, get_event_list: () => [event] }, false);
    viewCallback(null, "uuid-1");
    EventView.EventRow.prototype.connect = originalConnect;
    global.imports.gi.GLib.find_program_in_path = () => null;

    assert.equal(list._emitted.at(-1).name, "launched-calendar");
    assert.deepEqual(spawned.at(-1), ["gnome-calendar", "--uuid=uuid-1"]);
});

// T73 regression: refreshing a row through its phases must replace the
// countdown pseudo-class, never stack them
test("countdown pseudo-classes never accumulate across refreshes", () => {
    const event = makeRowEvent({
        startUnix: 50 * DAY_S + 13 * 3600,
        endUnix: 50 * DAY_S + 14 * 3600
    });
    const row = new EventView.EventRow(event, TODAY, rowParams());
    const at = (h, m) => new FakeDateTime(50 * DAY_US + (h * 3600 + m * 60) * 1000000);

    row.update_variations(at(10, 0), TODAY); // 3 h away: text, no class
    assert.deepEqual([...row.countdown_label.pseudo_classes], []);

    row.update_variations(at(12, 15), TODAY); // 45 min away
    assert.deepEqual([...row.countdown_label.pseudo_classes], ["soon"]);

    row.update_variations(at(12, 56), TODAY); // 4 min away
    assert.deepEqual([...row.countdown_label.pseudo_classes], ["imminent"],
        "soon must not linger under imminent");

    row.update_variations(at(13, 30), TODAY); // in progress
    assert.deepEqual([...row.countdown_label.pseudo_classes], ["current"]);

    row.update_variations(at(14, 30), TODAY); // past
    assert.deepEqual([...row.countdown_label.pseudo_classes], ["ended"],
        "past replaces the countdown class with its non-colour cue");
    assert.equal(row.countdown_label.text, "Ended");
});

// refresh_time_state() runs every row on every tick while the menu is open, and
// St compares by pointer — an identical string still queues a relayout. Count
// the writes, because a redundant one produces exactly the state the skipped
// one would have and is invisible to a value assertion.
test("an unchanged event row writes nothing back to its actors on a refresh", () => {
    const event = makeRowEvent({
        startUnix: 50 * DAY_S + 13 * 3600,
        endUnix: 50 * DAY_S + 14 * 3600
    });
    const row = new EventView.EventRow(event, TODAY, rowParams());
    const at = (h, m) => new FakeDateTime(50 * DAY_US + (h * 3600 + m * 60) * 1000000);

    // render the row once, then watch what a repeat of that same pass costs
    row.update_variations(at(12, 15), TODAY);

    let writes = 0;
    for (const actor of [row.event_time, row.countdown_label]) {
        const setText = actor.set_text.bind(actor);
        const setStyle = actor.set_style_class_name.bind(actor);
        const setPseudo = actor.set_style_pseudo_class.bind(actor);
        actor.set_text = (text) => { writes++; setText(text); };
        actor.set_style_class_name = (name) => { writes++; setStyle(name); };
        actor.set_style_pseudo_class = (name) => { writes++; setPseudo(name); };
    }

    row.update_variations(at(12, 15), TODAY);
    assert.equal(writes, 0, "an identical refresh writes nothing back");

    // a minute later, still 'soon': only the countdown text has moved
    row.update_variations(at(12, 16), TODAY);
    assert.equal(writes, 1, "only the value that changed is written");
    assert.equal(row.countdown_label.text, "Starting in 44 minutes");

    // ...and a phase change still gets the style and the countdown through
    row.update_variations(at(13, 30), TODAY);
    assert.equal(row.countdown_label.text, "In progress");
    assert.deepEqual([...row.countdown_label.pseudo_classes], ["current"]);
    assert.equal(row.event_time.style_class, "calendar-event-time-present");

    // An all-day row is the only kind that writes a pseudo-class onto the time
    // label, and it writes the same one on every pass — so it is the only place
    // that guard can be observed at all.
    const allDay = new EventView.EventRow(makeRowEvent({
        startUnix: 50 * DAY_S, endUnix: 51 * DAY_S, allDay: true
    }), TODAY, rowParams());
    allDay.update_variations(at(12, 15), TODAY);
    let pseudoWrites = 0;
    const setPseudo = allDay.event_time.set_style_pseudo_class.bind(allDay.event_time);
    allDay.event_time.set_style_pseudo_class = (name) => {
        pseudoWrites++;
        setPseudo(name);
    };
    allDay.update_variations(at(13, 30), TODAY);
    assert.equal(pseudoWrites, 0, "'all-day' is already on the label");
    assert.ok(allDay.event_time.pseudo_classes.has("all-day"), "and it stays there");
});

test("EventRow activation covers mouse, keyboard, and current all-day branches", () => {
    global.imports.gi.GLib.find_program_in_path = () => "/usr/bin/gnome-calendar";
    const event = makeRowEvent({
        startUnix: 50 * DAY_S + 14 * 3600,
        endUnix: 50 * DAY_S + 15 * 3600
    });
    const row = new EventView.EventRow(event, TODAY, rowParams({ use_24h: false }));
    global.imports.gi.GLib.find_program_in_path = () => null;

    const emitted = [];
    row.emit = (name, id) => emitted.push([name, id]);
    row.actor.fire("button-press-event", { get_button: () => 1 });
    row.actor.fire("key-press-event", { get_key_symbol: () => 65421 });
    assert.deepEqual(emitted, [["view-event", "id1"], ["view-event", "id1"]]);

    const allDay = makeRowEvent({
        startUnix: 50 * DAY_S,
        endUnix: 51 * DAY_S,
        allDay: true
    });
    const allDayRow = new EventView.EventRow(allDay, TODAY, rowParams());
    allDayRow.update_variations(NOW, TODAY);
    assert.equal(allDayRow.countdown_label.text, "");
    assert.ok(allDayRow.event_time.pseudo_classes.has("all-day"));
});

// set_unavailable() rewrote the button's label and its accessible name and left
// it focusable, hoverable, themed as a button and still wired to
// launch_calendar(). So in the "no calendar service" state it announced only the
// error sentence — and pressing Enter on it launched gnome-calendar. A control's
// name has to say what activating it does; this one is not a control at all here.
test("the empty-state button stops being a button when there is nothing to launch", () => {
    global.imports.gi.GLib.find_program_in_path = () => "/usr/bin/gnome-calendar";
    const list = new EventView.EventList(desktopSettings());
    selectDate(list, new FakeDateTime(10 * DAY_US));
    const heading = list.selected_date_label.text;

    assert.equal(list.no_events_button.options.can_focus, true);
    assert.equal(list.no_events_button.options.reactive, true);
    assert.equal(list.selected_date_label.can_focus, true);
    assert.match(list.selected_date_label.accessible_name, /Open the calendar app/);

    list.set_unavailable(true);

    assert.equal(list.no_events_button.can_focus, false,
        "it does not take focus in a state where activating it does nothing");
    assert.equal(list.no_events_button.reactive, false);
    assert.equal(list.no_events_button.style_class, "",
        "and it does not look like a button either");
    assert.match(list.no_events_label.text, /no calendar service is running/);
    assert.equal(list.selected_date_label.can_focus, false,
        "the date heading does not keep a dead keyboard stop");
    assert.equal(list.selected_date_label.reactive, false);
    assert.equal(list.selected_date_label.accessible_role, global.imports.gi.Atk.Role.LABEL);
    assert.equal(list.selected_date_label.accessible_name, heading);
    assert.equal(TooltipDouble.forActor(list.selected_date_label).text, "");

    // ...and it launches nothing, whatever reaches it
    const launched = [];
    list.connect("launched-calendar", () => launched.push(true));
    list.launch_calendar(list.selected_date);
    assert.deepEqual(launched, [], "Enter on the error message must not open a calendar app");

    // the service comes back: so does the button
    list.set_unavailable(false);
    assert.equal(list.no_events_button.can_focus, true);
    assert.equal(list.no_events_button.style_class, "calendar-events-no-events-button");
    assert.equal(list.selected_date_label.can_focus, true);
    assert.equal(list.selected_date_label.accessible_role,
        global.imports.gi.Atk.Role.PUSH_BUTTON);
    assert.match(list.selected_date_label.accessible_name, /Open the calendar app/);
    assert.equal(TooltipDouble.forActor(list.selected_date_label).text,
        "Open the calendar app");
});

// the box declares itself a list and had no name, so a screen reader announced
// "list" with nothing to say what it is a list of
test("the events list says what it is a list of", () => {
    const list = new EventView.EventList(desktopSettings());

    const Atk = global.imports.gi.Atk;
    assert.equal(list.events_box.options.accessible_role, Atk.Role.LIST);
    assert.equal(list.events_box.accessible_name, "Events for the selected day");
});
