const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { makeRandom: makeSeededRandom } = require("./helpers/prng");

const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "6.0", "worldclocks.js");
const dataModulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "worldclockData.js");
const shimPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "6.0", "worldclockData.js");
const ioUtilsPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "ioUtils.js");
const providerUtilsPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "providerUtils.js");
const localeTextPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "localeText.js");
const textUtilsPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "textUtils.js");
const style52Path = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "6.0", "stylesheet.css");

// two built-in rows (UTC and local time) always precede the configured clocks
const BUILTIN_ROWS = 2;

// Seeded PRNG so fuzz failures reproduce; change FUZZ_SEED to explore
const FUZZ_SEED = 20260709;
function makeRandom(seed = FUZZ_SEED) {
    return makeSeededRandom(seed);
}

function pickRandom(random, values) {
    return values[Math.floor(random() * values.length)];
}

let originalImports;

class MockGridLayout {
    constructor() {
        this.children = [];
    }

    attach(child, column, row, width, height) {
        child.parent = this.owner;
        this.children.push({ child, column, row, width, height });
    }
}

class MockWidget {
    constructor(options) {
        this.options = options;
        this.options.layout_manager.owner = this;
        this.children = [];
        this.visible = true;
    }

    set_accessible_name(name) {
        this.accessible_name = name;
    }

    destroy_all_children() {
        this.children = [];
        this.options.layout_manager.children = [];
    }

    show() {
        this.visible = true;
    }

    hide() {
        this.visible = false;
    }
}

class MockLabel {
    constructor(options = {}) {
        this.text = options.text || "";
        this.options = options;
        // every write, so a test can assert that a tick which changed nothing
        // wrote nothing: St compares by pointer and this runs once a second
        this.texts = [];
        // every St.Label has one; the clock name ellipsizes through it
        this.clutter_text = { ellipsize: 0, line_wrap: false };
        this.handlers = new Map();
    }

    connect(signal, callback) {
        this.handlers.set(signal, callback);
    }

    pointerEnter() {
        if (this.options.reactive && this.parent?.options.reactive) {
            this.handlers.get("enter-event")?.();
        }
    }

    get_clutter_text() {
        return this.clutter_text;
    }

    set_text(text) {
        this.text = text;
        this.texts.push(text);
    }

    set_accessible_name(name) {
        this.accessible_name = name;
    }
}

// a real GLib.TimeZone names itself through get_identifier() and has no
// `timezone` property; the double used to have one, and production carried a
// fallback branch that existed only for it
function fakeTimeZone(identifier) {
    return { get_identifier: () => identifier };
}

// The instant every clock in a test is read at. GLib.DateTime.new_now_utc() is
// the only clock production reads, so pinning it here pins the whole table — and
// no test depends on the machine's own zone or on the wall clock at run time.
// 2026-07-09T11:45:00Z: mid-July, so the northern zones are on summer time.
let NOW_MS = Date.UTC(2026, 6, 9, 11, 45, 0);

// The double used to answer `${zone}:${format}` — it echoed its own input, so
// every clock assertion in this file checked the mock and not the time. A clock
// an hour off, a zone resolved to the wrong offset, a DST transition read
// backwards: none of it could fail a test. This is a real conversion:
// Intl.DateTimeFormat does the zone arithmetic, and the strftime tokens the
// applet's formats use are rendered from its parts.
const STRFTIME_FIELDS = {
    "%H": { hour: "2-digit", hour12: false },
    "%M": { minute: "2-digit" },
    "%S": { second: "2-digit" },
    "%I": { hour: "2-digit", hour12: true },
    "%l": { hour: "numeric", hour12: true },
    "%p": { hour: "numeric", hour12: true },
    "%d": { day: "2-digit" },
    "%m": { month: "2-digit" },
    "%Y": { year: "numeric" },
    "%Z": { timeZoneName: "short" }
};

const STRFTIME_PART = {
    "%H": "hour", "%M": "minute", "%S": "second", "%I": "hour", "%l": "hour",
    "%p": "dayPeriod", "%d": "day", "%m": "month", "%Y": "year", "%Z": "timeZoneName"
};
// strftime pads to two digits; Intl asked for a single field does not — a lone
// `minute: "2-digit"` renders 0, not 00
const STRFTIME_PADDED = new Set(["%H", "%M", "%S", "%I", "%d", "%m"]);

function timePart(timezone, token) {
    const options = Object.assign({ timeZone: timezone }, STRFTIME_FIELDS[token]);
    const parts = new Intl.DateTimeFormat("en-GB", options).formatToParts(new Date(NOW_MS));
    const found = parts.find((part) => part.type === STRFTIME_PART[token]);
    if (!found) {
        return "";
    }

    return STRFTIME_PADDED.has(token) ? found.value.padStart(2, "0") : found.value;
}

function makeZonedTime(tz) {
    const timezone = tz.get_identifier();
    const numeric = (options) => new Intl.DateTimeFormat("en-GB",
        Object.assign({ timeZone: timezone }, options)).format(new Date(NOW_MS));

    return {
        // GLib.DateTime.format takes a strftime string; the applet's are built
        // from %H %M %S %I %l %p %d %m %Y %Z. Refuse tokens this double does
        // not implement so a new production format cannot be "verified" by an
        // echo that only looks formatted.
        format(fmt) {
            return String(fmt).replace(/%[A-Za-z%]/g, (token) => {
                if (token === "%%") {
                    return "%";
                }
                if (!STRFTIME_FIELDS[token]) {
                    throw new Error(`unsupported strftime token in test double: ${token}`);
                }
                return timePart(timezone, token);
            });
        },
        get_hour() {
            return Number(numeric({ hour: "2-digit", hour12: false }));
        },
        get_minute() {
            return Number(numeric({ minute: "2-digit" }));
        },
        get_year() {
            return Number(numeric({ year: "numeric" }));
        },
        get_month() {
            return Number(numeric({ month: "2-digit" }));
        },
        get_day_of_month() {
            return Number(numeric({ day: "2-digit" }));
        }
    };
}

// The machine's own zone is whatever it is; the tests need one that is neither
// UTC nor any zone they configure, so the local row is distinguishable from the
// rest. São Paulo is UTC-3 all year — no DST of its own to reason about.
const LOCAL_TIMEZONE = "America/Sao_Paulo";

// Real zones for the tests that need a list of them (the cap, the fuzz). They
// used to be "Zone/0"…"Zone/11", which the old echoing double was happy to
// "convert" — no zone database was ever consulted. A double that does the
// arithmetic cannot pretend a made-up name is a place.
const ZONE_POOL = [
    "Asia/Tokyo", "Europe/Rome", "America/New_York", "Australia/Sydney",
    "Africa/Cairo", "Asia/Kolkata", "America/Los_Angeles", "Europe/Lisbon",
    "Pacific/Auckland", "America/Mexico_City", "Asia/Shanghai", "Europe/Berlin"
];
const zoneAt = (index) => ZONE_POOL[index % ZONE_POOL.length];
const ZONEINFO_LINKS = {
    "/usr/share/zoneinfo/US/Eastern": "../America/New_York",
    "/usr/share/zoneinfo/Canada/Eastern": "../America/Toronto",
    "/usr/share/zoneinfo/Brazil/East": "../America/Sao_Paulo"
};

// GLib.TimeZone.new_identifier answers null for a zone it does not know, and so
// does this: Intl is the zone database, and a name it rejects is not a zone.
function knownTimeZone(timezone) {
    try {
        new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
        return true;
    } catch {
        return false;
    }
}

// what the table should read for a zone at NOW_MS, derived the same way the
// double is — an assertion that hard-codes "20:45" is a second clock to get wrong
function timeIn(timezone, fmt = "%H:%M") {
    return makeZonedTime(fakeTimeZone(timezone)).format(fmt);
}

function localTimeStamp(localTime) {
    return Date.UTC(
        localTime.get_year(),
        localTime.get_month() - 1,
        localTime.get_day_of_month(),
        localTime.get_hour(),
        localTime.get_minute());
}

function assertClockEntryOrder(entries, context) {
    assert.ok(entries.every((entry) => entry.localTime), `${context}: every timezone must resolve`);
    const stamps = entries.map((entry) => localTimeStamp(entry.localTime));

    for (let i = 1; i < stamps.length; i++) {
        assert.ok(stamps[i - 1] > stamps[i],
            `${context}: ${entries[i - 1].timezone} must be ahead of ${entries[i].timezone}`);
    }
}

test("the zoned-time double refuses strftime fields it cannot render", () => {
    assert.throws(() => timeIn("Etc/UTC", "%Q"), /unsupported strftime token.*%Q/);
    assert.equal(timeIn("Etc/UTC", "%% %H:%M"), "% 11:45");
});

function weatherCity(data, timezone) {
    return data.timezoneWeatherRequest(timezone)?.query || "";
}

function loadWorldclocks(options = {}) {
    clearWorldclockCaches();
    require.cache[require.resolve(localeTextPath)] = {
        exports: {
            translate: options.translate || ((str) => str),
            joinPhrases: (...parts) => parts.filter((part) => part).join(" — ")
        }
    };

    global.imports = {
        ui: {
            popupMenu: {},
            tooltips: {
                Tooltip: class {
                    constructor(actor, text) {
                        this.actor = actor;
                        this.text = text;
                        actor.tooltip_text = text;
                        actor.connect("enter-event", () => { actor.visible_tooltip = this.text; });
                    }
                    set_text(text) { this.text = text; }
                }
            }
        },
        gi: {
            Pango: { EllipsizeMode: { NONE: 0, END: 3 } },
            GLib: {
                get_language_names: () => ["C"],
                get_monotonic_time: () => 1000000,
                // GLib >= 2.68, which is what Cinnamon 5.4 ships: new_identifier
                // answers null for a zone it does not know. The pre-2.68
                // TimeZone.new() path the applet used to carry is gone.
                TimeZone: {
                    new_identifier(timezone) {
                        return knownTimeZone(timezone) ? fakeTimeZone(timezone) : null;
                    },
                    new_local() {
                        return fakeTimeZone(LOCAL_TIMEZONE);
                    }
                },
                DateTime: {
                    new_now_utc() {
                        return {
                            to_timezone(tz) {
                                return makeZonedTime(tz);
                            }
                        };
                    }
                },
                file_read_link(filename) {
                    if (Object.prototype.hasOwnProperty.call(ZONEINFO_LINKS, filename)) {
                        return ZONEINFO_LINKS[filename];
                    }
                    throw new Error("regular zoneinfo file");
                }
            },
            Clutter: {
                ActorAlign: { START: "start", END: "end" },
                GridLayout: MockGridLayout
            },
            St: {
                Label: MockLabel,
                Widget: MockWidget
            }
        }
    };

    return reloadWorldclocks();
}

function clearWorldclockCaches() {
    delete require.cache[require.resolve(modulePath)];
    delete require.cache[require.resolve(shimPath)];
    delete require.cache[require.resolve(dataModulePath)];
    delete require.cache[require.resolve(textUtilsPath)];
    // the shared I/O adapter captures GLib at load, and the OS-timezone tests
    // below stub GLib.file_get_contents on this call's imports object (T809)
    delete require.cache[require.resolve(ioUtilsPath)];
}

// 6.0/worldclocks.js reaches the shared data module through the 6.0 shim,
// which reads it off the applet importer
function reloadWorldclocks() {
    clearWorldclockCaches();
    const textUtils = require(textUtilsPath);
    const appletModules = {
        localeText: require(localeTextPath),
        textUtils,
        elapsedTime: {
            monotonicSeconds: () => 1
        },
        dateFormats: {
            MAX_DATE_FORMAT_LENGTH: 256,
            MAX_CLOCK_STAMP_LENGTH: 256,
            dateFormatOrDefault(format, fallback) {
                return textUtils.textWithinLimit(format, this.MAX_DATE_FORMAT_LENGTH) ?
                    format : fallback;
            },
            clampClockStamp(stamp) {
                return textUtils.clampText(stamp, this.MAX_CLOCK_STAMP_LENGTH);
            }
        }
    };
    global.imports.ui.appletManager = {
        applets: {
            "chronos@geraldo-netto": appletModules
        }
    };
    appletModules.worldclockData = require(dataModulePath);

    return require(modulePath);
}

beforeEach(() => {
    originalImports = global.imports;
});

afterEach(() => {
    global.imports = originalImports;
    clearWorldclockCaches();
    delete require.cache[require.resolve(localeTextPath)];
});

