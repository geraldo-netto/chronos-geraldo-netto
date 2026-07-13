/* global imports */
/* eslint camelcase: "off" */

const St = imports.gi.St;
const Atk = imports.gi.Atk;
const Utils = require("./utils");
// the pure half of the weather module: the constants and the formatters. The
// panel presenter renders — it must not link the Soup session, the provider
// chains and the refresh scheduler that the weather.js barrel drags in.
const Weather = require("./weatherFormat");
const WorldclockData = require("./worldclockData");

const _ = Utils.translate;
const joinPhrases = Utils.joinPhrases;

const MSECS_IN_DAY = Utils.MSECS_IN_DAY;
// Eight world clocks plus a weather reading reached the old 80-character cap
// and squeezed every other applet off a 1366px panel. The panel is shared: the
// suffix is an extra, and the date and time are the point.
const LABEL_SUFFIX_MAX_LENGTH = 48;
// ...and the same argument bounds the whole label. Only the weather suffix was
// capped; the date and time come from the user's own custom-format string, which
// nothing limits. "%A, %-d %B %Y — %H:%M:%S %Z" renders about 40 characters, takes
// two-fifths of a 1366px panel and pushes the window list off it, with nothing to
// say the applet did it: the stylesheet sets no max-width and St does not
// ellipsize a panel label on its own.
const LABEL_MAX_LENGTH = 64;
// the ellipsis everything else in this applet uses, rather than three dots — it
// is the one clampText appends, and the tests read it from here
const LABEL_ELLIPSIS = Utils.TEXT_ELLIPSIS;
// the panel label follows the desktop's 12/24-hour setting, and the tooltip is
// the same applet's readout of the same clocks: a 12-hour user reading
// "2:52 PM" on the panel should not find "14:52" in its tooltip.
//
// The hour field is %-l throughout. Its padded sibling renders every hour before
// ten with a leading space, so a horizontal panel showed a double space before the
// time and the vertical layout's stacked hour sat visibly off centre. The
// world-clock rows escaped it only because worldclocks.js trims what it formats.
const TOOLTIP_CLOCK_FORMAT_24H = "%d %b %H:%M";
const TOOLTIP_CLOCK_FORMAT_12H = "%d %b %-l:%M %p";
// label, date and time, temperature, condition: only the numbers are right-aligned
const TOOLTIP_TEMPERATURE_COLUMN = 2;

// The derived (non-custom) clock formats, chosen by three independent booleans:
// panel orientation, 12/24-hour, and seconds. A table instead of a four-deep
// nest — the panel's main label depends on all three, the world-clock format on
// two. Flat lookup, so no logic to follow.
const PANEL_CLOCK_FORMATS = {
    vertical: {
        h24: { seconds: "%H%n%M%n%S", plain: "%H%n%M" },
        h12: { seconds: "%-l%n%M%n%S", plain: "%-l%n%M" }
    },
    horizontal: {
        h24: { seconds: "%d %b %H:%M:%S", plain: "%d %b %H:%M" },
        h12: { seconds: "%d %b %-l:%M:%S %p", plain: "%d %b %-l:%M %p" }
    }
};
const WORLD_CLOCK_FORMATS = {
    h24: { seconds: "%H:%M:%S (%a)", plain: "%H:%M (%a)" },
    h12: { seconds: "%-l:%M:%S (%a)", plain: "%-l:%M (%a)" }
};

const WEATHER_ERROR_TEXT = {
    [Weather.WEATHER_ERRORS.LOCATION_NOT_FOUND]: _("Location not found"),
    [Weather.WEATHER_ERRORS.SERVICE_UNAVAILABLE]: _("Weather service unavailable"),
    [Weather.WEATHER_ERRORS.NO_LOCATION]: _("Set a weather location")
};

function translateWeatherError(error) {
    return WEATHER_ERROR_TEXT[error] || error;
}

// the panel readout is a glyph and a temperature; these are the words for it
const WEATHER_CONDITION_TEXT = {
    Clear: _("Clear"),
    "Partly cloudy": _("Partly cloudy"),
    Cloudy: _("Cloudy"),
    Rain: _("Rain"),
    Snow: _("Snow"),
    Showers: _("Showers"),
    Thunderstorm: _("Thunderstorm"),
    Fair: _("Fair")
};

