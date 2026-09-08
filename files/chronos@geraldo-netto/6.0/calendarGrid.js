// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// The month grid's rendering layer: the port its three collaborators see, the
// day-cell renderer, the event-dot renderer and the grid view that owns the
// table's cells and the Clutter allocation the dots are laid out in.
//
// calendar.js is the coordinator above this — settings, navigation, the header,
// the holiday annotation passes — and it was in one 1140-line file with all of
// it, along with the toolkit-free month arithmetic that is now
// calendarMonthWindow.js.

const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const LocaleQuery = require("./localeQuery");
const LocaleText = require("./localeText");
const StyleUtils = require("./styleUtils");
const UiVocabulary = require("./uiVocabulary");
const DateMath = require("./dateMath");
const CalendarAnnotations = require("./calendarAnnotations");

const _ = LocaleText.translate;
const joinPhrases = LocaleText.joinPhrases;
const releaseHolidayTooltip = CalendarAnnotations.releaseHolidayTooltip;
const ngettext = LocaleText.translatePlural;
const _sameDay = DateMath.sameCivilDate;
const civilWeekday = DateMath.civilWeekday;
function _today(date, today) {
    return _sameDay(date, today);
}
// Geometry remains the primary limit, but a broken or unusually permissive
// theme must not turn one dense day into an arbitrary number of actors.
const MAX_EVENT_DOTS_PER_CELL = 64;
const EVENT_DOT_OVERFLOW_NOTICE = UiVocabulary.EVENTS_HIDDEN_TEXT;

const _lcFirstWorkday = LocaleQuery.lazyLocaleValue(
    "LC_TIME", (info) => (info.first_workday + 6) % 7);

// Weekend days are derived from the locale's first workday and configured length.
function _isWorkDay(weekday, weekend_length) {
    const firstWorkday = _lcFirstWorkday();
    return weekday !== (firstWorkday + 7 - weekend_length) % 7 &&
        weekday !== (firstWorkday + 6) % 7;
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

    // The dot colours for one day, and not the whole EventsManager. Handing the
    // collaborator out defeated the port: a test for the dot renderer needed a
    // full-shaped manager double, and the field was captured as a *value* at
    // construction, so it went stale the moment the Calendar reassigned it.
    colorsForUnixKey(dateUnixKey) {
        return this.port.colorsForUnixKey(dateUnixKey);
    }

    // ...and the same for the holiday provider: whether it has anything to
    // annotate, and one month's holidays. Nothing downstream needs the object.
    holidaysActive() {
        return this.port.holidaysActive();
    }

    requestHolidays(year, month, callback) {
        this.port.requestHolidays(year, month, callback);
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
        cell.dateUnixKey = dateUnixKey;
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
        cell.date = { ...iter };
        cell.is_today = _today(iter, today);

        const label = String(iter.day);
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
            if (!cell.date || cell.dateUnixKey === null) {
                return;
            }
            this.host.selectDate({ ...cell.date });
        });

        return cell;
    }

    _dayStyleClass(iter, row, today) {
        let styleClass = ['calendar-day-base', 'calendar-day'];
        if (_isWorkDay(civilWeekday(iter), this.host.weekendLength)) {
            styleClass.push('calendar-work-day');
        } else {
            styleClass.push("calendar-nonwork-day");
        }

        // Hack used in lieu of border-collapse - see cinnamon.css
        if (row === 2) {
            styleClass.push('calendar-day-top');
        }
        if (civilWeekday(iter) === this.host.weekStart) {
            styleClass.push('calendar-day-left');
        }

        if (_today(iter, today)) {
            styleClass.push('calendar-today');
        } else if (iter.month !== this.host.selectedDate.month) {
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
        const color_set = this.host.eventDataAvailable && dateUnixKey !== null ?
            this.host.colorsForUnixKey(dateUnixKey) : null;
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

    addDayHeading(label, weekday) {
        this.dayHeadings.push({ label, weekday });
    }

    invalidateStyle() {
        this.dotMetrics = null;
    }

    render(monthWindow, annotating, today = DateMath.localDateParts(new Date())) {
        this.ensureGrid();
        this.updateDayHeadings();
        const cells = new Map();

        for (let i = 0; i < this.dayCells.length; i++) {
            const iter = monthWindow.days[i];
            const cell = this.dayCells[i];
            this.dayCellRenderer.update(cell, iter, 2 + Math.trunc(i / 7), today,
                monthWindow.dateUnixKeys[i], monthWindow.accessibleDates[i]);
            if (annotating) {
                cells.set(`${iter.month}/${iter.day}`, cell);
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

    dayHeadingStyleClass(weekday) {
        let styleClass = 'calendar-day-base calendar-day-heading';
        if (_isWorkDay(weekday, this.port.weekendLength())) {
            styleClass += ' calendar-work-day';
        } else {
            styleClass += ' calendar-nonwork-day';
        }
        return styleClass;
    }

    updateDayHeadings() {
        for (const heading of this.dayHeadings) {
            const styleClass = this.dayHeadingStyleClass(heading.weekday);
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

if (typeof module !== "undefined") {
    module.exports = {
        CalendarGridHost,
        CalendarGridView,
        CalendarDayCellRenderer,
        CalendarEventDotRenderer,
        MAX_EVENT_DOTS_PER_CELL,
        _isWorkDay
    };
}
