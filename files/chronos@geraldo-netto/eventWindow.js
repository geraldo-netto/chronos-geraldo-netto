// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports */
/* eslint camelcase: "off" */

// Date-window use case. It coordinates the pure event index and calls ports
// supplied by the orchestration layer; it knows no DBus proxy.
const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const GLib = GjsImports.gi.GLib;
const Cinnamon = GjsImports.gi.Cinnamon;
const APPLET_MODULES = IS_NODE ?
    null : GjsImports.ui.appletManager.applets["chronos@geraldo-netto"];
const DateMath = APPLET_MODULES ? APPLET_MODULES.dateMath : require("./dateMath");
const EventDataModule = APPLET_MODULES ? APPLET_MODULES.eventData : require("./eventData");
const CivilTime = APPLET_MODULES ? APPLET_MODULES.civilTime : require("./civilTime");
const dt_equals = EventDataModule.dt_equals;

var EventWindowCoordinator = class EventWindowCoordinator { // NOSONAR [S3504] -- GJS importer export
    constructor(index) {
        this.index = index;
        this.current_month_year = null;
        this.current_window_signature = null;
        this.current_selected_date = GLib.DateTime.new_from_unix_local(0);
        this.current_selected_civil = null;
        this.current_selected_signature = null;
    }

    fetchMonthEvents(month_year, force, setTimeRange, timestampNow,
        onWindowChanged, cancellable = null) {
        const changed_month = this.current_month_year === null ||
            !dt_equals(month_year, this.current_month_year);
        const first = DateMath.monthWindowStart(
            month_year.get_year(), month_year.get_month(), Cinnamon.util_get_week_start());
        const afterLast = DateMath.addCivilDays(first, 42);
        const timezone = GLib.TimeZone.new_local();
        // Project each civil endpoint independently: a skipped first day must
        // not move the exclusive end, and folded midnights start at their first copy.
        const start = CivilTime.civilDayStart(first.year, first.month, first.day, timezone);
        const end = CivilTime.civilDayStart(afterLast.year, afterLast.month, afterLast.day,
            timezone).add_seconds(-1);
        const window_signature = `${start.to_unix()}/${end.to_unix()}`;
        const changed_window = window_signature !== this.current_window_signature;
        if (!changed_month && !changed_window && !force) {
            return null;
        }
        this.current_month_year = month_year;
        this.current_window_signature = window_signature;

        // A forced refetch with identical bounds keeps indexed events. A new
        // month or first weekday also retires pending deliveries before the
        // replacement request can deliver into the new window.
        if (changed_month || changed_window) {
            onWindowChanged();
            this.index.reset(start, end);
        } else {
            this.index.setWindow(start, end);
        }
        // Take the reconciliation watermark before dispatch. A test double can
        // complete synchronously, and production signals may arrive as soon as
        // the method is sent; both must stamp records with this same fetch.
        const timestamp = timestampNow();
        setTimeRange(start.to_unix(), end.to_unix(), force, cancellable, timestamp);
        return timestamp;
    }

    selectDate(date, force, isActive, fetchMonthEvents, emit) {
        if (!isActive()) {
            return;
        }

        const selectedSignature = DateMath.civilDateKey(date);
        if (!force && selectedSignature === this.current_selected_signature) {
            return;
        }

        const timezone = GLib.TimeZone.new_local();
        const gdate_only = CivilTime.projectCivilDate(date, timezone);
        const month_year = CivilTime.civilDayStart(date.year, date.month, 1, timezone);
        fetchMonthEvents(month_year, force);
        const previous = this.current_selected_civil;
        const delay_no_events_box = Boolean(gdate_only) && (!previous ||
            previous.year !== date.year || previous.month !== date.month);

        this.current_selected_civil = { ...date };
        this.current_selected_date = gdate_only;
        this.current_selected_signature = selectedSignature;
        emit("selected-date-changed", { ...date }, gdate_only);
        emit("selected-date-events-changed",
            this.index.get(gdate_only),
            delay_no_events_box,
            Boolean(gdate_only && this.index.overflowed));
    }

    // Re-project the retained civil date without borrowing the next day when
    // the new timezone omits it. The civil selection survives a null projection
    // and can become representable again after a later timezone change.
    renormalizeSelectedDate() {
        if (this.current_selected_signature === null) {
            return;
        }
        this.current_selected_date = CivilTime.projectCivilDate(
            this.current_selected_civil, GLib.TimeZone.new_local());
    }

    reloadSelected(isActive, fetchMonthEvents, emit) {
        // Background calendar-server transitions refresh data; they do not own
        // navigation. If the applet has not selected a date yet, its composition
        // root will do so when the provider-ready/status signal reaches it.
        if (!isActive() || this.current_selected_signature === null) {
            return;
        }

        const selected = this.current_selected_date;
        const civil = this.current_selected_civil;
        fetchMonthEvents(CivilTime.civilDayStart(civil.year, civil.month, 1,
            GLib.TimeZone.new_local()), true);
        emit("selected-date-changed", { ...civil }, selected);
        emit("selected-date-events-changed",
            this.index.get(selected), false, Boolean(selected && this.index.overflowed));
    }
};

if (typeof module !== "undefined") {
    module.exports = { EventWindowCoordinator };
}
