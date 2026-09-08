const {
    assert, test, fs, path, makeRandom, makeSoup3, STAMP,
    loadHolidays, holiday, cachePath
} = require("./helpers/holidayFixture");
const root = path.join(__dirname, "..", "files", "chronos@geraldo-netto");
const { CalendarPluginLoader, selectedPluginIds, readInstalledPlugin } =
    require(path.join(root, "calendarPluginLoader"));
const { countrySelections, countryCalendarName, publicCalendar, religiousCalendar, manifestCalendar } =
    require(path.join(root, "calendarSourceAdapters"));
const { validateCalendarManifest } = require(path.join(root, "calendarPluginData"));
const { SUPPORTED_COUNTRIES } = require(path.join(root, "holidayConstants"));

function manifest(id = "custom:family", changes = {}) {
    return Object.assign({
        apiVersion: 1, id, name: "Family", category: "personal",
        source: { name: "Family notes" }, coverage: { from: 2025, through: 2027 },
        events: [{ name: "Family dinner", month: 12, day: 25 }]
    }, changes);
}

function monthMap(name, month = 12, day = 25, flags = []) {
    return new Map([[`${month}/${day}`, { name, flags }]]);
}

function baseProvider(country = "", name = "Public date") {
    return {
        country, destroyed: false,
        get active() { return Boolean(this.country); },
        clearPlace() { this.country = ""; },
        setPlace(nextCountry, region, onUpdated) {
            this.country = nextCountry;
            this.region = region;
            if (onUpdated) onUpdated();
        },
        getHolidays(year, month, callback) {
            callback(monthMap(name, month, 25, ["public_holiday"]), "", "Public service");
        },
        destroy() { this.destroyed = true; }
    };
}

function answerFor(provider, year = 2026, month = 12) {
    let answer;
    provider.getHolidays(year, month, (...values) => { answer = values; });
    return answer;
}

test("plugin selections reject paths and malformed values, deduplicate, and cap installed sources", () => {
    const valid = ["custom:family", "city.it:genoa", "city:plzen-holidays", "custom:family.json"];
    const invalid = [null, true, {}, 123, "../custom:family", "custom:../../passwd",
        "custom/family", "/tmp/calendar", "file:///calendar",
        "custom:bad\0", "Custom:family", "custom:" + "a".repeat(90),
        "custom:family\n", "custom:family\r", "custom:family\r\n", "custom:family\u2028",
        "custom:family\u2029"];
    assert.deepEqual(selectedPluginIds(valid.concat(invalid, valid)), valid);
    for (const value of [null, {}, false, "custom:family"]) {
        assert.deepEqual(selectedPluginIds(value), []);
    }
    const many = Array.from({ length: 80 }, (value, index) => `custom:calendar-${index}`);
    assert.deepEqual(selectedPluginIds(many), many.slice(0, 32));
});

test("fuzz: selection normalization only emits unique bounded path-safe identifiers", () => {
    const random = makeRandom(0x1dadea);
    const pieces = ["custom:family", "city:genoa", "..", "/", "\\", "\0", "x", "_", "a:b"];
    for (let round = 0; round < 250; round++) {
        const values = Array.from({ length: 40 }, () => pieces[Math.floor(random() * pieces.length)]);
        const selected = selectedPluginIds(values);
        assert.equal(selected.length, new Set(selected).size);
        assert.ok(selected.length <= 32);
        assert.ok(selected.every((id) => values.includes(id) && !/[/\\\0]/.test(id)));
    }
});

