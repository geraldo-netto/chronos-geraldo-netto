const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const readmePath = path.join(__dirname, "..", "README.md");
const appletDir = path.join(__dirname, "..", "files", "chronos@geraldo-netto");
const projectUrl = "https://github.com/geraldo-netto/cinnamon-chronos";

function schema(version) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", version, "settings-schema.json"), "utf8"));
}

// The Spices site offers an update only when metadata.json says so: the applet's
// version is the manifest's, and package.json is only the tooling's idea of it.
// They were once allowed to disagree — package.json carried no version at all —
// and a release then means whichever file you happened to read.
test("the manifest and the tooling agree on the version", () => {
    const metadata = JSON.parse(fs.readFileSync(path.join(appletDir, "metadata.json"), "utf8"));
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

    assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
    assert.equal(pkg.version, metadata.version,
        "the tooling and the applet disagree about which version this is");
});

test("project metadata uses the Cinnamon Chronos repository identity", () => {
    const root = path.join(__dirname, "..");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    const metadata = JSON.parse(fs.readFileSync(path.join(appletDir, "metadata.json"), "utf8"));
    const readme = fs.readFileSync(readmePath, "utf8");
    const makepot = fs.readFileSync(path.join(appletDir, "po", "makepot"), "utf8");
    const weatherAdapters = fs.readFileSync(
        path.join(appletDir, "weatherServiceAdapters.js"), "utf8");

    assert.equal(pkg.name, "cinnamon-chronos");
    assert.equal(lock.name, pkg.name);
    assert.equal(lock.packages[""].name, pkg.name);
    assert.equal(pkg.repository.url, `git+${projectUrl}.git`);
    assert.equal(pkg.bugs.url, `${projectUrl}/issues`);
    assert.equal(pkg.homepage, `${projectUrl}#readme`);
    assert.ok(readme.includes(`git clone ${projectUrl}.git`));
    assert.ok(makepot.includes(`${projectUrl}/issues`));
    assert.ok(weatherAdapters.includes(projectUrl));
    assert.equal(metadata.uuid, "chronos@geraldo-netto",
        "renaming the repository must not change Cinnamon's installed applet identity");
});

// The applet declares GPL-2.0-or-later in package.json and the README, and it
// redistributes two GPL works — but shipped no license text at all, which makes
// the declaration unenforceable and the redistribution a GPL violation. The
// manifest is what Cinnamon and the Spices site read, so it has to say so too.
test("the license is declared everywhere it is claimed, and its text ships", () => {
    const metadata = JSON.parse(fs.readFileSync(path.join(appletDir, "metadata.json"), "utf8"));
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    const license = fs.readFileSync(path.join(__dirname, "..", "LICENSE"), "utf8");

    assert.equal(metadata.license, "GPL-2.0-or-later");
    assert.equal(pkg.license, metadata.license,
        "the tooling and the applet disagree about the license");
    assert.match(fs.readFileSync(readmePath, "utf8"), /GPL-2\.0-or-later/);

    // the text itself, and the "or later" the identifier promises
    assert.match(license, /GNU GENERAL PUBLIC LICENSE\n\s+Version 2, June 1991/);
    assert.match(license, /any later\nversion/);
});

test("5.4 schema exposes Belgium holiday regions", () => {
    const schema52 = schema("5.4");

    assert.ok(schema52.has_region.default.includes("bel"));
    assert.deepEqual(schema52.region_bel, {
        type: "combobox",
        // the value that means "no region": an unset region and "global" are the
        // same thing to the applet, and this is the one the user can pick
        default: "global",
        // One msgid, not ten. These were briefly named for their countries
        // ("Region in Belgium"), which orphaned the "Region" translation that
        // existed in all 15 catalogs and asked for 150 new ones — to say
        // something the user can already see, since each combobox is gated on
        // its own country and appears directly under the country that selects
        // it. Identical strings collapse to one msgid, which is the point.
        description: "Region",
        tooltip: "Region whose public holidays are marked, on top of the national ones. " +
            "Leave it unset to mark only the holidays that apply nationwide.",
        options: {
            // The tooltip tells the user to leave it unset — and once a region
            // was picked there was no value in the list that returned to unset,
            // so regional holidays could never be turned off again from the
            // dialog. "global" is what the applet already maps an unset region
            // onto; now it is a value the user can choose.
            "Nationwide only": "global",
            Brussels: "bru",
            "Flemish Region": "vlg",
            "Walloon Region": "wal"
        },
        dependency: "country=bel"
    });
});