test("constructor adds a grid actor to the supplied box", () => {
    const { Worldclocks } = loadWorldclocks();
    const box = {
        added: [],
        add_actor(actor, options) {
            this.added.push({ actor, options });
        }
    };

    const worldclocks = new Worldclocks(box);

    assert.equal(box.added.length, 1);
    assert.equal(box.added[0].actor, worldclocks.actor);
    assert.equal(box.added[0].options, undefined);
    assert.equal(worldclocks.actor.options.style_class, "calendar calendar-world-list");
    assert.ok(worldclocks.layout instanceof MockGridLayout);
});

test("stylesheets define world clock time alignment", () => {
    const css = fs.readFileSync(style52Path, "utf8");
    assert.match(css, /\.calendar-world-time \{[\s\S]*?padding-left: 1em;[\s\S]*?text-align: right;/);
    assert.match(css, /\.calendar-world-time-invalid \{[\s\S]*?font-style: italic;/);
});

test("built-in UTC and local rows are shown even with no configured clocks", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([]);
    worldclocks.updateClocks();

    assert.equal(worldclocks.actor.visible, true);
    assert.equal(worldclocks.clocks.length, BUILTIN_ROWS);
    assert.deepEqual(worldclocks.clocks.map((clock) => clock.label), ["UTC", "Local time"]);
    assert.deepEqual(worldclocks.clocks.map((clock) => clock.builtin), [true, true]);
    assert.equal(worldclocks.clocks[0].display.text, timeIn("UTC"));
    assert.equal(worldclocks.clocks[1].display.text, timeIn(LOCAL_TIMEZONE));

    assert.equal(worldclocks.getClockEntries().filter((entry) => !entry.builtin).length, 0);

    // the city label beside the time is read from its own text, so repeating it
    // here made a screen reader say "UTC", then "UTC UTC:%H:%M"
    assert.equal(worldclocks.clocks[0].display.accessible_name, timeIn("UTC"));
    assert.equal(worldclocks.clocks[1].display.accessible_name, timeIn(LOCAL_TIMEZONE));
});

// the local row pinned whatever /etc/localtime said when the clocks were built,
// so a user who travelled and changed the system timezone kept seeing the old
// offset in the popup while the panel clock moved: the same applet disagreeing
// with itself
test("the local row follows the system timezone when it changes", () => {
    const { Worldclocks } = loadWorldclocks();
    const GLib = global.imports.gi.GLib;
    let systemZone = "Europe/Rome";
    GLib.TimeZone.new_local = () => {
        // a real GLib.TimeZone is a snapshot: it keeps naming the zone it was
        // built from, whatever the system does afterwards
        return fakeTimeZone(systemZone);
    };

    let wallNow = 1000;
    let elapsedNow = 1000;
    GLib.DateTime.new_now_utc = () => ({
        to_unix: () => wallNow,
        to_timezone: (tz) => makeZonedTime(tz)
    });

    const worldclocks = new Worldclocks(
        { add_actor() {} }, { elapsedNow: () => elapsedNow });
    worldclocks.buildClocks([]);
    worldclocks.updateClocks();
    assert.equal(worldclocks.clocks[1].display.text, timeIn("Europe/Rome"));

    // the user lands in Tokyo and the system timezone changes under the applet
    systemZone = "Asia/Tokyo";

    // the zone is not re-read on every tick — that would build a GLib.TimeZone
    // a second, and the popup only shows minutes
    // A civil-clock correction is irrelevant to the runtime recheck interval.
    wallNow -= 24 * 60 * 60;
    elapsedNow += 5;
    worldclocks.updateClocks();
    assert.equal(worldclocks.clocks[1].display.text, timeIn("Europe/Rome"));

    elapsedNow += 60;
    worldclocks.updateClocks();
    assert.equal(worldclocks.clocks[1].display.text, timeIn("Asia/Tokyo"),
        "and within the minute the popup agrees with the panel again");
});

// T1002: the recheck used to swap `clock.tz` in place, which cannot re-run the
// selection — so a configured clock hidden as a duplicate of the built-in local
// row stayed hidden after the system zone moved away from it.
test("a zone change re-selects the configured rows, not just the local one", () => {
    const { Worldclocks } = loadWorldclocks();
    const GLib = global.imports.gi.GLib;
    let systemZone = "Europe/Rome";
    GLib.TimeZone.new_local = () => fakeTimeZone(systemZone);

    let elapsedNow = 1000;
    const worldclocks = new Worldclocks(
        { add_actor() {} }, { elapsedNow: () => elapsedNow });
    worldclocks.buildClocks([{ label: "Rome", timezone: "Europe/Rome" }]);
    worldclocks.updateClocks();
    assert.equal(worldclocks.clocks.length, BUILTIN_ROWS,
        "a configured clock on the local zone is covered by the built-in row");

    systemZone = "Asia/Tokyo";
    elapsedNow += 60;
    worldclocks.updateClocks();

    assert.deepEqual(worldclocks.clocks.map((clock) => clock.timezone),
        ["UTC", "local", "Europe/Rome"],
        "and it comes back once the local zone no longer covers it");
    assert.equal(worldclocks.clocks[1].display.text, timeIn("Asia/Tokyo"));
    assert.equal(worldclocks.clocks[2].display.text, timeIn("Europe/Rome"));
});

test("fallback timezone polling keeps city weather in step without reentrant notifications", () => {
    const { Worldclocks } = loadWorldclocks();
    const { AppletWeatherCoordinator } = require("../files/chronos@geraldo-netto/6.0/appletCoordinators");
    let systemZone = "Europe/Rome";
    let elapsedNow = 1000;
    global.imports.gi.GLib.TimeZone.new_local = () => fakeTimeZone(systemZone);
    const saved = [{ label: "Rome", timezone: "Europe/Rome" }];
    const requests = [];
    const coordinator = new AppletWeatherCoordinator({
        cityWeatherProvider: { schedule: (settings) => requests.push(settings.cities) },
        settings: () => ({ showWorldclocks: true, showWeather: true, units: "si" }),
        worldclocks: () => saved
    });
    const view = new Worldclocks({ add_actor() {} }, {
        elapsedNow: () => elapsedNow,
        onTimezoneChanged() {
            view.updateClocks();
            coordinator.scheduleCities();
        }
    });
    view.buildClocks(saved);
    coordinator.scheduleCities();
    for (const zone of ["Asia/Tokyo", "Europe/Rome"]) {
        systemZone = zone;
        elapsedNow += 60;
        view.updateClocks();
        view.getClockEntries();
    }
    assert.deepEqual(requests.map((cities) => cities.map((city) => city.query)),
        [[], ["Rome"], []]);
    view.destroy();
    assert.equal(view._onTimezoneChanged, null);
});

// a tick can still arrive after the menu is torn down, and the recheck now
// rebuilds actors — it must not do that into a destroyed view
test("a timezone recheck after destroy rebuilds nothing", () => {
    const { Worldclocks } = loadWorldclocks();
    const GLib = global.imports.gi.GLib;
    let systemZone = "Europe/Rome";
    GLib.TimeZone.new_local = () => fakeTimeZone(systemZone);

    let elapsedNow = 1000;
    const worldclocks = new Worldclocks(
        { add_actor() {} }, { elapsedNow: () => elapsedNow });
    worldclocks.buildClocks([{ label: "Tokyo", timezone: "Asia/Tokyo" }]);
    worldclocks.destroy();

    systemZone = "Asia/Tokyo";
    elapsedNow += 60;
    worldclocks.updateClocks();
    worldclocks.refreshTimezone();

    assert.deepEqual(worldclocks.clocks, []);
});

test("buildClocks caps configured clocks at 8 on top of the built-ins", () => {
    const { Worldclocks, MAX_CLOCKS } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    assert.equal(MAX_CLOCKS, 8);

    const clocks = Array.from({ length: 12 }, (_, index) => ({
        label: `Clock ${index}`,
        timezone: zoneAt(index)
    }));

    worldclocks.buildClocks(clocks);

    assert.equal(worldclocks.actor.visible, true);
    assert.equal(worldclocks.clocks.length, BUILTIN_ROWS + MAX_CLOCKS);
    // every row attaches a name, a time and the city's temperature
    assert.equal(worldclocks.layout.children.length, (BUILTIN_ROWS + MAX_CLOCKS) * 3);

    const firstUserLabel = worldclocks.layout.children
        .find((cell) => cell.column === 0 && cell.row === BUILTIN_ROWS);
    assert.equal(firstUserLabel.child.text, "Clock 0");
    assert.equal(worldclocks.clocks[BUILTIN_ROWS + 7].tz.get_identifier(), zoneAt(7));
    assert.equal(worldclocks.clocks.some((clock) =>
        clock.tz && clock.tz.get_identifier() === zoneAt(8)), false);
});

test("buildClocks skips configured rows already covered by built-ins", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([
        { label: "UTC duplicate", timezone: "UTC" },
        { label: "Etc UTC duplicate", timezone: "Etc/UTC" },
        { label: "Local duplicate", timezone: "local" },
        { label: "Rome", timezone: "Europe/Rome" }
    ]);

    assert.deepEqual(worldclocks.clocks.map((clock) => clock.label), [
        "UTC",
        "Local time",
        "Rome"
    ]);
});

// The popup and the weather side each had their own idea of which clocks count,
// and they disagreed: a clock the popup drops for colliding with a built-in was
// still geocoded every half hour and still ate one of the eight weather slots,
// so the last real clock silently lost its temperature.
test("the popup and the weather side select the same clocks", () => {
    const { Worldclocks } = loadWorldclocks();
    const WorldclockData =
        global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const worldclocks = new Worldclocks({ add_actor() {} });

    const configured = [
        { label: "Ghost", timezone: "Etc/UTC" },
        { label: "Rome", timezone: "Europe/Rome" },
        { label: "Tokyo", timezone: "Asia/Tokyo" }
    ];

    worldclocks.buildClocks(configured);
    const shown = worldclocks.clocks.filter((clock) => !clock.builtin).map((clock) => clock.label);
    const selected = WorldclockData.selectUserClocks(configured).map((clock) => clock.label);

    assert.deepEqual(selected, shown);
    assert.deepEqual(selected, ["Rome", "Tokyo"], "the built-in collision is nobody's clock");
});

test("the first saved clock for a timezone wins without consuming another slot", () => {
    loadWorldclocks();
    const WorldclockData =
        global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const configured = [
        { label: "Rome", timezone: "Europe/Rome" },
        { label: "Rome duplicate", timezone: "Europe/Rome" }
    ].concat(ZONE_POOL.filter((timezone) => timezone !== "Europe/Rome")
        .slice(0, WorldclockData.MAX_CLOCKS - 1).map((timezone, index) => ({
            label: `Clock ${index}`,
            timezone
        })));

    const selected = WorldclockData.selectUserClocks(configured);

    assert.equal(selected.length, WorldclockData.MAX_CLOCKS);
    assert.deepEqual(selected.map((clock) => clock.label), [
        "Rome", ...Array.from(
            { length: WorldclockData.MAX_CLOCKS - 1 }, (_, index) => `Clock ${index}`)
    ]);
});

// The runtime request and Python placeholder share named-zone extraction cases.
// Runtime admission also resolves the symbolic local zone through GLib; the
// Python text helper receives an already-resolved identifier instead.
test("timezone requests share named-zone extraction with Python and resolve local through GLib", () => {
    loadWorldclocks();
    const WorldclockData =
        global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const fixture = require("./fixtures/timezone_city_cases.json");

    for (const { timezone, city, runtimeCity = city } of fixture.cases) {
        assert.equal(weatherCity(WorldclockData, timezone), runtimeCity,
            `timezoneWeatherRequest(${JSON.stringify(timezone)}) must be ${JSON.stringify(city)}`);
    }
});

