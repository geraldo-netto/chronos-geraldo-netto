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

const Applet = imports.ui.applet;
const Gio = imports.gi.Gio;
const Util = imports.misc.util;
const PopupMenu = imports.ui.popupMenu;
const AppletLifecycle = require("./appletLifecycle");
const AppletCoordinators = require("./appletCoordinators");
const SettingsFacade = require("./settingsFacade");
const AppletModules = imports.ui.appletManager.applets["chronos@geraldo-netto"];
const LocaleQuery = AppletModules.localeQuery;
const LocaleText = AppletModules.localeText;
const AppletPanelStatus = require("./appletPanelStatus");
const PanelFont = require("./panelFont");
const AppletMenu = require("./appletMenuBuilder");
const AppletTeardown = require("./appletTeardown");
const Main = imports.ui.main;
const AppletSettingsBinder = AppletLifecycle.AppletSettingsBinder;
const AppletProviderLifecycle = AppletLifecycle.AppletProviderLifecycle;
const AppletPanelStatusPresenter = AppletPanelStatus.AppletPanelStatusPresenter;
const PanelView = AppletPanelStatus.PanelView;
const AppletMenuBuilder = AppletMenu.AppletMenuBuilder;
const runTeardownSteps = AppletTeardown.runTeardownSteps;
const AppletWeatherCoordinator = AppletCoordinators.AppletWeatherCoordinator;
const AppletEventListCoordinator = AppletCoordinators.AppletEventListCoordinator;
const _ = LocaleText.translate;
const RUNTIME_ERROR_TEXT =
    _("Calendar applet encountered an error. Check the system log.");
const UPDATE_RESTART_TEXT =
    _("Chronos was updated. Restart Cinnamon to finish the update.");

function destroyIfPresent(collaborator) {
    if (collaborator) {
        collaborator.destroy();
    }
}

function finalizeIfPresent(settings) {
    if (settings) {
        settings.finalize();
    }
}

function removeOwnedMenu(applet) {
    if (applet.menu && applet.menuManager) {
        applet.menuManager.removeMenu(applet.menu);
    }
}

// Explicit adapter from the Cinnamon applet to the panel presenter's port. The
// presenter and the view receive this object and never the applet itself, so
// they name no Cinnamon type and no field of this class.
//
// The applet's private shape is not hidden here, though — it is *concentrated*
// here. Every accessor below reads the applet's own fields (`_panel_hovered`,
// `_weatherCoordinator`, `_worldclocks`, `_issueReporter`, `_day`, `_date`,
// `_calendar`), which is the point of a composition root: one file knows those
// names, and everything downstream is testable without one. The cost is that a
// rename here is silent — `applet._worldclocks` becoming undefined is falsy all
// the way down rather than an error — so this function is the place to check
// when a field is renamed.
function createPanelPort(applet) {
    return {
        showWeather: () => applet.show_weather,
        worldclocksEnabled: () => applet.show_worldclocks !== false,
        customFormat: () => applet.custom_format,
        customTooltipFormat: () => applet.custom_tooltip_format,
        panelHovered: () => applet._panel_hovered,
        menuOpen: () => applet.menu.isOpen,
        desktopSettings: () => applet.desktop_settings,
        weatherReading: () => applet._weatherCoordinator.reading,
        weatherPending: () => applet._weatherCoordinator.pending,
        weatherUnits: () => applet.weather_units,
        weatherError: () => applet._weatherCoordinator.error,
        weatherProvider: () => applet._weatherCoordinator.providerName,
        cityWeatherReading: (city) => applet._weatherCoordinator.cityReading(city),
        cityWeatherStale: (city) => applet._weatherCoordinator.cityStale(city),
        cityWeatherError: (city) => applet._weatherCoordinator.cityError(city),
        cityWeatherProviderName: (city) => applet._weatherCoordinator.cityProviderName(city),
        formattedClock: () => applet.clock.get_clock(),
        formatClock: (format) => applet.clock.get_clock_for_format(format),
        setClockFormatString: (format) => applet.clock.set_format_string(format),
        setLabel: (text) => applet.set_applet_label(text),
        setTooltip: (text) => applet.set_applet_tooltip(text),
        actor: () => applet.actor,
        dayLabel: () => applet._day,
        dateLabel: () => applet._date,
        setWorldclockFormat: (format) => applet._worldclocks.setFormat(format),
        setWorldclocksVisible: (visible) => applet._worldclocks.setVisible(visible),
        updateWorldclocks: (entries) => applet._worldclocks.updateClocks(entries),
        setWeatherSource: (source) => applet._worldclocks.setWeatherSource(source),
        setWeatherStatus: (text) => applet._issueReporter.set("panel", text),
        getClockEntries: () => applet._worldclocks.getClockEntries(),
        todaySelected: () => applet._calendar.todaySelected(),
        homeButton: () => applet.go_home_button,
        focusSelectedDay: () => applet._calendar && applet._calendar.focusSelectedDay && // NOSONAR [S6582] -- accepted compatible form
            applet._calendar.focusSelectedDay()
    };
}

