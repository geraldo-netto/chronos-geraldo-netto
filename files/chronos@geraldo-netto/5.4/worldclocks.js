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

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const Clutter = GjsImports.gi.Clutter;
const Pango = GjsImports.gi.Pango;
const Tooltips = GjsImports.ui.tooltips;
const GLib = GjsImports.gi.GLib;
const St = GjsImports.gi.St;
// same-dir shim like every other 5.4 module: it hands back the single
// importer-loaded root module instead of a second CJS copy of it
const WorldclockData = require("./worldclockData");
const Utils = require("./utils");

const _ = Utils.translate;
const joinPhrases = Utils.joinPhrases;

const MAX_CLOCKS = WorldclockData.MAX_CLOCKS;
const INVALID_TIMEZONE_TEXT = WorldclockData.INVALID_TIMEZONE_TEXT;
const timezoneFromIdentifier = WorldclockData.timezoneFromIdentifier;
const LOCAL_TIMEZONE = WorldclockData.LOCAL_TIMEZONE;
// how often the local zone is re-read from the system; the popup shows minutes
const LOCAL_TIMEZONE_RECHECK_SECONDS = 60;
const builtinClocks = WorldclockData.builtinClocks;
const timezoneIdentity = WorldclockData.timezoneIdentity;
const selectUserClocks = WorldclockData.selectUserClocks;

