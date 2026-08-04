// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* global imports */

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Astronomy = require("./astronomy");
const AppletModules = imports.ui.appletManager.applets["chronos@geraldo-netto"];
const LocaleText = AppletModules.localeText;
const WorldclockData = AppletModules.worldclockData;
const _ = LocaleText.translate;
const MISSING_EVENT_TIME = "—";

function zonedDateTime(timestamp, timezone) {
    if (!Number.isFinite(timestamp) || !timezone) {
        return null;
    }
    const utc = GLib.DateTime.new_from_unix_utc(Math.floor(timestamp / 1000));
    return utc ? utc.to_timezone(timezone) : null;
}

function civilDayBounds(now, timezone) {
    if (!now || typeof now.getTime !== "function" || !Number.isFinite(now.getTime())) {
        return null;
    }
    const placeNow = zonedDateTime(now.getTime(), timezone);
    if (!placeNow) {
        return null;
    }
    const start = GLib.DateTime.new(timezone,
        placeNow.get_year(), placeNow.get_month(), placeNow.get_day_of_month(), 0, 0, 0);
    const end = start ? start.add_days(1) : null;
    if (!start || !end) {
        return null;
    }
    const bounds = { startMs: start.to_unix() * 1000, endMs: end.to_unix() * 1000 };
    return Astronomy.validDayBounds(bounds.startMs, bounds.endMs) ? bounds : null;
}

function replaceTimes(template, rise, set) {
    return template.replace("%s", rise).replace("%s", set);
}

function bodyLine(body, riseTemplate, alwaysUpText, alwaysDownText, formatTime) {
    if (body.state === "alwaysUp") {
        return alwaysUpText;
    }
    if (body.state === "alwaysDown") {
        return alwaysDownText;
    }
    const rise = body.rise === null ? MISSING_EVENT_TIME : formatTime(body.rise);
    const set = body.set === null ? MISSING_EVENT_TIME : formatTime(body.set);
    return replaceTimes(riseTemplate, rise || MISSING_EVENT_TIME, set || MISSING_EVENT_TIME);
}

function defaultFormatTime(timestamp, use24h, timezone) {
    const placeTime = zonedDateTime(timestamp, timezone);
    if (!placeTime) {
        return "";
    }
    return placeTime.format(use24h ? "%H:%M" : "%-l:%M %p") || "";
}

class AstronomyView {
    constructor(box, params = {}) {
        this._calculate = params.calculate || Astronomy.calculateAstronomyEvents;
        this._formatTime = params.formatTime || defaultFormatTime;
        this._dayBounds = params.dayBounds || civilDayBounds;
        this._now = params.now || (() => new Date());
        this._renderedKey = "";
        this._timezoneKey = "";
        this._timezone = null;

        this.actor = new St.BoxLayout({
            vertical: true,
            visible: false,
            x_align: Clutter.ActorAlign.START,
            style_class: "calendar-astronomy"
        });
        this.sunLabel = new St.Label({ style_class: "calendar-astronomy-row" });
        this.moonLabel = new St.Label({ style_class: "calendar-astronomy-row" });
        this.sunLabel.get_clutter_text().line_wrap = true;
        this.moonLabel.get_clutter_text().line_wrap = true;
        this.actor.add_actor(this.sunLabel);
        this.actor.add_actor(this.moonLabel);
        box.add_actor(this.actor);
    }

    _placeTimezone(identifier) {
        const key = typeof identifier === "string" ? identifier.trim() : "";
        if (key && key === this._timezoneKey) {
            return this._timezone;
        }
        const timezone = key ? WorldclockData.timezoneFromIdentifier(key) : null;
        if (timezone) {
            this._timezoneKey = key;
            this._timezone = timezone;
            return timezone;
        }
        return WorldclockData.timezoneFromIdentifier(WorldclockData.LOCAL_TIMEZONE);
    }

    _render(events, use24h, timezone) {
        const formatTime = (timestamp) => this._formatTime(timestamp, use24h, timezone);
        this.sunLabel.set_text(bodyLine(events.sun,
            _("Sunrise: %s — Sunset: %s"),
            _("Sun is above the horizon all day"),
            _("Sun is below the horizon all day"), formatTime));
        this.moonLabel.set_text(bodyLine(events.moon,
            _("Moonrise: %s — Moonset: %s"),
            _("Moon is above the horizon all day"),
            _("Moon is below the horizon all day"), formatTime));
    }

    _observerDay(visible, place) {
        if (!visible || !place ||
            !Astronomy.validCoordinates(place.latitude, place.longitude)) {
            return null;
        }
        const timezone = this._placeTimezone(place.timezone);
        const bounds = timezone ? this._dayBounds(this._now(), timezone) : null;
        if (!bounds || !Astronomy.validDayBounds(bounds.startMs, bounds.endMs)) {
            return null;
        }
        return { latitude: place.latitude, longitude: place.longitude, timezone, bounds };
    }

    update({ visible, place, use24h }) {
        const day = this._observerDay(visible, place);
        if (!day) {
            this.actor.hide();
            return;
        }
        const { latitude, longitude, timezone, bounds } = day;
        const timezoneKey = WorldclockData.timezoneIdentity(timezone) || "";
        const key = [bounds.startMs, bounds.endMs, latitude, longitude,
            timezoneKey, Boolean(use24h)].join("|");
        if (key !== this._renderedKey) {
            const events = this._calculate(
                bounds.startMs, bounds.endMs, latitude, longitude);
            if (!events) {
                this.actor.hide();
                return;
            }
            this._render(events, Boolean(use24h), timezone);
            this._renderedKey = key;
        }
        this.actor.show();
    }
}

if (typeof module !== "undefined") {
    module.exports = {
        AstronomyView,
        MISSING_EVENT_TIME,
        zonedDateTime,
        civilDayBounds,
        replaceTimes,
        bodyLine,
        defaultFormatTime
    };
}
