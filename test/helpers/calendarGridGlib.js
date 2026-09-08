/* global ARGV, print */

// Actual calendar composition and GLib/tzdata, with only actors and Cinnamon
// services replaced. This process owns its TZ; no desktop settings are changed.
const GLib = imports.gi.GLib;
imports.searchPath.unshift(ARGV[0]);
const root = { dateMath: imports.dateMath, civilTime: imports.civilTime,
    textUtils: imports.textUtils, styleUtils: imports.styleUtils,
    holidayConstants: imports.holidayConstants };
root.localeText = { translate: text => text, joinPhrases: (...parts) => parts.join(" — "),
    translatePlural: (one, many, count) => count === 1 ? one : many };
root.localeQuery = { lazyLocaleValue: (category, read) => () => read({
    first_workday: 2, abday: "Sun;Mon;Tue;Wed;Thu;Fri;Sat"
}) };
Object.defineProperty(String.prototype, "format", { // NOSONAR [S6643] -- isolated Cinnamon test seam
    value(...args) { let i = 0; return this.replace(/%[sd]/g, () => String(args[i++])); }
});
let focused = null;
globalThis.global = { stage: { get_key_focus: () => focused } };

class Actor {
    constructor(options = {}) {
        Object.assign(this, options);
        this.children = [];
        this.placements = [];
        this.handlers = new Map();
    }
    connect(signal, callback) { this.handlers.set(signal, callback); return 1; }
    add_actor(actor) { this.children.push(actor); }
    add(actor, position) { this.add_actor(actor); this.placements.push({ actor, ...position }); }
    get_children() { return this.children; }
    grab_key_focus() { focused = this; }
    remove_actor(actor) { this.children = this.children.filter(child => child !== actor); }
    destroy() {}
    set_accessible_name(name) { this.accessible_name = name; }
    add_style_pseudo_class() {}
    remove_style_pseudo_class() {}
    add_style_class_name(name) { this.style_class += " " + name; }
    remove_style_class_name(name) { this.style_class = this.style_class.replace(name, ""); }
}

const Clutter = { KEY_Left: 1, KEY_Right: 2, KEY_Up: 3, KEY_Down: 4,
    KEY_Page_Down: 5, KEY_Page_Up: 6,
    ActorAlign: { CENTER: 0 }, EVENT_STOP: true, EVENT_PROPAGATE: false };
const shell = {
    gi: { GLib, Clutter, Pango: {}, St: { Button: Actor, Widget: Actor, Bin: Actor,
        Label: Actor, Align: { MIDDLE: 0 }, TextDirection: { RTL: 1 } },
    Cinnamon: { Stack: Actor, GenericContainer: Actor, util_get_week_start: () => 0 },
    CinnamonDesktop: { WallClock: { lctime_format: (domain, fmt) => fmt } } },
    signals: { addSignalMethods() {} }, mainloop: {
        timeout_add: () => 1, idle_add: () => 2, source_remove() {}
    },
    gettext: { domain: () => ({ gettext: text => text }) },
    ui: { appletManager: { applets: { "chronos@geraldo-netto": root } },
        tooltips: { Tooltip: class { set_text(text) { this.text = text; } destroy() {} } } }
};
const loaded = new Map();
function load(file) {
    if (!loaded.has(file)) {
        const module = { exports: {} };
        const source = imports.byteArray.toString(GLib.file_get_contents(ARGV[0] + "/" + file + ".js")[1]);
        const require = name => load("6.0/" + name.slice(2));
        new Function("imports", "require", "module", source)(shell, require, module);
        loaded.set(file, module.exports);
    }
    return loaded.get(file);
}
root.dateFormats = load("dateFormats");
const Grid = load("6.0/calendarGrid");
const { CalendarMonthWindow } = load("6.0/calendarMonthWindow");
const { CalendarHolidayAnnotator } = load("6.0/calendarAnnotations");
const { CalendarNavigationController, browsedDate } = load("6.0/calendarNavigation");
const { Calendar } = load("6.0/calendar");

