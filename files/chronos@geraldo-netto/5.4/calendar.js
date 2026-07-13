/* global imports */
/* eslint camelcase: "off" */

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Tooltips = imports.ui.tooltips;
const Signals = imports.signals;
const Pango = imports.gi.Pango;
const Gettext_gtk30 = imports.gettext.domain('gtk30');
const Cinnamon = imports.gi.Cinnamon;
const Mainloop = imports.mainloop;
const Utils = require("./utils");
const SettingsFacade = require("./settingsFacade");
// only HOLIDAY_ERRORS is read here, and it is declared in holidayConstants;
// requiring the holidays barrel linked the cache repository, the three vendor
// adapters and the HTTP session into the day grid
const Holidays = require("./holidayConstants");
const EventDataModule = require("./eventData");

const _ = Utils.translate;
const joinPhrases = Utils.joinPhrases;
const ngettext = Utils.translatePlural;
const date_only = EventDataModule.date_only;
const js_date_to_gdatetime = EventDataModule.js_date_to_gdatetime;

const MSECS_IN_DAY = Utils.MSECS_IN_DAY;
const WEEKDATE_HEADER_WIDTH_DIGITS = 3;
// how much smooth-scroll delta makes one month. Clutter reports a touchpad's
// scroll in fractions of a notch, and one notch is what a mouse wheel sends.
const SMOOTH_SCROLL_NOTCH = 1;
// the key name itself lives in the settings boundary, with the schema
const FIRST_WEEKDAY_KEY = SettingsFacade.FIRST_DAY_OF_WEEK_KEY;
const PART_DAY_HOLIDAY = 'PART_DAY_HOLIDAY';
const HOLIDAY_ERROR_MARKER = Utils.UI_ERROR_MARKER;
const HOLIDAY_PENDING_MARKER = "…";
// weekday, day, month and year: what a sighted user reads off the grid
// The visible full date is locale-ordered through the shared format, so a
// hardcoded day-month order here meant an en_US user saw "Saturday, July 12,
// 2026" while their screen reader said "Saturday, 12 July 2026". Same date,
// same applet, two different orders.
const ACCESSIBLE_DATE_FORMAT = Utils.DATE_FORMAT_FULL;

const _lcAbday = Utils.lazyLocaleValue("LC_TIME", (info) => info.abday.split(";"));
const _lcFirstWorkday = Utils.lazyLocaleValue("LC_TIME", (info) => (info.first_workday + 6) % 7);

// Date.prototype.toLocaleFormat is a non-standard SpiderMonkey extension
// that modern GJS removed; format through GLib.DateTime instead
function _formatJsDate(jsDate, fmt) {
    const dt = GLib.DateTime.new_local(
        jsDate.getFullYear(), jsDate.getMonth() + 1, jsDate.getDate(), 12, 0, 0);
    return dt ? dt.format(fmt) : "";
}

const DAY_KEY_DELTAS = {
    [Clutter.KEY_Left]: -1,
    [Clutter.KEY_Right]: 1,
    [Clutter.KEY_Up]: -7,
    [Clutter.KEY_Down]: 7
};

// Left and Right are directions on the screen, not directions in time. In an RTL
// locale St mirrors the grid, so the cell to the *left* of Tuesday is Wednesday —
// and walking a day back on Left moved the focus rightward, which is to say the
// arrow keys were inverted for every Arabic and Hebrew user. Cinnamon's own
// popupMenu.js asks the same question of the same actor before it decides what
// Left means.
const MIRRORED_KEYS = new Set([Clutter.KEY_Left, Clutter.KEY_Right]);

function _sameDay(dateA, dateB) {
    return (dateA.getDate() == dateB.getDate() &&
            dateA.getMonth() == dateB.getMonth() &&
            dateA.getYear() == dateB.getYear());
}

function _today(date, today = new Date()) {
    return (date.getDate() == today.getDate() &&
            date.getMonth() == today.getMonth() &&
            date.getYear() == today.getYear());
}

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

// holiday providers report canonical error ids; translate at display time.
const HOLIDAY_ERROR_TEXT = {
    [Holidays.HOLIDAY_ERRORS.SERVICE_UNAVAILABLE]: _("Holiday service unavailable"),
    [Holidays.HOLIDAY_ERRORS.INVALID_RESPONSE]: _("Holiday data unavailable")
};

function translateHolidayError(error) {
    return HOLIDAY_ERROR_TEXT[error] || error;
}

// The window depends only on the displayed month and the week start, but
// _update() runs on every menu open, settings change and event update, and
// rebuilding it costs 42 Dates plus 84 GLib.DateTimes every time.
class CalendarMonthWindowCache {
    constructor() {
        this._key = "";
        this._window = null;
    }

