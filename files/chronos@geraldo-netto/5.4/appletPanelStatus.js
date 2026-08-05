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

const Atk = imports.gi.Atk;
const AppletModules = imports.ui.appletManager.applets["chronos@geraldo-netto"];
const DateFormats = AppletModules.dateFormats;
const LocaleText = AppletModules.localeText;
const TextUtils = AppletModules.textUtils;
// the pure half of the weather module: the constants and the formatters. The
// panel presenter renders — it must not link the Soup session, the provider
// chains and the refresh scheduler that the weather.js barrel drags in.
const Weather = require("./weatherFormat");
const WorldclockData = require("./worldclockData");
const SettingsFacade = require("./settingsFacade");

const _ = LocaleText.translate;
const joinPhrases = LocaleText.joinPhrases;

const MSECS_IN_DAY = DateFormats.MSECS_IN_DAY;
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
const LABEL_ELLIPSIS = TextUtils.TEXT_ELLIPSIS;
// The shipped panel and tooltip formats keep the same day-month, 24-hour order
// in every locale. %b still localizes the abbreviated month name itself.
// The value is the facade's: the schema defaults, the legacy-format migration
// and this runtime fallback must all name the same format.
const DEFAULT_DATE_TIME_FORMAT = SettingsFacade.DEFAULT_DATE_TIME_FORMAT;
// label, date and time, temperature, condition: only the numbers are right-aligned
const TOOLTIP_TEMPERATURE_COLUMN = 2;
const INVALID_TIME_FORMAT_TEXT = _("Invalid time format; edit it in Settings");

function tooltipColumnWidths(rows) {
    const widths = [];
    rows.forEach((cells) => {
        cells.forEach((cell, column) => {
            const width = Array.from(cell).length;
            widths[column] = Math.max(widths[column] || 0, width);
        });
    });
    return widths;
}

function alignedTooltipCell(cell, column, cells, widths) {
    const pad = widths[column] - Array.from(cell).length;
    const padding = " ".repeat(Math.max(pad, 0)); // NOSONAR [S7766] -- accepted compatible form
    if (column === TOOLTIP_TEMPERATURE_COLUMN) {
        return padding + cell;
    }
    // the last cell of a row needs no padding behind it
    return column === cells.length - 1 ? cell : cell + padding;
}

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

function weatherConditionWords(condition) {
    const word = condition ? (Weather.WEATHER_CONDITIONS[condition] || "") : "";
    return word ? (WEATHER_CONDITION_TEXT[word] || word) : "";
}

function markedWeatherError(error) {
    const text = translateWeatherError(error);
    return text ? Weather.WEATHER_ERROR_MARKER + " " + text : "";
}

// The panel has room for a glyph and a temperature, and no more. A screen
// reader gets the emoji's codepoint name or nothing at all, so the spoken name
// spells the condition out. `condition` is the reading's condition glyph
// (record.condition); `pending` is the first-refresh placeholder state, whose
// ellipsis reads aloud as nothing at all.
function describeWeather(text, condition = "", pending = false) {
    if (pending) {
        return joinPhrases(text, _("Weather: loading…"));
    }

    const words = weatherConditionWords(condition);
    if (!words) {
        return text;
    }

    return joinPhrases(text, words);
}

// The result is handed to strftime, so every % in it is a directive. A
// translator who writes "100 % ungültig", or slips in a stray %d, would
// otherwise corrupt the panel label — and xgettext does not mark these strings
// c-format, so msgfmt would not catch it either. %% is strftime's literal
// percent, and the time beside the message follows the user's own clock rather
// than a hardcoded 12-hour one.
function badFormatFallback(view, message) {
    const use24h = view.desktopSettings && view.desktopSettings.use24h; // NOSONAR [S6582] -- accepted compatible form

    return String(message).replace(/%/g, "%%") + " • " + (use24h ? "%H:%M" : "%-l:%M %p"); // NOSONAR [S7781] -- accepted compatible form
}

