const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { makeRandom: makeSeededRandom } = require("./helpers/prng");

const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "worldclocks.js");
const dataModulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "worldclockData.js");
const shimPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "worldclockData.js");
const utilsPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "utils.js");
const style52Path = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "stylesheet.css");

// two built-in rows (UTC and local time) always precede the configured clocks
const BUILTIN_ROWS = 2;

// Seeded PRNG so fuzz failures reproduce; change FUZZ_SEED to explore
const FUZZ_SEED = 20260709;
function makeRandom(seed = FUZZ_SEED) {
    return makeSeededRandom(seed);
}

let originalImports;

class MockGridLayout {
    constructor() {
        this.children = [];
    }

    attach(child, column, row, width, height) {
        this.children.push({ child, column, row, width, height });
    }
}

class MockWidget {
    constructor(options) {
        this.options = options;
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
        // every St.Label has one; the clock name ellipsizes through it
        this.clutter_text = { ellipsize: 0, line_wrap: false };
    }

    get_clutter_text() {
        return this.clutter_text;
    }

    set_text(text) {
        this.text = text;
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

function makeZonedTime(tz, format) {
    return {
        format(fmt) {
            void format;
            return `${tz.get_identifier()}:${fmt} `;
        },
        get_hour() {
            return 13;
        },
        get_minute() {
            return 45;
        }
    };
}

function loadWorldclocks(options = {}) {
    clearWorldclockCaches();
    require.cache[require.resolve(utilsPath)] = {
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
                    }
                    set_text(text) { this.text = text; }
                }
            }
        },
        gi: {
            Pango: { EllipsizeMode: { NONE: 0, END: 3 } },
            GLib: {
                // GLib >= 2.68, which is what Cinnamon 5.4 ships: new_identifier
                // answers null for a zone it does not know. The pre-2.68
                // TimeZone.new() path the applet used to carry is gone.
                TimeZone: {
                    new_identifier(timezone) {
                        return timezone.startsWith("Invalid/") ? null : fakeTimeZone(timezone);
                    },
                    new_local() {
                        return fakeTimeZone("Local/Here");
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
}

// 5.4/worldclocks.js reaches the shared data module through the 5.4 shim,
// which reads it off the applet importer
function reloadWorldclocks() {
    clearWorldclockCaches();
    global.imports.ui.appletManager = {
        applets: {
            "chronos@geraldo-netto": {
                worldclockData: require(dataModulePath),
                utils: require(utilsPath)
            }
        }
    };

    return require(modulePath);
}

beforeEach(() => {
    originalImports = global.imports;
});

afterEach(() => {
    global.imports = originalImports;
    clearWorldclockCaches();
    delete require.cache[require.resolve(utilsPath)];
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

    worldclocks.buildClocks([], "%H:%M");
    worldclocks.updateClocks();

    assert.equal(worldclocks.actor.visible, true);
    assert.equal(worldclocks.clocks.length, BUILTIN_ROWS);
    assert.deepEqual(worldclocks.clocks.map((clock) => clock.label), ["UTC", "Local time"]);
    assert.deepEqual(worldclocks.clocks.map((clock) => clock.builtin), [true, true]);
    assert.equal(worldclocks.clocks[0].display.text, "UTC:%H:%M");
    assert.equal(worldclocks.clocks[1].display.text, "Local/Here:%H:%M");

    assert.equal(worldclocks.getClockEntries().filter((entry) => !entry.builtin).length, 0);

    // the city label beside the time is read from its own text, so repeating it
    // here made a screen reader say "UTC", then "UTC UTC:%H:%M"
    assert.equal(worldclocks.clocks[0].display.accessible_name, "UTC:%H:%M");
    assert.equal(worldclocks.clocks[1].display.accessible_name, "Local/Here:%H:%M");
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

    let now = 1000;
    GLib.DateTime.new_now_utc = () => ({
        to_unix: () => now,
        to_timezone: (tz) => makeZonedTime(tz)
    });

    const worldclocks = new Worldclocks({ add_actor() {} });
    worldclocks.buildClocks([], "%H:%M");
    worldclocks.updateClocks();
    assert.equal(worldclocks.clocks[1].display.text, "Europe/Rome:%H:%M");

    // the user lands in Tokyo and the system timezone changes under the applet
    systemZone = "Asia/Tokyo";

    // the zone is not re-read on every tick — that would build a GLib.TimeZone
    // a second, and the popup only shows minutes
    now += 5;
    worldclocks.updateClocks();
    assert.equal(worldclocks.clocks[1].display.text, "Europe/Rome:%H:%M");

    now += 60;
    worldclocks.updateClocks();
    assert.equal(worldclocks.clocks[1].display.text, "Asia/Tokyo:%H:%M",
        "and within the minute the popup agrees with the panel again");
});

test("buildClocks caps configured clocks at 8 on top of the built-ins", () => {
    const { Worldclocks, MAX_CLOCKS } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    assert.equal(MAX_CLOCKS, 8);

    const clocks = Array.from({ length: 12 }, (_, index) => ({
        label: `Clock ${index}`,
        timezone: `Zone/${index}`
    }));

    worldclocks.buildClocks(clocks, "%H:%M");

    assert.equal(worldclocks.actor.visible, true);
    assert.equal(worldclocks.clocks.length, BUILTIN_ROWS + MAX_CLOCKS);
    // every row attaches a name label and a time label
    assert.equal(worldclocks.layout.children.length, (BUILTIN_ROWS + MAX_CLOCKS) * 2);

    const firstUserLabel = worldclocks.layout.children
        .find((cell) => cell.column === 0 && cell.row === BUILTIN_ROWS);
    assert.equal(firstUserLabel.child.text, "Clock 0");
    assert.equal(worldclocks.clocks[BUILTIN_ROWS + 7].tz.get_identifier(), "Zone/7");
    assert.equal(worldclocks.clocks.some((clock) =>
        clock.tz && clock.tz.get_identifier() === "Zone/8"), false);
});

test("buildClocks skips configured rows already covered by built-ins", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([
        { label: "UTC duplicate", timezone: "UTC" },
        { label: "Etc UTC duplicate", timezone: "Etc/UTC" },
        { label: "Local duplicate", timezone: "local" },
        { label: "Rome", timezone: "Europe/Rome" }
    ], "%H:%M");

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

    worldclocks.buildClocks(configured, "%H:%M");
    const shown = worldclocks.clocks.filter((clock) => !clock.builtin).map((clock) => clock.label);
    const selected = WorldclockData.selectUserClocks(configured).map((clock) => clock.label);

    assert.deepEqual(selected, shown);
    assert.deepEqual(selected, ["Rome", "Tokyo"], "the built-in collision is nobody's clock");
});

// the label is the user's own name for the clock and the dialog puts no limit on
// it; it is rendered in the popup grid and padded to the widest cell in the
// monospace tooltip, so one 60-character name stretches both
test("a very long clock name is cut down to size", () => {
    const { Worldclocks } = loadWorldclocks();
    const WorldclockData =
        global.imports.ui.appletManager.applets["chronos@geraldo-netto"].worldclockData;
    const worldclocks = new Worldclocks({ add_actor() {} });
    const max = WorldclockData.MAX_CLOCK_LABEL_LENGTH;

    worldclocks.buildClocks([
        { label: "x".repeat(60), timezone: "Europe/Rome" },
        { label: "Tokyo", timezone: "Asia/Tokyo" }
    ], "%H:%M");

    const [long, short] = worldclocks.clocks.filter((clock) => !clock.builtin);
    assert.equal(Array.from(long.label).length, max);
    assert.ok(long.label.endsWith("…"), "and it says it was cut");
    assert.equal(short.label, "Tokyo", "a name that fits is untouched");

    // the weather readings are keyed by this label, so both sides must clamp
    // the same way or a city's temperature is looked up under a name nobody has
    assert.equal(WorldclockData.selectUserClocks([{ label: "x".repeat(60), timezone: "Europe/Rome" }])[0].label,
        long.label);
});

// Cinnamon fires a text entry's changed signal on every keystroke, and
// updateFormatString used to call buildClocks: typing a 20-character custom
// format destroyed and rebuilt every label, re-resolved every GLib.TimeZone and
// relaid out the menu subtree twenty times, on the compositor thread.
test("changing the format re-renders the clocks without rebuilding them", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([{ label: "Tokyo", timezone: "Asia/Tokyo" }], "%H:%M");
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
});

// the service that answered was named only in the panel's mouse tooltip
test("the clock list names the weather service that answered", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.setWeatherSource("Open-Meteo");
    assert.match(worldclocks.actor.accessible_name, /World clocks/);
    assert.match(worldclocks.actor.accessible_name, /Open-Meteo/);

    // written once: the name is rebuilt every tick and St compares by pointer
    const first = worldclocks.actor.accessible_name;
    worldclocks.setWeatherSource("Open-Meteo");
    assert.equal(worldclocks.actor.accessible_name, first);

    // with weather off there is no source, and the list is just the list
    worldclocks.setWeatherSource("");
    assert.equal(worldclocks.actor.accessible_name, "World clocks");
});

