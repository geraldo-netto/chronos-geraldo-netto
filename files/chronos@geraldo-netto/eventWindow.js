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
const DateFormats = APPLET_MODULES ? APPLET_MODULES.dateFormats : require("./dateFormats");
const EventDataModule = APPLET_MODULES ? APPLET_MODULES.eventData : require("./eventData");
const js_date_to_gdatetime = EventDataModule.js_date_to_gdatetime;
const date_only = EventDataModule.date_only;
const month_year_only = EventDataModule.month_year_only;
const dt_equals = EventDataModule.dt_equals;

var EventWindowCoordinator = class EventWindowCoordinator { // NOSONAR [S3504] -- GJS importer export
    constructor(index) {
        this.index = index;
        this.current_month_year = null;
        this.current_selected_date = GLib.DateTime.new_from_unix_local(0);
        this.current_selected_signature = null;
    }

    fetchMonthEvents(month_year, force, setTimeRange, timestampNow, cancellable = null) {
        const changed_month = this.current_month_year === null ||
            !dt_equals(month_year, this.current_month_year);
        if (!changed_month && !force) {
            return null;
        }
        this.current_month_year = month_year;

        if (changed_month) {
            this.index.clear();
        }

        const day_one = month_year_only(month_year);
        const start = day_one.add_days(-DateFormats.monthWindowStartOffset(
            day_one.get_day_of_week(), Cinnamon.util_get_week_start()));
        const end = start.add_days(42).add_seconds(-1);
        this.index.setWindow(start, end);
        setTimeRange(start.to_unix(), end.to_unix(), force, cancellable);
        return timestampNow();
    }

    selectDate(date, force, isActive, fetchMonthEvents, emit) {
        if (!isActive()) {
            return;
        }

        const selectedSignature = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        if (!force && selectedSignature === this.current_selected_signature) {
            return;
        }

        const gdate_only = date_only(js_date_to_gdatetime(date));
        if (!force && dt_equals(gdate_only, this.current_selected_date)) {
            this.current_selected_signature = selectedSignature;
            return;
        }

        const month_year = month_year_only(gdate_only);
        fetchMonthEvents(month_year, force);
        emit("selected-date-changed", gdate_only);
        const delay_no_events_box = !dt_equals(month_year_only(this.current_selected_date),
                                               month_year_only(gdate_only));

        this.current_selected_date = gdate_only;
        this.current_selected_signature = selectedSignature;
        emit("selected-date-events-changed",
            this.index.get(gdate_only),
            delay_no_events_box,
            Boolean(this.index.overflowed));
    }
};

if (typeof module !== "undefined") {
    module.exports = { EventWindowCoordinator };
}
