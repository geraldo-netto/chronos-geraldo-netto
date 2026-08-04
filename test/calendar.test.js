const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");
const { freezeClock } = require("./helpers/clock");

// The grid marks "today" and Home returns to it, both read off the wall clock, and
// the month window is built around it. A run that crosses local midnight moved the
// day underneath the assertions. Each test file runs in its own process, so this
// stands for the file: every explicit new Date(2026, …) is untouched.
freezeClock();

const APPLET_DIR = path.join(__dirname, "..", "files", "chronos@geraldo-netto");

global.log = () => {};
function makeFakeDateTimeFromDate(date) {
    return {
        get_year: () => date.getFullYear(),
        get_month: () => date.getMonth() + 1,
        get_day_of_month: () => date.getDate(),
        to_unix: () => Math.trunc(date.getTime() / 1000),
        format(fmt) {
            const months = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
            return fmt
                .replace("%OB", months[date.getMonth()])
                .replace("%Y", String(date.getFullYear()))
                .replace("%V", "01");
        }
    };
}

global.imports = {
    gi: {
        Clutter: { ActorAlign: { CENTER: 0 },
            // Clutter's own ordering, and all five values: UP, DOWN, LEFT, RIGHT,
            // SMOOTH. The double used to be {UP:0, LEFT:1, DOWN:2, RIGHT:3} — its
            // own invention — and it left out SMOOTH, which is what a touchpad
            // sends, so the one direction a real device emits most was the one
            // value no test could pass in.
            ScrollDirection: { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, SMOOTH: 4 },
            EVENT_STOP: true,
            EVENT_PROPAGATE: false,
            KEY_Left: 65361, KEY_Up: 65362, KEY_Right: 65363, KEY_Down: 65364,
            KEY_Page_Up: 65365, KEY_Page_Down: 65366, KEY_Home: 65360 },
        Gio: {
            Settings: class { connect() { return 1; } disconnect() {} },
            // Cinnamon always has these; the locale query needs them, and the
            // double that lacked them was the only thing the compat guards in
            // localeUtils ever ran for. The query is left in flight, which is
            // exactly the state the applet starts in.
            Cancellable: class { cancel() {} },
            SubprocessFlags: { STDOUT_PIPE: 1 },
            Subprocess: class {
                init() {}
                communicate_utf8_async() {}
            }
        },
        GLib: {
            SOURCE_REMOVE: false,
            PRIORITY_DEFAULT: 0,
            timeout_add_seconds: () => 1,
            get_home_dir: () => "/home/x",
            get_user_cache_dir: () => "/tmp/cache",
            build_filenamev: (parts) => parts.join("/"),
            DateTime: {
                new_from_unix_local: (unix) =>
                    makeFakeDateTimeFromDate(new Date(unix * 1000)),
                new_local: (year, month, day, hour = 0, minute = 0, second = 0) =>
                    makeFakeDateTimeFromDate(new Date(year, month - 1, day, hour, minute, second))
            }
        },
        St: { Align: { MIDDLE: 1 }, TextDirection: { LTR: 0, RTL: 1 },
            Button: class {}, Label: class {}, Bin: class {},
            BoxLayout: class {}, Widget: class {} },
        Pango: {},
        Cinnamon: { util_get_week_start: () => 0, Stack: class {}, GenericContainer: class {} },
        Soup: { MAJOR_VERSION: 3, Session: class {} },
        CinnamonDesktop: { WallClock: { lctime_format: (d, f) => f } }
    },
    lang: { bind: (self, fn, ...args) => fn.bind(self, ...args) },
    byteArray: {},
    signals: {
        addSignalMethods(proto) {
            proto.connect = function() { return 1; };
            proto.emit = function() {};
        }
    },
    mainloop: { timeout_add: () => 1, idle_add: () => 1, source_remove: () => {} },
    gettext: {
        bindtextdomain: () => {},
        dgettext: (domain, str) => str,
        domain: () => ({ gettext: (s) => s })
    },
    ui: {
        tooltips: { Tooltip: class {
            constructor() { this.texts = []; this.shown = false; }
            set_text(text) { this.texts.push(text); }
            show() { this.shown = true; }
            hide() { this.shown = false; }
        } },
        appletManager: { applets: { "chronos@geraldo-netto": {} } }
    }
};
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].dateFormats =
    require(path.join(APPLET_DIR, "dateFormats.js"));
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].localeQuery =
    require(path.join(APPLET_DIR, "localeQuery.js"));
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].localeText =
    require(path.join(APPLET_DIR, "localeText.js"));
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].styleUtils =
    require(path.join(APPLET_DIR, "styleUtils.js"));
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].eventData =
    require(path.join(APPLET_DIR, "eventData.js"));
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].settingsFacade =
    require(path.join(APPLET_DIR, "settingsFacade.js"));
// the grid reads the error identifiers and nothing else out of the holiday
// feature, so it requires the constants, not the barrel that carries the HTTP
// stack behind them
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].holidayConstants = {
    PUBLIC_HOLIDAY_FLAG: "public_holiday",
    RELIGIOUS_HOLIDAY_FLAG: "religious_holiday",
    HOLIDAY_ERRORS: {
        SERVICE_UNAVAILABLE: "Holiday service unavailable",
        INVALID_RESPONSE: "Holiday data unavailable"
    }
};

const CalendarModule = require(path.join(APPLET_DIR, "5.4", "calendar.js"));
const AnnotationsModule = require(path.join(APPLET_DIR, "5.4", "calendarAnnotations.js"));
const NavigationModule = require(path.join(APPLET_DIR, "5.4", "calendarNavigation.js"));
const CalendarDateModule = require(path.join(APPLET_DIR, "5.4", "calendarDate.js"));

test("calendar date identity has one null-safe definition", () => {
    const date = new Date(2026, 6, 9);

    assert.equal(CalendarDateModule.sameDay(date, new Date(date)), true);
    assert.equal(CalendarDateModule.sameDay(null, date), false);
    assert.equal(CalendarDateModule.sameDay(date, null), false);
    assert.equal(CalendarDateModule.sameDay(date, new Date(2026, 6, 10)), false);
    assert.equal(CalendarDateModule.sameDay(date, new Date(2026, 7, 9)), false);
    assert.equal(CalendarDateModule.sameDay(date, new Date(2027, 6, 9)), false);
    assert.equal(CalendarDateModule.isToday(date, new Date(date)), true);
    assert.equal(NavigationModule.sameDay, CalendarDateModule.sameDay);
});

test("calendar date formatting owns the GLib boundary", () => {
    const date = new Date(2026, 6, 9);
    assert.equal(CalendarDateModule.formatJsDate(date, "%Y"), "2026");

    const newLocal = global.imports.gi.GLib.DateTime.new_local;
    global.imports.gi.GLib.DateTime.new_local = () => null;
    assert.equal(CalendarDateModule.formatJsDate(date, "%Y"), "");
    global.imports.gi.GLib.DateTime.new_local = newLocal;
});

test("navigation controller owns no-op, cancellation, and focus boundaries", () => {
    const removed = [];
    global.imports.mainloop.source_remove = (id) => removed.push(id);
    let updates = 0;
    let emitted = 0;
    const selected = new Date(2026, 6, 9);
    const controller = new NavigationModule.CalendarNavigationController({
        actor: () => ({}),
        dayCells: () => [],
        eventsEnabled: () => true,
        emitSelected() { emitted++; },
        update: () => updates++,
        setDate() {},
        browse() {},
        queueDate() {}
    }, selected);

    assert.equal(controller.setDate(new Date(selected), false), false);
    assert.equal(updates, 0, "an unchanged date is a no-op");
    assert.equal(controller.setDate(new Date(selected), true), false);
    assert.equal(updates, 1, "a forced reload still updates");
    assert.equal(controller.setDate(new Date(2026, 6, 10), true), true);
    assert.equal(updates, 2);
    assert.equal(emitted, 1, "only a changed selection emits");

    controller.setDateIdleId = 7;
    controller.queuedDate = new Date(selected);
    controller.cancelQueuedDate();
    assert.deepEqual(removed, [7]);
    assert.equal(controller.queuedDate, null);
    assert.equal(controller.focusSelectedDay(), false);

    global.stage = null;
    assert.equal(controller.onKeyPress({ get_key_symbol: () => -1 }),
        global.imports.gi.Clutter.EVENT_PROPAGATE);
});

function browse(fromDate, yearChange, monthChange) {
    let queued = null;
    const stub = {
        _navigation: { queuedDate: null, selectedDate: fromDate },
        queue_set_date(date) {
            queued = date;
        }
    };
    CalendarModule.Calendar.prototype._applyDateBrowseAction.call(stub, yearChange, monthChange);
    return queued;
}

function dateInYear(year, month, day) {
    const date = new Date(0);
    date.setFullYear(year, month, day);
    return date;
}

// T09a: month/year browsing across year boundaries
test("next month from December rolls into January of the next year", () => {
    const result = browse(new Date(2025, 11, 15), 0, +1);
    assert.equal(result.getFullYear(), 2026);
    assert.equal(result.getMonth(), 0);
    assert.equal(result.getDate(), 15);
});

test("previous month from January rolls into December of the prior year", () => {
    const result = browse(new Date(2026, 0, 15), 0, -1);
    assert.equal(result.getFullYear(), 2025);
    assert.equal(result.getMonth(), 11);
    assert.equal(result.getDate(), 15);
});

test("year browsing keeps month and day", () => {
    const up = browse(new Date(2025, 5, 30), +1, 0);
    assert.equal(up.getFullYear(), 2026);
    assert.equal(up.getMonth(), 5);
    assert.equal(up.getDate(), 30);

    const down = browse(new Date(2025, 5, 30), -1, 0);
    assert.equal(down.getFullYear(), 2024);
});

// T09b: February day clamping, leap and non-leap
test("browsing into February clamps day 31 to 28 in a non-leap year", () => {
    const result = browse(new Date(2026, 0, 31), 0, +1);
    assert.equal(result.getMonth(), 1);
    assert.equal(result.getDate(), 28);
});

test("browsing into February keeps day 29 in a leap year", () => {
    const result = browse(new Date(2024, 2, 29), 0, -1);
    assert.equal(result.getMonth(), 1);
    assert.equal(result.getDate(), 29);
});

test("browsing into February clamps day 31 to 29 in a leap year", () => {
    const result = browse(new Date(2024, 0, 31), 0, +1);
    assert.equal(result.getMonth(), 1);
    assert.equal(result.getDate(), 29);
});

test("year change from Feb 29 clamps to Feb 28 in the non-leap target", () => {
    const result = browse(new Date(2024, 1, 29), +1, 0);
    assert.equal(result.getMonth(), 1);
    assert.equal(result.getDate(), 28);
});

test("calendar navigation stops at complete GLib month-window boundaries", () => {
    const earliest = dateInYear(1, 1, 15);
    const latest = dateInYear(9999, 10, 15);
    let heldBackward = new Date(2026, 6, 9);
    let heldForward = new Date(2026, 6, 9);

    for (let repeat = 0; repeat < 12000; repeat++) {
        heldBackward = NavigationModule.browsedDate(heldBackward, -1, 0);
        heldForward = NavigationModule.browsedDate(heldForward, 1, 0);
    }

    assert.equal(NavigationModule.browsedDate(earliest, -1, 0).getTime(),
        earliest.getTime(), "year browsing cannot enter year zero");
    assert.equal(NavigationModule.browsedDate(earliest, 0, -1).getTime(),
        earliest.getTime(), "month browsing cannot build January's year-zero cells");
    assert.equal(NavigationModule.browsedDate(latest, 1, 0).getTime(),
        latest.getTime(), "year browsing cannot enter year 10000");
    assert.equal(NavigationModule.browsedDate(latest, 0, 1).getTime(),
        latest.getTime(), "month browsing cannot build December's year-10000 cells");
    assert.deepEqual([heldBackward.getFullYear(), heldBackward.getMonth()], [1, 6]);
    assert.deepEqual([heldForward.getFullYear(), heldForward.getMonth()], [9999, 6]);

    assert.deepEqual([
        NavigationModule.clampCalendarDate(dateInYear(1, 0, 15)).getFullYear(),
        NavigationModule.clampCalendarDate(dateInYear(1, 0, 15)).getMonth(),
        NavigationModule.clampCalendarDate(dateInYear(1, 0, 15)).getDate()
    ], [1, 1, 1]);
    assert.deepEqual([
        NavigationModule.clampCalendarDate(dateInYear(9999, 11, 15)).getFullYear(),
        NavigationModule.clampCalendarDate(dateInYear(9999, 11, 15)).getMonth(),
        NavigationModule.clampCalendarDate(dateInYear(9999, 11, 15)).getDate()
    ], [9999, 10, 30]);
});

