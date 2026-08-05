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
const WeatherFormat = require("./weatherFormat");
const CityWeather = require("./cityWeather");
const Holidays = require("./holidays");
const SettingsFacade = require("./settingsFacade");
const WorldclockData = require("./worldclockData");
const HolidayConstants = require("./holidayConstants");

const NO_HOLIDAYS = SettingsFacade.NO_HOLIDAYS;
const SUPPORTED_COUNTRIES = HolidayConstants.SUPPORTED_COUNTRIES;

function localDayKey(date) {
    return `${date.getFullYear()}:${date.getMonth()}:${date.getDate()}`;
}

function millisecondsUntilNextLocalDay(date) {
    const next = new Date(
        date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
    return Math.max(1, next.getTime() - date.getTime());
}

// WallClock only notifies when its rendered string changes, so a literal or
// month-only panel format is not a day clock. This source owns that one job.
// Recomputing the next local midnight after every firing preserves 23/25-hour
// days, and reschedule() handles timezone changes and resume jumps.
class LocalDayRollover {
    constructor({ now = () => new Date(), schedule = Mainloop.timeout_add,
        cancel = Mainloop.source_remove } = {}) {
        this._now = now;
        this._scheduleSource = schedule;
        this._cancelSource = cancel;
        this._sourceId = 0;
        this._dayKey = "";
        this._callback = null;
        this._destroyed = false;
    }

    start(callback) {
        if (this._destroyed || this._callback) {
            return;
        }
        this._callback = callback;
        this._dayKey = localDayKey(this._now());
        this._schedule();
    }

    _schedule() {
        if (this._destroyed || !this._callback) {
            return;
        }
        const delay = millisecondsUntilNextLocalDay(this._now());
        this._sourceId = this._scheduleSource(delay, () => {
            this._sourceId = 0;
            try {
                this._checkDay();
            } finally {
                this._schedule();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkDay() {
        const key = localDayKey(this._now());
        if (key === this._dayKey) {
            return;
        }
        this._dayKey = key;
        this._callback();
    }

    reschedule() {
        if (!this._callback || this._destroyed) {
            return;
        }
        this._cancel();
        try {
            this._checkDay();
        } finally {
            this._schedule();
        }
    }

    _cancel() {
        if (this._sourceId > 0) {
            this._cancelSource(this._sourceId);
            this._sourceId = 0;
        }
    }

    destroy() {
        this._destroyed = true;
        this._cancel();
        this._callback = null;
    }
}

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
        // AppletSettings registers itself with Cinnamon's settings manager at
        // construction, but the applet can only finalize what bind() returned
        // — a later bind step that throws (a corrupt schema has) would strand
        // the registration, and its bind closures pin the applet for the
        // session. Until the caller holds the instance, releasing it on
        // failure is this method's job.
        const settings = new Settings.AppletSettings(
            this.applet, "chronos@geraldo-netto", this.applet.instance_id);
        try {
            return this._bindAll(settings);
        } catch (e) {
            this._finalizeQuietly(settings);
            throw e;
        }
    }

    _bindAll(settings) {
        const applet = this.applet;
        const panel = new SettingsFacade.PanelSettings(settings);
        const holiday = new SettingsFacade.HolidaySettings(settings);
        this.holidaySettings = holiday;

        panel.migrateDateFormatDefaults();
        panel.bindPanelKeys(this.handlers);
        panel.bindWeatherKeys(
            applet,
            this.handlers.onWeatherSettingsChanged,
            this.handlers.onWeatherUnitsChanged);
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

    _finalizeQuietly(settings) {
        try {
            settings.finalize();
        } catch (e) {
            if (global.logError) {
                global.logError(e);
            }
        }
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
    weatherRepository: () => new Weather.WeatherReadingRepository({
        cacheSeconds: WeatherFormat.REFRESH_SECONDS
    }),
    weatherProvider: (repository) => new Weather.WeatherProvider({
        readingRepository: repository
    }),
    cityWeatherProvider: (repository) => new CityWeather.CityWeatherProvider({
        readingRepository: repository
    }),
    eventsManager: (eventsSettings) => EventsManagerModule.createEventsManager(eventsSettings),
    holidayProvider: (religiousIds) => Holidays.createHolidayProvider({ religiousIds })
};

// Owns the applet's providers and every signal it connects on their behalf.
// The context carries exactly what the providers need, so this class is
// constructible from plain objects in a test.
class AppletProviderLifecycle {
    constructor(context, factories = {}) {
        this.context = context;
        this.factories = Object.assign({}, DEFAULT_FACTORIES, factories); // NOSONAR [S6661] -- accepted compatible form
        this.clock = null;
        this.weatherRepository = null;
        this.weatherProvider = null;
        this.cityWeatherProvider = null;
        this.eventsManager = null;
        this.holidayProvider = null;
        this.holidayRegions = {};
        this._clock_notify_id = 0;
        this._dayRollover = new LocalDayRollover();
        this._actor_signal_ids = [];
        this._desktop_settings_signal_ids = [];
        this._events_manager_signal_ids = [];
        this._logind_sleep_signal_id = 0;
        this._timedate_signal_id = 0;
        this._destroyed = false;
    }

    initProviders() {
        const context = this.context;

        this.clock = this.factories.clock();
        this.weatherRepository = this.factories.weatherRepository();
        this.weatherProvider = this.factories.weatherProvider(this.weatherRepository);
        this.cityWeatherProvider = this.factories.cityWeatherProvider(this.weatherRepository);

        this._actor_signal_ids.push(context.actor.connect("enter-event", () => {
            context.onPanelHover(true);
        }));
        this._actor_signal_ids.push(context.actor.connect("leave-event", () => { // NOSONAR [S7778] -- accepted compatible form
            context.onPanelHover(false);
        }));

        this.eventsManager = this.factories.eventsManager(context.eventsSettings);
        this._events_manager_signal_ids.push(
            this.eventsManager.connect("events-manager-ready", context.onEventsManagerReady));
        this._events_manager_signal_ids.push( // NOSONAR [S7778] -- accepted compatible form
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
        this.holidayProvider = this.factories.holidayProvider(holidaySettings.religiousIds);
        this.holidayRegions = {};

        const onPlaceChanged = this.onHolidayPlaceChanged.bind(this);
        holidaySettings.connectCountryChanged(onPlaceChanged);
        // the regions bind onto a real target: onHolidayPlaceChanged reads
        // holidayRegions[country] to find the region for the country in use
        holidaySettings.bindRegions(this.holidayRegions, onPlaceChanged);
        holidaySettings.connectReligionsChanged(this.onReligionsChanged.bind(this));

        // A missing legacy value still means disabled. New settings have
        // already had their one-time timezone default resolved by the binder.
        if (holidaySettings.country == null) {
            holidaySettings.country = NO_HOLIDAYS;
        }

        // a country the combobox cannot show (an older config, a hand-edited
        // value) leaves the widget blank and every lookup failing, with only a
        // warning glyph on the month label to show for it
        const country = holidaySettings.country;
        if (country && country !== NO_HOLIDAYS && SUPPORTED_COUNTRIES.indexOf(country) === -1) { // NOSONAR [S7765] -- accepted compatible form
            global.logError(`chronos@geraldo-netto: holidays are unavailable for "${country}"; ` +
                "resetting the country to none");
            holidaySettings.country = NO_HOLIDAYS;
        }

        this.onHolidayPlaceChanged();
    }

    onReligionsChanged() {
        this.holidayProvider.setEnabledIds(this.context.holidaySettings.religiousIds);
        this.context.onHolidayPlaceChanged();
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

    // WallClock drives the rendered panel string. It notifies when the string
    // *it* renders changes, not once a second — measured,
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

    startDayRollover() {
        if (this._destroyed) {
            return;
        }
        this._dayRollover.start(this.context.onDayChanged);
    }

    bindSystemSignals() {
        const context = this.context;

        this._desktop_settings_signal_ids =
            context.desktopSettings.connectClockFormatChanged(context.onSettingsChanged);

        // logind's PrepareForSleep is true on the way into sleep and false on
        // resume, so refresh on the false transition.
        if (Gio && Gio.DBus && Gio.DBus.system) { // NOSONAR [S6582] -- accepted compatible form
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
                        this._dayRollover.reschedule();
                        context.onResume();
                    }
                });
            this._timedate_signal_id = Gio.DBus.system.signal_subscribe(
                "org.freedesktop.timedate1",
                "org.freedesktop.DBus.Properties",
                "PropertiesChanged",
                "/org/freedesktop/timedate1",
                null,
                Gio.DBusSignalFlags.NONE,
                () => this._dayRollover.reschedule());
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
        if (this._logind_sleep_signal_id > 0 && Gio && Gio.DBus && Gio.DBus.system) { // NOSONAR [S6582] -- accepted compatible form
            Gio.DBus.system.signal_unsubscribe(this._logind_sleep_signal_id);
            this._logind_sleep_signal_id = 0;
        }
        if (this._timedate_signal_id > 0 && Gio && Gio.DBus && Gio.DBus.system) { // NOSONAR [S6582] -- accepted compatible form
            Gio.DBus.system.signal_unsubscribe(this._timedate_signal_id);
            this._timedate_signal_id = 0;
        }
    }

    // Every step runs even if an earlier one throws: a teardown that stops at the
    // first failure leaves the rest of the applet's signals and timers connected
    // to a destroyed object for the life of the session.
    destroy() {
        this._destroyed = true;

        const steps = [
            () => this._releaseClockNotify(),
            () => this._dayRollover.destroy(),
            () => this._releaseActorSignals(),
            () => this.weatherProvider && this.weatherProvider.destroy(), // NOSONAR [S6582] -- accepted compatible form
            () => this.cityWeatherProvider && this.cityWeatherProvider.destroy(), // NOSONAR [S6582] -- accepted compatible form
            () => this.weatherRepository && this.weatherRepository.destroy(), // NOSONAR [S6582] -- accepted compatible form
            () => this.holidayProvider && this.holidayProvider.destroy(), // NOSONAR [S6582] -- accepted compatible form
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
    module.exports = { AppletSettingsBinder, AppletProviderLifecycle, LocalDayRollover,
        localDayKey, millisecondsUntilNextLocalDay, DEFAULT_FACTORIES };
}
