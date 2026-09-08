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
// same-dir shim like every other 6.0 module: it hands back the single
// importer-loaded root module instead of a second CJS copy of it
const WorldclockData = require("./worldclockData");
const DateFormats = require("./dateFormats");
const ElapsedTime = require("./elapsedTime");
const LocaleText = require("./localeText");
const TextUtils = require("./textUtils");

const _ = LocaleText.translate;
const joinPhrases = LocaleText.joinPhrases;
const fillTemplate = TextUtils.fillTemplate;

const MAX_CLOCKS = WorldclockData.MAX_CLOCKS;
const INVALID_TIMEZONE_TEXT = WorldclockData.INVALID_TIMEZONE_TEXT;
const timezoneFromIdentifier = WorldclockData.timezoneFromIdentifier;
const LOCAL_TIMEZONE = WorldclockData.LOCAL_TIMEZONE;
// how often the local zone is re-read from the system; the popup shows minutes
const LOCAL_TIMEZONE_RECHECK_SECONDS = 60;
const builtinClocks = WorldclockData.builtinClocks;
const timezoneIdentity = WorldclockData.timezoneIdentity;
const selectUserClocks = WorldclockData.selectUserClocks;
const clockDisplayLabel = WorldclockData.clockDisplayLabel;

var Worldclocks = class Worldclocks { // NOSONAR [S3504] -- GJS importer export
    constructor(box, params = {}) {
        this.clocks = [];
        this._destroyed = false;
        this.format = "%H:%M";
        this._elapsed_now = params.elapsedNow || ElapsedTime.monotonicSeconds;
        this._onTimezoneChanged = params.onTimezoneChanged || null;

        this.layout = new Clutter.GridLayout();
        this.actor = new St.Widget({
            layout_manager: this.layout,
            style_class: "calendar calendar-world-list",
            reactive: false,
            x_expand: true });
        box.add_actor(this.actor);
    }

    _formatTime(time) {
        return DateFormats.clampClockStamp(time.format(this.format) || "").trim();
    }

    buildClocks(clocks) {
        if (this._destroyed) {
            return;
        }
        this.actor.destroy_all_children();
        this.clocks = [];
        // remembered so the timezone recheck below can re-run this exact call:
        // re-resolving the local zone in place is not enough, because which
        // configured rows survive selectUserClocks depends on that zone
        this._configured_clocks = clocks;
        this._local_tz_identity = timezoneIdentity(timezoneFromIdentifier(LOCAL_TIMEZONE));

        // UTC and the local time are always shown; configured clocks follow.
        // Which of them count is worldclockData's answer, and the weather side
        // asks the same function — it used to have its own, different one.
        const builtins = builtinClocks();
        const rows = builtins.concat(selectUserClocks(clocks));

        rows.forEach((item, i) => {
            let tz = timezoneFromIdentifier(item.timezone);
            let builtin = i < builtins.length;
            const fullLabel = item.label;
            const visibleLabel = builtin ? fullLabel : clockDisplayLabel(fullLabel);

            // The display name is free text from the settings dialog, and this
            // label had no max-width, no ellipsize and no tooltip — so a long one
            // ("Mom's place in Buenos Aires") widened the whole popup and pushed
            // the calendar grid across the screen. The clamp above is
            // worldclockData's MAX_CLOCK_LABEL_CELLS, which exists for this
            // label; see the note there for why it is counted in cells.
            let label = new St.Label({
                text: visibleLabel,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                style_class: "calendar-world-label"
            });
            label.get_clutter_text().ellipsize = Pango.EllipsizeMode.END;
            // ellipsized text is text the user cannot read: the hover gives it back
            new Tooltips.Tooltip(label, fullLabel); // NOSONAR [S1848] -- constructor registers handlers
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
                label: visibleLabel, full_label: fullLabel, timezone: item.timezone,
                display, weather, tz, builtin,
                rendered_time: null, rendered_name: null, rendered_weather: null
            });
        });
    }

    // The actors go with the menu, but the rows above do not, and the applet
    // that holds this view outlives its removal from the panel: up to ten
    // records, each keeping a GLib.TimeZone alive and three St.Label handles
    // that are about to be disposed. Dropping them also leaves updateClocks and
    // getClockEntries nothing to walk, so a tick that arrives after teardown
    // cannot write into one of those labels — the same property the footer
    // reporter's detach() is there for.
    //
    // The seam matters more than today's bytes: every other menu component
    // states in its own comment why it must release, and without one here the
    // first timer or signal this view acquires has nowhere to be torn down.
    //
    // And the release is a state, not just a clear: every public method above
    // short-circuits on `_destroyed`. Nothing calls one today, but the applet's
    // teardown isolates each step, so a throw partway through leaves the menu's
    // actors disposed while `applet._worldclocks` still points here — and the
    // methods would then write into freed St.Labels.
    destroy() {
        this._destroyed = true;
        this.clocks = [];
        // and nothing may rebuild them afterwards: the recheck below goes
        // through buildClocks, which would attach fresh actors to an actor the
        // menu is disposing
        this._configured_clocks = null;
        this._onTimezoneChanged = null;
    }

    // The format decides how a time is *rendered*; the clock list decides what
    // actors exist. Only the second one needs actors rebuilt, and the two were
    // conflated: updateFormatString() called buildClocks(), and Cinnamon fires
    // a text entry's changed signal on every keystroke — so typing a
    // 20-character custom format destroyed and rebuilt every label, re-resolved
    // every GLib.TimeZone and relaid out the menu subtree twenty times, on the
    // compositor thread.
    setFormat(format) {
        if (this._destroyed) {
            return;
        }
        const next = DateFormats.dateFormatOrDefault(format || "%H:%M", "%H:%M"); // NOSONAR [S7760] -- accepted compatible form
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
        if (this._destroyed) {
            return;
        }
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
    // same applet, disagreeing with itself. The applet subscribes to
    // org.freedesktop.timedate1 and rebuilds on its PropertiesChanged, so this
    // poll is only the fallback for a session where that signal never arrives.
    //
    // It used to swap `clock.tz` in place, which is *less* than the rebuild the
    // signal path does: which configured rows exist depends on the local zone
    // too - selectUserClocks drops a configured clock that collides with the
    // built-in local row - so a zone change that makes a row a duplicate, or
    // stops it being one, has to re-select, not just re-resolve. Left in place,
    // the popup drew the same zone twice or silently dropped a clock until
    // something else forced a rebuild. So the fallback now runs the same
    // buildClocks path the signal does.
    //
    // Re-resolving on every tick would build a GLib.TimeZone a second; the
    // popup shows minutes, so once a minute is enough to be right and cheap
    // enough to not matter.
    _refreshLocalTimezone(nowSeconds = this._elapsed_now()) {
        const elapsed = nowSeconds - this._local_tz_checked_elapsed;
        if (this._local_tz_checked_elapsed !== undefined &&
            Number.isFinite(elapsed) && elapsed >= 0 &&
            elapsed < LOCAL_TIMEZONE_RECHECK_SECONDS) {
            return;
        }
        this._local_tz_checked_elapsed = nowSeconds;
        if (!this._configured_clocks) {
            return;
        }

        const identity = timezoneIdentity(timezoneFromIdentifier(LOCAL_TIMEZONE));
        if (identity === this._local_tz_identity) {
            return;
        }
        this.refreshTimezone();
        // The checked time and rebuilt identity are current before notifying
        // the owner, whose reconciliation may synchronously repaint this view.
        if (this._onTimezoneChanged) this._onTimezoneChanged();
    }

    // The one way the local zone is re-read: the timedate1 subscriber and the
    // fallback poll above both land here, so both do the whole job.
    refreshTimezone() {
        if (this._destroyed) {
            return;
        }
        if (this._configured_clocks) {
            this.buildClocks(this._configured_clocks);
        }
    }

    getClockEntries() {
        if (this._destroyed) {
            return [];
        }
        const time = GLib.DateTime.new_now_utc();
        this._refreshLocalTimezone();

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

    updateClocks (rows = this.getClockEntries()) {
        for (const row of rows) {
            this.renderRow(row.clock, row);
        }
    }

    // The row this view draws, declared where it is drawn.
    //
    // `time` is this view's own - getClockEntries builds it - and `weather` and
    // `temperature` are the presenter's. They used to arrive bolted onto the
    // entry object on the way back through the presenter, so this view read two
    // fields it never produced and that appear nowhere in its own contract.
    // Both were optional by absence, because with weather off the undecorated
    // entry came straight through: a rename or a typo on either side produced
    // no error at all, and the temperature column and the row's spoken weather
    // just went blank. That is the failure the comment below records having
    // been fixed once already - the fix corrected the consumer and left the
    // contract open.
    renderRow(clock, { time, weather = "", temperature = "" } = {}) {
        if (this._destroyed) {
            return;
        }
        const text = time;

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
        const name = weather ? joinPhrases(text, weather) : text;
        if (clock.rendered_name !== name) {
            clock.rendered_name = name;
            if (clock.display.set_accessible_name) {
                clock.display.set_accessible_name(name);
            }
        }

        // ...and the same reading, drawn. The accessible name carries the
        // condition in words as well; the cell is the temperature, which is
        // what the row has room for beside a time. The presenter hands it over
        // as its own field: reconstructing it from the joined string above put
        // a whole error sentence in this column whenever the fetch failed, and
        // truncated the reading at the first comma a translation happened to
        // contain.
        const reading = temperature;
        if (clock.rendered_weather !== reading && clock.weather) {
            clock.rendered_weather = reading;
            clock.weather.set_text(reading);
        }
    }

    // the service that answered is a courtesy the data providers are owed, and
    // it was named only in the tooltip
    setWeatherSource(source) {
        if (this._destroyed) {
            return;
        }
        const name = source ?
            joinPhrases(_("World clocks"), fillTemplate(_("Source: %s"), [source])) :
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