test("loader preserves selection order, settles once, and skips invalid or mismatched manifests", () => {
    const pending = new Map();
    const errors = [];
    const loader = new CalendarPluginLoader({
        read: (id, done) => pending.set(id, done), report: (error) => errors.push(error.message)
    });
    const answers = [];
    loader.load(["custom:first", "custom:second", "custom:first", "custom:bad", "custom:mismatch"],
        (values) => answers.push(values));
    assert.equal(pending.size, 4);
    pending.get("custom:second")(manifest("custom:second"));
    pending.get("custom:second")(manifest("custom:duplicate"));
    pending.get("custom:bad")({ apiVersion: 99 });
    pending.get("custom:mismatch")(manifest("custom:wrong"));
    assert.equal(answers.length, 0);
    pending.get("custom:first")(manifest("custom:first"));
    assert.deepEqual(answers.map((rows) => rows.map((row) => row.id)), [["custom:first", "custom:second"]]);
    assert.equal(errors.length, 2);
    assert.ok(errors.some((message) => message.includes("filename and id differ")));
    assert.ok(Object.isFrozen(answers[0][0]));
});

test("loader isolates throwing reads and reports through its default logger", () => {
    const messages = [];
    global.logError = (error) => messages.push(error.message);
    const loader = new CalendarPluginLoader({ read(id, done) {
        if (id === "custom:broken") throw new Error("Could not open calendar");
        done(manifest(id));
    } });
    let answer;
    loader.load(["custom:broken", "custom:good"], (values) => { answer = values; });
    assert.deepEqual(answer.map((value) => value.id), ["custom:good"]);
    assert.ok(messages.includes("Could not open calendar"));
    global.logError = undefined;
    assert.doesNotThrow(() => loader.load(["custom:broken"], () => {}));
});

test("a failing injected logger cannot interrupt invalid-plugin settlement or healthy reads", () => {
    for (const throwsOnRead of [false, true]) {
        const loader = new CalendarPluginLoader({
            read(id, done) {
                if (id === "custom:broken") {
                    if (throwsOnRead) throw new Error("Read failed");
                    done(null);
                    return;
                }
                done(manifest(id));
            },
            report() { throw new Error("Logger failed"); }
        });
        const delivered = [];
        assert.doesNotThrow(() => loader.load(["custom:broken", "custom:healthy"],
            (rows) => delivered.push(rows.map((row) => row.id))));
        assert.deepEqual(delivered, [["custom:healthy"]]);
    }
});

test("loader ignores superseded selections and callbacks after destruction", () => {
    const callbacks = [];
    const loader = new CalendarPluginLoader({ read: (id, done) => callbacks.push(done) });
    loader.load(["custom:first"], () => assert.fail("superseded selection delivered"));
    let latest;
    loader.load(["custom:second"], (rows) => { latest = rows; });
    callbacks[0](manifest("custom:first"));
    callbacks[1](manifest("custom:second"));
    assert.equal(latest[0].id, "custom:second");
    loader.load(["custom:last"], () => assert.fail("destroyed selection delivered"));
    loader.destroy();
    callbacks[2](manifest("custom:last"));
    loader.load([], () => assert.fail("destroyed loader called back"));
    assert.equal(callbacks.length, 3);
    const empty = new CalendarPluginLoader({ read() { assert.fail("empty selection read a file"); } });
    empty.load(null, (rows) => assert.deepEqual(rows, []));
});

test("loader propagates consumer exceptions without diagnosing them as read failures", () => {
    const reported = [];
    const loader = new CalendarPluginLoader({
        read: (id, done) => done(manifest(id)), report: (error) => reported.push(error)
    });
    assert.throws(() => loader.load(["custom:family"], () => {
        throw new Error("Consumer failed");
    }), /Consumer failed/);
    assert.deepEqual(reported, []);
});

function failAt(options, phase) {
    if (options.fail === phase) throw new Error(`Injected ${phase} failure`);
}

function streamFixture(bytes, options, state) {
    let offset = 0;
    let requested = 0;
    return {
        read_bytes_async(count, priority, cancellable, done) {
            failAt(options, "read-start");
            requested = count;
            state.reads.push(count);
            done(this, {});
        },
        read_bytes_finish() {
            failAt(options, "read-finish");
            const chunk = bytes.subarray(offset, offset + requested);
            offset += chunk.length;
            state.delivered += chunk.length;
            return { get_data: () => chunk };
        },
        close_async(priority, cancellable, done) {
            state.closed++;
            failAt(options, "close-start");
            done(this, {});
        },
        close_finish() { failAt(options, "close-finish"); return true; }
    };
}

