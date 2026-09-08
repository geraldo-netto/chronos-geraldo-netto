// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Signals = imports.signals;
const Pango = imports.gi.Pango;
const Atk = imports.gi.Atk;
const Gtk = imports.gi.Gtk;
const Separator = imports.ui.separator;
const Tooltips = imports.ui.tooltips;
const Mainloop = imports.mainloop;
const DateFormats = require("./dateFormats");
const DateMath = require("./dateMath");
const CalendarDate = require("./calendarDate");
const LocaleText = require("./localeText");
const UiVocabulary = require("./uiVocabulary");
const ACTIVATION_KEY_SYMBOLS = UiVocabulary.ACTIVATION_KEY_SYMBOLS;
const EventFormat = require("./eventFormat");
const SelectedDayAgendaModule = require("./selectedDayAgenda");
const EventRowModule = require("./eventRow");
const SelectedDayAgenda = SelectedDayAgendaModule.SelectedDayAgenda;
const composeSelectedDayAgenda = SelectedDayAgendaModule.composeSelectedDayAgenda;
const holidayAgendaType = SelectedDayAgendaModule.holidayAgendaType;
const format_timespan = SelectedDayAgendaModule.format_timespan;
const EventRow = EventRowModule.EventRow;
const EventRowPresenter = EventRowModule.EventRowPresenter;

const _ = LocaleText.translate;
const joinPhrases = LocaleText.joinPhrases;

const DATE_FORMAT_FULL = DateFormats.DATE_FORMAT_FULL;
const DATE_FORMAT_FULL_FALLBACK = DateFormats.DATE_FORMAT_FULL_FALLBACK;

const locale_cap = EventFormat.localeCap;

// event rows built per main-loop turn: enough that a normal day (a handful of
// events) is drawn in one go, small enough that a 200-event feed cannot stall
// the compositor
const EVENT_ROW_CHUNK = 20;
// Retaining the full bounded index keeps navigation and event launching useful,
// but a single selected day must not manufacture thousands of St actors.
const MAX_RENDERED_EVENT_ROWS = 200;
const EVENTS_OVERFLOW_TEXT = UiVocabulary.EVENTS_HIDDEN_TEXT;
const EVENTS_UNAVAILABLE_TEXT =
    _("Calendar events are unavailable — no calendar service is running. Install or enable Evolution Data Server.");
const EVENTS_REFRESH_FAILED_TEXT =
    _("Calendar events could not be refreshed.");
const EventDataModule = require("./eventData");
const date_only = EventDataModule.date_only;
const CalendarLauncherModule = require("./calendarLauncher");
const CalendarLauncher = CalendarLauncherModule.CalendarLauncher;

class EventListRenderer {
    constructor(list) {
        this.list = list;
        // The three GLib sources below are armed here and were stored on the
        // list, which is also the only place that removed them. So the class
        // that owns the timer was not the class that owns its teardown: a new
        // arming site in here that forgot to write its id back into the list
        // leaked a main-loop source into a destroyed menu, and neither class
        // would have noticed. Whatever arms a source removes it.
        this._scroll_to_idle_id = 0;
        this._no_events_timeout_id = 0;
        this._build_rows_idle_id = 0;
        this._rowBuildState = null;
        this._preserveFocus = false;
        this._eventDataList = null;
    }

    // every source this renderer can arm, torn down in one place
    destroy() {
        this._cancelScroll();
        this._cancelNoEventsTimeout();
        this._cancelRowBuild();
        this.list.cancelFocusRestore();
        this._eventDataList = null;
    }

    setEvents(event_data_list, delay_no_events_box, overflowed = false) {
        this._eventDataList = event_data_list;
        this._cancelScroll();
        this.list.setOverflowed(Boolean(overflowed) ||
            Boolean(event_data_list &&
                event_data_list.length > MAX_RENDERED_EVENT_ROWS));

        if (event_data_list != null &&
            event_data_list.timestamp === this.list.currentTimestamp) {
            this.refreshTimeState();
            return;
        }

        this._clearRows();
        this._cancelNoEventsTimeout();

        if (event_data_list == null) {
            this.list.cancelFocusRestore();
            this._showNoEvents(delay_no_events_box);
            return;
        }

        this._buildRows(event_data_list);
    }

