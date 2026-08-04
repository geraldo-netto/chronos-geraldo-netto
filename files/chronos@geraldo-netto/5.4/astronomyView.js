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
const LocaleText = imports.ui.appletManager.applets["chronos@geraldo-netto"].localeText;
const _ = LocaleText.translate;
const MISSING_EVENT_TIME = "—";

function localDayBounds(now) {
    if (!now || typeof now.getTime !== "function" || !Number.isFinite(now.getTime())) {
        return null;
    }
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { startMs: start.getTime(), endMs: end.getTime() };
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

function defaultFormatTime(timestamp, use24h) {
    const local = GLib.DateTime.new_from_unix_local(Math.floor(timestamp / 1000));
    if (!local) {
        return "";
    }
    return local.format(use24h ? "%H:%M" : "%-l:%M %p") || "";
}

class AstronomyView {
    constructor(box, params = {}) {
        this._calculate = params.calculate || Astronomy.calculateAstronomyEvents;
        this._formatTime = params.formatTime || defaultFormatTime;
        this._now = params.now || (() => new Date());
        this._renderedKey = "";

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

    _render(events, use24h) {
        const formatTime = (timestamp) => this._formatTime(timestamp, use24h);
        this.sunLabel.set_text(bodyLine(events.sun,
            _("Sunrise: %s — Sunset: %s"),
            _("Sun is above the horizon all day"),
            _("Sun is below the horizon all day"), formatTime));
        this.moonLabel.set_text(bodyLine(events.moon,
            _("Moonrise: %s — Moonset: %s"),
            _("Moon is above the horizon all day"),
            _("Moon is below the horizon all day"), formatTime));
    }

    update({ visible, place, use24h }) {
        const latitude = place ? place.latitude : null;
        const longitude = place ? place.longitude : null;
        const bounds = visible && Astronomy.validCoordinates(latitude, longitude) ?
            localDayBounds(this._now()) : null;
        if (!bounds) {
            this.actor.hide();
            return;
        }

        const key = [bounds.startMs, bounds.endMs, latitude, longitude, Boolean(use24h)].join("|");
        if (key !== this._renderedKey) {
            const events = this._calculate(
                bounds.startMs, bounds.endMs, latitude, longitude);
            if (!events) {
                this.actor.hide();
                return;
            }
            this._render(events, Boolean(use24h));
            this._renderedKey = key;
        }
        this.actor.show();
    }
}

if (typeof module !== "undefined") {
    module.exports = {
        AstronomyView,
        MISSING_EVENT_TIME,
        localDayBounds,
        replaceTimes,
        bodyLine,
        defaultFormatTime
    };
}