    get(selectedDate, weekStart) {
        const key = `${selectedDate.getFullYear()}/${selectedDate.getMonth()}/${weekStart}`;
        if (this._key !== key || !this._window) {
            this._key = key;
            this._window = new CalendarMonthWindow(selectedDate, weekStart);
        }

        return this._window;
    }
}

class CalendarMonthWindow {
    constructor(selectedDate, weekStart) {
        this.selectedDate = selectedDate;
        this.weekStart = weekStart;
        this.beginDate = this._beginDate();
        this.days = this._buildDays();
        this.dateUnixKeys = this.days.map((day) =>
            date_only(js_date_to_gdatetime(day)).to_unix());
        // one GLib.DateTime plus a format per cell, and _update() runs on every
        // menu open, month change, settings change and coalesced event update:
        // the name depends only on the date in the slot, so it belongs here
        // with the rest of the per-month work
        this.accessibleDates = this.days.map((day) =>
            _formatJsDate(day, ACCESSIBLE_DATE_FORMAT));
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
        const daysToWeekStart = Utils.monthWindowStartOffset(
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
// Cinnamon's Tooltip.set_text() has no equality guard: it calls
// allocate_preferred_size() and queue_relayout() unconditionally, so writing
// byte-identical text still forces a relayout. This applet writes the same text
// over and over — the month tooltip is cleared on every _update() and re-set by
// annotate(), and every holiday cell's tooltip is cleared and re-set on every
// pass — so a month with a dozen holidays paid ~30 forced relayouts per update,
// for text that had not changed.
//
// The grid already diffs rendered_style, dot_key and accessible_name before
// writing them. The tooltips are the ones that were missed.
function setTooltipText(owner, tooltip, text) {
    if (owner.rendered_tooltip === text) {
        return;
    }

    owner.rendered_tooltip = text;
    tooltip.set_text(text);
}

class CalendarGridHost {
    constructor(calendar) {
        this._calendar = calendar;
    }

    get selectedDate() {
        return this._calendar._selectedDate;
    }

    get weekStart() {
        return this._calendar._weekStart;
    }

    get weekendLength() {
        return this._calendar.weekend_length;
    }

    get eventsEnabled() {
        return this._calendar.events_enabled;
    }

    get eventsManager() {
        return this._calendar.events_manager;
    }

    get holidayProvider() {
        return this._calendar.holiday;
    }

    // a fetch that lands after the grid moved on belongs to a month that is no
    // longer on screen
    get holidayGeneration() {
        return this._calendar._holiday_update_generation;
    }

    selectDate(date) {
        this._calendar.setDate(date, false);
    }

    allocateDotBox(actor, box, flags) {
        this._calendar._allocate_dot_box(actor, box, flags);
    }

    // the cell renderer draws the dots and the annotator renames the cell it
    // just annotated: both used to reach through the calendar for the other
    renderDots(cell, iter, dateUnixKey) {
        this._calendar._eventDotRenderer.update(cell, iter, dateUnixKey);
    }

    nameCell(cell) {
        this._calendar._dayCellRenderer.applyAccessibleName(cell);
    }
}

class CalendarDayCellRenderer {
    constructor(host) {
        this.host = host;
    }

    update(cell, iter, row, today, dateUnixKey, accessibleDate) {
        // the slot is reused: whether it is showing a different day now is what
        // decides whether last pass's holiday annotation still belongs to it
        const dateChanged = !cell.date || !_sameDay(cell.date, iter);
        cell.date = new Date(iter.getTime());
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

        // a holiday annotation appends classes after our write, so an
        // annotated cell needs a rewrite even when the base is unchanged
        const styleClass = this._dayStyleClass(iter, row, today);
        if (cell.rendered_style !== styleClass || cell.holiday_styled) {
            cell.button.style_class = styleClass;
            cell.rendered_style = styleClass;
            cell.holiday_styled = false;
        }

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

        // clear any holiday annotation from the date previously shown here
        if (dateChanged && cell.holiday_tooltip_set) {
            setTooltipText(cell, cell.holidayTooltip, "");
            cell.holiday_tooltip_set = false;
        }

        this.host.renderDots(cell, iter, dateUnixKey);
        this.applyAccessibleName(cell);
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
        if (cell.holiday_name) {
            parts.push(cell.holiday_name.split("\n").join(", "));
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

        cell.dot_box.connect('allocate',
            (actor, box, flags) => this.host.allocateDotBox(actor, box, flags));
        cell.group.add_actor(cell.dot_box);

        // reads cell.date so the reused button always selects the date
        // it currently displays
        cell.button.connect('clicked', () => {
            if (!this.host.eventsEnabled || !cell.date) {
                return;
            }
            this.host.selectDate(new Date(cell.date.getTime()));
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

    update(cell, iter, dateUnixKey) {
        const color_set = this.host.eventsManager.get_colors_for_unix_key(dateUnixKey);
        const colors = (this.host.eventsEnabled && color_set !== null) ?
            color_set.map((color) => Utils.safeCssColor(color)) : [];

        // the dots are the only sign that a day has events, and they are 4px of
        // colour: the count goes into the cell's name so it can be said as well
        // as seen
        cell.event_count = colors.length;

        const dot_key = colors.join("|");
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

// The month label and everything written on it: the month's name, the pending
// and failure markers, the status tooltip, the accessible name.
//
// The annotator used to write all of this straight onto the calendar —
// _monthLabel.text, _holidayTooltip, _holiday_status_text — and _buildHeader
// owned and reset the same three fields. Two owners for one piece of state.
// The label is built by the header and handed here, and this is the only thing
// that writes it.
class CalendarMonthLabel {
    constructor(label, reasonLabel = null) {
        this.label = label;
        // the reason a month is marked ⚠, as a real actor rather than a hover
        this.reasonLabel = reasonLabel;
        this.tooltip = null;
        this.statusText = "";
    }

    setText(text) {
        // St.Label compares by pointer, so writing a byte-identical string still
        // queues a relayout; the month name changes once a month and _update()
        // runs on every menu open, settings change and event delivery
        if (this.label.text !== text) {
            this.label.text = text;
        }
    }

    // `text` is the whole status, for the mouse tooltip and the accessible name.
    // `reason` is set only when something is actually wrong, and it is what a
    // user with neither a mouse nor a screen reader reads off the popup.
    //
    // The reason used to live in the tooltip alone, shown from a key-focus-in
    // handler — which cannot work. Cinnamon's Tooltip.show() opens with
    //
    //     if (this._tooltip.get_text() == "" || !this.mousePosition) return;
    //
    // and mousePosition is only ever set from enter-event and motion-event; a
    // keyboard sets it never. TooltipBase also connects global.stage's
    // notify::key-focus straight to its own _hide, so moving focus onto the label
    // hides the very tooltip the focus handler is trying to open. It shipped, and
    // it never once worked: the keyboard-only user saw "July ⚠" and had no way to
    // find out why.
    setStatus(text, reason = "") {
        this.statusText = text;
        this._setTooltip(text);

        if (!this.reasonLabel) {
            return;
        }

        // no space is taken when there is nothing wrong, so the ordinary month
        // looks exactly as it did
        this.reasonLabel.visible = Boolean(reason);
        if (reason && this.reasonLabel.text !== reason) {
            this.reasonLabel.text = reason;
        }
    }

    _setTooltip(text) {
        if (!text && !this.tooltip) {
            return;
        }

        if (!this.tooltip) {
            this.tooltip = new Tooltips.Tooltip(this.label);
        }
        setTooltipText(this, this.tooltip, text);
    }

    setAccessibleName(name) {
        if (this.label.set_accessible_name) {
            this.label.set_accessible_name(name);
        }
        this.label.accessible_name = name;
    }
}

class CalendarHolidayAnnotator {
    constructor(host) {
        this.host = host;
        this._month_name_key = "";
        this._month_name = "";
        // the status of the holiday lookup is this collaborator's own: it is
        // what produces it, and it was writing it back into the calendar's
        // private fields for nobody else to read
        this.error = "";
        this.provider = "";
        this.monthLabel = null;
        // whether any cell currently carries a holiday mark, so the grid knows
        // whether it still has to hand us the cells when holidays are switched off
        this.annotated = false;
    }

    // the header builds the label and gives it to us; nothing else writes it
    attachLabel(label, reasonLabel = null) {
        this.monthLabel = new CalendarMonthLabel(label, reasonLabel);
        return this.monthLabel;
    }

    // three sites want the month's name and all three ran a fresh GLib.DateTime
    // and a format to get it, on every update; it changes once a month
    _monthName() {
        const date = this.host.selectedDate;
        const key = `${date.getFullYear()}/${date.getMonth()}`;

        if (this._month_name_key !== key) {
            this._month_name_key = key;
            this._month_name = _formatJsDate(date, '%OB').capitalize();
        }

        return this._month_name;
    }

    // A new pass over the grid: last pass's error belongs to last pass, and the
    // month name may have changed.
    //
    // This used to be a full setStatus(""), which wrote an empty status to the
    // tooltip that annotate() then immediately overwrote with the real one — two
    // forced relayouts per update, for a status that had not changed. Cinnamon's
    // Tooltip.set_text() has no equality guard, so both of them cost a relayout.
    beginUpdate() {
        this.error = "";
        this.provider = "";

        if (this.monthLabel) {
            this.monthLabel.setText(this._monthName());
        }
    }

    // a slow or hanging holiday service must not look the same as a month
    // with no holidays; weather has the same pending marker
    setPending() {
        if (!this.monthLabel) {
            return;
        }

        this.monthLabel.setText(this._monthName() + " " + HOLIDAY_PENDING_MARKER);
        // a lookup in flight is not a failure: the ellipsis on the label says it,
        // and a line of text that appears and vanishes a second later says less
        this._report(_("Holiday data: %s").format(_("loading…")));
    }

    setStatus(error, providerName = "") {
        this.error = error || "";
        this.provider = providerName || "";

        if (!this.monthLabel) {
            return;
        }

        this.monthLabel.setText(this._monthName() +
            (this.error ? " " + HOLIDAY_ERROR_MARKER : ""));

        const status = this.error ?
            translateHolidayError(this.error) +
                (this.provider ? " (" + this.provider + ")" : "") :
            this.provider;
        // the reason is shown as text only when something is wrong; the provider
        // credit on a good month belongs in the tooltip and the accessible name,
        // not as a permanent line under the month
        this._report(status ? _("Holiday data: %s").format(status) : "",
            this.error ? status : "");
    }

    // the warning glyph is decorative: on its own it reads as an unnamed
    // symbol, and the explanation only existed in a hover tooltip
    _report(status, reason = "") {
        this.monthLabel.setStatus(status, reason);

        const month = this._monthName();
        this.monthLabel.setAccessibleName(status ? joinPhrases(month, status) : month);
    }

    // an answer for a country the user has since changed away from owns nothing
    // on this grid
    _isCurrent(holiday_generation) {
        return holiday_generation === this.host.holidayGeneration;
    }

    _reportProvider(error, providerName) {
        if (error) {
            this.setStatus(error, providerName);
        } else if (!this.error) {
            this.setStatus("", providerName);
        }
    }

    _markCells(dates, cells) {
        for (const [date, [name, flags]] of dates.entries()) {
            const cell = cells.get(date);
            if (cell) {
                this._annotateCell(cell, name, flags);
            }
        }
    }

    annotate(months, cells, holiday_generation) {
        const holiday = this.host.holidayProvider;
        if (!holiday || !holiday.country) {
            // holidays were switched off, or the country was cleared: the marks
            // on the grid belong to a country the user is no longer asking about
            this.clearAnnotations(cells);
            this._report("");
            return;
        }

        let awaited = 0;
        for (let month of months) {
            const [y, m] = month.split('/');
            awaited++;
            holiday.getHolidays(y, m, (dates, error, providerName) => {
                if (!this._isCurrent(holiday_generation)) {
                    return;
                }

                awaited--;
                this._reportProvider(error, providerName);
                this._markCells(dates, cells);
            });
        }

        // a cached month answers inside getHolidays; anything still awaited is
        // a real network round-trip the user should see
        if (awaited > 0) {
            this.setPending();
        }
    }

    clearAnnotations(cells) {
        this.annotated = false;

        for (const cell of cells.values()) {
            if (!cell.holiday_name && !cell.holiday_tooltip_set) {
                continue;
            }

            cell.holiday_name = "";
            if (cell.holidayTooltip) {
                setTooltipText(cell, cell.holidayTooltip, "");
            }
            cell.holiday_tooltip_set = false;
            this.host.nameCell(cell);
        }
    }

    _annotateCell(cell, name, flags) {
        if (!cell.holidayTooltip) {
            cell.holidayTooltip = new Tooltips.Tooltip(cell.button);
        }
        setTooltipText(cell, cell.holidayTooltip, name);
        cell.holiday_tooltip_set = true;

        // the tooltip is the only place the holiday's name appears, and a
        // keyboard never opens one
        cell.holiday_name = name;
        this.annotated = true;
        this.host.nameCell(cell);

        const partDay = flags && flags.indexOf(PART_DAY_HOLIDAY) >= 0;
        if (this.host.weekendLength === 1 && partDay) return;

        cell.button.remove_style_class_name("calendar-work-day");
        cell.button.add_style_class_name("calendar-nonwork-day");
        // ...which is the class a Saturday already carries, so on its own it
        // made a public holiday pixel-identical to a weekend: the feature the
        // user turned holidays on for was invisible unless they hovered every
        // bold cell in the month. This is the mark that says "holiday".
        cell.button.add_style_class_name("calendar-holiday-day");
        cell.holiday_styled = true;
    }
}

class Calendar {
    constructor(settings, events_manager, holiday_provider, desktop_settings) {
        this.events_manager = events_manager;
        this._weekStart = Cinnamon.util_get_week_start();
        this._digitWidth = NaN;
        this.settings = settings;
        this.holiday = holiday_provider;
        this._monthWindows = new CalendarMonthWindowCache();
        // the collaborators see the calendar through one written-down seam, not
        // through its private fields
        this._gridHost = new CalendarGridHost(this);
        this._eventDotRenderer = new CalendarEventDotRenderer(this._gridHost);
        this._dayCellRenderer = new CalendarDayCellRenderer(this._gridHost);
        this._holidayAnnotator = new CalendarHolidayAnnotator(this._gridHost);
        this._holiday_update_generation = 0;

        this._update_id = 0;
        this._set_date_idle_id = 0;
        this._queued_set_date = null;
        // fractions of a scroll notch a touchpad has sent so far; see _onSmoothScroll
        this._scroll_accumulator = 0;

        // day cells live at fixed grid slots; they are built once and
        // mutated on every update (rebuilt only when the header rebuilds)
        this._day_cells = [];
        this._week_labels = [];
        this._day_headings = [];

        this.settings.bindShowWeekNumbers(this, "show_week_numbers", this._onSettingsChange);
        this.settings.bindWeekendLength(this, "weekend_length", this._onSettingsChange);
        // The applet already owns a Gio.Settings for this schema and already
        // listens to it; a second object for the same schema meant two owners
        // of the same thing, so it is handed in. There is no fallback
        // construction any more: the one caller always passes one, and the
        // fallback existed only for tests that did not.
        this.desktop_settings = desktop_settings;
        this._desktop_settings_signal_id =
            this.desktop_settings.connectFirstDayOfWeekChanged(this._onSettingsChange.bind(this));

        // The weekday abbreviations and the weekend days come from the locale
        // query, which answers after the first paint — and they are both LC_TIME.
        // This used to be told whenever *any* env answered, so LC_ADDRESS landing
        // — which is asked for only to pick the holiday provider's language, and
        // which nothing in this header depends on — rebuilt the header, dropped
        // all 42 day cells and every tooltip on them, and made the next update
        // reconstruct the lot.
        this._locale_listener = Utils.onLocaleInfoChanged("LC_TIME", () => {
            this._buildHeader();
            this._queue_update();
        });

        this.events_enabled = true;
        this._events_manager_signal_ids = [
            this.events_manager.connect("events-updated", this._events_updated.bind(this)),
            this.events_manager.connect("events-manager-ready", this._update_events_enabled.bind(this)),
            this.events_manager.connect("has-calendars-changed", this._update_events_enabled.bind(this))
        ];

        // Find the ordering for month/year in the calendar heading

        switch (Gettext_gtk30.gettext('calendar:MY')) {
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

        // Start off with the current date
        this._selectedDate = new Date();

        this.actor = new St.Table({ homogeneous: false,
                                    style_class: 'calendar',
                                    reactive: true });

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

        this._update_id = Mainloop.idle_add(this._idle_do_update.bind(this));
    }

    _idle_do_update() {
        this._update_id = 0;
        this._update();

        return GLib.SOURCE_REMOVE;
    }

    _cancel_set_date_idle() {
        if (this._set_date_idle_id > 0) {
            Mainloop.source_remove(this._set_date_idle_id);
            this._set_date_idle_id = 0;
        }
        this._queued_set_date = null;
    }

    _queue_set_date_idle() {
        const date = this._queued_set_date;
        this._queued_set_date = null;
        this._set_date_idle_id = 0;

        this.setDate(date, false);

        // PageUp/PageDown moved the month; the focus goes with it, onto the day
        // that is now selected
        if (this._focus_after_set_date) {
            this._focus_after_set_date = false;
            this.focusSelectedDay();
        }

        return GLib.SOURCE_REMOVE;
     }

    queue_set_date(date) {
        this._queued_set_date = date;

        if (this._set_date_idle_id > 0) {
            return;
        }

        this._set_date_idle_id = Mainloop.timeout_add(25, this._queue_set_date_idle.bind(this));
    }

    destroy() {
        this._holiday_update_generation++;
        this._cancel_update();
        this._cancel_set_date_idle();
        if (this._locale_listener) {
            this._locale_listener();
            this._locale_listener = null;
        }
        if (this._desktop_settings_signal_id > 0) {
            this.desktop_settings.disconnect(this._desktop_settings_signal_id);
            this._desktop_settings_signal_id = 0;
        }

        for (let id of this._events_manager_signal_ids) {
            this.events_manager.disconnect(id);
        }
        this._events_manager_signal_ids = [];

        // the actors go with the menu, but these arrays are the grid's own, and
        // the applet that holds the grid outlives its removal from the panel
        this._day_cells = [];
        this._week_labels = [];
        this._day_headings = [];
    }

    _update_events_enabled(em) {
        this.events_enabled = this.events_manager.is_active();
        this._queue_update();
    }

    _headerSignature() {
        return this._weekStart + "|" + this.show_week_numbers;
    }

    _onSettingsChange(object, key) {
        if (key == FIRST_WEEKDAY_KEY) this._weekStart = Cinnamon.util_get_week_start();
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

    // Sets the calendar to show a specific date
    setDate(date, forceReload) {
        if (_sameDay(date, this._selectedDate) && !forceReload) {
            return;
        }

        if (!_sameDay(date, this._selectedDate)) {
            this._selectedDate = date;
            this.emit('selected-date-changed', this._selectedDate);
            this._update();
            return;
        }

        this._update();
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
        // the day-cell actors died with the table children
        this._day_cells = [];
        this._week_labels = [];
        this._day_headings = [];

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
            this._day_headings.push({ label, date: new Date(iter) });
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
        this._dot_metrics = null;
    }

    _setWeekdateHeaderWidth() {
        if (!isNaN(this._digitWidth) && this.show_week_numbers && this._weekdateHeader) {
            this._weekdateHeader.set_width (this._digitWidth * WEEKDATE_HEADER_WIDTH_DIGITS);
        }
    }

    // The menu opens on a hotkey, so the grid has to be usable without a
    // mouse: arrows walk days and weeks, PageUp/PageDown walk months, Home
    // returns to today.
    _rtl() {
        return Boolean(this.actor.get_direction &&
            this.actor.get_direction() === St.TextDirection.RTL);
    }

    _onKeyPress (actor, event) {
        const symbol = event.get_key_symbol();
        const days = DAY_KEY_DELTAS[symbol];

        if (days !== undefined) {
            // The handler is on the table, which is the ancestor of the month
            // and year buttons too. Taking the arrows unconditionally meant
            // Left and Right moved the selected date while the user was trying
            // to move between those buttons.
            if (!this._dayCellHasFocus()) {
                return Clutter.EVENT_PROPAGATE;
            }

            // the grid is mirrored in an RTL locale, so the key that points at
            // the previous day is the other one
            const delta = this._rtl() && MIRRORED_KEYS.has(symbol) ? -days : days;
            const target = new Date(this._selectedDate.getTime());
            target.setDate(target.getDate() + delta);
            this.setDate(target, false);
            this.focusSelectedDay();
            return Clutter.EVENT_STOP;
        }

        // the month change is queued on an idle, so the focus has to follow the
        // date rather than chase it: focusing here would land on the day the
        // grid is about to stop showing
        // The handler is on the table, which is the ancestor of the month and year
        // buttons too — so these were taken unconditionally, from wherever the
        // focus happened to be. Pressing PageDown while focused on "Next year"
        // changed the *month* and then yanked the focus off the button the user
        // was operating. Only the arrows asked this question; these three did not.
        if (!this._dayCellHasFocus()) {
            return Clutter.EVENT_PROPAGATE;
        }

        if (symbol === Clutter.KEY_Page_Up) {
            this._focus_after_set_date = true;
            this._onPrevMonthButtonClicked();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Page_Down) {
            this._focus_after_set_date = true;
            this._onNextMonthButtonClicked();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Home) {
            this.setDate(new Date(), false);
            this.focusSelectedDay();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _dayCellHasFocus () {
        const focused = global.stage && global.stage.get_key_focus ?
            global.stage.get_key_focus() : null;

        // nothing has focus yet (the menu was just opened): the grid is the
        // thing the arrows are for, so take them
        if (!focused) {
            return true;
        }

        return this._day_cells.some((cell) => cell.button === focused);
    }

    // Called when the menu opens. Cinnamon's menu manager focuses the menu's
    // own actor on open (popupMenu.js, PopupMenuManager._onMenuOpenState), and
    // the grid sits *below* that actor: a key event delivered to the focused
    // menu never travels through the table, so the handler on it — and every
    // key this class implements — was unreachable until focus moved into the
    // grid. Nothing moved it there but a mouse click on a cell.
    focusSelectedDay () {
        for (const cell of this._day_cells) {
            if (cell.date && _sameDay(cell.date, this._selectedDate) && cell.button.grab_key_focus) {
                // the selected cell is the grid's one tab stop, so it has to be
                // able to take the focus we are about to hand it
                cell.button.can_focus = true;
                cell.button.grab_key_focus();
                return true;
            }
        }

        return false;
    }

    _onScroll (actor, event) {
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            this._onPrevMonthButtonClicked();
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            this._onNextMonthButtonClicked();
            break;
        case Clutter.ScrollDirection.SMOOTH:
            this._onSmoothScroll(event);
            break;
        }
    }

    // A touchpad does not send UP or DOWN. It sends SMOOTH, with a fractional
    // delta per frame — and the switch above had no case for it, so scrolling the
    // month grid on a laptop did nothing at all. (The suite could not have caught
    // it: its ScrollDirection double left SMOOTH out entirely.)
    //
    // The deltas are fractions of a notch, so they accumulate: a flick is one
    // month, not twelve. Whatever is left over stays for the next frame, and the
    // remainder is dropped when the direction reverses so a scroll back does not
    // start out owing a month to the scroll that came before it.
    _onSmoothScroll(event) {
        const [dx, dy] = event.get_scroll_delta();
        const delta = Math.abs(dy) > Math.abs(dx) ? dy : dx;
        if (!Number.isFinite(delta) || delta === 0) {
            return;
        }

        if (Math.sign(delta) !== Math.sign(this._scroll_accumulator)) {
            this._scroll_accumulator = 0;
        }

        this._scroll_accumulator += delta;

        while (this._scroll_accumulator <= -SMOOTH_SCROLL_NOTCH) {
            this._scroll_accumulator += SMOOTH_SCROLL_NOTCH;
            this._onPrevMonthButtonClicked();
        }

        while (this._scroll_accumulator >= SMOOTH_SCROLL_NOTCH) {
            this._scroll_accumulator -= SMOOTH_SCROLL_NOTCH;
            this._onNextMonthButtonClicked();
        }
    }

    _applyDateBrowseAction(yearChange, monthChange) {
        // Browse actions inside the coalescing window have to accumulate, not
        // replace each other. queue_set_date holds the new date for 25 ms so a
        // burst of scroll notches costs one grid rebuild — but this read the
        // *committed* date, which the queued setDate has not written yet, so the
        // second and third notch each recomputed from the same starting month and
        // overwrote the first. Three notches in 30 ms moved the calendar one
        // month; so did a held PageDown.
        let oldDate = this._queued_set_date || this._selectedDate;
        let newMonth = oldDate.getMonth() + monthChange;

        if (newMonth> 11) {
            yearChange = yearChange + 1;
            newMonth = 0;
        } else if (newMonth < 0) {
            yearChange = yearChange - 1;
            newMonth = 11;
        }
        let newYear = oldDate.getFullYear() + yearChange;

        let newDayOfMonth = oldDate.getDate();
        let daysInMonth = 32 - new Date(newYear, newMonth, 32).getDate();
        if (newDayOfMonth > daysInMonth) {
            newDayOfMonth = daysInMonth;
        }

        let newDate = new Date();
        newDate.setFullYear(newYear, newMonth, newDayOfMonth);
        this.queue_set_date(newDate);
    }

    _onPrevYearButtonClicked() {
        this._applyDateBrowseAction(-1, 0);
    }

    _onNextYearButtonClicked() {
        this._applyDateBrowseAction(+1, 0);
    }

    _onPrevMonthButtonClicked() {
        this._applyDateBrowseAction(0, -1);
    }

    _onNextMonthButtonClicked() {
        this._applyDateBrowseAction(0, +1);
    }

    _update() {
        this._holidayAnnotator.beginUpdate();
        // the month name beside it is memoised; the year was not, and it changes
        // once a year while _update() runs on every menu open, settings change and
        // event delivery — each one a fresh GLib.DateTime plus a strftime
        const year = String(this._selectedDate.getFullYear());
        if (this._rendered_year !== year) {
            this._rendered_year = year;
            this._yearLabel.text = _formatJsDate(this._selectedDate, '%Y');
        }

        this._ensureGrid();
        this._updateDayHeadings();

        const holiday_generation = ++this._holiday_update_generation;
        // The annotator is the only consumer of this map, and it answers early
        // when there is no country: building 42 template-string keys for it on
        // every update, with holidays switched off, is pure waste. It is still
        // needed for the pass that *removes* the marks a country left behind.
        const annotating = Boolean(this.holiday && this.holiday.country) ||
            this._holidayAnnotator.annotated;
        const cells = new Map();
        const monthWindow = this._monthWindows.get(this._selectedDate, this._weekStart);
        const today = new Date();

        for (let i = 0; i < this._day_cells.length; i++) {
            const row = 2 + Math.trunc(i / 7);
            const cell = this._day_cells[i];
            const iter = monthWindow.days[i];

            const dateUnixKey = monthWindow.dateUnixKeys[i];

            this._dayCellRenderer.update(cell, iter, row, today, dateUnixKey,
                monthWindow.accessibleDates[i]);

            if (annotating) {
                cells.set(`${iter.getMonth() + 1}/${iter.getDate()}`, cell);
            }
        }

        this._updateWeekNumbers(monthWindow);
        this._holidayAnnotator.annotate(monthWindow.months, cells, holiday_generation);
    }

    // the gutter is six rows, not forty-two cells: lifted out of the day-cell
    // loop, where it sat three levels deep and drove the method's complexity
    _updateWeekNumbers(monthWindow) {
        if (!this.show_week_numbers) {
            return;
        }

        for (let rowIndex = 0; rowIndex < this._week_labels.length; rowIndex++) {
            const week = monthWindow.weekLabelForRow(rowIndex);
            const label = this._week_labels[rowIndex];
            if (label.text === week) {
                continue;
            }

            label.text = week;
            // the gutter cell is a bare number ("28"), and the one place that
            // says what it counts is the column header — a different actor, which
            // a screen reader reading this cell never visits
            const name = _("Week %s").format(week);
            if (label.set_accessible_name) {
                label.set_accessible_name(name);
            }
            label.accessible_name = name;
        }
    }

    _dayHeadingStyleClass(iter) {
        let styleClass = 'calendar-day-base calendar-day-heading';
        if (_isWorkDay(iter, this.weekend_length))
            styleClass += ' calendar-work-day';
        else
            styleClass += ' calendar-nonwork-day';
        return styleClass;
    }

    // the weekend length restyles the headings; the grid geometry did not
    // change, so this must not rebuild the header
    _updateDayHeadings() {
        for (const heading of this._day_headings) {
            const styleClass = this._dayHeadingStyleClass(heading.date);
            if (heading.label.style_class !== styleClass) {
                heading.label.style_class = styleClass;
            }
        }
    }

    // Builds the 42 day cells (and the week-number gutter) once; the grid
    // always spans 6 rows, even if the month fits in 4, to prevent issues
    // with jumping controls, see #226. Slots are fixed: only the dates
    // shown in them change, so _update mutates cells instead of
    // destroying and recreating ~42 actors on every pass.
    _ensureGrid() {
        if (this._day_cells.length > 0) {
            return;
        }

        const offsetCols = this.show_week_numbers ? 1 : 0;

        for (let i = 0; i < 42; i++) {
            const row = 2 + Math.trunc(i / 7);
            const col = i % 7;

            if (this.show_week_numbers && col === 0) {
                const label = new St.Label(
                    { style_class: 'calendar-day-base calendar-week-number' });
                this.actor.add(label, { row: row, col: 0, y_align: St.Align.MIDDLE });
                this._week_labels.push(label);
            }

            const cell = this._dayCellRenderer.build();
            this.actor.add(cell.group, { row: row, col: offsetCols + col });
            this._day_cells.push(cell);
        }
    }

    // This runs inside Clutter's allocation cycle, once per event-bearing day
    // cell — up to 42 of them. The dot's natural size and the theme's max-rows
    // do not depend on the box being allocated: they change on style-changed,
    // which is where they are read now.
    _dotMetrics (actor, a_dot) {
        if (this._dot_metrics) {
            return this._dot_metrics;
        }

        const [, nw] = a_dot.get_preferred_width(-1);
        const [, nh] = a_dot.get_preferred_height(-1);
        const [found, rows] = actor.get_theme_node().lookup_double("max-rows", false);

        this._dot_metrics = {
            nw,
            nh,
            max_rows: found ? Math.trunc(rows) : 2
        };

        return this._dot_metrics;
    }

    _allocate_dot_box (actor, box, flags) {
        let children = actor.get_children();

        if (children.length == 0) {
            return;
        }

        let a_dot = children[0];

        let box_width = box.x2 - box.x1;
        const { nw, nh, max_rows } = this._dotMetrics(actor, a_dot);

        let max_children_per_row = Math.trunc(box_width / nw);

        let n_rows = Math.min(max_rows, Math.ceil(children.length / max_children_per_row));

        let dots_left = children.length;
        let i = 0;
        for (let dot_row = 0; dot_row < n_rows; dot_row++, dots_left -= max_children_per_row) {
            let dots_this_row = Math.min(dots_left, max_children_per_row);
            let total_child_width = nw * dots_this_row;

            let start_x = Math.floor((box_width - total_child_width) / 2);

            let cbox = new Clutter.ActorBox();
            cbox.x1 = start_x;
            cbox.y1 = dot_row * nh;
            cbox.x2 = cbox.x1 + nw;
            cbox.y2 = cbox.y1 + nh;

            while (i < ((dot_row * max_children_per_row) + dots_this_row)) {
                children[i].allocate(cbox, flags);

                cbox.x1 += nw;
                cbox.x2 += nw;

                i++;
            }
        }
    }
}

Signals.addSignalMethods(Calendar.prototype);

if (typeof module !== "undefined") {
    module.exports = {
        Calendar,
        CalendarMonthWindow,
        CalendarMonthWindowCache,
        CalendarGridHost,
        CalendarDayCellRenderer,
        CalendarEventDotRenderer,
        CalendarHolidayAnnotator,
        CalendarMonthLabel,
        HOLIDAY_ERROR_TEXT,
        translateHolidayError,
        _isWorkDay,
        _sameDay,
        _today
    };
}
