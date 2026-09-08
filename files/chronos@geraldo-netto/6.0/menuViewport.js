// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* global imports */

const St = imports.gi.St;
const Pango = imports.gi.Pango;
const MenuLayout = require("./menuLayout");

function horizontalInset(actor) {
    const node = actor.get_theme_node();
    return node.get_horizontal_padding() + node.get_border_width(St.Side.LEFT) +
        node.get_border_width(St.Side.RIGHT);
}

function verticalInset(actor) {
    const node = actor.get_theme_node();
    return node.get_vertical_padding() + node.get_border_width(St.Side.TOP) +
        node.get_border_width(St.Side.BOTTOM);
}

function revealAxis(adjustment, position, length) {
    const previous = adjustment.get_value();
    adjustment.clamp_page(position, position + length);
    return previous - adjustment.get_value();
}

// The menu owns the actors; this owns the focus and scrollbar connections.
class MenuViewport {
    constructor(menu, content, bodySection, stage = global.stage) {
        this._menu = menu;
        this._content = content;
        this._bodySection = bodySection;
        this._stage = stage;
        this._connections = [];
        this._scrolling = new Set();
        this._footer = null;
        this.actor = new St.ScrollView({
            style_class: "calendar-body-viewport",
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            clip_to_allocation: true,
            x_expand: true
        });
        this.actor.add_actor(content);
        for (const bar of [this.actor.get_hscroll_bar(), this.actor.get_vscroll_bar()]) {
            this._connect(bar, "scroll-start", () => this._setScrolling(bar, true));
            this._connect(bar, "scroll-stop", () => this._setScrolling(bar, false));
        }
        this._connect(stage, "notify::key-focus", () => this.revealFocus());
        // Reflow queues allocation before the applet focuses today's cell.
        // Reveal it again once the new viewport geometry is actually allocated.
        this._connect(this.actor, "notify::allocation", () => this.revealFocus());
    }

    _connect(actor, signal, callback) {
        this._connections.push([actor, actor.connect(signal, callback)]);
    }

    _setScrolling(bar, scrolling) {
        if (scrolling) {
            this._scrolling.add(bar);
        } else {
            this._scrolling.delete(bar);
        }
        this._menu.passEvents = this._scrolling.size > 0;
    }

    setFooter(item, issueLabel) {
        this._footer = item;
        this._issueLabel = issueLabel;
        for (const label of [item.label, issueLabel]) {
            const text = label.get_clutter_text();
            text.single_line_mode = false;
            text.line_wrap = true;
            text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            text.ellipsize = Pango.EllipsizeMode.NONE;
        }
    }

    _constrainFooter(budget, scale) {
        if (!this._footer) {
            return;
        }
        const item = this._footer;
        const columns = item.getColumnWidths();
        const [, labelWidth] = item.label.get_preferred_width(-1);
        const ornaments = Math.max(0, columns.reduce((total, width) => total + width, 0) - labelWidth);
        const spacing = Math.max(0, columns.length - 1) * item.actor.get_theme_node().get_length("spacing");
        const insets = [this._menu.actor, this._menu.box, item.actor]
            .reduce((total, actor) => total + horizontalInset(actor), 0);
        const width = Math.max(1, Math.floor((budget.width - insets - ornaments - spacing) / scale));
        for (const label of [item.label, this._issueLabel]) {
            label.set_style(`max-width: ${width}px;`);
        }
        // PopupMenu reuses column widths across siblings, including separators.
        // Their minimum-size caches must not retain a previous wide warning.
        for (const actor of this._menu.box.get_children()) {
            actor.queue_relayout();
        }
    }

    constrain(metrics) {
        if (!MenuLayout.menuLayoutMeasured(metrics)) {
            return;
        }
        // St CSS pixels scale with ui_scale; native preferred sizes do not.
        this.actor.set_style(null);
        const budget = MenuLayout.menuLayoutBudget(metrics);
        this._constrainFooter(budget, metrics.uiScale);
        const { width, height } = this._bodyBudget(budget);
        this.actor.set_style(`max-width: ${Math.floor(width / metrics.uiScale)}px; ` +
            `max-height: ${Math.floor(height / metrics.uiScale)}px;`);
    }

    _bodyBudget(budget) {
        // Resolve PopupMenu's shared column widths before measuring its rows.
        this._menu.actor.get_preferred_width(-1);
        const parents = [this._menu.actor, this._menu.box, this._bodySection];
        const width = Math.max(1, budget.width - parents.reduce(
            (total, actor) => total + horizontalInset(actor), 0));
        const rows = this._menu.box.get_children().filter(
            (actor) => actor.visible && actor !== this._bodySection);
        const rowHeight = rows.reduce(
            (total, actor) => total + actor.get_preferred_height(width)[1], 0);
        const spacing = rows.length * this._menu.box.get_theme_node().get_length("spacing");
        const chrome = parents.reduce((total, actor) => total + verticalInset(actor), 0);
        return { width, height: Math.max(1, budget.height - rowHeight - spacing - chrome) };
    }

    revealFocus() {
        const focus = this._stage.get_key_focus();
        if (!this._menu.isOpen || !focus || !this._content.contains(focus)) {
            return;
        }
        const [x, y] = focus.get_transformed_position();
        const [width, height] = focus.get_transformed_size();
        const rectangle = { x, y, width, height };
        // An agenda row may also be clipped by its own list viewport. Reveal
        // inner scroll views first and carry their pending movement outward;
        // adjustment writes queue allocation, so native transforms still show
        // the old position until the next frame.
        for (let actor = focus.get_parent(); actor !== this.actor; actor = actor.get_parent()) {
            if (actor instanceof St.ScrollView) {
                this._revealInViewport(actor, rectangle);
            }
        }
        this._revealInViewport(this.actor, rectangle);
    }

    _revealInViewport(viewport, rectangle) {
        const [originX, originY] = viewport.get_child().get_transformed_position();
        rectangle.x += revealAxis(viewport.get_hscroll_bar().get_adjustment(),
            rectangle.x - originX, rectangle.width);
        rectangle.y += revealAxis(viewport.get_vscroll_bar().get_adjustment(),
            rectangle.y - originY, rectangle.height);
    }

    destroy() {
        for (const [actor, id] of this._connections) {
            actor.disconnect(id);
        }
        this._connections = [];
        this._scrolling.clear();
        this._menu.passEvents = false;
    }
}

if (typeof module !== "undefined") {
    module.exports = { MenuViewport };
}
