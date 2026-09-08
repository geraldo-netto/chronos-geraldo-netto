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
const DateMath = require(path.join(APPLET_DIR, "dateMath.js"));
function civilDate(...args) {
    return DateMath.localDateParts(new Date(...args));
}

global.log = () => {};
function makeFakeDateTimeFromDate(date) {
    return {
        get_year: () => date.getFullYear(),
        get_month: () => date.getMonth() + 1,
        get_day_of_month: () => date.getDate(),
        get_day_of_week: () => date.getDay() || 7,
        add_days(days) {
            const next = new Date(date);
            next.setDate(next.getDate() + days);
            return makeFakeDateTimeFromDate(next);
        },
        add_seconds: (seconds) => makeFakeDateTimeFromDate(new Date(date.getTime() + seconds * 1000)),
        to_unix: () => Math.trunc(date.getTime() / 1000),
        get_utc_offset: () => -date.getTimezoneOffset() * 60000000,
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
            get_language_names: () => ["C"],
            SOURCE_REMOVE: false,
            PRIORITY_DEFAULT: 0,
            timeout_add_seconds: () => 1,
            get_home_dir: () => "/home/x",
            get_user_cache_dir: () => "/tmp/cache",
            build_filenamev: (parts) => parts.join("/"),
            TimeType: { STANDARD: 0, DAYLIGHT: 1 },
            TimeZone: { new_local: () => ({ find_interval: () => -1 }) },
            DateTime: {
                new(timezone, ...args) { return this.new_local(...args); },
                new_utc(year, month, day, hour, minute, second) {
                    const date = new Date(0);
                    date.setFullYear(year, month - 1, day);
                    date.setHours(hour, minute, second, 0);
                    return makeFakeDateTimeFromDate(date);
                },
                new_from_unix_local: (unix) =>
                    makeFakeDateTimeFromDate(new Date(unix * 1000)),
                new_local(year, month, day, hour = 0, minute = 0, second = 0) {
                    return this.new_utc(year, month, day, hour, minute, second);
                }
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
            constructor(actor) {
                this.actor = actor;
                this.texts = [];
                this.shown = false;
                this.destroyed = false;
                Tooltips.live++;
            }
            set_text(text) { this.texts.push(text); }
            show() { this.shown = true; }
            hide() { this.shown = false; }
            // Cinnamon's TooltipBase.destroy() disconnects its seven signals
            // and Tooltip._destroy() drops the label it parked in uiGroup
            destroy() { this.destroyed = true; Tooltips.live--; }
        } },
        appletManager: { applets: { "chronos@geraldo-netto": {} } }
    }
};
const Tooltips = global.imports.ui.tooltips;
Tooltips.live = 0;
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].dateMath = DateMath;
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].civilTime =
    require(path.join(APPLET_DIR, "civilTime.js"));

global.imports.ui.appletManager.applets["chronos@geraldo-netto"].dateFormats =
    require(path.join(APPLET_DIR, "dateFormats.js"));
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].localeQuery =
    require(path.join(APPLET_DIR, "localeQuery.js"));
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].localeText =
    require(path.join(APPLET_DIR, "localeText.js"));
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils =
    require(path.join(APPLET_DIR, "textUtils.js"));
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].styleUtils =
    require(path.join(APPLET_DIR, "styleUtils.js"));
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].eventData =
    require(path.join(APPLET_DIR, "eventData.js"));
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].settingsFacade =
    require(path.join(APPLET_DIR, "settingsFacade.js"));
// the grid reads the error identifiers and nothing else out of the holiday
// feature, so it requires the constants, not the barrel that carries the HTTP
// stack behind them
// the real module, not a hand-written stub of it: it reaches for nothing, and a
// stub is a second definition of the flag vocabulary that drifts from the first
// (T806 - PART_DAY_HOLIDAY was missing from this one)
global.imports.ui.appletManager.applets["chronos@geraldo-netto"].holidayConstants =
    require(path.join(APPLET_DIR, "holidayConstants.js"));

const CalendarModule = require(path.join(APPLET_DIR, "6.0", "calendar.js"));
const AnnotationsModule = require(path.join(APPLET_DIR, "6.0", "calendarAnnotations.js"));
const NavigationModule = require(path.join(APPLET_DIR, "6.0", "calendarNavigation.js"));
const CalendarDateModule = require(path.join(APPLET_DIR, "6.0", "calendarDate.js"));

test("calendar date identity has one null-safe definition", () => {
    const date = civilDate(2026, 6, 9);

    assert.equal(CalendarDateModule.sameDay(date, ({...date})), true);
    assert.equal(CalendarDateModule.sameDay(null, date), false);
    assert.equal(CalendarDateModule.sameDay(date, null), false);
    assert.equal(CalendarDateModule.sameDay(date, civilDate(2026, 6, 10)), false);
    assert.equal(CalendarDateModule.sameDay(date, civilDate(2026, 7, 9)), false);
    assert.equal(CalendarDateModule.sameDay(date, civilDate(2027, 6, 9)), false);
    assert.equal(CalendarDateModule.isToday(date, ({...date})), true);
    assert.equal(NavigationModule.sameDay, CalendarDateModule.sameDay);
});

test("calendar date formatting owns the GLib boundary", () => {
    const date = civilDate(2026, 6, 9);
    assert.equal(CalendarDateModule.formatCivilDate(date, "%Y"), "2026");

    const newUtc = global.imports.gi.GLib.DateTime.new_utc;
    global.imports.gi.GLib.DateTime.new_utc = () => ({
        format: (format) => format === "bad" ? null : "fallback date"
    });
    assert.equal(CalendarDateModule.formatCivilDate(date, "bad", "known-good"),
        "fallback date");

    global.imports.gi.GLib.DateTime.new_utc = () => null;
    assert.equal(CalendarDateModule.formatCivilDate(date, "%Y"), "");
    global.imports.gi.GLib.DateTime.new_utc = newUtc;
});

test("navigation controller owns no-op, cancellation, and focus boundaries", () => {
    const removed = [];
    global.imports.mainloop.source_remove = (id) => removed.push(id);
    let updates = 0;
    let emitted = 0;
    const selected = civilDate(2026, 6, 9);
    const controller = new NavigationModule.CalendarNavigationController({
        actor: () => ({}),
        dayCells: () => [],
        emitSelected() { emitted++; },
        update: () => updates++,
        setDate() {},
        browse() {},
        queueDate() {}
    }, selected);

    assert.equal(controller.setDate(({...selected}), false), false);
    assert.equal(updates, 0, "an unchanged date is a no-op");
    assert.equal(controller.setDate(({...selected}), true), false);
    assert.equal(updates, 1, "a forced reload still updates");
    assert.equal(controller.setDate(civilDate(2026, 6, 10), true), true);
    assert.equal(updates, 2);
    assert.equal(emitted, 1, "only a changed selection emits");

    controller.setDateIdleId = 7;
    controller.queuedDate = ({...selected});
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
        _navigation: new NavigationModule.CalendarNavigationController({
            queueDate: (date) => { queued = date; }
        }, fromDate)
    };
    CalendarModule.Calendar.prototype._applyDateBrowseAction.call(stub, yearChange, monthChange);
    return queued;
}

function dateInYear(year, month, day) {
    const date = new Date(0);
    date.setFullYear(year, month, day);
    return DateMath.localDateParts(date);
}

// T09a: month/year browsing across year boundaries
test("next month from December rolls into January of the next year", () => {
    const result = browse(civilDate(2025, 11, 15), 0, +1);
    assert.equal(result.year, 2026);
    assert.equal((result.month - 1), 0);
    assert.equal(result.day, 15);
});

test("previous month from January rolls into December of the prior year", () => {
    const result = browse(civilDate(2026, 0, 15), 0, -1);
    assert.equal(result.year, 2025);
    assert.equal((result.month - 1), 11);
    assert.equal(result.day, 15);
});

test("year browsing keeps month and day", () => {
    const up = browse(civilDate(2025, 5, 30), +1, 0);
    assert.equal(up.year, 2026);
    assert.equal((up.month - 1), 5);
    assert.equal(up.day, 30);

    const down = browse(civilDate(2025, 5, 30), -1, 0);
    assert.equal(down.year, 2024);
});

// T09b: February day clamping, leap and non-leap
test("browsing into February clamps day 31 to 28 in a non-leap year", () => {
    const result = browse(civilDate(2026, 0, 31), 0, +1);
    assert.equal((result.month - 1), 1);
    assert.equal(result.day, 28);
});

test("browsing into February keeps day 29 in a leap year", () => {
    const result = browse(civilDate(2024, 2, 29), 0, -1);
    assert.equal((result.month - 1), 1);
    assert.equal(result.day, 29);
});

test("browsing into February clamps day 31 to 29 in a leap year", () => {
    const result = browse(civilDate(2024, 0, 31), 0, +1);
    assert.equal((result.month - 1), 1);
    assert.equal(result.day, 29);
});

test("year change from Feb 29 clamps to Feb 28 in the non-leap target", () => {
    const result = browse(civilDate(2024, 1, 29), +1, 0);
    assert.equal((result.month - 1), 1);
    assert.equal(result.day, 28);
});

test("calendar navigation stops at complete GLib month-window boundaries", () => {
    const earliest = dateInYear(1, 1, 15);
    const latest = dateInYear(9999, 10, 15);
    let heldBackward = civilDate(2026, 6, 9);
    let heldForward = civilDate(2026, 6, 9);

    for (let repeat = 0; repeat < 12000; repeat++) {
        heldBackward = NavigationModule.browsedDate(heldBackward, -1, 0);
        heldForward = NavigationModule.browsedDate(heldForward, 1, 0);
    }

    assert.equal(DateMath.civilDayNumber(NavigationModule.browsedDate(earliest, -1, 0)),
        DateMath.civilDayNumber(earliest), "year browsing cannot enter year zero");
    assert.equal(DateMath.civilDayNumber(NavigationModule.browsedDate(earliest, 0, -1)),
        DateMath.civilDayNumber(earliest), "month browsing cannot build January's year-zero cells");
    assert.equal(DateMath.civilDayNumber(NavigationModule.browsedDate(latest, 1, 0)),
        DateMath.civilDayNumber(latest), "year browsing cannot enter year 10000");
    assert.equal(DateMath.civilDayNumber(NavigationModule.browsedDate(latest, 0, 1)),
        DateMath.civilDayNumber(latest), "month browsing cannot build December's year-10000 cells");
    assert.deepEqual([heldBackward.year, (heldBackward.month - 1)], [1, 6]);
    assert.deepEqual([heldForward.year, (heldForward.month - 1)], [9999, 6]);

    assert.deepEqual([
        NavigationModule.clampCalendarDate(dateInYear(1, 0, 15)).year,
        (NavigationModule.clampCalendarDate(dateInYear(1, 0, 15)).month - 1),
        NavigationModule.clampCalendarDate(dateInYear(1, 0, 15)).day
    ], [1, 1, 1]);
    assert.deepEqual([
        NavigationModule.clampCalendarDate(dateInYear(9999, 11, 15)).year,
        (NavigationModule.clampCalendarDate(dateInYear(9999, 11, 15)).month - 1),
        NavigationModule.clampCalendarDate(dateInYear(9999, 11, 15)).day
    ], [9999, 10, 30]);
});