// The panel has room for a glyph and a temperature, and no more. A screen
// reader gets the emoji's codepoint name or nothing at all, so the spoken name
// spells the condition out. `condition` is the reading's condition glyph
// (record.condition); `pending` is the first-refresh placeholder state, whose
// ellipsis reads aloud as nothing at all.
function describeWeather(text, condition = "", pending = false) {
    if (pending) {
        return joinPhrases(text, _("Weather: loading…"));
    }

    const word = condition ? (Weather.WEATHER_CONDITIONS[condition] || "") : "";
    if (!word) {
        return text;
    }

    return joinPhrases(text, WEATHER_CONDITION_TEXT[word] || word);
}

// The result is handed to strftime, so every % in it is a directive. A
// translator who writes "100 % ungültig", or slips in a stray %d, would
// otherwise corrupt the panel label — and xgettext does not mark these strings
// c-format, so msgfmt would not catch it either. %% is strftime's literal
// percent, and the time beside the message follows the user's own clock rather
// than a hardcoded 12-hour one.
function badFormatFallback(view, message) {
    const use24h = view.desktopSettings && view.desktopSettings.use24h;

    return String(message).replace(/%/g, "%%") + " • " + (use24h ? "%H:%M" : "%-l:%M %p");
}

// Everything the presenter reads and writes, behind one seam.
//
// It was the writes only, and the presenter went on reading about fifteen applet
// privates straight through it — _weather_text, _weather_error, _panel_hovered,
// _worldclocks, _calendar, events_manager — and wrote one field around it
// (applet.worldclock_format). PanelView broke its own seam too, reaching for
// applet._calendar. So the applet's private shape was still the presenter's API:
// renaming any of those fields threw nothing, because `undefined` is falsy, and
// the panel suffix, the tooltip's temperature column, the accessible name and
// the "Source:" credit would all just silently go blank.
//
// The reads are here now. AppletMenuBuilder and AppletProviderLifecycle take a
// context and hand their products back; this is the same idea for the panel.
class PanelView {
    constructor(applet) {
        this.applet = applet;
    }

    // --- what the panel is being asked to show -----------------------------

    get orientation() {
        return this.applet.orientation;
    }

    get showWeather() {
        return this.applet.show_weather;
    }

    // the one setting that decides whether the popup grid, the panel suffix, the
    // tooltip rows and the per-city weather exist at all
    get worldclocksEnabled() {
        return this.applet.show_worldclocks !== false;
    }

    get useCustomFormat() {
        return this.applet.use_custom_format;
    }

    get customFormat() {
        return this.applet.custom_format;
    }

    get customTooltipFormat() {
        return this.applet.custom_tooltip_format;
    }

    get panelHovered() {
        return this.applet._panel_hovered;
    }

    get menuOpen() {
        return this.applet.menu.isOpen;
    }

    get desktopSettings() {
        return this.applet.desktop_settings;
    }

    // --- the weather readings ----------------------------------------------

    // the unit-free reading record everything on the panel and in the tooltip is
    // rendered from: this side of the applet is the only one that knows the units
    get weatherReading() {
        return this.applet._weather_reading;
    }

    // the first refresh has not landed yet. It used to be told by comparing the
    // stored text against the "…" placeholder, which made a display string load
    // bearing: a provider that rendered its own ellipsis would have been read as
    // a pending fetch.
    get weatherPending() {
        return this.applet._weather_pending;
    }

    // the record is Celsius; the panel and tooltip render its temperature in the
    // unit the user asked for, so the render needs to know which
    get weatherUnits() {
        return Weather.normalizeUnits(this.applet.weather_units);
    }

    get weatherError() {
        return this.applet._weather_error;
    }

    get weatherProvider() {
        return this.applet._weather_provider;
    }

    cityWeatherReading(city) {
        return this.applet.cityWeatherReading ? this.applet.cityWeatherReading(city) : null;
    }

    cityWeatherStale(city) {
        return Boolean(this.applet.cityWeatherStale && this.applet.cityWeatherStale(city));
    }

    cityWeatherProviderName() {
        return this.applet.cityWeatherProviderName ? this.applet.cityWeatherProviderName() : "";
    }