var Worldclocks = class Worldclocks {
    constructor(box) {
        this.clocks = [];
        this.format = "%H:%M";

        this.layout = new Clutter.GridLayout();
        this.actor = new St.Widget({
            layout_manager: this.layout,
            style_class: "calendar calendar-world-list",
            reactive: false,
            x_expand: true });
        box.add_actor(this.actor);
    }

    _formatTime(time) {
        return time.format(this.format).trim();
    }

    buildClocks(clocks, format) {
        this.format = format || "%H:%M";
        this.actor.destroy_all_children();
        this.clocks = [];

        // UTC and the local time are always shown; configured clocks follow.
        // Which of them count is worldclockData's answer, and the weather side
        // asks the same function — it used to have its own, different one.
        const builtins = builtinClocks();
        const rows = builtins.concat(selectUserClocks(clocks));

        rows.forEach((item, i) => {
            let tz = timezoneFromIdentifier(item.timezone);
            let builtin = i < builtins.length;

            // The display name is free text from the settings dialog, and this
            // label had no max-width, no ellipsize and no tooltip — so a long one
            // ("Mom's place in Buenos Aires") widened the whole popup and pushed
            // the calendar grid across the screen. The 24-character clamp applies
            // to the *panel* label, not to this one.
            let label = new St.Label({
                text: item.label,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                style_class: "calendar-world-label"
            });
            label.get_clutter_text().ellipsize = Pango.EllipsizeMode.END;
            // ellipsized text is text the user cannot read: the hover gives it back
            new Tooltips.Tooltip(label, item.label);
            this.layout.attach(label, 0, i, 1, 1);

            let display = new St.Label({
                x_align: Clutter.ActorAlign.END,
                style_class: tz ? "calendar-world-time" : "calendar-world-time calendar-world-time-invalid"
            });
            this.layout.attach(display, 1, i, 1, 1);

            // The temperature the settings dialog promises "beside each world
            // clock". It existed in the row's accessible name and in the panel's
            // mouse tooltip, and nowhere a user could look at: open the menu with
            // the hotkey, or on a touchscreen, and the rows were bare times.
            let weather = new St.Label({
                x_align: Clutter.ActorAlign.END,
                style_class: "calendar-world-weather"
            });
            this.layout.attach(weather, 2, i, 1, 1);

            this.clocks.push({
                label: item.label, timezone: item.timezone, display, weather, tz, builtin,
                rendered_time: null, rendered_name: null, rendered_weather: null
            });
        });
    }

    // The format decides how a time is *rendered*; the clock list decides what
    // actors exist. Only the second one needs actors rebuilt, and the two were
    // conflated: updateFormatString() called buildClocks(), and Cinnamon fires
    // a text entry's changed signal on every keystroke — so typing a
    // 20-character custom format destroyed and rebuilt every label, re-resolved
    // every GLib.TimeZone and relaid out the menu subtree twenty times, on the
    // compositor thread.
    setFormat(format) {
        const next = format || "%H:%M";
        if (next === this.format) {
            return;
        }
        this.format = next;

        // the rendered text is compared against the last one written, and the
        // format under it just moved
        for (const clock of this.clocks) {
            clock.rendered_time = null;
        }
    }

    setVisible(visible) {
        if (visible) {
            this.actor.show();
        } else {
            this.actor.hide();
        }
    }

    // The zones are resolved once, when the clocks are built, and the local one
    // is whatever /etc/localtime said at that moment. A user who travels and
    // changes the system timezone keeps seeing the old offset in the popup
    // while the panel clock - which rides CinnamonDesktop.WallClock - moves: the
    // same applet, disagreeing with itself. Re-resolving it every tick would
    // build a GLib.TimeZone a second; the popup shows minutes, so once a minute
    // is enough to be right and cheap enough to not matter.
    _refreshLocalTimezone(nowSeconds) {
        if (this._local_tz_checked_at !== undefined &&
            nowSeconds - this._local_tz_checked_at < LOCAL_TIMEZONE_RECHECK_SECONDS) {
            return;
        }
        this._local_tz_checked_at = nowSeconds;

        const local = timezoneFromIdentifier(LOCAL_TIMEZONE);
        const identity = timezoneIdentity(local);

        for (const clock of this.clocks) {
            if (clock.builtin && clock.timezone === LOCAL_TIMEZONE &&
                timezoneIdentity(clock.tz) !== identity) {
                clock.tz = local;
                // the text is compared against the last one written; the zone
                // moved under it, so it has to be written again
                clock.rendered_time = null;
            }
        }
    }

    getClockEntries() {
        const time = GLib.DateTime.new_now_utc();
        this._refreshLocalTimezone(time.to_unix ? time.to_unix() : 0);

        return this.clocks.map((clock) => {
            const localTime = clock.tz ? time.to_timezone(clock.tz) : null;
            const text = localTime ? this._formatTime(localTime) : INVALID_TIMEZONE_TEXT;
            return {
                clock,
                label: clock.label,
                timezone: clock.timezone,
                time: text,
                localTime,
                builtin: clock.builtin
            };
        });
    }

    updateClocks (entries = this.getClockEntries()) {
        for (const entry of entries) {
            const clock = entry.clock;
            const text = entry.time;

            // a tick is a change in the *panel* clock's rendered string, and a
            // zone on a half-hour offset rolls its minute somewhere else in the
            // hour — so a tick is not news for every clock in the table
            if (clock.rendered_time !== text) {
                clock.rendered_time = text;
                clock.display.set_text(text);
            }

            // The city label beside this one is read from its own text, so a
            // name of "Tokyo 07:51" here made a screen reader say "Tokyo",
            // then "Tokyo 07:51". The row is a label and a time side by side:
            // the time cell says the time — plus this city's weather, which
            // otherwise existed only in the panel's mouse tooltip and so reached
            // neither a keyboard user nor a screen reader.
            const name = entry.weather ? joinPhrases(text, entry.weather) : text;
            if (clock.rendered_name !== name) {
                clock.rendered_name = name;
                if (clock.display.set_accessible_name) {
                    clock.display.set_accessible_name(name);
                }
            }

            // ...and the same reading, drawn. The accessible name carries the
            // condition in words as well; the cell is the temperature, which is
            // what the row has room for beside a time.
            const reading = entry.weather ? String(entry.weather).split(",")[0].trim() : "";
            if (clock.rendered_weather !== reading && clock.weather) {
                clock.rendered_weather = reading;
                clock.weather.set_text(reading);
            }
        }
    }

    // the service that answered is a courtesy the data providers are owed, and
    // it was named only in the tooltip
    setWeatherSource(source) {
        const name = source ? joinPhrases(_("World clocks"), _("Source: %s").replace("%s", source)) :
            _("World clocks");

        if (this._rendered_source === name) {
            return;
        }
        this._rendered_source = name;

        if (this.actor.set_accessible_name) {
            this.actor.set_accessible_name(name);
        }
    }
};

if (typeof module !== "undefined") {
    module.exports = { Worldclocks, MAX_CLOCKS };
}