function expectedBrowseTarget(from, yearChange, monthChange) {
    let month = (from.month - 1) + monthChange;
    let year = from.year + yearChange;
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
        const from = civilDate(2000 + Math.floor(rand() * 50), Math.floor(rand() * 12), 1 + Math.floor(rand() * 31));
        const yearChange = Math.floor(rand() * 5) - 2;
        const monthChange = rand() < 0.5 ? 0 : (rand() < 0.5 ? -1 : 1);

        const result = browse(from, yearChange, monthChange);
        const expected = expectedBrowseTarget(from, yearChange, monthChange);
        assert.equal((result.month - 1), expected.month,
            `from ${DateMath.civilDateKey(from)} y${yearChange} m${monthChange}`);
        assert.equal(result.year, expected.year);
        assert.ok(result.day >= 1);
        assert.ok(result.day <= 31);
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
        selectedDate: civilDate(2026, 6, 9),
        weekStart: 0,
        weekendLength: 2,
        eventDataAvailable: true,
        // the answers the renderers ask for, not the collaborators behind them
        colorsForUnixKey: () => null,
        holidaysActive: () => false,
        requestHolidays() {},
        holidayGeneration: 0,
        selectDate() {},
        allocateDotBox() {},
        dotCapacityChanged() {},
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
        selections: [],
        select_date(date, force) {
            this.selections.push({ date, force });
        },
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

// T985: the month arithmetic sat in a 1140-line file with St, Clutter,
// Cinnamon, Pango and the gtk30 gettext domain, so 42 Dates' worth of pure date
// maths could not be loaded, let alone tested, without a toolkit.
test("the month window names no toolkit", () => {
    // the code, not the prose above it: the header comment names the toolkits
    // it is free of
    const source = fs.readFileSync(
        path.join(APPLET_DIR, "6.0", "calendarMonthWindow.js"), "utf8")
        .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

    for (const toolkit of [/\bSt\./, /Clutter/, /Pango/, /Cinnamon/, /gtk30/, /Tooltips/]) {
        assert.doesNotMatch(source, toolkit,
            "the window is date arithmetic; nothing in it draws anything");
    }
    assert.match(source, /class CalendarMonthWindow/);
});

// T985: the switch this replaced could only be exercised by reloading the
// module against three different gtk30 gettext domains, so two of its three
// arms — and the header layout under one of them — were never run.
test("the header order follows GTK's own answer, and survives a broken one", () => {
    assert.equal(CalendarModule.headerMonthFirst("calendar:MY"), true);
    assert.equal(CalendarModule.headerMonthFirst("calendar:YM"), false);

    const logged = [];
    const originalLog = global.log;
    global.log = (line) => logged.push(line);
    try {
        assert.equal(CalendarModule.headerMonthFirst("Kalender:JM"), true,
            "a translation GTK got wrong falls back to the commoner order");
    } finally {
        global.log = originalLog;
    }
    assert.equal(logged.length, 1);
    assert.match(logged[0], /not correct/);
});

// ...and the year-first order puts the same two boxes in the other columns
test("a year-first locale builds the header the other way round", () => {
    const cal = makeCalendar();
    const columnOf = (box) => cal.actor.placements
        .find((placement) => placement.child === box).opts.col;

    assert.equal(columnOf(cal._topBoxMonth), 0, "month first by default");

    cal._headerMonthFirst = false;
    cal._buildHeader();

    assert.equal(columnOf(cal._topBoxYear), 0, "the year takes the first columns");
    assert.ok(columnOf(cal._topBoxMonth) > 0);
});

// the grid keeps its cells; the day button is the first child of each cell group
function dayButtons(cal) {
    return cal._gridView.dayCells.map((cell) => cell.button);
}

function headerNavButton(box, styleClass) {
    const button = box.children.find((child) => child.style_class === styleClass);
    assert.ok(button, `no ${styleClass} button in the header`);
    return button;
}

// The dots are 4px of colour and nothing else: colour is the only channel that
// says a day has events, which leaves a screen-reader or low-vision user with
// no way to know.
test("a day's events are counted in its name, not only drawn as dots", () => {
    const cal = makeCalendar({ colors: ["#ff0000", "#00ff00"] });
    cal.setDate(civilDate(2026, 6, 9), true);

    const withEvents = dayButtons(cal).find((button) => button.label === "9");
    assert.match(withEvents.accessible_name, /2 events$/);

    const none = makeCalendar({ colors: [] });
    none.setDate(civilDate(2026, 6, 9), true);
    assert.doesNotMatch(dayButtons(none).find((button) => button.label === "9").accessible_name,
        /event/, "and a day with none says nothing about events");

    const one = makeCalendar({ colors: ["#ff0000"] });
    one.setDate(civilDate(2026, 6, 9), true);
    assert.match(dayButtons(one).find((button) => button.label === "9").accessible_name,
        /1 event$/, "one event is not 1 events");
});

// today and the selected day are drawn as a background colour and nothing
// else: the one piece of orientation the grid exists to give was unsayable
test("today and the selected day say so in their names", () => {
    const cal = makeCalendar();
    const today = civilDate();
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
    cal.setDate(civilDate(2026, 6, 9), true);
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
    cal.setDate(civilDate(2026, 6, 9), true);
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
        holidaysActive: () => true
    }));
    annotator.attachLabel(label);

    annotator.setStatus("Weather service unavailable");
    assert.match(label.text, /⚠/, "the glyph still marks it visually");
    assert.match(label.accessible_name, /Holiday data/,
        "and the reason is readable without hovering");

    annotator.setStatus("");
    assert.doesNotMatch(label.accessible_name, /Holiday data/);
});

// holidays-changed rebuilds the event column's holiday rows, so it must fire
// on a real change and only on a real change. The map the annotator already
// holds is the previous answer, so it is the comparison — this used to
// serialise both sides on every annotate pass to find out.
test("the holiday map is compared entry by entry, not by serialising it", () => {
    let changes = 0;
    const annotator = new AnnotationsModule.CalendarHolidayAnnotator(makeHost({
        holidaysChanged: () => { changes++; }
    }));
    // _reconcileCells keys what it stores by the cell's own date, so the cells
    // have to be the days the annotations are for
    const cellFor = (key) => {
        const [month, day] = key.split("/").map(Number);
        return { date: { year: 2026, month, day }, button: new MockActor(),
            holidayTooltip: null };
    };
    const reconcile = (entries) => {
        const cells = new Map(entries.map(([date]) => [date, cellFor(date)]));
        annotator._reconcileCells(new Map(entries), cells);
    };

    reconcile([]);
    assert.equal(changes, 0, "an empty month matches the empty starting state");

    reconcile([["7/14", { name: "Bastille Day", flags: ["PUBLIC_HOLIDAY"] }]]);
    assert.equal(changes, 1);

    // an equal-but-distinct array is the same annotation
    reconcile([["7/14", { name: "Bastille Day", flags: ["PUBLIC_HOLIDAY"] }]]);
    assert.equal(changes, 1, "re-annotating the same month changes nothing");

    reconcile([["7/14", { name: "Fête nationale", flags: ["PUBLIC_HOLIDAY"] }]]);
    assert.equal(changes, 2, "a renamed holiday is a change");

    reconcile([["7/14", { name: "Fête nationale", flags: ["PUBLIC_HOLIDAY", "PART_DAY_HOLIDAY"] }]]);
    assert.equal(changes, 3, "so is a change of flags at the same name");

    reconcile([["7/14", { name: "Fête nationale", flags: ["PUBLIC_HOLIDAY", "RELIGIOUS_HOLIDAY"] }]]);
    assert.equal(changes, 4, "...including one that keeps the same count");

    // a second date at the same size is not the same map
    reconcile([["7/15", { name: "Fête nationale", flags: ["PUBLIC_HOLIDAY", "RELIGIOUS_HOLIDAY"] }]]);
    assert.equal(changes, 5, "the same annotation on another day is a change");

    // a row can carry no flags, but never no `flags`: monthHolidayEntry
    // substitutes the empty array, and every producer of the map goes through it
    reconcile([["7/15", { name: "Some observance", flags: [] }]]);
    assert.equal(changes, 6);
    reconcile([["7/15", { name: "Some observance", flags: [] }]]);
    assert.equal(changes, 6, "two flagless rows are still equal");

    reconcile([]);
    assert.equal(changes, 7, "and a month that loses its holidays is a change");
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
        holidaysActive: () => true
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
    cal.setDate(civilDate(2026, 6, 9), true);

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
    cal.setDate(civilDate(2026, 6, 9), true);

    const press = (symbol) => cal.actor.fire("key-press-event", { get_key_symbol: () => symbol });
    const Clutter = global.imports.gi.Clutter;

    // the arrows coalesce on the same window as Page Up/Down below
    const arrow = (symbol) => {
        press(symbol);
        cal._navigation.flushQueuedDate();
    };

    arrow(Clutter.KEY_Right);
    assert.equal(cal.getSelectedDate().day, 10, "right moves one day");
    arrow(Clutter.KEY_Down);
    assert.equal(cal.getSelectedDate().day, 17, "down moves one week");
    arrow(Clutter.KEY_Left);
    assert.equal(cal.getSelectedDate().day, 16);
    arrow(Clutter.KEY_Up);
    assert.equal(cal.getSelectedDate().day, 9);

    press(Clutter.KEY_Page_Down);
    cal._navigation.flushQueuedDate();
    assert.equal((cal.getSelectedDate().month - 1), 7, "page down moves a month");
    press(Clutter.KEY_Page_Up);
    cal._navigation.flushQueuedDate();
    assert.equal((cal.getSelectedDate().month - 1), 6);

    press(Clutter.KEY_Home);
    // the whole date, not just the day-of-month: a Home key that lands on the
    // right day in the wrong month or year used to pass. The clock is read once,
    // so a run crossing local midnight cannot flake either.
    const today = civilDate();
    const selected = cal.getSelectedDate();
    assert.equal(selected.day, today.day, "home returns to today");
    assert.equal((selected.month - 1), (today.month - 1));
    assert.equal(selected.year, today.year);

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

test("holidays-only navigation stays live for every event-unavailable state", () => {
    const Clutter = global.imports.gi.Clutter;
    const states = [
        { name: "events disabled", showEvents: false, edsReady: true, hasCalendars: true },
        { name: "EDS unavailable", showEvents: true, edsReady: false, hasCalendars: true },
        { name: "no calendars", showEvents: true, edsReady: true, hasCalendars: false }
    ];

    for (const state of states) {
        const manager = makeEventsManager(["#ff0000"]);
        manager.is_active = () => state.showEvents && state.edsReady && state.hasCalendars;
        const holiday = makeHolidayStub({
            "2026/9": { "9/14": { name: "Holiday", flags: [] } }
        });
        const cal = new CalendarModule.Calendar(makeSettings(), manager, holiday,
            makeDesktopSettings());
        cal.setDate(civilDate(2026, 6, 9), true);

        assert.equal(cal.event_data_available, false, state.name);
        assert.ok(cal._gridView.dayCells.every((cell) => cell.dot_box.children.length === 0),
            `${state.name}: unavailable event data draws no dots`);

        const day10 = cal._gridView.dayCells.find((cell) =>
            cell.date.year === 2026 && cell.date.month === 7 && cell.date.day === 10);
        day10.button.fire("clicked");
        assert.equal(cal.getSelectedDate().day, 10,
            `${state.name}: mouse selection remains live`);

        assert.equal(cal._onKeyPress(null, {
            get_key_symbol: () => Clutter.KEY_Right
        }), Clutter.EVENT_STOP, `${state.name}: keyboard navigation remains live`);
        cal._navigation.flushQueuedDate();
        assert.equal(cal.getSelectedDate().day, 11);

        cal._onScroll(null, {
            get_scroll_direction: () => Clutter.ScrollDirection.DOWN
        });
        cal._navigation.flushQueuedDate();
        assert.equal((cal.getSelectedDate().month - 1), 7,
            `${state.name}: scroll navigation remains live`);

        headerNavButton(cal._topBoxMonth, "calendar-change-month-forward").fire("clicked");
        cal._navigation.flushQueuedDate();
        assert.equal((cal.getSelectedDate().month - 1), 8,
            `${state.name}: header navigation remains live`);

        const holidayCell = cal._gridView.dayCells.find((cell) =>
            cell.date.year === 2026 && cell.date.month === 9 && cell.date.day === 14);
        assert.ok(holidayCell.button.style_class.includes("calendar-holiday-day"),
            `${state.name}: holiday annotations follow the browsed month`);
    }
});

// the handler sits on the table, which is the ancestor of the month and year
// buttons too: taking the arrows unconditionally meant Left and Right moved the
// date while the user was trying to move between those buttons
// Held down, an arrow is about thirty key events a second, and each one used to
// run a grid update plus an emitSelected that reaches the applet, reselects the
// day on the events manager and re-feeds the event column. Page Up/Down and the
// scroll wheel have coalesced on a 25 ms window all along; the arrows were the
// one browse path that did not.
test("a held arrow key resolves to one selection, not one per repeat", () => {
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 6, 9), true);
    const Clutter = global.imports.gi.Clutter;
    const day = dayButtons(cal).find((button) => button.label === "9");
    global.stage = { get_key_focus: () => day };

    // a grid render plus the applet-facing selection notice, which is what
    // reselects the day and re-feeds the event column
    let renders = 0;
    const realUpdate = cal._update.bind(cal);
    cal._update = () => {
        renders++;
        return realUpdate();
    };

    try {
        // one autorepeat burst: five key events inside the coalescing window
        for (let repeat = 0; repeat < 5; repeat++) {
            cal.actor.fire("key-press-event", { get_key_symbol: () => Clutter.KEY_Right });
        }
        assert.equal(renders, 0, "nothing is drawn while the key is still down");

        cal._navigation.flushQueuedDate();

        assert.equal(renders, 1, "one render for the whole burst, not one per repeat");
        assert.equal(cal.getSelectedDate().day, 14,
            "the repeats compose rather than overwrite each other");
    } finally {
        global.stage = undefined;
    }
});

test("an arrow key moves the focus with the selection it coalesced", () => {
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 6, 9), true);
    const Clutter = global.imports.gi.Clutter;
    const day = dayButtons(cal).find((button) => button.label === "9");
    global.stage = { get_key_focus: () => day };

    try {
        cal.actor.fire("key-press-event", { get_key_symbol: () => Clutter.KEY_Right });
        cal._navigation.flushQueuedDate();

        const focused = MockActor.focused;
        assert.ok(focused, "the grid still owns the key focus");
        assert.equal(focused.label, "10",
            "and it is on the day the arrow moved to, not the one it left");
    } finally {
        global.stage = undefined;
    }
});

test("the arrow keys are the grid's, not the navigation buttons'", () => {
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 6, 9), true);
    const Clutter = global.imports.gi.Clutter;
    const press = (symbol) => cal.actor.fire("key-press-event", { get_key_symbol: () => symbol });

    // one of the month/year navigation buttons has keyboard focus
    const navButton = cal._topBoxMonth.children[0];
    assert.equal(navButton.accessible_name, "Previous month");
    global.stage = { get_key_focus: () => navButton };
    press(Clutter.KEY_Right);
    cal._navigation.flushQueuedDate();
    assert.equal(cal.getSelectedDate().day, 9,
        "the arrow belongs to the focused button; the date does not move");

    // a day cell has it
    const day = dayButtons(cal).find((button) => button.label === "9");
    global.stage = { get_key_focus: () => day };
    press(Clutter.KEY_Right);
    cal._navigation.flushQueuedDate();
    assert.equal(cal.getSelectedDate().day, 10, "and now the arrow walks the grid");

    global.stage = undefined;
});

