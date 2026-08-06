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
const AppletModules = imports.ui.appletManager.applets["chronos@geraldo-netto"];
const DateFormats = AppletModules.dateFormats;
const LocaleText = AppletModules.localeText;
const StyleUtils = AppletModules.styleUtils;
const EventFormat = require("./eventFormat");

const _ = LocaleText.translate;
const joinPhrases = LocaleText.joinPhrases;
const ngettext = LocaleText.translatePlural;

const DATE_FORMAT_FULL = DateFormats.DATE_FORMAT_FULL;
const DATE_FORMAT_FULL_FALLBACK = DateFormats.DATE_FORMAT_FULL_FALLBACK;
const DAY_FORMAT = DateFormats.DAY_FORMAT;

const locale_cap = EventFormat.localeCap;

// event rows built per main-loop turn: enough that a normal day (a handful of
// events) is drawn in one go, small enough that a 200-event feed cannot stall
// the compositor
const EVENT_ROW_CHUNK = 20;
// Retaining the full bounded index keeps navigation and event launching useful,
// but a single selected day must not manufacture thousands of St actors.
const MAX_RENDERED_EVENT_ROWS = 200;
const EVENTS_OVERFLOW_TEXT =
    _("Some calendar events were hidden to keep the desktop responsive.");
const EVENTS_UNAVAILABLE_TEXT =
    _("Calendar events are unavailable — no calendar service is running. Install or enable Evolution Data Server.");
const EVENTS_REFRESH_FAILED_TEXT =
    _("Calendar events could not be refreshed.");
const EventDataModule = require("./eventData");
const HolidayConstants = require("./holidayConstants");
const date_only = EventDataModule.date_only;
const dt_equals = EventDataModule.dt_equals;
const CalendarLauncherModule = require("./calendarLauncher");
const CalendarLauncher = CalendarLauncherModule.CalendarLauncher;
const eventUidCanLaunch = CalendarLauncherModule.eventUidCanLaunch;

function holidayAgendaType(flags = []) {
    const publicHoliday = flags.indexOf(HolidayConstants.PUBLIC_HOLIDAY_FLAG) >= 0;
    const religiousHoliday = flags.indexOf(HolidayConstants.RELIGIOUS_HOLIDAY_FLAG) >= 0;
    if (publicHoliday && religiousHoliday) {
        return _("Public holiday and religious observance");
    }
    if (publicHoliday) {
        return _("Public holiday");
    }
    if (religiousHoliday) {
        return _("Religious observance");
    }
    return _("Holiday");
}

class SelectedDayAgenda {
    constructor(eventDataList, holiday) {
        this._eventDataList = eventDataList;
        this._holiday = holiday;
        this.hasHolidays = Boolean(holiday);
        const eventTimestamp = eventDataList ? eventDataList.timestamp : 0;
        this.timestamp = `agenda:${eventTimestamp}:${JSON.stringify(holiday)}`;
        this.length = (eventDataList ? eventDataList.length : 0) +
            (this.hasHolidays ? 1 : 0);
    }

    get_event_list() {
        const events = this._eventDataList ? this._eventDataList.get_event_list() : [];
        if (!this._holiday) {
            return events;
        }
        return [{
            id: null,
            is_holiday: true,
            summary: EventDataModule.clampEventSummary(this._holiday[0]),
            flags: this._holiday[1] || [],
            color: "transparent"
        }].concat(events);
    }

    holidaysOnly() {
        return new SelectedDayAgenda(null, this._holiday);
    }
}

function composeSelectedDayAgenda(eventDataList, holiday) {
    return holiday ? new SelectedDayAgenda(eventDataList, holiday) : eventDataList;
}