class CinnamonCalendarApplet extends Applet.TextApplet {
    constructor(orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        try {
            // The locale query is process-wide and shared with every other
            // instance of this applet on the panel; the count is what stops this
            // instance's teardown from cancelling their query. Claimed before
            // anything below can throw, because the catch tears down.
            LocaleQuery.registerLocaleConsumer();
            // Per-instance proof that this applet holds one of those counts, so
            // a teardown that runs without a matching register — a constructor
            // that threw before this line, a second _destroy() — releases
            // nothing. Same convention as the weather and worldclock consumers
            // in appletLifecycle.js.
            this._localeConsumerRegistered = true;

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

            // After the label exists, and before the first clock is written:
            // a scale applied only on change would leave a restarted session
            // at the theme's size until the user touched the setting again.
            this._applyPanelFontScale();

            this._providerLifecycle.bindSystemSignals();

            this.worldclock_settings.connectChanged(this._onWorldclocksChanged.bind(this));

            // the rows exist because of the clock list, and are rebuilt only
            // when it changes; the format only decides what they say
            this._worldclocks.buildClocks(this.worldclock_settings.clocks);
            this._updateFormatString();
            this._applied_format_signature = this._formatSignature();

            this._constructed = true;
        }
        catch (e) {
            global.logError(e);
            // a partial build still holds a WallClock handler, weather timers,
            // the EDS bus watch and DBus proxy signals; leaving them behind
            // leaks them for the whole session
            this._destroy();
        }
    }

    _initProviders() {
        this._panel_hovered = false;

        this._providerLifecycle = new AppletProviderLifecycle({
            actor: this.actor,
            desktopSettings: this.desktop_settings,
            eventsSettings: this.events_settings,
            holidaySettings: this.holiday_settings,
            onPanelHover: (hovered) => {
                this._guarded("panel-hover", () => {
                    this._panel_hovered = hovered;
                    if (hovered) {
                        this._updateClockAndDate();
                    }
                });
            },
            onEventsManagerReady: () => this._events_manager_ready(),
            onHasCalendarsChanged: () => this._has_calendars_changed(),
            onHolidayPlaceChanged: () => this._guarded("holiday-place", () => {
                if (this._calendar) {
                    this._calendar.refreshHolidays();
                }
            }),
            onHolidayCountryUnresolved: () => this._inferHolidayCountry(),
            onUpgradeRequired: () => {
                this._pendingProviderIssue = UPDATE_RESTART_TEXT;
            },
            onSettingsChanged: () => this._onSettingsChanged(),
            onResume: () => this._onResume(),
            onNetworkRestored: () => this._onNetworkRestored(),
            onTimezoneChanged: () => this._onTimezoneChanged(),
            onDayChanged: () => this._guarded(
                "day-rollover", () => this._onDayChanged()),
            onTextScaleChanged: () => this._guarded(
                "text-scale", () => this._reflowMenu()),
            layoutManager: Main.layoutManager,
            onMonitorsChanged: () => this._guarded(
                "monitors-changed", () => this._reflowMenu())
        });

        const providers = this._providerLifecycle.initProviders();
        this.clock = providers.clock;
        this._weatherProvider = providers.weatherProvider;
        this._cityWeatherProvider = providers.cityWeatherProvider;
        this.events_manager = providers.eventsManager;
        this.holiday_provider = providers.holidayProvider;

        this._weatherCoordinator = new AppletWeatherCoordinator({
            weatherProvider: this._weatherProvider,
            cityWeatherProvider: this._cityWeatherProvider,
            settings: () => ({
                showWeather: this.show_weather,
                showWorldclocks: this.show_worldclocks,
                location: this.weather_location,
                units: this.weather_units
            }),
            worldclocks: () => this.worldclock_settings.clocks,
            onChanged: () => this._guarded(
                "weather-view", () => this._updateClockAndDate()),
            guard: (source, fn) => this._guarded(source, fn)
        });
        this._eventListCoordinator = new AppletEventListCoordinator({
            manager: this.events_manager,
            eventList: () => this.event_list,
            selectedDate: () => this._calendar.getSelectedDate(),
            guard: (source, fn) => this._guarded(source, fn),
            // Event availability gates the day-cell dots, and no manager
            // signal recomputes it when the setting flips.
            onEnabledChanged: () => this._calendar.refreshEventDataAvailability()
        });
    }