test("CalendarMonthWindow builds 42 visible dates and month lookup keys", () => {
    const window = new CalendarModule.CalendarMonthWindow(civilDate(2026, 6, 9), 0);

    assert.equal(window.days.length, 42);
    assert.equal(window.dateUnixKeys.length, 42);
    assert.deepEqual(window.days[0], { year: 2026, month: 6, day: 28 });
    assert.equal(window.dateUnixKeys[0], Math.trunc(new Date(2026, 5, 28).getTime() / 1000));
    assert.equal(window.dateUnixKeys[3], Math.trunc(new Date(2026, 6, 1).getTime() / 1000));
    assert.equal(window.days[3].day, 1);
    assert.equal(window.months.has("2026/6"), true);
    assert.equal(window.months.has("2026/7"), true);
    assert.equal(typeof window.weekLabelForRow(0), "string");
});

test("CalendarMonthWindow guards its GLib date domain", () => {
    const minimum = new CalendarModule.CalendarMonthWindow(dateInYear(1, 0, 15), 0);
    const maximum = new CalendarModule.CalendarMonthWindow(dateInYear(9999, 11, 15), 0);
    assert.ok(minimum.days.every((day) => day.year >= 1));
    assert.ok(maximum.days.every((day) => day.year <= 9999));

    const original = global.imports.gi.GLib.DateTime.new;
    global.imports.gi.GLib.DateTime.new = () => null;
    try {
        const unavailable = new CalendarModule.CalendarMonthWindow(civilDate(2026, 6, 9), 0);
        assert.ok(unavailable.dateUnixKeys.every((key) => key === null),
            "a failed GLib conversion does not escape the render idle");
    } finally {
        global.imports.gi.GLib.DateTime.new = original;
    }
});

test("skipped civil projections retain their labels and never select or query the following day", (t) => {
    const clock = global.imports.gi.GLib.DateTime;
    const construct = clock.new;
    const date = { year: 2011, month: 12, day: 30 };
    let normalized;
    t.mock.method(clock, "new", () => normalized ? construct.call(clock, null,
        normalized.year, normalized.month, normalized.day) : null);
    for (const result of [
        { year: 2012, month: 12, day: 30 },
        { year: 2011, month: 11, day: 30 },
        { year: 2011, month: 12, day: 31 }
    ]) {
        normalized = result;
        assert.equal(CalendarDateModule.localUnixForCivilDate(date), null);
    }
    normalized = null;
    let selected = false;
    let lookedUp = false;
    const host = makeHost({ selectDate() { selected = true; },
        colorsForUnixKey() { lookedUp = true; return ["#fff"]; } });
    const dots = new CalendarModule.CalendarEventDotRenderer(host);
    host.renderDots = (...args) => dots.update(...args);
    const renderer = new CalendarModule.CalendarDayCellRenderer(host);
    const cell = renderer.build();
    renderer.update(cell, date, 2, civilDate(2011, 11, 31), null, "Friday, December 30, 2011");
    cell.button.fire("clicked");
    assert.equal(cell.button.label, "30");
    assert.equal(cell.accessible_date, "Friday, December 30, 2011");
    assert.equal(cell.event_count, 0);
    assert.equal(lookedUp, false);
    assert.equal(selected, false);

    const cal = makeCalendar();
    cal._selectedDate = civilDate(2011, 11, 29);
    cal._onKeyPress(null, { get_key_symbol: () => global.imports.gi.Clutter.KEY_Right });
    assert.equal(cal._navigation.queuedDate, null,
        "failed projections stop after two attempts instead of scanning indefinitely");
    assert.equal(NavigationModule.browsedDate(cal._selectedDate, 0, 1), cal._selectedDate);
});

test("CalendarDayCellRenderer builds reusable clickable cells", () => {
    let selected = null;
    const host = makeHost({ selectDate(date) { selected = date; } });
    const renderer = new CalendarModule.CalendarDayCellRenderer(host);
    const cell = renderer.build();

    assert.equal(cell.button.label, "");
    assert.equal(cell.group.children[0], cell.button);
    assert.equal(cell.group.children[1], cell.dot_box);

    cell.date = { year: 2026, month: 7, day: 14 };
    cell.dateUnixKey = CalendarDateModule.localUnixForCivilDate(cell.date);
    cell.button.fire("clicked");
    assert.equal(selected.year, 2026);
    assert.equal((selected.month - 1), 6);
    assert.equal(selected.day, 14);
});

// The cells are built once and reused, so a click can land on a cell that is not
// currently showing a date. Optional event data must not control selection.
test("a day cell click requires a date but not event data", () => {
    let selected = null;
    const host = makeHost({ selectDate(date) { selected = date; } });
    const renderer = new CalendarModule.CalendarDayCellRenderer(host);

    const empty = renderer.build();
    empty.button.fire("clicked");
    assert.equal(selected, null, "a cell with no date selects nothing");

    host.eventDataAvailable = false;
    const dated = renderer.build();
    dated.date = { year: 2026, month: 7, day: 14 };
    dated.dateUnixKey = CalendarDateModule.localUnixForCivilDate(dated.date);
    dated.button.fire("clicked");
    assert.equal(selected.day, 14,
        "a dated cell remains selectable without event data");
});

// T581: event-data availability was recomputed only from manager-ready and
// calendars-changed signals, but the show-events setting participates in
// is_active() and changes through the applet's settings path — so cached
// event dots stayed on the grid after the user switched events off.
test("switching events off clears the grid without a manager signal", () => {
    let active = true;
    const manager = makeEventsManager(["#ff0000"]);
    manager.is_active = () => active;
    const cal = new CalendarModule.Calendar(makeSettings(), manager, null,
        makeDesktopSettings());
    cal.setDate(civilDate(2026, 6, 9), true);
    const day9 = () => dayButtons(cal).find((button) => button.label === "9");
    assert.match(day9().accessible_name, /1 event$/);

    // the user switches show-events off: is_active() flips, no signal fires
    active = false;
    cal.refreshEventDataAvailability();
    cal._idle_do_update();
    assert.equal(cal.event_data_available, false);
    assert.doesNotMatch(day9().accessible_name, /event/,
        "the cached dots and counts are gone");

    // ...and switching back on restores them from the still-indexed data
    active = true;
    cal.refreshEventDataAvailability();
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
    let capacityChanges = 0;
    let selected = null;
    const colorRequests = [];
    const holidayRequests = [];
    const selectedDate = civilDate(2026, 6, 9);
    const port = {
        selectedDate: () => selectedDate,
        weekStart: () => 1,
        weekendLength: () => 1,
        eventDataAvailable: () => true,
        // T976: the answers, not the collaborators. Handing out the whole
        // EventsManager and the whole holiday provider meant a test for either
        // renderer still needed a full-shaped double of them.
        colorsForUnixKey: (key) => {
            colorRequests.push(key);
            return null;
        },
        holidaysActive: () => true,
        requestHolidays: (...args) => holidayRequests.push(args),
        holidayGeneration: () => 4,
        selectDate: (date) => { selected = date; },
        allocateDotBox: (...args) => {
            allocations.push(args);
            return 7;
        },
        dotCapacityChanged: () => { capacityChanges++; },
        renderDots: (...args) => dots.push(args),
        nameCell: (cell) => named.push(cell),
        reportIssue() {},
        holidaysChanged: () => { holidayChanges++; }
    };
    const host = new CalendarModule.CalendarGridHost(port);

    assert.equal(host.selectedDate, selectedDate);
    assert.equal(host.weekStart, 1);
    assert.equal(host.weekendLength, 1);
    assert.equal(host.eventDataAvailable, true);
    assert.equal(host.colorsForUnixKey(20260714), null);
    assert.deepEqual(colorRequests, [20260714]);
    assert.equal(host.holidaysActive(), true);
    host.requestHolidays(2026, 7, "cb");
    assert.deepEqual(holidayRequests, [[2026, 7, "cb"]]);
    assert.equal(host.holidayGeneration, 4);

    const date = civilDate(2026, 6, 14);
    host.selectDate(date);
    // a cell click never forces a reload: the date it selects is the date it
    // already shows
    assert.equal(selected, date);

    assert.equal(host.allocateDotBox("actor", "box", "flags"), 7);
    assert.deepEqual(allocations, [["actor", "box", "flags"]]);
    host.dotCapacityChanged();
    assert.equal(capacityChanges, 1);

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
    let capacityChanges = 0;
    const host = makeHost({
        allocateDotBox(actor, box, flags) {
            allocations.push([actor, box, flags]);
            return 8;
        },
        dotCapacityChanged: () => { capacityChanges++; }
    });
    const renderer = new CalendarModule.CalendarDayCellRenderer(host);
    const cell = renderer.build();

    const box = { x1: 0, x2: 40, y1: 0, y2: 10 };
    cell.dot_box.fire("allocate", box, 0);

    assert.equal(allocations.length, 1, "the allocate signal reaches the calendar");
    assert.equal(allocations[0][0], cell.dot_box);
    assert.equal(allocations[0][1], box);
    assert.equal(cell.dot_capacity, 8);
    assert.equal(capacityChanges, 1);

    cell.dot_box.fire("allocate", box, 0);
    assert.equal(capacityChanges, 1, "an unchanged capacity does not queue another update");

    const calendar = makeCalendar();
    calendar._update();
    const actualCell = calendar._gridView.dayCells[0];
    actualCell.dot_box.add_actor(makeDot());
    calendar._gridView.dotMetrics = { nw: 10, nh: 10, max_rows: 2 };
    global.imports.gi.Clutter.ActorBox = class {
        constructor() {
            this.x1 = 0;
            this.y1 = 0;
            this.x2 = 0;
            this.y2 = 0;
        }
    };
    actualCell.dot_box.fire("allocate", box, 0);
    assert.equal(actualCell.dot_capacity, 8);
    assert.equal(calendar._update_id, 1, "a real capacity change queues a bounded redraw");
});

function allocateContentSizedDots(calendar, widthLimit) {
    for (const cell of calendar._gridView.dayCells) {
        const children = cell.dot_box.get_children();
        for (const dot of children) dot.allocate = () => {};
        const width = Math.max(33, Math.min(widthLimit, children.length * 12));
        cell.dot_box.fire("allocate", { x1: 0, x2: width, y1: 0, y2: 12 }, 0);
    }
}

function settleContentSizedDots(calendar, pending, widthLimit) {
    for (let pass = 0; pass <= 64; pass++) {
        allocateContentSizedDots(calendar, widthLimit);
        assert.ok(pending.size <= 1, "42 capacity notifications leave one scheduled render");
        if (pending.size === 0) return pass;
        const [id, callback] = pending.entries().next().value;
        pending.delete(id);
        assert.equal(callback(), false);
    }
    assert.fail("content-dependent dot sizing must settle within the 64-dot ceiling");
}

test("content-dependent dot widths settle across dense, empty and themed days", (t) => {
    const pending = new Map();
    let nextId = 0;
    t.mock.method(global.imports.mainloop, "idle_add", (callback) => {
        pending.set(++nextId, callback);
        return nextId;
    });
    t.mock.method(global.imports.mainloop, "source_remove", (id) => pending.delete(id));
    const savedBox = global.imports.gi.Clutter.ActorBox;
    global.imports.gi.Clutter.ActorBox = class {};
    t.after(() => { global.imports.gi.Clutter.ActorBox = savedBox; });
    const calendar = makeCalendar();
    // These dimensions and transitions come from the live Cinnamon fixture
    // documented in docs/calendar-dot-layout.md, including its 33px day width.
    const cases = [
        [48, 512, 2, 8, 1], [12, 512, 2, 4, 1], [120, 512, 2, 20, 3],
        [120, 2, 2, 2, 1], [120, 0, 2, 0, 0], [120, 512, 2, 20, 3],
        [48, 512, 1, 4, 1], [48, 512, 2, 8, 1]
    ];
    for (const [width, count, rows, visible, passes] of cases) {
        calendar.events_manager.get_colors_for_unix_key = () => Array(count).fill("#3399ff");
        calendar._gridView.dotMetrics = { nw: 12, nh: 4, max_rows: rows };
        calendar._update();
        assert.equal(settleContentSizedDots(calendar, pending, width), passes);
        assert.ok(calendar._gridView.dayCells.every((cell) =>
            cell.dot_box.get_children().length === visible && cell.event_count === count));
        allocateContentSizedDots(calendar, width);
        assert.equal(pending.size, 0, "unchanged allocation schedules no further render");
    }
    calendar.destroy();
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
        renderDots: (cell, iter, key) => dotCalls.push([cell, iter, key])
    });
    const renderer = new CalendarModule.CalendarDayCellRenderer(host);
    const cell = renderer.build();
    const iter = { year: 2026, month: 7, day: 9 };
    const today = civilDate(2026, 6, 9);
    const dateUnixKey = CalendarDateModule.localUnixForCivilDate(iter);
    const accessibleDate = "Thursday, 9 July 2026";
    const tooltip = new global.imports.ui.tooltips.Tooltip(cell.button);
    cell.holidayTooltip = tooltip;
    cell.holiday_tooltip_set = true;

    renderer.update(cell, iter, 2, today, dateUnixKey, accessibleDate);

    assert.equal(cell.button.label, "9");
    assert.equal(cell.date.day, 9);
    assert.equal(cell.is_today, true);
    assert.equal(cell.accessible_date, accessibleDate);
    assert.equal(cell.selected, true);
    assert.ok(cell.button.pseudo.has("selected"));
    assert.ok(cell.button.style_class.includes("calendar-day-top"));
    assert.ok(cell.button.style_class.includes("calendar-today"));
    assert.equal(cell.holiday_tooltip_set, false);
    // the slot shows a different day now, so the tooltip that carried the old
    // day's holiday is handed back rather than blanked and kept
    assert.equal(cell.holidayTooltip, null);
    assert.equal(tooltip.destroyed, true);
    assert.deepEqual(dotCalls, [[cell, iter, dateUnixKey]]);
});

