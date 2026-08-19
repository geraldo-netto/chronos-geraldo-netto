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
//
// WeatherFormat, not Weather: appletLifecycle beside this file binds `Weather`
// to weather.js, and weather.js flattens weatherFormat into its own namespace
// on the Node side - so a line moved between the two files kept resolving under
// `node test/` and stopped resolving in Cinnamon.
const WeatherFormat = require("./weatherFormat");
const WorldclockData = require("./worldclockData");
const SettingsFacade = require("./settingsFacade");

const _ = LocaleText.translate;
const joinPhrases = LocaleText.joinPhrases;
const fillTemplate = TextUtils.fillTemplate;

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
// The shipped panel and tooltip formats keep the same day-month, 24-hour order
// in every locale. %b still localizes the abbreviated month name itself.
// The value is the facade's: the schema defaults, the legacy-format migration
// and this runtime fallback must all name the same format.
const DEFAULT_DATE_TIME_FORMAT = SettingsFacade.DEFAULT_DATE_TIME_FORMAT;
// label, date and time, temperature, condition: only the numbers are right-aligned
const TOOLTIP_TEMPERATURE_COLUMN = 2;
const INVALID_TIME_FORMAT_TEXT = _("Invalid time format; edit it in Settings");

// Cells, not code points: the tooltip is padded with spaces in a fixed-width
// font, so a CJK label or a translated condition has to be measured in the
// units the padding is made of. See TextUtils.displayWidth.
function tooltipColumnWidths(rows) {
    const widths = [];
    rows.forEach((cells) => {
        cells.forEach((cell, column) => {
            const width = TextUtils.displayWidth(cell);
            widths[column] = Math.max(widths[column] || 0, width);
        });
    });
    return widths;
}

function alignedTooltipCell(cell, column, cells, widths) {
    const pad = widths[column] - TextUtils.displayWidth(cell);
    const padding = " ".repeat(Math.max(pad, 0)); // NOSONAR [S7766] -- accepted compatible form
    if (column === TOOLTIP_TEMPERATURE_COLUMN) {
        return padding + cell;
    }
    // the last cell of a row needs no padding behind it
    return column === cells.length - 1 ? cell : cell + padding;
}

const WEATHER_ERROR_TEXT = {
    [WeatherFormat.WEATHER_ERRORS.LOCATION_NOT_FOUND]: _("Location not found"),
    [WeatherFormat.WEATHER_ERRORS.SERVICE_UNAVAILABLE]: _("Weather service unavailable"),
    [WeatherFormat.WEATHER_ERRORS.NO_LOCATION]: _("Set a weather location"),
    [WeatherFormat.WEATHER_ERRORS.OFFLINE]: _("No network connection")
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
    const word = condition ? (WeatherFormat.WEATHER_CONDITIONS[condition] || "") : "";
    return word ? (WEATHER_CONDITION_TEXT[word] || word) : "";
}