    // --- the clock, and the actors it writes to -----------------------------

    formattedClock() {
        return this.applet.clock.get_clock();
    }

    formatClock(format) {
        return this.applet.clock.get_clock_for_format(format);
    }

    setClockFormatString(format) {
        return this.applet.clock.set_format_string(format);
    }

    setLabel(text) {
        this.applet.set_applet_label(text);
    }

    setTooltip(text) {
        this.applet.set_applet_tooltip(text);
    }

    setAccessibleName(name) {
        const actor = this.applet.actor;
        if (!actor || !actor.set_accessible_name) {
            return;
        }

        actor.set_accessible_name(name);

        // The home button and the date heading were both given a PUSH_BUTTON role
        // in the accessibility pass; the panel button itself was missed. Orca read
        // out the date, the time and the weather with a filler role and never said
        // the thing was activatable — and clicking it is how the menu opens.
        if (Atk.Role && actor.accessible_role !== Atk.Role.PUSH_BUTTON) {
            actor.accessible_role = Atk.Role.PUSH_BUTTON;
        }
    }

    get dayLabel() {
        return this.applet._day;
    }

    get dateLabel() {
        return this.applet._date;
    }

    // the world-clock rows: the format they render in, whether they are shown at
    // all, and what they say. The presenter used to set applet.worldclock_format
    // directly — a write straight past the seam it writes everything else
    // through.
    setWorldclockFormat(format) {
        this.applet.worldclock_format = format;
        this.applet._worldclocks.setFormat(format);
    }

    setWorldclocksVisible(visible) {
        this.applet._worldclocks.setVisible(visible);
    }

    updateWorldclocks(entries) {
        this.applet._worldclocks.updateClocks(entries);
    }

    setWeatherSource(source) {
        this.applet._worldclocks.setWeatherSource(source);
    }

    getClockEntries(limit, includeBuiltin) {
        return this.applet._worldclocks.getClockEntries(
            limit === null ? undefined : limit, includeBuiltin);
    }

    // --- the menu's own collaborators --------------------------------------

    todaySelected() {
        return this.applet._calendar.todaySelected();
    }

    selectEventsDate() {
        this.applet.events_manager.select_date(this.applet._calendar.getSelectedDate());
    }

    // today is already selected: there is nowhere to go, and a button that only
    // *looks* disabled still takes focus and still fires on Enter
    setHomeEnabled(enabled) {
        const button = this.applet.go_home_button;

        // Clearing can_focus on the actor that currently holds the key focus
        // makes St drop the stage focus to null, and the menu manager closes
        // the menu the moment focus leaves it. Pressing Enter on "Go to today"
        // therefore selected today and slammed the popup shut. Hand the focus
        // to the day the button just jumped to before taking the button's away.
        if (!enabled && button.can_focus && this._hasKeyFocus(button)) {
            const calendar = this.applet._calendar;
            if (calendar && calendar.focusSelectedDay) {
                calendar.focusSelectedDay();
            }
        }

        button.reactive = enabled;
        button.can_focus = enabled;
        button.set_style_class_name(enabled ?
            "calendar-today-home-button-enabled" : "calendar-today-home-button");
    }

    _hasKeyFocus(actor) {
        const stage = typeof global !== "undefined" ? global.stage : null;
        return Boolean(stage && stage.get_key_focus && stage.get_key_focus() === actor);
    }
}

class AppletPanelStatusPresenter {
    // the applet is only here to build the default view: the presenter itself
    // does not hold it, and reads and writes nothing but the seam
    constructor(applet, view = new PanelView(applet)) {
        this.view = view;
        this._todayFormatCache = null;
    }