test("CalendarEventDotRenderer owns dot actor reuse and cleanup", () => {
    let colors = ["#101010", "color: red;"];
    const renderer = new CalendarModule.CalendarEventDotRenderer(makeHost({
        colorsForUnixKey: () => colors
    }));
    const cell = { dot_key: "", dot_box: new MockActor() };

    renderer.update(cell, civilDate(2026, 6, 9), 1);
    assert.equal(cell.dot_box.children.length, 2);
    assert.ok(cell.dot_box.children[0].options.style.includes("#101010"));
    assert.ok(!cell.dot_box.children[1].options.style.includes("color: red"));

    const firstDot = cell.dot_box.children[0];
    colors = ["#202020"];
    renderer.update(cell, civilDate(2026, 6, 9), 1);
    assert.equal(cell.dot_box.children.length, 1);
    assert.equal(cell.dot_box.children[0], firstDot);
    assert.ok(firstDot.style.includes("#202020"));

    colors = null;
    renderer.update(cell, civilDate(2026, 6, 9), 1);
    assert.equal(cell.dot_box.children.length, 0);
    assert.equal(firstDot.destroyed, true);
});

test("CalendarEventDotRenderer bounds dense days without losing the accessible count", () => {
    const colors = Array.from({ length: 2000 }, (_unused, index) =>
        `rgb(${index % 255}, 0, 0)`);
    const renderer = new CalendarModule.CalendarEventDotRenderer(makeHost({
        colorsForUnixKey: () => colors
    }));
    const cell = {
        accessible_date: "Thursday, 9 July 2026",
        button: new MockActor(),
        dot_capacity: 3,
        dot_key: "",
        dot_box: new MockActor(),
        holiday_name: "",
        is_today: false,
        selected: false
    };

    renderer.update(cell, civilDate(2026, 6, 9), 1);

    assert.equal(cell.event_count, 2000);
    assert.equal(cell.event_dots_overflowed, true);
    assert.equal(cell.dot_box.children.length, 3);
    assert.ok(cell.dot_key.length < 100, "the reuse key follows visible dots, not all events");

    new CalendarModule.CalendarDayCellRenderer({}).applyAccessibleName(cell);
    assert.match(cell.accessible_name, /2000 events/);
    assert.match(cell.accessible_name, /hidden to keep the desktop responsive/);
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
    cal.setDate(civilDate(2026, 6, 9), true);
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
    cal.setDate(civilDate(2026, 1, 10), true);
    const cells = placedGrid(cal);
    const first = cells.find((c) => c.day === "1" && c.row === 2 && c.col === 0);
    assert.ok(first, "Feb 1st 2026 placed at row 2 col 0");
    assert.equal(cells.length, 42);
});

test("grid placement: April 2026 (30 days, starts Wednesday)", () => {
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 3, 15), true);
    const cells = placedGrid(cal);
    assert.equal(cells.length, 42);
    const first = cells.find((c) => c.day === "1" && c.row === 2);
    assert.equal(first.col, 3);
});

test("selected day carries the selected pseudo class and dots render colors", () => {
    const cal = makeCalendar({ colors: ["#101010", "#202020"] });
    cal.setDate(civilDate(2026, 6, 9), true);
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
    const holiday = makeHolidayStub({ "2026/7": { "7/14": { name: "Bastille Day", flags: ["public_holiday"] } } });
    const cal = makeCalendar({ holiday });
    cal.setDate(civilDate(2026, 6, 9), true);

    assert.ok(holiday.calls.length >= 1);
    const day14 = dayButtons(cal).find((b) => b.label === "14" &&
        b.style_class.includes("calendar-nonwork-day"));
    assert.ok(day14, "holiday day styled as nonwork");
    assert.ok(!day14.style_class.includes("calendar-work-day"));
    const fetches = holiday.calls.length;
    assert.deepEqual(cal.holidayForDate(civilDate(2026, 6, 14)),
        { name: "Bastille Day", flags: ["public_holiday"] });
    assert.equal(holiday.calls.length, fetches,
        "selected-day lookup reuses the rendered holiday model");
    const cell = cal._gridView.dayCells.find((candidate) => candidate.button === day14);
    assert.equal(cell.holidayTooltip.texts.at(-1), "Bastille Day",
        "the existing cell tooltip remains intact");
    assert.equal(AnnotationsModule.calendarDateKey(
        { year: 2026, month: 7, day: 14 }), "2026/7/14",
        "the selected civil date addresses the cached holiday");
});

test("the month window is reused while the month and week start hold", () => {
    const cache = new CalendarModule.CalendarMonthWindowCache();

    const first = cache.get(civilDate(2026, 6, 9), 0);
    const sameMonth = cache.get(civilDate(2026, 6, 27), 0);
    assert.equal(sameMonth, first, "another day of the same month reuses the window");

    const otherWeekStart = cache.get(civilDate(2026, 6, 9), 1);
    assert.notEqual(otherWeekStart, first, "a different week start rebuilds it");

    const otherMonth = cache.get(civilDate(2026, 7, 9), 1);
    assert.notEqual(otherMonth, otherWeekStart);
    assert.equal(otherMonth.days.length, 42);

    cache.invalidate();
    assert.notEqual(cache.get(civilDate(2026, 7, 9), 1), otherMonth,
        "an invalidated cache rebuilds under an unchanged key");
});

// A timedatectl set-timezone, or an automatic change on a travelling laptop,
// leaves the cache key (year/month/weekStart) identical while every dateUnixKey
// inside the window becomes an offset the grid can no longer match event
// buckets on — so nothing about the change would otherwise reach the cache.
test("an OS timezone change drops the cached month window and re-renders", () => {
    const cal = new CalendarModule.Calendar(
        makeSettings(), makeEventsManager(), null, makeDesktopSettings());
    cal.setDate(civilDate(2026, 6, 9), true);
    cal._update_id = 0;

    const before = cal._monthWindows.get(civilDate(2026, 6, 9), cal._weekStart);
    assert.equal(cal._monthWindows.get(civilDate(2026, 6, 20), cal._weekStart), before,
        "another day of the month reuses it while the zone holds");

    cal.refreshTimezone();

    assert.notEqual(cal._monthWindows.get(civilDate(2026, 6, 9), cal._weekStart), before,
        "the zone change rebuilds it");
    assert.ok(cal._update_id > 0, "and queues the re-render that picks it up");
});

