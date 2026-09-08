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
const Mainloop = imports.mainloop;
const EventView = require("./eventView");
const CivilTime = require("./civilTime");
const DateMath = require("./dateMath");

// The agenda column's runtime state, and the only writer of it.
//
// This lived in AppletMenuBuilder, whose stated job is to build the menu
// contents and hand them back. The builder therefore declared six pieces of
// live state and a main-loop source id, owned three events-manager handlers for
// the life of the session, and had a nine-step destroy() — while the applet
// treated it as a one-shot factory. T819 came straight out of that: the
// build-time seeding call and the runtime signal handler shared one method, so
// a type contract that held on only one of the two paths went unnoticed.
//
// Two producers drive this column. EventWindowCoordinator emits the selected
// day and, in the same synchronous call, that day's events; the calendar emits
// its own selection whether or not any event service is running.
var AgendaColumnCoordinator = class AgendaColumnCoordinator { // NOSONAR [S3504] -- GJS importer export
    constructor(eventsManager, eventList) {
        this._events_manager = eventsManager;
        this._event_list = eventList;
        this._calendar = null;
        this._signal_ids = [];
        this._selected_date = eventList ? eventList.selectedCivilDate : null;
        this._selected_local_date = eventList ? eventList.selectedDate : null;
        this._event_data_list = null;
        this._delay_no_events_box = false;
        this._events_overflowed = false;
        this._render_id = 0;

        this._connect();
    }

    // The calendar is built after the event list, so it arrives second. It is
    // read for the selected day's holiday and nothing else.
    setCalendar(calendar) {
        this._calendar = calendar;
    }

    get selectedDate() {
        return this._selected_date;
    }

    _connect() {
        const manager = this._events_manager;
        this._signal_ids.push(
            manager.connect("selected-date-changed", (em, date, gdate) => {
                this._event_list.set_date(date, gdate);
                this._selected_date = { ...date };
                this._selected_local_date = gdate;
                this._event_data_list = null;
                this._delay_no_events_box = Boolean(gdate);
                this._events_overflowed = false;
                this._queueRender();
            }),
            manager.connect("selected-date-events-changed",
                (em, eventDataList, delayNoEventsBox, overflowed) => {
                    this._event_data_list = eventDataList;
                    this._delay_no_events_box = delayNoEventsBox;
                    this._events_overflowed = overflowed;
                    this.render();
                }),
            manager.connect("refresh-error-changed", (em, failed) => {
                this._event_list.set_refresh_failed(failed);
            }));
    }

    // The column's date heading and its holiday row used to come only from the
    // events manager's "selected-date-changed", and `EventWindowCoordinator`
    // returns before emitting anything when `isActive()` is false. With "Show
    // events" on and evolution-data-server absent — or present with every
    // calendar disabled — that signal never fires for the life of the session,
    // while the column stays on screen: the heading was built with no text and
    // had no other writer, so it rendered permanently blank, and the selected
    // date stayed pinned to the applet's start date, so clicking through the
    // grid moved the dots while the column kept announcing the holiday of the
    // day the applet was added.
    //
    // The calendar's own signal fires regardless of event availability, and it
    // fires first, so the events-manager handler still owns the rendering
    // whenever it is going to run at all — this only fills the gap it leaves.
    //
    // Both producers use civil dates. Only timed events need a local instant;
    // the heading and holiday remain the same when that projection is absent.
    selectDate(date) {
        if (!this._event_list || !date) {
            return;
        }

        const gdate = CivilTime.projectCivilDate(date, GLib.TimeZone.new_local());
        const changed = !DateMath.sameCivilDate(date, this._selected_date) ||
            gdate?.to_unix() !== this._selected_local_date?.to_unix();
        this._event_list.set_date(date, gdate);
        this._selected_date = { ...date };
        this._selected_local_date = gdate;
        if (changed) {
            this._event_data_list = null;
            this._delay_no_events_box = false;
            this._events_overflowed = false;
        }
        if (!this._events_manager.is_active() || !gdate) {
            this.render();
        } else if (changed) {
            this._queueRender();
        }
    }

    // The two signals arrive together: EventWindowCoordinator.selectDate emits
    // the new day and then, in the same synchronous call, that day's events. So
    // rendering on the first one only ever built a column the second one
    // replaced — a _clearRows, a "Loading…" write and a 600 ms timer armed and
    // cancelled, on every click, arrow key and go-home. On a day carrying a
    // holiday it was real actors: composeSelectedDayAgenda(null, holiday) is a
    // one-row agenda, so the holiday row was built, torn down and built again.
    //
    // The day handler marks the column stale and leaves the drawing to the
    // delivery behind it. The idle is the safety net: nothing emits a day
    // change on its own today, and if anything ever does, the column must not
    // keep showing the previous day's events.
    _queueRender() {
        if (this._render_id > 0) {
            return;
        }

        this._render_id = Mainloop.idle_add(() => {
            this._render_id = 0;
            this.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancelRender() {
        if (this._render_id > 0) {
            Mainloop.source_remove(this._render_id);
            this._render_id = 0;
        }
    }

    render() {
        this.cancelRender();
        if (!this._event_list) {
            return;
        }
        const holiday = this._calendar && this._selected_date ?
            this._calendar.holidayForDate(this._selected_date) : null;
        this._event_list.set_events(
            EventView.composeSelectedDayAgenda(this._selected_local_date ? this._event_data_list : null, holiday),
            Boolean(this._selected_local_date && this._delay_no_events_box),
            Boolean(this._selected_local_date && this._events_overflowed));
    }

    // The column may be waiting on an idle to draw itself, and the actors it
    // would draw into are the builder's to destroy. The handlers go with it:
    // nothing emits after EventsManager.destroy() today, but they were the only
    // set of connects in the applet with no owner, which makes them the ones
    // that break when something upstream starts emitting a little later than it
    // used to.
    destroy() {
        this.cancelRender();
        for (const id of this._signal_ids) {
            this._events_manager.disconnect(id);
        }
        this._signal_ids = [];
        this._event_list = null;
        this._calendar = null;
    }
};

if (typeof module !== "undefined") {
    module.exports = { AgendaColumnCoordinator };
}
