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
// Shown instead of nothing when the resolved place carries no timezone of
// its own: the rows are then the viewer's clock, not the place's.
const ZONE_FALLBACK_TEXT = _("Times shown in this computer's time zone");

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
        this._local_timezone = null;
        this._dayCache = null;

        this.actor = new St.BoxLayout({
            vertical: true,
            visible: false,
            x_align: Clutter.ActorAlign.START,
            style_class: "calendar-astronomy"
        });
        this.zoneLabel = new St.Label({
            style_class: "calendar-astronomy-row",
            visible: false
        });
        this.zoneLabel.get_clutter_text().line_wrap = true;
        this.actor.add_actor(this.zoneLabel);
        this.sunLabel = new St.Label({ style_class: "calendar-astronomy-row" });
        this.moonLabel = new St.Label({ style_class: "calendar-astronomy-row" });
        this.sunLabel.get_clutter_text().line_wrap = true;
        this.moonLabel.get_clutter_text().line_wrap = true;
        this.actor.add_actor(this.sunLabel);
        this.actor.add_actor(this.moonLabel);
        box.add_actor(this.actor);
    }

    // `resolved` is false when the zone below is the viewer's own rather than
    // the place's. The times are then a different city's clock read off this
    // one, which the rows have to say — see _render.
    _placeTimezone(identifier) {
        const key = typeof identifier === "string" ? identifier.trim() : "";
        if (key === this._timezoneKey && this._timezone) {
            return { timezone: this._timezone, resolved: true };
        }
        const timezone = key ? WorldclockData.timezoneFromIdentifier(key) : null;
        if (timezone) {
            this._timezoneKey = key;
            this._timezone = timezone;
            return { timezone, resolved: true };
        }
        return { timezone: this._localTimezone(), resolved: false };
    }

    // update() runs on every clock notify while the menu is open, and this used
    // to build a fresh GLib.TimeZone on each one.
    _localTimezone() {
        if (!this._local_timezone) {
            this._local_timezone =
                WorldclockData.timezoneFromIdentifier(WorldclockData.LOCAL_TIMEZONE);
        }
        return this._local_timezone;
    }

    // The OS zone moved under us. The named-zone memo above survives it — an
    // IANA identifier does not start meaning somewhere else — but the fallback
    // is *this machine's* zone, which is precisely what changed, so the rows
    // would go on showing a city's sunrise in the old offset for the rest of
    // the session. Worldclocks re-reads the same zone once a minute for this
    // reason; the calendar grid and the event index are reset from the same
    // signal.
    //
    // Only the memo is dropped. _renderedKey already carries the resolved
    // zone's identity, so the next update() sees a different key and redraws on
    // its own; clearing it here as well would be a second reset that no input
    // can distinguish from this one.
    refreshTimezone() {
        this._local_timezone = null;
    }

    _render(events, use24h, day) {
        const timezone = day.timezone;
        const formatTime = (timestamp) => this._formatTime(timestamp, use24h, timezone);
        // Neither geocoder could name the place's zone and the forecast did not
        // either, so these are the viewer's own hours applied to somebody else's
        // sky. Silently substituting them made the same city read differently
        // depending on which service had answered.
        this.zoneLabel.set_text(day.zoneResolved ? "" : ZONE_FALLBACK_TEXT);
        this.zoneLabel.visible = !day.zoneResolved;
        this.sunLabel.set_text(bodyLine(events.sun,
            _("Sunrise: %s — Sunset: %s"),
            _("Sun is above the horizon all day"),
            _("Sun is below the horizon all day"), formatTime));
        this.moonLabel.set_text(bodyLine(events.moon,
            _("Moonrise: %s — Moonset: %s"),
            _("Moon is above the horizon all day"),
            _("Moon is below the horizon all day"), formatTime));
    }

    // A day's bounds are only the day's bounds while the clock is inside them,
    // which is the whole validity rule — no separate key is needed, and none
    // could be cheaper than the answer it would be guarding.
    _cachedBounds(key, nowMs) {
        const cached = this._dayCache;
        if (!cached || cached.key !== key) {
            return null;
        }

        return nowMs >= cached.bounds.startMs && nowMs < cached.bounds.endMs ?
            cached.bounds : null;
    }

    // update() runs on every clock notify while the menu is open, and this used
    // to run in front of the render memo rather than behind it: four
    // GLib.DateTimes per tick — new_from_unix_utc, to_timezone, new() and
    // add_days — for a value that changes once a civil day.
    _civilDay(timezone) {
        const now = this._now();
        const key = WorldclockData.timezoneIdentity(timezone) || "";
        const nowMs = now && typeof now.getTime === "function" ? // NOSONAR [S6582] -- accepted compatible form
            now.getTime() : NaN;
        const cached = this._cachedBounds(key, nowMs);
        if (cached) {
            return cached;
        }

        const bounds = this._dayBounds(now, timezone);
        this._dayCache = bounds ? { key, bounds } : null;
        return bounds;
    }

    _observerDay(visible, place) {
        if (!visible || !place ||
            !Astronomy.validCoordinates(place.latitude, place.longitude)) {
            return null;
        }
        const zone = this._placeTimezone(place.timezone);
        const bounds = zone.timezone ? this._civilDay(zone.timezone) : null;
        if (!bounds || !Astronomy.validDayBounds(bounds.startMs, bounds.endMs)) {
            return null;
        }
        return {
            latitude: place.latitude,
            longitude: place.longitude,
            timezone: zone.timezone,
            zoneResolved: zone.resolved,
            bounds
        };
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
            timezoneKey, day.zoneResolved, Boolean(use24h)].join("|");
        if (key !== this._renderedKey) {
            const events = this._calculate(
                bounds.startMs, bounds.endMs, latitude, longitude);
            if (!events) {
                this.actor.hide();
                return;
            }
            this._render(events, Boolean(use24h), day);
            this._renderedKey = key;
        }
        this.actor.show();
    }
}

if (typeof module !== "undefined") {
    module.exports = {
        AstronomyView,
        MISSING_EVENT_TIME,
        ZONE_FALLBACK_TEXT,
        zonedDateTime,
        civilDayBounds,
        replaceTimes,
        bodyLine,
        defaultFormatTime
    };
}
