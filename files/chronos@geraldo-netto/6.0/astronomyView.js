// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* global imports */

// The guard is what keeps a host that exposes only globalThis.imports from
// ReferenceError-ing at load; a file that used it on half its lines would have
// the appearance of protection and none of it.
const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const Clutter = GjsImports.gi.Clutter;
const GLib = GjsImports.gi.GLib;
const St = GjsImports.gi.St;
const Astronomy = require("./astronomy");
const AppletModules = GjsImports.ui.appletManager.applets["chronos@geraldo-netto"];
const LocaleText = AppletModules.localeText;
// through the 6.0 shim, as worldclocks.js, appletCoordinators.js and
// appletPanelStatus.js do: the shims are the seam where a future version tree
// adapts a root module for its Cinnamon version, so a file that reaches past
// them keeps the unadapted root while its siblings pick the adaptation up, and
// nothing fails.
const WorldclockData = require("./worldclockData");
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

function bodyRows(body, riseLabel, setLabel, alwaysUpText, alwaysDownText, formatTime) {
    if (body.state === "alwaysUp") {
        return [{ status: alwaysUpText }];
    }
    if (body.state === "alwaysDown") {
        return [{ status: alwaysDownText }];
    }
    const rise = body.rise === null ? MISSING_EVENT_TIME : formatTime(body.rise);
    const set = body.set === null ? MISSING_EVENT_TIME : formatTime(body.set);
    return [
        { label: riseLabel, value: rise || MISSING_EVENT_TIME },
        { label: setLabel, value: set || MISSING_EVENT_TIME }
    ];
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
            style_class: "calendar-astronomy-zone",
            visible: false
        });
        this.zoneLabel.get_clutter_text().line_wrap = true;
        this.actor.add_actor(this.zoneLabel);
        this.grid = new St.Table({
            homogeneous: false,
            style_class: "calendar-astronomy-grid"
        });
        this.actor.add_actor(this.grid);
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

    // The same seam Worldclocks.destroy() describes, for the same reason: the
    // three labels die with the menu, the memos behind them are this view's own
    // and the applet outlives its removal from the panel — the place's
    // GLib.TimeZone, this machine's, and a civil day's bounds. refreshTimezone
    // above already drops one of them on its own signal; this drops the set.
    destroy() {
        this._renderedKey = "";
        this._timezoneKey = "";
        this._timezone = null;
        this._local_timezone = null;
        this._dayCache = null;
    }

    _cell(text, styleClass) {
        const label = new St.Label({ style_class: styleClass });
        label.set_text(text);
        label.get_clutter_text().line_wrap = true;
        return label;
    }

    _renderRows(rows) {
        this.grid.destroy_all_children();
        for (let row = 0; row < rows.length; row++) {
            const entry = rows[row];
            const moonClass = entry.moonStart ? " calendar-astronomy-moon-cell" : "";
            if (entry.status) {
                this.grid.add(this._cell(entry.status,
                    "calendar-astronomy-status" + moonClass), {
                    row,
                    col: 0,
                    col_span: 2,
                    x_fill: true,
                    x_align: St.Align.START
                });
                continue;
            }

            this.grid.add(this._cell(entry.label,
                "calendar-astronomy-event" + moonClass), {
                row,
                col: 0,
                x_fill: false,
                x_align: St.Align.START
            });
            this.grid.add(this._cell(entry.value,
                "calendar-astronomy-value" + moonClass), {
                row,
                col: 1,
                x_fill: true,
                x_align: St.Align.END
            });
        }
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
        const sunRows = bodyRows(events.sun,
            _("Sunrise"), _("Sunset"),
            _("Sun is above the horizon all day"),
            _("Sun is below the horizon all day"), formatTime);
        const moonRows = bodyRows(events.moon,
            _("Moonrise"), _("Moonset"),
            _("Moon is above the horizon all day"),
            _("Moon is below the horizon all day"), formatTime);
        if (moonRows.length) {
            moonRows[0].moonStart = true;
        }
        this._renderRows(sunRows.concat(moonRows));
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
            now.getTime() : Number.NaN;
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
        bodyRows,
        defaultFormatTime
    };
}