test("schema groups panel label controls together", () => {
    const data = schema("5.4");
    const layout = data.layout;

    assert.deepEqual(layout.section5, {
        type: "section",
        title: "Panel Label",
        keys: ["show-weather", "weather-location", "openstreetmap-attribution", "weather-units"]
    });
    assert.ok(layout.page1.sections.includes("section5"));
    assert.equal(layout.section1.keys.includes("show-weather"), false);
    // the clocks list lives with the switch that greys it out, not on another page
    assert.deepEqual(layout.section4.keys, ["show-worldclocks", "worldclocks"]);
});

test("date format controls are always visible", () => {
    const data = schema("5.4");

    assert.equal(data["use-custom-format"], undefined);
    assert.equal(data.layout.section1.keys.includes("use-custom-format"), false);
    assert.equal(data["custom-format"].default, "%d %b %H:%M");
    assert.equal(data["custom-tooltip-format"].default, "%d %b %H:%M");
    assert.deepEqual(data["date-format-defaults-migrated"], {
        type: "generic",
        default: false
    });
    for (const key of ["custom-format", "custom-tooltip-format", "format-button"]) {
        assert.ok(data.layout.section1.keys.includes(key), `${key} is missing from the Calendar page`);
        assert.equal(data[key].dependency, undefined, `${key} is still hidden behind a dependency`);
        assert.equal(data[key].indent, undefined, `${key} is still nested under a removed switch`);
    }
});

test("the country combobox and the supported-country list agree", () => {
    const data = schema("5.4");
    const constants = require(path.join(appletDir, "holidayConstants.js"));

    const offered = Object.values(data.country.options).filter((code) => code !== "none");
    assert.deepEqual(offered.slice().sort(), constants.SUPPORTED_COUNTRIES.slice().sort(),
        "a country the combobox offers but the applet rejects would silently disable holidays");
});

// The country combobox is gated against SUPPORTED_COUNTRIES; the region
// comboboxes were gated against nothing. Add a region to region_usa without
// adding it to REGION_TO_SUBDIVISION.usa and regionSubdivisionCode() answers null,
// so both ISO fallback providers quietly serve nationwide-only holidays: no
// error, no log, wrong calendar.
test("every region the dialog offers is a region the providers understand", () => {
    const data = schema("5.4");
    const constants = require(path.join(appletDir, "holidayConstants.js"));
    const regions = constants.REGION_TO_SUBDIVISION;

    assert.deepEqual(data.has_region.default.slice().sort(), Object.keys(regions).sort(),
        "has_region lists the countries that have a region selector");

    for (const country of Object.keys(regions)) {
        const key = `region_${country}`;
        assert.ok(data[key], `${country} has regions but no ${key} combobox`);
        assert.equal(data[key].dependency, `country=${country}`);

        // "global" is not a region, it is the absence of one
        const offered = Object.values(data[key].options)
            .filter((code) => code !== "global").sort();
        const known = Object.keys(regions[country]).sort();
        assert.deepEqual(offered, known,
            `${key} and REGION_TO_SUBDIVISION.${country} disagree`);

        assert.equal(data[key].options["Nationwide only"], "global",
            `${key} offers no way back to nationwide-only holidays`);
        assert.equal(data[key].default, "global");
    }

    // ...and no combobox offers regions for a country the map has never heard of
    for (const key of Object.keys(data).filter((name) => name.startsWith("region_"))) {
        assert.ok(regions[key.slice("region_".length)],
            `${key} offers regions the providers cannot resolve`);
    }
});

