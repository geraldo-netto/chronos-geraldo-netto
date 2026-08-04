const assert = require("node:assert/strict");
const { beforeEach, test } = require("node:test");
const path = require("node:path");

const appletDir = path.join(__dirname, "..", "files", "chronos@geraldo-netto");
const astronomyPath = path.join(appletDir, "astronomy.js");
const shimPath = path.join(appletDir, "5.4", "astronomy.js");
const viewPath = path.join(appletDir, "5.4", "astronomyView.js");
let unixDateTime = null;

class MockBox {
    constructor(options = {}) {
        this.options = options;
        this.children = [];
        this.visible = options.visible !== false;
    }

    add_actor(actor) {
        this.children.push(actor);
    }

    hide() {
        this.visible = false;
    }

    show() {
        this.visible = true;
    }
}

class MockLabel {
    constructor(options = {}) {
        this.options = options;
        this.text = "";
        this.clutterText = { line_wrap: false };
    }

    get_clutter_text() {
        return this.clutterText;
    }

    set_text(text) {
        this.text = text;
    }
}

function loadView() {
    for (const file of [astronomyPath, shimPath, viewPath]) {
        delete require.cache[require.resolve(file)];
    }
    const astronomy = require(astronomyPath);
    global.imports = {
        gi: {
            Clutter: { ActorAlign: { START: 1 } },
            GLib: { DateTime: { new_from_unix_local: () => unixDateTime } },
            St: { BoxLayout: MockBox, Label: MockLabel }
        },
        ui: {
            appletManager: { applets: { "chronos@geraldo-netto": {
                astronomy,
                localeText: { translate: (text) => text }
            } } }
        }
    };
    return require(viewPath);
}

beforeEach(() => {
    unixDateTime = null;
});

test("local civil-day bounds reject bad clocks and include DST-sized days", () => {
    const View = loadView();
    assert.equal(View.localDayBounds(null), null);
    assert.equal(View.localDayBounds({}), null);
    assert.equal(View.localDayBounds({ getTime: () => NaN }), null);

    const now = new Date(2026, 2, 5, 12, 30);
    const bounds = View.localDayBounds(now);
    assert.equal(bounds.startMs, new Date(2026, 2, 5).getTime());
    assert.equal(bounds.endMs, new Date(2026, 2, 6).getTime());
});

test("row formatting covers ordinary, missing, and continuous-horizon events", () => {
    const View = loadView();
    assert.equal(View.replaceTimes("Rise %s / Set %s", "06:00", "18:00"),
        "Rise 06:00 / Set 18:00");
    assert.equal(View.bodyLine({ rise: 1, set: 2, state: "normal" },
        "Rise %s / Set %s", "up", "down", (value) => String(value)),
    "Rise 1 / Set 2");
    assert.equal(View.bodyLine({ rise: null, set: 2, state: "normal" },
        "Rise %s / Set %s", "up", "down", () => ""), "Rise — / Set —");
    assert.equal(View.bodyLine({ rise: null, set: null, state: "alwaysUp" },
        "", "up", "down", () => ""), "up");
    assert.equal(View.bodyLine({ rise: null, set: null, state: "alwaysDown" },
        "", "up", "down", () => ""), "down");
});

test("default time formatting uses the desktop clock convention and fails closed", () => {
    const View = loadView();
    assert.equal(View.defaultFormatTime(1000, true), "");

    const formats = [];
    unixDateTime = {
        format(format) {
            formats.push(format);
            return format === "%H:%M" ? "06:30" : "6:30 AM";
        }
    };
    assert.equal(View.defaultFormatTime(1000, true), "06:30");
    assert.equal(View.defaultFormatTime(1000, false), "6:30 AM");
    assert.deepEqual(formats, ["%H:%M", "%-l:%M %p"]);

    unixDateTime.format = () => null;
    assert.equal(View.defaultFormatTime(1000, true), "");
});

test("the popup view reuses one daily result and hides without cached coordinates", () => {
    const View = loadView();
    const parent = new MockBox();
    const calls = [];
    let now = new Date(2026, 2, 5, 12);
    let nextEvents = {
        sun: { rise: 1, set: 2, state: "normal" },
        moon: { rise: 3, set: 4, state: "normal" }
    };
    const view = new View.AstronomyView(parent, {
        now: () => now,
        calculate(...args) {
            calls.push(args);
            return nextEvents;
        },
        formatTime: (timestamp, use24h) => `${use24h ? "24" : "12"}:${timestamp}`
    });

    assert.equal(parent.children[0], view.actor);
    assert.equal(view.actor.children.length, 2);
    assert.equal(view.sunLabel.clutterText.line_wrap, true);
    assert.equal(view.moonLabel.clutterText.line_wrap, true);
    view.update({ visible: false, place: { latitude: 41.9, longitude: 12.48 }, use24h: true });
    view.update({ visible: true, place: null, use24h: true });
    assert.equal(view.actor.visible, false);
    assert.equal(calls.length, 0);

    const request = { visible: true, place: { latitude: 41.9, longitude: 12.48 }, use24h: true };
    view.update(request);
    assert.equal(view.actor.visible, true);
    assert.equal(view.sunLabel.text, "Sunrise: 24:1 — Sunset: 24:2");
    assert.equal(view.moonLabel.text, "Moonrise: 24:3 — Moonset: 24:4");
    view.update(request);
    assert.equal(calls.length, 1, "an open-menu tick reuses the daily calculation");

    nextEvents = {
        sun: { rise: null, set: null, state: "alwaysUp" },
        moon: { rise: null, set: null, state: "alwaysDown" }
    };
    view.update(Object.assign({}, request, { use24h: false }));
    assert.equal(view.sunLabel.text, "Sun is above the horizon all day");
    assert.equal(view.moonLabel.text, "Moon is below the horizon all day");

    now = new Date(2026, 2, 6, 12);
    nextEvents = null;
    view.update(request);
    assert.equal(view.actor.visible, false, "a failed calculation does not show stale times");
});

test("the shipped view uses its local clock, solver, and formatter defaults", () => {
    const View = loadView();
    const parent = new MockBox();
    const view = new View.AstronomyView(parent);

    assert.doesNotThrow(() => view.update({
        visible: true,
        place: { latitude: 41.9, longitude: 12.48 },
        use24h: true
    }));
    assert.equal(view.actor.visible, true);
    assert.match(view.sunLabel.text, /^Sunrise:/);
    assert.match(view.moonLabel.text, /^Moonrise:/);
});