    updateFormatString() {
        const view = this.view;
        let world_string = view.customFormat;
        let main_string = view.customFormat;

        if (view.useCustomFormat) {
            if (!view.setClockFormatString(world_string)) {
                global.logError("Calendar applet: bad time format string - check your string.");
                world_string = main_string = badFormatFallback(view, _("Invalid time format; edit it in Settings"));
            }
        } else {
            // a horizontal panel gets the compact local readout — day, short
            // month, time; the weekday, year and other zones live in the
            // tooltip and the popup, so the panel stays narrow
            const vertical = view.orientation === St.Side.LEFT || view.orientation === St.Side.RIGHT;
            const hour = view.desktopSettings.use24h ? "h24" : "h12";
            const slot = view.desktopSettings.showSeconds ? "seconds" : "plain";
            main_string = PANEL_CLOCK_FORMATS[vertical ? "vertical" : "horizontal"][hour][slot];
            world_string = WORLD_CLOCK_FORMATS[hour][slot];
        }

        view.setClockFormatString(main_string);
        // the format changes what the rows say, not which rows exist: rebuilding
        // the actors here meant every keystroke in the custom-format entry tore
        // the whole clock grid down and built it again
        view.setWorldclockFormat(world_string);
        view.setWorldclocksVisible(this.worldclocksEnabled());
    }

    // the condition glyph in words, translated where a word exists — the tooltip
    // cell and the accessible name both say the sky this way
    _conditionWords(condition) {
        const word = condition ? (Weather.WEATHER_CONDITIONS[condition] || "") : "";
        return word ? (WEATHER_CONDITION_TEXT[word] || word) : "";
    }

    // the panel carries the temperature, not the sky: the glyph is a picture of
    // what the tooltip and the accessible name already say in words. The record
    // is Celsius; the panel renders it in the user's unit.
    panelReadingText() {
        const view = this.view;
        // the first refresh has not landed: the placeholder is the panel's, and
        // it is the one weather state the record cannot carry
        if (view.weatherPending) {
            return Weather.WEATHER_PENDING_TEXT;
        }

        const record = view.weatherReading;
        return record ? Weather.formatTemperature(record.temperatureC, view.weatherUnits) : "";
    }

    // The one thing show_worldclocks used to do was hide the popup grid. The
    // panel label, the tooltip and the per-city weather all ignored it: with
    // the clocks switched off and weather on, the applet still built a
    // GLib.DateTime per clock every second, still appended the clocks to the
    // panel label and the tooltip, and still made 8 cities × 1 forecast every
    // 30 minutes — sixteen HTTP round-trips an hour for a feature that is off.
    worldclocksEnabled() {
        return this.view.worldclocksEnabled;
    }

    // World clocks never reach the panel. They are a table — a label and a time
    // per city — and the panel is a single line that the date and the weather
    // already share; a clock appended to it is the first thing the panel drops
    // when it runs out of room. They are shown in full where there is room to
    // show them: the tooltip and the popup.
    buildLabelSuffix() {
        const view = this.view;
        if (view.orientation === St.Side.LEFT || view.orientation === St.Side.RIGHT) {
            return "";
        }

        let parts = [];

        if (view.showWeather) {
            const reading = this.panelReadingText();
            if (view.weatherError) {
                // the failure marker stays: it is the only sign on the panel
                // that the reading may be stale
                parts.push(reading ?
                    Weather.WEATHER_ERROR_MARKER + " " + reading :
                    Weather.WEATHER_ERROR_MARKER);
            } else if (reading) {
                parts.push(reading);
            }
        }

        return parts.join(" • ");
    }

    ellipsizeLabelSuffix(suffix) {
        return Utils.clampText(suffix, LABEL_SUFFIX_MAX_LENGTH);
    }

    tooltipClockFormat() {
        const use24h = this.view.desktopSettings && this.view.desktopSettings.use24h;

        return use24h ? TOOLTIP_CLOCK_FORMAT_24H : TOOLTIP_CLOCK_FORMAT_12H;
    }

    // the stamp the tooltip actually shows: the no-seconds tooltip format, not
    // entry.time (which carries seconds when clock-show-seconds is on). The
    // change-detection key must read this same value or it recomputes the whole
    // tooltip every second for a string that never changes.
    tooltipClockStamp(entry) {
        const stamp = entry.localTime && entry.localTime.format ?
            entry.localTime.format(this.tooltipClockFormat()) : entry.time;
        return stamp || entry.time;
    }

    // the panel shows one time and one temperature; the tooltip is where the
    // rest of the world fits, one row per clock: label, date and time,
    // temperature, condition
    tooltipClockRow(entry) {
        const cells = [entry.label, this.tooltipClockStamp(entry)];

        if (!this.view.showWeather) {
            return cells;
        }

        return cells.concat(this.tooltipWeatherCells(entry));
    }