    _buildUi() {
        this._menuBuilder = new AppletMenuBuilder({
            menu: this.menu,
            contextMenu: this._applet_context_menu,
            desktopSettings: this.desktop_settings,
            calendarSettings: this.calendar_settings,
            eventsManager: this.events_manager,
            holidayProvider: this.holiday_provider,
            onGoHome: () => this._guarded(
                "go-home", () => this._resetCalendar()),
            onSelectedDateChanged: () => this._guarded(
                "selected-date", () => this._updateClockAndDate(true)),
            onLaunchSettings: () => this._onLaunchSettings()
        });

        const ui = this._menuBuilder.build();
        this.event_list = ui.eventList;
        this._calendar = ui.calendar;
        this._worldclocks = ui.worldclocks;
        this._astronomy = ui.astronomy;
        this._issueReporter = ui.issueReporter;
        if (this._pendingProviderIssue) {
            this._issueReporter.set("update", this._pendingProviderIssue);
        }
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
            onShowEventsChanged: this._onShowEventsChanged.bind(this),
            onPanelFormatChanged: this._onPanelFormatChanged.bind(this),
            onTooltipFormatChanged: this._onTooltipFormatChanged.bind(this),
            onPanelFontScaleChanged: this._onPanelFontScaleChanged.bind(this),
            onShowWorldclocksChanged: this._onShowWorldclocksChanged.bind(this),
            onShowAstronomyChanged: this._onShowAstronomyChanged.bind(this),
            onWeatherSettingsChanged: this._onWeatherSettingsChanged.bind(this),
            onWeatherUnitsChanged: this._onWeatherUnitsChanged.bind(this),
            onKeybindingChanged: () => this._guarded(
                "keybinding-settings", () => this._setKeybinding())
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
        const tooltip = this._applet_tooltip && this._applet_tooltip._tooltip; // NOSONAR [S6582] -- accepted compatible form
        if (tooltip && tooltip.add_style_class_name) { // NOSONAR [S6582] -- accepted compatible form
            tooltip.add_style_class_name("calendar-tooltip");
        }
    }

    // Everything below that a signal can reach runs through this. The callers are
    // GLib, GObject and Cinnamon's settings — none of them is a JS frame, so a
    // throw out of one of these handlers unwinds into the compositor, where it is
    // nobody's to catch: the applet stops updating and stays that way until
    // Cinnamon restarts. The construction and teardown paths have been guarded
    // like this all along; the paths that run once a second were not.
    _guarded(source, fn) {
        const issueSource = "runtime:" + source;
        try {
            const result = fn();
            if (this._issueReporter) {
                this._issueReporter.set(issueSource, "");
            }
            return result;
        } catch (e) {
            global.logError(e);
            if (this._issueReporter) {
                this._issueReporter.set(issueSource, RUNTIME_ERROR_TEXT);
            }
            return undefined;
        }
    }

    // settings emit (emitter, key, oldValue, newValue)
    _onWorldclocksChanged() {
        this._guarded("worldclocks-settings", () => this._reconcileWorldclocks());
    }

    // Runs at add-to-panel and again whenever the country key returns to the
    // schema's empty sentinel. deferInitialHolidayCountry only ever fills that
    // sentinel and guards its own idle, so calling it twice costs nothing and a
    // user choice made in between still wins.
    _inferHolidayCountry() {
        this._settingsBinder.deferInitialHolidayCountry(() =>
            this._guarded("holiday-country-inference",
                () => this._providerLifecycle.onHolidayPlaceChanged()));
    }

    _onTimezoneChanged() {
        this._guarded("timezone", () => {
            this._reconcileWorldclocks();
            this._reconcileCalendarTimezone();
            this._reconcileAstronomyTimezone();
        });
    }