function expectedBrowseTarget(from, yearChange, monthChange) {
    let month = from.getMonth() + monthChange;
    let year = from.getFullYear() + yearChange;
    if (month > 11) {
        month = 0;
        year++;
    }
    if (month < 0) {
        month = 11;
        year--;
    }
    return { month, year };
}

test("fuzz: browse always lands in the expected month with a valid day", () => {
    const rand = makeRandom(424242);
    for (let i = 0; i < 400; i++) {
        const from = new Date(2000 + Math.floor(rand() * 50), Math.floor(rand() * 12),
            1 + Math.floor(rand() * 31));
        const yearChange = Math.floor(rand() * 5) - 2;
        const monthChange = rand() < 0.5 ? 0 : (rand() < 0.5 ? -1 : 1);

        const result = browse(from, yearChange, monthChange);
        const expected = expectedBrowseTarget(from, yearChange, monthChange);
        assert.equal(result.getMonth(), expected.month,
            `from ${from.toDateString()} y${yearChange} m${monthChange}`);
        assert.equal(result.getFullYear(), expected.year);
        assert.ok(result.getDate() >= 1 && result.getDate() <= 31);
    }
});


// ---- full-instantiation harness (T07a) ----

if (!String.prototype.capitalize) {
    Object.defineProperty(String.prototype, "capitalize", {
        value: function() {
            return this.charAt(0).toUpperCase() + this.slice(1);
        }
    });
}

if (!String.prototype.format) {
    Object.defineProperty(String.prototype, "format", {
        value: function(...args) {
            let i = 0;
            return this.replace(/%[ds]/g, () => String(args[i++]));
        }
    });
}

class MockActor {
    constructor(options = {}) {
        this.options = options;
        this.children = [];
        this.placements = [];
        this.handlers = {};
        this.visible = options.visible !== false;
        this.clutter_text = { line_wrap: false, ellipsize: 0 };
        this.style_class = options.style_class || "";
        this.text = options.text || "";
        this.label = options.label;
        this.pseudo = new Set();
        this.destroyed = false;
    }

    connect(name, cb) {
        (this.handlers[name] = this.handlers[name] || []).push(cb);
        return this.handlers[name].length;
    }

    set_accessible_name(name) {
        this.accessible_name = name;
    }

    grab_key_focus() {
        MockActor.focused = this;
    }

    fire(name, ...args) {
        (this.handlers[name] || []).forEach((cb) => cb(this, ...args));
    }

    get_clutter_text() {
        return this.clutter_text;
    }

    add(child, opts) {
        this.children.push(child);
        this.placements.push({ child, opts });
    }

    add_actor(child) {
        this.children.push(child);
        this.placements.push({ child });
    }

    remove_actor(child) {
        this.children = this.children.filter((c) => c !== child);
    }

    get_children() {
        return this.children.slice();
    }

    get_n_children() {
        return this.children.length;
    }

    destroy_all_children() {
        this.children = [];
        this.placements = [];
    }

    destroy() {
        this.destroyed = true;
    }

    add_style_pseudo_class(name) {
        this.pseudo.add(name);
    }

    remove_style_pseudo_class(name) {
        this.pseudo.delete(name);
    }

    remove_style_class_name(name) {
        this.style_class = this.style_class.split(" ").filter((c) => c !== name).join(" ");
    }

    add_style_class_name(name) {
        this.style_class += " " + name;
    }

    set_text(text) {
        this.text = text;
    }

    set_width(width) {
        this.width = width;
    }
}

global.imports.gi.St.Table = MockActor;
global.imports.gi.St.Button = MockActor;
global.imports.gi.St.Label = MockActor;
global.imports.gi.St.Bin = MockActor;
global.imports.gi.St.BoxLayout = MockActor;
global.imports.gi.Cinnamon.Stack = MockActor;
global.imports.gi.Cinnamon.GenericContainer = MockActor;

// The grid's collaborators take a host, not a Calendar: this is the whole
// contract they are allowed to know about. It used to be the Calendar's private
// field layout, so none of them could be built without one.
function makeHost(overrides = {}) {
    return Object.assign({
        selectedDate: new Date(2026, 6, 9),
        weekStart: 0,
        weekendLength: 2,
        eventsEnabled: true,
        eventsManager: null,
        holidayProvider: null,
        holidayGeneration: 0,
        selectDate() {},
        allocateDotBox() {},
        renderDots() {},
        nameCell() {},
        reportIssue() {},
        holidaysChanged() {}
    }, overrides);
}

function makeDesktopSettings() {
    return {
        connectFirstDayOfWeekChanged: () => 1,
        disconnect: () => {},
        use24h: true,
        showSeconds: false
    };
}

function makeSettings() {
    return {
        bindShowWeekNumbers(obj, prop) {
            obj[prop] = false;
        },
        bindWeekendLength(obj, prop) {
            obj[prop] = 2;
        }
    };
}

function makeEventsManager(colors = null) {
    return {
        handlers: {},
        disconnected: [],
        next_id: 1,
        connect(name, cb) {
            this.handlers[name] = cb;
            return this.next_id++;
        },
        disconnect(id) {
            this.disconnected.push(id);
        },
        is_active: () => true,
        get_colors_for_date: () => colors,
        get_colors_for_unix_key: () => colors
    };
}

function makeCalendar({ colors = null, holiday = null } = {}) {
    return new CalendarModule.Calendar(makeSettings(), makeEventsManager(colors), holiday,
        makeDesktopSettings());
}

// the grid keeps its cells; the day button is the first child of each cell group
function dayButtons(cal) {
    return cal._gridView.dayCells.map((cell) => cell.button);
}

// The dots are 4px of colour and nothing else: colour is the only channel that
// says a day has events, which leaves a screen-reader or low-vision user with
// no way to know.
test("a day's events are counted in its name, not only drawn as dots", () => {
    const cal = makeCalendar({ colors: ["#ff0000", "#00ff00"] });
    cal.setDate(new Date(2026, 6, 9), true);

    const withEvents = dayButtons(cal).find((button) => button.label === "9");
    assert.match(withEvents.accessible_name, /2 events$/);

    const none = makeCalendar({ colors: [] });
    none.setDate(new Date(2026, 6, 9), true);
    assert.doesNotMatch(dayButtons(none).find((button) => button.label === "9").accessible_name,
        /event/, "and a day with none says nothing about events");

    const one = makeCalendar({ colors: ["#ff0000"] });
    one.setDate(new Date(2026, 6, 9), true);
    assert.match(dayButtons(one).find((button) => button.label === "9").accessible_name,
        /1 event$/, "one event is not 1 events");
});

// today and the selected day are drawn as a background colour and nothing
// else: the one piece of orientation the grid exists to give was unsayable
test("today and the selected day say so in their names", () => {
    const cal = makeCalendar();
    const today = new Date();
    cal.setDate(today, true);

    const buttons = dayButtons(cal);
    const todayCell = cal._gridView.dayCells.find((cell) => cell.is_today);
    assert.ok(todayCell, "the grid always contains today when today is selected");
    assert.match(todayCell.button.accessible_name, /Today/);
    assert.match(todayCell.button.accessible_name, /Selected/);

    const others = buttons.filter((button) => button !== todayCell.button);
    assert.equal(others.filter((button) => /Today/.test(button.accessible_name)).length, 0,
        "exactly one cell is today");
    assert.equal(others.filter((button) => /Selected/.test(button.accessible_name)).length, 0,
        "exactly one cell is selected");
});

test("harness: Calendar instantiates and builds header plus 42 day cells", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);
    const buttons = dayButtons(cal);
    assert.equal(buttons.length, 42);
    assert.equal(cal._yearLabel.text, "2026");
});

test("the calendar rebuilds when the locale query answers", () => {
    const localeQuery = global.imports.ui.appletManager.applets["chronos@geraldo-netto"].localeQuery;
    const listeners = [];
    const original = localeQuery.onLocaleInfoChanged;
    localeQuery.onLocaleInfoChanged = (env, callback) => {
        listeners.push({ env, callback });
        return () => {
            const index = listeners.findIndex((entry) => entry.callback === callback);
            if (index >= 0) {
                listeners.splice(index, 1);
            }
        };
    };

    const cal = makeCalendar();
    localeQuery.onLocaleInfoChanged = original;
    cal.setDate(new Date(2026, 6, 9), true);
    const oldYearLabel = cal._yearLabel;

    assert.equal(listeners.length, 1, "the calendar listens for the locale info");
    // ...for LC_TIME, and only LC_TIME: the header depends on the weekday
    // abbreviations and the weekend days, and on nothing else the locale carries
    assert.equal(listeners[0].env, "LC_TIME");

    // the weekday abbreviations and the weekend days depend on it, so the
    // header and the grid are rebuilt when it lands
    let updates = 0;
    const queue = cal._queue_update.bind(cal);
    cal._queue_update = () => {
        updates++;
        cal._cancel_update();
        cal._update();
    };
    listeners[0].callback();
    void queue;
    assert.equal(updates, 1);
    assert.notEqual(cal._yearLabel, oldYearLabel, "the locale rebuild replaces the label");
    assert.equal(cal._yearLabel.text, "2026",
        "the replacement label receives the current year");
    assert.equal(dayButtons(cal).length, 42, "the rebuilt header still carries a full grid");

    cal.destroy();
    assert.equal(listeners.length, 0, "and it stops listening when destroyed");
});

test("a holiday failure is announced in words, not just a glyph", () => {
    const label = new MockActor();
    const annotator = new AnnotationsModule.CalendarHolidayAnnotator(makeHost({
        holidayProvider: { active: true, getHolidays() {} }
    }));
    annotator.attachLabel(label);

    annotator.setStatus("Weather service unavailable");
    assert.match(label.text, /⚠/, "the glyph still marks it visually");
    assert.match(label.accessible_name, /Holiday data/,
        "and the reason is readable without hovering");

    annotator.setStatus("");
    assert.doesNotMatch(label.accessible_name, /Holiday data/);
});

test("holiday failures reach the shared footer and recovery clears them", () => {
    const issues = [];
    const label = new MockActor();
    const annotator = new AnnotationsModule.CalendarHolidayAnnotator(makeHost({
        reportIssue: (source, message) => issues.push([source, message])
    }));
    annotator.attachLabel(label, new MockActor());

    annotator.setStatus("Holiday service unavailable", "Enrico");
    assert.deepEqual(issues.at(-1),
        ["holidays", "Holiday service unavailable — Enrico"]);

    annotator.setPending();
    assert.deepEqual(issues.at(-1),
        ["holidays", "Holiday service unavailable — Enrico"],
        "another month still loading cannot erase a known visible error");

    annotator.beginUpdate();
    annotator.setPending();
    assert.deepEqual(issues.at(-1), ["holidays", ""],
        "a retry in flight is not reported as a current error");

    annotator.setStatus("", "Enrico");
    assert.deepEqual(issues.at(-1), ["holidays", ""],
        "a successful provider answer keeps the footer clear");
});

// REGRESSION: the provider's own JSON error string was stored as the applet's
// error and displayed verbatim — translateHolidayError was a lookup with a
// passthrough fallback, so an English sentence from a vendor was pinned under the
// month name in an otherwise French interface, in the label, its accessible name
// and the tooltip. A broken or hostile endpoint chose that sentence.
test("a provider's own error sentence is never shown to the user", () => {
    const label = new MockActor();
    const annotator = new AnnotationsModule.CalendarHolidayAnnotator(makeHost({
        holidayProvider: { active: true, getHolidays() {} }
    }));
    annotator.attachLabel(label);

    annotator.setStatus("Le service Enrico est momentanément indisponible", "Enrico");

    assert.doesNotMatch(label.text, /Enrico est/);
    assert.doesNotMatch(label.accessible_name, /Enrico est/);
    assert.match(label.accessible_name, /Holiday data unavailable/,
        "the applet's own message, which every catalog can translate");
});