    _cancelScroll() {
        if (this._scroll_to_idle_id > 0) {
            Mainloop.source_remove(this._scroll_to_idle_id);
            this._scroll_to_idle_id = 0;
        }
    }

    // The three values below are the column's, not each row's, and this runs
    // for every row on every tick while the menu is open — so they are built
    // once here and handed to every row, whichever refresh asked for them.
    _updateVariations(rows, before) {
        if (rows.length === 0) {
            return;
        }
        const now = GLib.DateTime.new_now_local();
        const today = date_only(now);
        const selectedDay = this.list.selectedDate ? date_only(this.list.selectedDate) : null;
        for (const row of rows) {
            if (before) {
                before(row);
            }
            row.update_variations(now, today, selectedDay);
        }
    }

    refreshTimeState() {
        this._reconcileRowOrder();
        this._updateVariations(this.list.rows, null);
    }

    _reconcileRowOrder() {
        if (!this._eventDataList || this._build_rows_idle_id > 0) {
            return false;
        }
        const events = this._eventDataList.get_event_list().slice(0, MAX_RENDERED_EVENT_ROWS);
        const current = new Map();
        for (const row of this.list.rows) {
            const matches = current.get(row.event.id) || [];
            matches.push(row);
            current.set(row.event.id, matches);
        }
        const ordered = events.map((event) => current.get(event.id)?.shift());
        if (ordered.length !== this.list.rows.length || ordered.some((row) => !row)) {
            this._cancelScroll();
            this._clearRows();
            this._buildRows(this._eventDataList);
            return true;
        }
        this.list.reorderRows(ordered);
        return false;
    }

    // Row work is the renderer's; the list used to reimplement this over its
    // own _rows with a second copy of the three column values.
    refreshTimeFormat(use24h) {
        // Each row used to fall back to update_variations()' defaults, so a
        // format change built its own now, today and selected day per row.
        const stale = this.list.rows.filter((row) => row.use_24h !== use24h);
        this._updateVariations(stale, (row) => {
            row.use_24h = use24h;
        });
    }

    _clearRows() {
        this._cancelRowBuild();
        this._preserveFocus = this.list.parkRowFocus();
        this.list.clearRows();
    }

    _cancelNoEventsTimeout() {
        if (this._no_events_timeout_id > 0) {
            Mainloop.source_remove(this._no_events_timeout_id);
            this._no_events_timeout_id = 0;
        }
    }

    _showNoEvents(delay_no_events_box) {
        // Show the 'no events' label, but wait a little bit to give the calendar server
        // to deliver some events if there are any.
        if (delay_no_events_box) {
            // The column used to sit blank for those 600ms and then jump to
            // "No Events" — an empty state asserted before it was known to be
            // true. On a slow EDS start the user watched nothing become "no
            // events" become a list. showNoEvents keeps the "unavailable" text
            // rule (the box shows either way).
            this.list.showNoEvents(_("Loading…"));

            this._no_events_timeout_id = Mainloop.timeout_add(600, () => {
                this._no_events_timeout_id = 0;
                this.list.showNoEvents(_("No Events"));
                return GLib.SOURCE_REMOVE;
            });
        } else {
            // Not delayed: the answer is known now, so the column must say so.
            // Without this the "Loading…" armed by a previous, delayed pass
            // survives — its 600ms timer was cancelled on the way in here, so
            // nothing was left to overwrite it — and the user is told the
            // applet is fetching something that will never arrive, until they
            // select a different day.
            this.list.showNoEvents(_("No Events"));
        }

        this.list.setCurrentTimestamp(0);
    }

