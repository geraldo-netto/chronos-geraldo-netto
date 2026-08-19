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

// One event in the agenda: its actors, and the presenter that writes them.
//
// eventView.js keeps the list — the column, its state machine and its
// accessibility — and this is the row it repeats. They were one 1134-line file.

const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;
const St = imports.gi.St;
const Signals = imports.signals;
const DateFormats = require("./dateFormats");
const LocaleText = require("./localeText");
const StyleUtils = require("./styleUtils");
const UiVocabulary = require("./uiVocabulary");
const EventFormat = require("./eventFormat");
const EventDataModule = require("./eventData");
const SelectedDayAgendaModule = require("./selectedDayAgenda");
const CalendarLauncherModule = require("./calendarLauncher");

const _ = LocaleText.translate;
const joinPhrases = LocaleText.joinPhrases;
const ACTIVATION_KEY_SYMBOLS = UiVocabulary.ACTIVATION_KEY_SYMBOLS;
const DAY_FORMAT = DateFormats.DAY_FORMAT;
const date_only = EventDataModule.date_only;
const eventUidCanLaunch = CalendarLauncherModule.eventUidCanLaunch;
const holidayAgendaType = SelectedDayAgendaModule.holidayAgendaType;
const format_timespan = SelectedDayAgendaModule.format_timespan;

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
            if (ACTIVATION_KEY_SYMBOLS.has(symbol)) {
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

    // `selectedDay` is the whole column's, not this row's: every row in the
    // list shows the same selected day, and deriving it here meant one
    // GLib.DateTime per row per tick for a value the caller already has.
    update(now, today, selectedDay) {
        if (this.row.event.is_holiday) {
            this.row.is_current_or_next = false;
            this._setTimeStyleClass("calendar-event-time-present");
            this._setTimePseudoClass("all-day");
            this._setTimeText(holidayAgendaType(this.row.event.flags));
            this._setCountdown("");
            this._announce();
            return;
        }
        const state = EventFormat.classifyEventDisplayState(this.row.event, now, today);
        this.row.is_current_or_next = state.is_current_or_next;

        this._applyState(state);
        this._setTimeText(EventFormat.formatEventTimeRange(
            this.row.event, selectedDay, today,
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
    // The row is a policy decision (can this event be opened at all?), an actor
    // tree of two nested boxes and three labels, and the first render. It was
    // one 124-line constructor; the sibling EventList decomposes its own tree
    // into _build* methods, and this follows it.
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

        this._buildRowActor(canActivate);
        this.actor.add(this._buildColorStrip());
        this.actor.add_actor(this._buildContent());

        this.update_variations();
    }

    _buildRowActor(canActivate) {
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
    }

    // The strip is the only sign of which calendar an event belongs to, and it
    // is a colour and nothing else — no text, no tooltip, no name. That is
    // information a colour-blind user does not get and a screen reader cannot
    // say.
    //
    // The applet cannot fix that half: cinnamon-calendar-server sends the
    // calendar's *colour* and never its display name (see the Event tuple in
    // /usr/libexec/cinnamon/cinnamon-calendar-server.py — uid, color, summary,
    // all_day, start, end, mod), so there is no name here to announce. What it
    // can do is stop the strip being read out as an unnamed object beside the
    // row that already says the time, the summary and the countdown.
    _buildColorStrip() {
        const color_strip = new St.Bin(
            {
                style_class: "calendar-event-color-strip",
                style: this._presenter.colorStyle()
            }
        );
        if (Atk.Role) {
            // decorative: the row's own accessible name carries the content
            color_strip.accessible_role = Atk.Role.SEPARATOR;
        }
        return color_strip;
    }

    // the time and the countdown share a line; the summary wraps under them
    _buildContent() {
        const vbox = new St.BoxLayout(
            {
                style_class: "calendar-event-row-content",
                x_expand: true,
                vertical: true
            }
        );

        vbox.add_actor(this._buildLabelBox());
        vbox.add(this._buildSummary(), { expand: true });
        return vbox;
    }

    _buildLabelBox() {
        const label_box = new St.BoxLayout(
            {
                name: "label-box",
                x_expand: true
            }
        );

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

        return label_box;
    }

    _buildSummary() {
        const event_summary = new St.Label(
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
        return event_summary;
    }

    // the presenter reads it; the row stays the only writer of its own fields,
    // same seam shape as EventList's calendarLauncher
    get calendarLauncher() {
        return this._calendar_launcher;
    }

    update_variations(now = GLib.DateTime.new_now_local(), today = date_only(now),
        selectedDay = date_only(this.selected_date)) {
        this._presenter.update(now, today, selectedDay);
    }
}
Signals.addSignalMethods(EventRow.prototype);

if (typeof module !== "undefined") {
    module.exports = { EventRow, EventRowPresenter };
}