// A tooltip is driven by enter-event, and a non-reactive actor is not pickable,
// so it never emits one: the holiday status tooltip was writing text nobody
// could ever see, and the warning glyph on the month label went unexplained for
// every mouse user.
test("the holiday status tooltip can actually be hovered", () => {
    const cal = makeCalendar();

    assert.equal(cal._monthLabel.options.reactive, true);
});

// The reason used to be shown from a key-focus-in handler that called
// Tooltip.show(). That cannot work: Cinnamon's show() opens with
//
//     if (this._tooltip.get_text() == "" || !this.mousePosition) return;
//
// and mousePosition is set only from enter-event and motion-event — a keyboard
// sets it never. TooltipBase also wires global.stage's notify::key-focus straight
// to its own _hide, so moving focus onto the label hides the tooltip the focus
// handler is trying to open. It shipped and never once worked: the reason is a
// real actor now, not a hover.
test("a failed holiday lookup says why, without a mouse", () => {
    const cal = makeCalendar();

    assert.equal(cal._holidayReasonLabel.visible, false,
        "an ordinary month says nothing and takes no space");

    cal._holidayAnnotator.setStatus("Holiday service unavailable", "Enrico");

    assert.equal(cal._holidayReasonLabel.visible, true);
    assert.match(cal._holidayReasonLabel.text, /Holiday service unavailable/,
        "the reason is readable with no mouse and no screen reader");
    assert.match(cal._holidayReasonLabel.text, /Enrico/, "and it names the service");
    assert.match(cal._monthLabel.text, /⚠/, "the glyph still marks the month");
    // the mouse still gets the tooltip, and a screen reader still gets the name
    assert.match(cal._holidayAnnotator.monthLabel.tooltip.texts.at(-1), /Holiday service unavailable/);
    assert.match(cal._monthLabel.accessible_name, /Holiday service unavailable/);

    // ...and when the lookup recovers, the line goes away again
    cal._holidayAnnotator.setStatus("", "Enrico");

    assert.equal(cal._holidayReasonLabel.visible, false,
        "the provider credit on a good month is not a permanent line under it");
    assert.doesNotMatch(cal._monthLabel.text, /⚠/);
});

test("the month and year navigation buttons announce what they do", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);

    const navButtons = cal.actor.get_children()
        .filter((child) => child.children && child.children.length)
        .flatMap((box) => box.children)
        .filter((child) => (child.options.style_class || "").startsWith("calendar-change-month"));

    assert.equal(navButtons.length, 4, "previous/next month and previous/next year");
    assert.deepEqual(navButtons.map((button) => button.accessible_name), [
        "Previous month", "Next month", "Previous year", "Next year"
    ]);
    assert.ok(navButtons.every((button) => button.options.can_focus === true));
});

test("the grid is navigable from the keyboard and announces its days", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);

    const press = (symbol) => cal.actor.fire("key-press-event", { get_key_symbol: () => symbol });
    const Clutter = global.imports.gi.Clutter;

    press(Clutter.KEY_Right);
    assert.equal(cal.getSelectedDate().getDate(), 10, "right moves one day");
    press(Clutter.KEY_Down);
    assert.equal(cal.getSelectedDate().getDate(), 17, "down moves one week");
    press(Clutter.KEY_Left);
    assert.equal(cal.getSelectedDate().getDate(), 16);
    press(Clutter.KEY_Up);
    assert.equal(cal.getSelectedDate().getDate(), 9);

    press(Clutter.KEY_Page_Down);
    cal._navigation.flushQueuedDate();
    assert.equal(cal.getSelectedDate().getMonth(), 7, "page down moves a month");
    press(Clutter.KEY_Page_Up);
    cal._navigation.flushQueuedDate();
    assert.equal(cal.getSelectedDate().getMonth(), 6);

    press(Clutter.KEY_Home);
    // the whole date, not just the day-of-month: a Home key that lands on the
    // right day in the wrong month or year used to pass. The clock is read once,
    // so a run crossing local midnight cannot flake either.
    const today = new Date();
    const selected = cal.getSelectedDate();
    assert.equal(selected.getDate(), today.getDate(), "home returns to today");
    assert.equal(selected.getMonth(), today.getMonth());
    assert.equal(selected.getFullYear(), today.getFullYear());

    // the focused cell follows the selection, and every cell names its date
    assert.ok(MockActor.focused, "the selected day takes keyboard focus");
    const buttons = dayButtons(cal);
    assert.ok(buttons.every((button) => typeof button.accessible_name === "string" &&
        button.accessible_name.length > 0));

    // PageUp/PageDown queue the month change on an idle: the focus has to
    // follow the date rather than chase it
    MockActor.focused = null;
    press(Clutter.KEY_Page_Down);
    assert.equal(MockActor.focused, null, "nothing is focused before the date lands");
    cal._navigation.flushQueuedDate();
    assert.ok(MockActor.focused, "and the newly selected day has focus once it does");
});

test("events-off selection stays locked for keyboard and scroll input", () => {
    const cal = makeCalendar();
    const selected = new Date(2026, 6, 9);
    const Clutter = global.imports.gi.Clutter;
    const press = (symbol) => cal.actor.fire("key-press-event", {
        get_key_symbol: () => symbol
    });
    const scroll = (direction) => cal._onScroll(null, {
        get_scroll_direction: () => direction,
        get_scroll_delta: () => [0, 2]
    });
    cal.setDate(selected, true);
    cal.events_enabled = false;

    for (const symbol of [
        Clutter.KEY_Right,
        Clutter.KEY_Page_Down,
        Clutter.KEY_Home
    ]) {
        press(symbol);
    }
    for (const direction of [
        Clutter.ScrollDirection.DOWN,
        Clutter.ScrollDirection.SMOOTH
    ]) {
        scroll(direction);
    }

    assert.equal(cal.getSelectedDate().getTime(), selected.getTime());
    assert.equal(cal._navigation.queuedDate, null);
    assert.equal(cal._navigation.scrollAccumulator, 0);
});

// the handler sits on the table, which is the ancestor of the month and year
// buttons too: taking the arrows unconditionally meant Left and Right moved the
// date while the user was trying to move between those buttons
test("the arrow keys are the grid's, not the navigation buttons'", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);
    const Clutter = global.imports.gi.Clutter;
    const press = (symbol) => cal.actor.fire("key-press-event", { get_key_symbol: () => symbol });

    // one of the month/year navigation buttons has keyboard focus
    const navButton = cal._topBoxMonth.children[0];
    assert.equal(navButton.accessible_name, "Previous month");
    global.stage = { get_key_focus: () => navButton };
    press(Clutter.KEY_Right);
    assert.equal(cal.getSelectedDate().getDate(), 9,
        "the arrow belongs to the focused button; the date does not move");

    // a day cell has it
    const day = dayButtons(cal).find((button) => button.label === "9");
    global.stage = { get_key_focus: () => day };
    press(Clutter.KEY_Right);
    assert.equal(cal.getSelectedDate().getDate(), 10, "and now the arrow walks the grid");

    global.stage = undefined;
});

test("CalendarMonthWindow builds 42 visible dates and month lookup keys", () => {
    const window = new CalendarModule.CalendarMonthWindow(new Date(2026, 6, 9), 0);

    assert.equal(window.days.length, 42);
    assert.equal(window.dateUnixKeys.length, 42);
    assert.equal(window.days[0].getFullYear(), 2026);
    assert.equal(window.days[0].getMonth(), 5);
    assert.equal(window.days[0].getDate(), 28);
    assert.equal(window.dateUnixKeys[0], Math.trunc(new Date(2026, 5, 28).getTime() / 1000));
    assert.equal(window.dateUnixKeys[3], Math.trunc(new Date(2026, 6, 1).getTime() / 1000));
    assert.equal(window.days[3].getDate(), 1);
    assert.equal(window.months.has("2026/6"), true);
    assert.equal(window.months.has("2026/7"), true);
    assert.equal(typeof window.weekLabelForRow(0), "string");
});

test("CalendarMonthWindow guards its GLib date domain", () => {
    const minimum = new CalendarModule.CalendarMonthWindow(dateInYear(1, 0, 15), 0);
    const maximum = new CalendarModule.CalendarMonthWindow(dateInYear(9999, 11, 15), 0);
    assert.ok(minimum.days.every((day) => day.getFullYear() >= 1));
    assert.ok(maximum.days.every((day) => day.getFullYear() <= 9999));

    const original = global.imports.gi.GLib.DateTime.new_from_unix_local;
    global.imports.gi.GLib.DateTime.new_from_unix_local = () => null;
    try {
        const unavailable = new CalendarModule.CalendarMonthWindow(new Date(2026, 6, 9), 0);
        assert.ok(unavailable.dateUnixKeys.every((key) => key === null),
            "a failed GLib conversion does not escape the render idle");
    } finally {
        global.imports.gi.GLib.DateTime.new_from_unix_local = original;
    }
});

test("CalendarDayCellRenderer builds reusable clickable cells", () => {
    let selected = null;
    const host = makeHost({ selectDate(date) { selected = date; } });
    const renderer = new CalendarModule.CalendarDayCellRenderer(host);
    const cell = renderer.build();

    assert.equal(cell.button.label, "");
    assert.equal(cell.group.children[0], cell.button);
    assert.equal(cell.group.children[1], cell.dot_box);

    cell.date = new Date(2026, 6, 14);
    cell.button.fire("clicked");
    assert.equal(selected.getFullYear(), 2026);
    assert.equal(selected.getMonth(), 6);
    assert.equal(selected.getDate(), 14);
});

// the cells are built once and reused, so a click can land on a cell that is not
// currently showing a date, and clicking one while events are off must not move
// the selection out from under the user
test("a day cell click selects nothing when it holds no date or events are off", () => {
    let selected = null;
    const host = makeHost({ selectDate(date) { selected = date; } });
    const renderer = new CalendarModule.CalendarDayCellRenderer(host);

    const empty = renderer.build();
    empty.button.fire("clicked");
    assert.equal(selected, null, "a cell with no date selects nothing");

    host.eventsEnabled = false;
    const dated = renderer.build();
    dated.date = new Date(2026, 6, 14);
    dated.button.fire("clicked");
    assert.equal(selected, null, "and neither does one clicked while events are off");
});

// T581: events_enabled was recomputed only from the manager-ready and
// calendars-changed signals, but the show-events setting participates in
// is_active() and changes through the applet's settings path — so cached
// event dots stayed on the grid after the user switched events off.
test("switching events off clears the grid without a manager signal", () => {
    let active = true;
    const manager = makeEventsManager(["#ff0000"]);
    manager.is_active = () => active;
    const cal = new CalendarModule.Calendar(makeSettings(), manager, null,
        makeDesktopSettings());
    cal.setDate(new Date(2026, 6, 9), true);
    const day9 = () => dayButtons(cal).find((button) => button.label === "9");
    assert.match(day9().accessible_name, /1 event$/);

    // the user switches show-events off: is_active() flips, no signal fires
    active = false;
    cal.refreshEventsEnabled();
    cal._idle_do_update();
    assert.equal(cal.events_enabled, false);
    assert.doesNotMatch(day9().accessible_name, /event/,
        "the cached dots and counts are gone");

    // ...and switching back on restores them from the still-indexed data
    active = true;
    cal.refreshEventsEnabled();
    cal._idle_do_update();
    assert.match(day9().accessible_name, /1 event$/);
});