test("built-in timezone rules match the Python settings resolver", () => {
    loadWorldclocks();
    const WorldclockData =
        global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const fixture = require("./fixtures/timezone_builtin_cases.json");

    assert.equal(LOCAL_TIMEZONE, fixture.local_timezone,
        "the GLib local-zone double must match the shared parity case");
    assert.deepEqual(
        Array.from(WorldclockData.builtInTimezoneKeys(WorldclockData.builtinClocks())).sort(),
        fixture.builtin_identities);

    const choices = fixture.reserved_inputs
        .concat(fixture.ordinary_timezone)
        .map((timezone) => ({ label: timezone, timezone }));
    assert.deepEqual(WorldclockData.selectUserClocks(choices), [{
        label: fixture.ordinary_timezone,
        timezone: fixture.ordinary_timezone
    }]);

    // T782: GLib does not canonicalize — get_identifier() answers the string it
    // was given — and TZ takes a POSIX colon prefix and an absolute path, so
    // the local zone reaches this comparison spelled whichever way the session
    // was started. Comparing those raw drew the same zone twice in the popup
    // while the settings dialog, which already reduced TZ to a plain zoneinfo
    // name, considered it a duplicate and hid it.
    for (const [spelling, reduced] of Object.entries(fixture.identifier_spellings)) {
        assert.equal(WorldclockData.zoneinfoIdentifier(spelling), reduced,
            `${JSON.stringify(spelling)} is the zone ${reduced}`);
    }

    // and a clock spelled the way TZ spells the local zone is that zone
    const aliased = Object.keys(fixture.identifier_spellings)
        .filter((spelling) =>
            fixture.identifier_spellings[spelling] === fixture.local_timezone)
        .map((timezone) => ({ label: timezone, timezone }));
    assert.ok(aliased.length > 1, "the fixture carries more than one spelling");
    assert.deepEqual(WorldclockData.selectUserClocks(aliased), [],
        "every spelling of the local zone collides with the built-in local row");
});

test("timezone whitespace preserves Python and runtime clock selection parity", () => {
    loadWorldclocks();
    const WorldclockData =
        global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const fixture = require("./fixtures/timezone_whitespace_cases.json");
    const saved = JSON.parse(JSON.stringify(fixture.saved));

    assert.equal(LOCAL_TIMEZONE, fixture.local_timezone);
    for (const { input, normalized } of fixture.identifiers)
        assert.equal(WorldclockData.zoneinfoIdentifier(input), normalized);
    assert.deepEqual(WorldclockData.selectUserClocks(saved), fixture.selected);
    assert.deepEqual(WorldclockData.selectUserClocks(fixture.selected), fixture.selected);
    assert.deepEqual(saved, fixture.saved);
});

test("invalid Unicode clock rows do not discard valid neighboring clocks", () => {
    loadWorldclocks();
    const data = global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const fixture = require("./fixtures/settings_unicode_cases.json");
    const saved = JSON.parse(JSON.stringify(fixture.savedClocks));
    for (const { input, valid } of fixture.text)
        assert.equal(data.clockInputLabel(input), valid ? input : "");
    assert.deepEqual(data.selectUserClocks(saved), fixture.selectedClocks);
    assert.deepEqual(data.selectUserClocks(fixture.selectedClocks), fixture.selectedClocks);
    assert.deepEqual(saved, fixture.savedClocks);
});

test("T1150 saved timezone NUL rows never consume valid clock slots", () => {
    loadWorldclocks();
    const data = global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const fixture = require("./fixtures/timezone_nul_cases.json");
    const valid = fixture.valid.map((timezone) => ({ label: timezone, timezone }));
    const invalid = fixture.invalid.map((timezone) => ({ label: "Refused", timezone }));
    const saved = [valid[0], ...invalid, ...valid.slice(1)];
    const before = JSON.parse(JSON.stringify(saved));
    assert.deepEqual(data.selectUserClocks(saved), valid);
    assert.deepEqual(data.selectUserClocks(valid), valid);
    assert.deepEqual(saved, before);
});

test("T1150 shared native timezone admission refuses NUL before GLib", () => {
    loadWorldclocks();
    const data = global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const fixture = require("./fixtures/timezone_nul_cases.json");
    const calls = [];
    global.imports.gi.GLib.TimeZone.new_identifier = (timezone) => {
        calls.push(timezone);
        return { get_identifier: () => timezone.split("\0")[0] };
    };
    for (const timezone of fixture.invalid)
        assert.equal(data.timezoneFromIdentifier(timezone), null, JSON.stringify(timezone));
    assert.deepEqual(calls, [], "no refused timezone crosses the NUL-terminated boundary");
    for (const timezone of fixture.valid)
        assert.equal(data.timezoneFromIdentifier(timezone).get_identifier(), timezone);
    assert.deepEqual(calls, fixture.valid);
});

// the label is the user's own name for the clock and the dialog puts no limit on
// it; it is rendered in the popup grid and padded to the widest cell in the
// monospace tooltip, so one 60-character name stretches both
test("a very long clock name is cut down to size", () => {
    const { Worldclocks } = loadWorldclocks();
    const WorldclockData =
        global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const worldclocks = new Worldclocks({ add_actor() {} });
    const max = WorldclockData.MAX_CLOCK_LABEL_CELLS;

    const fullLabel = "x".repeat(60);
    worldclocks.buildClocks([
        { label: fullLabel, timezone: "Europe/Rome" },
        { label: "Tokyo", timezone: "Asia/Tokyo" }
    ]);

    const [long, short] = worldclocks.clocks.filter((clock) => !clock.builtin);
    assert.equal(Array.from(long.label).length, max);
    assert.ok(long.label.endsWith("…"), "and it says it was cut");
    assert.equal(long.full_label, fullLabel, "the disclosure model keeps the full name");
    assert.equal(short.label, "Tokyo", "a name that fits is untouched");

    const selected = WorldclockData.selectUserClocks(
        [{ label: fullLabel, timezone: "Europe/Rome" }])[0];
    assert.equal(selected.label, fullLabel);
    const popupLabel = worldclocks.layout.children
        .find((cell) => cell.row === BUILTIN_ROWS && cell.column === 0).child;
    assert.equal(popupLabel.text, long.label, "only the drawn projection is clamped");
    assert.equal(popupLabel.tooltip_text, fullLabel, "hover reveals the complete saved label");

    const oversized = WorldclockData.clockInputLabel(
        "y".repeat(WorldclockData.MAX_CLOCK_INPUT_LABEL_LENGTH + 20));
    assert.equal(Array.from(oversized).length, WorldclockData.MAX_CLOCK_INPUT_LABEL_LENGTH);
    assert.ok(oversized.endsWith("…"));
});

// T792: the cap's own rationale is the popup grid and the monospace tooltip
// padded to the widest cell - both measured in cells by TextUtils.displayWidth -
// and it was enforced with a code-point clamp. So a CJK name passed the cap at
// 24 code points and drew 48 cells, twice the budget, in exactly the sessions
// the width work was done for.
test("a clock name is cut to the cells the tooltip pads, not to code points", () => {
    loadWorldclocks();
    const applets = global.imports.ui.appletManager.applets["chronos@geraldo-netto"];
    const WorldclockData = applets.worldclockData;
    const TextUtils = applets.textUtils;
    const cells = WorldclockData.MAX_CLOCK_LABEL_CELLS;

    const wide = WorldclockData.clockDisplayLabel("東".repeat(cells));
    assert.ok(TextUtils.displayWidth(wide) <= cells,
        "24 ideographs are 24 code points and 48 cells");
    assert.ok(wide.endsWith("…"));

    // a name that fits either way is still untouched, and the budget is the
    // same number of cells a Latin name gets
    assert.equal(WorldclockData.clockDisplayLabel("東京"), "東京");
    assert.equal(TextUtils.displayWidth(
        WorldclockData.clockDisplayLabel("x".repeat(cells))), cells);
});

test("configured clocks require visible normalized labels", () => {
    loadWorldclocks();
    const WorldclockData =
        global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const selected = WorldclockData.selectUserClocks([
        { label: "   ", timezone: "Asia/Tokyo" },
        { label: "", timezone: "America/New_York" },
        { label: 42, timezone: "Australia/Sydney" },
        { label: "Missing timezone" },
        { label: " Rome ", timezone: " Europe/Rome " }
    ]);

    assert.deepEqual(selected, [{ label: "Rome", timezone: "Europe/Rome" }]);
    assert.equal(WorldclockData.clockDisplayLabel(" Tokyo "), "Tokyo");
    assert.equal(WorldclockData.clockDisplayLabel("\t\n"), "");
});

test("configured timezones use the settings editor length bound", () => {
    loadWorldclocks();
    const WorldclockData =
        global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const maximum = WorldclockData.MAX_CLOCK_TIMEZONE_LENGTH;
    const exact = "R/" + "x".repeat(maximum - 2);
    const oversized = exact + "x";

    assert.equal(maximum, 64);
    assert.deepEqual(WorldclockData.selectUserClocks([
        { label: "Too long", timezone: oversized },
        { label: "Exact", timezone: exact }
    ]), [{ label: "Exact", timezone: exact }]);
});

// T729: textUtils names "a world clock's label" as exactly what its shared
// control-character rule is for, and this was the one caller that clamped
// without it. A Display name pasted with an embedded newline reached the popup
// row's St.Label verbatim — a second line that shifts the calendar grid — and
// became one cell of the monospace panel tooltip, whose padding is computed
// from the cell's code-point count, so the newline both split the row and
// misaligned every column of the table.
test("clock label whitespace agrees with settings", () => {
    loadWorldclocks();
    const data = global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const cases = require("./fixtures/settings_whitespace_cases.json");
    for (const entry of cases) {
        assert.equal(data.clockInputLabel(entry.input), entry.clockLabel);
    }
    assert.deepEqual(data.selectUserClocks([{ label: "\ufeff", timezone: "Europe/Rome" }]), []);
});

test("a pasted control character cannot reach a clock label", () => {
    loadWorldclocks();
    const WorldclockData =
        global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;

    assert.equal(WorldclockData.clockInputLabel("Home\nOffice"), "Home Office");
    // a run of them collapses to one space, and the edges still trim
    assert.equal(WorldclockData.clockInputLabel("\r\n Home\u000b\u000cOffice \t"),
        "Home Office");
    // C1 controls are invisible in a text field but not to Pango
    assert.equal(WorldclockData.clockInputLabel("HomeOffice"), "Home Office");
    // a label that is nothing but controls is no label at all
    assert.deepEqual(WorldclockData.selectUserClocks(
        [{ label: "\u0085\u0000", timezone: "Asia/Tokyo" }]), []);

    // and the whole stored read path goes through it
    assert.deepEqual(
        WorldclockData.selectUserClocks([{ label: "Home\nOffice", timezone: "Europe/Rome" }]),
        [{ label: "Home Office", timezone: "Europe/Rome" }]);
});

// Cinnamon fires a text entry's changed signal on every keystroke, and
// updateFormatString used to call buildClocks: typing a 20-character custom
// format destroyed and rebuilt every label, re-resolved every GLib.TimeZone and
// relaid out the menu subtree twenty times, on the compositor thread.
test("changing the format re-renders the clocks without rebuilding them", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([{ label: "Tokyo", timezone: "Asia/Tokyo" }]);
    worldclocks.updateClocks();
    const actors = worldclocks.clocks.map((clock) => clock.display);
    const before = worldclocks.clocks.at(-1).display.text;

    worldclocks.setFormat("%H:%M:%S");
    assert.deepEqual(worldclocks.clocks.map((clock) => clock.display), actors,
        "the actors are the same objects: nothing was destroyed");

    worldclocks.updateClocks();
    assert.notEqual(worldclocks.clocks.at(-1).display.text, before,
        "and the new format is what they now say");

    // the same format twice is not a change
    worldclocks.clocks.forEach((clock) => { clock.rendered_time = "sentinel"; });
    worldclocks.setFormat("%H:%M:%S");
    assert.ok(worldclocks.clocks.every((clock) => clock.rendered_time === "sentinel"));

    worldclocks.buildClocks([{ label: "Rome", timezone: "Europe/Rome" }]);
    assert.equal(worldclocks.format, "%H:%M:%S",
        "rebuilding configured rows does not reset the view-owned format");
});

test("world-clock formats and rendered stamps stay within shared bounds", () => {
    const { Worldclocks } = loadWorldclocks();
    const DateFormats =
        global.imports.ui.appletManager.applets["chronos@geraldo-netto"].dateFormats;
    const worldclocks = new Worldclocks({ add_actor() {} });
    const maxFormat = DateFormats.MAX_DATE_FORMAT_LENGTH;
    const maxStamp = DateFormats.MAX_CLOCK_STAMP_LENGTH;

    worldclocks.setFormat(" ".repeat(maxFormat + 1));
    assert.equal(worldclocks.format, "%H:%M",
        "overlong whitespace falls back before GLib formats it");
    worldclocks.buildClocks([]);

    worldclocks.setFormat("x".repeat(maxFormat + 1));
    assert.equal(worldclocks.format, "%H:%M",
        "overlong non-whitespace is rejected too");

    worldclocks.setFormat("%Z".repeat(Math.floor(maxFormat / 2)));
    worldclocks.updateClocks();
    assert.ok(worldclocks.clocks.every(
        (clock) => Array.from(clock.display.text).length <= maxStamp));
    assert.ok(worldclocks.clocks.every(
        (clock) => clock.display.text.endsWith("…")));
});

