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

const CinnamonDesktop = imports.gi.CinnamonDesktop;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;
const EventsManagerModule = require("./eventsManager");
const Weather = require("./weather");
const CityWeather = require("./cityWeather");
const Holidays = require("./holidays");
const SettingsFacade = require("./settingsFacade");
const WorldclockData = require("./worldclockData");
const HolidayConstants = require("./holidayConstants");

const NO_HOLIDAYS = "none";
const SUPPORTED_COUNTRIES = HolidayConstants.SUPPORTED_COUNTRIES;

// Cinnamon's settings.bind() writes the bound value onto the applet object
// itself, so the applet is the bind target by construction. Everything else
// here is returned to the caller instead of assigned behind its back.
class AppletSettingsBinder {
    constructor(applet, handlers) {
        this.applet = applet;
        this.handlers = handlers;
        this.holidaySettings = null;
        this._country_inference_idle_id = 0;
    }

    bind() {
        const applet = this.applet;
        const settings = new Settings.AppletSettings(applet, "chronos@geraldo-netto", applet.instance_id);
        const panel = new SettingsFacade.PanelSettings(settings);
        const holiday = new SettingsFacade.HolidaySettings(settings);
        this.holidaySettings = holiday;

        panel.migrateDateFormatDefaults();
        panel.bindPanelKeys(this.handlers.onSettingsChanged);
        panel.bindWeatherKeys(applet, this.handlers.onWeatherSettingsChanged);
        // a user who never opens the settings dialog still gets a weather
        // location: the one their own timezone names
        panel.fillEmptyWeatherLocation(applet, WorldclockData.localCityName());
        panel.bindKeybinding(this.handlers.onKeybindingChanged);

        return {
            settings,
            panel,
            calendar: new SettingsFacade.CalendarSettings(settings),
            events: new SettingsFacade.EventsSettings(settings),
            holiday,
            worldclock: new SettingsFacade.WorldclockSettings(settings)
        };
    }

    // tzdata is local but synchronous. Cinnamon constructs applets on its
    // compositor thread, so wait for the added-to-panel callback and then yield
    // to the low-priority idle queue before reading it. A user choice made in
    // the meantime still wins because the facade only fills the empty sentinel.
    deferInitialHolidayCountry() {
        const holiday = this.holidaySettings;
        if (!holiday || this._country_inference_idle_id > 0 ||
                (holiday.country !== "" && holiday.country != null)) {
            return;
        }

        this._country_inference_idle_id = Mainloop.idle_add(() => {
            this._country_inference_idle_id = 0;
            holiday.fillInitialCountryFromTimezone(() =>
                HolidayConstants.countryFromIso2(WorldclockData.localCountryCode()));
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._country_inference_idle_id > 0) {
            Mainloop.source_remove(this._country_inference_idle_id);
            this._country_inference_idle_id = 0;
        }
        this.holidaySettings = null;
    }
}

// The composition root: the one place the applet's provider graph is assembled.
//
// This class said it "owns the applet's providers" and was "constructible from
// plain objects in a test" — but it could not substitute a single one of them.
// Every provider was a bare `new` on a concrete class, and the graph below each
// one self-assembled through default arguments: new HolidayProviderFacade()
// reached for new HolidayService(), which built the chain, its adapters, the
// repository and the cache; WeatherProvider built its display state, scheduler,
// two resolvers and a live Soup session. The wiring lived in four files'
// parameter lists, and no test could reach into it.
//
// The factories are that graph, in one object. A caller replaces the one node it
// cares about; the rest is the shipped wiring.
const DEFAULT_FACTORIES = {
    clock: () => new CinnamonDesktop.WallClock(),
    weatherProvider: () => new Weather.WeatherProvider(),
    cityWeatherProvider: () => new CityWeather.CityWeatherProvider(),
    eventsManager: (eventsSettings) => EventsManagerModule.createEventsManager(eventsSettings),
    holidayProvider: () => Holidays.createHolidayProvider()
};

// Owns the applet's providers and every signal it connects on their behalf.
// The context carries exactly what the providers need, so this class is
// constructible from plain objects in a test.
class AppletProviderLifecycle {
    constructor(context, factories = {}) {
        this.context = context;
        this.factories = Object.assign({}, DEFAULT_FACTORIES, factories);
        this.clock = null;
        this.weatherProvider = null;
        this.cityWeatherProvider = null;
        this.eventsManager = null;
        this.holidayProvider = null;
        this.holidayRegions = {};
        this._clock_notify_id = 0;
        this._actor_signal_ids = [];
        this._desktop_settings_signal_ids = [];
        this._events_manager_signal_ids = [];
        this._logind_sleep_signal_id = 0;
        this._destroyed = false;
    }