function filesystemFile(filePath, options, state) {
    return {
        query_info_async(attributes, flags, priority, cancellable, done) {
            failAt(options, "query-start");
            state.queries.push({ filePath, flags });
            done(this, {});
        },
        query_info_finish() {
            failAt(options, "query-finish");
            const info = fs.lstatSync(filePath);
            const size = options.declaredSize === undefined ? info.size : options.declaredSize;
            return {
                get_size: () => size,
                get_is_symlink: () => info.isSymbolicLink(),
                get_file_type: () => info.isDirectory() ? 2 : Number(info.isFile())
            };
        },
        read_async(priority, cancellable, done) {
            failAt(options, "open-start");
            state.opened.push(filePath);
            done(this, {});
        },
        read_finish() {
            failAt(options, "open-finish");
            return streamFixture(options.bytes || fs.readFileSync(filePath), options, state);
        }
    };
}

function installedFixture(options = {}) {
    loadHolidays();
    const { Gio, GLib } = global.imports.gi;
    GLib.get_user_data_dir = GLib.get_user_cache_dir;
    GLib.path_is_absolute = path.isAbsolute;
    GLib.get_home_dir = GLib.get_user_cache_dir;
    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS = 1;
    Gio.FileType = { REGULAR: 1, DIRECTORY: 2 };
    const state = { queries: [], opened: [], reads: [], closed: 0, delivered: 0 };
    Gio.file_new_for_path = (filePath) => filesystemFile(filePath, options, state);
    const directory = cachePath("calendars");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "custom:family.json");
    fs.writeFileSync(file, JSON.stringify(manifest()));
    return { directory, file, state };
}

test("the default loader reads a real installed manifest through bounded asynchronous Gio operations", () => {
    const { file, state } = installedFixture();
    let answer;
    new CalendarPluginLoader().load(["custom:family"], (rows) => { answer = rows; });
    assert.equal(answer[0].id, "custom:family");
    assert.deepEqual(state.opened, [file]);
    assert.equal(state.queries.length, 2);
    assert.ok(state.queries.every((query) => query.flags === 1));
    assert.ok(state.reads.every((size) => size <= 65536));
    assert.equal(state.closed, 1);
    assert.equal(state.delivered, fs.statSync(file).size);
});

test("runtime loader rejects symlinked manifests and calendar directories before opening", () => {
    const { file, directory, state } = installedFixture();
    const target = file + ".target";
    fs.renameSync(file, target);
    fs.symlinkSync(target, file);
    let answer;
    new CalendarPluginLoader().load(["custom:family"], (rows) => { answer = rows; });
    assert.deepEqual(answer, []);
    assert.equal(state.opened.length, 0);
    fs.unlinkSync(file);
    fs.renameSync(target, file);
    const movedDirectory = directory + "-target";
    fs.renameSync(directory, movedDirectory);
    fs.symlinkSync(movedDirectory, directory);
    new CalendarPluginLoader().load(["custom:family"], (rows) => { answer = rows; });
    assert.deepEqual(answer, []);
    assert.equal(state.opened.length, 0);
});

test("a relative runtime data directory falls back to the user's absolute data home", () => {
    const { file, state } = installedFixture();
    const { GLib } = global.imports.gi;
    const expectedDirectory = path.join(GLib.get_home_dir(), ".local/share/chronos@geraldo-netto/calendars");
    fs.mkdirSync(expectedDirectory, { recursive: true });
    const expectedFile = path.join(expectedDirectory, "custom:family.json");
    fs.copyFileSync(file, expectedFile);
    GLib.get_user_data_dir = () => "relative";
    let loaded;
    new CalendarPluginLoader().load(["custom:family"], rows => { loaded = rows; });
    assert.deepEqual(loaded.map(row => row.id), ["custom:family"]);
    assert.deepEqual(state.opened, [expectedFile]);
});