    // a temperature cell and a condition cell, rendered from the reading record.
    // The tooltip has room for words, so it takes the temperature and the sky in
    // text and leaves the glyph to the panel. The error, if any, replaces the
    // condition words: the marker says the reading may be old, not gone.
    _readingCells(record, error) {
        return [
            Weather.formatTemperature(record.temperatureC, this.view.weatherUnits),
            error || this._conditionWords(record.condition)
        ];
    }

    // the local row takes the panel reading; UTC is a scale, not a place, and
    // shows no weather. A failed refresh keeps the last good reading, as the
    // panel does — the marker says it may be old, not gone.
    _builtinWeatherCells(entry) {
        const view = this.view;
        if (entry.timezone === WorldclockData.UTC_TIMEZONE) {
            return ["", ""];
        }

        const error = view.weatherError ?
            Weather.WEATHER_ERROR_MARKER + " " + translateWeatherError(view.weatherError) : "";
        // the first refresh has not landed: an ellipsis in the temperature
        // column, with nothing beside it, says less than nothing
        if (view.weatherPending) {
            return ["", error || _("Weather: loading…")];
        }

        const record = view.weatherReading;
        return record ? this._readingCells(record, error) : ["", error];
    }

    // every non-built-in row takes its own city's reading record, which it keeps
    // when a refresh fails — without the marker a temperature from this morning
    // would read as the weather now. A city with no reading yet shows a blank
    // cell rather than a placeholder: unlike the panel, the city provider reserves
    // no slot, so there is no "loading" state to report.
    _cityWeatherCells(entry) {
        const view = this.view;
        // the reading is of the city the timezone names, which is also what was
        // geocoded; the label is the user's name for the row and two rows may
        // share one
        const city = WorldclockData.timezoneCityName(entry.timezone);

        // An offset-only zone (Etc/GMT+3) names no city, so there is nothing to
        // forecast and there never will be. Blank cells said exactly what a fetch
        // still in flight and a fetch that failed said, so the row looked broken
        // rather than inapplicable.
        if (!city) {
            return ["", _("No weather for this timezone")];
        }

        const record = view.cityWeatherReading(city);
        if (!record) {
            return ["", ""];
        }

        let error = "";
        if (view.cityWeatherStale(city)) {
            // one msgid: the marker is a glyph the phrase is built around, and a
            // translator has to be able to put it where it belongs
            error = _("%s Last known reading").replace("%s", Weather.WEATHER_ERROR_MARKER);
        }

        return this._readingCells(record, error);
    }

    tooltipWeatherCells(entry) {
        return entry.builtin ? this._builtinWeatherCells(entry) : this._cityWeatherCells(entry);
    }

    // The tooltip is rebuilt on every tick while the panel is hovered — once a
    // minute normally, 1 Hz with clock-show-seconds on — and alignTooltipRows
    // makes two passes over every cell with Array.from()
    // plus a " ".repeat() each, which is some eighty allocations for ten clocks.
    // The tooltip format carries no seconds, so 59 of every 60 rebuilds produced
    // byte-identical text and were thrown away by set_applet_tooltip's own
    // equality check. The key says whether anything it is built from has changed.
    _tooltipKey(dateFormattedTooltip, clockEntries) {
        const view = this.view;

        return [
            dateFormattedTooltip,
            view.showWeather ? this.panelReadingText() : "",
            view.showWeather ? view.weatherError : "",
            clockEntries.map((entry) => [
                entry.label,
                this.tooltipClockStamp(entry),
                entry.builtin ? "b" : "",
                view.showWeather ? this.tooltipWeatherCells(entry).join("\u0001") : ""
            ].join("\u0002")).join("\u0003")
        ].join("\u0004");
    }

    setTooltipText(dateFormattedTooltip, clockEntries) {
        const key = this._tooltipKey(dateFormattedTooltip, clockEntries);
        if (this._rendered_tooltip_key === key) {
            return;
        }
        this._rendered_tooltip_key = key;

        this.view.setTooltip(this.buildTooltipText(dateFormattedTooltip, clockEntries));
    }

