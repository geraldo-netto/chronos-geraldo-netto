/* global imports */
/* eslint camelcase: "off" */

const Applet = imports.ui.applet;
const Gio = imports.gi.Gio;
const Util = imports.misc.util;
const PopupMenu = imports.ui.popupMenu;
const AppletLifecycle = require("./appletLifecycle");
const SettingsFacade = require("./settingsFacade");
const Utils = require("./utils");
const AppletPanelStatus = require("./appletPanelStatus");
const AppletMenu = require("./appletMenuBuilder");
const WorldclockData = require("./worldclockData");
const Main = imports.ui.main;
const AppletSettingsBinder = AppletLifecycle.AppletSettingsBinder;
const AppletProviderLifecycle = AppletLifecycle.AppletProviderLifecycle;
const AppletPanelStatusPresenter = AppletPanelStatus.AppletPanelStatusPresenter;
const AppletMenuBuilder = AppletMenu.AppletMenuBuilder;

class CinnamonCalendarApplet extends Applet.TextApplet {
    constructor(orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        try {
            // The locale query is process-wide and shared with every other
            // instance of this applet on the panel; the count is what stops this
            // instance's teardown from cancelling their query. Claimed before
            // anything below can throw, because the catch tears down.
            Utils.registerLocaleConsumer();

            this.menuManager = new PopupMenu.PopupMenuManager(this);
            this.orientation = orientation;

            this._initContextMenu();
            this.menu.setCustomStyleClass('calendar-background');
            this._styleTooltip();

            this._bindSettings();

            this.desktop_settings = new SettingsFacade.DesktopSettings(
                new Gio.Settings({ schema_id: SettingsFacade.DESKTOP_SCHEMA }));

            this._initProviders();

            this._buildUi();

            this._providerLifecycle.bindSystemSignals();

            this.worldclock_settings.connectChanged(this._onWorldclocksChanged.bind(this));
            this.worldclocks = this.worldclock_settings.clocks;
            this.worldclock_format = "%H:%M";

            // the rows exist because of the clock list, and are rebuilt only
            // when it changes; the format only decides what they say
            this._worldclocks.buildClocks(this.worldclocks, this.worldclock_format);
            this._updateFormatString();

            this._constructed = true;
        }
        catch (e) {
            global.logError(e);
            // a partial build still holds a WallClock handler, the UPower
            // client, weather timers, the EDS bus watch and DBus proxy
            // signals; leaving them behind leaks them for the whole session
            this._destroy();
        }
    }

    _initProviders() {
        // the reading is the unit-free record the panel renders from; the text
        // is the placeholder/empty/pending string state the record cannot carry
        this._weather_reading = null;
        // no reading has landed yet: a state of its own, not a placeholder string
        this._weather_pending = false;
        this._weather_error = "";
        this._weather_provider = "";
        this._panel_hovered = false;

        this._providerLifecycle = new AppletProviderLifecycle({
            actor: this.actor,
            desktopSettings: this.desktop_settings,
            eventsSettings: this.events_settings,
            holidaySettings: this.holiday_settings,
            onPanelHover: (hovered) => {
                this._panel_hovered = hovered;
                if (hovered) {
                    this._updateClockAndDate();
                }
            },
            onEventsManagerReady: () => this._events_manager_ready(),
            onHasCalendarsChanged: () => this._has_calendars_changed(),
            onHolidayPlaceChanged: () => {
                if (this._calendar) {
                    this._calendar.refreshHolidays();
                }
            },
            onSettingsChanged: () => this._onSettingsChanged(),
            onResume: () => this._onResume()
        });

        const providers = this._providerLifecycle.initProviders();
        this.clock = providers.clock;
        this._weatherProvider = providers.weatherProvider;
        this._cityWeatherProvider = providers.cityWeatherProvider;
        this.events_manager = providers.eventsManager;
        this.holiday_provider = providers.holidayProvider;
    }

    _buildUi() {
        this._menuBuilder = new AppletMenuBuilder({
            menu: this.menu,
            contextMenu: this._applet_context_menu,
            desktopSettings: this.desktop_settings,
            calendarSettings: this.calendar_settings,
            eventsManager: this.events_manager,
            holidayProvider: this.holiday_provider,
            onGoHome: () => this._resetCalendar(),
            onSelectedDateChanged: () => this._updateClockAndDate(true),
            onLaunchSettings: () => this._onLaunchSettings()
        });

        const ui = this._menuBuilder.build();
        this.event_list = ui.eventList;
        this._calendar = ui.calendar;
        this._worldclocks = ui.worldclocks;
        this.go_home_button = ui.goHomeButton;
        this._day = ui.dayLabel;
        this._date = ui.dateLabel;
    }