test("runtime loader rejects nonregular entries, missing files, invalid UTF-8 and corrupt JSON", () => {
    const { file, state } = installedFixture();
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    let answer;
    const read = () => new CalendarPluginLoader().load(["custom:family"], (rows) => { answer = rows; });
    read();
    assert.deepEqual(answer, []);
    assert.equal(state.opened.length, 0);
    fs.rmdirSync(file);
    read();
    assert.deepEqual(answer, []);
    for (const contents of [Buffer.from([0xff]), Buffer.from("{incomplete"),
        Buffer.from("\ufeff" + JSON.stringify(manifest()))]) {
        fs.writeFileSync(file, contents);
        read();
        assert.deepEqual(answer, []);
    }
    assert.equal(state.closed, 3);
});

test("runtime loader accepts exactly 1 MiB and refuses oversized files before reading", () => {
    const { file, state } = installedFixture();
    const content = JSON.stringify(manifest());
    const padded = content + " ".repeat(1024 * 1024 - Buffer.byteLength(content));
    fs.writeFileSync(file, padded);
    let answer;
    new CalendarPluginLoader().load(["custom:family"], (rows) => { answer = rows; });
    assert.equal(answer.length, 1);
    assert.equal(state.delivered, 1024 * 1024);
    fs.appendFileSync(file, " ");
    new CalendarPluginLoader().load(["custom:family"], (rows) => { answer = rows; });
    assert.deepEqual(answer, []);
    assert.equal(state.opened.length, 1);
    assert.equal(state.closed, 1);
});

test("runtime loader stops at cap plus one if a file grows after the size check", () => {
    const { state } = installedFixture({ declaredSize: 10, bytes: Buffer.alloc(2 * 1024 * 1024, 32) });
    let answer;
    new CalendarPluginLoader().load(["custom:family"], (rows) => { answer = rows; });
    assert.deepEqual(answer, []);
    assert.equal(state.delivered, 1024 * 1024 + 1);
    assert.equal(state.closed, 1);
});

test("runtime loader settles filesystem failures and always attempts to close acquired streams", () => {
    for (const phase of ["query-start", "query-finish", "open-start", "open-finish", "read-start", "read-finish",
        "close-start", "close-finish"]) {
        const { state } = installedFixture({ fail: phase });
        let answer;
        new CalendarPluginLoader().load(["custom:family"], (rows) => { answer = rows; });
        assert.equal(answer.length, phase.startsWith("close") ? 1 : 0, phase);
        assert.equal(state.closed, /^(read|close)/.test(phase) ? 1 : 0, phase);
    }
});

test("a failing Cinnamon logger cannot prevent acquired plugin streams from closing", () => {
    const { state } = installedFixture({ fail: "read-finish" });
    global.logError = () => { throw new Error("Cinnamon logger unavailable"); };
    const answers = [];
    assert.doesNotThrow(() => new CalendarPluginLoader().load(["custom:family"],
        (rows) => answers.push(rows)));
    assert.deepEqual(answers, [[]]);
    assert.equal(state.closed, 1);
});

test("default file reader rejects a path-like ID and preserves callback exceptions", () => {
    const { state } = installedFixture();
    readInstalledPlugin("../outside", (raw) => assert.equal(raw, null));
    assert.equal(state.queries.length, 0);
    assert.throws(() => readInstalledPlugin("custom:family", () => {
        throw new Error("Consumer failed after read");
    }), /Consumer failed after read/);
    assert.equal(state.closed, 1);
});

test("country selection validates regions, normalizes omissions, deduplicates and applies source limits", () => {
    const rows = [null, false, { country: "ita" }, { country: "ita", region: " " },
        { country: "cze", region: 4 }, { country: "usa", region: " CA " },
        { country: "usa", region: "ca" }, { country: "usa", region: "__proto__" },
        { country: "ita", region: "unknown" }, { country: "xx" },
        { country: "fra", enabled: false }];
    assert.deepEqual(countrySelections(rows), [
        { country: "ita", region: "global" },
        { country: "usa", region: "ca" }
    ]);
    assert.deepEqual(countrySelections(null), []);
    assert.equal(countrySelections(SUPPORTED_COUNTRIES.map((country) => ({ country }))).length, 16);
    assert.deepEqual(countrySelections(Array(64).fill(null).concat({ country: "ita" })), []);
    assert.equal(countryCalendarName("ita", "global"), "Italy");
    assert.equal(countryCalendarName("usa", "ca"), "United States / CA");
});