    // One EventRow is ~6 actors plus a separator and a couple of signal
    // connections. Keep the first 200 ordered events and say when the rest were
    // omitted: idles bound per-turn work, while this cap bounds total actors.
    //
    // The first chunk is built straight away, so the column is never empty while
    // something is there to show; the rest follow on idles, a chunk at a time.
    _buildRows(event_data_list) {
        this.list.hideNoEvents();
        this.list.setCurrentTimestamp(event_data_list.timestamp);

        const allEvents = event_data_list.get_event_list();
        const events = allEvents.slice(0, MAX_RENDERED_EVENT_ROWS);
        if (allEvents.length > events.length) {
            this.list.setOverflowed(true);
        }
        this._cancelRowBuild();

        const state = {
            events,
            index: 0,
            scroll_to_row: null,
            preserveFocus: this._preserveFocus,
            timestamp: event_data_list.timestamp
        };

        this._rowBuildState = state;
        this._buildRowChunk(state);
    }

    _cancelRowBuild() {
        this._rowBuildState = null;
        if (this._build_rows_idle_id > 0) {
            Mainloop.source_remove(this._build_rows_idle_id);
            this._build_rows_idle_id = 0;
        }
    }

    _buildRowChunk(state) {
        if (state !== this._rowBuildState) {
            return GLib.SOURCE_REMOVE;
        }
        // the day changed under us while the chunks were still going out
        if (state.timestamp !== this.list.currentTimestamp) {
            this._build_rows_idle_id = 0;
            this._rowBuildState = null;
            this.list.cancelFocusRestore();
            return GLib.SOURCE_REMOVE;
        }

        const end = Math.min(state.index + EVENT_ROW_CHUNK, state.events.length);

        for (; state.index < end; state.index++) {
            this._appendEventRow(state, state.events[state.index]);
        }

        return this._continueRowBuild(state);
    }

    _appendEventRow(state, event_data) {
        if (this.list.rows.length > 0) {
            this.list.addSeparator();
        }
        const row = new EventRow(
            event_data,
            this.list.selectedDate,
            {
                use_24h: this.list.desktopSettings.use24h,
                launcher: this.list.calendarLauncher
            }
        );
        row.connect("view-event", (_emitter, uuid) => {
            if (this.list.calendarLauncher.launchUuid(uuid)) {
                this.list.emitLaunched();
            }
        });
        if (row.is_current_or_next && state.scroll_to_row === null) {
            state.scroll_to_row = row;
        }
        this.list.addRow(row);
    }

    _continueRowBuild(state) {
        if (state.index < state.events.length) {
            this._build_rows_idle_id = Mainloop.idle_add(() => this._buildRowChunk(state));
            return GLib.SOURCE_REMOVE;
        }

        this._build_rows_idle_id = 0;
        if (this._reconcileRowOrder()) {
            return GLib.SOURCE_REMOVE;
        }
        this._rowBuildState = null;
        this.list.restoreRowFocus();
        if (!state.preserveFocus && state.scroll_to_row !== null) {
            this._queueScroll(state.scroll_to_row);
        }

        return GLib.SOURCE_REMOVE;
    }

    _queueScroll(scroll_to_row) {
        this._scroll_to_idle_id = Mainloop.idle_add(((row) => {
            const adjustment = this.list.scrollBox.get_vscroll_bar().get_adjustment();

            if (row != null) {
                const mid_position = row.actor.y + (row.actor.height / 2) - (adjustment.page_size / 2);
                adjustment.set_value(mid_position);
            } else {
                adjustment.set_value(0);
            }

            this._scroll_to_idle_id = 0;
            return GLib.SOURCE_REMOVE;
        }).bind(null, scroll_to_row));
    }
}