function format_timespan(timespan) {
    let minutes = Math.floor(timespan / GLib.TIME_SPAN_MINUTE);

    if (minutes < 10) {
        return ["imminent", _("Starting in a few minutes")];
    }

    if (minutes < 60) {
        // Russian declares three plural forms, and 21, 22 and 25 minutes each
        // take a different one. The line below already uses ngettext for hours;
        // this one just never did.
        return ["soon", ngettext("Starting in %d minute", "Starting in %d minutes", minutes).format(minutes)];
    }

    let hours = Math.floor(minutes / 60);

    if (hours > 6) {
        let now = GLib.DateTime.new_now_local();
        let later = now.add_hours(hours);

        if (later.get_hour() > 18) {
            return ["", _("This evening")];
        }

        return ["", _("Starting later today")];
    }

    return ["", ngettext("In %d hour", "In %d hours", hours).format(hours)];
}

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
    }

    // every source this renderer can arm, torn down in one place
    destroy() {
        this._cancelScroll();
        this._cancelNoEventsTimeout();
        this._cancelRowBuild();
    }

    setEvents(event_data_list, delay_no_events_box, overflowed = false) {
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

    refreshTimeState() {
        const now = GLib.DateTime.new_now_local();
        const today = date_only(now);
        this.list.rows.forEach((row) => {
            row.update_variations(now, today);
        });
    }

    _clearRows() {
        this._cancelRowBuild();
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
            timestamp: event_data_list.timestamp
        };

        this._buildRowChunk(state);
    }

    _cancelRowBuild() {
        if (this._build_rows_idle_id > 0) {
            Mainloop.source_remove(this._build_rows_idle_id);
            this._build_rows_idle_id = 0;
        }
    }

    _buildRowChunk(state) {
        // the day changed under us while the chunks were still going out
        if (state.timestamp !== this.list.currentTimestamp) {
            this._build_rows_idle_id = 0;
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
        if (state.scroll_to_row !== null) {
            this._queueScroll(state.scroll_to_row);
        }

        return GLib.SOURCE_REMOVE;
    }

    _queueScroll(scroll_to_row) {
        this._scroll_to_idle_id = Mainloop.idle_add(((row) => {
            let vscroll = this.list.scrollBox.get_vscroll_bar();

            if (row != null) {
                let mid_position = row.actor.y + (row.actor.height / 2) - (this.list.eventsBox.height / 2);
                vscroll.get_adjustment().set_value(mid_position);
            } else {
                vscroll.get_adjustment().set_value(0);
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
        this.desktop_settings = desktop_settings;
        this._calendar_launcher = launcher;
        this._rows = [];
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
        const canLaunch = this._calendar_launcher.isAvailable();
        this.selected_date_label = this._buildSelectedDateLabel(canLaunch);
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
        return this._calendar_launcher.isAvailable() && !this._unavailable;
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

    _syncSelectedDateLauncher() {
        const canLaunch = this._canLaunchCalendar();
        this.selected_date_label.reactive = canLaunch;
        this.selected_date_label.can_focus = canLaunch;
        this._syncSelectedDateAccessibility(canLaunch);

        if (this._selected_date_tooltip) {
            this._selected_date_tooltip.set_text(canLaunch ? _("Open the calendar app") : "");
        }
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
        if (symbol !== Clutter.KEY_Return && symbol !== Clutter.KEY_KP_Enter &&
            symbol !== Clutter.KEY_space) {
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
        if (this._unavailable) {
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
        const canAdd = this._calendar_launcher.isAvailable() && !this._unavailable;
        this.no_events_button.set_accessible_name(
            canAdd ? joinPhrases(text, _("Add an event")) : text);
    }

    set_date(gdate) {
        if (this.selected_date && dt_equals(this.selected_date, gdate)) {
            return;
        }

        const dateText = locale_cap(DateFormats.formatDateWithFallback(
            (format) => gdate.format(format), DATE_FORMAT_FULL, DATE_FORMAT_FULL_FALLBACK));
        this.selected_date_label.set_text(dateText);
        // the date first, because that is what this heading is for; what
        // clicking it does comes after, only while that action is live
        this._syncSelectedDateLauncher();

        this.selected_date = gdate;
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

    clearRows() {
        this.events_box.get_children().forEach((actor) => actor.destroy());
        this._rows = [];
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
            agenda = agenda && agenda.hasHolidays ? agenda.holidaysOnly() : null;
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
        const use24h = Boolean(this.desktop_settings.use24h);
        for (const row of this._rows) {
            if (row.use_24h === use24h) {
                continue;
            }
            row.use_24h = use24h;
            row.update_variations();
        }
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
        this._syncSelectedDateLauncher();
        this._syncIssues();

        // In the unavailable state the button announced only the error sentence —
        // while staying focusable, hoverable, themed as a button and still wired
        // to launch_calendar(). So it read as "no calendar service is running",
        // and pressing Enter on it opened gnome-calendar. A control's name has to
        // say what activating it does; this one is not a control at all here.
        const canLaunch = this._calendar_launcher.isAvailable() && !unavailable;
        this.no_events_button.reactive = canLaunch;
        this.no_events_button.can_focus = canLaunch;
        this.no_events_button.set_style_class_name(
            canLaunch ? "calendar-events-no-events-button" : "");

        if (!unavailable) {
            this.set_no_events_text(_("No Events"));
            this._renderCurrentEvents();
            return;
        }

        this._renderCurrentEvents();
    }

    // the renderer arms every source this class can be holding, so it is the
    // renderer that removes them
    destroy() {
        this._renderer.destroy();
        this._reportingEnabled = false;
        this._syncIssues();
    }
}
Signals.addSignalMethods(EventList.prototype);

class EventRowPresenter {
    constructor(row) {
        this.row = row;
    }

    colorStyle() {
        return `background-color: ${StyleUtils.safeCssColor(this.row.event.color)};`;
    }

    connectActivation() {
        if (!this.row.calendarLauncher.isAvailable() ||
            !eventUidCanLaunch(this.row.event.id)) {
            return;
        }

        this.row.actor.connect("button-press-event", (actor, event) => {
            if (event.get_button() == Clutter.BUTTON_PRIMARY) {
                this.row.emit("view-event", this.row.event.id);
                return Clutter.EVENT_STOP;
            }
        });

        this.row.actor.connect("key-press-event", (actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter ||
                symbol === Clutter.KEY_space) {
                this.row.emit("view-event", this.row.event.id);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // St compares by pointer, so writing a byte-identical string still queues a
    // relayout — the reason the day cells diff rendered_style and dot_key, the
    // panel diffs _rendered_label, and the tooltips diff rendered_tooltip. The
    // rows were the ones that did not: refresh_time_state() runs them all on
    // every tick while the menu is open, and a row's time range never changes
    // while its day is on screen and its countdown changes once a minute at
    // most, so 200 rows paid four forced relayouts each, a second, for text
    // that was already there.
    //
    // Each writer guards exactly the properties the caller writes today. The
    // pseudo-class on event_time is deliberately not reset on the branches that
    // never set it: "all-day" belongs to an event whose kind cannot change
    // while the row exists, and clearing it here would be a new write, not a
    // saved one.
    _setTimeText(text) {
        if (this.row.rendered_time_text === text) {
            return;
        }
        this.row.rendered_time_text = text;
        this.row.event_time.set_text(text);
    }

    _setTimeStyleClass(styleClass) {
        if (this.row.rendered_time_style === styleClass) {
            return;
        }
        this.row.rendered_time_style = styleClass;
        this.row.event_time.set_style_class_name(styleClass);
    }

    _setTimePseudoClass(pseudoClass) {
        if (this.row.rendered_time_pseudo === pseudoClass) {
            return;
        }
        this.row.rendered_time_pseudo = pseudoClass;
        this.row.event_time.set_style_pseudo_class(pseudoClass);
    }

    update(now = GLib.DateTime.new_now_local(), today = date_only(now)) {
        if (this.row.event.is_holiday) {
            this.row.is_current_or_next = false;
            this._setTimeStyleClass("calendar-event-time-present");
            this._setTimePseudoClass("all-day");
            this._setTimeText(holidayAgendaType(this.row.event.flags));
            this._setCountdown("");
            this._announce();
            return;
        }
        const selectedDateOnly = date_only(this.row.selected_date);
        const state = EventFormat.classifyEventDisplayState(this.row.event, now, today);
        this.row.is_current_or_next = state.is_current_or_next;

        this._applyState(state);
        this._setTimeText(EventFormat.formatEventTimeRange(
            this.row.event, selectedDateOnly, today,
            {
                timeFormat: this.row.use_24h ? "%H:%M" : "%-l:%M %p",
                dayFormat: DAY_FORMAT,
                translate: _
            }
        ));

        this._announce();
    }

    // The row is a focusable box holding three separate labels — time, summary,
    // countdown — with no name of its own, inside a box that calls itself a
    // list. A screen reader read a list with no items in it.
    _announce() {
        const actor = this.row.actor;
        if (!actor.set_accessible_name) {
            return;
        }

        const countdown = this.row.countdown_label.text;
        const name = joinPhrases(this.row.event_time.text, this.row.event.summary, countdown);

        if (this.row.rendered_accessible_name !== name) {
            this.row.rendered_accessible_name = name;
            actor.set_accessible_name(name);
        }
    }

    _applyState(state) {
        if (state.phase === EventFormat.EVENT_PHASE_PAST) {
            this._setTimeStyleClass("calendar-event-time-past");
            // The time colour is theme-dependent and cannot be the only state
            // cue. This word is visible and also becomes part of the row's
            // accessible name through _announce().
            this._setCountdown(_("Ended"), "ended");
        } else if (state.phase === EventFormat.EVENT_PHASE_UPCOMING) {
            this._setTimeStyleClass("calendar-event-time-future");
            this._applyUpcomingState(state);
        } else {
            this._applyPresentState();
        }
    }

    // rows refresh in place while the menu is open, so the countdown
    // pseudo-class must be replaced, never accumulated
    _setCountdown(text, pseudoClass = "") {
        if (this.row.rendered_countdown !== text) {
            this.row.rendered_countdown = text;
            this.row.countdown_label.set_text(text);
        }
        if (this.row.rendered_countdown_pseudo !== pseudoClass) {
            this.row.rendered_countdown_pseudo = pseudoClass;
            this.row.countdown_label.set_style_pseudo_class(pseudoClass);
        }
    }

    _applyUpcomingState(state) {
        if (state.show_countdown) {
            let [countdown_pclass, text] = format_timespan(state.time_until_start);
            this._setCountdown(text, countdown_pclass);
        } else {
            this._setCountdown("");
        }
    }

    _applyPresentState() {
        this._setTimeStyleClass("calendar-event-time-present");
        if (this.row.event.all_day || this.row.event.multi_day) {
            this._setCountdown("");
            this._setTimePseudoClass("all-day");
        } else {
            this._setCountdown(_("In progress"), "current");
        }
    }
}

class EventRow {
    constructor(event, date, params) {
        this.event = event;
        this.is_current_or_next = false;
        this.selected_date = date;
        this.use_24h = params.use_24h;
        // The launcher is the list's, and the list is handed one. A default
        // here silently built a *second* launcher, each with its own memo of
        // find_program_in_path — which is the one thing the class exists to
        // avoid, and the rows are where the PATH scans came from.
        this._calendar_launcher = params.launcher;
        this._presenter = new EventRowPresenter(this);

        // A row opens the event in the calendar app, and connectActivation()
        // wires nothing when there is no calendar app to open. The row still
        // took focus, still lit up on hover and still looked like a button —
        // one that does nothing on Enter, Space or click. The empty-state
        // button and the date heading were both already guarded this way; the
        // rows were the ones that got missed.
        const canActivate = this._calendar_launcher.isAvailable() &&
            eventUidCanLaunch(this.event.id);

        this.actor = new St.BoxLayout(
            {
                style_class: "calendar-event-button",
                reactive: canActivate,
                can_focus: canActivate
            }
        );

        // the box around these rows declares itself a list; without this its
        // children are plain boxes and the list has no items
        if (Atk.Role) {
            this.actor.accessible_role = Atk.Role.LIST_ITEM;
        }

        if (canActivate) {
            this.actor.connect("enter-event", () => {
                this.actor.add_style_pseudo_class("hover");
            });

            this.actor.connect("leave-event", () => {
                this.actor.remove_style_pseudo_class("hover");
            });
        }

        this._presenter.connectActivation();

        // The strip is the only sign of which calendar an event belongs to, and
        // it is a colour and nothing else — no text, no tooltip, no name. That is
        // information a colour-blind user does not get and a screen reader cannot
        // say.
        //
        // The applet cannot fix that half: cinnamon-calendar-server sends the
        // calendar's *colour* and never its display name (see the Event tuple in
        // /usr/libexec/cinnamon/cinnamon-calendar-server.py — uid, color, summary,
        // all_day, start, end, mod), so there is no name here to announce. What it
        // can do is stop the strip being read out as an unnamed object beside the
        // row that already says the time, the summary and the countdown.
        let color_strip = new St.Bin(
            {
                style_class: "calendar-event-color-strip",
                style: this._presenter.colorStyle()
            }
        );
        if (Atk.Role) {
            // decorative: the row's own accessible name carries the content
            color_strip.accessible_role = Atk.Role.SEPARATOR;
        }

        this.actor.add(color_strip);

        let vbox = new St.BoxLayout(
            {
                style_class: "calendar-event-row-content",
                x_expand: true,
                vertical: true
            }
        );
        this.actor.add_actor(vbox);

        let label_box = new St.BoxLayout(
            {
                name: "label-box",
                x_expand: true
            }
        );
        vbox.add_actor(label_box);

        this.event_time = new St.Label(
            {
                x_align: Clutter.ActorAlign.START,
                text: "",
                style_class: "calendar-event-time-present"
            }
        );
        label_box.add(this.event_time, { expand: true, x_fill: true });

        this.countdown_label = new St.Label(
            {
                /// text set below
                x_align: Clutter.ActorAlign.END,
                style_class: "calendar-event-countdown",
            }
        );

        label_box.add(this.countdown_label, { expand: true, x_fill: true });

        let event_summary = new St.Label(
            {
                text: this.event.summary,
                y_expand: true,
                style_class: "calendar-event-summary"
            }
        );

        event_summary.get_clutter_text().line_wrap = true;
        // Pango.EllipsizeMode has no NEVER: the name reads as undefined, which
        // GJS coerces to 0 — the value of NONE — so this line has been getting
        // the behaviour it wanted by accident. Say what it means.
        event_summary.get_clutter_text().ellipsize = Pango.EllipsizeMode.NONE;
        vbox.add(event_summary, { expand: true });

        this.update_variations();
    }

    // the presenter reads it; the row stays the only writer of its own fields,
    // same seam shape as EventList's calendarLauncher
    get calendarLauncher() {
        return this._calendar_launcher;
    }

    update_variations(now = GLib.DateTime.new_now_local(), today = date_only(now)) {
        this._presenter.update(now, today);
    }
}
Signals.addSignalMethods(EventRow.prototype);

if (typeof module !== "undefined") {
    module.exports = { EventList, EventListRenderer, EventRow,
        EventRowPresenter, SelectedDayAgenda, composeSelectedDayAgenda,
        holidayAgendaType, format_timespan, MAX_RENDERED_EVENT_ROWS,
        EVENTS_OVERFLOW_TEXT,
        EVENTS_UNAVAILABLE_TEXT, EVENTS_REFRESH_FAILED_TEXT };
}