test("a holiday fetch that has not answered yet shows a pending marker", () => {
    let pending = null;
    const label = new MockActor();
    const annotator = new AnnotationsModule.CalendarHolidayAnnotator(makeHost({
        holidayGeneration: 3,
        holidaysActive: () => true,
        // a real network round-trip: the callback lands later
        requestHolidays(y, m, cb) {
            pending = cb;
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
        holidaysActive: () => true,
        requestHolidays(y, m, cb) {
            pending.set(`${y}/${m}`, cb);
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

function updatingCalendarFixture(months = ["2026/12", "2027/1"]) {
    const { CalendarRegistry } = require(path.join(APPLET_DIR, "calendarRegistry"));
    const registry = new CalendarRegistry();
    const pending = new Map();
    registry.register({
        id: "review:standing", name: "Standing dates", category: "custom", enabled: true,
        available: () => true,
        getHolidays(year, month, done) {
            done(new Map([[`${month}/25`, { name: "Standing observance", flags: ["calendar_observance"] }]]),
                "", "Standing provider");
        }
    });
    registry.register({
        id: "review:updating", name: "Updating dates", category: "custom", enabled: true,
        available: () => true,
        getHolidays(year, month, done) { pending.set(`${year}/${month}`, done); }
    });
    const cells = new Map([25, 26].map((day) => [`12/${day}`, {
        date: { year: 2026, month: 12, day },
        button: new MockActor({ style_class: "calendar-day-base calendar-work-day" }),
        rendered_style: "calendar-day-base calendar-work-day", holiday_styled: false,
        holidayTooltip: null, holiday_tooltip_set: false
    }]));
    const label = new MockActor();
    const host = makeHost({
        holidayGeneration: 3, holidaysActive: () => true,
        requestHolidays(year, month, done) { registry.getHolidays(Number(year), Number(month), done); }
    });
    const annotator = new AnnotationsModule.CalendarHolidayAnnotator(host);
    annotator.attachLabel(label);
    annotator.annotate(new Set(months), cells, 3);
    return { registry, pending, cells, label, annotator, host };
}

test("registry updates never settle a sibling month that has not answered", () => {
    const { pending, label, cells, registry } = updatingCalendarFixture();
    pending.get("2026/12")(new Map(), "", "Updating provider");
    pending.get("2026/12")(new Map(), "", "Updating provider");
    assert.match(label.text, /…$/, "January remains pending after two December answers");
    assert.equal(cells.get("12/25").holiday_tooltip_set, false,
        "partial data is not reconciled before January answers");
    pending.get("2027/1")(new Map(), "", "January provider");
    assert.doesNotMatch(label.text, /…/);
    assert.equal(cells.get("12/25").holiday_name, "Standing observance");
    registry.destroy();
});

test("updated month snapshots retain overlapping sources and remove withdrawn dates and styling", () => {
    const { pending, cells, annotator, registry } = updatingCalendarFixture(["2026/12"]);
    const reply = pending.get("2026/12");
    reply(new Map([
        ["12/25", { name: "Temporary day off", flags: ["public_holiday"] }],
        ["12/26", { name: "Withdrawn date", flags: ["public_holiday"] }]
    ]), "", "Old provider");
    assert.equal(cells.get("12/25").holiday_name, "Standing observance\nTemporary day off");
    assert.match(cells.get("12/25").button.style_class, /calendar-nonwork-day/);
    reply(new Map(), "", "New provider");
    assert.equal(cells.get("12/25").holiday_name, "Standing observance");
    assert.match(cells.get("12/25").button.style_class, /calendar-work-day/);
    assert.doesNotMatch(cells.get("12/25").button.style_class, /calendar-nonwork-day/);
    assert.equal(cells.get("12/26").holiday_name, "");
    assert.equal(cells.get("12/26").holiday_tooltip_set, false);
    assert.equal(cells.get("12/26").button.style_class, cells.get("12/26").rendered_style);
    assert.equal(annotator.holidayForDate(civilDate(2026, 11, 26)), null);
    assert.equal(annotator.provider, "Standing provider, New provider");
    registry.destroy();
});

test("month updates replace recovered errors and old credits while keeping other failures", () => {
    const { pending, label, annotator, registry } = updatingCalendarFixture();
    const december = pending.get("2026/12");
    const january = pending.get("2027/1");
    december(new Map(), "Holiday service unavailable", "December failed");
    january(new Map(), "Holiday data unavailable", "January failed");
    december(new Map(), "", "December recovered");
    assert.equal(annotator.error, "Holiday data unavailable");
    assert.equal(annotator.provider, "Standing provider, January failed");
    january(new Map(), "", "January recovered");
    assert.equal(annotator.error, "");
    assert.doesNotMatch(label.text, /⚠/);
    assert.doesNotMatch(annotator.provider, /failed/);
    assert.match(annotator.provider, /December recovered/);
    assert.match(annotator.provider, /January recovered/);
    registry.destroy();
});

test("recovering an early month resumes loading until the remaining month answers", () => {
    const { pending, label, annotator, registry, host } = updatingCalendarFixture();
    pending.get("2026/12")(new Map(), "Holiday service unavailable", "Offline");
    assert.match(label.text, /⚠/);
    pending.get("2026/12")(new Map(), "", "Recovered");
    assert.equal(annotator.error, "");
    assert.match(label.text, /…$/);
    host.holidayGeneration++;
    pending.get("2027/1")(new Map(), "Holiday service unavailable", "Stale failure");
    assert.equal(annotator.error, "", "an obsolete pass cannot restore an old error");
    registry.destroy();
});

// T702: a 42-day grid spans two calendar years, each with its own cached
// status, so adjacent months are legitimately served by different fallback
// providers. Holidays from both were shown, but the annotator kept one
// provider string and the last callback to arrive supplied it alone — so
// completion timing decided which service got the credit.
test("the grid credits every provider that answered, whatever the order", () => {
    const runPass = (answerOrder) => {
        const pending = new Map();
        const label = new MockActor();
        const annotator = new AnnotationsModule.CalendarHolidayAnnotator(makeHost({
            holidayGeneration: 3,
            holidaysActive: () => true,
            requestHolidays(y, m, cb) {
                pending.set(`${y}/${m}`, cb);
            }
        }));
        annotator.attachLabel(label);
        annotator.annotate(new Set(["2026/12", "2027/1"]), new Map(), 3);

        // December is served by Nager.Date, January by Enrico
        const providers = { "2026/12": "Nager.Date", "2027/1": "Enrico" };
        for (const month of answerOrder) {
            pending.get(month)(new Map(), "", providers[month]);
        }
        return annotator;
    };

    const december_first = runPass(["2026/12", "2027/1"]);
    const january_first = runPass(["2027/1", "2026/12"]);

    const credit = (annotator) => annotator.monthLabel.tooltip.texts.at(-1);
    assert.ok(credit(december_first).includes("Enrico"));
    assert.ok(credit(december_first).includes("Nager.Date"),
        "both sources on the grid are named, not just the last one to answer");
    assert.equal(credit(december_first), credit(january_first),
        "and which one answered first cannot change what the user is told");

    // the same pass run twice renders the same string, so no repaint churn
    assert.equal(december_first.provider, "Enrico, Nager.Date");
});

// A failure still names the service that produced it: that is more use than a
// list of everyone who answered, and a sibling month's success must not soften
// an error that is still true.
test("a failed month keeps its own provider in the credit", () => {
    const pending = new Map();
    const label = new MockActor();
    const annotator = new AnnotationsModule.CalendarHolidayAnnotator(makeHost({
        holidayGeneration: 3,
        holidaysActive: () => true,
        requestHolidays(y, m, cb) {
            pending.set(`${y}/${m}`, cb);
        }
    }));
    annotator.attachLabel(label);
    annotator.annotate(new Set(["2026/12", "2027/1"]), new Map(), 3);

    pending.get("2026/12")(new Map(), "Holiday service unavailable", "Nager.Date");
    pending.get("2027/1")(new Map(), "", "Enrico");

    assert.equal(annotator.error, "Holiday service unavailable");
    assert.equal(annotator.provider, "Nager.Date",
        "the error names the service that failed, not the one that worked");
    assert.match(label.text, /⚠/);
});

// T842: setPending and setStatus both check monthLabel before touching it, and
// annotate()'s holidays-off branch — the third caller of _report — did not.
// release()'s own comment says a calendar that was never given a label is a
// contemplated state, so the guard belongs in _report, where it cannot be
// forgotten by the next caller.
test("a calendar with no month label can still be told holidays are off", () => {
    const reported = [];
    const cell = {
        button: new MockActor({ style_class: "calendar-holiday-day" }),
        holidayTooltip: null,
        holiday_tooltip_set: true,
        holiday_styled: true
    };
    const annotator = new AnnotationsModule.CalendarHolidayAnnotator(makeHost({
        holidaysActive: () => false,
        reportIssue: (source, text) => reported.push([source, text])
    }));

    assert.equal(annotator.monthLabel, null, "no header was ever built");
    assert.doesNotThrow(
        () => annotator.annotate(new Set(["2026/7"]), new Map([["7/14", cell]]), 0));

    assert.deepEqual(reported, [["holidays", ""]], "the footer is still cleared");
    assert.equal(cell.holiday_tooltip_set, false, "and the stale marks still come off");

    // the same tolerance for the two callers that reach _report through a write
    assert.doesNotThrow(() => annotator.setPending());
    assert.doesNotThrow(() => annotator.setStatus("Holiday service unavailable"));
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
        holidaysActive: () => true,
        requestHolidays(y, m, cb) {
            assert.equal(`${y}/${m}`, "2026/7");
            cb(new Map([["7/14", { name: "Bastille Day", flags: ["public_holiday"] }]]), "", "stub-provider");
        }
    });
    // the annotator renames the cell it just annotated through the host, rather
    // than reaching across for the calendar's cell renderer
    const cellRenderer = new CalendarModule.CalendarDayCellRenderer(host);
    host.nameCell = (target) => cellRenderer.applyAccessibleName(target);
    const annotator = new AnnotationsModule.CalendarHolidayAnnotator(host);
    annotator.attachLabel(label);

    cell.accessible_date = "Tuesday, 14 July 2026";
    cell.date = { year: 2026, month: 7, day: 14 };
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
    const css = fs.readFileSync(path.join(APPLET_DIR, "6.0", "stylesheet.css"), "utf8");
    assert.match(css, /\.calendar-holiday-day\s*\{[^}]+\}/,
        "the class has to draw something");

    // the tooltip is the only place the name appears, and a keyboard never
    // opens one
    assert.equal(cell.button.accessible_name, "Tuesday, 14 July 2026 — Bastille Day");
});

test("holiday annotation: part-day holidays keep workday style with 1-day weekends", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": { name: "Half day", flags: ["public_holiday", "PART_DAY_HOLIDAY"] } } });
    const cal = makeCalendar({ holiday });
    cal.weekend_length = 1;
    cal.setDate(civilDate(2026, 6, 9), true);
    const day14 = dayButtons(cal).find((b) => b.label === "14");
    assert.ok(day14.style_class.includes("calendar-work-day"));
});

test("holiday annotation: religious-only dates stay working days", () => {
    const holiday = makeHolidayStub({
        "2026/7": { "7/14": { name: "Local observance", flags: ["religious_holiday", "taoism"] } }
    });
    const cal = makeCalendar({ holiday });
    cal.setDate(civilDate(2026, 6, 9), true);
    const day14 = dayButtons(cal).find((button) => button.label === "14");

    assert.ok(day14.style_class.includes("calendar-work-day"));
    assert.ok(!day14.style_class.includes("calendar-nonwork-day"));
    assert.ok(day14.style_class.includes("calendar-holiday-day"),
        "the observance remains visible without being called a day off");
});

test("country observances require an explicit public flag to mark a day non-working", () => {
    for (const flags of [[], ["optional"], ["bank", "optional"], ["PART_DAY_HOLIDAY"]]) {
        const holiday = makeHolidayStub({
            "2026/7": { "7/14": { name: "Country observance", flags } }
        });
        const cal = makeCalendar({ holiday });
        cal.setDate(civilDate(2026, 6, 9), true);
        const day = dayButtons(cal).find((button) => button.label === "14");
        assert.ok(day.style_class.includes("calendar-work-day"));
        assert.ok(day.style_class.includes("calendar-holiday-day"));
        assert.ok(!day.style_class.includes("calendar-nonwork-day"));
    }
});

test("holiday annotation: merged public and religious dates are non-working", () => {
    const holiday = makeHolidayStub({
        "2026/7": {
            "7/14": { name: "Public holiday\nLocal observance", flags: ["public_holiday", "religious_holiday", "taoism"] }
        }
    });
    const cal = makeCalendar({ holiday });
    cal.setDate(civilDate(2026, 6, 9), true);
    const day14 = dayButtons(cal).find((button) => button.label === "14");

    assert.ok(!day14.style_class.includes("calendar-work-day"));
    assert.ok(day14.style_class.includes("calendar-nonwork-day"));
    assert.ok(day14.style_class.includes("calendar-holiday-day"));
});

test("custom calendar observances preserve working days and merge with days off", () => {
    const holiday = makeHolidayStub({ "2026/7": {
        "7/14": { name: "Team anniversary", flags: ["calendar_observance"] },
        "7/15": { name: "Team anniversary\nPublic holiday", flags: ["calendar_observance", "public_holiday"] }
    } });
    const cal = makeCalendar({ holiday });
    cal.setDate(civilDate(2026, 6, 9), true);
    const day14 = dayButtons(cal).find((button) => button.label === "14");
    const day15 = dayButtons(cal).find((button) => button.label === "15");
    assert.ok(day14.style_class.includes("calendar-work-day"));
    assert.ok(day14.style_class.includes("calendar-holiday-day"));
    assert.ok(!day14.style_class.includes("calendar-nonwork-day"));
    assert.ok(day15.style_class.includes("calendar-nonwork-day"));
    assert.ok(!day15.style_class.includes("calendar-work-day"));
});

test("holiday annotation: errors surface in the month label marker", () => {
    const holiday = makeHolidayStub({}, "Holiday service unavailable");
    const cal = makeCalendar({ holiday });
    cal.setDate(civilDate(2026, 6, 9), true);
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
    cal.setDate(civilDate(2026, 6, 9), true);
    const staleCb = savedCb;
    cal.setDate(civilDate(2026, 7, 9), true); // bumps generation
    const before = cal._monthLabel.text;
    staleCb(new Map(), "err", "stale");
    assert.equal(cal._monthLabel.text, before, "stale callback must not mutate state");
});

test("_isWorkDay derives the weekend from locale first_workday and length", () => {
    const firstWorkday = 1;
    for (let weekendLength of [1, 2]) {
        for (let day = 0; day < 7; day++) {
            // 2026-03-01 is a Sunday; day offsets map directly onto getDay()
            const date = civilDate(2026, 2, 1 + day);
            const expected = day !== (firstWorkday + 7 - weekendLength) % 7 &&
                day !== (firstWorkday + 6) % 7;
            assert.equal(CalendarModule._isWorkDay(DateMath.civilWeekday(date), weekendLength), expected,
                `day ${day} length ${weekendLength}`);
        }
        // exactly `weekendLength` days off per week
        let off = 0;
        for (let day = 0; day < 7; day++) {
            if (!CalendarModule._isWorkDay(day, weekendLength)) {
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

function allocateDots(count, boxWidth, maxRows = null, dotWidth = 10, dotHeight = 10) {
    const dots = Array.from({ length: count }, () => makeDot(dotWidth, dotHeight));
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
    dots.capacity = cal._gridView.allocateDotBox(
        actor, { x1: 0, y1: 0, x2: boxWidth, y2: 20 }, {});
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

// Clutter copies the box it is handed, so one box serves the whole allocation.
// This runs inside the allocate handler of all 42 day cells on every relayout
// of the grid, which is the reason a per-row construction is worth removing —
// and the row geometry above is what proves the reuse still resets every edge.
test("dot box: one ActorBox serves every row of an allocation", () => {
    const dots = Array.from({ length: 12 }, () => makeDot(10, 10));
    const actor = {
        get_children: () => dots,
        get_theme_node: () => ({ lookup_double: () => [true, 2] })
    };
    let constructed = 0;
    global.imports.gi.Clutter.ActorBox = class {
        constructor() {
            constructed++;
            this.x1 = 0;
            this.y1 = 0;
            this.x2 = 0;
            this.y2 = 0;
        }
    };

    const cal = makeCalendar();
    cal._gridView.allocateDotBox(actor, { x1: 0, y1: 0, x2: 100, y2: 20 }, {});
    assert.equal(constructed, 1, "two rows, one box");

    // ...and the second row still starts from its own centred origin rather
    // than continuing where the first one stopped
    const secondRow = dots.filter((dot) => dot.allocations[0].y1 === 10);
    assert.equal(secondRow.length, 2);
    assert.equal(secondRow[0].allocations[0].x1, 40, "10 wide, 2 dots, centred in 100");

    // an allocation with nothing to place builds no box at all
    constructed = 0;
    cal._gridView.allocateDotBox(
        { get_children: () => [] }, { x1: 0, y1: 0, x2: 100, y2: 20 }, {});
    assert.equal(constructed, 0);
});

test("dot box: dots that fit stay centered on one row", () => {
    const dots = allocateDots(3, 100);
    assert.equal(dots.capacity, 20, "the renderer receives the shared layout capacity");
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
    assert.equal(dots.capacity, 10);
    const allocated = dots.filter((d) => d.allocations.length);
    assert.equal(allocated.length, 10);
    assert.ok(allocated.every((d) => d.allocations[0].y1 === 0));
});

test("dot box: a dot wider than its cell still gets one slot per row", () => {
    const dots = allocateDots(3, 5, null, 10);
    assert.equal(dots.capacity, 2);
    assert.equal(dots[0].allocations.length, 1);
    assert.equal(dots[1].allocations.length, 1);
    assert.equal(dots[2].allocations.length, 0, "the default two-row limit still applies");
    assert.deepEqual(dots.slice(0, 2).map((dot) => dot.allocations[0].y1), [0, 10]);
});

test("dot box: invalid theme metrics fall back to visible positive dimensions", () => {
    const dots = allocateDots(3, 100, 0, 0, 0);
    assert.ok(dots.every((dot) => dot.allocations.length === 1));
    assert.ok(dots.every((dot) => dot.allocations[0].x2 - dot.allocations[0].x1 === 1));
    assert.ok(dots.every((dot) => dot.allocations[0].y2 - dot.allocations[0].y1 === 1));
});

test("dot box: empty box allocates nothing and does not throw", () => {
    const dots = allocateDots(0, 100);
    assert.equal(dots.length, 0);
});

test("settings churn rebuilds the header only when week geometry changes", () => {
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 6, 9), true);
    const headerBefore = cal._monthLabel;

    cal._onGridGeometryChanged();
    assert.equal(cal._monthLabel, headerBefore, "same geometry: header actors kept");

    cal.show_week_numbers = !cal.show_week_numbers;
    cal._onGridGeometryChanged();
    assert.notEqual(cal._monthLabel, headerBefore, "geometry change rebuilds header");
});

// T977: the desktop first-day-of-week handler is the only caller that may move
// the week start; the two bind-path callers never could, because Cinnamon
// invokes them as (value, user_data) and the old key test never matched.
test("the first-weekday handler recomputes the week start and rebuilds", () => {
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 6, 9), true);
    const headerBefore = cal._monthLabel;
    assert.equal(cal._weekStart, 0);

    global.imports.gi.Cinnamon.util_get_week_start = () => 1;
    try {
        cal._onFirstWeekdayChanged();
        cal._onFirstWeekdayChanged();
    } finally {
        global.imports.gi.Cinnamon.util_get_week_start = () => 0;
    }

    assert.equal(cal._weekStart, 1, "week start comes from the desktop");
    assert.notEqual(cal._monthLabel, headerBefore, "week geometry moved: header rebuilt");
    assert.deepEqual(cal.events_manager.selections,
        [{ date: civilDate(2026, 6, 9), force: true }],
        "refresh the selected date once per effective weekday change");
});

test("desktop weekday changes fetch the exact calendar grid without changing the selected date", (t) => {
    const { EventWindowCoordinator } = require(path.join(APPLET_DIR, "eventWindow.js"));
    const { EventIndex } = require(path.join(APPLET_DIR, "eventIndex.js"));
    const coordinator = new EventWindowCoordinator(new EventIndex());
    const requests = [];
    const manager = makeEventsManager();
    manager.select_date = (date, force) => coordinator.selectDate(date, force,
        manager.is_active,
        (month, forced) => coordinator.fetchMonthEvents(month, forced,
            (start, end, force) => requests.push({ start, end, force }), () => 1, () => {}),
        () => {});
    const settings = makeDesktopSettings();
    let onWeekdayChanged;
    settings.connectFirstDayOfWeekChanged = (callback) => {
        onWeekdayChanged = callback;
        return 1;
    };
    const getWeekStart = global.imports.gi.Cinnamon.util_get_week_start;
    t.after(() => { global.imports.gi.Cinnamon.util_get_week_start = getWeekStart; });
    const cal = new CalendarModule.Calendar(makeSettings(), manager, null, settings);
    t.after(() => cal.destroy());
    const selected = civilDate(2026, 7, 15);
    cal.setDate(selected, true);
    manager.select_date(selected, false);
    const unix = (year, month, day, hour = 0, minute = 0, second = 0) =>
        new Date(year, month - 1, day, hour, minute, second).getTime() / 1000;
    const dayUnix = (date) => unix(date.year, date.month, date.day);
    assert.deepEqual(requests, [{
        start: unix(2026, 7, 26), end: unix(2026, 9, 5, 23, 59, 59), force: false
    }]);

    global.imports.gi.Cinnamon.util_get_week_start = () => 1;
    onWeekdayChanged();
    assert.equal(DateMath.civilDayNumber(cal._selectedDate), DateMath.civilDayNumber(selected));
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], {
        start: unix(2026, 7, 27), end: unix(2026, 9, 6, 23, 59, 59), force: true
    });
    assert.equal(dayUnix(cal._gridView.dayCells[0].date), requests[1].start);
    assert.equal(dayUnix(cal._gridView.dayCells.at(-1).date),
        unix(2026, 9, 6));
    onWeekdayChanged();
    assert.equal(requests.length, 2, "duplicate settings notifications do not refetch");

    manager.is_active = () => false;
    global.imports.gi.Cinnamon.util_get_week_start = () => 0;
    onWeekdayChanged();
    assert.equal(requests.length, 2, "a disabled event provider is not fetched");
    assert.equal(cal._weekStart, 0, "the calendar still adopts the weekday setting");
});

// T978: destroy() cancelled the pending idle but set no flag, so any later
// refresh re-armed it and _update() rebuilt 42 cells and tooltips into a
// destroyed St.Table — _gridView.reset() having emptied dayCells.
test("a refresh after Calendar.destroy neither queues nor renders", () => {
    const callbacks = [];
    const idleAdd = global.imports.mainloop.idle_add;
    global.imports.mainloop.idle_add = (cb) => {
        callbacks.push(cb);
        return callbacks.length;
    };
    try {
        const cal = makeCalendar();
        cal.setDate(civilDate(2026, 6, 9), true);
        cal.destroy();
        callbacks.length = 0;

        cal.refreshToday();
        cal.refreshHolidays();
        cal.refreshTimezone();
        cal.refreshEventDataAvailability();

        assert.deepEqual(callbacks, [], "no idle is re-armed after destroy");
        assert.equal(cal._update_id, 0);

        cal._update();
        assert.deepEqual(cal._gridView.dayCells, [],
            "a direct update builds no cells into the destroyed table");
    } finally {
        global.imports.mainloop.idle_add = idleAdd;
    }
});

test("Calendar.destroy disconnects its events-manager signals", () => {
    const manager = makeEventsManager();
    const cal = new CalendarModule.Calendar(makeSettings(), manager, null, makeDesktopSettings());
    cal.destroy();
    assert.deepEqual(manager.disconnected, [1, 2, 3]);
});

// Cinnamon's Applet has no destroy() and AppletContextMenu holds the actor,
// which holds _delegate — so the applet survives its own removal from the
// panel, and anything the grid is still holding survives with it for the rest
// of the login session. The cell arrays were already released here; the cached
// month and the annotator's matched holidays were not.
test("Calendar.destroy releases the cached month and the matched holidays", () => {
    const cal = makeCalendar({
        holiday: makeHolidayStub({ "2026/7": { "7/14": { name: "Bastille Day", flags: [] } } })
    });
    cal.setDate(civilDate(2026, 6, 9), true);

    assert.ok(cal._monthWindows._window, "a month window is held while it is shown");
    assert.equal(cal._monthWindows._window.days.length, 42);
    assert.equal(cal._holidayAnnotator._dates.size, 1);
    assert.ok(cal.holidayForDate(civilDate(2026, 6, 14)));
    assert.equal(cal._holidayAnnotator.annotated, true);

    cal.destroy();

    assert.equal(cal._monthWindows._window, null,
        "42 Dates, 42 day keys and 42 formatted day names");
    assert.equal(cal._holidayAnnotator._dates.size, 0);
    assert.equal(cal.holidayForDate(civilDate(2026, 6, 14)), null);
    assert.equal(cal._holidayAnnotator.annotated, false);
    assert.deepEqual(cal._gridView.dayCells, [], "as before, the cells go too");
});

// T29a: day cells are cached and reused across updates

test("day cells: month navigation reuses the same actors", () => {
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 6, 9), true);
    const before = dayButtons(cal);
    assert.equal(before.length, 42);

    cal.setDate(civilDate(2026, 7, 9), true);
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
    cal.setDate(civilDate(2026, 6, 9), true);
    const button = dayButtons(cal)[6]; // July grid: 2026-07-04

    cal.setDate(civilDate(2026, 7, 9), true); // August grid: same slot is 08-01
    button.fire("clicked");

    assert.equal((cal.getSelectedDate().month - 1), 7);
    assert.equal(cal.getSelectedDate().day, 1);
});

test("day cells: holiday annotations do not leak into the next month", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": { name: "Bastille Day", flags: ["public_holiday"] } } });
    const cal = makeCalendar({ holiday });
    cal.setDate(civilDate(2026, 6, 14), true);
    const day14 = dayButtons(cal).find((b) => b.label === "14" &&
        b.style_class.includes("calendar-nonwork-day"));
    assert.ok(day14);
    assert.ok(day14.pseudo.has("selected"));

    cal.setDate(civilDate(2026, 7, 9), true);
    // same actor now shows an August date (a Tuesday): style fully reset
    assert.equal(day14.label, "11");
    assert.ok(!day14.style_class.includes("calendar-nonwork-day"));
    assert.ok(!day14.pseudo.has("selected"));
    // and its tooltip went with the annotation
    const cell = cal._gridView.dayCells.find((c) => c.button === day14);
    assert.equal(cell.holidayTooltip, null);
});

