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

const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Signals = imports.signals;
const Pango = imports.gi.Pango;
const Gettext_gtk30 = imports.gettext.domain('gtk30');
const Cinnamon = imports.gi.Cinnamon;
const Mainloop = imports.mainloop;
const LocaleQuery = require("./localeQuery");
const LocaleText = require("./localeText");
const CalendarNavigation = require("./calendarNavigation");
const CalendarDate = require("./calendarDate");
const CalendarNavigationController = CalendarNavigation.CalendarNavigationController;
const _formatJsDate = CalendarDate.formatJsDate;
const _sameDay = CalendarDate.sameDay;
const _today = CalendarDate.isToday;
const CalendarMonthWindowModule = require("./calendarMonthWindow");
const CalendarGrid = require("./calendarGrid");
const CalendarMonthWindow = CalendarMonthWindowModule.CalendarMonthWindow;
const CalendarMonthWindowCache = CalendarMonthWindowModule.CalendarMonthWindowCache;
const CalendarGridHost = CalendarGrid.CalendarGridHost;
const CalendarGridView = CalendarGrid.CalendarGridView;
const CalendarDayCellRenderer = CalendarGrid.CalendarDayCellRenderer;
const CalendarEventDotRenderer = CalendarGrid.CalendarEventDotRenderer;
const MAX_EVENT_DOTS_PER_CELL = CalendarGrid.MAX_EVENT_DOTS_PER_CELL;
const _isWorkDay = CalendarGrid._isWorkDay;
const CalendarAnnotations = require("./calendarAnnotations");
const CalendarHolidayAnnotator = CalendarAnnotations.CalendarHolidayAnnotator;

const _ = LocaleText.translate;

// GTK's own msgid, asked of GTK's own domain: it answers "calendar:MY" or
// "calendar:YM" to say which way round the month and year go. Not a literal at the
// call site, because our .pot extractor scans gettext() calls and would harvest
// GTK's msgid into our catalog, where nobody could translate it into anything
// meaningful.
const GTK_CALENDAR_ORDER_MSGID = 'calendar:MY';
const GTK_CALENDAR_YEAR_FIRST = 'calendar:YM';

// A pure reading of GTK's answer, so the two orders and the broken-translation
// case can be exercised without reloading this module against three different
// gettext domains. An answer that is neither is a translation bug in GTK's own
// catalog, and month-first is the more common order to fall back to.
function headerMonthFirst(order) {
    if (order === GTK_CALENDAR_YEAR_FIRST) {
        return false;
    }
    if (order !== GTK_CALENDAR_ORDER_MSGID) {
        log('Translation of "calendar:MY" in GTK+ is not correct');
    }
    return true;
}

const WEEKDATE_HEADER_WIDTH_DIGITS = 3;

const _lcAbday = LocaleQuery.lazyLocaleValue("LC_TIME", (info) => info.abday.split(";"));

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
        this._headerMonthFirst = headerMonthFirst(
            Gettext_gtk30.gettext(GTK_CALENDAR_ORDER_MSGID));

        this.actor = new St.Table({ homogeneous: false,
                                    style_class: 'calendar',
                                    reactive: true });

        this._gridHost = new CalendarGridHost({
            selectedDate: () => this._selectedDate,
            weekStart: () => this._weekStart,
            weekendLength: () => this.weekend_length,
            eventDataAvailable: () => this.event_data_available,
            // thunks, both of them: `eventsManager` was the one port member
            // captured as a value at construction, so it went stale if the
            // field was ever reassigned
            colorsForUnixKey: (dateUnixKey) =>
                this.events_manager.get_colors_for_unix_key(dateUnixKey),
            holidaysActive: () => Boolean(this.holiday && this.holiday.active), // NOSONAR [S6582] -- accepted compatible form
            requestHolidays: (year, month, callback) =>
                this.holiday.getHolidays(year, month, callback),
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
        const weekStart = Cinnamon.util_get_week_start();
        if (weekStart === this._weekStart) {
            return;
        }
        this._weekStart = weekStart;
        this.events_manager.select_date(this._selectedDate, true);
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

    // The header is the month and year lines, the four navigation buttons, the
    // optional week-number gutter heading and the seven weekday headings. It
    // was one 115-line method, so the destructive-rebuild semantics above were
    // buried in the middle of actor plumbing.
    _buildHeader() {
        const offsetCols = this.show_week_numbers ? 1 : 0;

        this._resetGridForRebuild();
        this._buildHeaderBoxes(offsetCols);
        this._buildMonthHeader();
        this._buildYearHeader();
        this._buildWeekNumberHeading();
        this._buildWeekdayHeadings(offsetCols);

        this._header_signature = this._headerSignature();
    }

    // A destructive rebuild: every actor below is new, and the day cells the
    // last pass handed to the annotator are gone. That is why the generation
    // moves here — an annotation pass still in flight captured those cells, and
    // its generation guard only watches for a *newer pass*. destroy() already
    // strands in-flight passes this way; a rebuild kills the same actors and
    // must too, or the async holiday answer writes tooltips onto disposed
    // buttons.
    _resetGridForRebuild() {
        this.actor.destroy_all_children();
        this._holiday_update_generation++;
        this._gridView.reset();
    }

    // Top line of the calendar '<| September |> <| 2009 |>', in the order the
    // locale puts them.
    _buildHeaderBoxes(offsetCols) {
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
    }

    _buildMonthHeader() {
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

        const forward = this._navButton('calendar-change-month-forward', _("Next month"));
        this._topBoxMonth.add(forward);
        forward.connect('clicked', this._onNextMonthButtonClicked.bind(this));
    }

    _buildYearHeader() {
        const back = this._navButton('calendar-change-month-back', _("Previous year"));
        this._topBoxYear.add(back);
        back.connect('clicked', this._onPrevYearButtonClicked.bind(this));

        this._yearLabel = new St.Label({style_class: 'calendar-month-label'});
        // The rendered value belongs to this actor. A locale or week-number
        // change replaces the label, so keeping the old actor's cache makes
        // _update() believe the new, empty label already contains this year.
        this._rendered_year = null;
        this._topBoxYear.add(this._yearLabel, {expand: true, x_fill: false, x_align: St.Align.MIDDLE});

        const forward = this._navButton('calendar-change-month-forward', _("Next year"));
        this._topBoxYear.add(forward);
        forward.connect('clicked', this._onNextYearButtonClicked.bind(this));
    }

    // the week-number gutter needs a header cell so the column
    // reserves its digit-based width above the week labels
    _buildWeekNumberHeading() {
        this._weekdateHeader = null;
        if (!this.show_week_numbers) {
            return;
        }

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

    // Headings are the seven Gregorian weekdays, independent of any timezone
    // transition in the selected week.
    _buildWeekdayHeadings(offsetCols) {
        for (let weekday = 0; weekday < 7; weekday++) {
            const customDayAbbrev = _getCalendarDayAbbreviation(weekday);
            const label = new St.Label({ style_class: this._dayHeadingStyleClass(weekday), text: customDayAbbrev });
            this._gridView.addDayHeading(label, weekday);
            this.actor.add(label,
                           { row: 1,
                             col: offsetCols + (7 + weekday - this._weekStart) % 7,
                             x_fill: false, x_align: St.Align.MIDDLE });
        }
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
        return this._navigation.onScroll(event);
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
        headerMonthFirst,
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
