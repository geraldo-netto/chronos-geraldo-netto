// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* global imports */
/* eslint camelcase: "off" */

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Signals = imports.signals;
const Pango = imports.gi.Pango;
const Gettext_gtk30 = imports.gettext.domain('gtk30');
const Cinnamon = imports.gi.Cinnamon;
const Mainloop = imports.mainloop;
const AppletModules = imports.ui.appletManager.applets["chronos@geraldo-netto"];
const DateFormats = AppletModules.dateFormats;
const LocaleQuery = AppletModules.localeQuery;
const LocaleText = AppletModules.localeText;
const StyleUtils = AppletModules.styleUtils;
const UiVocabulary = require("./uiVocabulary");
const EventDataModule = require("./eventData");
const CalendarNavigation = require("./calendarNavigation");
const CalendarDate = require("./calendarDate");
const CalendarNavigationController = CalendarNavigation.CalendarNavigationController;
const clampCalendarDate = CalendarNavigation.clampCalendarDate;
const _formatJsDate = CalendarDate.formatJsDate;
const _sameDay = CalendarDate.sameDay;
const _today = CalendarDate.isToday;
const CalendarAnnotations = require("./calendarAnnotations");
const CalendarHolidayAnnotator = CalendarAnnotations.CalendarHolidayAnnotator;
const releaseHolidayTooltip = CalendarAnnotations.releaseHolidayTooltip;

const _ = LocaleText.translate;
const joinPhrases = LocaleText.joinPhrases;
const ngettext = LocaleText.translatePlural;
const date_only = EventDataModule.date_only;
const js_date_to_gdatetime = EventDataModule.js_date_to_gdatetime;

// GTK's own msgid, asked of GTK's own domain: it answers "calendar:MY" or
// "calendar:YM" to say which way round the month and year go. Not a literal at the
// call site, because our .pot extractor scans gettext() calls and would harvest
// GTK's msgid into our catalog, where nobody could translate it into anything
// meaningful.
const GTK_CALENDAR_ORDER_MSGID = 'calendar:MY';

const MSECS_IN_DAY = DateFormats.MSECS_IN_DAY;
const WEEKDATE_HEADER_WIDTH_DIGITS = 3;
// weekday, day, month and year: what a sighted user reads off the grid
// The visible full date is locale-ordered through the shared format, so a
// hardcoded day-month order here meant an en_US user saw "Saturday, July 12,
// 2026" while their screen reader said "Saturday, 12 July 2026". Same date,
// same applet, two different orders.
const ACCESSIBLE_DATE_FORMAT = DateFormats.DATE_FORMAT_FULL;
const ACCESSIBLE_DATE_FORMAT_FALLBACK = DateFormats.DATE_FORMAT_FULL_FALLBACK;
// Geometry remains the primary limit, but a broken or unusually permissive
// theme must not turn one dense day into an arbitrary number of actors.
const MAX_EVENT_DOTS_PER_CELL = 64;
const EVENT_DOT_OVERFLOW_NOTICE = UiVocabulary.EVENTS_HIDDEN_TEXT;

const _lcAbday = LocaleQuery.lazyLocaleValue("LC_TIME", (info) => info.abday.split(";"));
const _lcFirstWorkday = LocaleQuery.lazyLocaleValue(
    "LC_TIME", (info) => (info.first_workday + 6) % 7);

// Weekend days are derived from the locale's first workday and configured length.
function _isWorkDay(date, weekend_length) {
    const firstWorkday = _lcFirstWorkday();
    return date.getDay() !== (firstWorkday + 7 - weekend_length) % 7 &&
    date.getDay() !== (firstWorkday + 6) % 7;
}

function _getDigitWidth(actor){
    let context = actor.get_pango_context();
    let themeNode = actor.get_theme_node();
    let font = themeNode.get_font();
    let metrics = context.get_metrics(font, context.get_language());
    let width = metrics.get_approximate_digit_width();
    return width;
}

function _getCalendarDayAbbreviation(dayNumber) {
    return _lcAbday()[dayNumber];
}

// The window depends only on the displayed month and the week start, but
// _update() runs on every menu open, settings change and event update, and
// rebuilding it costs 42 Dates plus 84 GLib.DateTimes every time.
class CalendarMonthWindowCache {
    constructor() {
        this._key = ""; // NOSONAR [S7757] -- accepted compatible form
        this._window = null;
    }

    get(selectedDate, weekStart) {
        const bounded = clampCalendarDate(selectedDate);
        const key = `${bounded.getFullYear()}/${bounded.getMonth()}/${weekStart}`;
        if (this._key !== key || !this._window) {
            this._key = key;
            this._window = new CalendarMonthWindow(bounded, weekStart);
        }

        return this._window;
    }

    // The key is year/month/weekStart, but dateUnixKeys and accessibleDates are
    // absolute values derived from the process timezone the window was built
    // in. A zone change leaves the key identical and every value inside wrong,
    // so it has to be dropped from outside. Releasing the window rather than
    // clearing the key is what frees the 42 Dates and 84 GLib.DateTimes it
    // holds; get() rebuilds on either, and the key is rewritten there anyway.
    invalidate() {
        this._window = null;
    }
}