// The seam itself: what the grid's collaborators may know about the calendar.
// They used to hold the Calendar and read its private fields, so this contract
// existed only as the sum of those reads.
test("the grid host is the whole contract the collaborators get", () => {
    const allocations = [];
    const named = [];
    const dots = [];
    let holidayChanges = 0;
    let selected = null;
    const eventsManager = { get_colors_for_unix_key: () => null };
    const holiday = { country: "ita" };
    const selectedDate = new Date(2026, 6, 9);
    const port = {
        selectedDate: () => selectedDate,
        weekStart: () => 1,
        weekendLength: () => 1,
        eventsEnabled: () => true,
        eventsManager,
        holidayProvider: () => holiday,
        holidayGeneration: () => 4,
        selectDate: (date) => { selected = date; },
        allocateDotBox: (...args) => allocations.push(args),
        renderDots: (...args) => dots.push(args),
        nameCell: (cell) => named.push(cell),
        reportIssue() {},
        holidaysChanged: () => { holidayChanges++; }
    };
    const host = new CalendarModule.CalendarGridHost(port);

    assert.equal(host.selectedDate, selectedDate);
    assert.equal(host.weekStart, 1);
    assert.equal(host.weekendLength, 1);
    assert.equal(host.eventsEnabled, true);
    assert.equal(host.eventsManager, eventsManager);
    assert.equal(host.holidayProvider, holiday);
    assert.equal(host.holidayGeneration, 4);

    const date = new Date(2026, 6, 14);
    host.selectDate(date);
    // a cell click never forces a reload: the date it selects is the date it
    // already shows
    assert.equal(selected, date);

    host.allocateDotBox("actor", "box", "flags");
    assert.deepEqual(allocations, [["actor", "box", "flags"]]);

    host.renderDots("cell", "iter", 99);
    assert.deepEqual(dots, [["cell", "iter", 99]]);

    host.nameCell("cell");
    assert.deepEqual(named, ["cell"]);

    host.holidaysChanged();
    assert.equal(holidayChanges, 1);
});

// The dot box's allocate handler is wired with connect(), and the grid's only
// per-frame work runs inside it. Calling the calendar's handler directly — which
// is what the suite did — proves nothing about whether the signal reaches it.
test("a day cell's dot box allocates through the host", () => {
    const allocations = [];
    const host = makeHost({
        allocateDotBox: (actor, box, flags) => allocations.push([actor, box, flags])
    });
    const renderer = new CalendarModule.CalendarDayCellRenderer(host);
    const cell = renderer.build();

    const box = { x1: 0, x2: 40, y1: 0, y2: 10 };
    cell.dot_box.fire("allocate", box, 0);

    assert.equal(allocations.length, 1, "the allocate signal reaches the calendar");
    assert.equal(allocations[0][0], cell.dot_box);
    assert.equal(allocations[0][1], box);

    const calendar = makeCalendar();
    calendar._update();
    calendar._gridView.dayCells[0].dot_box.fire("allocate", box, 0);
});

// St gives every actor set_accessible_name; a plain double does not, and the
// renderer must not die on the older Cinnamon that also does not
test("applyAccessibleName tolerates a button that cannot be named", () => {
    const renderer = new CalendarModule.CalendarDayCellRenderer({});
    const cell = {
        button: {},
        accessible_date: "Tuesday, July 14, 2026",
        event_count: 0,
        holiday_name: ""
    };

    renderer.applyAccessibleName(cell);

    assert.equal(cell.accessible_name, undefined);
});

test("CalendarDayCellRenderer mutates cached state and delegates dots", () => {
    const dotCalls = [];
    const host = makeHost({
        renderDots: (cell, iter) => dotCalls.push([cell, iter])
    });
    const renderer = new CalendarModule.CalendarDayCellRenderer(host);
    const cell = renderer.build();
    cell.holidayTooltip = new global.imports.ui.tooltips.Tooltip(cell.button);
    cell.holiday_tooltip_set = true;

    renderer.update(cell, new Date(2026, 6, 9), 2);

    assert.equal(cell.button.label, "9");
    assert.equal(cell.date.getDate(), 9);
    assert.equal(cell.selected, true);
    assert.ok(cell.button.pseudo.has("selected"));
    assert.ok(cell.button.style_class.includes("calendar-day-top"));
    assert.equal(cell.holiday_tooltip_set, false);
    assert.equal(cell.holidayTooltip.texts.at(-1), "");
    assert.equal(dotCalls.length, 1);
});

test("CalendarDayCellRenderer reuses the update-scoped today value", () => {
    const OriginalDate = Date;
    const renderer = new CalendarModule.CalendarDayCellRenderer({
        _selectedDate: new OriginalDate(2026, 6, 9),
        _weekStart: 0,
        weekend_length: 2,
        _eventDotRenderer: { update() {} }
    });
    const iter = new OriginalDate(2026, 6, 9);
    const today = new OriginalDate(2026, 6, 9);

    let constructed = 0;
    global.Date = class CountingDate extends OriginalDate {
        constructor(...args) {
            constructed++;
            super(...args);
        }
    };
    try {
        assert.match(renderer._dayStyleClass(iter, 2, today), /calendar-today/);
        assert.equal(constructed, 0);
    } finally {
        global.Date = OriginalDate;
    }
});

test("CalendarEventDotRenderer owns dot actor reuse and cleanup", () => {
    let colors = ["#101010", "color: red;"];
    const renderer = new CalendarModule.CalendarEventDotRenderer(makeHost({
        eventsManager: { get_colors_for_unix_key: () => colors }
    }));
    const cell = { dot_key: "", dot_box: new MockActor() };

    renderer.update(cell, new Date(2026, 6, 9), 1);
    assert.equal(cell.dot_box.children.length, 2);
    assert.ok(cell.dot_box.children[0].options.style.includes("#101010"));
    assert.ok(!cell.dot_box.children[1].options.style.includes("color: red"));

    const firstDot = cell.dot_box.children[0];
    colors = ["#202020"];
    renderer.update(cell, new Date(2026, 6, 9), 1);
    assert.equal(cell.dot_box.children.length, 1);
    assert.equal(cell.dot_box.children[0], firstDot);
    assert.ok(firstDot.style.includes("#202020"));

    colors = null;
    renderer.update(cell, new Date(2026, 6, 9), 1);
    assert.equal(cell.dot_box.children.length, 0);
    assert.equal(firstDot.destroyed, true);
});

// T07b: placement for representative month shapes
function placedGrid(cal) {
    const cells = [];
    for (const placement of cal.actor.placements) {
        if (placement.opts && placement.opts.row >= 2 && placement.child.children
            && placement.child.children.length) {
            cells.push({ row: placement.opts.row, col: placement.opts.col,
                day: placement.child.children[0].label });
        }
    }
    return cells;
}

test("grid placement: July 2026 (31 days, starts Wednesday, week starts Sunday)", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);
    const cells = placedGrid(cal);

    // 2026-07-01 is a Wednesday: row 2, col 3
    const first = cells.find((c) => c.day === "1" && c.col === 3 && c.row === 2);
    assert.ok(first, "July 1st placed at row 2 col 3");
    // six full rows
    assert.equal(Math.max(...cells.map((c) => c.row)), 7);
    assert.equal(cells.length, 42);
});

test("grid placement: February 2026 (28 days, starts Sunday)", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 1, 10), true);
    const cells = placedGrid(cal);
    const first = cells.find((c) => c.day === "1" && c.row === 2 && c.col === 0);
    assert.ok(first, "Feb 1st 2026 placed at row 2 col 0");
    assert.equal(cells.length, 42);
});

test("grid placement: April 2026 (30 days, starts Wednesday)", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 3, 15), true);
    const cells = placedGrid(cal);
    assert.equal(cells.length, 42);
    const first = cells.find((c) => c.day === "1" && c.row === 2);
    assert.equal(first.col, 3);
});

test("selected day carries the selected pseudo class and dots render colors", () => {
    const cal = makeCalendar({ colors: ["#101010", "#202020"] });
    cal.setDate(new Date(2026, 6, 9), true);
    const selected = dayButtons(cal).filter((b) => b.pseudo.has("selected"));
    assert.equal(selected.length, 1);
    assert.equal(selected[0].label, "9");

    const dotBox = cal._gridView.dayCells[0].dot_box;
    assert.equal(dotBox.children.length, 2);
    assert.ok(dotBox.children[0].options.style.includes("#101010"));
});

// T07c: holiday annotation via a stubbed provider
function makeHolidayStub(datesByMonth, error = "") {
    return {
        active: true,
        calls: [],
        getHolidays(y, m, cb) {
            this.calls.push([y, m]);
            const dates = new Map(Object.entries(datesByMonth[`${y}/${m}`] || {}));
            cb(dates, error, "stub-provider");
        }
    };
}

test("holiday annotation: names become tooltips and days turn nonwork", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": ["Bastille Day", []] } });
    const cal = makeCalendar({ holiday });
    cal.setDate(new Date(2026, 6, 9), true);

    assert.ok(holiday.calls.length >= 1);
    const day14 = dayButtons(cal).find((b) => b.label === "14" &&
        b.style_class.includes("calendar-nonwork-day"));
    assert.ok(day14, "holiday day styled as nonwork");
    assert.ok(!day14.style_class.includes("calendar-work-day"));
    const fetches = holiday.calls.length;
    assert.deepEqual(cal.holidayForDate(new Date(2026, 6, 14)),
        ["Bastille Day", []]);
    assert.equal(holiday.calls.length, fetches,
        "selected-day lookup reuses the rendered holiday model");
    const cell = cal._gridView.dayCells.find((candidate) => candidate.button === day14);
    assert.equal(cell.holidayTooltip.texts.at(-1), "Bastille Day",
        "the existing cell tooltip remains intact");
    assert.equal(AnnotationsModule.calendarDateKey(
        makeFakeDateTimeFromDate(new Date(2026, 6, 14))), "2026/7/14",
        "GLib and JavaScript dates address the same cached holiday");
});

test("the month window is reused while the month and week start hold", () => {
    const cache = new CalendarModule.CalendarMonthWindowCache();

    const first = cache.get(new Date(2026, 6, 9), 0);
    const sameMonth = cache.get(new Date(2026, 6, 27), 0);
    assert.equal(sameMonth, first, "another day of the same month reuses the window");

    const otherWeekStart = cache.get(new Date(2026, 6, 9), 1);
    assert.notEqual(otherWeekStart, first, "a different week start rebuilds it");

    const otherMonth = cache.get(new Date(2026, 7, 9), 1);
    assert.notEqual(otherMonth, otherWeekStart);
    assert.equal(otherMonth.days.length, 42);
});

test("a holiday fetch that has not answered yet shows a pending marker", () => {
    let pending = null;
    const label = new MockActor();
    const annotator = new AnnotationsModule.CalendarHolidayAnnotator(makeHost({
        holidayGeneration: 3,
        holidayProvider: {
            active: true,
            // a real network round-trip: the callback lands later
            getHolidays(y, m, cb) {
                pending = cb;
            }
        }
    }));
    annotator.attachLabel(label);

    annotator.annotate(new Set(["2026/7"]), new Map(), 3);

    // the pending marker on the label is the whole observable: the annotator
    // used to carry a `pending` flag beside it that nothing in the applet read
    assert.match(label.text, /…$/);
    assert.match(annotator.monthLabel.tooltip.texts.at(-1), /loading/);

    pending(new Map(), "", "stub-provider");

    assert.doesNotMatch(label.text, /…/);
});

// T603: `awaited` was a local counter never re-read after the dispatch loop,
// and a success ran setStatus() unconditionally — so on a year-straddling grid
// the first month's answer erased the pending marker while the second was
// still in flight, making a slow January look identical to a month with no
// holidays. Only the last outstanding answer may render the final status.
test("the pending marker survives until every in-flight month answers", () => {
    const pending = new Map();
    const label = new MockActor();
    const annotator = new AnnotationsModule.CalendarHolidayAnnotator(makeHost({
        holidayGeneration: 3,
        holidayProvider: {
            active: true,
            getHolidays(y, m, cb) {
                pending.set(`${y}/${m}`, cb);
            }
        }
    }));
    annotator.attachLabel(label);

    annotator.annotate(new Set(["2026/12", "2027/1"]), new Map(), 3);
    assert.match(label.text, /…$/);

    pending.get("2026/12")(new Map(), "", "stub-provider");
    assert.match(label.text, /…$/, "December's answer keeps January's marker");
    assert.match(annotator.monthLabel.tooltip.texts.at(-1), /loading/);

    pending.get("2027/1")(new Map(), "", "stub-provider");
    assert.doesNotMatch(label.text, /…/);
    assert.ok(annotator.monthLabel.tooltip.texts.at(-1).includes("stub-provider"),
        "the final answer renders the provider credit");
});