    // Bound, because the receiver depends on which of Cinnamon's two paths the key
    // takes and the handler cannot see which one it is. settings.bind() binds the
    // callback to the applet for us, so a bare method works there — but
    // weather-location is a "custom"-typed key, which bind() refuses, so the facade
    // mirrors it through settings.connect(), which calls the callback with no
    // receiver at all. `this` was then undefined in a class-body method,
    // `this._guarded` threw TypeError into a GJS signal emission, which swallows
    // it, and the location the user typed never reached the geocoder: the panel
    // went on fetching the old city for the rest of the session, silently.
    _bindSettings() {
        this._settingsBinder = new AppletSettingsBinder(this, {
            onSettingsChanged: this._onSettingsChanged.bind(this),
            onWeatherSettingsChanged: this._onWeatherSettingsChanged.bind(this),
            onKeybindingChanged: this._setKeybinding.bind(this)
        });

        const bound = this._settingsBinder.bind();
        this.settings = bound.settings;
        this.panel_settings = bound.panel;
        this.calendar_settings = bound.calendar;
        this.events_settings = bound.events;
        this.holiday_settings = bound.holiday;
        this.worldclock_settings = bound.worldclock;

        this._setKeybinding();
    }

    // themes centre tooltip text, which reads badly for a table of clocks: the
    // rows are one string, so a centred block staggers every line
    _styleTooltip() {
        const tooltip = this._applet_tooltip && this._applet_tooltip._tooltip;
        if (tooltip && tooltip.add_style_class_name) {
            tooltip.add_style_class_name("calendar-tooltip");
        }
    }

    // Everything below that a signal can reach runs through this. The callers are
    // GLib, GObject and Cinnamon's settings — none of them is a JS frame, so a
    // throw out of one of these handlers unwinds into the compositor, where it is
    // nobody's to catch: the applet stops updating and stays that way until
    // Cinnamon restarts. The construction and teardown paths have been guarded
    // like this all along; the paths that run once a second were not.
    _guarded(fn) {
        try {
            return fn();
        } catch (e) {
            global.logError(e);
            return undefined;
        }
    }

    // settings emit (emitter, key, oldValue, newValue)
    _onWorldclocksChanged(setting_provider, key, oldval, newval) {
        this._guarded(() => {
            this.worldclocks = newval;
            this._worldclocks.buildClocks(this.worldclocks, this.worldclock_format);
            this._worldclocks.updateClocks();
            this._scheduleCityWeatherRefresh();
        });
    }

    _setKeybinding() {
        Main.keybindingManager.addHotKey("calendar-open-" + this.instance_id, this.keyOpen, this._openMenu.bind(this));
    }

    // the hottest path in the applet: WallClock's notify::clock
    _clockNotify(obj, pspec, data) {
        this._guarded(() => this._updateClockAndDate());
    }

    // A suspend does not advance CLOCK_MONOTONIC, which is what GLib's timers
    // ride, so on wake the armed refresh still thinks it has most of its period
    // left. Both readouts are re-read at once, and the city half is forced past
    // its "nothing changed" guard — the settings have not changed, but the world
    // has.
    _onResume() {
        this._guarded(() => {
            this._updateClockAndDate();
            this._scheduleWeatherRefresh({ force: true });
        });
    }

    on_applet_clicked(event) {
        this._openMenu();
    }
    
    _openMenu() {
        this.menu.toggle();
    }

    // Cinnamon text entries fire this on every keystroke. Rebuilding the clock
    // format tears down and recreates the world-clock actors, and a forced
    // select_date makes the calendar server re-emit and re-parse the whole
    // month, so both are gated on the values that actually drive them.
    _formatSignature() {
        return [
            this.orientation,
            this.use_custom_format,
            this.custom_format,
            this.show_worldclocks,
            this.desktop_settings.use24h,
            this.desktop_settings.showSeconds
        ].join("|");
    }

    _onSettingsChanged() {
        this._guarded(() => this._applySettings());
    }