    initProviders() {
        const context = this.context;

        this.clock = this.factories.clock();
        this.weatherProvider = this.factories.weatherProvider();
        this.cityWeatherProvider = this.factories.cityWeatherProvider();

        this._actor_signal_ids.push(context.actor.connect("enter-event", () => {
            context.onPanelHover(true);
        }));
        this._actor_signal_ids.push(context.actor.connect("leave-event", () => {
            context.onPanelHover(false);
        }));

        this.eventsManager = this.factories.eventsManager(context.eventsSettings);
        this._events_manager_signal_ids.push(
            this.eventsManager.connect("events-manager-ready", context.onEventsManagerReady));
        this._events_manager_signal_ids.push(
            this.eventsManager.connect("has-calendars-changed", context.onHasCalendarsChanged));

        this.initHolidayProvider();

        return {
            clock: this.clock,
            weatherProvider: this.weatherProvider,
            cityWeatherProvider: this.cityWeatherProvider,
            eventsManager: this.eventsManager,
            holidayProvider: this.holidayProvider
        };
    }

    // holidays is a provider like weather and events; the place-changed
    // handler tolerates the calendar not existing yet
    initHolidayProvider() {
        const holidaySettings = this.context.holidaySettings;
        this.holidayProvider = this.factories.holidayProvider();
        this.holidayRegions = {};

        const onPlaceChanged = this.onHolidayPlaceChanged.bind(this);
        holidaySettings.connectCountryChanged(onPlaceChanged);
        // the regions bind onto a real target: onHolidayPlaceChanged reads
        // holidayRegions[country] to find the region for the country in use
        holidaySettings.bindRegions(this.holidayRegions, onPlaceChanged);

        // A missing legacy value still means disabled. New settings have
        // already had their one-time timezone default resolved by the binder.
        if (holidaySettings.country == null) {
            holidaySettings.country = NO_HOLIDAYS;
        }

        // a country the combobox cannot show (an older config, a hand-edited
        // value) leaves the widget blank and every lookup failing, with only a
        // warning glyph on the month label to show for it
        const country = holidaySettings.country;
        if (country && country !== NO_HOLIDAYS && SUPPORTED_COUNTRIES.indexOf(country) === -1) {
            global.logError(`chronos@geraldo-netto: holidays are unavailable for "${country}"; ` +
                "resetting the country to none");
            holidaySettings.country = NO_HOLIDAYS;
        }

        this.onHolidayPlaceChanged();
    }

    onHolidayPlaceChanged() {
        const country = this.context.holidaySettings.country || NO_HOLIDAYS;

        if (country === NO_HOLIDAYS) {
            this.holidayProvider.clearPlace();
        } else {
            // the second callback repaints when the fetch for the new place
            // lands, which is long after this call returns
            this.holidayProvider.setPlace(country, this.holidayRegions[country],
                () => this.context.onHolidayPlaceChanged());
        }

        this.context.onHolidayPlaceChanged();
    }