test("day cells: geometry change rebuilds the grid with week-number labels", () => {
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 6, 9), true);
    const before = dayButtons(cal);
    assert.equal(cal._gridView.weekLabels.length, 0);

    cal.show_week_numbers = true;
    cal._onGridGeometryChanged();

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
    cal.setDate(civilDate(2026, 6, 9), true);
    const before = dayButtons(cal);

    let rebuilds = 0;
    const buildHeader = cal._buildHeader.bind(cal);
    cal._buildHeader = function() {
        rebuilds++;
        return buildHeader();
    };

    cal._update(); // same-month refresh, e.g. events-updated
    cal.setDate(civilDate(2026, 7, 9), true); // month navigation
    cal.weekend_length = 1;
    cal._onGridGeometryChanged(); // style-only setting

    assert.equal(rebuilds, 0);
    const after = dayButtons(cal);
    assert.equal(after.length, 42);
    for (let i = 0; i < 42; i++) {
        assert.equal(after[i], before[i], `cell ${i} must survive incremental refreshes`);
    }

    cal.show_week_numbers = true;
    cal._onGridGeometryChanged();
    assert.equal(rebuilds, 1, "week-number geometry still rebuilds the grid");
});

// T68 regression: a weekend-length change must restyle the weekday headings
// even though it no longer rebuilds the header
test("weekend-length change restyles the weekday headings without a rebuild", () => {
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 6, 9), true);

    assert.equal(cal._gridView.dayHeadings.length, 7);
    const before = cal._gridView.dayHeadings.map((h) => h.label);
    const nonwork = () => cal._gridView.dayHeadings
        .filter((h) => h.label.style_class.includes("calendar-nonwork-day"))
        .map((h) => h.weekday)
        .sort();
    assert.equal(nonwork().length, 2, "two weekend headings with the default length");

    let rebuilds = 0;
    const buildHeader = cal._buildHeader.bind(cal);
    cal._buildHeader = function() {
        rebuilds++;
        return buildHeader();
    };

    cal.weekend_length = 1;
    cal._onGridGeometryChanged();

    assert.equal(rebuilds, 0, "weekend length is style-only, no rebuild");
    assert.equal(nonwork().length, 1, "one weekend heading after the change");
    cal._gridView.dayHeadings.forEach((heading, i) => {
        assert.equal(heading.label, before[i], "heading actors are reused");
        const expected = CalendarModule._isWorkDay(heading.weekday, 1) ?
            "calendar-work-day" : "calendar-nonwork-day";
        assert.ok(heading.label.style_class.includes(expected),
            `heading for day ${heading.weekday} restyled`);
    });

    // headings and day cells must agree on which days are the weekend
    const headingNonwork = new Set(nonwork());
    cal._gridView.dayCells.forEach((cell) => {
        assert.equal(cell.button.style_class.includes("calendar-nonwork-day") &&
            !cell.holiday_styled,
        headingNonwork.has(DateMath.civilWeekday(cell.date)),
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
        // duplicates its heading; weekday-number headings do not walk instants.
        cal._selectedDate = civilDate(2026, 10, 1, 0, 30);
        cal._buildHeader();

        assert.deepEqual(cal._gridView.dayHeadings.map((heading) => heading.weekday),
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
    cal.setDate(civilDate(2026, 6, 9), true);
    assert.equal(cal._weekdateHeader, null, "no gutter header without week numbers");

    cal.show_week_numbers = true;
    cal._onGridGeometryChanged();

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
    cal._onGridGeometryChanged();
    assert.equal(cal._weekdateHeader, null, "gutter header cleared on rebuild");
});

// seeded fuzz: random navigation keeps the cached grid consistent
test("fuzz: cached grid stays consistent across random navigation", () => {
    const rand = makeRandom(20260709);
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 6, 9), true);
    const original = dayButtons(cal);

    for (let i = 0; i < 250; i++) {
        const date = civilDate(2000 + Math.floor(rand() * 50), Math.floor(rand() * 12), 1 + Math.floor(rand() * 28), 12, 0, 0);
        cal.setDate(date, rand() < 0.2);

        const buttons = dayButtons(cal);
        assert.equal(buttons.length, 42);
        for (let j = 0; j < 42; j++) {
            assert.equal(buttons[j], original[j], `iteration ${i}: cell ${j} reused`);
        }

        // recompute the expected grid start independently
        const begin = new Date(0);
        begin.setUTCFullYear(date.year, (date.month - 1), 1);
        begin.setUTCDate(1 - begin.getUTCDay());
        for (let j = 0; j < 42; j += 5) {
            const expected = new Date(begin.getTime() + j * 86400000);
            assert.equal(buttons[j].label, String(expected.getUTCDate()),
                `iteration ${i}: cell ${j} shows the right day`);
        }

        const selected = buttons.filter((b) => b.pseudo.has("selected"));
        assert.equal(selected.length, 1, `iteration ${i}: exactly one selected`);
        assert.equal(selected[0].label, String(date.day));
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
    cal.setDate(civilDate(2026, 6, 9), true);

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
    cal.setDate(civilDate(2026, 6, 9), true);

    const expected = new CalendarModule.CalendarMonthWindow(
        civilDate(2026, 6, 9), cal._weekStart).dateUnixKeys;
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
        c.date.month === month + 1 && c.date.day === day);
}

test("in place: dot actors are reused and restyled when colors change", () => {
    const { cal, colorsByDay } = makeColorCalendar();
    colorsByDay.set("6/9", ["#111111", "#222222"]);
    cal.setDate(civilDate(2026, 6, 9), true);

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
    cal.setDate(civilDate(2026, 6, 9), true);

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
    cal.setDate(civilDate(2026, 6, 9), true);
    const day9 = dayButtons(cal).find((b) => b.pseudo.has("selected"));

    cal.setDate(civilDate(2026, 6, 10), false);
    assert.ok(!day9.pseudo.has("selected"));
    const selected = dayButtons(cal).filter((b) => b.pseudo.has("selected"));
    assert.equal(selected.length, 1);
    assert.equal(selected[0].label, "10");
});

test("in place: a holiday cell never accumulates duplicate style classes", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": { name: "Bastille Day", flags: ["public_holiday"] } } });
    const cal = makeCalendar({ holiday });
    cal.setDate(civilDate(2026, 6, 9), true);
    cal._update();
    cal._update();

    const day14 = cal._gridView.dayCells.find((c) => c.date.month === 7 &&
        c.date.day === 14).button;
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
    cal.setDate(civilDate(2026, 6, 9), true);
    const palette = ["#101010", "#202020", "red", "rgb(1,2,3)", "bad;value"];

    for (let i = 0; i < 200; i++) {
        const day = mutateDayColors(rand, colorsByDay, palette);
        cal._update();
        assertRenderedDots(cal, colorsByDay, i);
        assertStableDay(cal, day, i);
    }
});

