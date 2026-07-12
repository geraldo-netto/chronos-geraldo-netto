/* global imports */
/* eslint camelcase: "off" */

const CinnamonDesktop = imports.gi.CinnamonDesktop;
const UPowerGlib = imports.gi.UPowerGlib;
const Settings = imports.ui.settings;
const EventsManagerModule = require("./eventsManager");
const Weather = require("./weather");
const CityWeather = require("./cityWeather");
const Holidays = require("./holidays");
const SettingsFacade = require("./settingsFacade");
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
    }

    bind() {
        const applet = this.applet;
        const settings = new Settings.AppletSettings(applet, "chronos@geraldo-netto", applet.instance_id);
        const panel = new SettingsFacade.PanelSettings(settings);

        panel.bindPanelKeys(this.handlers.onSettingsChanged);
        panel.bindWeatherKeys(applet, this.handlers.onWeatherSettingsChanged);
        panel.bindKeybinding(this.handlers.onKeybindingChanged);

        return {
            settings,
            panel,
            calendar: new SettingsFacade.CalendarSettings(settings),
            events: new SettingsFacade.EventsSettings(settings),
            holiday: new SettingsFacade.HolidaySettings(settings),
            worldclock: new SettingsFacade.WorldclockSettings(settings)
        };
    }
}

// The composition root: the one place the applet's provider graph is assembled.
//
// This class said it "owns the applet's providers" and was "constructible from
// plain objects in a test" — but it could not substitute a single one of them.
// Every provider was a bare `new` on a concrete class, and the graph below each
// one self-assembled through default arguments: new HolidayProviderFacade()
// reached for new Enrico(), which built the chain, the three adapters, the
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
    eventsManager: (eventsSettings) => new EventsManagerModule.EventsManager(eventsSettings),
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
        this._up_client = null;
        this._up_resume_signal_id = 0;
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
            holidayProvider: this.holidayProvider,
            holidayRegions: this.holidayRegions
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

        // holidays are opt-in, like weather: a country reaches a third-party
        // service, so the applet never picks one on the user's behalf
        if (holidaySettings.country == null) {
            holidaySettings.country = NO_HOLIDAYS;
        }

        // a country the combobox cannot show (an older config, a hand-edited
        // value) leaves the widget blank and every lookup failing, with only a
        // warning glyph on the month label to show for it
        const country = holidaySettings.country;
        if (country !== NO_HOLIDAYS && SUPPORTED_COUNTRIES.indexOf(country) === -1) {
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
    // format string is the tick rate, and _updateFormatString only puts %S in it
    // when clock-show-seconds is set. Seconds off, a minute; seconds on, a second.
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

        this._up_client = new UPowerGlib.Client();
        try {
            this._up_resume_signal_id = this._up_client.connect("notify-resume", context.onResume);
        } catch (unsupportedSignal) {
            void unsupportedSignal;
            this._up_resume_signal_id = this._up_client.connect("notify::resume", context.onResume);
        }
    }

    // Every step runs even if an earlier one throws. This was one unguarded
    // block, so a single failure — weatherProvider.destroy() calling abort() on
    // a Soup session Cinnamon has already disposed, say, during a reload — left
    // the city-weather provider, the holiday provider and the events manager
    // undestroyed and the desktop-settings and UPower signals connected: a
    // leaked EDS bus watch, four live DBus handlers, a 30-minute timer, and a
    // UPower handler firing into a dead applet on every resume, for the rest of
    // the session. The applet's own _destroy() has isolated its steps for
    // exactly this reason all along; this one did not.
    destroy() {
        this._destroyed = true;

        const steps = [
            () => {
                if (this._clock_notify_id > 0) {
                    this.clock.disconnect(this._clock_notify_id);
                    this._clock_notify_id = 0;
                }
            },
            () => {
                for (let id of this._actor_signal_ids) {
                    this.context.actor.disconnect(id);
                }
                this._actor_signal_ids = [];
            },
            () => this.weatherProvider && this.weatherProvider.destroy(),
            () => this.cityWeatherProvider && this.cityWeatherProvider.destroy(),
            () => this.holidayProvider && this.holidayProvider.destroy(),
            () => {
                if (!this.eventsManager) {
                    return;
                }
                for (let id of this._events_manager_signal_ids) {
                    this.eventsManager.disconnect(id);
                }
                this._events_manager_signal_ids = [];
                this.eventsManager.destroy();
            },
            () => {
                for (let id of this._desktop_settings_signal_ids) {
                    this.context.desktopSettings.disconnect(id);
                }
                this._desktop_settings_signal_ids = [];
            },
            () => {
                if (this._up_resume_signal_id > 0) {
                    this._up_client.disconnect(this._up_resume_signal_id);
                    this._up_resume_signal_id = 0;
                }
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
}

if (typeof module !== "undefined") {
    module.exports = { AppletSettingsBinder, AppletProviderLifecycle, DEFAULT_FACTORIES };
}
