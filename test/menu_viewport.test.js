// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// SPDX-License-Identifier: GPL-2.0-or-later

const { assert, test, path, APPLET_DIR } = require("./helpers/appletFixture");
const { MenuViewport } = require(path.join(APPLET_DIR, "6.0", "menuViewport.js"));
const { MenuLayoutController } = require(path.join(APPLET_DIR, "6.0", "menuLayoutController.js"));

function viewportFixture() {
    const actor = (width, height, horizontalPadding = 0) => ({
        visible: true,
        get_preferred_width: () => [0, width],
        get_preferred_height: () => [0, height],
        set_style(style) { this.style = style; },
        get_theme_node: () => ({
            get_horizontal_padding: () => horizontalPadding,
            get_vertical_padding: () => 0,
            get_border_width: () => 0,
            get_length: () => 0
        })
    });
    const content = Object.assign(actor(1450, 1710), {
        vertical: false,
        set_style_class_name(style) { this.style_class = style; },
        get_transformed_position: () => [20, -400],
        contains: (focus) => focus.inside
    });
    const bodySection = actor(1450, 1710);
    const menu = {
        actor: actor(1530, 1800, 40),
        box: Object.assign(actor(1490, 1800, 40), {
            get_children: () => [bodySection, actor(1490, 90), { visible: false }]
        }),
        isOpen: true, passEvents: false
    };
    const stage = {
        connect(_name, callback) { this.callback = callback; return 1; },
        disconnect() { this.callback = null; },
        get_key_focus() { return this.focus; }
    };
    const viewport = new MenuViewport(menu, content, bodySection, stage);
    Object.assign(viewport.actor, actor(1450, 1710));
    const ranges = [];
    viewport.actor.bars.forEach((bar, axis) => {
        bar.get_adjustment = () => ({
            get_value: () => 0,
            clamp_page: (low, high) => ranges.push([axis, low, high])
        });
    });
    const agenda = actor(750, 636);
    const layout = new MenuLayoutController({
        mainBox: content, calbox: actor(700, 1074), eventListActor: agenda, viewport
    });
    return { viewport, layout, menu, content, stage, ranges, agenda, bodySection };
}

test("HiDPI large-text popup reserves physical work-area space for its footer", () => {
    const fixture = viewportFixture();
    for (const workArea of [
        { workAreaWidth: 1366, workAreaHeight: 688 },
        { workAreaWidth: 1286, workAreaHeight: 768 }
    ]) {
        const layout = fixture.layout.reflow({ ...workArea, uiScale: 2, textScale: 1.5 });
        assert.equal(layout, "stacked");
        const [width, height] = fixture.viewport.actor.style.match(/\d+/g).map(Number);
        assert.ok(width * 2 + 80 <= workArea.workAreaWidth * 0.9);
        assert.ok(height * 2 + 90 <= workArea.workAreaHeight * 0.9);
        assert.equal(fixture.agenda.style, "min-height: 180px;",
            "the outer viewport never compresses the agenda below its usable minimum");
    }
    fixture.layout.reflow({ workAreaWidth: 3840, workAreaHeight: 2160, uiScale: 1, textScale: 1 });
    assert.equal(fixture.content.vertical, false, "a roomy monitor restores side-by-side columns");
    const style = fixture.viewport.actor.style;
    fixture.viewport.constrain({ workAreaWidth: 0, workAreaHeight: 0 });
    assert.equal(fixture.viewport.actor.style, style, "missing monitor data preserves the last bound");
    fixture.viewport.destroy();
});

test("keyboard focus reveals both scroll axes without moving focus or content", () => {
    const fixture = viewportFixture();
    fixture.stage.callback();
    fixture.stage.focus = { inside: false };
    fixture.stage.callback();
    assert.deepEqual(fixture.ranges, []);
    const focus = {
        inside: true,
        get_parent: () => fixture.viewport.actor,
        get_transformed_position: () => [700, 1100],
        get_transformed_size: () => [80, 60]
    };
    fixture.stage.focus = focus;
    fixture.stage.callback();
    assert.deepEqual(fixture.ranges, [[0, 680, 760], [1, 1500, 1560]]);
    assert.equal(fixture.stage.focus, focus);
    assert.equal(fixture.viewport.actor.content, fixture.content);
    focus.get_transformed_position = () => [400, 800];
    fixture.viewport.actor.fire("notify::allocation");
    assert.deepEqual(fixture.ranges.slice(-2), [[0, 380, 460], [1, 1200, 1260]],
        "focus is revealed again after the queued reflow receives its real allocation");
    fixture.menu.isOpen = false;
    fixture.stage.callback();
    assert.equal(fixture.ranges.length, 4);
    fixture.viewport.destroy();
    assert.equal(fixture.stage.callback, null, "the global focus observer leaves with its menu");
});