test("an inactive provider is never queried", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": { name: "X", flags: [] } } });
    holiday.active = false;
    const cal = makeCalendar({ holiday });
    cal.setDate(civilDate(2026, 6, 9), true);
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

    const queuedDate = civilDate(2026, 10, 5);
    let setDateArgs = null;
    cal.setDate = (...args) => { setDateArgs = args; };
    cal.queue_set_date(queuedDate);
    cal.queue_set_date(civilDate(2026, 10, 6));
    assert.equal(cal._navigation.setDateIdleId, 13);
    assert.equal(callbacks.at(-1)(), false);
    assert.equal(setDateArgs[0].day, 6);
    assert.equal(setDateArgs[1], false);
});

test("calendar wrappers cover scroll, style, holiday refresh, and selected-date helpers", () => {
    const cal = makeCalendar();
    const actions = [];
    cal._navigation.applyBrowse = (year, month) => actions.push([year, month]);
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
    cal._update_event_data_availability();
    assert.equal(queued, 3);
    assert.equal(cal.event_data_available, true);

    cal._selectedDate = civilDate();
    assert.deepEqual(cal.getSelectedDate(), cal._selectedDate);
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

    headerNavButton(cal._topBoxMonth, "calendar-change-month-back").fire("clicked");
    headerNavButton(cal._topBoxMonth, "calendar-change-month-forward").fire("clicked");
    headerNavButton(cal._topBoxYear, "calendar-change-month-back").fire("clicked");
    headerNavButton(cal._topBoxYear, "calendar-change-month-forward").fire("clicked");

    assert.deepEqual(actions, [[0, -1], [0, 1], [-1, 0], [1, 0]],
        "previous month, next month, previous year, next year");
});

test("event-unavailable calendars keep every header navigation button live", () => {
    const cal = makeCalendar();
    const selected = civilDate(2026, 6, 9);
    cal.event_data_available = false;

    for (const [box, styleClass, expectedYear, expectedMonth] of [
        [cal._topBoxMonth, "calendar-change-month-back", 2026, 5],
        [cal._topBoxMonth, "calendar-change-month-forward", 2026, 7],
        [cal._topBoxYear, "calendar-change-month-back", 2025, 6],
        [cal._topBoxYear, "calendar-change-month-forward", 2027, 6]
    ]) {
        cal.setDate(selected, true);
        headerNavButton(box, styleClass).fire("clicked");
        cal._navigation.flushQueuedDate();
        assert.equal(cal.getSelectedDate().year, expectedYear);
        assert.equal((cal.getSelectedDate().month - 1), expectedMonth);
    }
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
    cal._navigation.applyBrowse = (year, month) => actions.push([year, month]);

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
        const source = civilDate(2000 + Math.floor(rand() * 40), Math.floor(rand() * 12), 1 + Math.floor(rand() * 28));
        cal._selectedDate = source;
        let queued = null;
        cal.queue_set_date = (date) => { queued = date; };
        const op = Math.floor(rand() * 4);
        [cal._onPrevYearButtonClicked, cal._onNextYearButtonClicked,
            cal._onPrevMonthButtonClicked, cal._onNextMonthButtonClicked][op].call(cal);
        assert.deepEqual(Object.keys(queued).sort(), ["day", "month", "year"]);
        assert.ok(queued.day >= 1);
        assert.ok(queued.day <= 31);
    }
});

// Left and Right are directions on the screen, not in time. St mirrors the grid
// in an RTL locale, so the cell to the left of Tuesday is Wednesday — and the
// arrows were walking the selection the wrong way for every Arabic and Hebrew
// user. Cinnamon's own popupMenu.js asks the same question of the same actor.
test("the arrow keys follow the grid, not the calendar, in an RTL locale", () => {
    const cal = makeCalendar();
    const St = global.imports.gi.St;
    cal.setDate(civilDate(2026, 6, 9), true);
    cal.actor.get_direction = () => St.TextDirection.RTL;

    const focusFirstCell = () => {
        const cell = dayButtons(cal).find((b) => b.label === "9");
        global.stage = { get_key_focus: () => cell };
    };

    focusFirstCell();
    cal.actor.fire("key-press-event", { get_key_symbol: () => 65361 }); // Left
    cal._navigation.flushQueuedDate();
    assert.equal(cal.getSelectedDate().day, 10,
        "in a mirrored grid, Left is the next day");

    focusFirstCell();
    cal.actor.fire("key-press-event", { get_key_symbol: () => 65363 }); // Right
    cal._navigation.flushQueuedDate();
    assert.equal(cal.getSelectedDate().day, 9, "and Right is the previous one");

    // up and down are not mirrored: a week is a week
    focusFirstCell();
    cal.actor.fire("key-press-event", { get_key_symbol: () => 65364 }); // Down
    cal._navigation.flushQueuedDate();
    assert.equal(cal.getSelectedDate().day, 16);

    // ...and an LTR grid is unchanged
    cal.actor.get_direction = () => St.TextDirection.LTR;
    cal.setDate(civilDate(2026, 6, 9), true);
    focusFirstCell();
    cal.actor.fire("key-press-event", { get_key_symbol: () => 65361 });
    cal._navigation.flushQueuedDate();
    assert.equal(cal.getSelectedDate().day, 8);

    global.stage = undefined;
});

// queue_set_date holds the new date for 25 ms so a burst of scroll notches costs
// one grid rebuild. The browse action read the *committed* date, which the queued
// setDate has not written yet — so every notch in the burst recomputed from the
// same starting month and overwrote the last. Three notches in 30 ms moved the
// calendar one month, and a held PageDown did the same.
test("a burst of month changes accumulates instead of overwriting itself", () => {
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 0, 15), true);

    // three scroll notches inside the coalescing window: the idle has not run
    cal._onNextMonthButtonClicked();
    cal._onNextMonthButtonClicked();
    cal._onNextMonthButtonClicked();

    assert.equal((cal._navigation.queuedDate.month - 1), 3, "three notches are three months");
    assert.equal(cal._navigation.queuedDate.year, 2026);

    // the coalesced date lands once
    cal._navigation.flushQueuedDate();
    assert.equal((cal.getSelectedDate().month - 1), 3);

    // ...and it still rolls the year correctly across December
    cal.setDate(civilDate(2026, 10, 15), true);
    cal._onNextMonthButtonClicked();
    cal._onNextMonthButtonClicked();
    cal._onNextMonthButtonClicked();
    assert.equal(cal._navigation.queuedDate.year, 2027);
    assert.equal((cal._navigation.queuedDate.month - 1), 1);

    // and back the other way
    cal._navigation.flushQueuedDate();
    cal._onPrevMonthButtonClicked();
    cal._onPrevMonthButtonClicked();
    assert.equal(cal._navigation.queuedDate.year, 2026);
    assert.equal((cal._navigation.queuedDate.month - 1), 11);
});

test("a direct selection cancels a pending month browse", () => {
    const removed = [];
    global.imports.mainloop.source_remove = (id) => removed.push(id);
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 0, 15), true);

    cal._navigation.focusAfterSetDate = true;
    cal._onNextMonthButtonClicked();
    const pendingId = cal._navigation.setDateIdleId;
    const direct = civilDate(2026, 0, 20);
    cal.setDate(direct, false);

    assert.deepEqual(removed, [pendingId]);
    assert.equal(cal._navigation.queuedDate, null);
    assert.equal(cal._navigation.setDateIdleId, 0);
    assert.equal(cal._navigation.focusAfterSetDate, false);
    assert.equal(DateMath.civilDayNumber(cal.getSelectedDate()), DateMath.civilDayNumber(direct));

    cal._navigation.flushQueuedDate();
    assert.equal(DateMath.civilDayNumber(cal.getSelectedDate()), DateMath.civilDayNumber(direct),
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
    const holiday = makeHolidayStub({ "2026/7": { "7/14": { name: "Bastille Day", flags: [] } } });
    const cal = makeCalendar({ holiday });
    cal.setDate(civilDate(2026, 6, 9), true);

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

// The 42 cells are reused for every month, and a cell only ever grew a Tooltip
// — it never gave one back, so browsing a holiday-heavy country left all 42
// holding one on a month with two. Each carries seven Cinnamon signal
// connections, one of them on global.stage, and its own Gio.Settings.
test("a day cell hands its holiday tooltip back when it stops being a holiday", () => {
    const datesByMonth = { "2026/7": {
        "7/14": { name: "Bastille Day", flags: [] }, "7/15": { name: "Assumption", flags: [] }
    } };
    const cal = makeCalendar({ holiday: makeHolidayStub(datesByMonth) });
    cal.setDate(civilDate(2026, 6, 9), true);

    const day14 = cal._gridView.dayCells.find((cell) => cell.button.label === "14");
    const day15 = cal._gridView.dayCells.find((cell) => cell.button.label === "15");
    const held = () => cal._gridView.dayCells.filter((cell) => cell.holidayTooltip).length;
    assert.equal(held(), 2, "one per annotated day");
    const first = day14.holidayTooltip;
    const liveAfterAnnotating = Tooltips.live;

    // the month loses one of its holidays
    delete datesByMonth["2026/7"]["7/14"];
    cal._update();
    assert.equal(day14.holidayTooltip, null);
    assert.equal(first.destroyed, true, "the tooltip is destroyed, not merely blanked");
    assert.equal(Tooltips.live, liveAfterAnnotating - 1, "and it is not replaced");
    assert.equal(held(), 1, "only the day that still has one keeps it");
    assert.equal(day15.holidayTooltip.destroyed, false);

    // ...and the day can become a holiday again. A replacement Tooltip starts
    // empty, so the text last written to the destroyed one must not go on
    // suppressing the first write to its successor.
    datesByMonth["2026/7"]["7/14"] = { name: "Bastille Day", flags: [] };
    cal._update();
    assert.notEqual(day14.holidayTooltip, null);
    assert.notEqual(day14.holidayTooltip, first, "a fresh one, not the destroyed one");
    assert.equal(day14.holidayTooltip.texts.at(-1), "Bastille Day",
        "and it actually says the holiday's name");
});

// Switching holidays off leaves the marks of a country the user is no longer
// asking about: the cells keep their dates, so nothing in the grid pass clears
// them, and the annotator used to return early without touching them.
test("switching holidays off clears the marks they left", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": { name: "Bastille Day", flags: [] } } });
    const cal = makeCalendar({ holiday });
    cal.setDate(civilDate(2026, 6, 9), true);

    const day14 = cal._gridView.dayCells.find((cell) => cell.button.label === "14");
    assert.equal(day14.holiday_name, "Bastille Day");
    assert.ok(day14.button.style_class.includes("calendar-holiday-day"));
    assert.match(day14.button.accessible_name, /Bastille Day/);

    // the user picks "None (disable holidays)"
    holiday.active = false;
    cal.refreshHolidays();
    cal._update();

    assert.equal(day14.holiday_name, "", "the name goes");
    assert.equal(day14.holidayTooltip, null, "and the tooltip goes with it");
    assert.equal(day14.holiday_tooltip_set, false);
    assert.doesNotMatch(day14.button.accessible_name, /Bastille Day/,
        "and the cell stops announcing a holiday the user turned off");
    assert.equal(cal._holidayReasonLabel.visible, false);
});

// Country, region and religion changes all keep the provider active and repaint
// through the same contract. The new pass must replace that contract's complete
// result, not merely overlay it onto the previous configuration's cells.
test("an active holiday configuration replaces its old annotations", () => {
    const datesByMonth = { "2026/7": { "7/14": { name: "Bastille Day", flags: [] } } };
    const holiday = makeHolidayStub(datesByMonth);
    const cal = makeCalendar({ holiday });
    cal.setDate(civilDate(2026, 6, 9), true);

    const day14 = cal._gridView.dayCells.find((cell) => cell.button.label === "14");
    const day15 = cal._gridView.dayCells.find((cell) => cell.button.label === "15");
    assert.equal(day14.holiday_name, "Bastille Day");

    datesByMonth["2026/7"] = {
        "7/15": { name: "Replacement observance", flags: ["religious_holiday"] }
    };
    cal._update();

    assert.equal(day14.holiday_name, "");
    assert.equal(day14.holidayTooltip, null);
    assert.equal(day14.holiday_tooltip_set, false);
    assert.doesNotMatch(day14.button.accessible_name, /Bastille Day/);
    assert.equal(day15.holiday_name, "Replacement observance");
    assert.equal(day15.holidayTooltip.texts.at(-1), "Replacement observance",
        "the day that gained one gets a working tooltip, not a silenced one");
    assert.match(day15.button.accessible_name, /Replacement observance/);
});