class EventList {
    constructor(desktop_settings, launcher = new CalendarLauncher(),
        reportIssue = () => {}) {
        this.selected_date = GLib.DateTime.new_now_local();
        this.selected_civil_date = { year: this.selected_date.get_year(),
            month: this.selected_date.get_month(), day: this.selected_date.get_day_of_month() };
        this.desktop_settings = desktop_settings;
        this._calendar_launcher = launcher;
        this._rows = [];
        this._rowFocus = null;
        this._current_event_data_list_timestamp = 0;
        this._unavailable = false;
        this._overflowed = false;
        this._refreshFailed = false;
        this._reportingEnabled = true;
        this._reportIssue = reportIssue;
        this._eventDataList = null;
        this._delayNoEventsBox = false;
        this._eventsOverflowed = false;
        this._renderer = new EventListRenderer(this);
        this._selected_date_tooltip = null;

        this.actor = new St.BoxLayout(
            {
                style_class: "calendar-events-main-box",
                vertical: true,
                visible: false
            }
        );

        // the label opens the calendar app: without focus, a key handler and a
        // tooltip it is a click target no keyboard user can reach and no user
        // can discover
        const canLaunch = this._canLaunchCalendar();
        this.selected_date_label = this._buildSelectedDateLabel(canLaunch);
        this.selected_date_label.connect("key-focus-out", () => this.cancelFocusRestore());
        this.actor.add_actor(this.selected_date_label);
        this._buildOverflowView();
        this._buildNoEventsView(canLaunch);
        this.set_no_events_text(_("No Events"));
        this._buildEventsView();
    }

    _buildSelectedDateLabel(canLaunch) {
        const label = new St.Label(
            {
                style_class: "calendar-events-date-label",
                reactive: canLaunch,
                can_focus: canLaunch
            }
        );

        if (canLaunch) {
            // The name is set in set_date(), because an explicit ATK name
            // *replaces* the label's own text: naming it only "Open the
            // calendar app" left the selected date - which this heading is the
            // only place to read - unsayable.
            if (label.set_accessible_role && Atk.Role) {
                label.accessible_role = Atk.Role.PUSH_BUTTON;
            }

            this._selected_date_tooltip =
                new Tooltips.Tooltip(label, _("Open the calendar app"));
            label.connect("button-press-event", this._onDateButtonPress.bind(this));
            label.connect("key-press-event", this._onDateKeyPress.bind(this));
        }
        return label;
    }

    _canLaunchCalendar() {
        return Boolean(this.selected_date) && this._calendar_launcher.isAvailable() && !this._unavailable;
    }

    _syncSelectedDateAccessibility(canLaunch) {
        if (this.selected_date_label.set_accessible_role && Atk.Role) {
            this.selected_date_label.accessible_role = canLaunch ?
                Atk.Role.PUSH_BUTTON : Atk.Role.LABEL;
        }
        if (this.selected_date_label.set_accessible_name) {
            const dateText = this.selected_date_label.text || "";
            this.selected_date_label.set_accessible_name(canLaunch ?
                joinPhrases(dateText, _("Open the calendar app")) : dateText);
        }
    }

    _syncCalendarLaunchers() {
        const canLaunch = this._canLaunchCalendar();
        this.selected_date_label.reactive = canLaunch;
        this.selected_date_label.can_focus = canLaunch;
        this._syncSelectedDateAccessibility(canLaunch);

        if (this._selected_date_tooltip) {
            this._selected_date_tooltip.set_text(canLaunch ? _("Open the calendar app") : "");
        }
        this.no_events_button.reactive = canLaunch;
        this.no_events_button.can_focus = canLaunch;
        this.no_events_button.set_style_class_name(
            canLaunch ? "calendar-events-no-events-button" : "");
        this.set_no_events_text(this.no_events_label.text);
    }

    _buildOverflowView() {
        this.events_overflow_label = new St.Label({
            style_class: "calendar-events-overflow-label",
            text: EVENTS_OVERFLOW_TEXT,
            visible: false
        });
        this.events_overflow_label.get_clutter_text().line_wrap = true;
        this.events_overflow_label.get_clutter_text().ellipsize =
            Pango.EllipsizeMode.NONE;
        this.actor.add_actor(this.events_overflow_label);
    }

    _onDateButtonPress(_actor, event) {
        if (event.get_button() != Clutter.BUTTON_PRIMARY) {
            return undefined;
        }
        this.launch_calendar(this.selected_date);
        return Clutter.EVENT_STOP;
    }

    _onDateKeyPress(_actor, event) {
        const symbol = event.get_key_symbol();
        if (!ACTIVATION_KEY_SYMBOLS.has(symbol)) {
            return Clutter.EVENT_PROPAGATE;
        }
        this.launch_calendar(this.selected_date);
        return Clutter.EVENT_STOP;
    }