// the service that answered was named only in the panel's mouse tooltip
// REGRESSION: the reading reached the row's accessible name and the panel's mouse
// tooltip, and nowhere a user could look at — while settings-schema.json promised
// units "used … for the temperature beside each world clock". Open the menu with
// the hotkey, or on a touchscreen, and the rows were bare times.
test("each clock row draws its city's temperature, not just says it", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });
    worldclocks.buildClocks([{ label: "Tokyo", timezone: "Asia/Tokyo" }]);

    const tokyo = worldclocks.clocks.at(-1);
    const reading = {
        clock: tokyo, label: "Tokyo", time: "18:00",
        weather: "12°C, Rain", temperature: "12°C", builtin: false
    };
    worldclocks.updateClocks([reading]);

    assert.equal(tokyo.weather.text, "12°C", "the cell carries the temperature");
    assert.match(tokyo.display.accessible_name, /Rain/,
        "and the name still carries the condition in words");

    // written once: this runs on every tick and St compares by pointer
    const before = tokyo.weather.texts.length;
    worldclocks.updateClocks([reading]);
    assert.equal(tokyo.weather.texts.length, before);

    // a row with no reading yet shows an empty cell, not a stale one
    worldclocks.updateClocks([
        { clock: tokyo, label: "Tokyo", time: "18:01", builtin: false }
    ]);
    assert.equal(tokyo.weather.text, "");
});

// REGRESSION: the cell was recovered as String(entry.weather).split(",")[0], so a
// row that had an error and no reading put the whole sentence in a column styled
// `text-align: right` with no width cap — and any comma a translator used in
// "⚠ Last known reading" or "No weather for this timezone" cut it mid-phrase.
test("a clock row whose weather failed leaves the temperature column empty", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });
    worldclocks.buildClocks([{ label: "Tokyo", timezone: "Asia/Tokyo" }]);

    const tokyo = worldclocks.clocks.at(-1);
    const failure = "⚠ No weather for this timezone, sorry";
    worldclocks.updateClocks([
        { clock: tokyo, label: "Tokyo", time: "18:00", weather: failure,
            temperature: "", builtin: false }
    ]);

    assert.equal(tokyo.weather.text, "",
        "the narrow column shows no temperature, not the error sentence");
    assert.match(tokyo.display.accessible_name, /No weather for this timezone, sorry/,
        "the row still says why, where there is room to say it");
});

test("the clock list names the weather service that answered", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.setWeatherSource("Open-Meteo");
    assert.match(worldclocks.actor.accessible_name, /World clocks/);
    assert.match(worldclocks.actor.accessible_name, /Open-Meteo/);

    worldclocks.setWeatherSource("Open-Meteo, MET Norway");
    assert.match(worldclocks.actor.accessible_name, /Open-Meteo, MET Norway/,
        "mixed displayed readings credit every distinct provider");

    // written once: the name is rebuilt every tick and St compares by pointer
    const first = worldclocks.actor.accessible_name;
    worldclocks.setWeatherSource("Open-Meteo, MET Norway");
    assert.equal(worldclocks.actor.accessible_name, first);

    // with weather off there is no source, and the list is just the list
    worldclocks.setWeatherSource("");
    assert.equal(worldclocks.actor.accessible_name, "World clocks");
});

// The point of a world clock is that Tokyo is not London. Nothing in this file
// could tell a correct clock from one an hour off, because the double answered
// with the format string it was handed. These are the assertions that need the
// arithmetic to be real: the offsets are spelled out, not derived.
test("each row reads its own zone's wall clock, not the applet's", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    // 11:45 UTC on 9 July 2026
    worldclocks.buildClocks([
        { label: "Tokyo", timezone: "Asia/Tokyo" },          // UTC+9, no DST
        { label: "Rome", timezone: "Europe/Rome" },          // UTC+2 in July (CEST)
        { label: "New York", timezone: "America/New_York" }, // UTC-4 in July (EDT)
        { label: "Kolkata", timezone: "Asia/Kolkata" }       // UTC+5:30 — the half hour
    ]);
    worldclocks.updateClocks();

    const shown = worldclocks.getClockEntries().map((entry) => [entry.label, entry.time]);
    assert.deepEqual(shown, [
        ["UTC", "11:45"],
        ["Local time", "08:45"],
        ["Tokyo", "20:45"],
        ["Rome", "13:45"],
        ["New York", "07:45"],
        ["Kolkata", "17:15"]
    ]);
});

test("regional clocks stay ordered from Japan through Europe to the Americas", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });
    const saved = NOW_MS;
    const cases = [
        {
            name: "winter",
            instant: Date.UTC(2026, 0, 15, 12, 0, 0),
            expected: ["21:00", "17:30", "13:00", "07:00", "04:00"]
        },
        {
            name: "summer",
            instant: Date.UTC(2026, 6, 15, 12, 0, 0),
            expected: ["21:00", "17:30", "14:00", "08:00", "05:00"]
        },
        {
            name: "UTC midnight rollover",
            instant: Date.UTC(2026, 6, 15, 23, 30, 0),
            expected: ["08:30", "05:00", "01:30", "19:30", "16:30"]
        }
    ];

    const clocks = [
        { label: "Tokyo", timezone: "Asia/Tokyo" },
        { label: "Kolkata", timezone: "Asia/Kolkata" },
        { label: "Rome", timezone: "Europe/Rome" },
        { label: "New York", timezone: "America/New_York" },
        { label: "Los Angeles", timezone: "America/Los_Angeles" }
    ];
    worldclocks.buildClocks(clocks);

    try {
        for (const current of cases) {
            NOW_MS = current.instant;
            const entries = worldclocks.getClockEntries().slice(BUILTIN_ROWS);
            worldclocks.updateClocks(entries);
            const displayed = worldclocks.clocks
                .slice(BUILTIN_ROWS)
                .map((clock) => clock.display.text);

            assert.deepEqual(displayed, current.expected, `${current.name} offsets`);
            assertClockEntryOrder(entries, current.name);
        }
    } finally {
        NOW_MS = saved;
    }
});

test("date-line, fractional-offset, and southern-DST clocks render exactly", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });
    const saved = NOW_MS;
    const cases = [
        {
            name: "January",
            instant: Date.UTC(2026, 0, 15, 12, 0, 0),
            expected: ["02:00", "01:45", "23:00", "22:30", "21:00", "17:45", "08:30", "01:00"]
        },
        {
            name: "July",
            instant: Date.UTC(2026, 6, 15, 12, 0, 0),
            expected: ["02:00", "00:45", "22:00", "21:30", "21:00", "17:45", "09:30", "01:00"]
        }
    ];
    const clocks = [
        { label: "Kiritimati", timezone: "Pacific/Kiritimati" },
        { label: "Chatham", timezone: "Pacific/Chatham" },
        { label: "Sydney", timezone: "Australia/Sydney" },
        { label: "Adelaide", timezone: "Australia/Adelaide" },
        { label: "Tokyo", timezone: "Asia/Tokyo" },
        { label: "Kathmandu", timezone: "Asia/Kathmandu" },
        { label: "St. John's", timezone: "America/St_Johns" },
        { label: "Pago Pago", timezone: "Pacific/Pago_Pago" }
    ];
    worldclocks.buildClocks(clocks);

    try {
        for (const current of cases) {
            NOW_MS = current.instant;
            const entries = worldclocks.getClockEntries().slice(BUILTIN_ROWS);
            worldclocks.updateClocks(entries);
            const displayed = worldclocks.clocks
                .slice(BUILTIN_ROWS)
                .map((clock) => clock.display.text);

            assert.deepEqual(displayed, current.expected, `${current.name} offsets`);
            assertClockEntryOrder(entries, current.name);
        }
    } finally {
        NOW_MS = saved;
    }
});

test("fuzz: timezone order and rendering hold across random instants", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });
    const random = makeRandom(FUZZ_SEED + 1);
    const saved = NOW_MS;
    const start = Date.UTC(2000, 0, 1);
    const span = Date.UTC(2040, 0, 1) - start;
    const clocks = [
        { label: "Kiritimati", timezone: "Pacific/Kiritimati" },
        { label: "Chatham", timezone: "Pacific/Chatham" },
        { label: "Tokyo", timezone: "Asia/Tokyo" },
        { label: "Kathmandu", timezone: "Asia/Kathmandu" },
        { label: "Rome", timezone: "Europe/Rome" },
        { label: "St. John's", timezone: "America/St_Johns" },
        { label: "Los Angeles", timezone: "America/Los_Angeles" },
        { label: "Pago Pago", timezone: "Pacific/Pago_Pago" }
    ];
    worldclocks.buildClocks(clocks);

    try {
        for (let round = 0; round < 100; round++) {
            NOW_MS = start + Math.floor(random() * span);
            const context = `seed ${FUZZ_SEED + 1}, round ${round}`;
            const entries = worldclocks.getClockEntries().slice(BUILTIN_ROWS);
            const expected = clocks.map((clock) => timeIn(clock.timezone));
            worldclocks.updateClocks(entries);

            assert.deepEqual(entries.map((entry) => entry.time), expected, context);
            assert.deepEqual(
                worldclocks.clocks.slice(BUILTIN_ROWS).map((clock) => clock.display.text),
                expected,
                context);
            assertClockEntryOrder(entries, context);
        }
    } finally {
        NOW_MS = saved;
    }
});

// The applet anchors its date arithmetic at noon precisely so a transition day
// cannot shift it, and nothing tested a transition. Europe/Rome springs forward
// at 01:00 UTC on the last Sunday in March: the same instant is 01:59 CET one
// minute and 03:00 CEST the next, and a clock that read the offset once and kept
// it would still say 02:00.
test("a clock crossing a DST transition reads the new offset, not the old one", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });
    const saved = NOW_MS;

    try {
        // 2026-03-29T00:59:00Z — one minute before Rome springs forward
        NOW_MS = Date.UTC(2026, 2, 29, 0, 59, 0);
        worldclocks.buildClocks([{ label: "Rome", timezone: "Europe/Rome" }]);
        worldclocks.updateClocks();
        assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, "01:59", "CET, UTC+1");

        // 01:00 UTC: 02:00 never happens in Rome that morning
        NOW_MS = Date.UTC(2026, 2, 29, 1, 0, 0);
        worldclocks.updateClocks();
        assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, "03:00", "CEST, UTC+2");

        // and back the other way, in October: 02:59 CEST, then 02:00 CET again
        NOW_MS = Date.UTC(2026, 9, 25, 0, 59, 0);
        worldclocks.updateClocks();
        assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, "02:59");
        NOW_MS = Date.UTC(2026, 9, 25, 1, 0, 0);
        worldclocks.updateClocks();
        assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, "02:00",
            "the hour repeats, and the clock repeats with it");
    } finally {
        NOW_MS = saved;
    }
});

test("updateClocks formats every configured timezone", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([
        { label: "Tokyo", timezone: "Asia/Tokyo" },
        { label: "Rome", timezone: "Europe/Rome" }
    ]);
    worldclocks.updateClocks();

    assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, timeIn("Asia/Tokyo"));
    assert.equal(worldclocks.clocks[BUILTIN_ROWS + 1].display.text, timeIn("Europe/Rome"));
    const entries = worldclocks.getClockEntries();
    assert.deepEqual(entries.map((entry) => [entry.label, entry.time, entry.builtin]), [
        ["UTC", timeIn("UTC"), true],
        ["Local time", timeIn(LOCAL_TIMEZONE), true],
        ["Tokyo", timeIn("Asia/Tokyo"), false],
        ["Rome", timeIn("Europe/Rome"), false]
    ]);
    entries[BUILTIN_ROWS].time = "cached";
    worldclocks.updateClocks(entries);
    assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, "cached");
});