class CalendarMonthWindow {
    constructor(selectedDate, weekStart) {
        this.selectedDate = clampCalendarDate(selectedDate);
        this.weekStart = weekStart;
        this.beginDate = this._beginDate();
        this.days = this._buildDays();
        this.dateUnixKeys = this.days.map((day) => {
            const gdate = js_date_to_gdatetime(day);
            return gdate ? date_only(gdate).to_unix() : null;
        });
        // one GLib.DateTime plus a format per cell, and _update() runs on every
        // menu open, month change, settings change and coalesced event update:
        // the name depends only on the date in the slot, so it belongs here
        // with the rest of the per-month work
        this.accessibleDates = this.days.map((day) =>
            _formatJsDate(day, ACCESSIBLE_DATE_FORMAT, ACCESSIBLE_DATE_FORMAT_FALLBACK));
        this.months = new Set();

        for (const day of this.days) {
            this.months.add(`${day.getFullYear()}/${day.getMonth() + 1}`);
        }
    }

    _beginDate() {
        let beginDate = new Date(this.selectedDate);
        beginDate.setDate(1);
        beginDate.setSeconds(0);
        beginDate.setHours(12);
        // monthWindowStartOffset speaks GLib's ISO weekday (1=Mon..7=Sun);
        // Date.getDay() reports Sunday as 0
        const daysToWeekStart = DateFormats.monthWindowStartOffset(
            beginDate.getDay() || 7, this.weekStart);
        beginDate.setTime(beginDate.getTime() - daysToWeekStart * MSECS_IN_DAY);
        return beginDate;
    }

    _buildDays() {
        const days = [];
        let iter = new Date(this.beginDate);
        for (let i = 0; i < 42; i++) {
            days.push(new Date(iter));
            iter.setTime(iter.getTime() + MSECS_IN_DAY);
        }
        return days;
    }

    weekLabelForRow(rowIndex) {
        const thursday = this.days[rowIndex * 7 + ((4 - this.weekStart + 7) % 7)];
        return _formatJsDate(thursday, '%V');
    }
}

// What the grid's collaborators are allowed to know about the calendar.
//
// The three of them used to hold the Calendar itself and read and write its
// privates — _selectedDate, _eventDotRenderer, _allocate_dot_box,
// events_manager, _holiday_update_generation — and the annotator assigned three
// more (_monthLabel.text, _holidayTooltip, _holiday_status_text) that
// _buildHeader also owned and reset. Two objects owning the same field is not a
// collaboration, it is a race with good manners. The extraction had moved the
// code without decoupling it: the Calendar's private shape *was* the
// collaborators' API, and none of them could be built or tested without a whole
// Calendar.
//
// This is that API, written down. AppletMenuBuilder, AppletProviderLifecycle and
// PanelView are the same idea one layer up.

class CalendarGridHost {
    constructor(port) {
        this.port = port;
    }

    get selectedDate() {
        return this.port.selectedDate();
    }

    get weekStart() {
        return this.port.weekStart();
    }

    get weekendLength() {
        return this.port.weekendLength();
    }

    get eventDataAvailable() {
        return this.port.eventDataAvailable();
    }

    get eventsManager() {
        return this.port.eventsManager;
    }

    get holidayProvider() {
        return this.port.holidayProvider();
    }

    // a fetch that lands after the grid moved on belongs to a month that is no
    // longer on screen
    get holidayGeneration() {
        return this.port.holidayGeneration();
    }

    selectDate(date) {
        this.port.selectDate(date);
    }

    allocateDotBox(actor, box, flags) {
        return this.port.allocateDotBox(actor, box, flags);
    }

    dotCapacityChanged() {
        this.port.dotCapacityChanged();
    }

    // the cell renderer draws the dots and the annotator renames the cell it
    // just annotated: both used to reach through the calendar for the other
    renderDots(cell, iter, dateUnixKey) {
        this.port.renderDots(cell, iter, dateUnixKey);
    }

    nameCell(cell) {
        this.port.nameCell(cell);
    }

    reportIssue(source, message) {
        this.port.reportIssue(source, message);
    }

    holidaysChanged() {
        this.port.holidaysChanged();
    }
}

class CalendarDayCellRenderer {
    constructor(host) {
        this.host = host;
    }

    update(cell, iter, row, today, dateUnixKey, accessibleDate) {
        const dateChanged = this._updateDateIdentity(
            cell, iter, today, accessibleDate);
        this._updateCellStyle(cell, iter, row, today);
        this._updateSelection(cell, iter);
        this._clearOldHolidayTooltip(cell, dateChanged);
        this.host.renderDots(cell, iter, dateUnixKey);
        this.applyAccessibleName(cell);
    }

    _updateDateIdentity(cell, iter, today, accessibleDate) {
        // the slot is reused: whether it is showing a different day now is what
        // decides whether last pass's holiday annotation still belongs to it
        const dateChanged = !cell.date || !_sameDay(cell.date, iter);
        cell.date = new Date(iter.getTime()); // NOSONAR [S7719] -- accepted compatible form
        cell.is_today = _today(iter, today);

        const label = iter.getDate().toString();
        if (cell.button.label !== label) {
            cell.button.label = label;
        }

        // a screen reader would otherwise announce 42 bare digits with no
        // month, year or weekday to place them; the month window built this
        // once for the whole grid
        cell.accessible_date = accessibleDate;
        // whatever the last date in this slot was annotated with is not this
        // one's — but if the slot still shows the same day, its holiday has not
        // changed either, and clearing it here only to have annotate() write the
        // identical text back is two forced relayouts per cell per update
        if (dateChanged) {
            cell.holiday_name = "";
        }
        return dateChanged;
    }