test("CalendarHolidayAnnotator owns provider status and cell annotations", () => {
    const cell = {
        button: new MockActor({ style_class: "calendar-work-day" }),
        holidayTooltip: null,
        holiday_tooltip_set: false,
        holiday_styled: false
    };
    const label = new MockActor();
    const host = makeHost({
        holidayGeneration: 7,
        holidayProvider: {
            active: true,
            getHolidays(y, m, cb) {
                assert.equal(`${y}/${m}`, "2026/7");
                cb(new Map([["7/14", ["Bastille Day", []]]]), "", "stub-provider");
            }
        }
    });
    // the annotator renames the cell it just annotated through the host, rather
    // than reaching across for the calendar's cell renderer
    const cellRenderer = new CalendarModule.CalendarDayCellRenderer(host);
    host.nameCell = (target) => cellRenderer.applyAccessibleName(target);
    const annotator = new AnnotationsModule.CalendarHolidayAnnotator(host);
    annotator.attachLabel(label);

    cell.accessible_date = "Tuesday, 14 July 2026";
    annotator.annotate(new Set(["2026/7"]), new Map([["7/14", cell]]), 7);

    assert.equal(annotator.provider, "stub-provider");
    assert.ok(annotator.monthLabel.tooltip.texts.at(-1).includes("stub-provider"));
    assert.equal(cell.holiday_tooltip_set, true);
    assert.equal(cell.holidayTooltip.texts.at(-1), "Bastille Day");
    assert.ok(cell.button.style_class.includes("calendar-nonwork-day"));
    assert.ok(!cell.button.style_class.includes("calendar-work-day"));
    // ...and nonwork-day alone is what a Saturday wears, so a holiday needs a
    // mark of its own or the feature is invisible without hovering every cell
    assert.ok(cell.button.style_class.includes("calendar-holiday-day"));
    const css = fs.readFileSync(path.join(APPLET_DIR, "5.4", "stylesheet.css"), "utf8");
    assert.match(css, /\.calendar-holiday-day\s*\{[^}]+\}/,
        "the class has to draw something");

    // the tooltip is the only place the name appears, and a keyboard never
    // opens one
    assert.equal(cell.button.accessible_name, "Tuesday, 14 July 2026 — Bastille Day");
});

test("holiday annotation: part-day holidays keep workday style with 1-day weekends", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": ["Half day", ["PART_DAY_HOLIDAY"]] } });
    const cal = makeCalendar({ holiday });
    cal.weekend_length = 1;
    cal.setDate(new Date(2026, 6, 9), true);
    const day14 = dayButtons(cal).find((b) => b.label === "14");
    assert.ok(day14.style_class.includes("calendar-work-day"));
});

test("holiday annotation: religious-only dates stay working days", () => {
    const holiday = makeHolidayStub({
        "2026/7": { "7/14": ["Local observance", ["religious_holiday", "taoism"]] }
    });
    const cal = makeCalendar({ holiday });
    cal.setDate(new Date(2026, 6, 9), true);
    const day14 = dayButtons(cal).find((button) => button.label === "14");

    assert.ok(day14.style_class.includes("calendar-work-day"));
    assert.ok(!day14.style_class.includes("calendar-nonwork-day"));
    assert.ok(day14.style_class.includes("calendar-holiday-day"),
        "the observance remains visible without being called a day off");
});

test("holiday annotation: merged public and religious dates are non-working", () => {
    const holiday = makeHolidayStub({
        "2026/7": {
            "7/14": ["Public holiday\nLocal observance",
                ["public_holiday", "religious_holiday", "taoism"]]
        }
    });
    const cal = makeCalendar({ holiday });
    cal.setDate(new Date(2026, 6, 9), true);
    const day14 = dayButtons(cal).find((button) => button.label === "14");

    assert.ok(!day14.style_class.includes("calendar-work-day"));
    assert.ok(day14.style_class.includes("calendar-nonwork-day"));
    assert.ok(day14.style_class.includes("calendar-holiday-day"));
});

test("holiday annotation: errors surface in the month label marker", () => {
    const holiday = makeHolidayStub({}, "Holiday service unavailable");
    const cal = makeCalendar({ holiday });
    cal.setDate(new Date(2026, 6, 9), true);
    assert.ok(cal._monthLabel.text.includes("⚠"));
});

test("stale holiday generations are ignored", () => {
    let savedCb = null;
    const holiday = {
        active: true,
        getHolidays(y, m, cb) {
            savedCb = cb;
        }
    };
    const cal = makeCalendar({ holiday });
    cal.setDate(new Date(2026, 6, 9), true);
    const staleCb = savedCb;
    cal.setDate(new Date(2026, 7, 9), true); // bumps generation
    const before = cal._monthLabel.text;
    staleCb(new Map(), "err", "stale");
    assert.equal(cal._monthLabel.text, before, "stale callback must not mutate state");
});

test("_isWorkDay derives the weekend from locale first_workday and length", () => {
    const firstWorkday = 1;
    for (let weekendLength of [1, 2]) {
        for (let day = 0; day < 7; day++) {
            // 2026-03-01 is a Sunday; day offsets map directly onto getDay()
            const date = new Date(2026, 2, 1 + day);
            const expected = date.getDay() !== (firstWorkday + 7 - weekendLength) % 7 &&
                date.getDay() !== (firstWorkday + 6) % 7;
            assert.equal(CalendarModule._isWorkDay(date, weekendLength), expected,
                `day ${day} length ${weekendLength}`);
        }
        // exactly `weekendLength` days off per week
        let off = 0;
        for (let day = 0; day < 7; day++) {
            if (!CalendarModule._isWorkDay(new Date(2026, 2, 1 + day), weekendLength)) {
                off++;
            }
        }
        assert.equal(off, weekendLength);
    }
});

// T24b: dot layout allocation across row wrapping
function makeDot(width, height) {
    return {
        allocations: [],
        get_preferred_width: () => [width, width],
        get_preferred_height: () => [height, height],
        allocate(box) {
            this.allocations.push({ x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 });
        }
    };
}

function allocateDots(count, boxWidth, maxRows = null) {
    const dots = Array.from({ length: count }, () => makeDot(10, 10));
    const actor = {
        get_children: () => dots,
        get_theme_node: () => ({
            lookup_double: () => (maxRows === null ? [false, 0] : [true, maxRows])
        })
    };
    global.imports.gi.Clutter.ActorBox = class {
        constructor() {
            this.x1 = 0;
            this.y1 = 0;
            this.x2 = 0;
            this.y2 = 0;
        }
    };
    const cal = makeCalendar();
    cal._gridView.allocateDotBox(actor, { x1: 0, y1: 0, x2: boxWidth, y2: 20 }, {});
    return dots;
}

// this runs inside Clutter's allocation cycle, once per event-bearing cell —
// up to 42 of them — and neither the dot's natural size nor the theme's
// max-rows depends on the box being allocated
test("dot box: the theme is asked once, and again only when it changes", () => {
    let lookups = 0;
    const dots = Array.from({ length: 3 }, () => makeDot(10, 10));
    const actor = {
        get_children: () => dots,
        get_theme_node: () => ({
            lookup_double: () => {
                lookups++;
                return [true, 2];
            }
        })
    };
    global.imports.gi.Clutter.ActorBox = class {
        constructor() {
            this.x1 = 0;
            this.y1 = 0;
            this.x2 = 0;
            this.y2 = 0;
        }
    };

    const cal = makeCalendar();
    const box = { x1: 0, y1: 0, x2: 100, y2: 20 };
    for (let cell = 0; cell < 42; cell++) {
        cal._gridView.allocateDotBox(actor, box, {});
    }
    assert.equal(lookups, 1, "the theme node is not re-read for every cell");

    // a theme change is the one moment those values move, and that is what
    // _onStyleChange drops
    assert.ok(cal._gridView.dotMetrics, "the metrics are held between allocations");
    cal._gridView.dotMetrics = null;
    cal._gridView.allocateDotBox(actor, box, {});
    assert.equal(lookups, 2);
});

test("dot box: dots that fit stay centered on one row", () => {
    const dots = allocateDots(3, 100);
    assert.equal(dots[0].allocations.length, 1);
    // 100 - 30 = 70, start at 35
    assert.equal(dots[0].allocations[0].x1, 35);
    assert.equal(dots[1].allocations[0].x1, 45);
    assert.deepEqual(dots.map((d) => d.allocations[0].y1), [0, 0, 0]);
});

test("dot box: overflow wraps to the second row and stops at max rows", () => {
    const dots = allocateDots(12, 100); // 10 per row, default max 2 rows
    const rows = new Set(dots.filter((d) => d.allocations.length)
        .map((d) => d.allocations[0].y1));
    assert.deepEqual([...rows].sort((a, b) => a - b), [0, 10]);
    // 12 dots, 10 per row, 2 rows: all 12 allocated, 2 on the second row
    const secondRow = dots.filter((d) => d.allocations.length && d.allocations[0].y1 === 10);
    assert.equal(secondRow.length, 2);
});

test("dot box: theme max-rows caps the allocated rows", () => {
    const dots = allocateDots(25, 100, 1); // only one row allowed
    const allocated = dots.filter((d) => d.allocations.length);
    assert.equal(allocated.length, 10);
    assert.ok(allocated.every((d) => d.allocations[0].y1 === 0));
});

test("dot box: empty box allocates nothing and does not throw", () => {
    const dots = allocateDots(0, 100);
    assert.equal(dots.length, 0);
});

test("settings churn rebuilds the header only when week geometry changes", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);
    const headerBefore = cal._monthLabel;

    cal._onSettingsChange(null, "unrelated-key", 0, 1);
    assert.equal(cal._monthLabel, headerBefore, "same geometry: header actors kept");

    cal.show_week_numbers = !cal.show_week_numbers;
    cal._onSettingsChange(null, "show-week-numbers", false, true);
    assert.notEqual(cal._monthLabel, headerBefore, "geometry change rebuilds header");
});

test("Calendar.destroy disconnects its events-manager signals", () => {
    const manager = makeEventsManager();
    const cal = new CalendarModule.Calendar(makeSettings(), manager, null, makeDesktopSettings());
    cal.destroy();
    assert.deepEqual(manager.disconnected, [1, 2, 3]);
});

// T29a: day cells are cached and reused across updates

test("day cells: month navigation reuses the same actors", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);
    const before = dayButtons(cal);
    assert.equal(before.length, 42);

    cal.setDate(new Date(2026, 7, 9), true);
    const after = dayButtons(cal);

    assert.equal(after.length, 42);
    for (let i = 0; i < 42; i++) {
        assert.equal(after[i], before[i], `cell ${i} must be the same actor`);
        assert.ok(!after[i].destroyed);
    }
    // labels moved to the new month: August 2026 starts on a Saturday
    assert.equal(after[6].label, "1");
});

test("day cells: a reused button clicks through to its current date", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);
    const button = dayButtons(cal)[6]; // July grid: 2026-07-04

    cal.setDate(new Date(2026, 7, 9), true); // August grid: same slot is 08-01
    button.fire("clicked");

    assert.equal(cal.getSelectedDate().getMonth(), 7);
    assert.equal(cal.getSelectedDate().getDate(), 1);
});

test("day cells: holiday annotations do not leak into the next month", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": ["Bastille Day", []] } });
    const cal = makeCalendar({ holiday });
    cal.setDate(new Date(2026, 6, 14), true);
    const day14 = dayButtons(cal).find((b) => b.label === "14" &&
        b.style_class.includes("calendar-nonwork-day"));
    assert.ok(day14);
    assert.ok(day14.pseudo.has("selected"));

    cal.setDate(new Date(2026, 7, 9), true);
    // same actor now shows an August date (a Tuesday): style fully reset
    assert.equal(day14.label, "11");
    assert.ok(!day14.style_class.includes("calendar-nonwork-day"));
    assert.ok(!day14.pseudo.has("selected"));
    // and its tooltip was cleared
    const cell = cal._gridView.dayCells.find((c) => c.button === day14);
    assert.equal(cell.holidayTooltip.texts.at(-1), "");
});