    // The sunrise and sunset rows fall back to this machine's zone whenever the
    // resolved place carries none of its own, and that fallback is memoised
    // against a zone that has just been replaced.
    _reconcileAstronomyTimezone() {
        if (!this._astronomy) {
            return;
        }
        this._astronomy.refreshTimezone();
        this._updateAstronomy();
    }

    // The grid matches event dots by absolute day keys, and both sides of that
    // match were derived from the zone that has just been replaced: the cached
    // month window on the calendar side, every indexed bucket on the events
    // side. Neither notices on its own — the window's cache key and the
    // displayed month are both unchanged — so they are reset together.
    _reconcileCalendarTimezone() {
        this.events_manager.refresh_for_timezone_change();
        if (this._calendar) {
            this._calendar.refreshTimezone();
        }
    }

    // The saved list does not change when the OS timezone does, but its
    // effective projection does: a configured row can become the built-in local
    // row, or stop colliding with it. Rebuild both consumers from the same list.
    _reconcileWorldclocks() {
        this._worldclocks.buildClocks(this.worldclock_settings.clocks);
        this._updateClockAndDate(true);
        this._scheduleCityWeatherRefresh();
    }

    _setKeybinding() {
        Main.keybindingManager.addXletHotKey(
            this,
            "calendar-open",
            this.keyOpen,
            () => this._guarded("keybinding-open", () => this._openMenu()));
    }

    // the hottest path in the applet: WallClock's notify::clock
    _clockNotify() {
        this._guarded("clock", () => this._updateClockAndDate());
    }

    // A suspend does not advance CLOCK_MONOTONIC, which is what GLib's timers
    // ride, so on wake the armed refresh still thinks it has most of its period
    // left. Both readouts are re-read at once, and the city half is forced past
    // its "nothing changed" guard — the settings have not changed, but the world
    // has.
    _onResume() {
        this._guarded("resume", () => {
            this._updateClockAndDate();
            this._scheduleWeatherRefresh({ force: true });
        });
    }

    // The network came back: the offline short-circuit reported instantly and
    // armed no retry, so this flip is the retry it deferred. Forced, because
    // the settings have not changed — the world has, like a resume.
    _onNetworkRestored() {
        this._guarded("network-restored", () => {
            this._scheduleWeatherRefresh({ force: true });
        });
    }

    _onDayChanged() {
        this._calendar.refreshToday();
        this._updateClockAndDate(true);
    }