    _updateCellStyle(cell, iter, row, today) {
        // a holiday annotation appends classes after our write, so an
        // annotated cell needs a rewrite even when the base is unchanged
        const styleClass = this._dayStyleClass(iter, row, today);
        if (cell.rendered_style !== styleClass || cell.holiday_styled) {
            cell.button.style_class = styleClass;
            cell.rendered_style = styleClass;
            cell.holiday_styled = false;
        }
    }

    _updateSelection(cell, iter) {
        const selected = _sameDay(this.host.selectedDate, iter);
        if (selected !== cell.selected) {
            if (selected) {
                cell.button.add_style_pseudo_class('selected');
            } else {
                cell.button.remove_style_pseudo_class('selected');
            }
            cell.selected = selected;
            // roving focus: the tab stop moves with the selection, so the grid
            // is one stop rather than forty-two
            cell.button.can_focus = selected;
        }
    }

    _clearOldHolidayTooltip(cell, dateChanged) {
        // whatever holiday the date previously shown here had, this one does
        // not inherit — and the tooltip that carried it goes with it
        if (dateChanged && cell.holiday_tooltip_set) {
            releaseHolidayTooltip(cell);
            cell.holiday_tooltip_set = false;
        }
    }

    // The date, whether it is today, whether it is the selected day, how many
    // events sit on it, and its holiday — five things a sighted user reads off
    // the cell at a glance, and only the first of which was ever said aloud.
    // Today and the selection are drawn as a background colour and nothing
    // else, the events are coloured 4px dots, and the holiday name lived in a
    // hover tooltip, which a keyboard never opens.
    applyAccessibleName(cell) {
        if (!cell.button.set_accessible_name) {
            return;
        }

        const parts = [cell.accessible_date];

        // orienting the user in the grid is the whole job of these two colours
        if (cell.is_today) {
            parts.push(_("Today"));
        }
        if (cell.selected) {
            parts.push(_("Selected"));
        }

        if (cell.event_count > 0) {
            parts.push(ngettext("%d event", "%d events", cell.event_count).format(cell.event_count));
        }
        if (cell.event_dots_overflowed) {
            parts.push(EVENT_DOT_OVERFLOW_NOTICE);
        }
        if (cell.holiday_name) {
            parts.push(cell.holiday_name.split("\n").join(", ")); // NOSONAR [S7781] -- accepted compatible form
        }

        const accessibleName = joinPhrases(...parts);
        if (cell.accessible_name !== accessibleName) {
            cell.button.set_accessible_name(accessibleName);
            cell.accessible_name = accessibleName;
        }
    }

    // the row is what places the cell in the table, and _ensureGrid does that;
    // the cell itself never needed to carry it, and nothing read it back
    build() {
        const cell = {
            date: null,
            selected: false,
            rendered_style: "",
            dot_key: "",
            // The first allocation replaces this hard safety ceiling with the
            // cell's exact themed capacity. Until then, startup stays bounded
            // without deliberately under-rendering ordinary event days.
            dot_capacity: MAX_EVENT_DOTS_PER_CELL,
            event_dots_overflowed: false,
            holiday_styled: false,
            holiday_tooltip_set: false,
            // what the cell's tooltip currently says, so identical text is not
            // written again — Cinnamon's set_text() forces a relayout either way
            rendered_tooltip: undefined,
            holidayTooltip: null,
            group: new Cinnamon.Stack(),
            // Not focusable until it is the selected day. All 42 cells used to
            // be tab stops, so the grid was 42 of them: from the cell the menu
            // focuses on open, a keyboard user pressed Tab up to 42 times to
            // reach the world clocks or "Date and Time Settings", and there was
            // no way out of the grid at all. A date grid is one composite widget
            // — one tab stop, with the arrow keys moving inside it, which is
            // what the arrow-key navigation is for.
            button: new St.Button({ label: "", can_focus: false }),
            dot_box: new Cinnamon.GenericContainer(
                {
                    style_class: "calendar-day-event-dot-box",
                }
            )
        };

        cell.group.add_actor(cell.button);

        cell.dot_box.connect('allocate', (actor, box, flags) => {
            const capacity = this.host.allocateDotBox(actor, box, flags);
            if (Number.isSafeInteger(capacity) && capacity >= 1 &&
                capacity !== cell.dot_capacity) {
                cell.dot_capacity = capacity;
                this.host.dotCapacityChanged();
            }
        });
        cell.group.add_actor(cell.dot_box);

        // reads cell.date so the reused button always selects the date
        // it currently displays
        cell.button.connect('clicked', () => {
            if (!cell.date) {
                return;
            }
            this.host.selectDate(new Date(cell.date.getTime())); // NOSONAR [S7719] -- accepted compatible form
        });

        return cell;
    }