test("day cells: geometry change rebuilds the grid with week-number labels", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);
    const before = dayButtons(cal);
    assert.equal(cal._gridView.weekLabels.length, 0);

    cal.show_week_numbers = true;
    cal._onSettingsChange(null, "show-week-numbers", false, true);

    const after = dayButtons(cal);
    assert.equal(after.length, 42);
    assert.ok(!after.includes(before[0]), "geometry change makes fresh cells");
    assert.equal(cal._gridView.weekLabels.length, 6);
    assert.ok(cal._gridView.weekLabels.every((l) => l.text.length > 0));
    // the cell is a bare number, and the only thing that says what it counts is
    // the column header — an actor a screen reader on this cell never visits
    assert.ok(cal._gridView.weekLabels.every((l) => /^Week \d+$/.test(l.accessible_name || "")),
        "each week cell names what its number counts");
    // day cells shift one column right of the week-number gutter
    const placed = placedGrid(cal);
    assert.ok(placed.every((c) => c.col >= 1));
});

// T29c: full rebuilds stay limited to grid-geometry changes
test("day cells: refreshes and month navigation do not rebuild the grid", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);
    const before = dayButtons(cal);

    let rebuilds = 0;
    const buildHeader = cal._buildHeader.bind(cal);
    cal._buildHeader = function() {
        rebuilds++;
        return buildHeader();
    };

    cal._update(); // same-month refresh, e.g. events-updated
    cal.setDate(new Date(2026, 7, 9), true); // month navigation
    cal.weekend_length = 1;
    cal._onSettingsChange(null, "weekend-length", 2, 1); // style-only setting

    assert.equal(rebuilds, 0);
    const after = dayButtons(cal);
    assert.equal(after.length, 42);
    for (let i = 0; i < 42; i++) {
        assert.equal(after[i], before[i], `cell ${i} must survive incremental refreshes`);
    }

    cal.show_week_numbers = true;
    cal._onSettingsChange(null, "show-week-numbers", false, true);
    assert.equal(rebuilds, 1, "week-number geometry still rebuilds the grid");
});

// T68 regression: a weekend-length change must restyle the weekday headings
// even though it no longer rebuilds the header
test("weekend-length change restyles the weekday headings without a rebuild", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);

    assert.equal(cal._gridView.dayHeadings.length, 7);
    const before = cal._gridView.dayHeadings.map((h) => h.label);
    const nonwork = () => cal._gridView.dayHeadings
        .filter((h) => h.label.style_class.includes("calendar-nonwork-day"))
        .map((h) => h.date.getDay())
        .sort();
    assert.equal(nonwork().length, 2, "two weekend headings with the default length");

    let rebuilds = 0;
    const buildHeader = cal._buildHeader.bind(cal);
    cal._buildHeader = function() {
        rebuilds++;
        return buildHeader();
    };

    cal.weekend_length = 1;
    cal._onSettingsChange(null, "weekend-length", 2, 1);

    assert.equal(rebuilds, 0, "weekend length is style-only, no rebuild");
    assert.equal(nonwork().length, 1, "one weekend heading after the change");
    cal._gridView.dayHeadings.forEach((heading, i) => {
        assert.equal(heading.label, before[i], "heading actors are reused");
        const expected = CalendarModule._isWorkDay(heading.date, 1) ?
            "calendar-work-day" : "calendar-nonwork-day";
        assert.ok(heading.label.style_class.includes(expected),
            `heading for day ${heading.date.getDay()} restyled`);
    });

    // headings and day cells must agree on which days are the weekend
    const headingNonwork = new Set(nonwork());
    cal._gridView.dayCells.forEach((cell) => {
        assert.equal(cell.button.style_class.includes("calendar-nonwork-day") &&
            !cell.holiday_styled,
        headingNonwork.has(cell.date.getDay()),
        `cell ${cell.date} agrees with its heading`);
    });
});

test("weekday headings stay unique across a daylight-saving fallback", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/New_York";

    try {
        const cal = makeCalendar();
        // New York repeats an hour on Sunday, 1 November 2026. Walking from
        // midnight in fixed 24-hour steps lands at 23:00 on Sunday again and
        // duplicates its heading; the production noon anchor avoids the fold.
        cal._selectedDate = new Date(2026, 10, 1, 0, 30);
        cal._buildHeader();

        assert.deepEqual(cal._gridView.dayHeadings.map((heading) => heading.date.getDay()),
            [0, 1, 2, 3, 4, 5, 6],
            "every weekday appears once through the repeated-hour transition");
    } finally {
        if (previousTimezone === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = previousTimezone;
        }
    }
});

// T69 regression: the week-number gutter keeps a wired header cell that
// receives the digit-based width (it must never dangle unassigned again)
test("week-number gutter gets a header cell sized by digit width", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);
    assert.equal(cal._weekdateHeader, null, "no gutter header without week numbers");

    cal.show_week_numbers = true;
    cal._onSettingsChange(null, "show-week-numbers", false, true);

    assert.ok(cal._weekdateHeader, "gutter header exists with week numbers");
    const placement = cal.actor.placements.find((p) => p.child === cal._weekdateHeader);
    assert.equal(placement.opts.row, 1);
    assert.equal(placement.opts.col, 0);

    cal.actor.get_pango_context = () => ({
        get_language: () => "en",
        get_metrics: () => ({ get_approximate_digit_width: () => 30 })
    });
    cal.actor.get_theme_node = () => ({ get_font: () => "font" });
    global.imports.gi.Pango.SCALE = 10;
    cal._onStyleChange();
    assert.equal(cal._weekdateHeader.width, 9, "3 digits at 3px each");

    cal.show_week_numbers = false;
    cal._onSettingsChange(null, "show-week-numbers", true, false);
    assert.equal(cal._weekdateHeader, null, "gutter header cleared on rebuild");
});

// seeded fuzz: random navigation keeps the cached grid consistent
test("fuzz: cached grid stays consistent across random navigation", () => {
    const rand = makeRandom(20260709);
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);
    const original = dayButtons(cal);

    for (let i = 0; i < 250; i++) {
        const date = new Date(2000 + Math.floor(rand() * 50),
            Math.floor(rand() * 12), 1 + Math.floor(rand() * 28), 12, 0, 0);
        cal.setDate(date, rand() < 0.2);

        const buttons = dayButtons(cal);
        assert.equal(buttons.length, 42);
        for (let j = 0; j < 42; j++) {
            assert.equal(buttons[j], original[j], `iteration ${i}: cell ${j} reused`);
        }

        // recompute the expected grid start independently
        const begin = new Date(date);
        begin.setDate(1);
        begin.setHours(12);
        begin.setTime(begin.getTime() - ((7 + begin.getDay() - 0) % 7) * 86400000);
        for (let j = 0; j < 42; j += 5) {
            const expected = new Date(begin.getTime() + j * 86400000);
            assert.equal(buttons[j].label, String(expected.getDate()),
                `iteration ${i}: cell ${j} shows the right day`);
        }

        const selected = buttons.filter((b) => b.pseudo.has("selected"));
        assert.equal(selected.length, 1, `iteration ${i}: exactly one selected`);
        assert.equal(selected[0].label, String(date.getDate()));
    }
});

// T29b: in-place mutation skips writes when the rendered value is unchanged

function countWrites(obj, prop) {
    let value = obj[prop];
    let count = 0;
    Object.defineProperty(obj, prop, {
        configurable: true,
        get: () => value,
        set: (v) => { value = v; count++; }
    });
    return () => count;
}

test("in place: a same-month refresh writes nothing when nothing changed", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);

    const buttons = dayButtons(cal);
    const labelCounts = buttons.map((b) => countWrites(b, "label"));
    const styleCounts = buttons.map((b) => countWrites(b, "style_class"));
    const pseudoBefore = buttons.map((b) => [...b.pseudo].join(","));

    cal._update(); // e.g. an events-updated signal for the same month

    assert.equal(labelCounts.reduce((s, c) => s + c(), 0), 0, "no label writes");
    assert.equal(styleCounts.reduce((s, c) => s + c(), 0), 0, "no style writes");
    buttons.forEach((b, i) => assert.equal([...b.pseudo].join(","), pseudoBefore[i]));
});

test("grid dot rendering uses precomputed unix keys", () => {
    const manager = makeEventsManager();
    let legacyDateLookups = 0;
    const unixKeys = [];
    manager.get_colors_for_date = () => {
        legacyDateLookups++;
        return null;
    };
    manager.get_colors_for_unix_key = (key) => {
        unixKeys.push(key);
        return null;
    };
    const cal = new CalendarModule.Calendar(makeSettings(), manager, null, makeDesktopSettings());
    cal.setDate(new Date(2026, 6, 9), true);

    const expected = new CalendarModule.CalendarMonthWindow(
        new Date(2026, 6, 9), cal._weekStart).dateUnixKeys;
    assert.equal(legacyDateLookups, 0);
    assert.deepEqual(unixKeys, expected);
});

function makeColorCalendar() {
    const manager = makeEventsManager();
    const colorsByDay = new Map();
    manager.get_colors_for_unix_key = (key) => {
        const d = new Date(key * 1000);
        return colorsByDay.get(`${d.getMonth()}/${d.getDate()}`) || null;
    };
    const cal = new CalendarModule.Calendar(makeSettings(), manager, null, makeDesktopSettings());
    return { cal, colorsByDay };
}

function cellForDay(cal, month, day) {
    return cal._gridView.dayCells.find((c) =>
        c.date.getMonth() === month && c.date.getDate() === day);
}

test("in place: dot actors are reused and restyled when colors change", () => {
    const { cal, colorsByDay } = makeColorCalendar();
    colorsByDay.set("6/9", ["#111111", "#222222"]);
    cal.setDate(new Date(2026, 6, 9), true);

    const cell = cellForDay(cal, 6, 9);
    assert.equal(cell.dot_box.children.length, 2);
    const firstDot = cell.dot_box.children[0];
    const secondDot = cell.dot_box.children[1];

    // shrink: first actor survives with a new style, the second dies
    colorsByDay.set("6/9", ["#333333"]);
    cal._update();
    assert.equal(cell.dot_box.children.length, 1);
    assert.equal(cell.dot_box.children[0], firstDot);
    assert.equal(firstDot.style, "background-color: #333333;");
    assert.ok(secondDot.destroyed);

    // grow: the survivor is kept, extras are appended
    colorsByDay.set("6/9", ["#333333", "#444444", "#555555"]);
    cal._update();
    assert.equal(cell.dot_box.children.length, 3);
    assert.equal(cell.dot_box.children[0], firstDot);
    assert.equal(cell.dot_box.children[2].options.style, "background-color: #555555;");
});

test("in place: unchanged colors leave the dot actors untouched", () => {
    const { cal, colorsByDay } = makeColorCalendar();
    colorsByDay.set("6/9", ["#111111"]);
    cal.setDate(new Date(2026, 6, 9), true);

    const cell = cellForDay(cal, 6, 9);
    const dot = cell.dot_box.children[0];
    const styleCount = countWrites(dot, "style");

    cal._update();
    assert.equal(cell.dot_box.children[0], dot);
    assert.equal(styleCount(), 0);
    assert.ok(!dot.destroyed);
});

test("in place: selecting another day moves only the selected pseudo class", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);
    const day9 = dayButtons(cal).find((b) => b.pseudo.has("selected"));

    cal.setDate(new Date(2026, 6, 10), false);
    assert.ok(!day9.pseudo.has("selected"));
    const selected = dayButtons(cal).filter((b) => b.pseudo.has("selected"));
    assert.equal(selected.length, 1);
    assert.equal(selected[0].label, "10");
});