    _buildNoEventsView(canLaunch) {
        this.no_events_box = new St.BoxLayout(
            {
                style_class: "calendar-events-no-events-box",
                vertical: true,
                visible: false,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: true
            }
        );

        // without a calendar app there is nothing to launch: a themed button
        // that silently does nothing is worse than no button at all
        this.no_events_button = new St.Button(
            {
                // the themed button chrome is what makes it read as clickable
                style_class: canLaunch ? "calendar-events-no-events-button" : "",
                reactive: canLaunch,
                can_focus: canLaunch
            }
        );

        if (canLaunch) {
            this.no_events_button.connect('clicked', () => {
                this.launch_calendar(this.selected_date);
            });
        }

        let button_inner_box = new St.BoxLayout(
            {
                vertical: true
            }
        );

        let no_events_icon = new St.Icon(
            {
                style_class: "calendar-events-no-events-icon",
                icon_name: 'x-office-calendar',
                icon_type: St.IconType.SYMBOLIC
            }
        );

        this.no_events_label = new St.Label(
            {
                style_class: "calendar-events-no-events-label",
                y_align: Clutter.ActorAlign.CENTER
            }
        );
        // St.Label ellipsizes at the end by default, and this label carries a
        // whole remediation sentence when no calendar service is running: the
        // part that says what to do about it was the part that got cut. The
        // event_summary label two classes down already wraps for the same
        // reason; the width cap that gives the wrap something to wrap against
        // is in the stylesheet.
        this.no_events_label.get_clutter_text().line_wrap = true;
        this.no_events_label.get_clutter_text().ellipsize = Pango.EllipsizeMode.NONE;

        button_inner_box.add_actor(no_events_icon);
        button_inner_box.add_actor(this.no_events_label);
        this.no_events_button.add_actor(button_inner_box);
        this.no_events_box.add_actor(this.no_events_button);
        this.actor.add_actor(this.no_events_box);
    }

    _buildEventsView() {
        this.events_box = new St.BoxLayout(
            {
                style_class: 'calendar-events-event-container',
                vertical: true,
                accessible_role: Atk.Role.LIST
            }
        );
        // a list that declares itself a list and has no name is announced as
        // "list", with nothing to say what it is a list of
        if (this.events_box.set_accessible_name) {
            this.events_box.set_accessible_name(_("Events for the selected day"));
        }
        this.events_scroll_box = new St.ScrollView(
            {
                style_class: 'calendar-events-scrollbox vfade',
                hscrollbar_policy: Gtk.PolicyType.NEVER,
                vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
                enable_auto_scrolling: true
            }
        );

        let vscroll = this.events_scroll_box.get_vscroll_bar();
        vscroll.connect('scroll-start', () => {
            this.emit("start-pass-events");
        });
        vscroll.connect('scroll-stop', () => {
            this.emit("stop-pass-events");
        });

        this.events_scroll_box.add_actor(this.events_box);
        this.actor.add_actor(this.events_scroll_box);
    }

    launch_calendar(gdate) {
        // the column is showing "no calendar service is running": there is
        // nothing to launch, and the button that would have said so is not a
        // button any more
        if (this._unavailable || !gdate) {
            return;
        }

        if (this._calendar_launcher.launchDate(gdate)) {
            this.emit("launched-calendar");
        }
    }

    // An explicit ATK name *replaces* the button's child text, so naming the
    // button "Add an event" once at construction meant the label under it —
    // "Loading…", "No Events", the unavailable sentence — was never announced
    // at all: a screen reader heard "Add an event" while the column was still
    // loading and while it was empty. The text and the name are one state, so
    // they are written in one place.
    set_no_events_text(text) {
        this.no_events_label.set_text(text);

        if (!this.no_events_button.set_accessible_name) {
            return;
        }

        // with no calendar app the button launches nothing, and while events
        // are unavailable it adds nothing: either way it is only a label
        this.no_events_button.set_accessible_name(
            this._canLaunchCalendar() ? joinPhrases(text, _("Add an event")) : text);
    }