    _dayStyleClass(iter, row, today) {
        let styleClass = ['calendar-day-base', 'calendar-day'];
        if (_isWorkDay(iter, this.host.weekendLength)) {
            styleClass.push('calendar-work-day');
        } else {
            styleClass.push("calendar-nonwork-day");
        }

        // Hack used in lieu of border-collapse - see cinnamon.css
        if (row === 2) {
            styleClass.push('calendar-day-top');
        }
        if (iter.getDay() === this.host.weekStart) {
            styleClass.push('calendar-day-left');
        }

        if (_today(iter, today)) {
            styleClass.push('calendar-today');
        } else if (iter.getMonth() !== this.host.selectedDate.getMonth()) {
            styleClass.push('calendar-other-month-day');
        } else {
            styleClass.push('calendar-not-today');
        }

        return styleClass.join(" ");
    }
}

class CalendarEventDotRenderer {
    constructor(host) {
        this.host = host;
    }

    _projectColors(colorSet, requestedCapacity) {
        const eventCount = colorSet !== null ? colorSet.length : 0;
        const capacity = Number.isSafeInteger(requestedCapacity) && requestedCapacity >= 1 ?
            Math.min(requestedCapacity, MAX_EVENT_DOTS_PER_CELL) : MAX_EVENT_DOTS_PER_CELL;
        const colors = colorSet !== null ? colorSet.slice(0, capacity)
            .map((color) => StyleUtils.safeCssColor(color)) : [];
        return { eventCount, colors };
    }

    update(cell, iter, dateUnixKey) {
        const color_set = this.host.eventDataAvailable ?
            this.host.eventsManager.get_colors_for_unix_key(dateUnixKey) : null;
        const { eventCount, colors } = this._projectColors(color_set, cell.dot_capacity);

        // the dots are the only sign that a day has events, and they are 4px of
        // colour: the count goes into the cell's name so it can be said as well
        // as seen
        cell.event_count = eventCount;
        cell.event_dots_overflowed = eventCount > colors.length;

        // Only the bounded visual projection participates in actor reuse. The
        // real count above still refreshes the accessible name when hidden
        // events are added or removed beyond the visible prefix.
        const dot_key = `${colors.length}:${colors.join("|")}`;
        if (dot_key === cell.dot_key) {
            return;
        }
        cell.dot_key = dot_key;

        const dots = cell.dot_box.get_children();
        for (let i = dots.length - 1; i >= colors.length; i--) {
            cell.dot_box.remove_actor(dots[i]);
            dots[i].destroy();
        }

        for (let i = 0; i < colors.length; i++) {
            const style = `background-color: ${colors[i]};`;
            if (i < dots.length) {
                dots[i].style = style;
            } else {
                cell.dot_box.add_actor(new St.Bin(
                    {
                        style_class: "calendar-day-event-dot",
                        style: style,
                        x_align: Clutter.ActorAlign.CENTER
                    }
                ));
            }
        }
    }
}

// Owns the persistent 6x7 grid and all writes to its actors. Calendar chooses
// the month and coordinates annotations; this view handles grid geometry and
// rendering through a small state port.
class CalendarGridView {
    constructor(port, dayCellRenderer) {
        this.port = port;
        this.dayCellRenderer = dayCellRenderer;
        this.dayCells = [];
        this.weekLabels = [];
        this.dayHeadings = [];
        this.dotMetrics = null;
    }

    reset() {
        this.dayCells = [];
        this.weekLabels = [];
        this.dayHeadings = [];
    }

    addDayHeading(label, date) {
        this.dayHeadings.push({ label, date });
    }

    invalidateStyle() {
        this.dotMetrics = null;
    }

    render(monthWindow, annotating, today = new Date()) {
        this.ensureGrid();
        this.updateDayHeadings();
        const cells = new Map();

        for (let i = 0; i < this.dayCells.length; i++) {
            const iter = monthWindow.days[i];
            const cell = this.dayCells[i];
            this.dayCellRenderer.update(cell, iter, 2 + Math.trunc(i / 7), today,
                monthWindow.dateUnixKeys[i], monthWindow.accessibleDates[i]);
            if (annotating) {
                cells.set(`${iter.getMonth() + 1}/${iter.getDate()}`, cell);
            }
        }

        this.updateWeekNumbers(monthWindow);
        return cells;
    }

    updateWeekNumbers(monthWindow) {
        if (!this.port.showWeekNumbers()) {
            return;
        }

        for (let rowIndex = 0; rowIndex < this.weekLabels.length; rowIndex++) {
            const week = monthWindow.weekLabelForRow(rowIndex);
            const label = this.weekLabels[rowIndex];
            if (label.text === week) {
                continue;
            }
            label.text = week;
            const name = _("Week %s").format(week);
            if (label.set_accessible_name) {
                label.set_accessible_name(name);
            }
            label.accessible_name = name;
        }
    }

    dayHeadingStyleClass(iter) {
        let styleClass = 'calendar-day-base calendar-day-heading';
        if (_isWorkDay(iter, this.port.weekendLength())) {
            styleClass += ' calendar-work-day';
        } else {
            styleClass += ' calendar-nonwork-day';
        }
        return styleClass;
    }

    updateDayHeadings() {
        for (const heading of this.dayHeadings) {
            const styleClass = this.dayHeadingStyleClass(heading.date);
            if (heading.label.style_class !== styleClass) {
                heading.label.style_class = styleClass;
            }
        }
    }