    _applySettings() {
        const formatSignature = this._formatSignature();
        if (formatSignature !== this._applied_format_signature) {
            this._applied_format_signature = formatSignature;
            this._updateFormatString();
        }

        this._updateClockAndDate();
        this._updateEventListState();

        if (this.show_events !== this._applied_show_events) {
            this._applied_show_events = this.show_events;
            this.events_manager.select_date(this._calendar.getSelectedDate(), true);
        }

        // The city weather exists to put a temperature beside each world clock,
        // so switching the clocks off is the end of the reason to fetch it. The
        // guard for that lives inside _scheduleCityWeatherRefresh — and nothing
        // called it when the setting changed. The armed timer closed over the old
        // settings and went on geocoding and forecasting eight cities every 30
        // minutes for the rest of the session: network traffic continuing after
        // the user opted out.
        if (this.show_worldclocks !== this._applied_show_worldclocks) {
            this._applied_show_worldclocks = this.show_worldclocks;
            this._scheduleCityWeatherRefresh();
        }
    }

    _onWeatherSettingsChanged() {
        this._guarded(() => {
            this._updateClockAndDate();
            this._queueWeatherRefresh();
        });
    }

    on_custom_format_button_pressed() {
        Util.spawnCommandLine("xdg-open https://cinnamon-spices.linuxmint.com/strftime.php");
    }

    _onLaunchSettings() {
        this.menu.close();
        Util.spawnCommandLine("cinnamon-settings calendar");
    }

    _panelStatus() {
        if (!this._panelStatusPresenter) {
            this._panelStatusPresenter = new AppletPanelStatusPresenter(this);
        }
        return this._panelStatusPresenter;
    }

    _updateFormatString() {
        this._panelStatus().updateFormatString();
    }

    _scheduleWeatherRefresh({ force = false } = {}) {
        this._weatherProvider.schedule({
            showWeather: this.show_weather,
            location: this.weather_location,
            units: this.weather_units
        }, this._setWeatherStatus.bind(this));
        this._scheduleCityWeatherRefresh(force);
    }

    _queueWeatherRefresh() {
        this._weatherProvider.queue({
            showWeather: this.show_weather,
            location: this.weather_location,
            units: this.weather_units
        }, this._setWeatherStatus.bind(this));
        this._scheduleCityWeatherRefresh();
    }

    // the tooltip prints a temperature next to every world clock, so the
    // cities are read as a set; a clock the user just added is one more place
    // to resolve, not a reason to re-read the panel location
    _scheduleCityWeatherRefresh(force = false) {
        if (!this._cityWeatherProvider) {
            return;
        }

        this._cityWeatherProvider.schedule({
            showWeather: this.show_weather,
            units: this.weather_units,
            // selectUserClocks is what decides which clocks the popup shows, so
            // it is what decides which cities have weather. Reading the raw
            // list here meant a clock the popup drops — one whose timezone
            // resolves to a built-in, like Etc/UTC — was still geocoded every
            // half hour and still ate one of the eight weather slots.
            //
            // The label is the user's own name for the clock — it can be "Mom's
            // place" — and geocoding it would send that to two third-party
            // services, and ask the wrong question while doing it. The timezone
            // already names the city.
            // ...and with the world clocks switched off there are no rows to
            // put a temperature beside, so there is nothing to ask about: this
            // used to geocode and forecast all eight cities every 30 minutes
            // for a feature the user had turned off
            cities: this.show_worldclocks === false ? [] :
                WorldclockData.selectUserClocks(this.worldclocks).map((clock) => ({
                    label: clock.label,
                    query: WorldclockData.timezoneCityName(clock.timezone)
                }))
        }, () => this._updateClockAndDate(), force);
    }

    cityWeatherReading(city) {
        return this._cityWeatherProvider ? this._cityWeatherProvider.recordFor(city) : null;
    }

    cityWeatherStale(city) {
        return this._cityWeatherProvider ? this._cityWeatherProvider.staleFor(city) : false;
    }

    cityWeatherProviderName() {
        return this._cityWeatherProvider ? this._cityWeatherProvider.lastProvider : "";
    }

    // an HTTP completion, so its caller is the main loop, not the code that
    // asked for the forecast
    _setWeatherStatus(weatherReading = null, weatherError = "", weatherProvider = "", pending = false) {
        this._guarded(() => {
            this._weather_reading = weatherReading || null;
            this._weather_pending = pending;
            this._weather_error = weatherError;
            this._weather_provider = weatherProvider || "";
            this._updateClockAndDate();
        });
    }

    // the column stays up whenever the user asked for events; when no calendar
    // service answers, the list says so instead of vanishing
    _updateEventListState() {
        const active = this.events_manager.is_active();
        this.event_list.actor.visible = Boolean(this.show_events);
        this.event_list.set_unavailable(Boolean(this.show_events) && !active);
    }