    set_date(date, gdate) {
        const changedDay = !DateMath.sameCivilDate(this.selected_civil_date, date);
        if (!changedDay && this.selected_date?.to_unix() === gdate?.to_unix()) {
            return;
        }
        if (changedDay) {
            // The old rows still belong to the previous civil day until its
            // replacement arrives. Capture that identity before changing it.
            this.parkRowFocus();
        }

        const dateText = locale_cap(CalendarDate.formatCivilDate(
            date, DATE_FORMAT_FULL, DATE_FORMAT_FULL_FALLBACK));
        this.selected_date_label.set_text(dateText);
        this.selected_date = gdate;
        this.selected_civil_date = { ...date };
        // the date first, because that is what this heading is for; what
        // clicking it does comes after, only while that action is live
        this._syncCalendarLaunchers();
    }

    // The renderer used to read and write the list's private fields directly —
    // this.list._rows, this.list._current_event_data_list_timestamp and the rest
    // — so renaming one of them broke nothing at parse time and the renderer just
    // pushed into a fresh undefined. It goes through these named seams now, and
    // the list is the only writer of its own fields. Same shape as CalendarGridHost.
    get rows() {
        return this._rows;
    }

    get currentTimestamp() {
        return this._current_event_data_list_timestamp;
    }

    setCurrentTimestamp(timestamp) {
        this._current_event_data_list_timestamp = timestamp;
    }

    get calendarLauncher() {
        return this._calendar_launcher;
    }

    get eventsBox() {
        return this.events_box;
    }

    get scrollBox() {
        return this.events_scroll_box;
    }

    get selectedDate() {
        return this.selected_date;
    }

    get selectedCivilDate() {
        return this.selected_civil_date;
    }

    get desktopSettings() {
        return this.desktop_settings;
    }

    addSeparator() {
        this.events_box.add_actor(new Separator.Separator().actor);
    }

    addRow(row) {
        this.events_box.add_actor(row.actor);
        this._rows.push(row);
    }

    reorderRows(rows) {
        if (rows.every((row, index) => row === this._rows[index])) {
            return;
        }
        const children = this.events_box.get_children();
        const ordered = rows.flatMap((row, index) => index === 0 ?
            [row.actor] : [children[index * 2 - 1], row.actor]);
        ordered.forEach((actor, index) => this.events_box.set_child_at_index(actor, index));
        this._rows = rows;
    }

    clearRows() {
        this.events_box.get_children().forEach((actor) => actor.destroy());
        this._rows = [];
    }

    // Cinnamon closes a popup as soon as focus escapes it. Park focus on the
    // stable date heading before destroying an agenda row, including when the
    // replacement needs several idle turns. Store values, never old actors.
    parkRowFocus() {
        const focus = global.stage?.get_key_focus();
        if (focus === this.selected_date_label && this._rowFocus) {
            return true;
        }
        this.cancelFocusRestore();
        if (!focus) {
            return false;
        }
        const index = this._rows.findIndex(row =>
            row.actor === focus || row.actor.contains(focus));
        if (index < 0) {
            return false;
        }
        const row = this._rows[index];
        this._rowFocus = {
            id: row.event.id, index,
            occurrence: this._rows.slice(0, index).filter(other => other.event.id === row.event.id).length,
            day: DateMath.civilDateKey(this.selected_civil_date)
        };
        this.selected_date_label.grab_key_focus();
        return true;
    }

    cancelFocusRestore() {
        this._rowFocus = null;
    }

    restoreRowFocus() {
        const saved = this._rowFocus;
        this.cancelFocusRestore();
        if (!saved || global.stage.get_key_focus() !== this.selected_date_label ||
            saved.day !== DateMath.civilDateKey(this.selected_civil_date)) {
            return;
        }
        const matching = this._rows.filter(row => row.event.id === saved.id)[saved.occurrence];
        const target = matching?.actor.can_focus ? matching : this._nearestFocusableRow(saved.index);
        if (target) {
            target.actor.grab_key_focus();
        }
    }

    _nearestFocusableRow(index) {
        return this._rows.slice(index).find(row => row.actor.can_focus) ||
            this._rows.slice(0, index).reverse().find(row => row.actor.can_focus);
    }