test("in place: a holiday cell never accumulates duplicate style classes", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": ["Bastille Day", []] } });
    const cal = makeCalendar({ holiday });
    cal.setDate(new Date(2026, 6, 9), true);
    cal._update();
    cal._update();

    const day14 = cal._gridView.dayCells.find((c) => c.date.getMonth() === 6 &&
        c.date.getDate() === 14).button;
    const classes = day14.style_class.split(" ");
    assert.equal(classes.filter((c) => c === "calendar-nonwork-day").length, 1);
    assert.ok(!classes.includes("calendar-work-day"));
});

// seeded fuzz: dots always mirror the current color source, writes stay
// suppressed on stable passes
function mutateDayColors(rand, colorsByDay, palette) {
    const day = 1 + Math.floor(rand() * 28);
    if (rand() < 0.3) {
        colorsByDay.delete(`6/${day}`);
    } else {
        const count = 1 + Math.floor(rand() * 4);
        colorsByDay.set(`6/${day}`,
            Array.from({ length: count }, () => palette[Math.floor(rand() * palette.length)]));
    }
    return day;
}

function assertRenderedDots(cal, colorsByDay, iteration) {
    for (const [key, colors] of colorsByDay) {
        const [month, day] = key.split("/").map(Number);
        const cell = cellForDay(cal, month, day);
        if (!cell) {
            continue;
        }
        assert.equal(cell.dot_box.children.length, colors.length,
            `iteration ${iteration}: day ${day} dot count`);
        cell.dot_box.children.forEach((dot, index) => {
            const rendered = dot.style || dot.options.style;
            const safe = colors[index] === "bad;value" ? "transparent" : colors[index];
            assert.equal(rendered, `background-color: ${safe};`);
        });
    }
}

function assertStableDay(cal, day, iteration) {
    const probe = cellForDay(cal, 6, day);
    const labelCount = countWrites(probe.button, "label");
    const dotIdentity = probe.dot_box.children.slice();
    cal._update();
    assert.equal(labelCount(), 0, `iteration ${iteration}: stable pass writes label`);
    assert.deepEqual(probe.dot_box.children, dotIdentity);
}

test("fuzz: in-place dot updates always match the color source", () => {
    const rand = makeRandom(97531);
    const { cal, colorsByDay } = makeColorCalendar();
    cal.setDate(new Date(2026, 6, 9), true);
    const palette = ["#101010", "#202020", "red", "rgb(1,2,3)", "bad;value"];

    for (let i = 0; i < 200; i++) {
        const day = mutateDayColors(rand, colorsByDay, palette);
        cal._update();
        assertRenderedDots(cal, colorsByDay, i);
        assertStableDay(cal, day, i);
    }
});

test("an inactive provider is never queried", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": ["X", []] } });
    holiday.active = false;
    const cal = makeCalendar({ holiday });
    cal.setDate(new Date(2026, 6, 9), true);
    assert.equal(holiday.calls.length, 0, "holidays disabled: no fetches");
});

test("queued calendar updates and reloads run exactly once", () => {
    const removed = [];
    const callbacks = [];
    global.imports.mainloop.source_remove = (id) => removed.push(id);
    global.imports.mainloop.idle_add = (cb) => {
        callbacks.push(cb);
        return callbacks.length;
    };
    global.imports.mainloop.timeout_add = (delay, cb) => {
        callbacks.push(cb);
        return callbacks.length + 10;
    };

    const cal = makeCalendar();
    let updates = 0;
    cal._update = () => updates++;

    cal._events_updated();
    assert.equal(cal._update_id, 1);
    cal._events_updated();
    assert.deepEqual(removed, [1], "second queue cancels pending update");
    assert.equal(callbacks.at(-1)(), false);
    assert.equal(updates, 1);
    assert.equal(cal._update_id, 0);

    const queuedDate = new Date(2026, 10, 5);
    let setDateArgs = null;
    cal.setDate = (...args) => { setDateArgs = args; };
    cal.queue_set_date(queuedDate);
    cal.queue_set_date(new Date(2026, 10, 6));
    assert.equal(cal._navigation.setDateIdleId, 13);
    assert.equal(callbacks.at(-1)(), false);
    assert.equal(setDateArgs[0].getDate(), 6);
    assert.equal(setDateArgs[1], false);
});

test("calendar wrappers cover scroll, style, holiday refresh, and selected-date helpers", () => {
    const cal = makeCalendar();
    const actions = [];
    cal._applyDateBrowseAction = (year, month) => actions.push([year, month]);
    cal._onPrevYearButtonClicked();
    cal._onNextYearButtonClicked();
    cal._onPrevMonthButtonClicked();
    cal._onNextMonthButtonClicked();
    assert.deepEqual(actions, [[-1, 0], [1, 0], [0, -1], [0, 1]]);

    const directions = global.imports.gi.Clutter.ScrollDirection;
    for (const [direction, expected] of [
        [directions.UP, [0, -1]],
        [directions.LEFT, [0, -1]],
        [directions.DOWN, [0, 1]],
        [directions.RIGHT, [0, 1]]
    ]) {
        actions.length = 0;
        cal._onScroll(null, { get_scroll_direction: () => direction });
        assert.deepEqual(actions, [expected]);
    }

    let queued = 0;
    cal._queue_update = () => queued++;
    cal.refreshHolidays();
    cal.refreshToday();
    cal._update_events_enabled();
    assert.equal(queued, 3);
    assert.equal(cal.events_enabled, true);

    cal._selectedDate = new Date();
    assert.equal(cal.getSelectedDate(), cal._selectedDate);
    assert.equal(cal.todaySelected(), true);

    const widthCalls = [];
    cal.show_week_numbers = true;
    cal._weekdateHeader = { set_width: (width) => widthCalls.push(width) };
    cal.actor.get_pango_context = () => ({
        get_language: () => "en",
        get_metrics: () => ({ get_approximate_digit_width: () => 20 })
    });
    cal.actor.get_theme_node = () => ({ get_font: () => "font" });
    global.imports.gi.Pango.SCALE = 10;
    cal._onStyleChange();
    assert.deepEqual(widthCalls, [6]);
});

// The test above calls the four handlers directly, which says nothing about the
// buttons: _buildHeader wires them with connect('clicked', …), and renaming that
// signal left the whole suite green. Every other signal in the applet — the day
// cells, the country combo, the scroll — is tested through the emit. These are
// the four buttons the calendar is navigated with; nothing else was watching the
// wiring at all.
test("the month and year nav buttons reach their handlers through the clicked signal", () => {
    const cal = makeCalendar();
    const actions = [];
    cal._applyDateBrowseAction = (year, month) => actions.push([year, month]);

    const navButton = (box, styleClass) => {
        const button = box.children.find((child) => child.style_class === styleClass);
        assert.ok(button, `no ${styleClass} button in the header`);
        return button;
    };

    navButton(cal._topBoxMonth, "calendar-change-month-back").fire("clicked");
    navButton(cal._topBoxMonth, "calendar-change-month-forward").fire("clicked");
    navButton(cal._topBoxYear, "calendar-change-month-back").fire("clicked");
    navButton(cal._topBoxYear, "calendar-change-month-forward").fire("clicked");

    assert.deepEqual(actions, [[0, -1], [0, 1], [-1, 0], [1, 0]],
        "previous month, next month, previous year, next year");
});

// The week-number column reserves its width from the theme's digit width, and the
// only thing that recomputes it is the style-changed signal — so a theme switch
// that changes the font leaves the column at the old font's width. The suite used
// to call _onStyleChange() directly and match `.connect('style-changed'` in the
// source, which says the line exists, not that the signal reaches it: renaming the
// signal left every test green.
test("a theme change reaches the calendar through the style-changed signal", () => {
    const cal = makeCalendar();
    const widths = [];
    cal.show_week_numbers = true;
    cal._weekdateHeader = { set_width: (width) => widths.push(width) };
    cal.actor.get_pango_context = () => ({
        get_language: () => "en",
        get_metrics: () => ({ get_approximate_digit_width: () => 30 })
    });
    cal.actor.get_theme_node = () => ({ get_font: () => "font" });
    global.imports.gi.Pango.SCALE = 10;

    cal.actor.fire("style-changed");

    assert.deepEqual(widths, [9], "3 digits at 30/10 units each");
    assert.equal((cal.actor.handlers["style-changed"] || []).length, 1,
        "and it is connected once: a second handler is a second relayout per theme change");
});

// SMOOTH is what a touchpad sends — and it was the one ScrollDirection value the
// test double left out, so the one device most users scroll with was the one the
// suite could not express. The switch had no case for it either: scrolling the
// month grid on a laptop did nothing at all.
test("a touchpad's smooth scroll walks the months, a notch at a time", () => {
    const cal = makeCalendar();
    const actions = [];
    cal._applyDateBrowseAction = (year, month) => actions.push([year, month]);

    const SMOOTH = global.imports.gi.Clutter.ScrollDirection.SMOOTH;
    const scroll = (dx, dy) => cal._onScroll(null, {
        get_scroll_direction: () => SMOOTH,
        get_scroll_delta: () => [dx, dy]
    });

    // a touchpad reports fractions of a notch per frame: four of these are one
    // month, not four months
    scroll(0, 0.3);
    scroll(0, 0.3);
    scroll(0, 0.3);
    assert.deepEqual(actions, [], "a nudge is not a month");
    scroll(0, 0.3);
    assert.deepEqual(actions, [[0, 1]], "and the notch that completes it is");

    // the other way, and the leftover from the scroll down does not carry into it
    actions.length = 0;
    scroll(0, -0.5);
    assert.deepEqual(actions, [], "the accumulator resets when the direction does");
    scroll(0, -0.5);
    assert.deepEqual(actions, [[0, -1]]);

    // a flick: several notches in one event are coalesced into one browse
    actions.length = 0;
    scroll(0, 3);
    assert.deepEqual(actions, [[0, 3]]);

    // a horizontal touchpad scroll walks the months too, and a 0 delta is not a
    // scroll at all — Clutter sends those to end a gesture
    actions.length = 0;
    scroll(-1, 0);
    scroll(0, 0);
    assert.deepEqual(actions, [[0, -1]]);

    // Driver glitches cannot multiply into an unbounded number of synchronous
    // compositor-thread calls, and non-finite deltas are ignored.
    for (const delta of [100000, -100000, Number.MAX_VALUE, -Number.MAX_VALUE]) {
        actions.length = 0;
        scroll(0, delta);
        assert.equal(actions.length, 1);
        assert.ok(Math.abs(actions[0][1]) <= 12);
    }
    actions.length = 0;
    for (const delta of [0, NaN, Infinity, -Infinity]) {
        scroll(delta, delta);
    }
    assert.deepEqual(actions, []);

    const rand = makeRandom(0x5c7011);
    for (let i = 0; i < 200; i++) {
        actions.length = 0;
        const delta = (rand() - 0.5) * Number.MAX_SAFE_INTEGER;
        scroll(0, delta);
        assert.ok(actions.length <= 1);
        assert.ok(actions.length === 0 || Math.abs(actions[0][1]) <= 12);
    }
});

test("fuzz: navigation wrappers preserve valid queued dates", () => {
    const rand = makeRandom(24680);
    const cal = makeCalendar();
    for (let i = 0; i < 160; i++) {
        const source = new Date(2000 + Math.floor(rand() * 40),
            Math.floor(rand() * 12), 1 + Math.floor(rand() * 28));
        cal._selectedDate = source;
        let queued = null;
        cal.queue_set_date = (date) => { queued = date; };
        const op = Math.floor(rand() * 4);
        [cal._onPrevYearButtonClicked, cal._onNextYearButtonClicked,
            cal._onPrevMonthButtonClicked, cal._onNextMonthButtonClicked][op].call(cal);
        assert.ok(queued instanceof Date);
        assert.ok(queued.getDate() >= 1 && queued.getDate() <= 31);
    }
});

