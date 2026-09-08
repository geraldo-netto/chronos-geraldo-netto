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
globalThis.global = { stage: { get_key_focus: () => null } };

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
    remove_actor(actor) { this.children = this.children.filter(child => child !== actor); }
    destroy() {}
    set_accessible_name(name) { this.accessible_name = name; }
    add_style_pseudo_class() {}
    remove_style_pseudo_class() {}
    add_style_class_name(name) { this.style_class += " " + name; }
    remove_style_class_name(name) { this.style_class = this.style_class.replace(name, ""); }
}

const Clutter = { KEY_Left: 1, KEY_Right: 2, KEY_Up: 3, KEY_Down: 4,
    ActorAlign: { CENTER: 0 }, EVENT_STOP: true, EVENT_PROPAGATE: false };
const shell = {
    gi: { GLib, Clutter, Pango: {}, St: { Button: Actor, Widget: Actor, Bin: Actor,
        Label: Actor, Align: { MIDDLE: 0 }, TextDirection: { RTL: 1 } },
    Cinnamon: { Stack: Actor, GenericContainer: Actor },
    CinnamonDesktop: { WallClock: { lctime_format: (domain, fmt) => fmt } } },
    signals: { addSignalMethods() {} }, mainloop: { timeout_add: () => 1, source_remove() {} },
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
    const selectedDate = new Date(GLib.DateTime.new_local(year, month, selectedDay, 12, 0, 0).to_unix() * 1000);
    const lookupKeys = [];
    const clicked = [];
    const actor = new Actor();
    const host = { selectedDate, weekStart, weekendLength: 2, eventDataAvailable: true,
        colorsForUnixKey(key) { lookupKeys.push(key); return ["#fff"]; },
        selectDate(date) { clicked.push(root.dateMath.localDateParts(date)); },
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
        return root.dateMath.localDateParts(navigation.selectedDate);
    });
    return { days: window.days, keys: window.dateUnixKeys, lookupKeys, clicked, steps,
        browsed: root.dateMath.localDateParts(browsedDate(selectedDate, 0, 1)),
        weeks: view.weekLabels.map(label => label.text),
        headings: actor.placements.filter(item => item.row === 1).map(item => ({
            column: item.col - 1, text: item.actor.text })),
        cells: view.dayCells.map(cell => ({ label: cell.button.label, name: cell.accessible_date,
            events: cell.event_count, holiday: cell.holiday_name || "",
            weekday: root.dateMath.civilWeekday(cell.date),
            column: actor.placements.find(item => item.actor === cell.group).col - 1 })) };
}
print(JSON.stringify(JSON.parse(ARGV[1]).map(inspect)));
