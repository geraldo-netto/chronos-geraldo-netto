// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* eslint camelcase: "off" */

const WorldclockData = require("./worldclockData");

// Owns panel and per-city weather state plus every scheduling decision. The
// applet supplies settings and a repaint callback; presenters only read this
// coordinator's public state.
class AppletWeatherCoordinator {
    constructor(params) {
        this.weatherProvider = params.weatherProvider;
        this.cityWeatherProvider = params.cityWeatherProvider;
        this.settings = params.settings;
        this.worldclocks = params.worldclocks;
        this.onChanged = params.onChanged;
        this.guard = params.guard;
        this.reading = null;
        this.pending = false;
        this.error = "";
        this.providerName = "";
        // undefined, not false: the first applyShowWorldclocks must schedule
        // whichever way the setting reads, the way the event coordinator does
        this._appliedShowWorldclocks = undefined;
    }

    _request() {
        const settings = this.settings();
        return {
            showWeather: settings.showWeather,
            location: settings.location,
            units: settings.units
        };
    }

    schedule({ force = false } = {}) {
        this.weatherProvider.schedule(this._request(), this.setStatus.bind(this));
        this.scheduleCities(force);
    }

    queue() {
        this.weatherProvider.queue(this._request(), this.setStatus.bind(this));
        this.scheduleCities();
    }

    // The city weather exists to put a temperature beside each world clock,
    // so switching the clocks off is the end of the reason to fetch it. The
    // change detection lives here with the scheduling decision it gates:
    // when the two halves lived in different classes, one could be edited
    // without the other and an armed timer kept fetching after the opt-out.
    applyShowWorldclocks() {
        const show = this.settings().showWorldclocks;
        if (show !== this._appliedShowWorldclocks) {
            this._appliedShowWorldclocks = show;
            this.scheduleCities();
        }
    }

    scheduleCities(force = false) {
        if (!this.cityWeatherProvider) {
            return;
        }

        const settings = this.settings();
        const clocks = settings.showWorldclocks === false ? [] :
            WorldclockData.selectUserClocks(this.worldclocks()).map((clock) => ({
                label: WorldclockData.clockDisplayLabel(clock.label),
                ...WorldclockData.timezoneWeatherRequest(clock.timezone)
            }));
        this.cityWeatherProvider.schedule({
            showWeather: settings.showWeather,
            units: settings.units,
            cities: clocks
        }, this.onChanged, force);
    }

    setStatus(reading = null, error = "", providerName = "", pending = false) {
        this.guard("weather-status", () => {
            this.reading = reading || null;
            this.pending = pending;
            this.error = error;
            this.providerName = providerName || "";
            this.onChanged();
        });
    }

    currentPlace() {
        const settings = this.settings();
        if (!settings.showWeather || !this.weatherProvider.placeFor) {
            return null;
        }
        return this.weatherProvider.placeFor(settings.location);
    }

    cityReading(timezone) {
        const request = WorldclockData.timezoneWeatherRequest(timezone);
        return request && this.cityWeatherProvider ?
            this.cityWeatherProvider.recordFor(request.query, request.hint) : null;
    }

    cityStale(timezone) {
        const request = WorldclockData.timezoneWeatherRequest(timezone);
        return request && this.cityWeatherProvider ?
            this.cityWeatherProvider.staleFor(request.query, request.hint) : false;
    }

    cityError(timezone) {
        const request = WorldclockData.timezoneWeatherRequest(timezone);
        return request && this.cityWeatherProvider ?
            this.cityWeatherProvider.errorFor(request.query, request.hint) : "";
    }

    cityProviderName(timezone) {
        const request = WorldclockData.timezoneWeatherRequest(timezone);
        return request && this.cityWeatherProvider ?
            this.cityWeatherProvider.providerFor(request.query, request.hint) : "";
    }
}

// Owns the event-column visibility/unavailable policy and forced reselection.
// The manager and the two view ports can be replaced independently in tests.
class AppletEventListCoordinator {
    constructor(params) {
        this.manager = params.manager;
        this.eventList = params.eventList;
        this.selectedDate = params.selectedDate;
        this.focusSelectedDay = params.focusSelectedDay;
        this.guard = params.guard;
        this.onEnabledChanged = params.onEnabledChanged || (() => {});
        this._appliedShowEvents = undefined;
    }

    update(showEvents) {
        const list = this.eventList();
        if (!list) {
            return null;
        }
        const active = this.manager.is_active();
        const enabled = Boolean(showEvents);
        if (!enabled) {
            const focus = global.stage?.get_key_focus();
            if (focus && list.actor.contains(focus)) {
                // Hiding a focused column drops focus to the stage and closes the popup.
                this.focusSelectedDay();
            }
        }
        list.actor.visible = enabled;
        list.set_reporting_enabled(enabled);
        list.set_unavailable(enabled && !active);
        return list;
    }

    apply(showEvents) {
        const enabled = Boolean(showEvents);
        const list = this.update(enabled);
        if (list) {
            list.refresh_time_format();
        }
        if (enabled !== this._appliedShowEvents) {
            this._appliedShowEvents = enabled;
            // off: the manager quiesces its own pipeline. On: the window to
            // fetch is the day the calendar has selected, which is this
            // coordinator's to say.
            this.manager.disableIfOff(enabled);
            if (enabled) {
                this.manager.select_date(this.selectedDate(), true);
            }
            // The column above is this coordinator's own; the grid's dots
            // gate on event-data availability, which only manager signals
            // recompute — and a settings flip fires none of them.
            this.onEnabledChanged();
        }
    }

    // The minute tick is what keeps the column's relative times ("in 20
    // minutes") honest, and re-selecting the day is what reloads the month
    // across a midnight rollover. Both used to run inside the panel presenter,
    // so the panel's refresh policy silently decided when calendar data
    // reloaded — and createPanelPort was two entries wider for it.
    tick() {
        this.manager.select_date(this.selectedDate());
        const list = this.eventList();
        if (list) {
            list.refresh_time_state();
        }
    }

    ready(showEvents) {
        this.guard("events-ready", () => {
            this.update(showEvents());
            this.manager.select_date(this.selectedDate(), true);
        });
    }

    calendarsChanged(showEvents) {
        this.guard("calendars-changed", () => {
            this.update(showEvents());
            // Status transitions are the one reload path whose authoritative
            // target lives outside EventsManager. Ask the calendar port instead
            // of letting the manager invent "today" behind the view's back.
            this.manager.select_date(this.selectedDate(), true);
        });
    }
}

if (typeof module !== "undefined") {
    module.exports = { AppletWeatherCoordinator, AppletEventListCoordinator };
}