function markedWeatherError(error) {
    const text = translateWeatherError(error);
    return text ? WeatherFormat.WEATHER_ERROR_MARKER + " " + text : "";
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
function safeClockFormat(port) {
    const use24h = port.desktopSettings() && port.desktopSettings().use24h; // NOSONAR [S6582] -- accepted compatible form

    return use24h ? "%H:%M" : "%-l:%M %p";
}

function badFormatFallback(port, message) {
    return String(message).replace(/%/g, "%%") + " • " + safeClockFormat(port); // NOSONAR [S7781] -- accepted compatible form
}

// The date formats are translator-supplied strftime, and — like the custom
// format badFormatFallback guards — nothing can check their directives. A
// broken msgstr makes get_clock_for_format answer null, which .capitalize()
// used to turn into a TypeError on every menu open for that locale. The
// untranslated msgid is known-valid, so the header falls back to it.
function _localizedStamp(port, format, fallback) {
    const stamp = DateFormats.formatDateWithFallback(
        (candidate) => port.formatClock(candidate), format, fallback);
    return stamp.capitalize();
}

// The presenter reads and writes the applet through one seam: the port literal
// `createPanelPort` builds in 6.0/applet.js, which is the single definition of
// that interface.
//
// It used to reach the applet's privates directly — weather state, hover state,
// `_worldclocks`, `_calendar`, `events_manager` — so the applet's private shape
// was the presenter's API, and renaming any of those fields threw nothing:
// `undefined` is falsy, and the panel suffix, the tooltip's temperature column,
// the accessible name and the "Source:" credit would all just silently go blank.
//
// The seam was a `PanelView` class wrapping the port, and twenty-two of its
// twenty-six members were `return this.port.X()`. That reproduced the failure
// mode it was introduced to prevent: one datum meant an edit in three files,
// and a typo in a view getter returned `undefined` — the same silent blank, one
// layer further in. The four members that carried behaviour are below; the rest
// of the interface is the port literal.

// The port answers whatever the settings hold; the units the presenter renders
// in are the normalized ones.
function panelWeatherUnits(port) {
    return WeatherFormat.normalizeUnits(port.weatherUnits());
}

function hasKeyFocus(actor) {
    const stage = typeof global !== "undefined" ? global.stage : null;
    return Boolean(stage && stage.get_key_focus && stage.get_key_focus() === actor); // NOSONAR [S6582] -- accepted compatible form
}

// Assigned, never compared. Reading accessible_role calls atk_object_get_role()
// on the actor's accessible, and on the xlet reload path that accessible is not
// an ATK object yet, so the read trips an assertion once per reload — but only
// while an AT-SPI client is attached, which is to say only for the screen-reader
// users this name is here to serve. The assignment is idempotent, so the
// comparison that guarded it bought nothing to pay for that.
function writeAccessibleName(port, name) {
    const actor = port.actor();
    if (!actor || !actor.set_accessible_name) { // NOSONAR [S6582] -- accepted compatible form
        return;
    }

    actor.set_accessible_name(name);
    if (Atk.Role) {
        actor.accessible_role = Atk.Role.PUSH_BUTTON;
    }
}

class AppletPanelStatusPresenter {
    // does not hold it, and reads and writes nothing but the seam
    constructor(port) {
        this.port = port;
        this._todayFormatCache = null;
        this._invalidTooltipFormat = null;
        this._tooltipFormatWasRejected = false;
        this._formatIssue = "";
        this._tooltipFormatIssue = "";
        // the diff-then-write caches, declared here rather than sprung into
        // existence on the first tick: the class's shape is its contract
        this._rendered_tooltip_key = null;
        this._rendered_accessible_name = null;
        this._rendered_label = null;
        this._rendered_day = null;
        this._rendered_date = null;
        this._rendered_home_enabled = null;
    }

    // this runs on every open-menu tick, and these writes were the one undiffed
    // path left in it: reactive/can_focus self-diff in Clutter, but
    // set_style_class_name queues a relayout for a byte-identical name
    _setHomeEnabled(enabled) {
        const next = Boolean(enabled);
        if (next === this._rendered_home_enabled) {
            return;
        }
        this._rendered_home_enabled = next;

        const button = this.port.homeButton();

        if (!enabled && button.can_focus && hasKeyFocus(button)) {
            this.port.focusSelectedDay();
        }

        button.reactive = enabled;
        button.can_focus = enabled;
        button.set_style_class_name(enabled ?
            "calendar-today-home-button-enabled" : "calendar-today-home-button");
    }

    updateFormatString() {
        const port = this.port;
        let world_string = port.customFormat();
        let accepted = false;

        if (DateFormats.dateFormatWithinLimit(world_string)) {
            accepted = port.setClockFormatString(world_string);
        }

        if (!accepted) {
            global.logError("Calendar applet: bad time format string - check your string.");
            this._formatIssue = INVALID_TIME_FORMAT_TEXT;
            world_string = badFormatFallback(port, INVALID_TIME_FORMAT_TEXT);
            port.setClockFormatString(world_string);
        } else {
            this._formatIssue = "";
        }

        // the format changes what the rows say, not which rows exist: rebuilding
        // the actors here meant every keystroke in the custom-format entry tore
        // the whole clock grid down and built it again
        //
        // A world-clock cell is a time, and badFormatFallback's string is an
        // explanation joined to one. Handing that to setWorldclockFormat printed
        // "Invalid time format; edit it in Settings" in every row — the time
        // column has no max-width, so the popup widened and pushed the calendar
        // grid across — while the footer was already saying it once.
        port.setWorldclockFormat(accepted ? world_string : safeClockFormat(port));
        port.setWorldclocksVisible(this.worldclocksEnabled());
    }

    // the panel carries the temperature, not the sky: the glyph is a picture of
    // what the tooltip and the accessible name already say in words. The record
    // is Celsius; the panel renders it in the user's unit.
    panelReadingText() {
        const port = this.port;
        // the first refresh has not landed: the placeholder is the panel's, and
        // it is the one weather state the record cannot carry
        if (port.weatherPending()) {
            return WeatherFormat.WEATHER_PENDING_TEXT;
        }

        const record = port.weatherReading();
        return record ? WeatherFormat.formatTemperature(record.temperatureC, panelWeatherUnits(port)) : "";
    }

    // The one thing show_worldclocks used to do was hide the popup grid. The
    // panel label, the tooltip and the per-city weather all ignored it: with
    // the clocks switched off and weather on, the applet still built a
    // GLib.DateTime per clock every second, still appended the clocks to the
    // panel label and the tooltip, and still made 8 cities × 1 forecast every
    // 30 minutes — sixteen HTTP round-trips an hour for a feature that is off.
    worldclocksEnabled() {
        return this.port.worldclocksEnabled();
    }

    // World clocks never reach the panel. They are a table — a label and a time
    // per city — and the panel is a single line that the date and the weather
    // already share; a clock appended to it is the first thing the panel drops
    // when it runs out of room. They are shown in full where there is room to
    // show them: the tooltip and the popup.
    buildLabelSuffix() {
        const port = this.port;
        let parts = [];

        if (port.showWeather()) {
            const reading = this.panelReadingText();
            if (port.weatherError()) {
                // the failure marker stays: it is the only sign on the panel
                // that the reading may be stale
                parts.push(reading ?
                    WeatherFormat.WEATHER_ERROR_MARKER + " " + reading :
                    WeatherFormat.WEATHER_ERROR_MARKER);
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
        const configured = this.port.customTooltipFormat() || DEFAULT_DATE_TIME_FORMAT;
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

    // A stamp rendered from the configured format is the proof it is usable,
    // and the only thing that can retire the warning it left behind.
    _acceptTooltipFormat() {
        if (this._tooltipFormatWasRejected) {
            return;
        }
        this._invalidTooltipFormat = null;
        this._tooltipFormatIssue = "";
    }

    _rejectTooltipFormat(format) {
        if (this._invalidTooltipFormat === format) {
            return;
        }
        this._invalidTooltipFormat = format;
        this._tooltipFormatIssue = INVALID_TIME_FORMAT_TEXT;
        global.logError("Calendar applet: bad tooltip time format string - check your string.");
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
            this._acceptTooltipFormat();
            return DateFormats.clampClockStamp(stamp);
        }

        this._rejectTooltipFormat(format);

        return DateFormats.clampClockStamp(
            entry.localTime.format(DEFAULT_DATE_TIME_FORMAT) || entry.time);
    }

    // The same stamp for the local zone, taken from the panel clock rather than
    // from a world-clock row. custom-tooltip-format is a tooltip setting the
    // settings page advertises unconditionally, and its only reader was the
    // per-row stamp above — so with the world clocks switched off it rendered
    // nowhere, and the panel was left with no tooltip at all.
    tooltipLocalStamp() {
        const format = this.tooltipClockFormat();
        const stamp = this.port.formatClock(format);
        if (stamp) {
            this._acceptTooltipFormat();
            return DateFormats.clampClockStamp(stamp);
        }

        this._rejectTooltipFormat(format);

        return DateFormats.clampClockStamp(
            this.port.formatClock(DEFAULT_DATE_TIME_FORMAT) || this.port.formattedClock());
    }

    // a temperature cell and a condition cell, rendered from the reading record.
    // The tooltip has room for words, so it takes the temperature and the sky in
    // text and leaves the glyph to the panel. The error, if any, replaces the
    // condition words: the marker says the reading may be old, not gone.
    _readingCells(record, error) {
        return [
            WeatherFormat.formatTemperature(record.temperatureC, panelWeatherUnits(this.port)),
            error || weatherConditionWords(record.condition)
        ];
    }

    // the local row takes the panel reading; UTC is a scale, not a place, and
    // shows no weather. A failed refresh keeps the last good reading, as the
    // panel does — the marker says it may be old, not gone.
    _builtinWeatherCells(entry) {
        const port = this.port;
        if (entry.timezone === WorldclockData.UTC_TIMEZONE) {
            return ["", ""];
        }

        const error = port.weatherError() ? markedWeatherError(port.weatherError()) : "";
        // the first refresh has not landed: an ellipsis in the temperature
        // column, with nothing beside it, says less than nothing
        if (port.weatherPending()) {
            return ["", error || _("Weather: loading…")];
        }

        const record = port.weatherReading();
        return record ? this._readingCells(record, error) : ["", error];
    }

    // every non-built-in row takes its own city's reading record, which it keeps
    // when a refresh fails — without the marker a temperature from this morning
    // would read as the weather now. A city with no reading yet shows a blank
    // cell rather than a placeholder: unlike the panel, the city provider reserves
    // no slot, so there is no "loading" state to report.
    _cityWeatherModel(entry) {
        const port = this.port;
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

        const record = port.cityWeatherReading(city);
        const currentError = port.cityWeatherError(city);
        let rowError = currentError ? markedWeatherError(currentError) : "";
        let issue = currentError ?
            joinPhrases(entry.label, translateWeatherError(currentError)) : "";
        if (!rowError && port.cityWeatherStale(city)) {
            // one msgid: the marker is a glyph the phrase is built around, and a
            // translator has to be able to put it where it belongs
            rowError = fillTemplate(_("%s Last known reading"),
                [WeatherFormat.WEATHER_ERROR_MARKER]);
            const stale = fillTemplate(_("%s Last known reading"), [""]).trim();
            issue = joinPhrases(entry.label, stale);
        }

        return {
            cells: record ? this._readingCells(record, rowError) : ["", rowError],
            issue,
            source: record ? port.cityWeatherProviderName(city) : ""
        };
    }

    _weatherSource(entry, cityModel, showWeather) {
        if (!showWeather) {
            return "";
        }
        if (cityModel) {
            return cityModel.source;
        }
        if (entry.timezone === WorldclockData.UTC_TIMEZONE || !this.port.weatherReading()) {
            return "";
        }
        return this.port.weatherProvider();
    }

    _clockRenderRow(entry, showWeather) {
        const cells = [entry.label, this.tooltipClockStamp(entry)];
        let cityModel = null;
        if (showWeather && !entry.builtin) {
            cityModel = this._cityWeatherModel(entry);
        }
        let weatherCells = [];
        if (showWeather) {
            weatherCells = cityModel ? cityModel.cells : this._builtinWeatherCells(entry);
        }
        const weather = weatherCells.filter(Boolean).join(", ");

        // The joined string is for the places that have room for a sentence —
        // the tooltip and the row's accessible name. The temperature travels
        // beside it as its own cell, because the popup's weather column is one
        // reading wide: a row whose fetch failed has no temperature and only an
        // error, and recovering the cell by splitting the join drew that error
        // into the column instead of leaving it empty.
        //
        // Named fields of the row Worldclocks.renderRow declares, always both of
        // them. This used to be Object.assign over the entry when there was a
        // reading and the bare entry when there was not, so the view read two
        // fields it never produced and that were optional by absence.
        return {
            cells: cells.concat(weatherCells),
            issue: cityModel ? cityModel.issue : "",
            source: this._weatherSource(entry, cityModel, showWeather),
            popupEntry: {
                clock: entry.clock,
                time: entry.time,
                weather,
                temperature: weatherCells[0] || ""
            }
        };
    }

    _clockModelKey(rows, localStamp, status) {
        return [
            rows.map((row) => row.cells.join("\u0001")).join("\u0002"),
            localStamp,
            status
        ].join("\u0003");
    }

    // Derive the clock stamp and weather cells once. The tooltip key, tooltip
    // text and popup accessibility all consume this model; timezone-to-city
    // resolution can synchronously inspect zoneinfo, so repeating it on every
    // consumer is expensive on the compositor thread.
    _clockRenderModel(clockEntries = []) {
        const rows = clockEntries.map(
            (entry) => this._clockRenderRow(entry, this.port.showWeather()));
        const status = rows.length ? "" : this.weatherStatusLine();
        // With a table on screen the local stamp is already one of its rows —
        // the built-in "Local time" clock — so a header line above it would say
        // the same thing twice. With no table it is the tooltip.
        const localStamp = rows.length ? "" : this.tooltipLocalStamp();

        return {
            key: this._clockModelKey(rows, localStamp, status),
            popupEntries: rows.map((row) => row.popupEntry),
            rows: rows.map((row) => row.cells),
            issues: rows.map((row) => row.issue).filter(Boolean),
            sources: [...new Set(rows.map((row) => row.source).filter(Boolean))],
            localStamp,
            status
        };
    }

    // The tooltip can be refreshed more often than its configured timestamp
    // changes. The key uses the rendered row stamps so byte-identical text is not
    // written and laid out again.
    _setTooltipModel(model) {
        if (this._rendered_tooltip_key === model.key) {
            return;
        }
        this._rendered_tooltip_key = model.key;

        this.port.setTooltip(this._tooltipText(model));
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
        } else if (model.localStamp) {
            lines.push(model.localStamp);
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

    // Test seam (decision D02): no production caller — the runtime path is
    // _clockRenderModel → _setTooltipModel → _tooltipText. It is here so a test
    // can read the rendered tooltip without reaching two privates to do it.
    buildTooltipText(clockEntries = []) {
        return this._tooltipText(this._clockRenderModel(clockEntries));
    }

    // what the panel's weather is doing, in words, for a tooltip with no clock
    // rows to hang it on
    weatherStatusLine() {
        const port = this.port;
        if (!port.showWeather()) {
            return "";
        }

        if (port.weatherError()) {
            return markedWeatherError(port.weatherError());
        }

        // the first refresh has not landed: an ellipsis on the panel says nothing
        if (port.weatherPending()) {
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
        const port = this.port;
        const issues = [
            this._formatIssue,
            this._tooltipFormatIssue,
            port.showWeather() && port.weatherError() ?
                translateWeatherError(port.weatherError()) : "",
            this._clockIssues(clockEntries),
            ...renderIssues
        ];
        return [...new Set(issues.filter(Boolean))].join("\n");
    }

    getFormattedToday() {
        const port = this.port;
        const now = new Date();
        const yearStart = Date.UTC(now.getFullYear(), 0, 0);
        const dayOfYear = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - yearStart) / MSECS_IN_DAY);
        const key = now.getFullYear() + ":" + dayOfYear;

        if (this._todayFormatCache && this._todayFormatCache.key === key) { // NOSONAR [S6582] -- accepted compatible form
            return this._todayFormatCache;
        }

        this._todayFormatCache = {
            key,
            full: _localizedStamp(port, DateFormats.DATE_FORMAT_FULL,
                DateFormats.DATE_FORMAT_FULL_FALLBACK),
            short: _localizedStamp(port, DateFormats.DATE_FORMAT_SHORT,
                DateFormats.DATE_FORMAT_SHORT_FALLBACK),
            day: _localizedStamp(port, DateFormats.DAY_FORMAT, DateFormats.DAY_FORMAT)
        };

        return this._todayFormatCache;
    }

    _announce(labelString) {
        const port = this.port;
        const error = port.showWeather() && port.weatherError() ?
            translateWeatherError(port.weatherError()) : "";
        const showing = !error && port.showWeather();
        const pending = showing && port.weatherPending();
        const condition = showing && port.weatherReading() ? port.weatherReading().condition : "";
        const name = error ? joinPhrases(labelString, error) :
            describeWeather(labelString, condition, pending);

        if (this._rendered_accessible_name === name) {
            return;
        }
        this._rendered_accessible_name = name;

        writeAccessibleName(this.port, name);
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
        this.port.setLabel(text);
    }

    getClockEntries() {
        return this.port.getClockEntries();
    }

    // Answers whether it refreshed the menu. The caller drives the event column
    // off that: re-selecting the day can dispatch a month fetch to
    // cinnamon-calendar-server and refreshing the rows redraws up to 200 of
    // them, and neither is this class's business — its job is the panel label,
    // the tooltip and the accessible name. Doing it here made the clock-refresh
    // policy the only thing deciding when calendar data reloads, and left the
    // two concerns impossible to change or test apart.
    updateClockAndDate(forceMenuUpdate = false) {
        const port = this.port;
        let label_string = DateFormats.clampClockStamp(port.formattedClock());

        let refreshMenu = forceMenuUpdate || port.menuOpen();
        const clocksOn = this.worldclocksEnabled();
        // Nobody reads a clock off the closed panel any more, so a closed panel
        // formats none: a GLib.DateTime per city per second, for a table only the
        // tooltip and the popup draw. They are built when one of those two is
        // about to be shown, and then in full.
        const showingClocks = Boolean(refreshMenu || port.panelHovered());
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
            if (port.panelHovered()) {
                this._setTooltipModel(clockModel);
            }
            return false;
        }

        let formattedToday = this.getFormattedToday();
        this._setHomeEnabled(!port.todaySelected());

        // St.Label compares by pointer, so writing a byte-identical string still
        // queues a relayout; these change once a day, and the tick is a minute —
        // or a second, if clock-show-seconds is on
        this._setLabel(port.dayLabel(), "_rendered_day", formattedToday.day);
        this._setLabel(port.dateLabel(), "_rendered_date", formattedToday.short);
        this._setTooltipModel(clockModel);
        // Unlike a tooltip, this actor is reachable from a keyboard-opened menu
        // and remains present when the world-clock block is switched off.
        port.setWeatherStatus(this.issueStatus(clockEntries, clockModel.issues));

        // The per-city temperature, the condition in words and the service that
        // answered lived only in the panel's mouse tooltip, so a keyboard-only
        // or screen-reader user never got any of it — and the provider credit is
        // a courtesy the data services are owed.
        port.updateWorldclocks(clockModel.popupEntries);
        port.setWeatherSource(port.showWeather() ? clockModel.sources.join(", ") : "");

        return true;
    }
}

if (typeof module !== "undefined") {
    module.exports = { AppletPanelStatusPresenter, writeAccessibleName, translateWeatherError, weatherConditionWords, markedWeatherError, describeWeather, badFormatFallback, WEATHER_ERROR_TEXT, WEATHER_CONDITION_TEXT, LABEL_SUFFIX_MAX_LENGTH, LABEL_MAX_LENGTH };
}
