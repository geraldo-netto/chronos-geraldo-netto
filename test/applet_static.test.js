const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// Source-level invariants: the rules that have no runtime surface to drive.
//
// Most of this file used to be `assert.match(sourceText, /regex/)` over behaviour
// that the applet, calendar, event and weather suites already exercise — locking
// the shape of a line rather than what it does, and sitting outside the coverage
// gate while doing it. A regex that matches `if (pending.events_changed)` passes
// whether or not that flag is ever false. Those are gone: what they were guarding
// is asserted by driving the code (T414), and each one was removed only after
// mutating the line it watched and confirming a behavioural test failed.
//
// What is left is what genuinely cannot be a behavioural test:
//
//   - the GJS export rule. Cinnamon's importer exposes a module's top-level `var`
//     and function declarations and nothing else; Node's require() exposes a
//     `const` just as happily, so no test running under Node can see the
//     difference. The declarations themselves are the only evidence.
//   - what the applet must never *do*: no synchronous spawn or socket on the
//     compositor thread, no raw request URL in the log, no deprecated Lang.bind,
//     no plain-HTTP link. An absence has no behaviour to drive.
//   - the stylesheet: St parses a fixed set of values, and a sheet is not code.
//   - the gettext domain each translating file declares.

function appletSource(version) {
    return fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", version, "applet.js"), "utf8");
}

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, "..", "files", "chronos@geraldo-netto", relativePath), "utf8");
}

function jsSources(relativeDir = "") {
    const root = path.join(__dirname, "..", "files", "chronos@geraldo-netto", relativeDir);
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return entries.flatMap((entry) => {
        const relativePath = path.join(relativeDir, entry.name);
        if (entry.isDirectory()) {
            return jsSources(relativePath);
        }
        return entry.isFile() && entry.name.endsWith(".js") ? [relativePath] : [];
    });
}