test("holiday reconciliation waits for every displayed month", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": { name: "Bastille Day", flags: [] } } });
    const cal = makeCalendar({ holiday });
    cal.setDate(civilDate(2026, 6, 9), true);

    const day14 = cal._gridView.dayCells.find((cell) => cell.button.label === "14");
    const day15 = cal._gridView.dayCells.find((cell) => cell.button.label === "15");
    const pending = new Map();
    holiday.getHolidays = (y, m, callback) => pending.set(`${y}/${m}`, callback);
    cal._update();

    pending.get("2026/7")(new Map([
        ["7/15", { name: "Replacement observance", flags: ["religious_holiday"] }]
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

// T707: at session start the LC_TIME locale answer rebuilds the header while the
// holiday cache read is still in flight. The rebuild destroys all 42 day-cell
// actors, but the pass guard only watched for a *newer pass*, so the async
// answer annotated disposed buttons — eleven Gjs-CRITICALs per login.
test("a header rebuild strands the annotation pass that captured the old cells", () => {
    const holiday = makeHolidayStub({ "2026/7": { "7/14": { name: "Bastille Day", flags: [] } } });
    const cal = makeCalendar({ holiday });
    cal.setDate(civilDate(2026, 6, 9), true);

    const oldDay15 = cal._gridView.dayCells.find((cell) => cell.button.label === "15");
    const pending = new Map();
    holiday.getHolidays = (y, m, callback) => pending.set(`${y}/${m}`, callback);
    cal._update();

    // the locale answer lands: header rebuilt, every old day cell destroyed
    cal._buildHeader();

    // ...then the holiday answer for the stranded pass arrives
    for (const callback of pending.values()) {
        callback(new Map([
            ["7/15", { name: "Replacement observance", flags: ["religious_holiday"] }]
        ]), "", "stub-provider");
    }

    assert.equal(oldDay15.holiday_name || "", "",
        "a stranded pass must not annotate cells that died with the rebuild");
    assert.equal(cal.holidayForDate(civilDate(2026, 6, 15)), null,
        "nor publish dates the visible grid does not carry");

    // the next update owns fresh cells and annotates them normally
    const restored = makeHolidayStub({ "2026/7": { "7/14": { name: "Bastille Day", flags: [] } } });
    holiday.getHolidays = restored.getHolidays.bind(restored);
    cal._update();
    const newDay14 = cal._gridView.dayCells.find((cell) => cell.button.label === "14");
    assert.equal(newDay14.holiday_name, "Bastille Day");
});

// All 42 day cells were can_focus, so the grid was 42 tab stops. From the cell the
// menu focuses on open, a keyboard user pressed Tab up to 42 times to reach the
// world clocks or "Date and Time Settings" — and there was no way out of the grid
// at all. A date grid is one composite widget: one tab stop, with the arrows
// moving inside it, which is what the arrow-key navigation is there for.
test("the grid is one tab stop, and it moves with the selection", () => {
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 6, 9), true);

    const focusable = () => cal._gridView.dayCells.filter((cell) => cell.button.can_focus);

    assert.equal(focusable().length, 1, "one tab stop, not forty-two");
    assert.equal(focusable()[0].button.label, "9", "and it is the selected day");

    // the selection moves: so does the tab stop
    cal.setDate(civilDate(2026, 6, 14), false);

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
    cal.setDate(civilDate(2026, 6, 9), true);

    const navButton = cal.actor.get_children()
        .flatMap((child) => (child.children || []))
        .find((child) => child.accessible_name === "Next year");
    assert.ok(navButton, "the year button exists");
    global.stage = { get_key_focus: () => navButton };

    for (const symbol of [65365, 65366, 65360]) { // Page_Up, Page_Down, Home
        const result = cal.actor.fire("key-press-event", { get_key_symbol: () => symbol });
        void result;
    }

    assert.equal((cal.getSelectedDate().month - 1), 6,
        "the month does not move while the user is operating a button");
    assert.equal(cal._navigation.queuedDate, null);

    // ...and from a day cell they still work
    const day = dayButtons(cal).find((b) => b.label === "9");
    global.stage = { get_key_focus: () => day };
    cal.actor.fire("key-press-event", { get_key_symbol: () => 65366 });
    assert.equal((cal._navigation.queuedDate.month - 1), 7, "PageDown from the grid is next month");

    global.stage = undefined;
});

// _update() runs on every menu open, settings change and event delivery. The
// month name beside it is memoised; the year was not — a fresh GLib.DateTime and
// a strftime every pass, for a value that changes once a year.
test("the year label is not reformatted on every update", () => {
    const cal = makeCalendar();
    cal.setDate(civilDate(2026, 6, 9), true);

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

    cal.setDate(civilDate(2027, 6, 9), false);
    assert.deepEqual(writes, ["2027"], "and a new one is");
});


test("calendar scroll signals consume month browsing and propagate ignored input", () => {
    const cal = makeCalendar();
    const { ScrollDirection, EVENT_STOP, EVENT_PROPAGATE } = global.imports.gi.Clutter;
    const actions = [];
    cal._navigation.applyBrowse = (...args) => actions.push(args);
    const dispatch = (direction, delta = [0, 0]) => cal.actor.handlers["scroll-event"][0](cal.actor, {
        get_scroll_direction: () => direction,
        get_scroll_delta: () => delta
    });

    for (const direction of [ScrollDirection.UP, ScrollDirection.DOWN,
        ScrollDirection.LEFT, ScrollDirection.RIGHT]) {
        assert.equal(dispatch(direction), EVENT_STOP);
    }
    assert.deepEqual(actions, [[0, -1], [0, 1], [0, -1], [0, 1]]);
    actions.length = 0;
    for (let i = 0; i < 4; i++) {
        assert.equal(dispatch(ScrollDirection.SMOOTH, [0, 0.25]), EVENT_STOP,
            "fractions are consumed even before they form a month notch");
    }
    assert.deepEqual(actions, [[0, 1]]);

    for (const delta of [[0, 0], [NaN, 1], [1, NaN], [Infinity, 0], [0, -Infinity]]) {
        assert.equal(dispatch(ScrollDirection.SMOOTH, delta), EVENT_PROPAGATE);
    }
    assert.equal(dispatch(-1), EVENT_PROPAGATE);
    assert.deepEqual(actions, [[0, 1]], "ignored input never queues navigation");
});


test("selection observers can focus today after returning from a distant month", () => {
    const cal = makeCalendar();
    const today = cal.getSelectedDate();
    cal._navigation.applyBrowse(0, -3);
    cal._navigation.flushQueuedDate();
    let notifications = 0;
    cal._navigation.port.emitSelected = () => {
        notifications++;
        assert.equal(cal.focusSelectedDay(), true, "the target month must exist before notification");
        const selectedCell = cal._gridView.dayCells.find(cell => cell.selected);
        assert.equal(MockActor.focused, selectedCell.button);
    };

    assert.equal(cal.setDate(today, false), true);
    assert.equal(notifications, 1);
    assert.equal(cal.todaySelected(), true);
    assert.equal(cal.setDate(today, false), false);
    assert.equal(cal.setDate(today, true), false);
    assert.equal(notifications, 1, "unchanged and forced same-day renders do not notify selection");
});

function installRebuildFocusStage(t) {
    const previous = global.stage;
    const stage = { focus: null, menuOpen: true, get_key_focus() { return this.focus; } };
    global.stage = stage;
    t.after(() => { global.stage = previous; });
    t.mock.method(MockActor.prototype, "grab_key_focus", function() {
        const old = stage.focus;
        stage.focus = this;
        old?.fire("key-focus-out");
        this.fire("key-focus-in");
    });
    // Cinnamon's popup manager closes the menu when destruction clears focus.
    // The usual lightweight actor fixture does not model recursive destruction.
    t.mock.method(MockActor.prototype, "destroy_all_children", function() {
        this.children.forEach(child => child.destroy());
        this.children = [];
        this.placements = [];
    });
    t.mock.method(MockActor.prototype, "destroy", function() {
        this.destroy_all_children();
        this.destroyed = true;
        if (stage.focus === this) {
            stage.focus = null;
            stage.menuOpen = false;
            this.fire("key-focus-out");
        }
    });
    return stage;
}

function makeRebuildFocusHarness(t) {
    const stage = installRebuildFocusStage(t);
    const pending = new Map();
    let nextId = 1;
    t.mock.method(global.imports.mainloop, "idle_add", callback => {
        const id = nextId++;
        pending.set(id, callback);
        return id;
    });
    t.mock.method(global.imports.mainloop, "source_remove", id => pending.delete(id));
    const changes = {};
    const settings = makeSettings();
    settings.bindShowWeekNumbers = (object, property, callback) => {
        object[property] = false;
        changes.weekNumbers = () => {
            object[property] = !object[property];
            callback.call(object);
        };
    };
    let weekStart = 0;
    t.mock.method(global.imports.gi.Cinnamon, "util_get_week_start", () => weekStart);
    const desktop = makeDesktopSettings();
    desktop.connectFirstDayOfWeekChanged = callback => {
        changes.firstWeekday = () => { weekStart = (weekStart + 1) % 7; callback(); };
        return [1];
    };
    const locale = global.imports.ui.appletManager.applets["chronos@geraldo-netto"].localeQuery;
    t.mock.method(locale, "onLocaleInfoChanged", (category, callback) => {
        assert.equal(category, "LC_TIME");
        changes.locale = callback;
        return () => {};
    });
    const cal = new CalendarModule.Calendar(settings, makeEventsManager(), null, desktop);
    cal.setDate(civilDate(2026, 6, 9), false);
    t.after(() => cal.destroy());
    return {
        cal, stage, changes, pending,
        flush() {
            const callbacks = [...pending.values()];
            pending.clear();
            callbacks.forEach(callback => callback());
            assert.equal(pending.size, 0, "a completed rebuild does not reschedule itself");
        }
    };
}

function rebuildFocusTarget(cal, target) {
    if (target === "day") {
        return cal._gridView.dayCells.find(cell => cell.selected).button;
    }
    return [...cal._topBoxMonth.children, ...cal._topBoxYear.children]
        .find(actor => actor.accessible_name === target);
}

function assertRebuildRetainsFocus(t, source, target) {
    const h = makeRebuildFocusHarness(t);
    const external = new MockActor();
    const original = target === "external" ? external : rebuildFocusTarget(h.cal, target);
    original.grab_key_focus();
    h.changes[source]();
    assert.equal(h.stage.menuOpen, true, "destroying grid actors must not close the popup");
    h.flush();
    const expected = target === "external" ? external : rebuildFocusTarget(h.cal, target);
    assert.equal(h.stage.focus, expected, "restore the same logical focus target");
    assert.deepEqual(h.cal.getSelectedDate(), civilDate(2026, 6, 9));
    assert.equal(expected.destroyed, false);
}

test("T1151: settings and locale grid rebuilds retain day/header focus and external focus", async t => {
    for (const source of ["weekNumbers", "firstWeekday", "locale"]) {
        for (const target of ["day", "Previous month", "Next month", "Previous year", "Next year", "external"]) {
            await t.test(`${source}: ${target}`, inner => assertRebuildRetainsFocus(inner, source, target));
        }
    }
});

test("T1151: repeated locale rebuilds preserve focus until the final render", t => {
    const h = makeRebuildFocusHarness(t);
    rebuildFocusTarget(h.cal, "day").grab_key_focus();
    h.changes.locale();
    h.changes.locale();
    h.changes.weekNumbers();
    h.flush();
    assert.equal(h.stage.menuOpen, true);
    assert.equal(h.stage.focus, rebuildFocusTarget(h.cal, "day"));
});

test("T1151: delayed locale completion respects subsequent user focus and teardown", t => {
    const h = makeRebuildFocusHarness(t);
    const external = new MockActor();
    rebuildFocusTarget(h.cal, "day").grab_key_focus();
    h.changes.locale();
    external.grab_key_focus();
    h.flush();
    assert.equal(h.stage.focus, external, "Tab out of the parked grid cancels restoration");
    rebuildFocusTarget(h.cal, "day").grab_key_focus();
    h.changes.locale();
    h.cal.destroy();
    external.grab_key_focus();
    h.flush();
    assert.equal(h.stage.focus, external);
    assert.equal(h.pending.size, 0);
});

test("T1151: leaving and revisiting the parking actor cancels old focus intent", t => {
    const h = makeRebuildFocusHarness(t);
    rebuildFocusTarget(h.cal, "Next year").grab_key_focus();
    h.changes.locale();
    new MockActor().grab_key_focus();
    h.cal.actor.grab_key_focus();
    h.flush();
    assert.equal(h.stage.focus, h.cal.actor, "do not resurrect focus intent after the user leaves");
});
