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

const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const St = imports.gi.St;
const PopupMenu = imports.ui.popupMenu;
const Tooltips = imports.ui.tooltips;
const AppletModules = imports.ui.appletManager.applets["chronos@geraldo-netto"];
const LocaleText = AppletModules.localeText;
const Calendar = require("./calendar");
const EventView = require("./eventView");
const AgendaColumn = require("./agendaColumn");
const UiVocabulary = require("./uiVocabulary");
const Worldclocks = require("./worldclocks");
const AstronomyView = require("./astronomyView");

const _ = LocaleText.translate;
const HOME_KEY_SYMBOLS = UiVocabulary.ACTIVATION_KEY_SYMBOLS;
const ISSUE_MARKER = AppletModules.textUtils.WARNING_MARKER;

// One footer owns every current user-facing problem. Sources update their own
// key, so a recovered weather request cannot erase a simultaneous calendar
// failure, and repeated ticks cannot duplicate the same sentence.
class AppletIssueReporter {
    constructor(label) {
        this.label = label;
        this._issues = new Map();
        this._rendered = null;
        this._render();
    }

    set(source, message) {
        const key = String(source || "").trim();
        if (!key) {
            return;
        }

        const text = typeof message === "string" ? message.trim() : "";
        if (text) {
            if (this._issues.get(key) === text) {
                return;
            }
            this._issues.set(key, text);
        } else if (!this._issues.delete(key)) {
            return;
        }
        this._render();
    }

    _messages() {
        const seen = new Set();
        const messages = [];
        for (const issue of this._issues.values()) {
            for (const line of issue.split(/\n+/)) {
                const message = line.trim();
                if (message && !seen.has(message)) {
                    seen.add(message);
                    messages.push(message);
                }
            }
        }
        return messages;
    }

    // Teardown steps that run after the menu is destroyed — provider aborts,
    // settings finalize — can still report issues, and this label's actor dies
    // with the menu. A detached reporter swallows them instead of writing into
    // a disposed St.Label.
    detach() {
        this.label = null;
    }

    _render() {
        if (!this.label) {
            return;
        }
        const text = this._messages()
            .map((message) => ISSUE_MARKER + " " + message)
            .join("\n");
        if (text === this._rendered) {
            return;
        }
        this._rendered = text;
        this.label.set_text(text);
        this.label.visible = Boolean(text);
        if (this.label.set_accessible_name) {
            this.label.set_accessible_name(text);
        }
    }
}

// Builds the menu contents and hands them back; the applet is the only
// writer of its own fields. The context carries the collaborators the UI
// needs plus the callbacks it fires.
class AppletMenuBuilder {
    constructor(context) {
        this.context = context;
        this._event_list_signal_ids = [];
        this._calendar_signal_ids = [];
        this._calendar = null;
        this._eventList = null;
        this._agenda = null;
        this._worldclocks = null;
        this._astronomy = null;
        this._menu_items = [];
        this._issueReporter = null;
    }

    build() {
        const context = this.context;
        const issueReporter = this._buildIssueReporter();
        // Recorded here rather than beside the return: everything between this
        // line and it can throw, and the field is what the detach step below
        // works from. Assigning it last defeated that step for exactly the
        // failures it exists to survive.
        this._issueReporter = issueReporter;
        const reportIssue = issueReporter.set.bind(issueReporter);
        let box = new St.BoxLayout(
            {
                style_class: 'calendar-main-box',
                vertical: false
            }
        );

        // The body is one actor, not a stack of PopupBaseMenuItems — a 42-cell
        // grid and a scrolling event list are not things PopupMenuSection models.
        // But hanging it off the menu with addActor() put it outside the menu's
        // item list entirely, so it could not be separated from the settings entry
        // below it the way every other Cinnamon menu separates its groups. A
        // section is the seam: the menu sees one item, the item is the whole body.
        const body = new PopupMenu.PopupMenuSection();
        body.addActor(box);
        context.menu.addMenuItem(body);

        const eventList = this._buildEventList(box, reportIssue);

        let calbox = new St.BoxLayout(
            {
                vertical: true
            }
        );

        const home = this._buildHomeButton(calbox);
        const calendar = this._buildCalendar(calbox, reportIssue);

        box.add_actor(calbox);

        // the heading has no writer until a selection changes, so seed it from
        // the calendar's own selection rather than leaving it blank until one does
        this._agenda.setCalendar(calendar);
        this._agenda.selectDate(calendar.getSelectedDate());

        // recorded as owned for the same reason the reporter above is, and in
        // the same place: _addSettingsMenuItems can throw, and a component this
        // class constructed but never handed back has no other owner
        const worldclocks = new Worldclocks.Worldclocks(calbox);
        this._worldclocks = worldclocks;
        const astronomy = new AstronomyView.AstronomyView(calbox);
        this._astronomy = astronomy;
        this._addSettingsMenuItems(issueReporter.label);

        return {
            eventList,
            calendar,
            agenda: this._agenda,
            worldclocks,
            astronomy,
            issueReporter,
            goHomeButton: home.button,
            dayLabel: home.day,
            dateLabel: home.date
        };
    }