    ensureGrid() {
        if (this.dayCells.length > 0) {
            return;
        }

        const actor = this.port.actor();
        const showWeekNumbers = this.port.showWeekNumbers();
        const offsetCols = showWeekNumbers ? 1 : 0;
        for (let i = 0; i < 42; i++) {
            const row = 2 + Math.trunc(i / 7);
            const col = i % 7;
            if (showWeekNumbers && col === 0) {
                const label = new St.Label(
                    { style_class: 'calendar-day-base calendar-week-number' });
                actor.add(label, { row, col: 0, y_align: St.Align.MIDDLE });
                this.weekLabels.push(label);
            }
            const cell = this.dayCellRenderer.build();
            actor.add(cell.group, { row, col: offsetCols + col });
            this.dayCells.push(cell);
        }
    }

    metricsFor(actor, dot) {
        if (!this.dotMetrics) {
            const [, nw] = dot.get_preferred_width(-1);
            const [, nh] = dot.get_preferred_height(-1);
            const [found, rows] = actor.get_theme_node().lookup_double("max-rows", false);
            const width = Number.isFinite(nw) && nw > 0 ? nw : 1;
            const height = Number.isFinite(nh) && nh > 0 ? nh : 1;
            const maxRows = found && Number.isFinite(rows) && rows >= 1 ?
                Math.trunc(rows) : 2;
            this.dotMetrics = { nw: width, nh: height, max_rows: maxRows };
        }
        return this.dotMetrics;
    }

    allocateDotBox(actor, box, flags) {
        const children = actor.get_children();
        if (children.length === 0) {
            return 0;
        }

        const allocatedWidth = box.x2 - box.x1;
        const boxWidth = Number.isFinite(allocatedWidth) && allocatedWidth > 0 ?
            allocatedWidth : 0;
        const { nw, nh, max_rows: maxRows } = this.metricsFor(actor, children[0]);
        const perRow = Math.max(1, Math.trunc(boxWidth / nw));
        const capacity = Math.min(MAX_EVENT_DOTS_PER_CELL, maxRows * perRow);
        const visibleCount = Math.min(children.length, capacity);
        const rowCount = Math.min(maxRows, Math.ceil(visibleCount / perRow));
        let childIndex = 0;
        // One box for the whole allocation: allocate() copies what it is given,
        // so nothing downstream holds this. It used to be constructed per row,
        // inside the allocate handler of all 42 day cells — which Clutter runs
        // on every relayout of the grid, and the grid relayouts on every menu
        // open, month change, settings change and coalesced event update.
        const childBox = new Clutter.ActorBox();
        for (let row = 0; row < rowCount; row++) {
            const rowDots = Math.min(visibleCount - row * perRow, perRow);
            childBox.x1 = Math.floor((boxWidth - nw * rowDots) / 2);
            childBox.y1 = row * nh;
            childBox.x2 = childBox.x1 + nw;
            childBox.y2 = childBox.y1 + nh;
            while (childIndex < row * perRow + rowDots) {
                children[childIndex++].allocate(childBox, flags);
                childBox.x1 += nw;
                childBox.x2 += nw;
            }
        }
        return capacity;
    }
}

class Calendar {
    get _selectedDate() {
        return this._navigation.selectedDate;
    }

    set _selectedDate(date) {
        this._navigation.selectedDate = date;
    }