// T75 regression: per-tick refreshes must not rewrite unchanged labels
test("updateClocks skips label writes when the time text is unchanged", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([
        { label: "Tokyo", timezone: "Asia/Tokyo" },
        { label: "Rome", timezone: "Europe/Rome" }
    ]);

    const writes = worldclocks.clocks.map(() => 0);
    worldclocks.clocks.forEach((clock, i) => {
        const original = clock.display.set_text.bind(clock.display);
        clock.display.set_text = (text) => { writes[i]++; original(text); };
    });

    worldclocks.updateClocks();
    worldclocks.updateClocks();
    worldclocks.updateClocks();
    assert.deepEqual(writes, [1, 1, 1, 1], "stable text is written exactly once");

    // a changed formatted time still lands
    worldclocks.clocks[BUILTIN_ROWS].tz = fakeTimeZone("Etc/GMT+1");
    worldclocks.updateClocks();
    assert.deepEqual(writes, [1, 1, 2, 1]);
    assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, timeIn("Etc/GMT+1"));
});

test("invalid timezones are marked instead of silently using UTC", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([
        { label: "Bad", timezone: "Invalid/Zone" }
    ]);
    worldclocks.updateClocks();

    const bad = worldclocks.clocks[BUILTIN_ROWS];
    assert.equal(bad.display.text, "Invalid timezone");
    assert.equal(bad.display.options.style_class, "calendar-world-time calendar-world-time-invalid");
    const badEntry = worldclocks.getClockEntries().find((entry) => entry.label === "Bad");
    assert.equal(badEntry.time, "Invalid timezone");
    assert.equal(badEntry.builtin, false);
});

test("the world-clock block can be hidden entirely", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([{ label: "Tokyo", timezone: "Asia/Tokyo" }]);

    worldclocks.setVisible(false);
    assert.equal(worldclocks.actor.visible, false, "including the built-in UTC and local rows");

    worldclocks.setVisible(true);
    assert.equal(worldclocks.actor.visible, true);
});

test("world clocks start with the default format", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([{ label: "Tokyo", timezone: "Asia/Tokyo" }]);
    worldclocks.updateClocks();

    assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, timeIn("Asia/Tokyo"));
});

function randomLabel(random, alphabet) {
    const length = Math.floor(random() * 20);
    let label = "";
    for (let i = 0; i < length; i++) {
        label += alphabet[Math.floor(random() * alphabet.length)];
    }
    return label;
}

function randomClockEntries(random, alphabet) {
    const count = Math.floor(random() * 26);
    return Array.from({ length: count }, (_, index) => {
        if (random() < 0.15) {
            return pickRandom(random, [
                null, "clock", {}, { label: "Missing zone" },
                { label: 42, timezone: zoneAt(index) }
            ]);
        }
        const invalid = random() < 0.4;
        return {
            label: randomLabel(random, alphabet),
            timezone: invalid ? `Invalid/Fuzz${index}` : zoneAt(index),
            invalid
        };
    });
}

function assertClockMatchesEntry(clock, entry) {
    const data = global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    assert.equal(clock.label, data.clockDisplayLabel(entry.label));
    assert.equal(clock.full_label, entry.label);
    if (!knownTimeZone(entry.timezone)) {
        assert.equal(clock.display.text, "Invalid timezone");
        assert.equal(clock.display.options.style_class,
            "calendar-world-time calendar-world-time-invalid");
    } else {
        assert.equal(clock.display.text, timeIn(entry.timezone));
        assert.equal(clock.display.options.style_class, "calendar-world-time");
    }
}

test("fuzzed clock lists never crash and always respect the cap and invalid marking", () => {
    const { Worldclocks, MAX_CLOCKS } = loadWorldclocks();
    const WorldclockData =
        global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const random = makeRandom();
    const labelAlphabet = "abcXYZ0189 -_/中東€é​";

    for (let round = 0; round < 50; round++) {
        const entries = randomClockEntries(random, labelAlphabet);

        const worldclocks = new Worldclocks({ add_actor() {} });
        worldclocks.buildClocks(entries);
        worldclocks.updateClocks();

        const shown = WorldclockData.selectUserClocks(entries);
        // built-ins keep the list visible even with nothing configured
        assert.equal(worldclocks.actor.visible, true);
        assert.ok(shown.length <= MAX_CLOCKS);
        assert.equal(worldclocks.clocks.length, BUILTIN_ROWS + shown.length);

        // every row attaches a label, a time display and a temperature cell
        assert.equal(worldclocks.layout.children.length, (BUILTIN_ROWS + shown.length) * 3);

        shown.forEach((entry, index) =>
            assertClockMatchesEntry(worldclocks.clocks[BUILTIN_ROWS + index], entry));

        const texts = worldclocks.getClockEntries()
            .filter((entry) => !entry.builtin)
            .map((entry) => ({ label: entry.label, time: entry.time }));
        assert.equal(texts.length, shown.length);
        texts.forEach((text) => {
            assert.equal(typeof text.label, "string");
            assert.ok(text.time.length > 0);
        });
    }
});

test("invalid-timezone text uses the shared translator", () => {
    const translations = [];
    const { Worldclocks } = loadWorldclocks({
        translate(str) {
            translations.push(str);
            return str === "Invalid timezone" ? "Zeitzone ungültig" : str;
        }
    });

    const worldclocks = new Worldclocks({ add_actor() {} });
    worldclocks.buildClocks([{ label: "Bad", timezone: "Invalid/Zone" }]);
    worldclocks.updateClocks();

    assert.deepEqual(translations, ["Invalid timezone", "Local time"]);
    assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, "Zeitzone ungültig");
});

test("untranslated strings inherit the shared translator fallback", () => {
    const lookups = [];
    const { Worldclocks } = loadWorldclocks({
        translate(str) {
            lookups.push(str);
            return `cinnamon:${str}`;
        }
    });

    const worldclocks = new Worldclocks({ add_actor() {} });
    worldclocks.buildClocks([{ label: "Bad", timezone: "Invalid/Zone" }]);
    worldclocks.updateClocks();

    assert.deepEqual(lookups, ["Invalid timezone", "Local time"]);
    assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, "cinnamon:Invalid timezone");
});

test("6.0 worldclocks module exports the presentation class", () => {
    const { Worldclocks } = loadWorldclocks();
    assert.equal(typeof Worldclocks, "function");
});

// worldclockData is loaded by two different module systems: GJS resolves its
// siblings through imports.ui.appletManager and has no require(), Node has
// require() and no `imports`. Only one arm runs per host, so compile the module
// once and run it against both: a symbol that resolves under Node but comes
// back undefined under the GJS importer is how the applet breaks on a desktop
// while the suite stays green.
test("worldclockData exposes the same API under the GJS importer and under Node", () => {
    const vm = require("node:vm");
    const script = new vm.Script(fs.readFileSync(dataModulePath, "utf8"), { filename: dataModulePath });

    const gjsContext = {
        imports: {
            gi: { GLib: { TimeZone: { new_identifier: (tz) => ({ get_identifier: () => tz }) } } },
            ui: {
                appletManager: {
                    applets: {
                        "chronos@geraldo-netto": {
                            clockLimits: { MAX_CLOCKS: 8 },
                            localeText: { translate: (str) => str },
                            textUtils: {
                                clampText: (text, max) => String(text).slice(0, max)
                            },
                            ioUtils: { readTextFileCapped: () => "" },
                            providerUtils: require(providerUtilsPath)
                        }
                    }
                }
            }
        }
    };
    script.runInNewContext(gjsContext);

    // Node has no `imports` binding in module scope; the applet reaches the
    // GJS globals through globalThis instead
    const nodeContext = {
        require: (request) => require(path.join(path.dirname(dataModulePath), request)),
        module: { exports: {} },
        globalThis: { imports: gjsContext.imports },
        // the loader guard asks whether this is Node, not whether require() exists
        process: { versions: { node: process.versions.node } }
    };
    require.cache[require.resolve(localeTextPath)] = { exports: { translate: (str) => str } };
    // the shared I/O adapter binds Gio at load, and this context has no imports
    require.cache[require.resolve(ioUtilsPath)] =
        { exports: { readTextFileCapped: () => "" } };
    script.runInNewContext(nodeContext);

    for (const symbol of Object.keys(nodeContext.module.exports)) {
        assert.notEqual(gjsContext[symbol], undefined,
            `worldclockData.${symbol} is missing when loaded through imports.ui.appletManager`);
    }
    assert.equal(gjsContext.MAX_CLOCKS, 8);
    assert.equal(gjsContext.UTC_TIMEZONE, "UTC");
});

test("timezoneIdentity asks the zone for its identifier, and answers null for none", () => {
    loadWorldclocks();
    const WorldclockData = require(dataModulePath);

    // new_identifier answers null for a zone it does not know; that is the only
    // way there is no zone to name
    assert.equal(WorldclockData.timezoneIdentity(null), null);
    assert.equal(WorldclockData.timezoneIdentity(fakeTimeZone("Etc/UTC")), "Etc/UTC");
});

test("timezoneWeatherRequest reads the place out of the identifier, not the label", () => {
    loadWorldclocks();
    const WorldclockData = require(dataModulePath);

    assert.equal(weatherCity(WorldclockData, "America/New_York"), "New York");
    assert.equal(weatherCity(WorldclockData, "America/Argentina/Buenos_Aires"), "Buenos Aires");
    assert.equal(weatherCity(WorldclockData, "Europe/Rome"), "Rome");
    assert.equal(weatherCity(WorldclockData, "US/Eastern"), "New York");
    assert.equal(weatherCity(WorldclockData, "Canada/Eastern"), "Toronto");
    assert.equal(weatherCity(WorldclockData, "Brazil/East"), "Sao Paulo");

    const aliasClock = WorldclockData.selectUserClocks([
        { label: "Legacy", timezone: "US/Eastern" }
    ])[0];
    assert.deepEqual(aliasClock, { label: "Legacy", timezone: "US/Eastern" },
        "canonicalizing the weather city does not rewrite the saved or displayed timezone");

    const GLib = global.imports.gi.GLib;
    GLib.file_read_link = (filename) => filename.endsWith("/First") ? "Second" : "First";
    assert.equal(weatherCity(WorldclockData, "Europe/First"), "",
        "an alias cycle exposes no false city to the weather providers");

    // UTC names no place. The forced alias cycle also prevents resolving the
    // current local timezone to a geographic request.
    assert.equal(weatherCity(WorldclockData, WorldclockData.UTC_TIMEZONE), "");
    assert.equal(weatherCity(WorldclockData, WorldclockData.LOCAL_TIMEZONE), "");

    // and neither is junk, or a bare word that is not an IANA path
    assert.equal(weatherCity(WorldclockData, "tokyo"), "");
    assert.equal(weatherCity(WorldclockData, ""), "");
    assert.equal(weatherCity(WorldclockData, null), "");
    assert.equal(weatherCity(WorldclockData, 42), "");
});

// T1001: the alias probe and the alias chase both started with a readlink on
// the same identifier, so every uncached zone cost two syscalls on the
// compositor thread where one would do.
test("timezoneWeatherRequest reads each zoneinfo link once", () => {
    loadWorldclocks();
    const WorldclockData = require(dataModulePath);
    const GLib = global.imports.gi.GLib;

    const reads = [];
    GLib.file_read_link = (filename) => {
        reads.push(filename);
        return filename.endsWith("US/Eastern") ? "../America/New_York" : undefined;
    };

    assert.equal(weatherCity(WorldclockData, "Europe/Rome"), "Rome");
    assert.deepEqual(reads, ["/usr/share/zoneinfo/Europe/Rome"],
        "a plain zone costs exactly one readlink");

    reads.length = 0;
    assert.equal(weatherCity(WorldclockData, "US/Eastern"), "New York");
    assert.deepEqual(reads, [
        "/usr/share/zoneinfo/US/Eastern",
        "/usr/share/zoneinfo/America/New_York"
    ], "an alias costs one readlink per hop and no probe");
});