// settingsFacade.test.js asserts the facade passed SettingsFacade.SHOW_WEEK_NUMBERS_KEY
// — a constant imported from the module under test — so both sides of the
// assertion are the same symbol and the key's *value* was never checked against
// anything. Rename SHOW_WEEK_NUMBERS_KEY to "show_week_numbers" and Cinnamon
// binds nothing, week numbers silently stop working, and every test stays green.
test("every settings key the facade binds exists in the schema", () => {
    const data = schema("5.4");
    const facade = fs.readFileSync(path.join(appletDir, "settingsFacade.js"), "utf8");

    // the literal key strings, as the facade declares them
    const declared = Array.from(facade.matchAll(/^var \w+_KEY = "([^"]+)";$/gm))
        .map(([, key]) => key);
    assert.ok(declared.length >= 8, "the key constants were not found");

    // The facade is also the boundary for Cinnamon's desktop schema, whose keys
    // are naturally not in the applet's own. They are checked against the list
    // DesktopSettings actually asks Gio for, so a key added there and forgotten
    // in that list — which is what tells the applet the key has gone missing —
    // still fails this.
    const desktopKeys = Array.from(
        facade.matchAll(/^var DESKTOP_KEYS = \[([^\]]+)\];$/gm)
    ).flatMap(([, names]) => names.split(",").map((name) => name.trim()));
    assert.ok(desktopKeys.length >= 3, "the desktop key list was not found");

    for (const key of declared) {
        const constant = facade.match(
            new RegExp(`^var (\\w+_KEY) = "${key}";$`, "m"))[1];

        if (desktopKeys.includes(constant)) {
            continue;
        }

        assert.ok(Object.prototype.hasOwnProperty.call(data, key),
            `the facade binds "${key}", which the schema does not define`);
    }

    // ...and the key->property tables, which are the other half of the binding
    const bound = Array.from(facade.matchAll(/^\s+\["([a-z][\w-]*)", "\w+"\],?$/gm))
        .map(([, key]) => key);
    assert.ok(bound.length >= 4, "the key/property tables were not found");

    for (const key of bound) {
        assert.ok(Object.prototype.hasOwnProperty.call(data, key),
            `the facade binds "${key}", which the schema does not define`);
    }

    // the region keys are built from a prefix, so check the prefix resolves too
    const prefix = /^var REGION_KEY_PREFIX = "([^"]+)";$/m.exec(facade)[1];
    const regions = Object.keys(data).filter((key) => key.startsWith(prefix));
    assert.ok(regions.length > 0, `no schema key starts with "${prefix}"`);
});

test("the layout lists only keys that render a widget", () => {
    const data = schema("5.4");
    const layout = data.layout;

    for (const sectionName of Object.keys(layout)) {
        const section = layout[sectionName];
        if (!section || section.type !== "section") {
            continue;
        }

        for (const key of section.keys) {
            // "generic" is a data-only key: xlet-settings renders nothing for
            // it, so listing it implies a control that never appears
            assert.notEqual(data[key].type, "generic",
                `${sectionName} lists ${key}, which renders no widget`);
        }
    }
});

// a dependent control sits inside the indented group under the switch that
// turns it on; one that forgets to say so hangs out of the group it belongs to
test("keys that depend on the same switch are indented alike", () => {
    const data = schema("5.4");
    const groups = {};

    for (const key of Object.keys(data)) {
        const entry = data[key];
        if (!entry || !entry.dependency || entry.type === "generic") {
            continue;
        }
        (groups[entry.dependency] = groups[entry.dependency] || []).push(key);
    }

    for (const [dependency, keys] of Object.entries(groups)) {
        // the world-clock list and the region comboboxes are pages of their own,
        // not rows inside a switch's group
        if (keys.some((key) => data[key].type === "custom" || key.startsWith("region_"))) {
            continue;
        }

        const indented = keys.filter((key) => data[key].indent === true);
        assert.ok(indented.length === 0 || indented.length === keys.length,
            `${dependency} indents ${indented.join(", ")} but not ` +
            `${keys.filter((key) => data[key].indent !== true).join(", ")}`);
    }
});