function inspect(input) {
    const { year, month, weekStart, selectedDay = 15 } = input;
    const selectedDate = { year, month, day: selectedDay };
    const lookupKeys = [];
    const clicked = [];
    const actor = new Actor();
    const host = { selectedDate, weekStart, weekendLength: 2, eventDataAvailable: true,
        colorsForUnixKey(key) { lookupKeys.push(key); return ["#fff"]; },
        selectDate(date) { clicked.push(date); },
        holidaysActive: () => true, holidayGeneration: 1, reportIssue() {}, holidaysChanged() {},
        requestHolidays(y, m, callback) {
            callback(new Map([[`${m}/30`, { name: "Civil-date observance", flags: [] }]]), "", "Fixture");
        } };
    const dots = new Grid.CalendarEventDotRenderer(host);
    host.renderDots = (...args) => dots.update(...args);
    const renderer = new Grid.CalendarDayCellRenderer(host);
    host.nameCell = cell => renderer.applyAccessibleName(cell);
    const view = new Grid.CalendarGridView({ actor: () => actor,
        showWeekNumbers: () => true, weekendLength: () => 2 }, renderer);
    const window = new CalendarMonthWindow(selectedDate, weekStart);
    const cells = view.render(window, true, selectedDate);
    const annotator = new CalendarHolidayAnnotator(host);
    annotator.annotate(window.months, cells, 1);
    Calendar.prototype._buildWeekdayHeadings.call({ actor, _gridView: view, _weekStart: weekStart,
        _dayHeadingStyleClass: weekday => view.dayHeadingStyleClass(weekday) }, 1);
    for (const cell of view.dayCells) cell.button.handlers.get("clicked")();

    const navigation = new CalendarNavigationController({ actor: () => actor, dayCells: () => [],
        queueDate: date => navigation.queueDate(date),
        setDate: date => navigation.setDate(date, false), emitSelected() {}, update() {} }, selectedDate);
    const steps = [Clutter.KEY_Right, Clutter.KEY_Left].map(key => {
        navigation.onKeyPress({ get_key_symbol: () => key });
        navigation.flushQueuedDate();
        return navigation.selectedDate;
    });
    return { days: window.days, keys: window.dateUnixKeys, lookupKeys, clicked, steps,
        browsed: browsedDate(selectedDate, 0, 1),
        weeks: view.weekLabels.map(label => label.text),
        headings: actor.placements.filter(item => item.row === 1).map(item => ({
            column: item.col - 1, text: item.actor.text })),
        cells: view.dayCells.map(cell => ({ label: cell.button.label, name: cell.accessible_date,
            events: cell.event_count, holiday: cell.holiday_name || "",
            weekday: root.dateMath.civilWeekday(cell.date),
            column: actor.placements.find(item => item.actor === cell.group).col - 1 })) };
}
function changeTimezone(zone) {
    GLib.setenv("TZ", zone, true);
    imports.system.clearDateCaches();
}

function seedNeighborEvent(index, date) {
    const next = root.dateMath.addCivilDays(date, 1);
    const projected = root.civilTime.projectCivilDate(next, GLib.TimeZone.new_local());
    if (projected) index.eventsByDate[projected.to_unix()] = {
        length: 1, timestamp: 1, get_event_list: () => [{ summary: "Neighbor event" }]
    };
}

function timezoneSnapshot(calendar, navigation, list, window, cells) {
    return { selected: calendar.getSelectedDate(), queued: navigation.queuedDate,
        timer: navigation.setDateIdleId, focusIntent: navigation.focusAfterSetDate,
        heading: list.heading, local: list.selectedDate?.format("%Y-%m-%d %z") || null,
        rows: list.rows, managerDate: window.current_selected_civil,
        managerUnix: window.current_selected_date?.to_unix() || null,
        focusedDate: cells.find(cell => cell.button === focused)?.date || null };
}