    _buildIssueReporter() {
        const label = new St.Label({
            style_class: "calendar-issue-status",
            visible: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.START
        });
        label.get_clutter_text().line_wrap = true;
        label.get_clutter_text().ellipsize = Pango.EllipsizeMode.NONE;
        return new AppletIssueReporter(label);
    }

    // The column's own signals — the ones about what the menu does when a row
    // is clicked — stay here with the actors. Everything about what the column
    // *shows* belongs to the coordinator, which owns that state for the life of
    // the session; this class hands the menu contents back and is done.
    //
    // These connections used to discard their handler ids, and there was no
    // teardown path from on_applet_removed_from_panel that could have used them.
    _buildEventList(box, reportIssue) {
        const context = this.context;
        const eventList = new EventView.EventList(
            context.desktopSettings, undefined, reportIssue);

        this._agenda = new AgendaColumn.AgendaColumnCoordinator(
            context.eventsManager, eventList);

        this._event_list_signal_ids.push(
            eventList.connect("launched-calendar", () => context.menu.toggle()));
        this._event_list_signal_ids.push( // NOSONAR [S7778] -- accepted compatible form
            eventList.connect("start-pass-events", () => {
                context.menu.passEvents = true;
            }));
        this._event_list_signal_ids.push( // NOSONAR [S7778] -- accepted compatible form
            eventList.connect("stop-pass-events", () => {
                context.menu.passEvents = false;
            }));

        this._eventList = eventList;
        box.add_actor(eventList.actor);

        return eventList;
    }

    // The builder constructs the calendar and the event list, so it destroys
    // them. Handing them back on the return statement made the applet their
    // only owner, and a throw anywhere between constructing them and returning
    // hands back nothing at all: the shared desktop-settings handler, the
    // module-level LC_TIME listener rebuilding a dead grid, three events-manager
    // handlers, the pending update idle, the navigation timeout and the
    // renderer's three GLib sources all survived the session that way.
    // Releasing the field first keeps a second call a no-op.
    _destroyOwned(field) {
        const owned = this[field];
        this[field] = null;
        if (owned) {
            owned.destroy();
        }
    }

    // reachable from on_applet_removed_from_panel, like every other teardown in
    // the applet; each step is isolated so one throw does not strand the rest
    _disconnectAll(target, ids) {
        if (!target) {
            return;
        }
        for (const id of ids) {
            target.disconnect(id);
        }
    }

    destroy() {
        const steps = [
            // the column may be waiting on an idle to draw itself, and it holds
            // the events-manager handlers; the actors both would touch are
            // destroyed further down
            () => this._destroyOwned("_agenda"),
            // first, so an issue reported by any later teardown step — here or
            // in the applet's remaining destroy steps — cannot reach the
            // footer label once its actor's fate is out of this builder's hands
            () => {
                if (this._issueReporter) {
                    this._issueReporter.detach();
                }
            },
            () => {
                this._disconnectAll(this._eventList, this._event_list_signal_ids);
                this._event_list_signal_ids = [];
            },
            () => {
                this._disconnectAll(this._calendar, this._calendar_signal_ids);
                this._calendar_signal_ids = [];
            },
            // every consumer is detached above, so the producers can go
            () => this._destroyOwned("_calendar"),
            () => this._destroyOwned("_eventList"),
            // leaves: no signals and no consumers, so they release whenever the
            // producers above have
            () => this._destroyOwned("_worldclocks"),
            () => this._destroyOwned("_astronomy"),
            () => {
                // the applet's own context menu is Cinnamon's, and it holds these
                // items — and each item's activate closure holds this builder,
                // which holds the applet
                for (const item of this._menu_items) {
                    item.destroy();
                }
                this._menu_items = [];
            }
        ];

        for (const step of steps) {
            try {
                step();
            } catch (e) {
                global.logError(e);
            }
        }
    }