// Under Cinnamon the root modules reach each other through the GJS importer
// (appletManager.applets[UUID].weatherFormat), which exposes a module's
// top-level `var` and function declarations and nothing else. A `const` still
// resolves today, but only because GJS warns instead of breaking:
//
//   Some code accessed the property 'WEATHER_DEBOUNCE_MS' on the module
//   'weatherFormat'. That property was defined with 'let' or 'const' [...]
//   Any symbols to be exported from a module must be defined with 'var'.
//
// The 5.4 tree is exempt: Cinnamon's require() hands back a plain module.exports
// object, which carries a `const` fine. Node's require() does too, so the rest of
// the suite cannot see the difference — this reads the declarations instead.
test("every name one root module reads off another is declared with var or function", () => {
    const rootModules = jsSources().filter((file) => !file.includes(path.sep));
    const sources = new Map(rootModules.map((file) => [file, source(file)]));

    const importsOf = (code) => {
        const aliases = new Map();
        // [^;] keeps the match inside one declaration: a greedier scan runs past
        // the semicolon and pins the next module's import onto this alias
        const pattern = /const\s+([\w$]+)\s*=[^;]{0,200}?applets\["chronos@geraldo-netto"\]\.([\w$]+)/g;
        for (const [, alias, imported] of code.matchAll(pattern)) {
            aliases.set(alias, `${imported}.js`);
        }
        return aliases;
    };

    let checked = 0;
    for (const [file, code] of sources) {
        for (const [alias, imported] of importsOf(code)) {
            const targetCode = sources.get(imported);
            if (!targetCode) {
                continue;
            }

            for (const [, name] of code.matchAll(new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)`, "g"))) {
                const declared = new RegExp(`^(?:var\\s+${name}\\b|function\\s+${name}\\s*\\()`, "m");
                assert.match(targetCode, declared,
                    `${file} reads ${alias}.${name}, so ${imported} must declare ${name} as var or function`);
                checked++;
            }
        }
    }

    // a regex that silently matched nothing would pass this test forever
    assert.ok(checked > 0, "the import scan found nothing to check");
});

// A fork+exec on the compositor thread stalls the whole shell, not just us — and
// the guard against the single worst thing this code could do could be walked
// straight past: GJS's most common synchronous spawn is
// GLib.spawn_command_line_sync, which does not contain the substring
// "spawn_sync". Nor did the check cover any file but localeUtils.
test("nothing in the applet blocks the compositor on a subprocess or a socket", () => {
    // every synchronous fork+exec GLib and Gio offer, plus the synchronous HTTP
    // call Soup offers, spelled out rather than pattern-matched on a substring
    const blocking = [
        /\bspawn_sync\b/,
        /\bspawn_command_line_sync\b/,
        /\bspawn_async_with_pipes\b.*\bwait\b/,
        /\bcommunicate_utf8\s*\(/,        // the sync twin of communicate_utf8_async
        /\bcommunicate\s*\(/,
        /\bsend_and_read\s*\(/,           // Soup's synchronous request
        /\bsend\s*\(\s*null\s*\)/
    ];

    for (const file of jsSources()) {
        const code = source(file);
        for (const pattern of blocking) {
            assert.doesNotMatch(code, pattern,
                `${file} makes a blocking call on the compositor thread`);
        }
    }

    // and the one place that does need a subprocess uses the async API
    assert.match(source("localeQuery.js"), /communicate_utf8_async/);
});

// The weather and holiday features were each split into a pure half and a
// networked half; the UI kept requiring the barrels, so the day grid linked the
// cache repository, the three vendor adapters and a Soup session in order to read
// two error identifiers, and the panel presenter linked the provider chains and
// the refresh scheduler to read six constants and a formatter. The split is only
// real if the import graph honours it, and only the imports say whether it does.
test("the presentation modules do not import the network stack", () => {
    const grid = source("5.4/calendar.js");
    assert.doesNotMatch(grid, /require\("\.\/holidays"\)/,
        "the grid reads HOLIDAY_ERRORS, which holidayConstants declares");
    assert.match(grid, /require\("\.\/holidayConstants"\)/);

    const panel = source("5.4/appletPanelStatus.js");
    assert.doesNotMatch(panel, /require\("\.\/weather"\)/,
        "the presenter reads constants and formatters, which weatherFormat declares");
    assert.match(panel, /require\("\.\/weatherFormat"\)/);
});

test("5.4 sources avoid deprecated Lang.bind callbacks", () => {
    for (const relativePath of jsSources("5.4")) {
        assert.doesNotMatch(source(relativePath), /Lang\.bind/,
            `${relativePath} should use arrow functions or Function.bind`);
    }
});

test("5.4 strftime help opens over HTTPS", () => {
    const source = appletSource("5.4");

    assert.match(source, /xdg-open https:\/\/cinnamon-spices\.linuxmint\.com\/strftime\.php/);
    assert.doesNotMatch(source, /xdg-open http:\/\//);
});

test("event managers expose teardown and applets call it", () => {
    const code = source("eventsManager.js");
    assert.match(code, /this\._calendar_server_signal_ids = \[\];/);
    assert.match(code, /destroy\(\) \{[\s\S]*?this\._server_connection\.destroy\(\);[\s\S]*?this\._stop_gc_timer\(\);[\s\S]*?this\._cancel_reload_today\(\);/);
    assert.match(code, /for \(let id of this\._calendar_server_signal_ids\) \{[\s\S]*?this\._calendar_server\.disconnect\(id\);/);
    assert.match(code, /this\._calendar_server = null;[\s\S]*?this\._inited = false;/);

    assert.match(code, /Gio\.bus_unwatch_name\(this\._bus_watch_id\);/);
    assert.match(code, /this\.cancelRetry\(\);/);

    assert.match(appletSource("5.4"), /this\._providerLifecycle && this\._providerLifecycle\.destroy\(\)/);
});

test("calendar and event list destroy pending timers", () => {
    const calendar52 = source("5.4/calendar.js");
    assert.match(calendar52, /_cancel_set_date_idle\(\) \{[\s\S]*?Mainloop\.source_remove\(this\._set_date_idle_id\);/);
    assert.match(calendar52, /destroy\(\) \{[\s\S]*?this\._cancel_update\(\);[\s\S]*?this\._cancel_set_date_idle\(\);/);
    assert.match(calendar52, /this\._desktop_settings_signal_id =\n\s*this\.desktop_settings\.connectFirstDayOfWeekChanged\(/);
    assert.match(calendar52, /destroy\(\) \{[\s\S]*?this\.desktop_settings\.disconnect\(this\._desktop_settings_signal_id\);/);

    // the renderer arms these sources, so the renderer removes them; the list's
    // destroy() hands the job to it rather than reaching into ids it never set
    const eventView52 = source("5.4/eventView.js");
    assert.match(eventView52, /destroy\(\) \{\n\s*this\._cancelScroll\(\);\n\s*this\._cancelNoEventsTimeout\(\);\n\s*this\._cancelRowBuild\(\);/);
    assert.match(eventView52, /destroy\(\) \{\n\s*this\._renderer\.destroy\(\);/);

    const applet52 = appletSource("5.4");
    assert.match(applet52, /this\._calendar && this\._calendar\.destroy\(\)/);
    assert.match(applet52, /this\.event_list && this\.event_list\.destroy\(\)/);
});

test("applets disconnect settings and resume handlers on removal", () => {
    const appletCode = appletSource("5.4");
    const code = source("5.4/appletLifecycle.js");
    assert.match(appletCode, /require\("\.\/appletLifecycle"\)/);
    assert.match(code, /this\._desktop_settings_signal_ids = \[\];/);
    assert.match(code, /this\._up_resume_signal_id = 0;/);
    assert.match(code, /class AppletProviderLifecycle \{/);
    assert.match(code, /this\._desktop_settings_signal_ids =\n\s*context\.desktopSettings\.connectClockFormatChanged\(context\.onSettingsChanged\);/);
    assert.match(code, /this\._up_resume_signal_id = this\._up_client\.connect\("notify-resume", context\.onResume\);/);
    assert.match(code, /this\._up_resume_signal_id = this\._up_client\.connect\("notify::resume", context\.onResume\);/);
    assert.match(code, /for \(let id of this\._desktop_settings_signal_ids\) \{[\s\S]*?this\.context\.desktopSettings\.disconnect\(id\);/);
    assert.match(code, /this\._up_client\.disconnect\(this\._up_resume_signal_id\);/);
    assert.match(appletCode, /this\.settings && this\.settings\.finalize\(\)/);
});

test("date changes force a menu update explicitly", () => {
    const appletCode = appletSource("5.4");
    const code = source("5.4/appletMenuBuilder.js");
    // binding the method directly let the signal's emitter argument land in
    // the forceMenuUpdate parameter — true only by accident
    assert.match(appletCode, /require\("\.\/appletMenuBuilder"\)/);
    assert.match(code, /class AppletMenuBuilder \{/);
    assert.match(code, /connect\("selected-date-changed", \(\) => context\.onSelectedDateChanged\(\)\)/);
    assert.match(appletCode, /onSelectedDateChanged: \(\) => this\._updateClockAndDate\(true\)/);
});

test("date settings menu items are not shared between menus", () => {
    const code = source("5.4/appletMenuBuilder.js");
    // a single PopupMenuItem added to two menus gets re-parented by the
    // second addMenuItem, leaving the first menu with a stale entry
    assert.match(code, /for \(let menu of \[context\.contextMenu, context\.menu\]\) \{[\s\S]*?let item = new PopupMenu\.PopupMenuItem\(_\("Date and Time Settings"\)\);[\s\S]*?menu\.addMenuItem\(item\);/);
    const sharedAdds = code.match(/this\.menu\.addMenuItem\(item\)/g) || [];
    assert.equal(sharedAdds.length, 0);
});

test("holiday tooltip callbacks drop stale calendar rebuilds", () => {
    const code = source("5.4/calendar.js");
    assert.match(code, /this\._holiday_update_generation = 0;/);
    assert.match(code, /const holiday_generation = \+\+this\._holiday_update_generation;/);
    // the guard is a named predicate now; what this pins is that the callback
    // still asks it before touching the grid
    assert.match(code, /_isCurrent\(holiday_generation\) \{[\s\S]*?return holiday_generation === this\.host\.holidayGeneration;/);
    assert.match(code, /if \(!this\._isCurrent\(holiday_generation\)\) \{[\s\S]*?return;/);
    assert.match(code, /destroy\(\) \{[\s\S]*?this\._holiday_update_generation\+\+;/);
});

// the status of the holiday lookup belongs to the annotator that produces it;
// what matters is that a provider failure reaches the user, which
// test/calendar.test.js asserts on the rendered label, the tooltip and the
// accessible name
test("calendars surface holiday provider failures", () => {
    const code = source("5.4/calendar.js");
    assert.match(code, /const HOLIDAY_ERROR_MARKER = Utils\.UI_ERROR_MARKER;/);
    assert.match(code, /class CalendarHolidayAnnotator \{/);
    assert.match(code, /setStatus\(error, providerName = ""\) \{/);
    assert.match(code, /HOLIDAY_ERROR_MARKER/);
    assert.match(code, /new Tooltips\.Tooltip\(this\.label\)/);
    assert.match(code, /Holiday data: %s/);
    assert.match(code, /holiday\.getHolidays\(y, m, \(dates, error, providerName\) => \{[\s\S]*?this\._reportProvider\(error, providerName\);/);
    assert.match(code, /_reportProvider\(error, providerName\) \{[\s\S]*?if \(error\) \{[\s\S]*?this\.setStatus\(error, providerName\);/);
});

// request URLs carry the configured country; they must never reach the log
test("holiday requests never log a raw URL", () => {
    const code = source("holidays.js");
    assert.doesNotMatch(code, /global\.log\([^)]*\burl\b/);
});

test("applets surface weather provider failures", () => {
    const code = appletSource("5.4");
    const panelStatus = source("5.4/appletPanelStatus.js");
    assert.match(code, /this\._weather_error = "";/);
    assert.match(code, /this\._weather_provider = "";/);
    assert.match(code, /_setWeatherStatus\(weatherReading = null, weatherError = "", weatherProvider = "", pending = false\) \{[\s\S]*?this\._weather_reading = weatherReading \|\| null;[\s\S]*?this\._weather_pending = pending;[\s\S]*?this\._weather_error = weatherError;[\s\S]*?this\._weather_provider = weatherProvider \|\| "";/);
    assert.match(panelStatus, /Weather\.WEATHER_ERROR_MARKER\);\n/);
    assert.match(panelStatus, /Weather\.WEATHER_ERROR_MARKER \+ " " \+ translateWeatherError\(view\.weatherError\)/);
    assert.match(panelStatus, /_\("Set a weather location"\)/);
    // the tooltip is a clock table and nothing else: the provider credit that
    // used to sit under a blank line at its foot is gone from it, and lives in
    // the world-clock popup's accessible name
    assert.doesNotMatch(panelStatus, /_\("Source: %s"\)/);
    assert.match(code, /this\._weatherProvider\.schedule\([\s\S]*?this\._setWeatherStatus\.bind\(this\)\);/);
    assert.match(code, /this\._weatherProvider\.queue\([\s\S]*?this\._setWeatherStatus\.bind\(this\)\);/);
});

test("event fetch window uses the shared week-start offset", () => {
    const code = source("eventsManager.js");
    // raw week_day - week_start mixes ISO (1=Mon..7=Sun) with the 0=Sun
    // convention and started the window a week early for Sunday locales
    assert.doesNotMatch(code, /week_day - week_start/);
    assert.match(code, /Utils\.monthWindowStartOffset\(\n?\s*day_one\.get_day_of_week\(\), Cinnamon\.util_get_week_start\(\)\)/);
});

test("translating files use the applet's own gettext domain", () => {
    for (const relativePath of [
        "5.4/appletMenuBuilder.js",
        "5.4/appletPanelStatus.js",
        "5.4/calendar.js",
        "5.4/eventView.js",
        "worldclockData.js"
    ]) {
        const code = source(relativePath);
        assert.match(code, /const _ = Utils\.translate/,
            `${relativePath} must use the shared UUID-domain translator`);
    }

    for (const relativePath of [
        "localeText.js"
    ]) {
        const code = source(relativePath);
        assert.match(code, /Gettext\.bindtextdomain\(UUID/,
            `${relativePath} must bind the UUID domain`);
        assert.match(code, /d(p)?gettext\(UUID/,
            `${relativePath} must translate through the UUID domain`);
    }

    // the shipped .po files carry these plural msgids; the global ngettext
    // (cinnamon domain) can never load them
    const eventView = source("5.4/eventView.js");
    assert.match(eventView, /const ngettext = Utils\.translatePlural;/);
    assert.doesNotMatch(eventView, /function ngettext\(singular, plural, n\)/);
});

test("weather failures keep showing the stale reading with the marker", () => {
    const code = source("5.4/appletPanelStatus.js");
    assert.match(code, /parts\.push\(reading \?\n\s+Weather\.WEATHER_ERROR_MARKER \+ " " \+ reading :\n\s+Weather\.WEATHER_ERROR_MARKER\);/);
    // the tooltip row keeps the temperature in its own column and puts the marker
    // in the condition column, so a failed refresh loses neither. Both the
    // built-in and city rows render their reading record through _readingCells.
    assert.match(code, /error \|\| this\._conditionWords\(record\.condition\)/);
    assert.match(code, /return record \? this\._readingCells\(record, error\) : \["", error\];/);
});

test("bad custom formats fall back without breaking either display", () => {
    const code = source("5.4/appletPanelStatus.js");
    assert.doesNotMatch(code, /~CLOCK FORMAT ERROR~/);
    assert.match(code, /_\("Invalid time format; edit it in Settings"\)/);
    assert.match(code, /entry\.localTime\.format\(DEFAULT_DATE_TIME_FORMAT\) \|\| entry\.time/,
        "an invalid tooltip format stays inside the location row with a safe timestamp");
});

test("go-home button takes focus and activates from the keyboard", () => {
    const code = source("5.4/appletMenuBuilder.js");
    assert.match(code, /const button = new St\.BoxLayout\(\n\s+\{[\s\S]*?can_focus: true,/);
    assert.match(code, /button\.connect\("key-press-event",[\s\S]*?context\.onGoHome\(\);/);
});

test("stylesheet gives keyboard focus a visible marker on any theme", () => {
    const css = source("5.4/stylesheet.css");
    for (const selector of [
        "calendar-event-button",
        "calendar-today-home-button",
        "calendar-today-home-button-enabled",
        "calendar-events-no-events-button",
        "calendar-change-month-back",
        "calendar-change-month-forward",
        "calendar-day",
        // the month label is not focusable any more: the holiday status it used
        // to carry for the keyboard is a visible actor now, because a Tooltip
        // cannot be opened by one
        "calendar-events-date-label"
    ]) {
        assert.match(css, new RegExp(`\\.${selector}:focus`),
            `${selector} can take focus but has no focus marker`);
    }

    // a single hard-coded white marker vanishes on a light theme: the rule
    // pairs a dark border with a light outline so one of them always contrasts
    const focusRule = /:focus[\s\S]*?\{([\s\S]*?)\}/.exec(css)[1];
    assert.match(focusRule, /border:[^;]*rgba\(0, 0, 0/);
    assert.match(focusRule, /outline:[^;]*rgba\(255, 255, 255/);

    // The themes disagree about the shape of a day cell — Cinnamon's fallback
    // rounds it to a circle, Mint-Y leaves it square — so naming any radius
    // here is right for one theme and wrong for the other. The marker says
    // where the focus is; it does not reshape what it lands on.
    const dayFocusRule = /\.calendar-day:focus,\s*\.calendar-day-base:focus \{([\s\S]*?)\}/.exec(css);
    assert.ok(dayFocusRule, "the day cells keep their own focus rule");
    assert.doesNotMatch(dayFocusRule[1], /border-radius/,
        "a radius here overrides the theme's and changes the cell's shape on focus");
    assert.match(dayFocusRule[1], /border:[^;]*rgba\(0, 0, 0/);
    assert.match(dayFocusRule[1], /outline:[^;]*rgba\(255, 255, 255/);
});

test("launch_calendar refuses to spawn without gnome-calendar", () => {
    const code = source("5.4/eventView.js");
    assert.match(code, /class CalendarLauncher \{/);
    assert.match(code, /isAvailable\(\) \{[\s\S]*?GLib\.find_program_in_path\("gnome-calendar"\)/);
    assert.match(code, /launchDate\(gdate\) \{[\s\S]{0,250}?if \(!this\.isAvailable\(\)\) \{\n\s+return false;/);
    assert.match(code, /launch_calendar\(gdate\) \{[\s\S]*?this\._calendar_launcher\.launchDate\(gdate\)/);
});

// The tooltip is a table of clocks whose columns are lined up with spaces, so it
// needs a fixed-width font and an alignment that does not move the rows.
//
// This test used to assert `text-align: start` and forbid `left` — it locked the
// bug in. St parses text-align as left | right | center | justify only, so
// `start` was discarded and the themes' own centred alignment on #Tooltip kept
// winning: the rows are padded to a common width and then right-trimmed, so
// centring gave each one its own indent and combed the table apart, under a
// monospace font that was applying and lining nothing up. A value the parser
// drops is not a value, whatever it would have meant if it were.
test("the clock tooltip is aligned with a value St can parse", () => {
    const css = source("5.4/stylesheet.css");
    const tooltip = /#Tooltip\.calendar-tooltip\s*\{([^}]*)\}/.exec(css);

    assert.ok(tooltip, "the tooltip rule is there");
    assert.match(tooltip[1], /text-align:\s*(left|right|center|justify)\s*;/,
        "St knows left, right, center and justify — nothing else");
    // the columns are padded with spaces, so they still need a fixed-width font
    assert.match(tooltip[1], /font-family:\s*monospace/);
});

// The instance above was one rule. The bug is the class: a declaration St cannot
// parse is dropped in silence — no warning in the log, no error in the sheet, and
// the theme's own value goes on winning underneath it. It looks exactly like a
// rule that works, and the only way to see otherwise is to look at the pixels.
// So the whole sheet is checked, not the one rule that was caught doing it.
test("every text-align in the sheet is a value St can parse", () => {
    const css = source("5.4/stylesheet.css");
    const ST_PARSES = ["left", "right", "center", "justify"];

    const declarations = [...css.matchAll(/text-align\s*:\s*([a-z-]+)/g)];
    assert.ok(declarations.length > 0, "there is at least one to check");

    for (const [, value] of declarations) {
        assert.ok(ST_PARSES.includes(value),
            `text-align: ${value} is not one of ${ST_PARSES.join(" | ")} — St drops ` +
            "it, the theme's value wins, and nothing anywhere says so");
    }
});