function inspectTimezone(input) {
    changeTimezone(input.from);
    focused = null;
    root.eventData = load("eventData");
    const { EventIndex } = load("eventIndex");
    const { EventWindowCoordinator } = load("eventWindow");
    loaded.set("6.0/eventView", load("6.0/selectedDayAgenda"));
    const { AgendaColumnCoordinator } = load("6.0/agendaColumn");
    const CalendarDate = load("6.0/calendarDate");
    const signals = new Map();
    const index = new EventIndex();
    const window = new EventWindowCoordinator(index);
    const active = () => input.active;
    const emit = (name, ...args) => signals.get(name)?.(null, ...args);
    const fetch = (month, force) => window.fetchMonthEvents(month, force,
        () => {}, () => 1, () => {});
    const list = {
        selectedDate: null, selectedCivilDate: null,
        set_date(date, gdate) {
            this.selectedCivilDate = date;
            this.selectedDate = gdate;
            this.heading = CalendarDate.formatCivilDate(date, "%Y-%m-%d");
        },
        set_events(value) { this.rows = value?.get_event_list().map(row => row.summary) || []; }
    };
    const agenda = new AgendaColumnCoordinator({
        connect(name, callback) { signals.set(name, callback); return name; },
        disconnect(name) { signals.delete(name); }, is_active: active
    }, list);
    const calendar = Object.create(Calendar.prototype);
    const actor = new Actor();
    let cells = [];
    const render = () => {
        const selected = calendar.getSelectedDate();
        cells = new CalendarMonthWindow(selected, 0).days.map(date => ({ date,
            dateUnixKey: CalendarDate.localUnixForCivilDate(date), button: new Actor() }));
    };
    const navigation = new CalendarNavigationController({ actor: () => actor, dayCells: () => cells,
        queueDate: date => navigation.queueDate(date),
        setDate: (date, force) => calendar.setDate(date, force),
        update: render, emitSelected: date => calendar.emit("selected-date-changed", date)
    }, input.selected);
    Object.assign(calendar, { _navigation: navigation,
        _monthWindows: new (load("6.0/calendarMonthWindow").CalendarMonthWindowCache)(),
        _queue_update: render,
        emit(name, date) {
            agenda.selectDate(date);
            window.selectDate(date, true, active, fetch, emit);
        },
        holidayForDate: date => ({ name: "Holiday " + root.dateMath.civilDateKey(date), flags: [] })
    });
    agenda.setCalendar(calendar);
    render();
    calendar.emit("selected-date-changed", input.selected);
    navigation.focusSelectedDay();
    if (input.pending) {
        navigation.onKeyPress({ get_key_symbol: () => input.pending === "day" ?
            Clutter.KEY_Right : Clutter.KEY_Page_Down });
    }
    const timer = navigation.setDateIdleId;
    const focusIntent = navigation.focusAfterSetDate;
    const snapshot = () => timezoneSnapshot(calendar, navigation, list, window, cells);
    const before = snapshot();
    const reconcile = zone => {
        changeTimezone(zone);
        index.discard();
        window.renormalizeSelectedDate();
        calendar.refreshTimezone();
        // Simulate a neighboring-day delivery after the timezone change. A
        // missing projection must never cause that bucket to be selected.
        seedNeighborEvent(index, calendar.getSelectedDate());
        window.reloadSelected(active, fetch, emit);
    };
    reconcile(input.to);
    const after = snapshot();
    const pendingPreserved = navigation.setDateIdleId === timer &&
        navigation.focusAfterSetDate === focusIntent;
    if (input.pending) navigation.flushQueuedDate();
    const flushed = snapshot();
    reconcile(input.from);
    const returned = snapshot();
    reconcile(input.to);
    navigation.focusSelectedDay();
    navigation.onKeyPress({ get_key_symbol: () => Clutter.KEY_Right });
    navigation.flushQueuedDate();
    const arrow = snapshot();
    navigation.onKeyPress({ get_key_symbol: () => Clutter.KEY_Page_Down });
    navigation.flushQueuedDate();
    const pageDown = snapshot();
    agenda.destroy();
    return { before, after, pendingPreserved, flushed, returned, arrow, pageDown };
}

print(JSON.stringify(JSON.parse(ARGV[1]).map(ARGV[2] === "timezone" ? inspectTimezone : inspect)));