// T654: the open menu asks for the same city on every tick, and each cold
// resolution is a TimeZone construction plus a synchronous readlink alias
// chase on the compositor thread
test("timezoneWeatherRequest memoizes per identifier and leaves local alone", () => {
    loadWorldclocks();
    const WorldclockData = require(dataModulePath);
    const GLib = global.imports.gi.GLib;
    const originalReadLink = GLib.file_read_link;
    const originalNewLocal = GLib.TimeZone.new_local;
    let readlinks = 0;
    GLib.file_read_link = (filename) => {
        readlinks++;
        return originalReadLink(filename);
    };

    try {
        assert.equal(weatherCity(WorldclockData, "US/Eastern"), "New York");
        const resolved = readlinks;
        assert.ok(resolved > 0, "the first resolution walks the alias chain");
        assert.equal(weatherCity(WorldclockData, "US/Eastern"), "New York");
        assert.equal(readlinks, resolved, "the second answer comes from the memo");

        // "local" names whatever the OS timezone is right now: never memoized
        GLib.TimeZone.new_local = () => fakeTimeZone("America/New_York");
        assert.equal(weatherCity(WorldclockData, WorldclockData.LOCAL_TIMEZONE),
            "New York");
        GLib.TimeZone.new_local = () => fakeTimeZone("Europe/Rome");
        assert.equal(weatherCity(WorldclockData, WorldclockData.LOCAL_TIMEZONE),
            "Rome");

        // The memo is bounded, and it gives up its least recently used entry
        // rather than all of them. US/Eastern went in first, so a plain
        // insertion order would evict it first however often it is asked for;
        // reading it once during the fill is what moves it out of the way.
        assert.equal(weatherCity(WorldclockData, "Europe/Rome"), "Rome");

        const cap = WorldclockData.MAX_MEMOIZED_WEATHER_CITIES;
        for (let i = 0; i < cap; i++) {
            assert.equal(weatherCity(WorldclockData, `Fill/Zone${i}`), "");
            if (i === 0) {
                assert.equal(weatherCity(WorldclockData, "US/Eastern"), "New York");
            }
        }

        const afterFill = readlinks;
        assert.equal(weatherCity(WorldclockData, "US/Eastern"), "New York");
        assert.equal(readlinks, afterFill,
            "the zone that was read during the fill is still remembered");

        // ...and the one that was not is the one that went, on its own: a
        // wholesale clear would have taken US/Eastern with it
        assert.equal(weatherCity(WorldclockData, "Europe/Rome"), "Rome");
        assert.ok(readlinks > afterFill, "the evicted entry is resolved again");
    } finally {
        GLib.file_read_link = originalReadLink;
        GLib.TimeZone.new_local = originalNewLocal;
    }
});

// a clock whose zone cannot be resolved contributes no key: the built-in set
// must not gain an "undefined" entry that then matches every broken clock
test("builtInTimezoneKeys skips zones that do not resolve and always holds Etc/UTC", () => {
    loadWorldclocks();
    const WorldclockData = require(dataModulePath);
    const GLib = global.imports.gi.GLib;
    const original = GLib.TimeZone.new_identifier;
    GLib.TimeZone.new_identifier = (tz) => (tz === "Broken/Zone" ? null : { get_identifier: () => tz });

    try {
        const keys = WorldclockData.builtInTimezoneKeys([
            { label: "Broken", timezone: "Broken/Zone" },
            { label: "UTC", timezone: "UTC" }
        ]);
        assert.deepEqual(Array.from(keys).sort(), ["Etc/UTC", "UTC"]);
    } finally {
        GLib.TimeZone.new_identifier = original;
    }
});

// The clock's display name is free text from the settings dialog. This label had
// no max-width, no ellipsize and no tooltip, so a long one ("Mom's place in
// Buenos Aires") widened the whole popup — the calendar grid with it — to fit one
// name. The 24-character clamp applies to the *panel* label, not to this one.
test("a long clock name ellipsizes instead of widening the popup", () => {
    const { Worldclocks } = loadWorldclocks();
    const Pango = global.imports.gi.Pango;
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks(
        [{ label: "Mom's place in Buenos Aires", timezone: "America/Argentina/Buenos_Aires" }]);

    const nameLabels = worldclocks.layout.children
        .filter((cell) => cell.column === 0)
        .map((cell) => cell.child);
    const long = nameLabels.find((label) => label.text.startsWith("Mom's place"));

    assert.ok(long, "the clock is on the grid");
    assert.equal(long.get_clutter_text().ellipsize, Pango.EllipsizeMode.END,
        "it is cut, not allowed to widen the popup");
    assert.equal(long.options.style_class, "calendar-world-label",
        "and the width it is cut to comes from the stylesheet");

    // ellipsized text is text the user cannot read: the hover gives it back
    const css = fs.readFileSync(
        path.join(__dirname, "..", "files", "chronos@geraldo-netto", "6.0", "stylesheet.css"),
        "utf8");
    assert.match(css, /\.calendar-world-label\s*\{[^}]*max-width/);
});

test("a truncated clock label accepts hover through its parent without becoming an action", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });
    const fullLabel = "A deliberately long Tokyo world clock label beyond the display limit";
    worldclocks.buildClocks([{ label: fullLabel, timezone: "Asia/Tokyo" }]);
    const label = worldclocks.layout.children.find((cell) =>
        cell.column === 0 && cell.row === BUILTIN_ROWS).child;
    assert.notEqual(label.text, fullLabel);
    assert.equal(label.parent, worldclocks.actor);
    label.pointerEnter();
    assert.equal(label.visible_tooltip, fullLabel, "both label and parent must participate in picking");
    assert.equal(worldclocks.actor.options.can_focus, false);
    assert.equal(label.options.can_focus, false);
    assert.ok(label instanceof MockLabel, "the hover target remains a label, not a button");
    assert.equal(label.handlers.has("clicked"), false);
});

test("the local world clock uses the current timezone city for its weather", () => {
    loadWorldclocks();
    const WorldclockData = require(dataModulePath);
    const GLib = global.imports.gi.GLib;

    GLib.TimeZone.new_local = () => fakeTimeZone("Europe/Rome");
    assert.equal(weatherCity(WorldclockData, "local"), "Rome");

    GLib.TimeZone.new_local = () => fakeTimeZone("America/Argentina/Buenos_Aires");
    assert.equal(weatherCity(WorldclockData, "local"), "Buenos Aires");

    // a zone that names no place: an offset-only zone, a UTC machine, and a
    // /etc/localtime that is not a zoneinfo symlink at all
    GLib.TimeZone.new_local = () => fakeTimeZone("+02");
    assert.equal(weatherCity(WorldclockData, "local"), "");

    GLib.TimeZone.new_local = () => fakeTimeZone("UTC");
    assert.equal(weatherCity(WorldclockData, "local"), "");

    GLib.TimeZone.new_local = () => null;
    assert.equal(weatherCity(WorldclockData, "local"), "",
        "no zone at all is not a place either");
});

test("regionalTimezoneIdentifier accepts named regions but not offsets", () => {
    loadWorldclocks();
    const { regionalTimezoneIdentifier } = require(dataModulePath);

    assert.equal(regionalTimezoneIdentifier("  Europe/Vatican\n"), "Europe/Vatican",
        "a configured alias is preserved, not resolved to its canonical zone");
    assert.equal(regionalTimezoneIdentifier("America/Argentina/Buenos_Aires"),
        "America/Argentina/Buenos_Aires");

    for (const timezone of [
        "UTC", "Etc/UTC", "Etc/GMT+2", "+02", "GMT-03:00", "local", "",
        "Europe//Rome", "Europe/../Rome", "Europe/Rome!", "x".repeat(256), null, 42
    ]) {
        assert.equal(regionalTimezoneIdentifier(timezone), "",
            `${JSON.stringify(timezone)} does not identify a geographic region`);
    }
});

test("local timezone sources preserve aliases and have deterministic precedence", () => {
    loadWorldclocks();
    const { localTimezoneFromSources } = require(dataModulePath);

    assert.equal(localTimezoneFromSources(
        "Europe/Vatican\n", "/usr/share/zoneinfo/Europe/Rome", "Asia/Tokyo"),
    "Europe/Rome", "the effective /etc/localtime link wins");
    assert.equal(localTimezoneFromSources(
        "Europe/Rome", "/usr/share/zoneinfo/Etc/UTC", "Asia/Tokyo"),
    "", "an authoritative UTC link does not fall through to stale sources");
    assert.equal(localTimezoneFromSources(
        "Europe/Rome", "/etc/alternatives/localtime", "Asia/Tokyo"),
    "Asia/Tokyo", "GLib's effective identifier is second");
    assert.equal(localTimezoneFromSources(
        "Europe/Rome", "/etc/alternatives/localtime", "+02"),
    "", "an authoritative fixed offset does not use stale plaintext");
    assert.equal(localTimezoneFromSources(
        "Europe/Vatican\n", "/etc/alternatives/localtime", null),
    "Europe/Vatican", "/etc/timezone is the last fallback");
});

test("timezone symlink targets stay inside zoneinfo", () => {
    loadWorldclocks();
    const { timezoneAliasTarget } = require(dataModulePath);

    assert.equal(timezoneAliasTarget("Europe/Bratislava", "Prague"),
        "Europe/Prague");
    assert.equal(timezoneAliasTarget("US/Eastern", "../America/New_York"),
        "America/New_York");
    assert.equal(timezoneAliasTarget(
        "Europe/Alias", "/usr/share/zoneinfo/Europe/Rome"), "Europe/Rome");
    assert.equal(timezoneAliasTarget("Europe/Alias", "./Rome"), "Europe/Rome");

    for (const target of [
        "/etc/passwd", "../../etc/passwd", "../Europe/Rome!", "../Etc/UTC",
        `Europe/${"x".repeat(1024)}`, "Europe/Rome\0suffix", "", null
    ]) {
        assert.equal(timezoneAliasTarget("Europe/Alias", target), "",
            `${JSON.stringify(target)} cannot escape or corrupt zoneinfo`);
    }
    assert.equal(timezoneAliasTarget("UTC", "Europe/Rome"), "");
});

test("canonical timezone symlink resolution is bounded and cycle-safe", () => {
    loadWorldclocks();
    const { canonicalTimezoneFromSymlinks } = require(dataModulePath);
    const links = new Map([
        ["/usr/share/zoneinfo/US/Eastern", "../America/New_York"],
        ["/usr/share/zoneinfo/Europe/First", "Second"],
        ["/usr/share/zoneinfo/Europe/Second", "First"]
    ]);
    const readLink = (filename) => links.has(filename) ? links.get(filename) : null;

    assert.equal(canonicalTimezoneFromSymlinks("US/Eastern", readLink),
        "America/New_York");
    assert.equal(canonicalTimezoneFromSymlinks("Europe/Rome", readLink),
        "Europe/Rome",
        "a zone that is not a link is already its own canonical name");
    assert.equal(canonicalTimezoneFromSymlinks("Europe/First", readLink), "",
        "cycles fail closed");
    assert.equal(canonicalTimezoneFromSymlinks("UTC", readLink), "");
    assert.equal(canonicalTimezoneFromSymlinks("Europe/Rome", null), "");

    const endless = (filename) => {
        const match = filename.match(/Alias(\d+)$/);
        return `Alias${Number(match[1]) + 1}`;
    };
    assert.equal(canonicalTimezoneFromSymlinks("Europe/Alias0", endless), "",
        "an alias chain cannot exceed the hop cap");

    assert.equal(canonicalTimezoneFromSymlinks("US/Eastern", (filename) => {
        if (filename.endsWith("US/Eastern")) {
            return "../America/New_York";
        }
        throw new Error("regular zoneinfo file");
    }), "America/New_York", "a regular canonical endpoint finishes the chain");
});

test("countryCodeFromZoneTab performs an exact timezone lookup", () => {
    loadWorldclocks();
    const { countryCodeFromZoneTab } = require(dataModulePath);
    const zoneTab = [
        "# country-code\tcoordinates\tTZ\tcomments",
        "",
        "IT\t+4154+01229\tEurope/Rome",
        "VA\t+415408+0122711\tEurope/Vatican\tVatican City",
        "US\t+404251-0740023\tUS/Eastern"
    ].join("\r\n");

    assert.equal(countryCodeFromZoneTab("Europe/Rome", zoneTab), "IT");
    assert.equal(countryCodeFromZoneTab("Europe/Vatican", zoneTab), "VA",
        "a backward-link alias remains independently mappable");
    assert.equal(countryCodeFromZoneTab("US/Eastern", zoneTab), "US");
    assert.equal(countryCodeFromZoneTab("Europe/Milan", zoneTab), "",
        "a nearby city is not inferred from the Area prefix");
    assert.equal(countryCodeFromZoneTab("UTC", zoneTab), "");
    assert.equal(countryCodeFromZoneTab("Etc/GMT+1", zoneTab), "");
    assert.equal(countryCodeFromZoneTab("+02", zoneTab), "");
});