test("country selections follow the shared strict settings fixtures", () => {
    const cases = require("./fixtures/country_selection_cases.json");
    for (const item of cases) {
        assert.deepEqual(countrySelections(item.input), item.enabled, item.name);
        assert.deepEqual(countrySelections(item.normalized), item.enabled, item.name);
    }
});

test("source adapters preserve their provider identity, recurrence coverage and publicness", () => {
    const base = baseProvider("ita", "Public date");
    const country = publicCalendar("country:ita", base);
    assert.equal(country.name, "Public holidays");
    assert.equal(country.enabled, true);
    assert.equal(country.available(2026), true);
    assert.deepEqual(answerFor(country)[0], monthMap("Public date", 12, 25, ["public_holiday"]));
    base.clearPlace();
    assert.equal(country.enabled, false);
    country.destroy();
    assert.equal(base.destroyed, true);
    const religious = religiousCalendar("christianity", (text) => text);
    assert.equal(religious.available(2026), true);
    assert.ok(answerFor(religious)[0].get("12/25").flags.includes("religious_holiday"));
    const local = manifestCalendar(validateCalendarManifest(manifest()));
    assert.equal(local.id, "plugin:custom:family");
    assert.equal(local.available(2028), false);
    assert.deepEqual(answerFor(local)[0], monthMap("Family dinner (Family)", 12, 25, ["calendar_observance"]));
});

test("country adapters preserve translated optional, bank, public and partial classifications", () => {
    const { NagerDateServiceAdapter, EnricoServiceAdapter, HolidayRecordContract } = loadHolidays();
    const nager = new NagerDateServiceAdapter();
    const rows = nager.translateResponse([
        { date: "2026-12-23", name: "Optional bank day", global: true, types: ["Optional", "Bank"] },
        { date: "2026-12-25", name: "Public day", global: true, types: ["Public"] }
    ], nager.params("ita", "global", 2026));
    rows.push(...new EnricoServiceAdapter().translateResponse([
        holiday("Partial day", 2026, 12, 24, ["PART_DAY_HOLIDAY"])
    ]));
    const record = new HolidayRecordContract();
    const map = new Map(rows.map((row) => {
        const [day] = record.expandHoliday(row, "global");
        return [`12/${day.day}`, { name: day.name, flags: day.flags }];
    }));
    const base = baseProvider("ita");
    base.getHolidays = (year, month, done) => done(map, "", "Country source");
    const provider = publicCalendar("country:ita", base, "Italy");
    const result = answerFor(provider)[0];
    assert.deepEqual(result.get("12/23").flags, ["optional", "bank"]);
    assert.deepEqual(result.get("12/24").flags, ["public_holiday", "PART_DAY_HOLIDAY"]);
    assert.deepEqual(result.get("12/25").flags, ["public_holiday"]);
    assert.equal(result.get("12/23").name, "Optional bank day (Italy)");
    assert.deepEqual(map.get("12/23").flags, ["optional", "bank"]);
});

test("the composed provider combines a primary country, several countries, religion and a local calendar", () => {
    const { ReligiousHolidayProvider } = loadHolidays();
    const created = [];
    const base = baseProvider("ita", "Primary date");
    const provider = new ReligiousHolidayProvider(base, ["christianity"], (text) => text, {
        createCountry(country) {
            const extra = baseProvider("", `${country} date`);
            created.push(extra);
            return extra;
        },
        pluginLoader: new CalendarPluginLoader({ read: (id, done) => done(manifest(id)) })
    });
    provider.setCountries([{ country: "ita" }, { country: "cze" }, { country: "usa", region: "ma" }]);
    provider.setPluginIds(["custom:family"]);
    assert.deepEqual(created.map((source) => source.country), ["cze", "usa"]);
    const [map, error, source] = answerFor(provider, "2026", "12");
    assert.deepEqual(map.get("12/25"), {
        name: "Primary date\ncze date (Czechia)\nusa date (United States / MA)\nChristmas Day (Christianity)\nFamily dinner (Family)",
        flags: ["calendar_observance", "public_holiday", "religious_holiday"]
    });
    assert.equal(error, "");
    assert.equal(source, "Public service");
    assert.ok(!answerFor(provider, 2028)[0].get("12/25").name.includes("Family dinner"));
    provider.destroy();
    assert.equal(base.destroyed, true);
    assert.ok(created.every((sourceProvider) => sourceProvider.destroyed));
});