// The date formats are translator-supplied strftime, and — like the custom
// format badFormatFallback guards — nothing can check their directives. A
// broken msgstr makes get_clock_for_format answer null, which .capitalize()
// used to turn into a TypeError on every menu open for that locale. The
// untranslated msgid is known-valid, so the header falls back to it.
function _localizedStamp(view, format, fallback) {
    const stamp = DateFormats.formatDateWithFallback(
        (candidate) => view.formatClock(candidate), format, fallback);
    return stamp.capitalize();
}

// Everything the presenter reads and writes, behind one seam.
//
// It was the writes only, and the presenter went on reading about fifteen applet
// privates straight through it — weather state, hover state,
// _worldclocks, _calendar and events_manager. PanelView broke its own seam too,
// reaching for applet._calendar. So the applet's private shape was still the presenter's API:
// renaming any of those fields threw nothing, because `undefined` is falsy, and
// the panel suffix, the tooltip's temperature column, the accessible name and
// the "Source:" credit would all just silently go blank.
//
// The reads are here now. AppletMenuBuilder and AppletProviderLifecycle take a
// context and hand their products back; this is the same idea for the panel.
class PanelView {
    constructor(port) {
        this.port = port;
        this._rendered_home_enabled = null;
    }

    get showWeather() {
        return this.port.showWeather();
    }

    get worldclocksEnabled() {
        return this.port.worldclocksEnabled();
    }

    get customFormat() {
        return this.port.customFormat();
    }

    get customTooltipFormat() {
        return this.port.customTooltipFormat();
    }

    get panelHovered() {
        return this.port.panelHovered();
    }

    get menuOpen() {
        return this.port.menuOpen();
    }

    get desktopSettings() {
        return this.port.desktopSettings();
    }

    get weatherReading() {
        return this.port.weatherReading();
    }

    get weatherPending() {
        return this.port.weatherPending();
    }

    get weatherUnits() {
        return Weather.normalizeUnits(this.port.weatherUnits());
    }

    get weatherError() {
        return this.port.weatherError();
    }

    get weatherProvider() {
        return this.port.weatherProvider();
    }

    cityWeatherReading(city) {
        return this.port.cityWeatherReading(city);
    }

    cityWeatherStale(city) {
        return this.port.cityWeatherStale(city);
    }

    cityWeatherError(city) {
        return this.port.cityWeatherError(city);
    }

    cityWeatherProviderName(city) {
        return this.port.cityWeatherProviderName(city);
    }

    formattedClock() {
        return this.port.formattedClock();
    }

    formatClock(format) {
        return this.port.formatClock(format);
    }

    setClockFormatString(format) {
        return this.port.setClockFormatString(format);
    }

    setLabel(text) {
        this.port.setLabel(text);
    }

    setTooltip(text) {
        this.port.setTooltip(text);
    }

    setAccessibleName(name) {
        const actor = this.port.actor();
        if (!actor || !actor.set_accessible_name) { // NOSONAR [S6582] -- accepted compatible form
            return;
        }

        actor.set_accessible_name(name);
        if (Atk.Role && actor.accessible_role !== Atk.Role.PUSH_BUTTON) {
            actor.accessible_role = Atk.Role.PUSH_BUTTON;
        }
    }

    get dayLabel() {
        return this.port.dayLabel();
    }

    get dateLabel() {
        return this.port.dateLabel();
    }

    setWorldclockFormat(format) {
        this.port.setWorldclockFormat(format);
    }

    setWorldclocksVisible(visible) {
        this.port.setWorldclocksVisible(visible);
    }

    updateWorldclocks(entries) {
        this.port.updateWorldclocks(entries);
    }

    setWeatherSource(source) {
        this.port.setWeatherSource(source);
    }

    setWeatherStatus(text) {
        this.port.setWeatherStatus(text);
    }

    getClockEntries() {
        return this.port.getClockEntries();
    }

    todaySelected() {
        return this.port.todaySelected();
    }

    selectEventsDate() {
        this.port.selectEventsDate();
    }