test("controls that cannot do anything are gated", () => {
    const data = schema("5.4");
    // with the clocks feature off there is nothing to configure
    assert.equal(data.worldclocks.dependency, "show-worldclocks");

    // ...and a control has to live on the page as the switch that greys it out:
    // a control greyed out by a switch on another page leaves the user looking
    // at a dead widget with the cause nowhere in sight.
    const pageOf = (key) => Object.entries(data.layout)
        .filter(([, entry]) => entry && entry.sections)
        .find(([, page]) => page.sections.some((section) =>
            data.layout[section].keys && data.layout[section].keys.includes(key)))[0];

    for (const [key, entry] of Object.entries(data)) {
        if (!entry || typeof entry !== "object" || !entry.dependency) {
            continue;
        }

        const on = entry.dependency.split("=")[0];
        if (!data[on]) {
            continue;
        }

        assert.equal(pageOf(key), pageOf(on),
            `${key} is greyed out by ${on}, which is on another page: ` +
            "the user cannot see why the control is dead");
    }
});

// Flip on "Show weather on the panel", leave the location empty, and a bare
// warning triangle welds itself to the clock. The words that explain it live in
// the panel's mouse tooltip — not in the settings dialog, where the user is
// standing when they make it happen.
test("the weather location says what an empty one does", () => {
    const data = schema("5.4");

    assert.equal(data["weather-location"].default, "");
    assert.match(data["weather-location"].tooltip, /empty/i);
    // and it shows what a good answer looks like
    assert.match(data["weather-location"].tooltip, /Lisbon/);
});