test("updateClocks formats every configured timezone", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([
        { label: "Tokyo", timezone: "Asia/Tokyo" },
        { label: "Rome", timezone: "Europe/Rome" }
    ], "%H:%M");
    worldclocks.updateClocks();

    assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, "Asia/Tokyo:%H:%M");
    assert.equal(worldclocks.clocks[BUILTIN_ROWS + 1].display.text, "Europe/Rome:%H:%M");
    const entries = worldclocks.getClockEntries(1);
    assert.deepEqual(entries.map((entry) => [entry.label, entry.time, entry.builtin]), [
        ["UTC", "UTC:%H:%M", true],
        ["Local time", "Local/Here:%H:%M", true],
        ["Tokyo", "Asia/Tokyo:%H:%M", false]
    ]);
    assert.deepEqual(worldclocks.getClockEntries(1, false).map((entry) => [entry.label, entry.time, entry.builtin]), [
        ["Tokyo", "Asia/Tokyo:%H:%M", false]
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
    ], "%H:%M");

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
    assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, "Etc/GMT+1:%H:%M");
});

test("invalid timezones are marked instead of silently using UTC", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([
        { label: "Bad", timezone: "Invalid/Zone" }
    ], "%H:%M");
    worldclocks.updateClocks();

    const bad = worldclocks.clocks[BUILTIN_ROWS];
    assert.equal(bad.display.text, "Invalid timezone");
    assert.equal(bad.display.options.style_class, "calendar-world-time calendar-world-time-invalid");
    const badEntry = worldclocks.getClockEntries(1).find((entry) => entry.label === "Bad");
    assert.equal(badEntry.time, "Invalid timezone");
    assert.equal(badEntry.builtin, false);
});