// T1013: aborting the whole table on one bad row withdraws automatic
// holiday-country inference for unrelated valid rows. Keep those rows and
// report the skipped row so the damaged source can still be investigated.
test("a malformed zone.tab row is logged and valid mappings survive", () => {
    loadWorldclocks();
    const { countryCodeFromZoneTab } = require(dataModulePath);
    const logged = [];
    global.logError = (message) => logged.push(message);

    const zoneTab = [
        "IT\t+4154+01229\tEurope/Rome",
        "FR\t+4852+00220\tEurope/Rome"
    ].join("\n");

    assert.equal(countryCodeFromZoneTab("Europe/Rome", zoneTab), "IT");
    assert.equal(logged.length, 1, "the parse failure is reported once");
    assert.ok(logged[0].includes("zone.tab"), "the log names the file");
    assert.ok(logged[0].includes("Europe/Rome"), "and the offending row");
    assert.match(logged[0], /skipping/i);

    // a table that parses says nothing
    logged.length = 0;
    assert.equal(countryCodeFromZoneTab("Europe/Rome",
        "IT\t+4154+01229\tEurope/Rome"), "IT");
    assert.deepEqual(logged, [], "a clean table is silent");
});

test("countryCodeFromZoneTab skips malformed rows and rejects missing or oversized tables", () => {
    loadWorldclocks();
    const { countryCodeFromZoneTab, MAX_ZONE_TAB_BYTES } = require(dataModulePath);
    const rome = "IT\t+4154+01229\tEurope/Rome";
    const malformedRows = [
        "FR\t+4852+00220\tEurope/Paris\textra\tfield",
        "I\t+4852+00220\tEurope/Paris",
        "FR\tnowhere\tEurope/Paris",
        "FR\t+4852+00220\tParis",
        "FR\t+4852+00220\tEurope/Rome"
    ];

    for (const malformed of malformedRows) {
        assert.equal(countryCodeFromZoneTab("Europe/Rome", `${rome}\n${malformed}`), "IT",
            `the valid mapping survives malformed row ${JSON.stringify(malformed)}`);
    }

    assert.equal(countryCodeFromZoneTab("Europe/Rome", `IT\tbad\tEurope/Rome\n${rome}`), "IT",
        "a rejected row does not reserve a timezone before its valid mapping");
    assert.equal(countryCodeFromZoneTab("Europe/Paris", `${rome}\nFR\tbad\tEurope/Paris`), "",
        "a malformed row never supplies its country code");

    assert.equal(countryCodeFromZoneTab("Europe/Rome", ""), "");
    assert.equal(countryCodeFromZoneTab("Europe/Rome", null), "");
    assert.equal(countryCodeFromZoneTab("Europe/Rome", "# no data rows\n"), "");
    assert.equal(countryCodeFromZoneTab(
        "Europe/Rome", "#".repeat(MAX_ZONE_TAB_BYTES + 1)), "");
});

test("localCountryCode reads fresh OS timezone sources in precedence order", () => {
    loadWorldclocks();
    const WorldclockData = require(dataModulePath);
    const GLib = global.imports.gi.GLib;
    const files = new Map([
        ["/etc/timezone", Buffer.from("Asia/Tokyo\n")],
        ["/usr/share/zoneinfo/zone.tab", Buffer.from([
            "IT\t+4154+01229\tEurope/Rome",
            "VA\t+415408+0122711\tEurope/Vatican",
            "JP\t+353916+1394441\tAsia/Tokyo"
        ].join("\n"))]
    ]);
    let localtimeLink = "/usr/share/zoneinfo/Europe/Rome";
    let fallback = "Asia/Tokyo";
    let timezoneFileReads = 0;

    GLib.file_get_contents = (filename) => {
        if (filename === "/etc/timezone") {
            timezoneFileReads += 1;
        }
        return files.has(filename) ? [true, files.get(filename)] : [false, null];
    };
    GLib.file_read_link = (filename) => {
        if (filename === "/etc/localtime") {
            return localtimeLink;
        }
        throw new Error("regular zoneinfo file");
    };
    GLib.TimeZone.new_local = () => fakeTimeZone(fallback);

    assert.equal(WorldclockData.localCountryCode(), "IT",
        "the lexical localtime link beats stale plaintext and GLib sources");

    localtimeLink = "/usr/share/zoneinfo/Etc/UTC";
    assert.equal(WorldclockData.localCountryCode(), "",
        "UTC is authoritative and never falls through to a country");

    localtimeLink = "/etc/alternatives/localtime";
    fallback = "Europe/Vatican";
    assert.equal(WorldclockData.localCountryCode(), "VA",
        "a non-zoneinfo symlink falls through to GLib's effective alias");

    fallback = "UTC";
    assert.equal(WorldclockData.localCountryCode(), "",
        "GLib UTC does not fall through to /etc/timezone");
    assert.equal(timezoneFileReads, 0,
        "stale plaintext is not even read while an effective source exists");

    fallback = null;
    assert.equal(WorldclockData.localCountryCode(), "JP",
        "plaintext timezone is used only when effective sources reveal nothing");
    assert.equal(timezoneFileReads, 1);
});

test("localCountryCode resolves an unmapped zoneinfo alias after exact lookup", () => {
    loadWorldclocks();
    const WorldclockData = require(dataModulePath);
    const GLib = global.imports.gi.GLib;
    const zoneTab = [
        "US\t+404251-0740023\tAmerica/New_York",
        "VA\t+415408+0122711\tEurope/Vatican"
    ].join("\n");
    let localtimeLink = "/usr/share/zoneinfo/US/Eastern";
    let aliasReads = 0;

    GLib.file_get_contents = (filename) => filename === "/usr/share/zoneinfo/zone.tab" ?
        [true, Buffer.from(zoneTab)] : [false, null];
    GLib.file_read_link = (filename) => {
        if (filename === "/etc/localtime") {
            return localtimeLink;
        }
        aliasReads += 1;
        if (filename === "/usr/share/zoneinfo/US/Eastern") {
            return "../America/New_York";
        }
        throw new Error("regular zoneinfo file");
    };
    GLib.TimeZone.new_local = () => fakeTimeZone("Europe/Rome");

    assert.equal(WorldclockData.localCountryCode(), "US");
    assert.equal(aliasReads, 2, "the alias and its canonical endpoint are inspected");

    localtimeLink = "/usr/share/zoneinfo/Europe/Vatican";
    aliasReads = 0;
    assert.equal(WorldclockData.localCountryCode(), "VA");
    assert.equal(aliasReads, 0,
        "an exact jurisdiction alias is never replaced by its symlink target");
});

test("localCountryCode fails closed when local timezone data cannot be read", () => {
    loadWorldclocks();
    const WorldclockData = require(dataModulePath);
    const GLib = global.imports.gi.GLib;

    GLib.file_get_contents = () => {
        throw new Error("unreadable");
    };
    GLib.file_read_link = () => {
        throw new Error("not a symlink");
    };
    GLib.TimeZone.new_local = () => {
        throw new Error("no local timezone");
    };
    assert.equal(WorldclockData.localCountryCode(), "");

    GLib.file_get_contents = (filename) => filename === "/etc/timezone" ?
        [true, "Europe/Rome\n"] : [false, null];
    GLib.TimeZone.new_local = () => fakeTimeZone("Europe/Rome");
    assert.equal(WorldclockData.localCountryCode(), "",
        "a missing zone.tab disables automatic holidays");
});

test("fuzz: timezone identifiers and OS source priority stay geographic", () => {
    loadWorldclocks();
    const {
        regionalTimezoneIdentifier,
        localTimezoneFromSources
    } = require(dataModulePath);
    const random = makeRandom(FUZZ_SEED + 10);
    const longestIdentifier = `A/${"x".repeat(253)}`;

    for (let round = 0; round < 500; round++) {
        const zones = [
            `Area${round % 17}/City_${round}`,
            `Region${round % 13}/District/Place_${round}`,
            "Europe/Rome"
        ];
        const identifierCases = [
            { input: `  ${zones[0]}\n`, expected: zones[0] },
            { input: longestIdentifier, expected: longestIdentifier },
            { input: "UTC", expected: "" },
            { input: `Etc/GMT+${round % 12}`, expected: "" },
            { input: `Area${round}//Place`, expected: "" },
            { input: `Area${round}/../Place`, expected: "" },
            { input: `Area${round}/Place!`, expected: "" },
            { input: "x".repeat(256), expected: "" },
            { input: null, expected: "" },
            { input: round, expected: "" }
        ];
        const identifierCase = pickRandom(random, identifierCases);
        const parsed = regionalTimezoneIdentifier(identifierCase.input);
        assert.equal(parsed, identifierCase.expected);
        assert.equal(regionalTimezoneIdentifier(parsed), parsed,
            "accepted identifiers are idempotent");

        const localtimeCases = [
            { link: `/usr/share/zoneinfo/${zones[0]}`, state: zones[0] },
            { link: "/usr/share/zoneinfo/Etc/UTC", state: "" },
            { link: "/usr/share/zoneinfo/+02", state: "" },
            { link: "/etc/alternatives/localtime", state: null },
            { link: null, state: null }
        ];
        const glibCases = [
            { value: zones[1], state: zones[1] },
            { value: "UTC", state: "" },
            { value: "+02", state: "" },
            { value: null, state: null }
        ];
        const fileCases = [
            { value: `${zones[2]}\n`, state: zones[2] },
            { value: "UTC\n", state: "" },
            { value: null, state: null }
        ];
        const localtime = pickRandom(random, localtimeCases);
        const glib = pickRandom(random, glibCases);
        const timezoneFile = pickRandom(random, fileCases);
        const afterLocaltime = localtime.state !== null ? localtime.state : glib.state;
        const expected = afterLocaltime !== null ? afterLocaltime : (timezoneFile.state || "");

        assert.equal(localTimezoneFromSources(
            timezoneFile.value, localtime.link, glib.value), expected);
    }
});

test("fuzz: zoneinfo alias paths are root-confined, bounded, and cycle-safe", () => {
    loadWorldclocks();
    const {
        regionalTimezoneIdentifier,
        timezoneAliasTarget,
        canonicalTimezoneFromSymlinks
    } = require(dataModulePath);
    const random = makeRandom(FUZZ_SEED + 11);

    for (let round = 0; round < 300; round++) {
        const area = `Area${round % 23}`;
        const base = `${area}/Alias0`;
        const city = `City_${round}`;
        const validTargets = [
            { target: city, expected: `${area}/${city}` },
            { target: `./${city}`, expected: `${area}/${city}` },
            { target: `../Other${round % 7}/${city}`, expected: `Other${round % 7}/${city}` },
            { target: `/usr/share/zoneinfo/${area}/${city}`, expected: `${area}/${city}` }
        ];
        const chosen = pickRandom(random, validTargets);
        const resolved = timezoneAliasTarget(base, chosen.target);
        assert.equal(resolved, chosen.expected);
        assert.equal(regionalTimezoneIdentifier(resolved), resolved);

        const hostile = pickRandom(random, [
            "/etc/passwd", "../../etc/passwd", "../Etc/UTC", "Bad!", "x\0y", "", null
        ]);
        assert.equal(timezoneAliasTarget(base, hostile), "");

        const hops = 1 + Math.floor(random() * 16);
        const links = new Map();
        for (let hop = 0; hop < hops; hop++) {
            links.set(`/usr/share/zoneinfo/${area}/Alias${hop}`, `Alias${hop + 1}`);
        }
        let reads = 0;
        const readLink = (filename) => {
            reads += 1;
            return links.get(filename);
        };
        assert.equal(canonicalTimezoneFromSymlinks(base, readLink), `${area}/Alias${hops}`);
        assert.ok(reads <= 17);

        links.set(`/usr/share/zoneinfo/${area}/Alias${hops}`, "Alias0");
        reads = 0;
        assert.equal(canonicalTimezoneFromSymlinks(base, readLink), "");
        assert.ok(reads <= 17);
    }
});