// The README promised that a lint failure was a build failure, and there was no
// build: no workflow, no hook, nothing that ran either suite or either coverage
// gate. The gates were one maintainer's machine. This asserts the workflow runs
// what the README says it runs, so deleting a step fails the suite that step runs.
test("CI runs the gates the README promises", () => {
    const workflow = fs.readFileSync(
        path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

    assert.match(workflow, /on:[\s\S]*push:[\s\S]*pull_request:/, "on push and on pull request");
    assert.match(workflow, /run: npm ci/);
    assert.match(workflow, /run: npm run lint\b/, "eslint and pyflakes");
    assert.match(workflow, /run: npm test\b/, "both suites, both coverage gates");
    // pyflakes is what lint:py runs, and lint:py now fails when it is missing:
    // a workflow that does not install it cannot pass
    assert.match(workflow, /pip install .*pyflakes/);

    // and the script it runs is a gate, not a skip: it used to be
    // `if import pyflakes; then …; else echo skipping; fi` — exit 0 either way
    assert.doesNotMatch(pkg.scripts["lint:py"], /skipping/);
    assert.match(pkg.scripts["lint:py"], /exit 1/);

    // sixteen timezone tests skipped themselves in CI because pytz was never
    // installed there, and neither the suite count nor a coverage number moved
    assert.match(workflow, /pip install .*pytz/);
    assert.match(workflow, /CHRONOS_REQUIRE_PYTZ: "1"/, "and the skip is a failure there");
});

// The README said Cinnamon compiled the catalogs "when the applet is installed".
// Nothing does: the documented install is a clone and an rsync, Cinnamon does not
// run msgfmt at applet load, and the applet reads .mo files that were never
// written — so all fifteen translations were dead on every install, at ~98 %
// translated. The install has a step that compiles them now, and the step is what
// this pins: a README that drops it ships an English-only applet again.
test("the documented install compiles the catalogs the applet reads", () => {
    const readme = fs.readFileSync(readmePath, "utf8");

    assert.match(readme, /cinnamon-xlet-makepot -i /,
        "the install must msgfmt po/*.po; nothing else in the pipeline does");
    assert.doesNotMatch(readme, /which Cinnamon builds from `po\/\*\.po`/,
        "Cinnamon does not build them, and saying so is what hid this");

    // it must land where the applet looks: localeUtils binds the textdomain to
    // ~/.local/share/locale for a per-user install, and that is where
    // cinnamon-xlet-makepot -i writes
    const localeText = fs.readFileSync(path.join(appletDir, "localeText.js"), "utf8");
    assert.match(localeText, /home \+ "\/\.local\/share\/locale"/);

    // and the catalogs it compiles are the ones in the tree
    const catalogs = fs.readdirSync(path.join(appletDir, "po")).filter((f) => f.endsWith(".po"));
    assert.ok(catalogs.length >= 15, `${catalogs.length} catalogs`);
});

// REGRESSION: dateFormats wraps the two calendar formats in _() precisely so a
// translator can reorder them — and not one of the fifteen catalogs translated
// either, so gettext returned the msgid and every locale rendered the US
// month-day-year order. A German user's event-list heading read "Samstag, Juli 12,
// 2026", and the same string is the grid's ACCESSIBLE_DATE_FORMAT, so her screen
// reader announced all 42 day cells that way too.
//
// The machinery was right; the data was never filled in. This is the data.
test("catalogs localize calendar dates while panel formats keep their fixed order", () => {
    const poDir = path.join(appletDir, "po");
    const catalogs = fs.readdirSync(poDir).filter((name) => name.endsWith(".po"));
    assert.ok(catalogs.length >= 15);

    // The calendar's two long forms remain locale-controlled.
    const dateFormats = fs.readFileSync(path.join(appletDir, "dateFormats.js"), "utf8");
    const panel = fs.readFileSync(path.join(appletDir, "5.4", "appletPanelStatus.js"), "utf8");
    const msgids = Array.from(dateFormats.matchAll(/_\("([^"]*%B[^"]*)"\)/g)).map(([, id]) => id);
    assert.deepEqual(msgids, ["%B %-e, %Y", "%A, %B %-e, %Y"]);

    // The panel and tooltip defaults are deliberately invariant: DD MMM and
    // 24-hour time, regardless of the desktop locale or clock preference.
    assert.match(panel, /DEFAULT_DATE_TIME_FORMAT = "%d %b %H:%M"/);
    assert.doesNotMatch(panel, /_\("%d %b %H:%M"\)/,
        "the fixed display order must not be translated or rearranged");

    for (const catalog of catalogs) {
        const source = fs.readFileSync(path.join(poDir, catalog), "utf8");

        for (const msgid of msgids) {
            const entry = new RegExp(`^msgid "${msgid.replace(/[%\-.*+?^${}()|[\]\\]/g, "\\$&")}"\nmsgstr "(.*)"$`, "m");
            const match = source.match(entry);
            assert.ok(match, `${catalog} has no entry for ${msgid}`);
            assert.notEqual(match[1], "",
                `${catalog} leaves ${msgid} untranslated, so it renders in US order`);

            // a format string, not a sentence: the fields must survive translation
            assert.match(match[1], /%[-\w]*[Bbm]/, `${catalog}: ${msgid} lost its month`);
            assert.match(match[1], /%[-\w]*[eYd]/, `${catalog}: ${msgid} lost its day or year`);
        }
    }
});

// The applet declares GPL-2.0-or-later, redistributes two GPL works, and shipped
// neither the licence text nor a single per-file notice: Cinnamon installs only
// files/chronos@geraldo-netto/, and 0 of the 45 sources in it carried a copyright
// or an SPDX tag. A GPL derived work of three authors was shipping with nothing
// to say so.
test("what ships carries its licence", () => {
    const shipped = fs.readFileSync(path.join(appletDir, "LICENSE"), "utf8");
    assert.match(shipped, /GNU GENERAL PUBLIC LICENSE\n\s+Version 2, June 1991/);
    assert.equal(shipped, fs.readFileSync(path.join(__dirname, "..", "LICENSE"), "utf8"),
        "the copy that ships and the one at the root must not drift");

    const sources = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory() && entry.name !== "po" && entry.name !== "__pycache__") {
                walk(full);
            } else if (entry.isFile() && /\.(js|py)$/.test(entry.name)) {
                sources.push(full);
            }
        }
    };
    walk(appletDir);
    assert.ok(sources.length >= 40, `${sources.length} shipped sources`);

    for (const file of sources) {
        const head = fs.readFileSync(file, "utf8").split("\n").slice(0, 12).join("\n");
        assert.match(head, /SPDX-License-Identifier: GPL-2\.0-or-later/,
            `${path.relative(appletDir, file)} ships with no licence notice`);
        assert.match(head, /calendar@ccprog[\s\S]*calendar@simonwiles\.net/,
            `${path.relative(appletDir, file)} does not credit the works it derives from`);
    }
});