    refreshEventRows() {
        this.port.refreshEventRows();
    }

    setHomeEnabled(enabled) {
        // this runs on every open-menu tick, and these writes were the one
        // undiffed path left in it: reactive/can_focus self-diff in Clutter,
        // but set_style_class_name queues a relayout for a byte-identical name
        const next = Boolean(enabled);
        if (next === this._rendered_home_enabled) {
            return;
        }
        this._rendered_home_enabled = next;

        const button = this.port.homeButton();

        if (!enabled && button.can_focus && this._hasKeyFocus(button)) {
            this.port.focusSelectedDay();
        }

        button.reactive = enabled;
        button.can_focus = enabled;
        button.set_style_class_name(enabled ?
            "calendar-today-home-button-enabled" : "calendar-today-home-button");
    }

    _hasKeyFocus(actor) {
        const stage = typeof global !== "undefined" ? global.stage : null;
        return Boolean(stage && stage.get_key_focus && stage.get_key_focus() === actor); // NOSONAR [S6582] -- accepted compatible form
    }
}
class AppletPanelStatusPresenter {
    // does not hold it, and reads and writes nothing but the seam
    constructor(view) {
        this.view = view;
        this._todayFormatCache = null;
        this._invalidTooltipFormat = null;
        this._tooltipFormatWasRejected = false;
        this._formatIssue = "";
        this._tooltipFormatIssue = "";
    }

    updateFormatString() {
        const view = this.view;
        let world_string = view.customFormat;
        let accepted = false;

        if (DateFormats.dateFormatWithinLimit(world_string)) {
            accepted = view.setClockFormatString(world_string);
        }

        if (!accepted) {
            global.logError("Calendar applet: bad time format string - check your string.");
            this._formatIssue = INVALID_TIME_FORMAT_TEXT;
            world_string = badFormatFallback(view, INVALID_TIME_FORMAT_TEXT);
            view.setClockFormatString(world_string);
        } else {
            this._formatIssue = "";
        }

        // the format changes what the rows say, not which rows exist: rebuilding
        // the actors here meant every keystroke in the custom-format entry tore
        // the whole clock grid down and built it again
        view.setWorldclockFormat(world_string);
        view.setWorldclocksVisible(this.worldclocksEnabled());
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
        return TextUtils.clampText(suffix, LABEL_SUFFIX_MAX_LENGTH);
    }

    tooltipClockFormat() {
        const configured = this.view.customTooltipFormat || DEFAULT_DATE_TIME_FORMAT;
        this._tooltipFormatWasRejected =
            !DateFormats.dateFormatWithinLimit(configured);

        if (!this._tooltipFormatWasRejected) {
            return configured;
        }

        if (this._invalidTooltipFormat !== "overlong") {
            this._invalidTooltipFormat = "overlong";
            this._tooltipFormatIssue = INVALID_TIME_FORMAT_TEXT;
            global.logError("Calendar applet: tooltip time format exceeds the safe limit.");
        }
        return DEFAULT_DATE_TIME_FORMAT;
    }

    // The change-detection key and the rendered row both use this stamp. An
    // invalid configured format falls back inside the row instead of creating a
    // separate error/header line that breaks the table shape.
    tooltipClockStamp(entry) {
        if (!(entry.localTime && entry.localTime.format)) { // NOSONAR [S6582] -- accepted compatible form
            return DateFormats.clampClockStamp(entry.time);
        }

        const format = this.tooltipClockFormat();
        const stamp = entry.localTime.format(format);
        if (stamp) {
            if (!this._tooltipFormatWasRejected) {
                this._invalidTooltipFormat = null;
                this._tooltipFormatIssue = "";
            }
            return DateFormats.clampClockStamp(stamp);
        }

        if (this._invalidTooltipFormat !== format) {
            this._invalidTooltipFormat = format;
            this._tooltipFormatIssue = INVALID_TIME_FORMAT_TEXT;
            global.logError("Calendar applet: bad tooltip time format string - check your string.");
        }

        return DateFormats.clampClockStamp(
            entry.localTime.format(DEFAULT_DATE_TIME_FORMAT) || entry.time);
    }

