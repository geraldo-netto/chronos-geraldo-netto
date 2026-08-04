const assert = require("node:assert/strict");
const { beforeEach, test } = require("node:test");
const path = require("node:path");

const appletDir = path.join(__dirname, "..", "files", "chronos@geraldo-netto");
const astronomyPath = path.join(appletDir, "astronomy.js");
const shimPath = path.join(appletDir, "5.4", "astronomy.js");
const viewPath = path.join(appletDir, "5.4", "astronomyView.js");
let unixDateTime = null;
let utcDateTimeFactory = () => null;
let dateTimeFactory = () => null;
const localTimezone = timezone("Europe/Rome");

function timezone(identifier) {
    return { get_identifier: () => identifier };
}

function timezoneFromIdentifier(identifier) {
    if (identifier === "local") {
        return localTimezone;
    }
    return identifier === "Broken/Zone" ? null : timezone(identifier);
}

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
            GLib: { DateTime: {
                new_from_unix_utc: (timestamp) => utcDateTimeFactory(timestamp),
                new: (...args) => dateTimeFactory(...args)
            } },
            St: { BoxLayout: MockBox, Label: MockLabel }
        },
        ui: {
            appletManager: { applets: { "chronos@geraldo-netto": {
                astronomy,
                localeText: { translate: (text) => text },
                worldclockData: {
                    LOCAL_TIMEZONE: "local",
                    timezoneFromIdentifier,
                    timezoneIdentity: (value) => value ? value.get_identifier() : null
                }
            } } }
        }
    };
    return require(viewPath);
}

beforeEach(() => {
    unixDateTime = null;
    utcDateTimeFactory = () => null;
    dateTimeFactory = () => null;
});

test("place civil-day bounds reject bad clocks and preserve DST-sized days", () => {
    const View = loadView();
    const seoul = timezone("Asia/Seoul");
    assert.equal(View.civilDayBounds(null, seoul), null);
    assert.equal(View.civilDayBounds({}, seoul), null);
    assert.equal(View.civilDayBounds({ getTime: () => NaN }, seoul), null);
    assert.equal(View.civilDayBounds(new Date(), null), null);

    const constructed = [];
    utcDateTimeFactory = () => ({
        to_timezone: (value) => value === seoul ? {
            get_year: () => 2026,
            get_month: () => 3,
            get_day_of_month: () => 29
        } : null
    });
    dateTimeFactory = (...args) => {
        constructed.push(args);
        return {
            to_unix: () => 1000,
            add_days: () => ({ to_unix: () => 1000 + 23 * 60 * 60 })
        };
    };

    const bounds = View.civilDayBounds(new Date(2026, 2, 29, 12, 30), seoul);
    assert.deepEqual(constructed, [[seoul, 2026, 3, 29, 0, 0, 0]]);
    assert.deepEqual(bounds, { startMs: 1000000, endMs: (1000 + 23 * 60 * 60) * 1000 });

    dateTimeFactory = () => null;
    assert.equal(View.civilDayBounds(new Date(), seoul), null);
    dateTimeFactory = () => ({ add_days: () => null });
    assert.equal(View.civilDayBounds(new Date(), seoul), null);
    dateTimeFactory = () => ({
        to_unix: () => 0,
        add_days: () => ({ to_unix: () => 27 * 60 * 60 })
    });
    assert.equal(View.civilDayBounds(new Date(), seoul), null, "oversized civil days fail closed");
    assert.equal(View.zonedDateTime(NaN, seoul), null);
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
    const seoul = timezone("Asia/Seoul");
    assert.equal(View.defaultFormatTime(1000, true, seoul), "");

    const formats = [];
    unixDateTime = {
        format(format) {
            formats.push(format);
            return format === "%H:%M" ? "06:30" : "6:30 AM";
        }
    };
    utcDateTimeFactory = () => ({ to_timezone: (value) => value === seoul ? unixDateTime : null });
    assert.equal(View.defaultFormatTime(1000, true, seoul), "06:30");
    assert.equal(View.defaultFormatTime(1000, false, seoul), "6:30 AM");
    assert.deepEqual(formats, ["%H:%M", "%-l:%M %p"]);

    unixDateTime.format = () => null;
    assert.equal(View.defaultFormatTime(1000, true, seoul), "");
});