// Cinnamon matches the running series against this list literally: a manifest
// that names only 5.4 is "incompatible" on Mint's current 6.x, even though the
// multiversion 5.4/ tree loads there fine — and the README promises 5.4 or newer.
// The list is the promise; the loader picks the highest 5.4/-style directory at
// or below the running series, so one directory serves them all.
test("the manifest supports every Cinnamon series the README promises", () => {
    const metadata = JSON.parse(fs.readFileSync(path.join(appletDir, "metadata.json"), "utf8"));
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    const supported = metadata["cinnamon-version"];

    assert.match(readme, /Cinnamon \*\*5\.4 or newer\*\*/);
    assert.equal(supported[0], "5.4", "5.4 is the floor the README states");
    assert.ok(supported.some((series) => series.startsWith("6.")),
        "a 6.x series is missing, so the Applets manager calls this incompatible on Mint 22");

    // ascending, with no gap in the series Cinnamon actually ships
    assert.deepEqual(supported, [...supported].sort(
        (a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]) ||
            Number(a.split(".")[1]) - Number(b.split(".")[1])));

    // and every version directory that ships is one the manifest claims
    const versionDirs = fs.readdirSync(appletDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+\.\d+$/.test(entry.name))
        .map((entry) => entry.name);
    versionDirs.forEach((dir) => assert.ok(supported.includes(dir),
        `the ${dir}/ tree ships but the manifest does not claim ${dir}`));
});

test("the Spices manifest credits the applets this one was merged from", () => {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "info.json"), "utf8"));
    const metadata = JSON.parse(fs.readFileSync(path.join(appletDir, "metadata.json"), "utf8"));
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

    // the Spices manifest is keyed by uuid; info.json carried none, so the one
    // file the site reads to place the xlet did not say which xlet it was
    assert.equal(info.uuid, "chronos@geraldo-netto");
    assert.equal(info.uuid, metadata.uuid,
        "info.json and metadata.json disagree about the uuid");
    assert.equal(info.author, "Geraldo Netto");
    assert.match(info.original_author, /ccprog/);
    assert.match(info.original_author, /simonwiles/);
    // the README names the same two upstreams
    assert.match(readme, /calendar@ccprog/);
    assert.match(readme, /calendar@simonwiles\.net/);
});

