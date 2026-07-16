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
const St = imports.gi.St;
const PopupMenu = imports.ui.popupMenu;
const Tooltips = imports.ui.tooltips;
const AppletModules = imports.ui.appletManager.applets["chronos@geraldo-netto"];
const LocaleText = AppletModules.localeText;
const Calendar = require("./calendar");
const EventView = require("./eventView");
const Worldclocks = require("./worldclocks");

const _ = LocaleText.translate;

// Builds the menu contents and hands them back; the applet is the only
// writer of its own fields. The context carries the collaborators the UI
// needs plus the callbacks it fires.
class AppletMenuBuilder {
    constructor(context) {
        this.context = context;
        this._events_manager_signal_ids = [];
        this._event_list_signal_ids = [];
        this._calendar_signal_ids = [];
        this._calendar = null;
        this._eventList = null;
        this._menu_items = [];
    }

    build() {
        const context = this.context;
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

        const eventList = this._buildEventList(box);

        let calbox = new St.BoxLayout(
            {
                vertical: true
            }
        );

        const home = this._buildHomeButton(calbox);
        const calendar = this._buildCalendar(calbox);

        box.add_actor(calbox);
        this._addSettingsMenuItems();

        const worldclocks = new Worldclocks.Worldclocks(calbox);
        const weatherStatus = new St.Label({
            style_class: "calendar-weather-status",
            visible: false
        });
        calbox.add_actor(weatherStatus);

        return {
            eventList,
            calendar,
            worldclocks,
            weatherStatus,
            goHomeButton: home.button,
            dayLabel: home.day,
            dateLabel: home.date
        };
    }

    // These five connections used to discard their handler ids, and there was no
    // teardown path from on_applet_removed_from_panel that could have used them.
    // Nothing emits after EventsManager.destroy() today, so they do not fire on
    // dead actors — but they were the only set of connects in the applet with no
    // owner, which makes them the ones that break when something upstream starts
    // emitting a little later than it used to.
    _buildEventList(box) {
        const context = this.context;
        const eventList = new EventView.EventList(context.desktopSettings);

        this._events_manager_signal_ids.push(
            context.eventsManager.connect("selected-date-changed", (em, gdate) => {
                eventList.set_date(gdate);
            }));
        this._events_manager_signal_ids.push(
            context.eventsManager.connect("selected-date-events-changed",
                (em, eventDataList, delayNoEventsBox) => {
                    eventList.set_events(eventDataList, delayNoEventsBox);
                }));

        this._event_list_signal_ids.push(
            eventList.connect("launched-calendar", () => context.menu.toggle()));
        this._event_list_signal_ids.push(
            eventList.connect("start-pass-events", () => {
                context.menu.passEvents = true;
            }));
        this._event_list_signal_ids.push(
            eventList.connect("stop-pass-events", () => {
                context.menu.passEvents = false;
            }));

        this._eventList = eventList;
        box.add_actor(eventList.actor);

        return eventList;
    }

    // reachable from on_applet_removed_from_panel, like every other teardown in
    // the applet; each step is isolated so one throw does not strand the rest
    destroy() {
        const steps = [
            () => {
                for (const id of this._events_manager_signal_ids) {
                    this.context.eventsManager.disconnect(id);
                }
                this._events_manager_signal_ids = [];
            },
            () => {
                if (!this._eventList) {
                    return;
                }
                for (const id of this._event_list_signal_ids) {
                    this._eventList.disconnect(id);
                }
                this._event_list_signal_ids = [];
            },
            () => {
                if (!this._calendar) {
                    return;
                }
                for (const id of this._calendar_signal_ids) {
                    this._calendar.disconnect(id);
                }
                this._calendar_signal_ids = [];
            },
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
        const context = this.context;
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

        new Tooltips.Tooltip(button, _("Go to today"));

        button.connect("enter-event", (actor, event) => {
            actor.add_style_pseudo_class("hover");
        });

        button.connect("leave-event", (actor, event) => {
            actor.remove_style_pseudo_class("hover");
        });

        button.connect("button-press-event", (actor, event) => {
            if (event.get_button() == Clutter.BUTTON_PRIMARY) {
                return Clutter.EVENT_STOP;
            }
        });

        button.connect("button-release-event", (actor, event) => {
            if (event.get_button() == Clutter.BUTTON_PRIMARY) {
                actor.remove_style_pseudo_class("hover");
                context.onGoHome();
                return Clutter.EVENT_STOP;
            }
        });

        button.connect("key-press-event", (actor, event) => {
            // today is already selected: the button is styled as disabled, and
            // it should act disabled too
            if (!actor.reactive) {
                return Clutter.EVENT_PROPAGATE;
            }

            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter ||
                symbol === Clutter.KEY_space) {
                context.onGoHome();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

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

    _buildCalendar(calbox) {
        const context = this.context;
        const calendar = new Calendar.Calendar(
            context.calendarSettings, context.eventsManager, context.holidayProvider,
            context.desktopSettings);

        // this id used to be discarded — the one connect in the applet with no
        // owner, in the file whose comment above says why that is not acceptable
        this._calendar_signal_ids.push(
            calendar.connect("selected-date-changed", () => context.onSelectedDateChanged()));

        this._calendar = calendar;
        calbox.add_actor(calendar.actor);
        return calendar;
    }

    _addSettingsMenuItems() {
        const context = this.context;

        // the body is a section now, so the settings entry can be fenced off from
        // it the way Cinnamon's own menus fence their groups
        context.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        for (let menu of [context.contextMenu, context.menu]) {
            let item = new PopupMenu.PopupMenuItem(_("Date and Time Settings"));
            item.connect("activate", () => context.onLaunchSettings());
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
    module.exports = { AppletMenuBuilder };
}