test("country and plugin selection changes remove old sources and preserve main-calendar operation", () => {
    const { ReligiousHolidayProvider } = loadHolidays();
    const created = [];
    const provider = new ReligiousHolidayProvider(baseProvider("ita"), [], undefined, {
        createCountry() { const extra = baseProvider(); created.push(extra); return extra; },
        pluginLoader: new CalendarPluginLoader({ read: (id, done) => done(manifest(id)) })
    });
    provider.setCountries([{ country: "ita" }, { country: "cze" }]);
    provider.clearPlace();
    assert.equal(provider.country, "");
    assert.equal(provider.active, true);
    assert.equal(created[0].destroyed, true);
    assert.match(answerFor(provider)[0].get("12/25").name, /Italy/);
    provider.setPlace("cze", "global");
    assert.match(answerFor(provider)[0].get("12/25").name, /Italy/);
    provider.setPluginIds(["custom:family"]);
    assert.match(answerFor(provider)[0].get("12/25").name, /Family dinner/);
    provider.setPluginIds([]);
    assert.doesNotMatch(answerFor(provider)[0].get("12/25").name, /Family dinner/);
    provider.setCountries([]);
    assert.deepEqual(answerFor(provider)[0], monthMap("Public date", 12, 25, ["public_holiday"]));
    provider.destroy();
    assert.doesNotThrow(() => provider.setEnabledIds(["christianity"]));
    provider.setCountries([{ country: "usa" }]);
    provider.setPluginIds(["custom:family"]);
    assert.equal(provider.active, false);
});

test("country settings publish one update after every synchronous source joins the registry", () => {
    const { ReligiousHolidayProvider } = loadHolidays();
    const provider = new ReligiousHolidayProvider(baseProvider("ita", "Primary date"), [], undefined, {
        createCountry: (country) => baseProvider("", `${country} date`)
    });
    const updates = [];
    provider.setCountries([{ country: "cze" }, { country: "usa" }], () =>
        updates.push(answerFor(provider)[0].get("12/25").name));
    assert.deepEqual(updates, ["Primary date\ncze date (Czechia)\nusa date (United States)"]);
    provider.setCountries([], () => updates.push(answerFor(provider)[0].get("12/25").name));
    assert.deepEqual(updates, ["Primary date\ncze date (Czechia)\nusa date (United States)", "Primary date"]);
    provider.destroy();
});

test("reapplying calendar settings preserves same-date order and truncation", () => {
    const { ReligiousHolidayProvider } = loadHolidays();
    const provider = new ReligiousHolidayProvider(baseProvider("ita", "Primary date"), ["christianity"],
        (text) => text, {
            createCountry: (country) => baseProvider("", `${country} date`),
            pluginLoader: new CalendarPluginLoader({ read: (id, done) => done(manifest(id, {
                name: id + "N".repeat(75),
                events: [{ name: "A".repeat(160), month: 12, day: 25 }]
            })) })
        });
    const countries = [{ country: "cze" }, { country: "usa" }];
    provider.setCountries(countries);
    provider.setPluginIds(["custom:second", "custom:first"]);
    const expected = answerFor(provider)[0];
    assert.equal(expected.get("12/25").name.length, 300);
    const repeat = [
        () => provider.setEnabledIds(["christianity"]),
        () => provider.setCountries(countries),
        () => provider.setPlace("ita", "global"),
        () => provider.setPluginIds(["custom:first", "custom:second"])
    ];
    for (const update of repeat) {
        update();
        assert.deepEqual(answerFor(provider)[0], expected);
    }
    provider.destroy();
});