test("the manual install does not copy Python bytecode", () => {
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    // a plain cp -r drags __pycache__ from the working tree into the install
    assert.doesNotMatch(readme, /cp -r "cinnamon-spices-applets/);
    assert.match(readme, /--exclude '__pycache__'/);
});

test("holiday timezone default is one-time and weather remains opt-in", () => {
    const data = schema("5.4");

    assert.equal(data["show-weather"].default, false);
    assert.equal(data.country.default, "",
        "an empty new-install sentinel lets upgrades preserve an old explicit none");
    assert.equal(data.country.options["None (disable holidays)"], "none");
    assert.equal(data["holiday-country-timezone-default-attempted"], undefined);
    assert.match(data.country.tooltip, /operating-system timezone/);
});

test("the clock cap is the same in schema, JS, Python, and the README", () => {
    // the cap lives in several unlinked places; this test is the link
    const worldclocks = fs.readFileSync(path.join(appletDir, "worldclockData.js"), "utf8");
    const widgets = fs.readFileSync(path.join(appletDir, "settings_widgets_common.py"), "utf8");
    const cityWeather = fs.readFileSync(path.join(appletDir, "cityWeather.js"), "utf8");
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    const data = schema("5.4");

    const jsCap = Number(/var MAX_CLOCKS = (\d+);/.exec(worldclocks)[1]);
    const pyCap = Number(/^MAX_CLOCKS = (\d+)$/m.exec(widgets)[1]);

    assert.equal(jsCap, pyCap);
    assert.match(data.worldclocks.tooltip, new RegExp(`up to ${jsCap} timezones`));

    // one city per clock: cityWeather must not carry a cap of its own, or a
    // raised clock cap leaves the extra clocks with a blank temperature column
    // and nothing to say why
    assert.match(cityWeather, /const MAX_CITIES = WorldclockData\.MAX_CLOCKS;/,
        "the city cap is the clock cap, not a copy of its current value");

    // the README states the cap in prose; every mention must agree
    // the prose wraps, so allow the count and its noun to sit on separate lines
    const readmeCaps = Array.from(readme.matchAll(/up\s+to\s+(\d+)\s+(?:extra\s+)?(?:clocks|timezones)/gi))
        .map((match) => Number(match[1]));
    assert.notEqual(readmeCaps.length, 0, "the README must state the clock cap");
    for (const cap of readmeCaps) {
        assert.equal(cap, jsCap);
    }
});

test("the holiday refresh period is the same in code and the README", () => {
    // UPDATE_PERIOD_DAYS is the one source; the README quotes it in prose
    const cache = fs.readFileSync(path.join(appletDir, "holidayCache.js"), "utf8");
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

    const days = Number(/var UPDATE_PERIOD_DAYS = (\d+);/.exec(cache)[1]);
    const readmeDays = Array.from(readme.matchAll(/every\s+(\d+)\s+days/gi)).map((m) => Number(m[1]));
    assert.notEqual(readmeDays.length, 0, "the README must state the refresh period");
    for (const stated of readmeDays) {
        assert.equal(stated, days);
    }
});

test("the clock list is tall enough to show every clock the cap allows", () => {
    // Cinnamon's List widget defaults to 200px, and a GTK tree view spends 29px
    // on the header and 22px on each row: eight clocks want 205px, so the last
    // one sat under a scrollbar. Measured on the default theme; a theme with a
    // bigger font grows the rows, hence the slack.
    const HEADER_HEIGHT = 29;
    const ROW_HEIGHT = 22;
    const widgets = fs.readFileSync(path.join(appletDir, "settings_widgets_common.py"), "utf8");
    const cap = Number(/^MAX_CLOCKS = (\d+)$/m.exec(widgets)[1]);
    const data = schema("5.4");

    assert.ok(data.worldclocks.height >= HEADER_HEIGHT + (cap * ROW_HEIGHT),
        "raising the clock cap without raising the list height hides clocks behind a scrollbar");
});

test("timezone entry dialog title is localized and extracted", () => {
    const widgets = fs.readFileSync(path.join(appletDir, "settings_widgets_common.py"), "utf8");
    const pot = fs.readFileSync(path.join(appletDir, "po", "chronos@geraldo-netto.pot"), "utf8");

    assert.match(widgets, /_\("City or timezone \(e\.g\. Buenos Aires\)"\)/);
    assert.match(pot, /msgid "City or timezone \(e\.g\. Buenos Aires\)"/);
});

// The applet's own name was translated — "Kalender", "Calendrier", "行事曆",
// "Calendário Geraldo" — so it appeared under a different name per locale in the
// Applets manager, and README's "search for Chronos Calendar" was wrong for
// those users. A product name is a name.
//
// The name is read from the manifest rather than written here twice: renaming the
// applet must not quietly turn this test into a no-op that matches nothing.
test("the applet's name is not translated", () => {
    const poDir = path.join(appletDir, "po");
    const { name } = JSON.parse(fs.readFileSync(path.join(appletDir, "metadata.json"), "utf8"));
    const pattern = new RegExp(`msgid "${name}"\\nmsgstr "([^"]*)"`);

    const catalogs = fs.readdirSync(poDir).filter((file) => file.endsWith(".po"));
    assert.ok(catalogs.length > 0, "there are catalogs to check");

    for (const file of catalogs) {
        const catalog = fs.readFileSync(path.join(poDir, file), "utf8");
        const entry = pattern.exec(catalog);

        assert.ok(entry, `${file} has no entry for the applet name "${name}"`);
        assert.equal(entry[1], "", `${file} renames the applet to "${entry[1]}"`);
    }
});

test("world clock strings stay extracted into the template", () => {
    const pot = fs.readFileSync(path.join(appletDir, "po", "chronos@geraldo-netto.pot"), "utf8");

    assert.match(pot, /msgid "Local time"/);
    assert.match(pot, /worldclocks->tooltip[\s\S]*UTC and your local time are always shown/);
    assert.match(pot, /worldclocks->tooltip[\s\S]*timezones on top of them/);
    assert.match(pot, /worldclocks->tooltip[\s\S]*pick it from the suggestions/);
});

// the README is not where consent is given: the settings dialog is. The country
// setting has said so all along; the two weather settings, which also leave the
// machine, did not.
test("every setting that leaves the machine says so where it is switched on", () => {
    const schema54 = schema("5.4");

    for (const key of ["show-weather", "weather-location", "worldclocks", "country"]) {
        assert.match(schema54[key].tooltip, /third-party/,
            `${key} sends something to a third party and its tooltip must say so`);
    }
});

test("README documents weather privacy data flow", () => {
    const readme = fs.readFileSync(readmePath, "utf8");

    assert.match(readme, /Open-Meteo/);
    assert.match(readme, /geocoding-api\.open-meteo\.com/);
    assert.match(readme, /api\.open-meteo\.com/);
    assert.match(readme, /every 30 minutes/);
});

test("README links to Enrico over canonical HTTPS URLs", () => {
    const readme = fs.readFileSync(readmePath, "utf8");

    assert.match(readme, /https:\/\/kayaposoft\.com\/enrico\//);
    assert.match(readme, /https:\/\/holidays\.kayaposoft\.com\//);
    assert.doesNotMatch(readme, /http:\/\/[^\s)]*kayaposoft\.com/);
});

// The schema change that renamed "Region" to ten per-country descriptions
// orphaned a translation that existed in all 15 catalogs, and nothing noticed:
// the pot is regenerated by hand, and no test compared it with the schema. Every
// user-visible schema string has to be a msgid the template actually carries, or
// it renders in English for everyone.
// Every string in the schema that a user reads: the four text fields, plus a
// combobox's option labels — "Angola", "Brussels", "None (disable holidays)" are
// what is actually in the list, and they are translated too.
const SCHEMA_TEXT_FIELDS = ["description", "tooltip", "title", "units"];

function shownSchemaStrings(data) {
    const shown = [];

    for (const [key, entry] of Object.entries(data)) {
        if (!entry || typeof entry !== "object" || key === "layout") {
            continue;
        }

        SCHEMA_TEXT_FIELDS
            .filter((field) => typeof entry[field] === "string" && entry[field])
            .forEach((field) => shown.push([key, field, entry[field]]));

        if (entry.options && typeof entry.options === "object") {
            Object.keys(entry.options).forEach((label) => shown.push([key, "option", label]));
        }
    }

    return shown;
}

test("every string the settings dialog shows is in the translation template", () => {
    const data = schema("5.4");
    const pot = fs.readFileSync(
        path.join(appletDir, "po", "chronos@geraldo-netto.pot"), "utf8");

    // msgids as the template declares them, unwrapped
    const msgids = new Set(
        Array.from(pot.matchAll(/^msgid ((?:"(?:[^"\\]|\\.)*"\n?)+)/gm))
            .map(([, raw]) => raw.match(/"(?:[^"\\]|\\.)*"/g)
                .map((part) => JSON.parse(part)).join("")));

    const shown = shownSchemaStrings(data);
    assert.ok(shown.length > 20, "the schema strings were not found");

    for (const [key, field, text] of shown) {
        assert.ok(msgids.has(text),
            `${key}.${field} is shown to the user but is not a msgid: ` +
            `"${text.slice(0, 60)}" — it will render in English in all 15 languages`);
    }
});