    _buildHomeButton(calbox) {
        const button = new St.BoxLayout(
            {
                style_class: "calendar-today-home-button",
                x_align: Clutter.ActorAlign.CENTER,
                reactive: true,
                can_focus: true,
                vertical: true
            }
        );

        // it is focusable and Enter-activatable, and it was announced as an
        // unnamed container: the two labels inside it say today's date, not
        // what pressing it does
        if (button.set_accessible_name) {
            button.set_accessible_name(_("Go to today"));
        }
        if (Atk.Role) {
            button.accessible_role = Atk.Role.PUSH_BUTTON;
        }

        new Tooltips.Tooltip(button, _("Go to today")); // NOSONAR [S1848] -- constructor registers handlers

        button.connect("enter-event", (actor, event) => {
            actor.add_style_pseudo_class("hover");
        });

        button.connect("leave-event", (actor, event) => {
            actor.remove_style_pseudo_class("hover");
        });

        button.connect("button-press-event", this._onHomeButtonPress.bind(this));
        button.connect("button-release-event", this._onHomeButtonRelease.bind(this));
        button.connect("key-press-event", this._onHomeButtonKeyPress.bind(this));

        calbox.add_actor(button);

        const day = new St.Label(
            {
                style_class: "calendar-today-day-label"
            }
        );
        button.add_actor(day);

        const date = new St.Label(
            {
                style_class: "calendar-today-date-label"
            }
        );
        button.add_actor(date);

        return { button, day, date };
    }

    _onHomeButtonPress(_actor, event) {
        return event.get_button() == Clutter.BUTTON_PRIMARY ?
            Clutter.EVENT_STOP : undefined;
    }

    _onHomeButtonRelease(actor, event) {
        if (event.get_button() != Clutter.BUTTON_PRIMARY) {
            return undefined;
        }
        actor.remove_style_pseudo_class("hover");
        this.context.onGoHome();
        return Clutter.EVENT_STOP;
    }

    _onHomeButtonKeyPress(actor, event) {
        // today is already selected: the button is styled as disabled, and it
        // should act disabled too
        if (!actor.reactive || !HOME_KEY_SYMBOLS.has(event.get_key_symbol())) {
            return Clutter.EVENT_PROPAGATE;
        }
        this.context.onGoHome();
        return Clutter.EVENT_STOP;
    }

    _buildCalendar(calbox, reportIssue) {
        const context = this.context;
        const calendar = new Calendar.Calendar(
            context.calendarSettings, context.eventsManager, context.holidayProvider,
            context.desktopSettings, reportIssue);

        // this id used to be discarded — the one connect in the applet with no
        // owner, in the file whose comment above says why that is not acceptable
        this._calendar_signal_ids.push(
            calendar.connect("selected-date-changed", (unused, date) => {
                this._agenda.selectDate(date);
                context.onSelectedDateChanged();
            }));
        this._calendar_signal_ids.push(
            calendar.connect("holidays-changed", () => this._agenda.render()));

        this._calendar = calendar;
        calbox.add_actor(calendar.actor);
        this._agenda.render();
        return calendar;
    }

    _addSettingsMenuItems(issueLabel) {
        const context = this.context;

        // the body is a section now, so the settings entry can be fenced off from
        // it the way Cinnamon's own menus fence their groups
        context.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        for (let menu of [context.contextMenu, context.menu]) {
            let item = new PopupMenu.PopupMenuItem(_("Date and Time Settings"));
            item.connect("activate", () => context.onLaunchSettings());
            if (menu === context.menu) {
                item.addActor(issueLabel, {
                    expand: true,
                    span: -1,
                    align: St.Align.END
                });
            }
            menu.addMenuItem(item);
            // Cinnamon's AppletContextMenu is not the applet's to destroy, and it
            // holds every item ever added to it — including this one, whose
            // activate closure captures this builder, which captures the applet.
            // Removing the applet from the panel does not remove the item.
            this._menu_items.push(item);
        }
    }
}

if (typeof module !== "undefined") {
    module.exports = { AppletIssueReporter, AppletMenuBuilder };
}