    // a temperature cell and a condition cell, rendered from the reading record.
    // The tooltip has room for words, so it takes the temperature and the sky in
    // text and leaves the glyph to the panel. The error, if any, replaces the
    // condition words: the marker says the reading may be old, not gone.
    _readingCells(record, error) {
        return [
            Weather.formatTemperature(record.temperatureC, this.view.weatherUnits),
            error || weatherConditionWords(record.condition)
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

        const error = view.weatherError ? markedWeatherError(view.weatherError) : "";
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
    _cityWeatherModel(entry) {
        const view = this.view;
        // the reading is of the city the timezone names, which is also what was
        // geocoded; the label is the user's name for the row and two rows may
        // share one
        const city = WorldclockData.timezoneWeatherCity(entry.timezone);

        // An offset-only zone (Etc/GMT+3) names no city, so there is nothing to
        // forecast and there never will be. Blank cells said exactly what a fetch
        // still in flight and a fetch that failed said, so the row looked broken
        // rather than inapplicable.
        if (!city) {
            return { cells: ["", _("No weather for this timezone")], issue: "", source: "" };
        }

        const record = view.cityWeatherReading(city);
        const currentError = view.cityWeatherError(city);
        let rowError = currentError ? markedWeatherError(currentError) : "";
        let issue = currentError ?
            joinPhrases(entry.label, translateWeatherError(currentError)) : "";
        if (!rowError && view.cityWeatherStale(city)) {
            // one msgid: the marker is a glyph the phrase is built around, and a
            // translator has to be able to put it where it belongs
            rowError = _("%s Last known reading").replace("%s", Weather.WEATHER_ERROR_MARKER);
            const stale = _("%s Last known reading").replace("%s", "").trim();
            issue = joinPhrases(entry.label, stale);
        }

        return {
            cells: record ? this._readingCells(record, rowError) : ["", rowError],
            issue,
            source: record ? view.cityWeatherProviderName(city) : ""
        };
    }

    _weatherSource(entry, cityModel, showWeather) {
        if (!showWeather) {
            return "";
        }
        if (cityModel) {
            return cityModel.source;
        }
        if (entry.timezone === WorldclockData.UTC_TIMEZONE || !this.view.weatherReading) {
            return "";
        }
        return this.view.weatherProvider;
    }

    _clockRenderRow(entry, showWeather) {
        const cells = [entry.label, this.tooltipClockStamp(entry)];
        const cityModel = showWeather && !entry.builtin ?
            this._cityWeatherModel(entry) : null;
        const weatherCells = !showWeather ? [] :
            (cityModel ? cityModel.cells : this._builtinWeatherCells(entry));
        const weather = weatherCells.filter((cell) => cell).join(", "); // NOSONAR [S7770] -- accepted compatible form

        return {
            cells: cells.concat(weatherCells),
            issue: cityModel ? cityModel.issue : "",
            source: this._weatherSource(entry, cityModel, showWeather),
            popupEntry: weather ? Object.assign({}, entry, { weather }) : entry // NOSONAR [S6661] -- accepted compatible form
        };
    }

    _clockModelKey(rows, status) {
        return [
            rows.map((row) => row.cells.join("\u0001")).join("\u0002"),
            status
        ].join("\u0003");
    }

    // Derive the clock stamp and weather cells once. The tooltip key, tooltip
    // text and popup accessibility all consume this model; timezone-to-city
    // resolution can synchronously inspect zoneinfo, so repeating it on every
    // consumer is expensive on the compositor thread.
    _clockRenderModel(clockEntries = []) {
        const rows = clockEntries.map(
            (entry) => this._clockRenderRow(entry, this.view.showWeather));
        const status = rows.length ? "" : this.weatherStatusLine();

        return {
            key: this._clockModelKey(rows, status),
            popupEntries: rows.map((row) => row.popupEntry),
            rows: rows.map((row) => row.cells),
            issues: rows.map((row) => row.issue).filter((issue) => issue),
            sources: [...new Set(rows.map((row) => row.source).filter((source) => source))],
            status
        };
    }

    // The tooltip can be refreshed more often than its configured timestamp
    // changes. The key uses the rendered row stamps so byte-identical text is not
    // written and laid out again.
    _tooltipKey(clockEntries) {
        return this._clockRenderModel(clockEntries).key;
    }

    _setTooltipModel(model) {
        if (this._rendered_tooltip_key === model.key) {
            return;
        }
        this._rendered_tooltip_key = model.key;

        this.view.setTooltip(this._tooltipText(model));
    }

    // a tooltip is plain text, so the columns can only be lined up by padding;
    // the temperatures hang off the right of their column so the digits stack
    alignTooltipRows(rows) {
        const widths = tooltipColumnWidths(rows);
        return rows.map((cells) => cells.map(
            (cell, column) => alignedTooltipCell(cell, column, cells, widths)
        ).join("  ").replace(/\s+$/, "")); // NOSONAR [S8786] -- input length is bounded
    }

    _tooltipText(model) {
        const lines = [];

        if (model.rows.length) {
            lines.push(...this.alignTooltipRows(model.rows));
        }

        // The weather's failure and its "loading" reached the user only through
        // the per-clock rows — and there are none when the world clocks are off,
        // or when no clocks are configured. So with weather on and clocks off, a
        // failed lookup painted a bare ⚠ on the panel and hovering it explained
        // nothing at all; NO_LOCATION was a lone ⚠ that never said "set a weather
        // location". The words existed, and were translated, and were unreachable
        // in the one configuration where the panel has nothing else to say.
        if (model.status) {
            lines.push(model.status);
        }

        // The provider used to be credited here, under a blank line. It is still
        // credited in the world-clock popup's accessible name and in the README —
        // the tooltip is a table of times, and a footer is not part of the table.
        return lines.join("\n");
    }

    buildTooltipText(clockEntries = []) {
        return this._tooltipText(this._clockRenderModel(clockEntries));
    }

    // what the panel's weather is doing, in words, for a tooltip with no clock
    // rows to hang it on
    weatherStatusLine() {
        const view = this.view;
        if (!view.showWeather) {
            return "";
        }

        if (view.weatherError) {
            return markedWeatherError(view.weatherError);
        }

        // the first refresh has not landed: an ellipsis on the panel says nothing
        if (view.weatherPending) {
            return _("Weather: loading…");
        }

        return "";
    }

    _clockIssues(clockEntries) {
        const labels = clockEntries
            .filter((entry) => entry.localTime === null)
            .map((entry) => entry.label);
        return labels.length ?
            joinPhrases(WorldclockData.INVALID_TIMEZONE_TEXT, labels.join(", ")) : "";
    }

    issueStatus(clockEntries, renderIssues) {
        const view = this.view;
        // The tooltip format only renders world-clock rows, and only a
        // rendered stamp clears its issue — so with clocks switched off a
        // fixed format could never clear the warning it left behind. With no
        // renderable row the issue no longer applies; a still-broken format
        // re-raises it from the first stamp after clocks return.
        if (!clockEntries.length) {
            this._invalidTooltipFormat = null;
            this._tooltipFormatIssue = "";
        }
        const issues = [
            this._formatIssue,
            this._tooltipFormatIssue,
            view.showWeather && view.weatherError ?
                translateWeatherError(view.weatherError) : "",
            this._clockIssues(clockEntries),
            ...renderIssues
        ];
        return [...new Set(issues.filter((issue) => issue))].join("\n");
    }

    getFormattedToday() {
        const view = this.view;
        const now = new Date();
        const yearStart = Date.UTC(now.getFullYear(), 0, 0);
        const dayOfYear = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - yearStart) / MSECS_IN_DAY);
        const key = now.getFullYear() + ":" + dayOfYear;

        if (this._todayFormatCache && this._todayFormatCache.key === key) { // NOSONAR [S6582] -- accepted compatible form
            return this._todayFormatCache;
        }

        this._todayFormatCache = {
            key,
            full: _localizedStamp(view, DateFormats.DATE_FORMAT_FULL,
                DateFormats.DATE_FORMAT_FULL_FALLBACK),
            short: _localizedStamp(view, DateFormats.DATE_FORMAT_SHORT,
                DateFormats.DATE_FORMAT_SHORT_FALLBACK),
            day: _localizedStamp(view, DateFormats.DAY_FORMAT, DateFormats.DAY_FORMAT)
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

    _setPanelLabel(text) {
        if (this._rendered_label === text) {
            return;
        }

        this._rendered_label = text;
        this.view.setLabel(text);
    }

    getClockEntries() {
        return this.view.getClockEntries();
    }

    updateClockAndDate(forceMenuUpdate = false) {
        const view = this.view;
        let label_string = DateFormats.clampClockStamp(view.formattedClock());

        let refreshMenu = forceMenuUpdate || view.menuOpen;
        const clocksOn = this.worldclocksEnabled();
        // Nobody reads a clock off the closed panel any more, so a closed panel
        // formats none: a GLib.DateTime per city per second, for a table only the
        // tooltip and the popup draw. They are built when one of those two is
        // about to be shown, and then in full.
        const showingClocks = Boolean(refreshMenu || view.panelHovered);
        let clockEntries = (clocksOn && showingClocks) ? this.getClockEntries() : [];
        let clockModel = showingClocks ? this._clockRenderModel(clockEntries) : null;
        let label_suffix = this.buildLabelSuffix();
        if (label_suffix) {
            // the temperature reads as part of the clock line, so no bullet
            // divides them; any world clocks after it keep theirs
            label_string += " " + this.ellipsizeLabelSuffix(label_suffix);
        }
        label_string = DateFormats.clampClockStamp(label_string);

        this._setPanelLabel(TextUtils.clampText(label_string, LABEL_MAX_LENGTH));
        // The screen reader gets more than the narrow visible label, but the
        // configured clock portion is still bounded before accessibility and
        // layout consumers receive it.
        this._announce(label_string);

        if (!refreshMenu) {
            if (view.panelHovered) {
                this._setTooltipModel(clockModel);
            }
            return;
        }

        let formattedToday = this.getFormattedToday();
        view.setHomeEnabled(!view.todaySelected());

        // St.Label compares by pointer, so writing a byte-identical string still
        // queues a relayout; these change once a day, and the tick is a minute —
        // or a second, if clock-show-seconds is on
        this._setLabel(view.dayLabel, "_rendered_day", formattedToday.day);
        this._setLabel(view.dateLabel, "_rendered_date", formattedToday.short);
        this._setTooltipModel(clockModel);
        // Unlike a tooltip, this actor is reachable from a keyboard-opened menu
        // and remains present when the world-clock block is switched off.
        view.setWeatherStatus(this.issueStatus(clockEntries, clockModel.issues));

        view.selectEventsDate();
        view.refreshEventRows();

        // The per-city temperature, the condition in words and the service that
        // answered lived only in the panel's mouse tooltip, so a keyboard-only
        // or screen-reader user never got any of it — and the provider credit is
        // a courtesy the data services are owed.
        view.updateWorldclocks(clockModel.popupEntries);
        view.setWeatherSource(view.showWeather ? clockModel.sources.join(", ") : "");
    }
}

if (typeof module !== "undefined") {
    module.exports = { AppletPanelStatusPresenter, PanelView, translateWeatherError, weatherConditionWords, markedWeatherError, describeWeather, badFormatFallback, WEATHER_ERROR_TEXT, WEATHER_CONDITION_TEXT, LABEL_SUFFIX_MAX_LENGTH, LABEL_MAX_LENGTH, LABEL_ELLIPSIS };
}