test("the world-clock block can be hidden entirely", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([{ label: "Tokyo", timezone: "Asia/Tokyo" }], "%H:%M");

    worldclocks.setVisible(false);
    assert.equal(worldclocks.actor.visible, false, "including the built-in UTC and local rows");

    worldclocks.setVisible(true);
    assert.equal(worldclocks.actor.visible, true);
});

test("buildClocks defaults the format when none is provided", () => {
    const { Worldclocks } = loadWorldclocks();
    const worldclocks = new Worldclocks({ add_actor() {} });

    worldclocks.buildClocks([{ label: "Tokyo", timezone: "Asia/Tokyo" }]);
    worldclocks.updateClocks();

    assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, "Asia/Tokyo:%H:%M");
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
        const invalid = random() < 0.4;
        return {
            label: randomLabel(random, alphabet),
            timezone: invalid ? `Invalid/Fuzz${index}` : `Zone/Fuzz${index}`,
            invalid
        };
    });
}

function assertClockMatchesEntry(clock, entry, index) {
    assert.equal(clock.label, entry.label);
    if (entry.invalid) {
        assert.equal(clock.display.text, "Invalid timezone");
        assert.equal(clock.display.options.style_class,
            "calendar-world-time calendar-world-time-invalid");
    } else {
        assert.equal(clock.display.text, `Zone/Fuzz${index}:%H:%M`);
        assert.equal(clock.display.options.style_class, "calendar-world-time");
    }
}