test("the popup view reuses one daily result and hides without cached coordinates", () => {
    const View = loadView();
    const parent = new MockBox();
    const calls = [];
    let now = new Date(2026, 2, 5, 12);
    let nextBounds = { startMs: 100, endMs: 200 };
    let nextEvents = {
        sun: { rise: 1, set: 2, state: "normal" },
        moon: { rise: 3, set: 4, state: "normal" }
    };
    const view = new View.AstronomyView(parent, {
        now: () => now,
        dayBounds(_now, placeTimezone) {
            calls.push(["bounds", placeTimezone.get_identifier()]);
            return nextBounds;
        },
        calculate(...args) {
            calls.push(args);
            return nextEvents;
        },
        formatTime: (timestamp, use24h, placeTimezone) =>
            `${use24h ? "24" : "12"}@${placeTimezone.get_identifier()}:${timestamp}`
    });

    assert.equal(parent.children[0], view.actor);
    assert.equal(view.actor.children.length, 2);
    assert.equal(view.sunLabel.clutterText.line_wrap, true);
    assert.equal(view.moonLabel.clutterText.line_wrap, true);
    view.update({ visible: false, place: { latitude: 41.9, longitude: 12.48 }, use24h: true });
    view.update({ visible: true, place: null, use24h: true });
    assert.equal(view.actor.visible, false);
    assert.equal(calls.length, 0);

    const request = { visible: true, place: {
        latitude: 41.9, longitude: 12.48, timezone: "Asia/Seoul"
    }, use24h: true };
    view.update(request);
    assert.equal(view.actor.visible, true);
    assert.equal(view.sunLabel.text, "Sunrise: 24@Asia/Seoul:1 — Sunset: 24@Asia/Seoul:2");
    assert.equal(view.moonLabel.text, "Moonrise: 24@Asia/Seoul:3 — Moonset: 24@Asia/Seoul:4");
    view.update(request);
    assert.deepEqual(calls, [
        ["bounds", "Asia/Seoul"], [100, 200, 41.9, 12.48],
        ["bounds", "Asia/Seoul"]
    ], "an open-menu tick reuses the daily calculation");

    view.update({ visible: true, place: {
        latitude: 40, longitude: 12, timezone: "Broken/Zone"
    }, use24h: true });
    assert.equal(calls.at(-2)[1], "Europe/Rome", "an invalid provider zone falls back locally");
    assert.match(view.sunLabel.text, /24@Europe\/Rome/);

    view.update({ visible: true, place: { latitude: 39, longitude: 12 }, use24h: true });
    assert.equal(calls.at(-2)[1], "Europe/Rome", "a fallback geocoder without a zone stays usable");

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

    nextEvents = { sun: { state: "alwaysUp" }, moon: { state: "alwaysDown" } };
    nextBounds = null;
    view.update({ visible: true, place: {
        latitude: 38, longitude: 12, timezone: "Europe/Rome"
    }, use24h: true });
    assert.equal(view.actor.visible, false, "missing place-day bounds hide the rows");
    nextBounds = { startMs: 0, endMs: 27 * 60 * 60 * 1000 };
    view.update({ visible: true, place: {
        latitude: 37, longitude: 12, timezone: "Europe/Rome"
    }, use24h: true });
    assert.equal(view.actor.visible, false, "invalid place-day bounds hide the rows");
    view.update({ visible: true, place: {
        latitude: 91, longitude: 12, timezone: "Europe/Rome"
    }, use24h: true });
    assert.equal(view.actor.visible, false, "invalid observer coordinates hide the rows");
});

test("the shipped view uses its local clock, solver, and formatter defaults", () => {
    const View = loadView();
    const parent = new MockBox();
    const view = new View.AstronomyView(parent);

    utcDateTimeFactory = () => ({
        to_timezone: () => unixDateTime || {
            get_year: () => 2026,
            get_month: () => 3,
            get_day_of_month: () => 5,
            format: () => "06:30"
        }
    });
    dateTimeFactory = () => ({
        to_unix: () => Date.parse("2026-03-05T00:00:00+01:00") / 1000,
        add_days: () => ({ to_unix: () => Date.parse("2026-03-06T00:00:00+01:00") / 1000 })
    });

    assert.doesNotThrow(() => view.update({
        visible: true,
        place: { latitude: 41.9, longitude: 12.48, timezone: "Europe/Rome" },
        use24h: true
    }));
    assert.equal(view.actor.visible, true);
    assert.match(view.sunLabel.text, /^Sunrise:/);
    assert.match(view.moonLabel.text, /^Moonrise:/);
});
