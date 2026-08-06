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

function importsOf(code) {
    const aliases = new Map();
    // [^;] keeps the match inside one declaration: a greedier scan runs past
    // the semicolon and pins the next module's import onto this alias
    const pattern = /const\s+([\w$]+)\s*=[^;]{0,200}?applets\["chronos@geraldo-netto"\]\.([\w$]+)/g;
    for (const [, alias, imported] of code.matchAll(pattern)) {
        aliases.set(alias, `${imported}.js`);
    }
    return aliases;
}

function assertImportedNames(file, code, alias, imported, targetCode) {
    let checked = 0;
    const reads = new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)`, "g");
    for (const [, name] of code.matchAll(reads)) {
        const declared = new RegExp(`^(?:var\\s+${name}\\b|function\\s+${name}\\s*\\()`, "m");
        assert.match(targetCode, declared,
            `${file} reads ${alias}.${name}, so ${imported} must declare ${name} as var or function`);
        checked++;
    }
    return checked;
}

function assertModuleImports(file, code, sources) {
    let checked = 0;
    for (const [alias, imported] of importsOf(code)) {
        const targetCode = sources.get(imported);
        checked += targetCode ?
            assertImportedNames(file, code, alias, imported, targetCode) : 0;
    }
    return checked;
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
// The 6.0 tree is exempt: Cinnamon's require() hands back a plain module.exports
// object, which carries a `const` fine. Node's require() does too, so the rest of
// the suite cannot see the difference — this reads the declarations instead.
test("every name one root module reads off another is declared with var or function", () => {
    const rootModules = jsSources().filter((file) => !file.includes(path.sep));
    const sources = new Map(rootModules.map((file) => [file, source(file)]));

    let checked = 0;
    for (const [file, code] of sources) {
        checked += assertModuleImports(file, code, sources);
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
// cache repository, all vendor adapters and a Soup session in order to read
// two error identifiers, and the panel presenter linked the provider chains and
// the refresh scheduler to read six constants and a formatter. The split is only
// real if the import graph honours it, and only the imports say whether it does.
test("the presentation modules do not import the network stack", () => {
    const grid = source("6.0/calendar.js");
    assert.doesNotMatch(grid, /require\("\.\/holidays"\)/,
        "the grid renders holiday marks the annotator hands it; it needs no holiday module at all");

    const annotations = source("6.0/calendarAnnotations.js");
    assert.doesNotMatch(annotations, /require\("\.\/holidays"\)/,
        "the annotator reads HOLIDAY_ERRORS and the flags, which holidayConstants declares");
    assert.match(annotations, /require\("\.\/holidayConstants"\)/);

    const panel = source("6.0/appletPanelStatus.js");
    assert.doesNotMatch(panel, /require\("\.\/weather"\)/,
        "the presenter reads constants and formatters, which weatherFormat declares");
    assert.match(panel, /require\("\.\/weatherFormat"\)/);
});

// T810: `Weather` named two different modules in files that sit side by side -
// appletLifecycle bound it to weather.js, appletPanelStatus and cityWeather to
// weatherFormat. weather.js flattens weatherFormat into its own namespace on the
// Node side, so RETRY_SECONDS, readingIsStale and WEATHER_ERRORS resolve under
// both bindings under `node test/` and only under weatherFormat in Cinnamon.
// Moving a line between two adjacent files silently rebound every reference, and
// the suite could not see it for any of the flattened names.
test("the Weather binding names weather.js and nothing else", () => {
    for (const file of jsSources()) {
        const code = source(file);
        const bindings = code.matchAll(
            /(?:const|var)\s+Weather\s*=[^;]{0,200}?["']\.\/(\w+)["']/g);
        for (const [, module] of bindings) {
            assert.equal(module, "weather",
                `${file} binds Weather to ${module}; the pure half is WeatherFormat`);
        }
    }
});

// T811: 6.0/astronomyView reached the root module directly while its three
// siblings went through the 6.0 shim. R14 dispositions the shims as intended
// indirection; it does not license half the tree bypassing them. They are the
// seam where a future version tree adapts a root module for its Cinnamon
// version, so the bypassing file would keep the unadapted root while its
// siblings picked the adaptation up, and nothing would fail.
test("a 6.0 source that has a shim goes through it", () => {
    const shims = new Set(jsSources("6.0")
        .map((file) => path.basename(file, ".js"))
        .filter((name) => jsSources().includes(`${name}.js`)));
    assert.ok(shims.size > 0, "the shim scan found nothing to check");

    for (const file of jsSources("6.0")) {
        if (shims.has(path.basename(file, ".js"))) {
            continue;
        }
        for (const [, name] of source(file).matchAll(
            /AppletModules\.(\w+)|applets\["chronos@geraldo-netto"\]\.(\w+)/g)) {
            assert.ok(!shims.has(name),
                `${file} reaches past 6.0/${name}.js for ${name}`);
        }
    }
});

// T825: the warning glyph was declared three times - the menu builder's
// ISSUE_MARKER, the grid annotator's HOLIDAY_ERROR_MARKER and weatherFormat's
// WEATHER_ERROR_MARKER - and all three land in the same footer, the same
// tooltip and the same accessible names. The activation key set was written
// three times too, twice as a chain of !==, so nothing stopped one focusable
// row answering Space and its neighbour not. And one msgid was declared
// byte-identically in two views: the .pot collapses identical msgids, so
// msgfmt could not have flagged the wording drifting apart.
test("the shared glyph, msgid and key set are each declared once", () => {
    const vocabulary = path.join("6.0", "uiVocabulary.js");
    for (const file of jsSources()) {
        const code = source(file);
        if (file !== "textUtils.js") {
            assert.doesNotMatch(code, /=\s*"⚠"/,
                `${file} must take the warning glyph from TextUtils.WARNING_MARKER`);
        }
        if (file !== vocabulary) {
            assert.doesNotMatch(code, /Some calendar events were hidden/,
                `${file} must take that sentence from 6.0/uiVocabulary`);
            assert.doesNotMatch(code, /Clutter\.KEY_KP_Enter/,
                `${file} must take the activation keys from 6.0/uiVocabulary`);
        }
    }
});

test("6.0 sources avoid deprecated Lang.bind callbacks", () => {
    for (const relativePath of jsSources("6.0")) {
        assert.doesNotMatch(source(relativePath), /Lang\.bind/,
            `${relativePath} should use arrow functions or Function.bind`);
    }
});

test("6.0 strftime help opens over HTTPS", () => {
    const source = appletSource("6.0");

    assert.match(source, /xdg-open https:\/\/cinnamon-spices\.linuxmint\.com\/strftime\.php/);
    assert.doesNotMatch(source, /xdg-open http:\/\//);
});

test("event managers expose teardown and applets call it", () => {
    const code = source("eventsManager.js");
    const connection = source("calendarServerConnection.js");
    const mutationStream = source("eventMutationStream.js");
    const fetchCoordinator = source("eventFetchCoordinator.js");
    assert.match(connection, /this\._calendar_server_signal_ids = \[\];/);
    assert.match(code,
        /destroy\(\) \{[\s\S]*?this\._fetch_coordinator\.destroy\(\);[\s\S]*?this\._mutation_stream\.destroy\(\);[\s\S]*?this\._server_connection\.destroy\(\);[\s\S]*?this\._event_index\.discard\(\);/);
    assert.match(fetchCoordinator,
        /destroy\(\) \{[\s\S]*?this\._fetchCancellable\.cancel\(\);[\s\S]*?this\.stopGcTimer\(\);[\s\S]*?this\.cancelReloadSelected\(\);[\s\S]*?this\.cancelFetchRetry\(\);/);
    assert.match(mutationStream,
        /reset\(\) \{[\s\S]*?for \(const id of this\._eventBatchIds\)[\s\S]*?this\.cancelPendingEmit\(\);[\s\S]*?this\._clearQueue\(\);[\s\S]*?destroy\(\) \{[\s\S]*?this\.reset\(\);/);
    assert.match(connection,
        /const signalIds = this\._calendar_server_signal_ids;[\s\S]*?this\._calendar_server_signal_ids = \[\];[\s\S]*?for \(let id of signalIds\) \{[\s\S]*?server\.disconnect\(id\);/);
    assert.match(connection, /this\._calendar_server = null;[\s\S]*?this\._inited = false;/);

    assert.match(connection, /Gio\.bus_unwatch_name\(this\._bus_watch_id\);/);
    assert.match(connection, /this\.cancelRetry\(\);/);

    const applet = appletSource("6.0");
    assert.match(applet,
        /function destroyIfPresent\(collaborator\) \{[\s\S]*?collaborator\.destroy\(\);/);
    assert.match(applet, /destroyIfPresent\(this\._providerLifecycle\)/);
});

test("calendar and event list destroy pending timers", () => {
    const calendar52 = source("6.0/calendar.js");
    const navigation52 = source("6.0/calendarNavigation.js");
    assert.match(navigation52,
        /cancelQueuedDate\(\) \{[\s\S]*?Mainloop\.source_remove\(this\.setDateIdleId\);/);
    assert.match(calendar52, /destroy\(\) \{[\s\S]*?this\._cancel_update\(\);[\s\S]*?this\._cancel_set_date_idle\(\);/);
    assert.match(calendar52, /this\._desktop_settings_signal_id =\n\s*this\.desktop_settings\.connectFirstDayOfWeekChanged\(/);
    assert.match(calendar52, /destroy\(\) \{[\s\S]*?this\.desktop_settings\.disconnect\(this\._desktop_settings_signal_id\);/);

    // the renderer arms these sources, so the renderer removes them; the list's
    // destroy() hands the job to it rather than reaching into ids it never set
    const eventView52 = source("6.0/eventView.js");
    assert.match(eventView52, /destroy\(\) \{\n\s*this\._cancelScroll\(\);\n\s*this\._cancelNoEventsTimeout\(\);\n\s*this\._cancelRowBuild\(\);/);
    assert.match(eventView52, /destroy\(\) \{\n\s*this\._renderer\.destroy\(\);/);

    // The builder constructs both, so the builder destroys both. Reaching them
    // through build()'s return value made a throw partway through it leave
    // every source above armed for the rest of the session.
    const builder52 = source("6.0/appletMenuBuilder.js");
    assert.match(builder52,
        /_destroyOwned\(field\) \{[\s\S]*?this\[field\] = null;[\s\S]*?owned\.destroy\(\);/);
    assert.match(builder52, /_destroyOwned\("_calendar"\)/);
    assert.match(builder52, /_destroyOwned\("_eventList"\)/);

    const applet52 = appletSource("6.0");
    assert.doesNotMatch(applet52, /destroyIfPresent\(this\._calendar\)/);
    assert.doesNotMatch(applet52, /destroyIfPresent\(this\.event_list\)/);
});

test("applets disconnect settings and resume handlers on removal", () => {
    const appletCode = appletSource("6.0");
    const code = source("6.0/appletLifecycle.js");
    assert.match(appletCode, /require\("\.\/appletLifecycle"\)/);
    assert.match(code, /this\._desktop_settings_signal_ids = \[\];/);
    assert.match(code, /class AppletProviderLifecycle \{/);
    assert.match(code, /this\._desktop_settings_signal_ids =\n\s*context\.desktopSettings\.connectClockFormatChanged\(context\.onSettingsChanged\);/);
    assert.match(code, /for \(let id of this\._desktop_settings_signal_ids\) \{[\s\S]*?this\.context\.desktopSettings\.disconnect\(id\);/);
    assert.match(code, /"PrepareForSleep"/);
    assert.match(code, /signal_unsubscribe\(this\._logind_sleep_signal_id\)/);
    assert.doesNotMatch(code, /UPower|notify-resume|notify::resume|_up_/);
    assert.match(appletCode,
        /function finalizeIfPresent\(settings\) \{[\s\S]*?settings\.finalize\(\);/);
    assert.match(appletCode, /finalizeIfPresent\(this\.settings\)/);
});

test("date changes force a menu update explicitly", () => {
    const appletCode = appletSource("6.0");
    const code = source("6.0/appletMenuBuilder.js");
    // binding the method directly let the signal's emitter argument land in
    // the forceMenuUpdate parameter — true only by accident
    assert.match(appletCode, /require\("\.\/appletMenuBuilder"\)/);
    assert.match(code, /class AppletMenuBuilder \{/);
    assert.match(code,
        /connect\("selected-date-changed", \(unused, date\) => \{[\s\S]*?this\._agenda\.selectDate\(date\);[\s\S]*?context\.onSelectedDateChanged\(\);/);
    assert.match(appletCode,
        /onSelectedDateChanged: \(\) => this\._guarded\([\s\S]*?"selected-date", \(\) => this\._updateClockAndDate\(true\)\)/);
});

test("date settings menu items are not shared between menus", () => {
    const code = source("6.0/appletMenuBuilder.js");
    // a single PopupMenuItem added to two menus gets re-parented by the
    // second addMenuItem, leaving the first menu with a stale entry
    assert.match(code, /for \(let menu of \[context\.contextMenu, context\.menu\]\) \{[\s\S]*?let item = new PopupMenu\.PopupMenuItem\(_\("Date and Time Settings"\)\);[\s\S]*?menu\.addMenuItem\(item\);/);
    const sharedAdds = code.match(/this\.menu\.addMenuItem\(item\)/g) || [];
    assert.equal(sharedAdds.length, 0);
});

test("holiday tooltip callbacks drop stale calendar rebuilds", () => {
    const code = source("6.0/calendar.js");
    assert.match(code, /this\._holiday_update_generation = 0;/);
    assert.match(code, /const holiday_generation = \+\+this\._holiday_update_generation;/);
    // the guard is a named predicate now; what this pins is that the callback
    // still asks it before touching the grid
    const annotations = source("6.0/calendarAnnotations.js");
    assert.match(annotations, /_isCurrent\(holiday_generation\) \{[\s\S]*?return holiday_generation === this\.host\.holidayGeneration;/);
    assert.match(annotations,
        /_receiveMonth\(dates, error, providerName, pass\) \{[\s\S]*?if \(!this\._isCurrent\(pass\.generation\)\) \{[\s\S]*?return;/);
    assert.match(code, /destroy\(\) \{[\s\S]*?this\._holiday_update_generation\+\+;/);
});

// the status of the holiday lookup belongs to the annotator that produces it;
// what matters is that a provider failure reaches the user, which
// test/calendar.test.js asserts on the rendered label, the tooltip and the
// accessible name
test("calendars surface holiday provider failures", () => {
    const code = source("6.0/calendarAnnotations.js");
    assert.match(code, /const HOLIDAY_ERROR_MARKER = TextUtils\.WARNING_MARKER;/);
    assert.match(code, /class CalendarHolidayAnnotator \{/);
    assert.match(code, /setStatus\(error, providerName = ""\) \{/);
    assert.match(code, /HOLIDAY_ERROR_MARKER/);
    assert.match(code, /new Tooltips\.Tooltip\(this\.label\)/);
    assert.match(code, /Holiday data: %s/);
    assert.match(code,
        /holiday\.getHolidays\(y, m, \(dates, error, providerName\) => \{[\s\S]*?this\._receiveMonth\(dates, error, providerName, pass\);/);
    assert.match(code,
        /_receiveMonth\(dates, error, providerName, pass\) \{[\s\S]*?this\._reportProvider\(error, providerName\);/);
    assert.match(code, /_reportProvider\(error, providerName\) \{[\s\S]*?if \(error\) \{[\s\S]*?this\.setStatus\(error, providerName\);/);
});

// request URLs carry the configured country; they must never reach the log
// T787: fillTemplate was written to eliminate two real defects, and it was
// private. Eight production sites went on writing the raw form it replaced:
// a value passed as the replacement argument of String.prototype.replace has
// `$&`, `` $` ``, `$'` and `$1` expanded, and a chained pair rescans the string
// the first call built ("50%sale" announced as "50In progressale"). An absence
// has no behaviour to drive, and what makes any given site latent is what its
// values happen to contain today - which is exactly what a static rule is for.
test("no production string substitution rescans what it just built", () => {
    for (const file of jsSources()) {
        if (file === "textUtils.js") {
            continue;
        }
        assert.doesNotMatch(source(file), /\.replace\(\s*"%s"/,
            `${file} must fill templates with TextUtils.fillTemplate`);
    }
});

// T804: the service layer clamped a provider's diagnostic - a line headed for
// global.logError - with clampHolidayName, whose bound holidayCache documents as
// sizing joined same-day holiday names in a Pango tooltip. Changing the tooltip
// budget silently changed how much of the diagnostic survived into the log, and
// the service took a dependency on the cache module for text formatting it needs
// for nothing else.
test("the holiday service bounds its log lines with its own constant", () => {
    const code = source("holidays.js");

    assert.match(code, /^const MAX_LOGGED_PROVIDER_ERROR = \d+;$/m);
    assert.doesNotMatch(code, /clampHolidayName/,
        "a tooltip budget is not a log-line budget");
});

test("holiday requests never log a raw URL", () => {
    const code = source("holidays.js");
    assert.doesNotMatch(code, /global\.log\([^)]*\burl\b/);
});

test("applets surface weather provider failures", () => {
    const code = appletSource("6.0");
    const coordinators = source("6.0/appletCoordinators.js");
    const panelStatus = source("6.0/appletPanelStatus.js");
    assert.match(coordinators, /this\.error = "";/);
    assert.match(coordinators, /this\.providerName = "";/);
    assert.match(coordinators, /setStatus\(reading = null, error = "", providerName = "", pending = false\) \{[\s\S]*?this\.reading = reading \|\| null;[\s\S]*?this\.pending = pending;[\s\S]*?this\.error = error;[\s\S]*?this\.providerName = providerName \|\| "";/);
    assert.doesNotMatch(code, /_setWeatherStatus/,
        "weather completions bind directly to the coordinator");
    assert.match(panelStatus, /WeatherFormat\.WEATHER_ERROR_MARKER\);\n/);
    assert.match(panelStatus, /function markedWeatherError\(error\)/);
    assert.match(panelStatus, /return text \? WeatherFormat\.WEATHER_ERROR_MARKER \+ " " \+ text : "";/);
    assert.match(panelStatus, /_\("Set a weather location"\)/);
    // the tooltip is a clock table and nothing else: the provider credit that
    // used to sit under a blank line at its foot is gone from it, and lives in
    // the world-clock popup's accessible name
    assert.doesNotMatch(panelStatus, /_\("Source: %s"\)/);
    assert.match(coordinators, /this\.weatherProvider\.schedule\(this\._request\(\), this\.setStatus\.bind\(this\)\);/);
    assert.match(coordinators, /this\.weatherProvider\.queue\(this\._request\(\), this\.setStatus\.bind\(this\)\);/);
});

test("production applets require their initialized coordinators", () => {
    const code = appletSource("6.0");

    assert.doesNotMatch(code,
        /_weather_reading|_weather_pending|_weather_error|_weather_provider|_applied_show_events/);
    assert.doesNotMatch(code, /CoordinatorForCurrentState/);
    assert.match(code, /this\._weatherCoordinator = new AppletWeatherCoordinator/);
    assert.match(code, /this\._eventListCoordinator = new AppletEventListCoordinator/);
});

test("event fetch window uses the shared week-start offset", () => {
    const code = source("eventWindow.js");
    // raw week_day - week_start mixes ISO (1=Mon..7=Sun) with the 0=Sun
    // convention and started the window a week early for Sunday locales
    assert.doesNotMatch(code, /week_day - week_start/);
    assert.match(code, /DateMath\.monthWindowStartOffset\(\n?\s*day_one\.get_day_of_week\(\), Cinnamon\.util_get_week_start\(\)\)/);
});

test("event orchestration depends on extracted boundary collaborators", () => {
    const manager = source("eventsManager.js");
    const mutationStream = source("eventMutationStream.js");
    const fetchCoordinator = source("eventFetchCoordinator.js");
    const lifecycle = source("6.0/appletLifecycle.js");

    assert.doesNotMatch(manager, /class CalendarServerConnection|class EventIndex|class EventWindowCoordinator/);
    assert.match(manager, /params\.serverConnection/);
    assert.match(manager, /params\.eventIndex/);
    assert.match(manager, /params\.windowCoordinator/);
    assert.match(manager, /new EventMutationStream\(/);
    assert.match(manager, /new EventFetchCoordinator\(/);
    assert.doesNotMatch(manager,
        /this\._event_mutations\s*=|this\._fetch_retry_id\s*=|this\._gc_timer_id\s*=/,
    "the facade does not own either collaborator's mutable state");
    assert.doesNotMatch(manager,
        /get _event_mutations|get _fetch_retry_id|_apply_next_event_mutation\(|_start_gc_timer\(/,
    "the facade does not mirror collaborator state or operations for tests");
    assert.match(mutationStream, /class EventMutationStream/);
    assert.match(mutationStream, /MAX_QUEUED_EVENT_MUTATIONS/);
    assert.doesNotMatch(mutationStream, /setTimeRange|fetchMonthEvents/);
    assert.match(fetchCoordinator, /class EventFetchCoordinator/);
    assert.match(fetchCoordinator, /fetchMonthEvents/);
    assert.doesNotMatch(fetchCoordinator, /boundedEventVariants|decodeRemovedUids/);
    assert.match(lifecycle, /EventsManagerModule\.createEventsManager\(eventsSettings\)/);
});

test("translating files use the applet's own gettext domain", () => {
    for (const relativePath of [
        "6.0/appletMenuBuilder.js",
        "6.0/appletPanelStatus.js",
        "6.0/calendar.js",
        "6.0/eventView.js",
        "worldclockData.js"
    ]) {
        const code = source(relativePath);
        assert.match(code, /const _ = LocaleText\.translate/,
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
    const eventView = source("6.0/eventView.js");
    assert.match(eventView, /const ngettext = LocaleText\.translatePlural;/);
    assert.doesNotMatch(eventView, /function ngettext\(singular, plural, n\)/);
});

test("weather failures keep showing the stale reading with the marker", () => {
    const code = source("6.0/appletPanelStatus.js");
    assert.match(code, /parts\.push\(reading \?\n\s+WeatherFormat\.WEATHER_ERROR_MARKER \+ " " \+ reading :\n\s+WeatherFormat\.WEATHER_ERROR_MARKER\);/);
    // the tooltip row keeps the temperature in its own column and puts the marker
    // in the condition column, so a failed refresh loses neither. Both the
    // built-in and city rows render their reading record through _readingCells.
    assert.match(code, /error \|\| weatherConditionWords\(record\.condition\)/);
    assert.match(code, /return record \? this\._readingCells\(record, error\) : \["", error\];/);
});

test("bad custom formats fall back without breaking either display", () => {
    const code = source("6.0/appletPanelStatus.js");
    assert.doesNotMatch(code, /~CLOCK FORMAT ERROR~/);
    assert.match(code, /_\("Invalid time format; edit it in Settings"\)/);
    assert.match(code, /entry\.localTime\.format\(DEFAULT_DATE_TIME_FORMAT\) \|\| entry\.time/,
        "an invalid tooltip format stays inside the location row with a safe timestamp");
});

test("go-home button takes focus and activates from the keyboard", () => {
    const code = source("6.0/appletMenuBuilder.js");
    assert.match(code, /const button = new St\.BoxLayout\(\n\s+\{[\s\S]*?can_focus: true,/);
    assert.match(code, /button\.connect\("key-press-event",[\s\S]*?context\.onGoHome\(\);/);
});

test("stylesheet gives keyboard focus a visible marker on any theme", () => {
    const css = source("6.0/stylesheet.css");
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
    const launcher = source("6.0/calendarLauncher.js");
    assert.match(launcher, /class CalendarLauncher \{/);
    assert.match(launcher, /isAvailable\(\) \{[\s\S]*?GLib\.find_program_in_path\("gnome-calendar"\)/);
    assert.match(launcher, /launchDate\(gdate\) \{[\s\S]{0,250}?if \(!this\.isAvailable\(\)\) \{\n\s+return false;/);
    const code = source("6.0/eventView.js");
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
    const css = source("6.0/stylesheet.css");
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
    const css = source("6.0/stylesheet.css");
    const ST_PARSES = ["left", "right", "center", "justify"];

    const declarations = [...css.matchAll(/text-align\s*:\s*([a-z-]+)/g)];
    assert.ok(declarations.length > 0, "there is at least one to check");

    for (const [, value] of declarations) {
        assert.ok(ST_PARSES.includes(value),
            `text-align: ${value} is not one of ${ST_PARSES.join(" | ")} — St drops ` +
            "it, the theme's value wins, and nothing anywhere says so");
    }
});

test("text-bound popup sizes follow the desktop text scale", () => {
    const css = source("6.0/stylesheet.css");
    const selectors = [
        ".calendar-world-label",
        ".calendar-holiday-reason",
        ".calendar-issue-status",
        ".calendar-events-no-events-label"
    ];

    for (const selector of selectors) {
        const escaped = selector.replace(".", "\\.");
        const declarations = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
        assert.ok(declarations, `${selector} has a style rule`);
        assert.match(declarations[1], /max-width:\s*[0-9.]+em\s*;/,
            `${selector} grows with the user's text scale`);
        assert.doesNotMatch(declarations[1], /max-width:\s*[0-9.]+px\s*;/);
    }

    const icon = /\.calendar-events-no-events-icon\s*\{([^}]*)\}/.exec(css);
    assert.ok(icon, "the empty-state icon has a style rule");
    assert.match(icon[1], /icon-size:\s*[0-9.]+em\s*;/);
    assert.doesNotMatch(source("6.0/eventView.js"), /icon_size:\s*48\b/,
        "a fixed constructor size would override the text-relative style");
});