    showNoEvents(text) {
        if (!this._unavailable) {
            this.set_no_events_text(text);
        }
        this.no_events_box.show();
    }

    hideNoEvents() {
        this.no_events_box.hide();
    }

    setOverflowed(overflowed) {
        this._overflowed = Boolean(overflowed);
        if (this._overflowed) {
            this.events_overflow_label.show();
        } else {
            this.events_overflow_label.hide();
        }
        this._syncIssues();
    }

    set_refresh_failed(failed) {
        this._refreshFailed = Boolean(failed);
        this._syncIssues();
    }

    set_reporting_enabled(enabled) {
        this._reportingEnabled = Boolean(enabled);
        this._syncIssues();
    }

    _syncIssues() {
        const reporting = this._reportingEnabled;
        this._reportIssue(
            "events-overflow", reporting && this._overflowed ? EVENTS_OVERFLOW_TEXT : "");
        this._reportIssue(
            "events-refresh", reporting && this._refreshFailed ?
                EVENTS_REFRESH_FAILED_TEXT : "");
        this._reportIssue(
            "calendar-service", reporting && this._unavailable ?
                EVENTS_UNAVAILABLE_TEXT : "");
    }

    emitLaunched() {
        this.emit("launched-calendar");
    }

    set_events(event_data_list, delay_no_events_box, overflowed = false) {
        this._eventDataList = event_data_list;
        this._delayNoEventsBox = delay_no_events_box;
        this._eventsOverflowed = overflowed;
        this._renderCurrentEvents();
    }

    _renderCurrentEvents() {
        let agenda = this._eventDataList;
        if (this._unavailable) {
            agenda = agenda?.hasHolidays ? agenda.holidaysOnly() : null;
        }
        this._renderer.setEvents(
            agenda, this._unavailable ? false : this._delayNoEventsBox,
            this._unavailable ? false : this._eventsOverflowed);
        // Gating this on an empty agenda dropped the remediation exactly when
        // the selected day carried a holiday: the column then rendered one
        // holiday row and nothing else, byte-identical to a healthy service on
        // a day whose only entry is that holiday, and contradicting the
        // footer's own calendar-service report. _buildRows hides the box on
        // the way past, so this runs after the renderer, not instead of it.
        if (this._unavailable) {
            this.set_no_events_text(EVENTS_UNAVAILABLE_TEXT);
            this.no_events_box.show();
        }
    }

    refresh_time_format() {
        this._renderer.refreshTimeFormat(Boolean(this.desktop_settings.use24h));
    }

    refresh_time_state() {
        this._renderer.refreshTimeState();
    }

    // events are on but no calendar service answered: hiding the column made
    // the setting look like it did nothing
    set_unavailable(unavailable) {
        if (this._unavailable === unavailable) {
            return;
        }
        this._unavailable = unavailable;
        this._syncCalendarLaunchers();
        this._syncIssues();

        // the unavailable state's own text is written by _syncIssues above;
        // coming back from it restores the ordinary one. The re-render is
        // unconditional either way.
        if (!unavailable) {
            this.set_no_events_text(_("No Events"));
        }

        this._renderCurrentEvents();
    }

    // the renderer arms every source this class can be holding, so it is the
    // renderer that removes them
    destroy() {
        this._renderer.destroy();
        // The applet object remains reachable after panel removal. Release the
        // row actors and their event records before the surrounding menu actor
        // is disposed, then drop the selected day's source model as well.
        this.clearRows();
        this._eventDataList = null;
        this._reportingEnabled = false;
        this._syncIssues();
    }
}
Signals.addSignalMethods(EventList.prototype);

if (typeof module !== "undefined") {
    // the row, the agenda value type and their helpers are re-exported: this
    // module is what the menu builder and the suite reach the feature through
    module.exports = { EventList, EventListRenderer, EventRow,
        EventRowPresenter, SelectedDayAgenda, composeSelectedDayAgenda,
        holidayAgendaType, format_timespan, MAX_RENDERED_EVENT_ROWS,
        EVENTS_OVERFLOW_TEXT,
        EVENTS_UNAVAILABLE_TEXT, EVENTS_REFRESH_FAILED_TEXT };
}