// Left and Right are directions on the screen, not in time. St mirrors the grid
// in an RTL locale, so the cell to the left of Tuesday is Wednesday — and the
// arrows were walking the selection the wrong way for every Arabic and Hebrew
// user. Cinnamon's own popupMenu.js asks the same question of the same actor.
test("the arrow keys follow the grid, not the calendar, in an RTL locale", () => {
    const cal = makeCalendar();
    const St = global.imports.gi.St;
    cal.setDate(new Date(2026, 6, 9), true);
    cal.actor.get_direction = () => St.TextDirection.RTL;

    const focusFirstCell = () => {
        const cell = dayButtons(cal).find((b) => b.label === "9");
        global.stage = { get_key_focus: () => cell };
    };

    focusFirstCell();
    cal.actor.fire("key-press-event", { get_key_symbol: () => 65361 }); // Left
    assert.equal(cal.getSelectedDate().getDate(), 10,
        "in a mirrored grid, Left is the next day");

    focusFirstCell();
    cal.actor.fire("key-press-event", { get_key_symbol: () => 65363 }); // Right
    assert.equal(cal.getSelectedDate().getDate(), 9, "and Right is the previous one");

    // up and down are not mirrored: a week is a week
    focusFirstCell();
    cal.actor.fire("key-press-event", { get_key_symbol: () => 65364 }); // Down
    assert.equal(cal.getSelectedDate().getDate(), 16);

    // ...and an LTR grid is unchanged
    cal.actor.get_direction = () => St.TextDirection.LTR;
    cal.setDate(new Date(2026, 6, 9), true);
    focusFirstCell();
    cal.actor.fire("key-press-event", { get_key_symbol: () => 65361 });
    assert.equal(cal.getSelectedDate().getDate(), 8);

    global.stage = undefined;
});

// queue_set_date holds the new date for 25 ms so a burst of scroll notches costs
// one grid rebuild. The browse action read the *committed* date, which the queued
// setDate has not written yet — so every notch in the burst recomputed from the
// same starting month and overwrote the last. Three notches in 30 ms moved the
// calendar one month, and a held PageDown did the same.
test("a burst of month changes accumulates instead of overwriting itself", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 0, 15), true);

    // three scroll notches inside the coalescing window: the idle has not run
    cal._onNextMonthButtonClicked();
    cal._onNextMonthButtonClicked();
    cal._onNextMonthButtonClicked();

    assert.equal(cal._navigation.queuedDate.getMonth(), 3, "three notches are three months");
    assert.equal(cal._navigation.queuedDate.getFullYear(), 2026);

    // the coalesced date lands once
    cal._navigation.flushQueuedDate();
    assert.equal(cal.getSelectedDate().getMonth(), 3);

    // ...and it still rolls the year correctly across December
    cal.setDate(new Date(2026, 10, 15), true);
    cal._onNextMonthButtonClicked();
    cal._onNextMonthButtonClicked();
    cal._onNextMonthButtonClicked();
    assert.equal(cal._navigation.queuedDate.getFullYear(), 2027);
    assert.equal(cal._navigation.queuedDate.getMonth(), 1);

    // and back the other way
    cal._navigation.flushQueuedDate();
    cal._onPrevMonthButtonClicked();
    cal._onPrevMonthButtonClicked();
    assert.equal(cal._navigation.queuedDate.getFullYear(), 2026);
    assert.equal(cal._navigation.queuedDate.getMonth(), 11);
});

test("a direct selection cancels a pending month browse", () => {
    const removed = [];
    global.imports.mainloop.source_remove = (id) => removed.push(id);
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 0, 15), true);

    cal._navigation.focusAfterSetDate = true;
    cal._onNextMonthButtonClicked();
    const pendingId = cal._navigation.setDateIdleId;
    const direct = new Date(2026, 0, 20);
    cal.setDate(direct, false);

    assert.deepEqual(removed, [pendingId]);
    assert.equal(cal._navigation.queuedDate, null);
    assert.equal(cal._navigation.setDateIdleId, 0);
    assert.equal(cal._navigation.focusAfterSetDate, false);
    assert.equal(cal.getSelectedDate().getTime(), direct.getTime());

    cal._navigation.flushQueuedDate();
    assert.equal(cal.getSelectedDate().getTime(), direct.getTime(),
        "a canceled idle cannot restore the stale month");
});

// Cinnamon's Tooltip.set_text() has no equality guard — it calls
// allocate_preferred_size() and queue_relayout() unconditionally — so writing
// byte-identical text still forces a relayout. The month tooltip is cleared on
// every _update() and re-set by annotate(), and every holiday cell's tooltip is
// cleared and re-set on every pass, so an unchanged month paid a pile of forced
// relayouts for text that had not changed. The grid already diffs its styles, its
// dots and its accessible names; the tooltips were the ones that were missed.
test("a tooltip is not rewritten with the text it already has", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": ["Bastille Day", []] } });
    const cal = makeCalendar({ holiday });
    cal.setDate(new Date(2026, 6, 9), true);

    const day14 = cal._gridView.dayCells.find((cell) => cell.button.label === "14");
    assert.equal(day14.holidayTooltip.texts.at(-1), "Bastille Day");
    const cellWrites = day14.holidayTooltip.texts.length;
    const monthWrites = cal._holidayAnnotator.monthLabel.tooltip.texts.length;

    // the same month, redrawn: nothing about it has changed
    cal._update();
    cal._update();

    assert.equal(day14.holidayTooltip.texts.length, cellWrites,
        "the holiday's name is written once, not once per update");
    assert.equal(cal._holidayAnnotator.monthLabel.tooltip.texts.length, monthWrites,
        "and neither is the month's status");

    // ...and a real change still lands
    cal._holidayAnnotator.setStatus("Holiday service unavailable", "Enrico");
    assert.match(cal._holidayAnnotator.monthLabel.tooltip.texts.at(-1),
        /Holiday service unavailable/);
});

// Switching holidays off leaves the marks of a country the user is no longer
// asking about: the cells keep their dates, so nothing in the grid pass clears
// them, and the annotator used to return early without touching them.
test("switching holidays off clears the marks they left", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": ["Bastille Day", []] } });
    const cal = makeCalendar({ holiday });
    cal.setDate(new Date(2026, 6, 9), true);

    const day14 = cal._gridView.dayCells.find((cell) => cell.button.label === "14");
    assert.equal(day14.holiday_name, "Bastille Day");
    assert.ok(day14.button.style_class.includes("calendar-holiday-day"));
    assert.match(day14.button.accessible_name, /Bastille Day/);

    // the user picks "None (disable holidays)"
    holiday.active = false;
    cal.refreshHolidays();
    cal._update();

    assert.equal(day14.holiday_name, "", "the name goes");
    assert.equal(day14.holidayTooltip.texts.at(-1), "", "and so does the tooltip");
    assert.equal(day14.holiday_tooltip_set, false);
    assert.doesNotMatch(day14.button.accessible_name, /Bastille Day/,
        "and the cell stops announcing a holiday the user turned off");
    assert.equal(cal._holidayReasonLabel.visible, false);
});

// Country, region and religion changes all keep the provider active and repaint
// through the same contract. The new pass must replace that contract's complete
// result, not merely overlay it onto the previous configuration's cells.
test("an active holiday configuration replaces its old annotations", () => {
    const datesByMonth = { "2026/7": { "7/14": ["Bastille Day", []] } };
    const holiday = makeHolidayStub(datesByMonth);
    const cal = makeCalendar({ holiday });
    cal.setDate(new Date(2026, 6, 9), true);

    const day14 = cal._gridView.dayCells.find((cell) => cell.button.label === "14");
    const day15 = cal._gridView.dayCells.find((cell) => cell.button.label === "15");
    assert.equal(day14.holiday_name, "Bastille Day");

    datesByMonth["2026/7"] = {
        "7/15": ["Replacement observance", ["religious_holiday"]]
    };
    cal._update();

    assert.equal(day14.holiday_name, "");
    assert.equal(day14.holidayTooltip.texts.at(-1), "");
    assert.equal(day14.holiday_tooltip_set, false);
    assert.doesNotMatch(day14.button.accessible_name, /Bastille Day/);
    assert.equal(day15.holiday_name, "Replacement observance");
    assert.match(day15.button.accessible_name, /Replacement observance/);
});

test("holiday reconciliation waits for every displayed month", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": ["Bastille Day", []] } });
    const cal = makeCalendar({ holiday });
    cal.setDate(new Date(2026, 6, 9), true);

    const day14 = cal._gridView.dayCells.find((cell) => cell.button.label === "14");
    const day15 = cal._gridView.dayCells.find((cell) => cell.button.label === "15");
    const pending = new Map();
    holiday.getHolidays = (y, m, callback) => pending.set(`${y}/${m}`, callback);
    cal._update();

    pending.get("2026/7")(new Map([
        ["7/15", ["Replacement observance", ["religious_holiday"]]]
    ]), "", "stub-provider");
    const siblings = Array.from(pending.entries())
        .filter(([month]) => month !== "2026/7");
    siblings[0][1](new Map(), "", "stub-provider");

    assert.equal(day14.holiday_name, "Bastille Day",
        "a partial pass cannot erase the old complete result");
    assert.equal(day15.holiday_name || "", "",
        "nor expose a partial replacement");

    siblings[1][1](new Map(), "", "stub-provider");
    assert.equal(day14.holiday_name, "");
    assert.equal(day15.holiday_name, "Replacement observance");
});

// All 42 day cells were can_focus, so the grid was 42 tab stops. From the cell the
// menu focuses on open, a keyboard user pressed Tab up to 42 times to reach the
// world clocks or "Date and Time Settings" — and there was no way out of the grid
// at all. A date grid is one composite widget: one tab stop, with the arrows
// moving inside it, which is what the arrow-key navigation is there for.
test("the grid is one tab stop, and it moves with the selection", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);

    const focusable = () => cal._gridView.dayCells.filter((cell) => cell.button.can_focus);

    assert.equal(focusable().length, 1, "one tab stop, not forty-two");
    assert.equal(focusable()[0].button.label, "9", "and it is the selected day");

    // the selection moves: so does the tab stop
    cal.setDate(new Date(2026, 6, 14), false);

    assert.equal(focusable().length, 1);
    assert.equal(focusable()[0].button.label, "14");

    // ...and the cell the menu focuses on open can take the focus it is handed
    global.stage = { get_key_focus: () => null };
    assert.equal(cal.focusSelectedDay(), true);
    assert.equal(MockActor.focused.label, "14");
    global.stage = undefined;
});

// The handler is on the table, which is the ancestor of the month and year
// buttons too. Only the arrows checked whether a day cell had the focus:
// Page_Up, Page_Down and Home were taken unconditionally, so pressing PageDown
// while operating "Next year" changed the *month* and then yanked the focus off
// the button the user was on.
test("the paging keys are the grid's, not the navigation buttons'", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);

    const navButton = cal.actor.get_children()
        .flatMap((child) => (child.children || []))
        .find((child) => child.accessible_name === "Next year");
    assert.ok(navButton, "the year button exists");
    global.stage = { get_key_focus: () => navButton };

    for (const symbol of [65365, 65366, 65360]) { // Page_Up, Page_Down, Home
        const result = cal.actor.fire("key-press-event", { get_key_symbol: () => symbol });
        void result;
    }

    assert.equal(cal.getSelectedDate().getMonth(), 6,
        "the month does not move while the user is operating a button");
    assert.equal(cal._navigation.queuedDate, null);

    // ...and from a day cell they still work
    const day = dayButtons(cal).find((b) => b.label === "9");
    global.stage = { get_key_focus: () => day };
    cal.actor.fire("key-press-event", { get_key_symbol: () => 65366 });
    assert.equal(cal._navigation.queuedDate.getMonth(), 7, "PageDown from the grid is next month");

    global.stage = undefined;
});

// _update() runs on every menu open, settings change and event delivery. The
// month name beside it is memoised; the year was not — a fresh GLib.DateTime and
// a strftime every pass, for a value that changes once a year.
test("the year label is not reformatted on every update", () => {
    const cal = makeCalendar();
    cal.setDate(new Date(2026, 6, 9), true);

    const writes = [];
    const label = cal._yearLabel;
    let text = label.text;
    Object.defineProperty(label, "text", {
        get: () => text,
        set: (value) => {
            writes.push(value);
            text = value;
        }
    });

    cal._update();
    cal._update();
    assert.deepEqual(writes, [], "the same year is not written again");

    cal.setDate(new Date(2027, 6, 9), false);
    assert.deepEqual(writes, ["2027"], "and a new one is");
});