test("changing the primary country publishes the completed deduplicated registry exactly once", () => {
    const { ReligiousHolidayProvider } = loadHolidays();
    const provider = new ReligiousHolidayProvider(baseProvider("ita", "Primary date"), [], undefined, {
        createCountry: (country) => baseProvider("", `${country} date`)
    });
    provider.setCountries([{ country: "ita" }, { country: "cze" }, { country: "usa" }]);
    const updates = [];
    provider.setPlace("cze", "global", () => updates.push(answerFor(provider)[0].get("12/25").name));
    assert.deepEqual(updates, ["Primary date\nita date (Italy)\nusa date (United States)"]);
    provider.destroy();
});

function updatingProvider(country, updates) {
    const provider = baseProvider(country);
    provider.setPlace = (nextCountry, region, onUpdated) => {
        provider.country = nextCountry;
        updates.push(onUpdated);
        onUpdated();
    };
    return provider;
}

test("later country callbacks survive publication and stop after replacement or teardown", () => {
    const { ReligiousHolidayProvider } = loadHolidays();
    const baseUpdates = [];
    const countryUpdates = [];
    const provider = new ReligiousHolidayProvider(updatingProvider("ita", baseUpdates), [], undefined, {
        createCountry: () => updatingProvider("", countryUpdates)
    });
    const delivered = [];
    provider.setCountries([{ country: "cze" }], () => delivered.push("countries"));
    assert.deepEqual(delivered, ["countries"]);
    countryUpdates[0]();
    assert.deepEqual(delivered, ["countries", "countries"]);
    provider.setPlace("ita", "global", () => delivered.push("place"));
    countryUpdates[0]();
    baseUpdates[0]();
    countryUpdates[1]();
    assert.deepEqual(delivered, ["countries", "countries", "place", "place", "place"]);
    provider.setCountries([], () => delivered.push("empty"));
    countryUpdates[1]();
    baseUpdates[0]();
    assert.deepEqual(delivered.slice(-2), ["empty", "place"]);
    provider.clearPlace();
    baseUpdates[0]();
    provider.setPlace("ita", "global", () => delivered.push("last"));
    baseUpdates[0]();
    provider.destroy();
    baseUpdates[1]();
    countryUpdates.forEach((notify) => notify());
    provider.setPlace("cze", "global", () => assert.fail("destroyed provider updated"));
    provider.clearPlace();
    assert.equal(baseUpdates.length, 2);
    assert.equal(delivered.at(-1), "last");
    assert.equal(delivered.filter((label) => label === "last").length, 1);
});

test("default country factories use isolated persistent caches and the injected transport", () => {
    const soup = makeSoup3();
    const { createHolidayProvider } = loadHolidays({ soup });
    const requested = [];
    const provider = createHolidayProvider({ lang: "en", load(url, params, done) {
        requested.push({ url, params });
        done([holiday(`${params.country} date`, Number(params.year), 12, 25)], params, STAMP);
    } });
    provider.setPlace("ita", "global");
    provider.setCountries([{ country: "cze" }, { country: "usa", region: "ma" }]);
    const [map, error] = answerFor(provider);
    assert.equal(error, "");
    assert.equal(map.get("12/25").name,
        "ita date\ncze date (Czechia)\nusa date (United States / MA)");
    assert.deepEqual(new Set(requested.map((request) => request.params.country)), new Set(["ita", "cze", "usa"]));
    assert.ok(requested.every((request) => request.url.startsWith("https://kayaposoft.com/enrico/")));
    const caches = ["holidays.json", "calendar-cze-global.json", "calendar-usa-ma.json"];
    for (const name of caches) assert.ok(fs.existsSync(cachePath(name)), name);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cachePath(caches[1]), "utf8"))), ["cze"]);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cachePath(caches[2]), "utf8"))), ["usa"]);
    assert.equal(soup.sessions.length, 0, "an injected transport does not acquire HTTP sessions");
    provider.destroy();
});