    // a tooltip is plain text, so the columns can only be lined up by padding;
    // the temperatures hang off the right of their column so the digits stack
    alignTooltipRows(rows) {
        const widths = [];
        rows.forEach((cells) => {
            cells.forEach((cell, column) => {
                const width = Array.from(cell).length;
                if (!widths[column] || width > widths[column]) {
                    widths[column] = width;
                }
            });
        });

        return rows.map((cells) => {
            return cells.map((cell, column) => {
                const pad = widths[column] - Array.from(cell).length;
                const padding = " ".repeat(pad > 0 ? pad : 0);
                if (column === TOOLTIP_TEMPERATURE_COLUMN) {
                    return padding + cell;
                }
                // the last cell of a row needs no padding behind it
                if (column === cells.length - 1) {
                    return cell;
                }
                return cell + padding;
            }).join("  ").replace(/\s+$/, "");
        });
    }

    buildTooltipText(dateFormattedTooltip, clockEntries = []) {
        const view = this.view;
        const lines = [];

        // the shipped tooltip is the clock table; a custom tooltip format is a
        // header the user asked for, so it keeps its place on top
        if (view.useCustomFormat && dateFormattedTooltip) {
            lines.push(dateFormattedTooltip);
        }

        const rows = clockEntries.map((entry) => this.tooltipClockRow(entry));
        if (rows.length) {
            lines.push(...this.alignTooltipRows(rows));
        } else if (dateFormattedTooltip && !view.useCustomFormat) {
            lines.push(dateFormattedTooltip);
        }

        // The weather's failure and its "loading" reached the user only through
        // the per-clock rows — and there are none when the world clocks are off,
        // or when no clocks are configured. So with weather on and clocks off, a
        // failed lookup painted a bare ⚠ on the panel and hovering it explained
        // nothing at all; NO_LOCATION was a lone ⚠ that never said "set a weather
        // location". The words existed, and were translated, and were unreachable
        // in the one configuration where the panel has nothing else to say.
        if (!rows.length) {
            const status = this.weatherStatusLine();
            if (status) {
                lines.push(status);
            }
        }

        // The provider used to be credited here, under a blank line. It is still
        // credited in the world-clock popup's accessible name and in the README —
        // the tooltip is a table of times, and a footer is not part of the table.
        return lines.join("\n");
    }

    // what the panel's weather is doing, in words, for a tooltip with no clock
    // rows to hang it on
    weatherStatusLine() {
        const view = this.view;
        if (!view.showWeather) {
            return "";
        }

        if (view.weatherError) {
            return Weather.WEATHER_ERROR_MARKER + " " + translateWeatherError(view.weatherError);
        }

        // the first refresh has not landed: an ellipsis on the panel says nothing
        if (view.weatherPending) {
            return _("Weather: loading…");
        }

        return "";
    }

    // the same cells the tooltip prints, as one phrase for the row's name
    describeClockWeather(clockEntries) {
        if (!this.view.showWeather) {
            return clockEntries;
        }

        return clockEntries.map((entry) => {
            const [reading, words] = this.tooltipWeatherCells(entry);
            const weather = [reading, words].filter((cell) => cell).join(", ");
            return weather ? Object.assign({}, entry, { weather }) : entry;
        });
    }

    weatherSourceName() {
        return this.view.weatherProvider || this.view.cityWeatherProviderName() || "";
    }