test("fuzz: zone.tab lookup is exact and unaffected by malformed rows", () => {
    loadWorldclocks();
    const { countryCodeFromZoneTab } = require(dataModulePath);
    const random = makeRandom(0x20e7ab);
    const records = [
        { code: "IT", zone: "Europe/Rome" },
        { code: "JP", zone: "Asia/Tokyo" },
        { code: "US", zone: "America/New_York" },
        { code: "SK", zone: "Europe/Bratislava" },
        { code: "ME", zone: "Europe/Podgorica" },
        { code: "SM", zone: "Europe/San_Marino" }
    ];

    for (let round = 0; round < 300; round++) {
        const offset = Math.floor(random() * records.length);
        const ordered = records.slice(offset).concat(records.slice(0, offset));
        const rows = ordered.map((record, index) =>
            `${record.code}\t+${String(1000 + index).padStart(4, "0")}+01229\t${record.zone}` +
            (random() < 0.5 ? `\tcomment-${round}-${index}` : ""));
        const separator = random() < 0.5 ? "\n" : "\r\n";
        const table = ["# generated valid table", "", ...rows].join(separator);
        const selected = pickRandom(random, records);

        assert.equal(countryCodeFromZoneTab(selected.zone, table), selected.code);
        assert.equal(countryCodeFromZoneTab(`${selected.zone}_Nearby`, table), "");

        const malformed = pickRandom(random, [
            `${selected.code}\tbad-coordinates\t${selected.zone}`,
            `X\t+1000+01229\tArea/Bad-${round}`,
            `IT\t+1000+01229\tNoArea`,
            rows[0],
            `IT\t+1000+01229\tArea/Bad!`
        ]);
        assert.equal(countryCodeFromZoneTab(selected.zone,
            `${table}${separator}${malformed}`), selected.code);
    }
});

const LOCAL_COUNTRY_FUZZ_ZONE_TAB = [
    "IT\t+4154+01229\tEurope/Rome",
    "JP\t+353916+1394441\tAsia/Tokyo",
    "US\t+404251-0740023\tAmerica/New_York"
].join("\n");
const LOCAL_COUNTRY_FUZZ_CODES = new Map([
    ["Europe/Rome", "IT"],
    ["Asia/Tokyo", "JP"],
    ["America/New_York", "US"],
    ["", ""]
]);
const LOCALTIME_FUZZ_CASES = [
    { link: "/usr/share/zoneinfo/Europe/Rome", state: "Europe/Rome" },
    { link: "/usr/share/zoneinfo/Etc/UTC", state: "" },
    { link: "/etc/alternatives/localtime", state: null },
    { link: null, state: null }
];
const GLIB_TIMEZONE_FUZZ_CASES = [
    { value: "Asia/Tokyo", state: "Asia/Tokyo" },
    { value: "UTC", state: "" },
    { value: null, state: null }
];
const TIMEZONE_FILE_FUZZ_CASES = [
    { value: "America/New_York", state: "America/New_York" },
    { value: "UTC", state: "" },
    { value: null, state: null }
];

function readLocalCountryFuzzLink(state, filename) {
    if (filename !== "/etc/localtime" || state.localtime.link === null) {
        throw new Error("not a usable link");
    }
    return state.localtime.link;
}

function localCountryFuzzTimezone(state) {
    return state.glib.value === null ? null : fakeTimeZone(state.glib.value);
}

function readLocalCountryFuzzFile(state, filename) {
    if (filename === "/usr/share/zoneinfo/zone.tab") {
        return [true, state.textFiles ?
            LOCAL_COUNTRY_FUZZ_ZONE_TAB : Buffer.from(LOCAL_COUNTRY_FUZZ_ZONE_TAB)];
    }
    if (filename === "/etc/timezone" && state.timezoneFile.value !== null) {
        const value = `${state.timezoneFile.value}\n`;
        return [true, state.textFiles ? value : Buffer.from(value)];
    }
    return [false, null];
}

function installLocalCountryFuzzMocks(GLib, state) {
    GLib.file_read_link = readLocalCountryFuzzLink.bind(null, state);
    GLib.TimeZone.new_local = localCountryFuzzTimezone.bind(null, state);
    GLib.file_get_contents = readLocalCountryFuzzFile.bind(null, state);
}

function nextLocalCountryFuzzState(random) {
    const localtime = pickRandom(random, LOCALTIME_FUZZ_CASES);
    const glib = pickRandom(random, GLIB_TIMEZONE_FUZZ_CASES);
    const timezoneFile = pickRandom(random, TIMEZONE_FILE_FUZZ_CASES);
    const afterLocaltime = localtime.state !== null ? localtime.state : glib.state;
    const identifier = afterLocaltime !== null ? afterLocaltime : (timezoneFile.state || "");
    return {
        localtime,
        glib,
        timezoneFile,
        textFiles: random() < 0.5,
        expected: LOCAL_COUNTRY_FUZZ_CODES.get(identifier)
    };
}

function assertLocalCountryFuzzRound(WorldclockData, state) {
    const country = WorldclockData.localCountryCode();
    assert.equal(country, state.expected);
    assert.match(country, /^(?:|[A-Z]{2})$/);
}

test("fuzz: localCountryCode follows fresh authoritative OS sources", () => {
    loadWorldclocks();
    const WorldclockData = require(dataModulePath);
    const GLib = global.imports.gi.GLib;
    const random = makeRandom(0x10ca1);
    const state = {};
    installLocalCountryFuzzMocks(GLib, state);

    for (let round = 0; round < 250; round++) {
        Object.assign(state, nextLocalCountryFuzzState(random));
        assertLocalCountryFuzzRound(WorldclockData, state);
    }
});

test("regression: exact jurisdiction aliases beat their cross-country targets", () => {
    loadWorldclocks();
    const WorldclockData = require(dataModulePath);
    const GLib = global.imports.gi.GLib;
    const cases = [
        { zone: "Europe/Bratislava", code: "SK", target: "Prague" },
        { zone: "Europe/Podgorica", code: "ME", target: "Belgrade" },
        { zone: "Europe/San_Marino", code: "SM", target: "Rome" }
    ];
    const zoneTab = [
        "SK\t+4809+01707\tEurope/Bratislava",
        "CZ\t+5005+01426\tEurope/Prague",
        "ME\t+4226+01916\tEurope/Podgorica",
        "RS\t+4450+02030\tEurope/Belgrade",
        "SM\t+4355+01228\tEurope/San_Marino",
        "IT\t+4154+01229\tEurope/Rome"
    ].join("\n");
    let current;
    let aliasReads = 0;

    GLib.file_get_contents = (filename) => filename === "/usr/share/zoneinfo/zone.tab" ?
        [true, Buffer.from(zoneTab)] : [false, null];
    GLib.file_read_link = (filename) => {
        if (filename === "/etc/localtime") {
            return `/usr/share/zoneinfo/${current.zone}`;
        }
        aliasReads += 1;
        return current.target;
    };
    GLib.TimeZone.new_local = () => fakeTimeZone("Europe/Rome");

    for (const testCase of cases) {
        current = testCase;
        aliasReads = 0;
        assert.equal(WorldclockData.localCountryCode(), testCase.code);
        assert.equal(aliasReads, 0, `${testCase.zone} must be matched before its symlink`);
    }
});

// The memo is module state on an importer-loaded root module, so it outlives
// every applet instance and is shared by all of them — the same shape as the
// Nominatim spacing queue and the locale query handles, which are both released
// by the last instance to leave rather than the first.
test("the timezone-to-city memo is released by the last consumer, not the first", () => {
    loadWorldclocks();
    const WorldclockData = require(dataModulePath);
    const GLib = global.imports.gi.GLib;
    const originalReadLink = GLib.file_read_link;
    let readlinks = 0;
    GLib.file_read_link = (filename) => {
        readlinks++;
        return originalReadLink(filename);
    };

    try {
        // two applets on the panel
        WorldclockData.registerWorldclockConsumer();
        WorldclockData.registerWorldclockConsumer();

        assert.equal(weatherCity(WorldclockData, "US/Eastern"), "New York");
        const resolved = readlinks;
        assert.ok(resolved > 0);

        WorldclockData.releaseWorldclockConsumer();
        assert.equal(weatherCity(WorldclockData, "US/Eastern"), "New York");
        assert.equal(readlinks, resolved,
            "one of two leaving takes nothing from the one still running");

        WorldclockData.releaseWorldclockConsumer();
        assert.equal(weatherCity(WorldclockData, "US/Eastern"), "New York");
        assert.ok(readlinks > resolved, "the last one out empties the table");

        // A teardown with nobody registered must not drive the count below
        // zero: two applets would then start from -1, and the first one to
        // leave would empty the table under the one still running.
        WorldclockData.releaseWorldclockConsumer();
        WorldclockData.registerWorldclockConsumer();
        WorldclockData.registerWorldclockConsumer();

        assert.equal(weatherCity(WorldclockData, "US/Eastern"), "New York");
        const held = readlinks;

        WorldclockData.releaseWorldclockConsumer();
        assert.equal(weatherCity(WorldclockData, "US/Eastern"), "New York");
        assert.equal(readlinks, held,
            "one of two leaving still takes nothing from the other");

        WorldclockData.releaseWorldclockConsumer();
        assert.equal(weatherCity(WorldclockData, "US/Eastern"), "New York");
        assert.ok(readlinks > held, "and the second one does");
    } finally {
        GLib.file_read_link = originalReadLink;
    }
});

// T822: getClockEntries produced {clock, label, timezone, time, localTime,
// builtin}, and the panel presenter then mutated the shape on the way back -
// Object.assign over the entry when there was a reading, the bare entry when
// there was not. So this view read two fields it never produced and that appear
// nowhere in its own contract, both optional by absence: a rename or a typo on
// either side produced no error, and the temperature column and the row's
// spoken weather just went blank. The row is declared here now.
test("the popup row is the contract this view declares, not what it is handed", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });
    worldclocks.buildClocks([{ label: "Tokyo", timezone: "Asia/Tokyo" }]);
    const tokyo = worldclocks.clocks.at(-1);

    // named arguments: the caller says which field is which
    worldclocks.renderRow(tokyo, { time: "18:00", weather: "12°C, Rain", temperature: "12°C" });
    assert.equal(tokyo.display.text, "18:00");
    assert.equal(tokyo.weather.text, "12°C");
    assert.match(tokyo.display.accessible_name, /Rain/);

    // the weather half is optional because a clock may have none - and it
    // defaults to empty here rather than to whatever the last row left behind
    worldclocks.renderRow(tokyo, { time: "18:01" });
    assert.equal(tokyo.display.text, "18:01");
    assert.equal(tokyo.weather.text, "");
    assert.equal(tokyo.display.accessible_name, "18:01");

    // ...and a caller that hands over no row at all draws an empty one rather
    // than throwing on the compositor thread
    assert.doesNotThrow(() => worldclocks.renderRow(tokyo));
});

// T841: this view declared no destroy(), and the builder that constructs it
// handed it back without recording it as owned — so the rows outlived every
// add/remove cycle, each one holding a GLib.TimeZone and three St.Label handles
// the menu had already disposed.
test("destroying the view drops the rows and leaves a late tick nothing to write", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });
    worldclocks.buildClocks([{ label: "Tokyo", timezone: "Asia/Tokyo" }]);
    worldclocks.updateClocks();
    const tokyo = worldclocks.clocks.at(-1);
    const drawn = tokyo.display.text;

    worldclocks.destroy();

    assert.deepEqual(worldclocks.clocks, [],
        "no record keeps a zone or a disposed label alive");
    assert.deepEqual(worldclocks.getClockEntries(), []);
    worldclocks.updateClocks();
    assert.equal(tokyo.display.text, drawn,
        "a tick after teardown has no row to render into");
    assert.doesNotThrow(() => worldclocks.destroy(), "and a second pass is a no-op");
});

// T1012: destroy() used to clear the rows and leave every method callable, so a
// teardown step that threw before the menu's actors were gone left the applet
// holding a view that would happily rebuild into them.
test("every public method of a destroyed view is a no-op", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });
    worldclocks.buildClocks([{ label: "Tokyo", timezone: "Asia/Tokyo" }]);
    const tokyo = worldclocks.clocks.at(-1);
    const format = worldclocks.format;

    worldclocks.destroy();
    worldclocks.actor.visible = true;

    worldclocks.buildClocks([{ label: "Rome", timezone: "Europe/Rome" }]);
    assert.deepEqual(worldclocks.clocks, [], "no actors are attached to a dead tree");
    worldclocks.setFormat("%I:%M %p");
    assert.equal(worldclocks.format, format, "and no render state moves");
    worldclocks.setVisible(false);
    assert.equal(worldclocks.actor.visible, true, "the disposed actor is not touched");
    worldclocks.setWeatherSource("Open-Meteo");
    assert.equal(worldclocks._rendered_source, undefined);
    worldclocks.renderRow(tokyo, { time: "09:00", temperature: "5°" });
    assert.equal(tokyo.display.text, "", "a late row render writes nothing");
    assert.doesNotThrow(() => worldclocks.refreshTimezone());
});