function boundedAdjustment(value, page, onClamp) {
    return {
        value,
        get_value() { return this.value; },
        clamp_page(low, high) {
            this.value = Math.max(0, Math.min(low, Math.max(this.value, high - page)));
            onClamp(this.value);
        }
    };
}

test("nested agenda focus scrolls inner-first before the pending native allocation", () => {
    const fixture = viewportFixture();
    const order = [];
    const innerAdjustment = boundedAdjustment(0, 200, (value) => order.push(["inner", value]));
    const outerAdjustment = boundedAdjustment(100, 300, (value) => order.push(["outer", value]));
    const horizontal = boundedAdjustment(0, 1000, () => {});
    const inner = new global.imports.gi.St.ScrollView();
    inner.add_actor({ get_transformed_position: () => [0, 150] });
    inner.get_parent = () => fixture.viewport.actor;
    inner.get_hscroll_bar().get_adjustment = () => horizontal;
    inner.get_vscroll_bar().get_adjustment = () => innerAdjustment;
    fixture.viewport.actor.get_hscroll_bar().get_adjustment = () => horizontal;
    fixture.viewport.actor.get_vscroll_bar().get_adjustment = () => outerAdjustment;
    fixture.content.get_transformed_position = () => [0, -100];
    fixture.stage.focus = {
        inside: true,
        get_parent: () => ({ get_parent: () => inner }),
        // Native transforms do not change until allocation, despite adjustment writes.
        get_transformed_position: () => [0, 650],
        get_transformed_size: () => [80, 60]
    };

    fixture.stage.callback();
    assert.deepEqual(order, [["inner", 360], ["outer", 150]]);
    const finalRowY = 650 - innerAdjustment.value - (outerAdjustment.value - 100);
    const finalInnerY = 150 - (outerAdjustment.value - 100);
    assert.ok(finalRowY >= finalInnerY && finalRowY + 60 <= finalInnerY + 200,
        "the row is visible inside the agenda's clipped area");
    assert.ok(finalRowY >= 0 && finalRowY + 60 <= 300,
        "the row is also visible inside the outer body viewport");
    fixture.viewport.destroy();
});

test("long footer labels fit independently and invalidate sibling minimum-size caches", () => {
    const fixture = viewportFixture();
    const theme = {
        get_horizontal_padding: () => 60,
        get_vertical_padding: () => 10,
        get_border_width: () => 0,
        get_length: () => 8
    };
    const text = {};
    const label = {
        get_clutter_text: () => text,
        get_preferred_width: () => [0, 1200],
        set_style(style) { this.style = style; }
    };
    const issueLabel = { ...label, get_clutter_text: () => ({}) };
    const item = {
        actor: { get_theme_node: () => theme }, label,
        getColumnWidths: () => [1200, 40]
    };
    let invalidations = 0;
    fixture.menu.actor.get_theme_node = () => theme;
    fixture.menu.box = {
        get_theme_node: () => theme,
        get_children: () => [fixture.bodySection, ...[0, 1].map(() => ({
            visible: true,
            get_preferred_height: () => [0, 30],
            queue_relayout() { invalidations++; }
        }))]
    };
    fixture.bodySection.queue_relayout = () => invalidations++;
    fixture.viewport.setFooter(item, issueLabel);
    fixture.layout.reflow({ workAreaWidth: 1366, workAreaHeight: 688, uiScale: 2, textScale: 1.5 });
    assert.equal(label.style, "max-width: 500px;");
    assert.equal(issueLabel.style, label.style);
    assert.deepEqual(text, { single_line_mode: false, line_wrap: true, line_wrap_mode: 2, ellipsize: 0 });
    assert.equal(invalidations, 3, "the separator cannot retain an earlier oversized column");
    assert.ok(500 * 2 + 180 + 40 + 8 <= 1366 * 0.9);
    const height = Number(fixture.viewport.actor.style.match(/max-height: (\d+)/)[1]);
    assert.ok(height * 2 + 60 + 20 + 16 <= 688 * 0.9,
        "visible rows, theme padding and spacing are reserved independently of body wrapping");
    fixture.viewport.destroy();
});

test("both scrollbars bypass popup grabs and disconnect on teardown", () => {
    const { viewport, menu } = viewportFixture();
    const [horizontal, vertical] = viewport.actor.bars;
    horizontal.fire("scroll-start");
    vertical.fire("scroll-start");
    horizontal.fire("scroll-stop");
    assert.equal(menu.passEvents, true);
    vertical.fire("scroll-stop");
    assert.equal(menu.passEvents, false);
    vertical.fire("scroll-start");
    viewport.destroy();
    assert.equal(menu.passEvents, false);
    assert.equal(horizontal.signals.size + vertical.signals.size, 0);
    assert.equal(viewport.actor.signals.size, 0);
    viewport.destroy();
});