    // both are EventsManager signals, raised from a DBus callback
    _events_manager_ready(em) {
        this._guarded(() => {
            this._updateEventListState();
            this.events_manager.select_date(this._calendar.getSelectedDate(), true);
        });
    }

    _has_calendars_changed(em) {
        this._guarded(() => this._updateEventListState());
    }

    _updateClockAndDate(forceMenuUpdate = false) {
        this._panelStatus().updateClockAndDate(forceMenuUpdate);
    }

    on_applet_added_to_panel() {
        // The constructor catches its own failure, tears down what it built and
        // still returns an object, so Cinnamon goes on to call this — which
        // dereferenced _providerLifecycle, events_manager and _calendar
        // unconditionally. A corrupt settings schema made _bindSettings() throw,
        // and the applet then died a second time inside Cinnamon's own
        // applet-loading loop, where the TypeError is nobody's to catch.
        //
        // _constructed has been set at the end of the constructor all along and
        // never read: this is the guard it was meant to power. The collaborators
        // guard the same path (appletLifecycle's connectClockNotify,
        // eventsManager's start) — the applet itself was the one that did not.
        if (!this._constructed) {
            return;
        }

        // Cinnamon calls this from its own applet-loading loop, where a throw is
        // nobody's to catch — the same loop the _constructed guard above exists
        // to survive
        this._guarded(() => {
            this._onSettingsChanged();

            this._providerLifecycle.connectClockNotify(() => this._clockNotify());

            this._scheduleWeatherRefresh();

            /* Populates the calendar so our menu allocation is correct for animation */
            this.events_manager.start_events();
            this._resetCalendar();
        });
    }

    on_applet_removed_from_panel() {
        this._destroy();
    }

    // tears down whatever exists: a constructor failure leaves a partial
    // object, and each step must run even if an earlier one throws
    _destroy() {
        if (this._destroyed) {
            return;
        }
        this._destroyed = true;

        const steps = [
            // the keybinding is registered inside the constructor's try, so a
            // failure after that point used to leave a live global hotkey bound
            // to a destroyed applet — pressing it opened a menu that was gone
            () => Main.keybindingManager.removeHotKey("calendar-open-" + this.instance_id),
            () => this._providerLifecycle && this._providerLifecycle.destroy(),
            // the menu builder connects five signals on the events manager and
            // the event list, and nothing used to disconnect them
            () => this._menuBuilder && this._menuBuilder.destroy(),
            () => this._calendar && this._calendar.destroy(),
            () => this.event_list && this.event_list.destroy(),
            // the popup menu is parented to Main.uiGroup, not to the applet
            // actor, so nothing else ever destroys it: without this the whole
            // 42-cell grid, its tooltips and the event rows are stranded on
            // every reload, and they keep the providers alive through their
            // closures
            () => this.menu && this.menuManager && this.menuManager.removeMenu(this.menu),
            () => this.menu && this.menu.destroy(),
            () => this.settings && this.settings.finalize(),
            // the locale query's deadline and its retry are module-level timers
            // with no other owner: without this the retry can still spawn
            // `locale` two minutes after the applet is gone
            () => Utils.cancelPendingLocaleQueries()
        ];

        for (let step of steps) {
            try {
                step();
            } catch (e) {
                global.logError(e);
            }
        }
    }

    _initContextMenu () {
        this.menu = new Applet.AppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);

        // Whenever the menu is opened, select today
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._resetCalendar();
                this._updateClockAndDate(true);
                // The menu manager grabs key focus onto the menu actor as the
                // menu opens, and it is connected to this signal before we are,
                // so it has already run: moving focus down into the day grid
                // here is what puts the calendar's key handler on the event
                // path. Without it the arrows, PageUp/PageDown and Home only
                // ever worked after a mouse click on a cell.
                if (this._calendar) {
                    this._calendar.focusSelectedDay();
                }
            }
        });
    }

    _resetCalendar () {
        this._calendar.setDate(new Date(), true);
    }

    on_orientation_changed (orientation) {
        this._guarded(() => {
            this.orientation = orientation;
            this.menu.setOrientation(orientation);
            this._onSettingsChanged();
        });
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new CinnamonCalendarApplet(orientation, panel_height, instance_id);
}

if (typeof module !== "undefined") {
    module.exports = { CinnamonCalendarApplet, AppletSettingsBinder, AppletProviderLifecycle, AppletMenuBuilder, AppletPanelStatusPresenter, main };
}