    constructor(settings, events_manager, holiday_provider, desktop_settings,
        reportIssue = () => {}) {
        this.events_manager = events_manager;
        this._weekStart = Cinnamon.util_get_week_start();
        this._digitWidth = NaN; // NOSONAR [S7773] -- accepted compatible form
        this.settings = settings;
        this.holiday = holiday_provider;
        this._monthWindows = new CalendarMonthWindowCache();
        this._holiday_update_generation = 0;

        this._update_id = 0;
        this._destroyed = false;

        this.settings.bindShowWeekNumbers(this, "show_week_numbers", this._onGridGeometryChanged);
        this.settings.bindWeekendLength(this, "weekend_length", this._onGridGeometryChanged);
        // The applet already owns a Gio.Settings for this schema and already
        // listens to it; a second object for the same schema meant two owners
        // of the same thing, so it is handed in. There is no fallback
        // construction any more: the one caller always passes one, and the
        // fallback existed only for tests that did not.
        this.desktop_settings = desktop_settings;
        this._desktop_settings_signal_ids =
            this.desktop_settings.connectFirstDayOfWeekChanged(this._onFirstWeekdayChanged.bind(this));

        // The weekday abbreviations and the weekend days come from the locale
        // query, which answers after the first paint — and they are both LC_TIME.
        // This used to be told whenever *any* env answered, so LC_ADDRESS landing
        // — historically queried for holiday language, though nothing in this
        // header depended on it — rebuilt the header, dropped
        // all 42 day cells and every tooltip on them, and made the next update
        // reconstruct the lot.
        this._locale_listener = LocaleQuery.onLocaleInfoChanged("LC_TIME", () => {
            this._buildHeader();
            this._queue_update();
        });

        // Event data is optional presentation state. It controls dots only;
        // the calendar remains independently browsable and selectable for
        // dates and holidays when Evolution, its calendars, or the setting is
        // unavailable.
        this.event_data_available = this.events_manager.is_active();
        this._events_manager_signal_ids = [
            this.events_manager.connect("events-updated", this._events_updated.bind(this)),
            this.events_manager.connect("events-manager-ready",
                this._update_event_data_availability.bind(this)),
            this.events_manager.connect("has-calendars-changed",
                this._update_event_data_availability.bind(this))
        ];

        // Find the ordering for month/year in the calendar heading

        switch (Gettext_gtk30.gettext(GTK_CALENDAR_ORDER_MSGID)) {
        case 'calendar:MY':
            this._headerMonthFirst = true;
            break;
        case 'calendar:YM':
            this._headerMonthFirst = false;
            break;
        default:
            log('Translation of "calendar:MY" in GTK+ is not correct');
            this._headerMonthFirst = true;
            break;
        }

        this.actor = new St.Table({ homogeneous: false,
                                    style_class: 'calendar',
                                    reactive: true });

        this._gridHost = new CalendarGridHost({
            selectedDate: () => this._selectedDate,
            weekStart: () => this._weekStart,
            weekendLength: () => this.weekend_length,
            eventDataAvailable: () => this.event_data_available,
            eventsManager: this.events_manager,
            holidayProvider: () => this.holiday,
            holidayGeneration: () => this._holiday_update_generation,
            selectDate: (date) => this.setDate(date, false),
            allocateDotBox: (actor, box, flags) =>
                this._gridView.allocateDotBox(actor, box, flags),
            dotCapacityChanged: () => this._queue_update(),
            renderDots: (cell, iter, key) => this._eventDotRenderer.update(cell, iter, key),
            nameCell: (cell) => this._dayCellRenderer.applyAccessibleName(cell),
            reportIssue,
            holidaysChanged: () => this.emit("holidays-changed")
        });
        this._eventDotRenderer = new CalendarEventDotRenderer(this._gridHost);
        this._dayCellRenderer = new CalendarDayCellRenderer(this._gridHost);
        this._gridView = new CalendarGridView({
            actor: () => this.actor,
            showWeekNumbers: () => this.show_week_numbers,
            weekendLength: () => this.weekend_length
        }, this._dayCellRenderer);
        this._holidayAnnotator = new CalendarHolidayAnnotator(this._gridHost);

        this._navigation = new CalendarNavigationController({
            actor: () => this.actor,
            dayCells: () => this._gridView.dayCells,
            emitSelected: (date) => this.emit('selected-date-changed', date),
            update: () => this._update(),
            setDate: (date, forceReload) => this.setDate(date, forceReload),
            queueDate: (date) => this.queue_set_date(date)
        });

        this.actor.connect('style-changed', this._onStyleChange.bind(this));
        this.actor.connect('scroll-event',
                           this._onScroll.bind(this));
        this.actor.connect('key-press-event',
                           this._onKeyPress.bind(this));

        this._buildHeader ();
    }

    _events_updated(events_manager) {
        this._queue_update();
    }

    _cancel_update() {
        if (this._update_id > 0) {
            Mainloop.source_remove(this._update_id);
            this._update_id = 0;
        }
    }

    _queue_update() {
        this._cancel_update();
        // destroy() reset the grid view, so a later refresh would re-arm the
        // idle and rebuild 42 cells and tooltips into a destroyed St.Table.
        // Several applet call sites do not null-guard their calendar.
        if (this._destroyed) {
            return;
        }

        this._update_id = Mainloop.idle_add(this._idle_do_update.bind(this));
    }

    _idle_do_update() {
        this._update_id = 0;
        this._update();

        return GLib.SOURCE_REMOVE;
    }

    _cancel_set_date_idle() {
        this._navigation.cancelQueuedDate();
    }

    queue_set_date(date) {
        this._navigation.queueDate(date);
    }

    destroy() {
        this._destroyed = true;
        this._holiday_update_generation++;
        this._cancel_update();
        this._cancel_set_date_idle();
        if (this._locale_listener) {
            this._locale_listener();
            this._locale_listener = null;
        }
        if (this._desktop_settings_signal_ids.length > 0) {
            this.desktop_settings.disconnect(this._desktop_settings_signal_ids);
            this._desktop_settings_signal_ids = [];
        }

        for (let id of this._events_manager_signal_ids) {
            this.events_manager.disconnect(id);
        }
        this._events_manager_signal_ids = [];

        // The actors go with the menu, but everything below is the grid's own
        // and the applet that holds the grid outlives its removal from the
        // panel: 42 Dates, 42 day keys and 42 formatted day names in the cached
        // window, and a month of matched holidays in the annotator.
        this._gridView.reset();
        this._monthWindows.invalidate();
        this._holidayAnnotator.release();
    }

    _update_event_data_availability() {
        this.event_data_available = this.events_manager.is_active();
        this._queue_update();
    }

    // The show-events setting participates in is_active(), but changing it
    // fires the applet's settings handler, not the manager's signals — so the
    // grid kept stale event dots after the user switched events off. The
    // applet calls this beside the event-column coordinator.
    refreshEventDataAvailability() {
        this._update_event_data_availability();
    }

    _headerSignature() {
        return this._weekStart + "|" + this.show_week_numbers;
    }

    // Two callers, two contracts. Cinnamon's bindWithObject invokes its
    // callback as (value, user_data) and Gio's "changed::" handler as
    // (settings, key), so one method taking (object, key) meant its parameters
    // named different things per caller and the key test was dead on the bind
    // path. Each contract gets its own zero-argument entry point and they
    // share the rebuild below.
    _onGridGeometryChanged() {
        this._applySettingsChange();
    }