    getFormattedToday() {
        const view = this.view;
        const now = new Date();
        const yearStart = Date.UTC(now.getFullYear(), 0, 0);
        const dayOfYear = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - yearStart) / MSECS_IN_DAY);
        const key = now.getFullYear() + ":" + dayOfYear;

        if (this._todayFormatCache && this._todayFormatCache.key === key) {
            return this._todayFormatCache;
        }

        this._todayFormatCache = {
            key,
            full: view.formatClock(Utils.DATE_FORMAT_FULL).capitalize(),
            short: view.formatClock(Utils.DATE_FORMAT_SHORT).capitalize(),
            day: view.formatClock(Utils.DAY_FORMAT).capitalize()
        };

        return this._todayFormatCache;
    }

    _announce(labelString) {
        const view = this.view;
        const error = view.showWeather && view.weatherError ?
            translateWeatherError(view.weatherError) : "";
        const showing = !error && view.showWeather;
        const pending = showing && view.weatherPending;
        const condition = showing && view.weatherReading ? view.weatherReading.condition : "";
        const name = error ? joinPhrases(labelString, error) :
            describeWeather(labelString, condition, pending);

        if (this._rendered_accessible_name === name) {
            return;
        }
        this._rendered_accessible_name = name;

        this.view.setAccessibleName(name);
    }

    _setLabel(label, cacheKey, text) {
        if (this[cacheKey] === text) {
            return;
        }

        this[cacheKey] = text;
        label.set_text(text);
    }

    getClockEntries(limit = null, includeBuiltin = true) {
        return this.view.getClockEntries(limit, includeBuiltin);
    }

    getDateFormattedTooltip(formattedToday) {
        const view = this.view;
        if (!view.useCustomFormat) {
            return formattedToday.full;
        }

        let dateFormattedTooltip = view.formatClock(view.customTooltipFormat).capitalize();
        if (!dateFormattedTooltip) {
            global.logError("Calendar applet: bad tooltip time format string - check your string.");
            dateFormattedTooltip = view.formatClock(
                badFormatFallback(view, _("Invalid tooltip format; edit it in Settings")));
        }
        return dateFormattedTooltip;
    }

    updateClockAndDate(forceMenuUpdate = false) {
        const view = this.view;
        let label_string = view.formattedClock();

        if (!view.useCustomFormat) {
            label_string = label_string.capitalize();
        }

        let refreshMenu = forceMenuUpdate || view.menuOpen;
        const clocksOn = this.worldclocksEnabled();
        // Nobody reads a clock off the closed panel any more, so a closed panel
        // formats none: a GLib.DateTime per city per second, for a table only the
        // tooltip and the popup draw. They are built when one of those two is
        // about to be shown, and then in full.
        const showingClocks = Boolean(refreshMenu || view.panelHovered);
        let clockEntries = (clocksOn && showingClocks) ?
            this.getClockEntries(null, true) : [];
        let label_suffix = this.buildLabelSuffix();
        if (label_suffix) {
            // the temperature reads as part of the clock line, so no bullet
            // divides them; any world clocks after it keep theirs
            label_string += " " + this.ellipsizeLabelSuffix(label_suffix);
        }

        this.view.setLabel(Utils.clampText(label_string, LABEL_MAX_LENGTH));
        // the panel label carries the weather failure as a bare glyph; a screen
        // reader needs the words — and it gets them in full: the cap is about the
        // width of a shared panel, and a screen reader has no width
        this._announce(label_string);

        if (!refreshMenu) {
            if (view.panelHovered) {
                let formattedToday = this.getFormattedToday();
                let dateFormattedTooltip = this.getDateFormattedTooltip(formattedToday);
                this.setTooltipText(dateFormattedTooltip, clockEntries);
            }
            return;
        }

        let formattedToday = this.getFormattedToday();
        let dateFormattedTooltip = this.getDateFormattedTooltip(formattedToday);
        view.setHomeEnabled(!view.todaySelected());

        // St.Label compares by pointer, so writing a byte-identical string still
        // queues a relayout; these change once a day, and the tick is a minute —
        // or a second, if clock-show-seconds is on
        this._setLabel(view.dayLabel, "_rendered_day", formattedToday.day);
        this._setLabel(view.dateLabel, "_rendered_date", formattedToday.short);
        this.setTooltipText(dateFormattedTooltip, clockEntries);

        view.selectEventsDate();

        // The per-city temperature, the condition in words and the service that
        // answered lived only in the panel's mouse tooltip, so a keyboard-only
        // or screen-reader user never got any of it — and the provider credit is
        // a courtesy the data services are owed.
        view.updateWorldclocks(this.describeClockWeather(clockEntries));
        view.setWeatherSource(view.showWeather ? this.weatherSourceName() : "");
    }
}

if (typeof module !== "undefined") {
    module.exports = { AppletPanelStatusPresenter, PanelView, translateWeatherError, describeWeather, badFormatFallback, WEATHER_ERROR_TEXT, WEATHER_CONDITION_TEXT, LABEL_SUFFIX_MAX_LENGTH, LABEL_MAX_LENGTH, LABEL_ELLIPSIS };
}