    // This is the applet's only clock: it arms no timer of its own. WallClock
    // notifies when the string *it* renders changes, not once a second — measured,
    // because four comments in this applet used to claim otherwise: with "%H:%M"
    // it emitted 0 times in ten seconds, with "%H:%M:%S" it emitted 11. So the
    // configured format is the tick rate: including %S produces second ticks;
    // otherwise WallClock waits until the rendered string actually changes.
    connectClockNotify(callback) {
        // destroy() zeroes the id, so guarding on the id alone lets Cinnamon's
        // on_applet_added_to_panel() re-arm a live handler on an applet whose
        // actors are already gone. Destroyed is terminal.
        if (this._destroyed || this._clock_notify_id > 0) {
            return;
        }

        this._clock_notify_id = this.clock.connect("notify::clock", callback);
    }

    bindSystemSignals() {
        const context = this.context;

        this._desktop_settings_signal_ids =
            context.desktopSettings.connectClockFormatChanged(context.onSettingsChanged);

        // logind's PrepareForSleep is true on the way into sleep and false on
        // resume, so refresh on the false transition.
        if (Gio && Gio.DBus && Gio.DBus.system) {
            this._logind_sleep_signal_id = Gio.DBus.system.signal_subscribe(
                "org.freedesktop.login1",
                "org.freedesktop.login1.Manager",
                "PrepareForSleep",
                "/org/freedesktop/login1",
                null,
                Gio.DBusSignalFlags.NONE,
                (connection, sender, path, iface, signal, params) => {
                    const [sleeping] = params.deep_unpack();
                    if (!sleeping) {
                        context.onResume();
                    }
                });
        }
    }

    // Every step runs even if an earlier one throws. This was one unguarded
    // block, so a single failure — weatherProvider.destroy() calling abort() on
    // a Soup session Cinnamon has already disposed, say, during a reload — left
    // the city-weather provider, the holiday provider and the events manager
    // undestroyed and the desktop-settings and logind signals connected: a
    // leaked EDS bus watch, four live DBus handlers and a 30-minute timer for
    // the rest of the session. The applet's own _destroy() has isolated its
    // steps for exactly this reason all along; this one did not.
    _releaseClockNotify() {
        if (this._clock_notify_id > 0) {
            this.clock.disconnect(this._clock_notify_id);
            this._clock_notify_id = 0;
        }
    }

    _releaseActorSignals() {
        for (let id of this._actor_signal_ids) {
            this.context.actor.disconnect(id);
        }
        this._actor_signal_ids = [];
    }

    _releaseEventsManager() {
        if (!this.eventsManager) {
            return;
        }

        for (let id of this._events_manager_signal_ids) {
            this.eventsManager.disconnect(id);
        }
        this._events_manager_signal_ids = [];
        this.eventsManager.destroy();
    }

    _releaseDesktopSettings() {
        for (let id of this._desktop_settings_signal_ids) {
            this.context.desktopSettings.disconnect(id);
        }
        this._desktop_settings_signal_ids = [];
    }

    _releaseLogind() {
        if (this._logind_sleep_signal_id > 0 && Gio && Gio.DBus && Gio.DBus.system) {
            Gio.DBus.system.signal_unsubscribe(this._logind_sleep_signal_id);
            this._logind_sleep_signal_id = 0;
        }
    }

    // Every step runs even if an earlier one throws: a teardown that stops at the
    // first failure leaves the rest of the applet's signals and timers connected
    // to a destroyed object for the life of the session.
    destroy() {
        this._destroyed = true;

        const steps = [
            () => this._releaseClockNotify(),
            () => this._releaseActorSignals(),
            () => this.weatherProvider && this.weatherProvider.destroy(),
            () => this.cityWeatherProvider && this.cityWeatherProvider.destroy(),
            () => this.holidayProvider && this.holidayProvider.destroy(),
            () => this._releaseEventsManager(),
            () => this._releaseDesktopSettings(),
            () => this._releaseLogind()
        ];

        for (const step of steps) {
            try {
                step();
            } catch (e) {
                global.logError(e);
            }
        }
    }
}

if (typeof module !== "undefined") {
    module.exports = { AppletSettingsBinder, AppletProviderLifecycle, DEFAULT_FACTORIES };
}