    _onFirstWeekdayChanged() {
        this._weekStart = Cinnamon.util_get_week_start();
        this._applySettingsChange();
    }

    _applySettingsChange() {
        // destroying and rebuilding the header on unrelated settings churn
        // is wasted allocation; only grid geometry affects it
        const signature = this._headerSignature();
        if (signature !== this._header_signature) {
            this._buildHeader();
        }
        this._update();
    }

    refreshHolidays() {
        this._queue_update();
    }

    // Local midnight passed: the data is unchanged but the "today" highlight is
    // a day behind. render() recomputes today on every pass, so a queued update
    // is the whole move.
    refreshToday() {
        this._queue_update();
    }

    // The OS zone moved under us. Unlike midnight, this does invalidate the
    // cached window: its day keys are the unix seconds the grid matches event
    // buckets on, and its accessible day names were formatted in the old zone.
    refreshTimezone() {
        this._monthWindows.invalidate();
        this._queue_update();
    }

    // Sets the calendar to show a specific date
    setDate(date, forceReload) {
        return this._navigation.setDate(date, forceReload);
    }

    getSelectedDate() {
        return this._selectedDate;
    }

    todaySelected() {
        return _today(this._selectedDate);
    }

    // the nav buttons carry only an icon from the theme; without a name a
    // screen reader announces four identical "button"s
    _navButton(styleClass, accessibleName) {
        const button = new St.Button({ style_class: styleClass, can_focus: true });
        if (button.set_accessible_name) {
            button.set_accessible_name(accessibleName);
        }
        button.accessible_name = accessibleName;
        return button;
    }

    _buildHeader() {
        let offsetCols = this.show_week_numbers ? 1 : 0;
        this.actor.destroy_all_children();
        // The day-cell actors died with the table children. An annotation pass
        // still in flight captured those cells, and its generation guard only
        // watches for a *newer pass* — destroy() already strands in-flight
        // passes this way; a rebuild kills the same actors and must too, or the
        // async holiday answer writes tooltips onto disposed buttons.
        this._holiday_update_generation++;
        this._gridView.reset();

        // Top line of the calendar '<| September |> <| 2009 |>'
        this._topBoxMonth = new St.BoxLayout();
        this._topBoxYear = new St.BoxLayout();

        if (this._headerMonthFirst) {
            this.actor.add(this._topBoxMonth,
                       {row: 0, col: 0, col_span: offsetCols + 4});
            this.actor.add(this._topBoxYear,
                       {row: 0, col: offsetCols + 4, col_span: 3});
        } else {
            this.actor.add(this._topBoxMonth,
                       {row: 0, col: offsetCols + 3, col_span: 4});
            this.actor.add(this._topBoxYear,
                       {row: 0, col: 0, col_span: offsetCols + 3});
        }

        let back = this._navButton('calendar-change-month-back', _("Previous month"));
        this._topBoxMonth.add(back);
        back.connect('clicked', this._onPrevMonthButtonClicked.bind(this));

        // reactive: a tooltip is driven by enter-event, and a non-reactive
        // actor is not pickable, so it never emits one. The holiday status
        // tooltip hangs off this label — "loading", "service unavailable", the
        // provider's name — and without this none of it could ever be seen.
        //
        // There used to be a key-focus-in handler here that opened the same
        // tooltip for the keyboard. It could not work — Cinnamon's Tooltip.show()
        // refuses without a mousePosition, and TooltipBase hides on the stage's
        // notify::key-focus — so the reason now lives in a real actor instead of
        // a hover. See CalendarMonthLabel.
        const monthBox = new St.BoxLayout({ vertical: true });
        this._monthLabel = new St.Label({
            style_class: 'calendar-month-label', reactive: true });
        this._holidayReasonLabel = new St.Label({
            style_class: 'calendar-holiday-reason', visible: false });
        this._holidayReasonLabel.get_clutter_text().line_wrap = true;

        monthBox.add(this._monthLabel, { x_fill: false, x_align: St.Align.MIDDLE });
        monthBox.add(this._holidayReasonLabel, { x_fill: false, x_align: St.Align.MIDDLE });

        // the header builds the labels; the annotator is the only thing that
        // writes them, and it owns the tooltip and status text that go with them
        this._holidayAnnotator.attachLabel(this._monthLabel, this._holidayReasonLabel);

        this._topBoxMonth.add(monthBox, { expand: true, x_fill: false, x_align: St.Align.MIDDLE });

        let forward = this._navButton('calendar-change-month-forward', _("Next month"));
        this._topBoxMonth.add(forward);
        forward.connect('clicked', this._onNextMonthButtonClicked.bind(this));

        back = this._navButton('calendar-change-month-back', _("Previous year"));
        this._topBoxYear.add(back);
        back.connect('clicked', this._onPrevYearButtonClicked.bind(this));

        this._yearLabel = new St.Label({style_class: 'calendar-month-label'});
        // The rendered value belongs to this actor. A locale or week-number
        // change replaces the label, so keeping the old actor's cache makes
        // _update() believe the new, empty label already contains this year.
        this._rendered_year = null;
        this._topBoxYear.add(this._yearLabel, {expand: true, x_fill: false, x_align: St.Align.MIDDLE});

        forward = this._navButton('calendar-change-month-forward', _("Next year"));
        this._topBoxYear.add(forward);
        forward.connect('clicked', this._onNextYearButtonClicked.bind(this));

        // the week-number gutter needs a header cell so the column
        // reserves its digit-based width above the week labels
        this._weekdateHeader = null;
        if (this.show_week_numbers) {
            this._weekdateHeader = new St.Label(
                { style_class: 'calendar-day-base calendar-day-heading' });
            // it exists to reserve the column's width, so it carries no text —
            // which leaves the week-number column with no heading at all
            if (this._weekdateHeader.set_accessible_name) {
                this._weekdateHeader.set_accessible_name(_("Week"));
            }
            this.actor.add(this._weekdateHeader,
                { row: 1, col: 0, x_fill: false, x_align: St.Align.MIDDLE });
            this._setWeekdateHeaderWidth();
        }

        // Add weekday labels...
        //
        // We need to figure out the abbreviated localized names for the days of the week;
        // we do this by just getting the next 7 days starting from right now and then putting
        // them in the right cell in the table. It doesn't matter if we add them in order
        let iter = new Date(this._selectedDate);
        iter.setSeconds(0); // Leap second protection. Hah!
        iter.setHours(12);
        for (let i = 0; i < 7; i++) {
            // Could use iter.toLocaleFormat('%a') but that normally gives three characters
            // and we want, ideally, a single character for e.g. S M T W T F S
            let customDayAbbrev = _getCalendarDayAbbreviation(iter.getDay());
            let label = new St.Label({ style_class: this._dayHeadingStyleClass(iter), text: customDayAbbrev });
            this._gridView.addDayHeading(label, new Date(iter));
            this.actor.add(label,
                           { row: 1,
                             col: offsetCols + (7 + iter.getDay() - this._weekStart) % 7,
                             x_fill: false, x_align: St.Align.MIDDLE });
            iter.setTime(iter.getTime() + MSECS_IN_DAY);
        }

        this._header_signature = this._headerSignature();
    }

