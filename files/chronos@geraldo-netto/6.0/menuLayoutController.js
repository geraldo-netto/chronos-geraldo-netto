// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// Which shape the popup is in, and the decision to change it.
//
// menuLayout.js is the rule — a pure function of the work area, the scales and
// the two columns' natural sizes. This is the half that touches actors: it
// measures them, and it applies the answer by flipping one property.
//
// It lived in AppletMenuBuilder, whose own doc says it "builds the menu
// contents and hands them back" — while this runs on every menu open,
// orientation change, text-scale change and monitors-changed, long after the
// build returned. Constructed with the three actors it reads, so the reflow
// path can be exercised without building a menu.

const MenuLayout = require("./menuLayout");

const MAIN_BOX_STYLE_CLASS = "calendar-main-box";
const STACKED_STYLE_CLASS = "calendar-main-box-stacked";

class MenuLayoutController {
    constructor(actors = {}) {
        this._mainBox = actors.mainBox || null;
        this._calbox = actors.calbox || null;
        this._eventListActor = actors.eventListActor || null;
        this._layout = MenuLayout.MENU_LAYOUT_HORIZONTAL;
    }

    // The popup's two columns, measured as St would lay them out with no width
    // imposed on them. Cinnamon's own theme puts a 350 px floor under the event
    // column, and the translated strings and the current font size are already
    // in these numbers — which is why the layout rule reads a measurement and
    // not a table of guessed widths.
    _naturalSize(actor) {
        if (!actor || typeof actor.get_preferred_width !== "function") {
            return { width: 0, height: 0 };
        }
        const [, width] = actor.get_preferred_width(-1);
        const [, height] = actor.get_preferred_height(-1);
        return { width, height };
    }

    // The actors are measured at whatever text size is in effect, and the rule
    // wants them at the default one, so the factor comes back out here. That is
    // the seam: this method is the only thing that touches actors, everything
    // downstream of it is arithmetic.
    layoutMetrics(environment) {
        const environmentMetrics = MenuLayout.menuLayoutMetrics(environment);
        const textScale = environmentMetrics.textScale;
        const calendar = this._naturalSize(this._calbox);
        const events = this._naturalSize(this._eventListActor);

        return {
            workAreaWidth: environmentMetrics.workAreaWidth,
            workAreaHeight: environmentMetrics.workAreaHeight,
            uiScale: environmentMetrics.uiScale,
            textScale,
            calendarWidth: calendar.width / textScale,
            calendarHeight: calendar.height / textScale,
            eventsWidth: events.width / textScale,
            eventsHeight: events.height / textScale
        };
    }

    get layout() {
        return this._layout;
    }

    // One property changes, and nothing else. No actor is created, destroyed,
    // reparented or reordered, so the agenda's scroll position survives, the
    // children stay in the order the keyboard walks them in, and the calendar's
    // focused day and the event list's selected date are not even consulted —
    // a reflow cannot lose state it never touches.
    applyLayout(layout) {
        const stacked = MenuLayout.isStackedLayout(layout);
        this._layout = stacked ?
            MenuLayout.MENU_LAYOUT_STACKED : MenuLayout.MENU_LAYOUT_HORIZONTAL;

        const box = this._mainBox;
        if (!box || Boolean(box.vertical) === stacked) {
            return this._layout;
        }

        box.vertical = stacked;
        if (typeof box.set_style_class_name === "function") {
            box.set_style_class_name(stacked ?
                MAIN_BOX_STYLE_CLASS + " " + STACKED_STYLE_CLASS : MAIN_BOX_STYLE_CLASS);
        }
        return this._layout;
    }

    reflow(environment) {
        return this.applyLayout(MenuLayout.menuLayoutFor(this.layoutMetrics(environment)));
    }
}

if (typeof module !== "undefined") {
    module.exports = { MenuLayoutController };
}