test("fuzzed clock lists never crash and always respect the cap and invalid marking", () => {
    const { Worldclocks, MAX_CLOCKS } = loadWorldclocks();
    const random = makeRandom();
    const labelAlphabet = "abcXYZ0189 -_/中東€é​";

    for (let round = 0; round < 50; round++) {
        const entries = randomClockEntries(random, labelAlphabet);

        const worldclocks = new Worldclocks({ add_actor() {} });
        worldclocks.buildClocks(entries, random() < 0.5 ? "%H:%M" : undefined);
        worldclocks.updateClocks();

        const shown = entries.slice(0, MAX_CLOCKS);
        // built-ins keep the list visible even with nothing configured
        assert.equal(worldclocks.actor.visible, true);
        assert.equal(worldclocks.clocks.length, BUILTIN_ROWS + shown.length);

        // every row attaches a label and a time display
        assert.equal(worldclocks.layout.children.length, (BUILTIN_ROWS + shown.length) * 2);

        shown.forEach((entry, index) =>
            assertClockMatchesEntry(worldclocks.clocks[BUILTIN_ROWS + index], entry, index));

        const limit = Math.floor(random() * 12);
        const texts = worldclocks.getClockEntries(limit)
            .filter((entry) => !entry.builtin)
            .map((entry) => ({ label: entry.label, time: entry.time }));
        assert.equal(texts.length, Math.min(limit, shown.length));
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
    worldclocks.buildClocks([{ label: "Bad", timezone: "Invalid/Zone" }], "%H:%M");
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
    worldclocks.buildClocks([{ label: "Bad", timezone: "Invalid/Zone" }], "%H:%M");
    worldclocks.updateClocks();

    assert.deepEqual(lookups, ["Invalid timezone", "Local time"]);
    assert.equal(worldclocks.clocks[BUILTIN_ROWS].display.text, "cinnamon:Invalid timezone");
});

test("5.4 worldclocks module exports the presentation class", () => {
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
                            utils: { translate: (str) => str }
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
        globalThis: { imports: gjsContext.imports }
    };
    require.cache[require.resolve(utilsPath)] = { exports: { translate: (str) => str } };
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

test("timezoneCityName reads the place out of the identifier, not the label", () => {
    loadWorldclocks();
    const WorldclockData = require(dataModulePath);

    assert.equal(WorldclockData.timezoneCityName("America/New_York"), "New York");
    assert.equal(WorldclockData.timezoneCityName("America/Argentina/Buenos_Aires"), "Buenos Aires");
    assert.equal(WorldclockData.timezoneCityName("Europe/Rome"), "Rome");

    // UTC is a scale and the local row is the panel location's job; neither is
    // a place to ask a geocoder about
    assert.equal(WorldclockData.timezoneCityName(WorldclockData.UTC_TIMEZONE), "");
    assert.equal(WorldclockData.timezoneCityName(WorldclockData.LOCAL_TIMEZONE), "");

    // and neither is junk, or a bare word that is not an IANA path
    assert.equal(WorldclockData.timezoneCityName("tokyo"), "");
    assert.equal(WorldclockData.timezoneCityName(""), "");
    assert.equal(WorldclockData.timezoneCityName(null), "");
    assert.equal(WorldclockData.timezoneCityName(42), "");
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
        [{ label: "Mom's place in Buenos Aires", timezone: "America/Argentina/Buenos_Aires" }],
        "%H:%M");

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
        path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "stylesheet.css"),
        "utf8");
    assert.match(css, /\.calendar-world-label\s*\{[^}]*max-width/);
});