    _onStyleChange() {
        // width of a digit in pango units
        this._digitWidth = _getDigitWidth(this.actor) / Pango.SCALE;
        this._setWeekdateHeaderWidth();
        // the dot size and max-rows come from the theme, and this is the one
        // moment they can change
        this._gridView.invalidateStyle();
    }

    _setWeekdateHeaderWidth() {
        if (!isNaN(this._digitWidth) && this.show_week_numbers && this._weekdateHeader) { // NOSONAR [S7773] -- accepted compatible form
            this._weekdateHeader.set_width (this._digitWidth * WEEKDATE_HEADER_WIDTH_DIGITS);
        }
    }

    // The menu opens on a hotkey, so the grid has to be usable without a
    // mouse: arrows walk days and weeks, PageUp/PageDown walk months, Home
    // returns to today.
    _onKeyPress(actor, event) {
        return this._navigation.onKeyPress(event);
    }

    focusSelectedDay() {
        return this._navigation.focusSelectedDay();
    }

    holidayForDate(date) {
        return this._holidayAnnotator.holidayForDate(date);
    }

    _onScroll(actor, event) {
        this._navigation.onScroll(event);
    }

    _applyDateBrowseAction(yearChange, monthChange) {
        this._navigation.applyBrowse(yearChange, monthChange);
    }

    _onPrevYearButtonClicked() {
        this._applyDateBrowseAction(-1, 0);
    }

    _onNextYearButtonClicked() {
        this._applyDateBrowseAction(1, 0);
    }

    _onPrevMonthButtonClicked() {
        this._applyDateBrowseAction(0, -1);
    }

    _onNextMonthButtonClicked() {
        this._applyDateBrowseAction(0, 1);
    }

    _update() {
        if (this._destroyed) {
            return;
        }

        this._holidayAnnotator.beginUpdate();
        // the month name beside it is memoised; the year was not, and it changes
        // once a year while _update() runs on every menu open, settings change and
        // event delivery — each one a fresh GLib.DateTime plus a strftime
        const year = String(this._selectedDate.getFullYear());
        if (this._rendered_year !== year) {
            this._rendered_year = year;
            this._yearLabel.text = _formatJsDate(this._selectedDate, '%Y');
        }

        const holiday_generation = ++this._holiday_update_generation;
        // The annotator is the only consumer of this map, and it answers early
        // for an inactive provider: building 42 template-string keys for it on
        // every update, with holidays switched off, is pure waste. It is still
        // needed for the pass that *removes* the marks a country left behind.
        const annotating = Boolean(this.holiday && this.holiday.active) || // NOSONAR [S6582] -- accepted compatible form
            this._holidayAnnotator.annotated;
        const monthWindow = this._monthWindows.get(this._selectedDate, this._weekStart);
        const cells = this._gridView.render(monthWindow, annotating);
        this._holidayAnnotator.annotate(monthWindow.months, cells, holiday_generation);
    }

    _dayHeadingStyleClass(iter) {
        return this._gridView.dayHeadingStyleClass(iter);
    }

}

Signals.addSignalMethods(Calendar.prototype);

if (typeof module !== "undefined") {
    module.exports = {
        Calendar,
        CalendarMonthWindow,
        CalendarMonthWindowCache,
        CalendarGridHost,
        CalendarGridView,
        CalendarDayCellRenderer,
        CalendarEventDotRenderer,
        MAX_EVENT_DOTS_PER_CELL,
        _isWorkDay,
        _sameDay,
        _today
    };
}