    on_applet_clicked() {
        this._guarded("applet-click", () => this._openMenu());
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
            this.custom_format,
            this.show_worldclocks,
            this.desktop_settings.use24h,
            this.desktop_settings.showSeconds
        ].join("|");
    }

    _onSettingsChanged() {
        this._guarded("settings", () => this._applySettings());
    }

    _applyFormatSettings() {
        const formatSignature = this._formatSignature();
        if (formatSignature !== this._applied_format_signature) {
            this._applied_format_signature = formatSignature;
            this._updateFormatString();
        }
    }

    _applySettings() {
        this._applyPanelFormat();
        this._eventListCoordinator.apply(this.show_events);
    }

    _applyPanelFormat() {
        this._applyFormatSettings();
        this._updateClockAndDate();
    }

    _onShowEventsChanged() {
        this._guarded("events-settings", () =>
            this._eventListCoordinator.apply(this.show_events));
    }

    _onPanelFormatChanged() {
        this._guarded("panel-format-settings", () => this._applyPanelFormat());
    }

    _onTooltipFormatChanged() {
        this._guarded("tooltip-format-settings", () => this._updateClockAndDate());
    }

    // Opt-in, and off by default: panel text size is a desktop-wide
    // typographic decision that the theme and the user's font settings own, so
    // the applet only departs from it when asked. At 1.0 the inline style is
    // cleared rather than set to 1em, leaving the theme in charge of a
    // property nobody here has an opinion about.
    _onPanelFontScaleChanged() {
        this._guarded("panel-font-scale-settings", () => this._applyPanelFontScale());
    }

    _applyPanelFontScale() {
        const label = this._applet_label;
        if (!label || typeof label.set_style !== "function") {
            return false;
        }
        const scale = PanelFont.panelFontStyle(this.panel_font_scale);
        label.set_style(scale);
        return true;
    }

    _onShowWorldclocksChanged() {
        this._guarded("worldclocks-visibility-settings", () => {
            this._applyPanelFormat();
            this._weatherCoordinator.applyShowWorldclocks();
        });
    }

    _onShowAstronomyChanged() {
        this._guarded("astronomy-visibility-settings", () => this._updateAstronomy());
    }

    _onWeatherSettingsChanged() {
        this._guarded("weather-settings", () => {
            this._updateClockAndDate();
            this._queueWeatherRefresh();
        });
    }

    _onWeatherUnitsChanged() {
        this._guarded("weather-units-settings", () => this._updateClockAndDate());
    }

    on_custom_format_button_pressed() {
        this._guarded("format-help", () => {
            Util.spawnCommandLine(
                "xdg-open https://cinnamon-spices.linuxmint.com/strftime.php");
        });
    }

    on_openstreetmap_attribution_pressed() {
        this._guarded("weather-attribution", () => {
            Util.spawnCommandLine("xdg-open https://www.openstreetmap.org/copyright");
        });
    }

    openAbout() {
        this._guarded("about", () => {
            const process = new Gio.Subprocess({
                argv: ["python3", this._meta.path + "/settings_about.py"],
                flags: Gio.SubprocessFlags.NONE
            });
            process.init(null);
        });
    }

    _onLaunchSettings() {
        this._guarded("date-settings", () => {
            this.menu.close();
            Util.spawnCommandLine("cinnamon-settings calendar");
        });
    }

    _panelStatus() {
        if (!this._panelStatusPresenter) {
            this._panelStatusPresenter = new AppletPanelStatusPresenter(
                new PanelView(createPanelPort(this)));
        }
        return this._panelStatusPresenter;
    }

    _updateFormatString() {
        this._panelStatus().updateFormatString();
    }

    _scheduleWeatherRefresh({ force = false } = {}) {
        this._weatherCoordinator.schedule({ force });
    }

    _queueWeatherRefresh() {
        this._weatherCoordinator.queue();
    }

    // the tooltip prints a temperature next to every world clock, so the
    // cities are read as a set; a clock the user just added is one more place
    // to resolve, not a reason to re-read the panel location
    _scheduleCityWeatherRefresh(force = false) {
        this._weatherCoordinator.scheduleCities(force);
    }

    // both are EventsManager signals, raised from a DBus callback
    _events_manager_ready() {
        this._eventListCoordinator.ready(() => this.show_events);
    }

    _has_calendars_changed() {
        this._eventListCoordinator.calendarsChanged(() => this.show_events);
    }

    _updateClockAndDate(forceMenuUpdate = false) {
        this._updateAstronomy(forceMenuUpdate);
        // The panel presenter reports whether it drew the menu; the event
        // column follows that, from here, rather than from inside it.
        if (this._panelStatus().updateClockAndDate(forceMenuUpdate)) {
            this._eventListCoordinator.tick();
        }
    }

    _updateAstronomy(forceMenuUpdate = false) {
        if (!this._astronomy || (!forceMenuUpdate && !this.menu.isOpen)) {
            return;
        }
        this._astronomy.update({
            visible: this.show_weather && this.show_astronomy,
            place: this._weatherCoordinator.currentPlace(),
            use24h: this.desktop_settings.use24h
        });
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
        this._guarded("added-to-panel", () => {
            this._onSettingsChanged();
            this._inferHolidayCountry();

            this._providerLifecycle.connectClockNotify(() => this._clockNotify());
            this._providerLifecycle.startDayRollover();

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
            () => Main.keybindingManager.removeXletHotKey(this, "calendar-open"),
            // Before the collaborators, not after them. Every settings handler
            // this applet owns ends in a live object — `_onWorldclocksChanged`
            // reaches `this._worldclocks.buildClocks`, which attaches actors —
            // and finalize() is what disconnects them. Finalizing last meant
            // the handlers stayed connected across the destruction of the menu
            // builder, the menu and the provider lifecycle, so a `changed::`
            // arriving in that window ran against torn-down objects. Nothing in
            // the list below spins the main loop today, so it was unreachable
            // rather than safe; the ordering makes it unreachable by
            // construction. The binder holds no settings state of its own
            // (destroy() drops one idle), so it is unaffected by going second.
            () => finalizeIfPresent(this.settings),
            () => destroyIfPresent(this._settingsBinder),
            // The menu builder connects five signals on the events manager and
            // the event list, and it constructed the calendar and the event
            // list — so it detaches every consumer before its producer and
            // destroys both, in that order, from inside this one step. The
            // applet used to destroy them here instead, which reached them
            // only when build() returned: a throw partway through it left
            // both alive, wired, and holding timers for the whole session.
            () => destroyIfPresent(this._menuBuilder),
            // the popup menu is parented to Main.uiGroup, not to the applet
            // actor, so nothing else ever destroys it: without this the whole
            // 42-cell grid, its tooltips and the event rows are stranded on
            // every reload, and they keep the providers alive through their
            // closures
            () => removeOwnedMenu(this),
            () => destroyIfPresent(this.menu),
            () => destroyIfPresent(this._providerLifecycle),
            // the locale query's deadline and its retry are module-level timers
            // with no other owner: without this the retry can still spawn
            // `locale` two minutes after the applet is gone
            () => this._releaseLocaleConsumer()
        ];

        runTeardownSteps(steps);
    }

    // Give back exactly the one consumer count this instance took, and only if
    // it took one.
    _releaseLocaleConsumer() {
        if (this._localeConsumerRegistered) {
            this._localeConsumerRegistered = false;
            LocaleQuery.cancelPendingLocaleQueries();
        }
    }

    // The one place that reads the desktop's own geometry. Everything the
    // layout rule needs and nothing it does not: the work area of the monitor
    // this applet sits on, the theme's scale factor, and the accessibility text
    // factor. Each is optional, because a monitor can be mid-hotplug and an
    // older Cinnamon need not carry every accessor.
    _menuLayoutEnvironment() {
        const area = this._menuWorkArea(Main.layoutManager);
        return {
            workAreaWidth: area ? area.width : 0,
            workAreaHeight: area ? area.height : 0,
            uiScale: global.ui_scale,
            textScale: this.desktop_settings ? this.desktop_settings.textScale : 1
        };
    }

    // The work area, not the monitor: this applet's own panel is subtracted
    // from it, and so is the side panel a vertical layout puts against the
    // screen edge the popup has to clear.
    _menuWorkArea(layoutManager) {
        if (!layoutManager) {
            return null;
        }
        const monitor = this._menuLayoutMonitor(layoutManager);
        if (!monitor) {
            return null;
        }
        if (typeof layoutManager.getWorkAreaForMonitor === "function" &&
            Number.isInteger(monitor.index)) {
            return layoutManager.getWorkAreaForMonitor(monitor.index) || monitor;
        }
        return monitor;
    }

    _menuLayoutMonitor(layoutManager) {
        if (typeof layoutManager.findMonitorForActor === "function" && this.actor) {
            return layoutManager.findMonitorForActor(this.actor);
        }
        return layoutManager.primaryMonitor;
    }

    _reflowMenu() {
        if (!this._menuBuilder) {
            return null;
        }
        return this._menuBuilder.reflow(this._menuLayoutEnvironment());
    }

    _initContextMenu () {
        this.menu = new Applet.AppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);

        // Whenever the menu is opened, select today
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._guarded("menu-open", () => {
                    // A changed selection emits synchronously and that callback
                    // owns the full refresh. If today was already selected there
                    // is no signal, so menu-open owns the one refresh instead.
                    if (!this._resetCalendar()) {
                        this._updateClockAndDate(true);
                    }
                    // The menu manager grabs key focus onto the menu actor as the
                    // menu opens, and it is connected to this signal before we are,
                    // so it has already run: moving focus down into the day grid
                    // here is what puts the calendar's key handler on the event
                    // path. Without it the arrows, PageUp/PageDown and Home only
                    // ever worked after a mouse click on a cell.
                    // Before focus moves into the grid: the work area, the UI
                    // scale and the text size can all have changed since the
                    // last time this popup was on screen, and reflowing after
                    // focus would move the focused cell under the pointer.
                    this._reflowMenu();
                    if (this._calendar) {
                        this._calendar.focusSelectedDay();
                    }
                });
            }
        });
    }

    _resetCalendar () {
        return this._calendar.setDate(new Date(), true);
    }

    on_orientation_changed (orientation) {
        this._guarded("orientation", () => {
            this.orientation = orientation;
            this.menu.setOrientation(orientation);
            this._applyPanelFormat();
            // A side panel takes its width out of the same work area the popup
            // has to fit into, and a vertical panel puts the popup against a
            // screen edge the horizontal shape may no longer clear.
            this._reflowMenu();
        });
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new CinnamonCalendarApplet(orientation, panel_height, instance_id);
}

if (typeof module !== "undefined") {
    module.exports = { CinnamonCalendarApplet, AppletSettingsBinder, AppletProviderLifecycle,
        AppletMenuBuilder, AppletPanelStatusPresenter, createPanelPort, main };
}
