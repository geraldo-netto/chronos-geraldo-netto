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

    scheduleCities(force = false) {
        if (!this.cityWeatherProvider) {
            return;
        }

        const settings = this.settings();
        const clocks = settings.showWorldclocks === false ? [] :
            WorldclockData.selectUserClocks(this.worldclocks()).map((clock) => ({
                label: clock.label,
                query: WorldclockData.timezoneWeatherCity(clock.timezone)
            }));
        this.cityWeatherProvider.schedule({
            showWeather: settings.showWeather,
            units: settings.units,
            cities: clocks
        }, this.onChanged, force);
    }

    setStatus(reading = null, error = "", providerName = "", pending = false) {
        this.guard(() => {
            this.reading = reading || null;
            this.pending = pending;
            this.error = error;
            this.providerName = providerName || "";
            this.onChanged();
        });
    }

    cityReading(city) {
        return this.cityWeatherProvider ? this.cityWeatherProvider.recordFor(city) : null;
    }

    cityStale(city) {
        return this.cityWeatherProvider ? this.cityWeatherProvider.staleFor(city) : false;
    }

    cityProviderName() {
        return this.cityWeatherProvider ? this.cityWeatherProvider.lastProvider : "";
    }
}

// Owns the event-column visibility/unavailable policy and forced reselection.
// The manager and the two view ports can be replaced independently in tests.
class AppletEventListCoordinator {
    constructor(params) {
        this.manager = params.manager;
        this.eventList = params.eventList;
        this.selectedDate = params.selectedDate;
        this.guard = params.guard;
        this._appliedShowEvents = undefined;
    }

    update(showEvents) {
        const list = this.eventList();
        if (!list) {
            return;
        }
        const active = this.manager.is_active();
        list.actor.visible = Boolean(showEvents);
        list.set_unavailable(Boolean(showEvents) && !active);
    }

    apply(showEvents) {
        this.update(showEvents);
        if (showEvents !== this._appliedShowEvents) {
            this._appliedShowEvents = showEvents;
            this.manager.select_date(this.selectedDate(), true);
        }
    }

    ready(showEvents) {
        this.guard(() => {
            this.update(showEvents());
            this.manager.select_date(this.selectedDate(), true);
        });
    }

    calendarsChanged(showEvents) {
        this.guard(() => this.update(showEvents()));
    }
}

if (typeof module !== "undefined") {
    module.exports = { AppletWeatherCoordinator, AppletEventListCoordinator };
}
