const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");
const { makeSoup3 } = require("./helpers/soup");

// A real Date response header. The cache refuses a stamp it cannot parse — and
// one planted in the future — so a placeholder like "today" is not a stand-in
// for a header: it is exactly the input that has to be rejected.
const STAMP = "Fri, 10 Jul 2026 10:00:00 GMT";

// loadAsync is the only loader: the synchronous load() it replaced had no
// production caller left. The file doubles answer immediately, so the callback
// has already run by the time this returns.
function loadCountry(repository, country) {
    let loaded = null;
    repository.loadAsync(country, (data) => {
        loaded = data;
    });
    return loaded;
}

// distinct, and parseable: which provider answered is told apart by the stamp,
// and an unparseable one is refused by the cache — which is the point of T320
const NAGER_STAMP = "Thu, 09 Jul 2026 08:00:00 GMT";
const OPENHOLIDAYS_STAMP = "Wed, 08 Jul 2026 08:00:00 GMT";

const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "holidays.js");
const utilsPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "utils.js");
const ioUtilsPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "ioUtils.js");
const localeUtilsPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "localeUtils.js");
const holidayCachePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "holidayCache.js");
const holidayConstantsPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "holidayConstants.js");
const holidayServiceAdaptersPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "holidayServiceAdapters.js");
const shimPath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "5.4", "holidays.js");

let originalImports;
let originalLog;
let originalLogError;
let tmpDir;

function makeFile(filePath) {
    return {
        query_exists() {
            return fs.existsSync(filePath);
        },
        get_path() {
            return filePath;
        },
        replace() {
            return {
                write(data) {
                    fs.writeFileSync(filePath, data, "utf8");
                },
                close() {}
            };
        },
        // Gio's async read, as used by readJsonFileAsync: the applet must not
        // read the cache synchronously on the compositor thread
        load_contents_async(_cancellable, callback) {
            callback(this, { ok: true });
        },
        load_contents_finish() {
            return [true, fs.readFileSync(filePath)];
        },
        // Gio's async write, as used by writeJsonFileAsync
        replace_contents_async(bytes, _etag, _backup, _flags, _cancellable, callback) {
            fs.writeFileSync(filePath, Buffer.from(bytes));
            callback(this, { ok: true });
        },
        replace_contents_finish(result) {
            return result.ok;
        }
    };
}

// the HTTP loader is per provider instance now; tests drive it with a session
// built from whichever Soup double the module was loaded with
function loadJson(Holidays) {
    const session = new global.imports.gi.Soup.Session();
    return Holidays.Provider.loaderFor(() => session);
}

function cachePath(...parts) {
    return path.join(tmpDir, "chronos@geraldo-netto", ...parts);
}

function loadHolidays(options = {}) {
    delete require.cache[require.resolve(modulePath)];
    delete require.cache[require.resolve(utilsPath)];
    delete require.cache[require.resolve(ioUtilsPath)];
    delete require.cache[require.resolve(localeUtilsPath)];
    delete require.cache[require.resolve(holidayCachePath)];
    delete require.cache[require.resolve(holidayConstantsPath)];
    delete require.cache[require.resolve(holidayServiceAdaptersPath)];

    const soup = options.soup || makeSoup3();

    global.imports = {
        byteArray: {
            toString(data) {
                return data.toString();
            }
        },
        ui: {
            appletManager: {
                appletMeta: {
                    "chronos@geraldo-netto": { path: tmpDir }
                }
            }
        },
        gi: {
            Cinnamon: {
                get_file_contents_utf8_sync(filePath) {
                    return fs.readFileSync(filePath, "utf8");
                },
                write_string_to_stream(stream, data) {
                    stream.write(data);
                }
            },
            CinnamonDesktop: {
                WallClock: {
                    lctime_format(_domain, format) {
                        return format;
                    }
                }
            },
            Gio: {
                FileCreateFlags: { NONE: 0 },
                file_new_for_path(filePath) {
                    return makeFile(filePath);
                },
                BufferedOutputStream: {
                    new_sized(raw) {
                        return raw;
                    }
                }
            },
            GLib: {
                PRIORITY_DEFAULT: 0,
                timeout_add_seconds: () => 1,
                build_filenamev(parts) {
                    return path.join(...parts);
                },
                get_user_cache_dir() {
                    return tmpDir;
                },
                mkdir_with_parents(dir) {
                    fs.mkdirSync(dir, { recursive: true });
                    return 0;
                },
                spawn_command_line_sync(command) {
                    if (command.endsWith("LC_ADDRESS")) {
                        return [false, Buffer.from('lang_ab="en"\ncountry_ab3="usa"\n'), Buffer.alloc(0), 0];
                    }

                    return [false, Buffer.from(""), Buffer.alloc(0), 0];
                }
            },
            Soup: soup
        }
    };

    return require(modulePath);
}

function holiday(name, year, month, day, flags = ["public_holiday"]) {
    return {
        date: { year, month, day },
        name: [{ lang: "en", text: name }],
        flags
    };
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-holidays-"));
    originalImports = global.imports;
    originalLog = global.log;
    originalLogError = global.logError;
    global.log = function() {};
    global.logError = function() {};
});

afterEach(() => {
    global.imports = originalImports;
    global.log = originalLog;
    global.logError = originalLogError;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("retrieveForYear without a country reports instead of throwing", () => {
    const Holidays = loadHolidays();
    const enrico = new Holidays.Enrico({ fetchYear() { throw new Error("no fetch expected"); } }, {
        years: {}, country: null, region: "global", data: [],
        recordAttempt() {}, setData() {}
    });

    let called = 0;
    assert.doesNotThrow(() => enrico.retrieveForYear(2026, () => called++));
    assert.equal(called, 1, "callback still fires so the UI can settle");
    assert.equal(enrico.last_error, Holidays.HOLIDAY_ERRORS.SERVICE_UNAVAILABLE);
});

test("clearPlace disables the provider and resets status", () => {
    const { Enrico } = loadHolidays();
    const cache = {
        years: {}, country: "ita", region: "global", data: [],
        recordAttempt() {}, setPlace() {}, setData() {},
        clearPlace() { this.country = null; }
    };
    const enrico = new Enrico({ fetchYear() {} }, cache);
    enrico.last_error = "boom";
    enrico.clearPlace();
    assert.equal(enrico.country, null);
    assert.equal(enrico.last_error, "");
    assert.equal(enrico.last_provider, "");
});

test("HolidayCache owns fetched holiday persistence and place clearing", () => {
    const { HolidayCache } = loadHolidays();
    let saved = null;
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), (_country, data) => {
        saved = data;
    });
    cache.setPlace("ita", "global");

    const stamp = new Date(Date.now() - 60000).toUTCString();
    cache.recordFetch(2026, "global", stamp, [
        { year: 2026, month: 1, day: 1, region: "global", name: "New Year", flags: [] }
    ]);

    assert.equal(cache.years[2026].global, stamp);
    assert.deepEqual(cache.matchMonth(2026, 1).get("1/1"), ["New Year", []]);
    // recording is not writing: the cache no longer reaches for the disk from
    // inside its own record method, so nothing has been saved yet
    assert.equal(saved, null);

    cache.persist();
    assert.equal(saved.holidays.length, 1);

    cache.clearPlace();
    assert.equal(cache.country, null);
});

// T76 regression: a response with no Date header must still mark the
// year fresh, otherwise it refetches every RETRY_PERIOD forever
test("HolidayCache falls back to receive time when the Date header is missing", () => {
    const { HolidayCache, UPDATE_PERIOD } = loadHolidays();
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    cache.setPlace("ita", "global");

    const received = "Thu, 09 Jul 2026 10:00:00 GMT";
    const receivedMs = new Date(received).getTime();
    cache.recordFetch(2026, "global", null, [
        { year: 2026, month: 1, day: 1, region: "global", name: "New Year", flags: [] }
    ], received);

    assert.equal(cache.years[2026].global, received);
    assert.equal(cache.stale(2026, "global", receivedMs + 1000), false,
        "fresh right after the header-less fetch");
    assert.equal(cache.stale(2026, "global", receivedMs + UPDATE_PERIOD + 1000), true,
        "still expires on the normal schedule");

    // an explicit header keeps winning over the fallback
    const header = "Fri, 10 Jul 2026 10:00:00 GMT";
    cache.recordFetch(2026, "global", header, [], received);
    assert.equal(cache.years[2026].global, header);

    // ...but only a *usable* one. validCachedStamp rejects a stamp planted in
    // the future — stale() only asks whether now - retrieved is inside
    // UPDATE_PERIOD, so a provider answering "Date: … 2050" would pin the year
    // as fresh for the rest of the session — and it rejects an unparseable one.
    // Both fall back to the receive time, which is the safe direction.
    for (const hostile of ["Sat, 01 Jan 2050 00:00:00 GMT", "not a date", 42, null]) {
        cache.recordFetch(2026, "global", hostile, [], received);
        assert.equal(cache.years[2026].global, received, String(hostile));
    }
});

// T77 regression: a fetch that lands after clearPlace() must not write
// the payload under a "null" country key in the cache file
test("an inflight fetch landing after clearPlace does not persist", () => {
    const { Enrico } = loadHolidays();
    let fetchCallback = null;
    const service = {
        fetchYear: (_country, _region, _year, callback) => { fetchCallback = callback; },
        validResponse: () => true,
        expandHoliday: (holiday) => [holiday]
    };
    const enrico = new Enrico(service);
    const saves = [];
    enrico.cache._save = (country, data) => saves.push([country, data]);

    enrico.country = "ita";
    enrico.retrieveForYear(2026, () => {});
    enrico.clearPlace();
    fetchCallback([{ year: 2026, month: 1, day: 1, name: [{ lang: "en", text: "x" }], flags: [] }],
        { year: 2026, region: "global", providerName: "Enrico" }, STAMP);

    assert.deepEqual(saves, [], "no write under a cleared place");

    // with a country set again, persisting works as before
    enrico.country = "ita";
    enrico.cache.persist();
    assert.equal(saves.length, 1);
    assert.equal(saves[0][0], "ita");
});

test("Enrico expands provider rows before recording cache fetches", () => {
    const { Enrico } = loadHolidays();
    const recorded = [];
    const service = {
        expandHoliday(holidayRow, region) {
            return [{ year: 2026, month: 1, day: 1, region, name: holidayRow.name, flags: [] }];
        },
        validResponse(data) {
            return Array.isArray(data);
        },
        fetchYear() {}
    };
    const cache = {
        years: {},
        country: "ita",
        region: "global",
        data: [],
        added: [],
        recordAttempt() {},
        stale: () => false,
        addUnique(single) {
            this.added.push(single);
        },
        recordFetch(year, region, retrieved, holidays) {
            recorded.push({ year, region, retrieved, holidays });
        },
        prune() { this.pruned = true; },
        persist() { this.persisted = true; },
        clearPlace() {
            this.country = null;
        }
    };
    const enrico = new Enrico(service, cache);

    assert.deepEqual(enrico.expandData([{ name: "Fetched" }]), [
        { year: 2026, month: 1, day: 1, region: "global", name: "Fetched", flags: [] }
    ]);

    enrico.addData([{ name: "Fetched" }], { year: 2026, region: "global" }, STAMP);
    assert.equal(recorded[0].year, 2026);
    assert.deepEqual(recorded[0].holidays[0], {
        year: 2026, month: 1, day: 1, region: "global", name: "Fetched", flags: []
    });
    // the provider owns the fetch, so the provider is what decides the result is
    // worth writing; the cache used to do this from inside recordFetch, i.e. a
    // disk write from inside a data structure
    assert.equal(cache.persisted, true);

    enrico.clearPlace();
    assert.equal(enrico.country, null);
});

// a payload that fails validation is not a fetch result: nothing is recorded and
// nothing reaches the disk
test("a rejected response is neither recorded nor written", () => {
    const { Enrico } = loadHolidays();
    const cache = {
        country: "ita", region: "global", years: {}, data: [],
        recordAttempt() {}, setPlace() {}, setData() {}, clearPlace() {},
        recordFetch() { this.recorded = true; },
        prune() { this.pruned = true; },
        persist() { this.persisted = true; }
    };
    const enrico = new Enrico({
        fetchYear() {},
        validResponse: () => false,
        expandHoliday: (holiday) => [holiday]
    }, cache);

    enrico.addData([{ junk: true }], { year: 2026, region: "global" }, STAMP);

    assert.equal(cache.recorded, undefined);
    assert.equal(cache.persisted, undefined, "a rejected payload must not reach the cache file");
    assert.ok(enrico.last_error);
});

test("cache staleness is deterministic under an injected clock", () => {
    const { HolidayCache } = loadHolidays();
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    cache.country = "ita";

    const fixedNow = new Date("2026-07-09T12:00:00Z").getTime();
    const DAY_MS = 24 * 3600 * 1000;

    cache.years = { 2026: { global: new Date(fixedNow - 10 * DAY_MS).toUTCString() } };
    assert.equal(cache.stale(2026, "global", fixedNow), false, "fresh within 50 days");

    cache.years = { 2026: { global: new Date(fixedNow - 60 * DAY_MS).toUTCString() } };
    assert.equal(cache.stale(2026, "global", fixedNow), true, "past the update period");

    // a recent failed attempt suppresses retries for an hour
    cache.attempts = { 2026: { global: new Date(fixedNow - 30 * 60 * 1000).toUTCString() } };
    assert.equal(cache.stale(2026, "global", fixedNow), false, "retry backoff holds");
    cache.attempts = { 2026: { global: new Date(fixedNow - 2 * 3600 * 1000).toUTCString() } };
    assert.equal(cache.stale(2026, "global", fixedNow), true, "retry window expired");
});

test("holiday validation rejects out-of-range months and days", () => {
    const Holidays = loadHolidays();
    // validHoliday is the record contract's rule; the adapter forwards to it
    const record = new Holidays.HolidayRecordContract();
    const base = {
        name: [{ lang: "en", text: "X" }],
        flags: []
    };
    assert.ok(record.validHoliday({ ...base, date: { year: 2026, month: 12, day: 31 } }));
    assert.ok(record.validHoliday({ ...base, date: { year: 2024, month: 2, day: 29 } }));
    assert.ok(!record.validHoliday({ ...base, date: { year: 2026, month: 13, day: 1 } }));
    assert.ok(!record.validHoliday({ ...base, date: { year: 2026, month: 0, day: 1 } }));
    assert.ok(!record.validHoliday({ ...base, date: { year: 2026, month: 5, day: 32 } }));
    assert.ok(!record.validHoliday({ ...base, date: { year: 2026, month: 5, day: 0 } }));
    assert.ok(!record.validHoliday({ ...base, date: { year: 2026, month: 2, day: 29 } }));
    assert.ok(!record.validHoliday({ ...base, date: { year: 2026, month: 2, day: 30 } }));
    assert.ok(!record.validHoliday({ ...base, date: { year: 2026, month: 4, day: 31 } }));
    assert.ok(!record.validHoliday({
        ...base,
        date: { year: 2026, month: 4, day: 30 },
        dateTo: { year: 2026, month: 4, day: 31 }
    }));

    const nager = new Holidays.NagerDateServiceAdapter(() => {});
    assert.equal(nager._dateParts("2026-13-01"), null);
    assert.equal(nager._dateParts("2026-00-10"), null);
    assert.equal(nager._dateParts("2026-05-32"), null);
    assert.equal(nager._dateParts("2026-02-29"), null);
    assert.equal(nager._dateParts("2026-04-31"), null);
    assert.deepEqual(nager._dateParts("2024-02-29"), { year: 2024, month: 2, day: 29 });
    assert.deepEqual(nager._dateParts("2026-05-31"), { year: 2026, month: 5, day: 31 });
});

test("Enrico.destroy aborts its own session and silences late callbacks", () => {
    const aborted = [];
    const soup = makeSoup3();
    soup.Session.prototype.abort = function() {
        aborted.push(this);
    };
    const Holidays = loadHolidays({ soup });

    let savedFetch = null;
    const service = {
        fetchYear(country, region, year, cb) {
            savedFetch = cb;
        },
        expandHoliday: () => [],
        validResponse: () => true
    };
    const cache = {
        years: {}, country: "ita", region: "global", data: [],
        recordAttempt() {}, recordYear() {}, addUnique() {}, persist() {},
        setPlace() {}, stale: () => true, matchMonth: () => new Map(),
        setData() {}
    };
    const enrico = new Holidays.Enrico(service, cache);
    enrico.cache.country = "ita";

    let called = 0;
    enrico.retrieveForYear(2026, () => called++);
    // the session is lazy; materialize it as a real fetch would
    enrico._getHttpSession();
    enrico.destroy();

    assert.equal(aborted.length, 1, "the provider aborts the session it owns");
    assert.deepEqual(enrico._inflight._waiting, {});
    savedFetch([], { year: 2026 }, "date");
    assert.equal(called, 0, "late fetch callback ignored after destroy");

    // new fetches are refused outright once destroyed
    savedFetch = null;
    enrico.retrieveForYear(2027, () => called++);
    assert.equal(savedFetch, null, "destroyed provider never fetches again");
});

test("holiday HTTP session carries an explicit timeout", () => {
    const instances = [];
    const soup = makeSoup3();
    const RecordingSession = class extends soup.Session {
        constructor() {
            super();
            instances.push(this);
        }
    };
    const Holidays = loadHolidays({ soup: { ...soup, Session: RecordingSession } });
    assert.ok(Holidays.HTTP_TIMEOUT_SECONDS > 0);
    assert.equal(instances.length, 0, "session is lazy: nothing at import time");

    const enrico = new Holidays.Enrico();
    assert.equal(instances.length, 0, "still lazy after construction");

    enrico._getHttpSession();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].timeout, Holidays.HTTP_TIMEOUT_SECONDS);
    assert.equal(instances[0].idle_timeout, Holidays.HTTP_TIMEOUT_SECONDS);

    enrico._getHttpSession();
    assert.equal(instances.length, 1, "session reused");

    // a second applet instance owns a separate session, so destroying one
    // never aborts the other's in-flight requests
    const other = new Holidays.Enrico();
    other._getHttpSession();
    assert.equal(instances.length, 2);

    // the default service fetches through the session its own provider owns
    const fetching = new Holidays.Enrico();
    fetching.country = "usa";
    fetching.region = "global";
    fetching.retrieveForYear(2026);
    assert.equal(instances.length, 3);
    assert.equal(instances[2].timeout, Holidays.HTTP_TIMEOUT_SECONDS);
});

test("HolidayCacheRepository reads and writes the per-country cache file", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/enrico.json");

    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("enrico.json"), JSON.stringify({
        usa: {
            years: { 2026: { global: "Mon, 05 Jan 2026 00:00:00 GMT" } },
            holidays: [{ year: 2026, month: 1, day: 1, region: "global", name: "New Year", flags: [] }]
        }
    }));

    assert.deepEqual(loadCountry(repository, "usa").years, { 2026: { global: "Mon, 05 Jan 2026 00:00:00 GMT" } });

    repository.save("usa", { years: {}, holidays: [] });

    assert.equal(HolidayCacheRepository.path, cachePath());
    const written = JSON.parse(fs.readFileSync(cachePath("enrico.json"), "utf8"));
    assert.deepEqual(Object.keys(written), ["usa"]);
    assert.deepEqual(written.usa.years, {});
    assert.deepEqual(written.usa.holidays, []);
    // when the blob was last written: what the country eviction sorts on
    assert.ok(Number.isFinite(written.usa.savedAt));
});

// prune() trims the years of the country in use; the per-country blobs of every
// country the user ever tried were kept forever, and _flush re-reads the whole
// file on every successful fetch.
test("the cache file keeps a handful of countries, not every one ever tried", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const { MAX_CACHED_COUNTRIES } = require(holidayCachePath);
    let clock = 1000;
    const repository = new HolidayCacheRepository("/enrico.json", { now: () => clock++ });

    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("enrico.json"), "{}");

    const tried = ["usa", "ita", "fra", "deu", "jpn", "bra", "can"];
    for (const country of tried) {
        repository.save(country, { years: {}, holidays: [] });
    }

    const written = JSON.parse(fs.readFileSync(cachePath("enrico.json"), "utf8"));
    assert.equal(Object.keys(written).length, MAX_CACHED_COUNTRIES);

    // the ones kept are the ones most recently looked at
    assert.deepEqual(Object.keys(written).sort(),
        tried.slice(-MAX_CACHED_COUNTRIES).sort());
});

test("the month-match memo is bounded, and scrolling back is still free", () => {
    const { HolidayCache } = loadHolidays();
    const { MAX_MEMOIZED_MONTHS } = require(holidayCachePath);
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    cache.setPlace("usa");
    cache.addUnique({ year: 2026, month: 1, day: 1, region: "global", name: "New Year", flags: [] });

    const january = cache.matchMonth(2026, 1);
    assert.equal(cache.matchMonth(2026, 1), january, "the same month is memoized, not recomputed");

    // scrolling needs no fetch, so prune() never runs: the memo has to hold
    // its own bound
    for (let month = 0; month < MAX_MEMOIZED_MONTHS * 3; month++) {
        cache.matchMonth(2020 + Math.floor(month / 12), (month % 12) + 1);
    }

    assert.ok(cache._matchedMonthCache.size <= MAX_MEMOIZED_MONTHS,
        "the memo stays inside its cap however far the user scrolls");
    assert.deepEqual(Array.from(cache.matchMonth(2026, 1).keys()), ["1/1"],
        "an evicted month is recomputed, not lost");
});

test("a holiday name cannot grow without bound", () => {
    const { HolidayCache } = loadHolidays();
    const { clampHolidayName, MAX_HOLIDAY_NAME_LENGTH } = require(holidayCachePath);
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});

    assert.equal(clampHolidayName("Christmas"), "Christmas");
    assert.equal(clampHolidayName(undefined), "");
    assert.equal(clampHolidayName("x".repeat(1000)).length, MAX_HOLIDAY_NAME_LENGTH);

    // a provider repeating itself on the same date is what grows the cell
    for (let i = 0; i < 200; i++) {
        cache.addUnique({ year: 2026, month: 1, day: 1, region: "global", name: "Holiday " + i, flags: [] });
    }

    assert.equal(cache.data.length, 1, "same date, same region: one row");
    assert.ok(cache.data[0].name.length <= MAX_HOLIDAY_NAME_LENGTH,
        "the joined name stays inside the cap");
});

test("a second write waits for the one in flight instead of racing it", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const settle = [];
    const writes = [];

    // a Gio file whose async write does not complete until we let it
    global.imports.gi.Gio.file_new_for_path = (filePath) => ({
        query_exists: () => false,
        get_path: () => filePath,
        replace_contents_async(bytes, _etag, _backup, _flags, _cancellable, callback) {
            writes.push(JSON.parse(Buffer.from(bytes).toString("utf8")));
            settle.push(() => callback(this, { ok: true }));
        },
        replace_contents_finish: (result) => result.ok
    });

    const repository = new HolidayCacheRepository("/enrico.json");
    repository.save("usa", { years: {}, holidays: [{ name: "first" }] });
    repository.save("usa", { years: {}, holidays: [{ name: "second" }] });
    repository.save("ita", { years: {}, holidays: [{ name: "third" }] });

    assert.equal(writes.length, 1, "only one write is in flight at a time");

    settle.shift()();
    assert.equal(writes.length, 2, "the queued changes go out once the first settles");
    assert.deepEqual(writes[1].usa.holidays, [{ name: "second" }], "and they are the newest ones");
    assert.deepEqual(writes[1].ita.holidays, [{ name: "third" }]);

    settle.shift()();
    assert.equal(writes.length, 2, "nothing is left over to write");
});

test("the country the user left does not overwrite the one they picked", () => {
    const { HolidayCache } = loadHolidays();
    const pending = [];
    const cache = new HolidayCache(
        (country, done) => pending.push(() => done({
            years: {},
            holidays: [{ year: 2026, month: 7, day: 14, region: "global", name: country, flags: [] }]
        })),
        () => {}
    );

    cache.setPlace("fra", "global");
    cache.setPlace("jpn", "global");

    // the reads land in order, so France's answers after Japan's
    pending.reverse().forEach((land) => land());

    assert.equal(cache.country, "jpn");
    assert.deepEqual(cache.data.map((single) => single.name), ["jpn"],
        "the stale read is dropped rather than loaded over the current country");
});

test("a fetch that lands after the place was cleared is not persisted", () => {
    const { HolidayCache } = loadHolidays();
    const saved = [];
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        (country, data) => saved.push([country, data])
    );

    cache.setPlace("usa", "global");
    cache.clearPlace();
    cache.recordFetch(2026, "global", new Date().toUTCString(),
        [{ year: 2026, month: 1, day: 1, region: "global", name: "New Year", flags: [] }]);

    assert.deepEqual(saved, [], "there is no country to file it under");
});

test("a cache directory that cannot be created degrades instead of throwing", () => {
    const { HolidayCacheRepository, HolidayCache, Enrico } = loadHolidays();
    const logged = [];
    global.logError = (error) => logged.push(error);
    global.imports.gi.GLib.mkdir_with_parents = () => {
        throw new Error("read-only home");
    };

    const repository = new HolidayCacheRepository("/enrico.json");

    // load() and loadAsync() both answer with an empty struct rather than
    // undefined, and save() is a no-op: a full disk or a read-only $HOME
    // costs the holiday cache, not the applet
    assert.deepEqual(loadCountry(repository, "usa"), { years: {}, holidays: [] });

    let loaded = "unset";
    repository.loadAsync("usa", (data) => {
        loaded = data;
    });
    assert.deepEqual(loaded, { years: {}, holidays: [] });

    assert.doesNotThrow(() => repository.save("usa", { years: {}, holidays: [] }));
    assert.equal(fs.existsSync(cachePath("enrico.json")), false, "nothing is written");
    assert.ok(logged.length > 0, "and the failure is reported, not swallowed");

    // the whole applet still works, it just cannot remember anything
    const cache = new HolidayCache(
        (country, done) => repository.loadAsync(country, done),
        (country, data) => repository.save(country, data)
    );
    const enrico = new Enrico({
        fetchYear(_country, region, year, callback) {
            callback([{ year, month: 1, day: 1, region, name: "New Year", flags: [] }],
                { year, region, providerName: "Enrico" }, new Date().toUTCString());
        },
        validResponse: () => true,
        expandHoliday: (single) => [single]
    }, cache);

    assert.doesNotThrow(() => enrico.setPlace("usa", "global"));
    assert.deepEqual(enrico.matchMonth(new Date().getFullYear(), 1).get("1/1"), ["New Year", []]);
});

test("a cached freshness stamp in the future is not believed", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const { validCachedStamp, validCachedYears } = require(holidayCachePath);
    const repository = new HolidayCacheRepository("/enrico.json");
    const now = Date.parse("2026-07-12T00:00:00Z");

    assert.equal(validCachedStamp("Sun, 05 Jul 2026 00:00:00 GMT", now), true);
    assert.equal(validCachedStamp("Sat, 01 Jan 3000 00:00:00 GMT", now), false);
    assert.equal(validCachedStamp("not a date", now), false);
    assert.equal(validCachedStamp(4102444800000, now), false);

    assert.deepEqual(validCachedYears({
        2026: { global: "Sat, 01 Jan 3000 00:00:00 GMT", usa: "Sun, 05 Jul 2026 00:00:00 GMT" },
        2027: { global: "whenever" },
        2028: "not even an object"
    }, now), { 2026: { usa: "Sun, 05 Jul 2026 00:00:00 GMT" } });

    // the whole point: a planted stamp must not pin the rows beside it
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("enrico.json"), JSON.stringify({
        usa: {
            years: { 2026: { global: "Sat, 01 Jan 3000 00:00:00 GMT" } },
            holidays: [{ year: 2026, month: 1, day: 1, region: "global", name: "Planted", flags: [] }]
        }
    }));

    assert.deepEqual(loadCountry(repository, "usa").years, {}, "the future stamp is dropped");
    assert.equal(loadCountry(repository, "usa").holidays.length, 1, "the rows themselves still load");
});

test("Provider.loadJsonAsync parses responses and forwards the date header", () => {
    const Holidays3 = loadHolidays({
        soup: makeSoup3({ data: '{"three":3}', date: "Wed, 03 Jan 2024 00:00:00 GMT" })
    });
    let soup3Result = null;

    loadJson(Holidays3)("https://example.test/3", { version: 3 }, (data, params, retrieved) => {
        soup3Result = { data, params, retrieved };
    });

    assert.deepEqual(soup3Result, {
        data: { three: 3 },
        params: { version: 3 },
        retrieved: "Wed, 03 Jan 2024 00:00:00 GMT"
    });
});

test("Provider.loadJsonAsync always reports failures through the callback", () => {
    const HolidaysHttpError = loadHolidays({
        soup: makeSoup3({ data: '{"ignored":true}', date: "Fri, 05 Jan 2024 00:00:00 GMT", status: 503 })
    });
    let httpErrorResult = "unset";

    loadJson(HolidaysHttpError)("https://example.test/error", { version: 3 }, (data, params, retrieved) => {
        httpErrorResult = { data, params, retrieved };
    });

    assert.deepEqual(httpErrorResult, {
        data: null,
        params: { version: 3 },
        retrieved: "Fri, 05 Jan 2024 00:00:00 GMT"
    });

    const HolidaysMalformed = loadHolidays({
        soup: makeSoup3({ data: "not json", date: "Sat, 06 Jan 2024 00:00:00 GMT" })
    });
    let malformedResult = "unset";

    loadJson(HolidaysMalformed)("https://example.test/malformed", { version: 3 }, (data, params, retrieved) => {
        malformedResult = { data, params, retrieved };
    });

    assert.deepEqual(malformedResult, {
        data: null,
        params: { version: 3 },
        retrieved: "Sat, 06 Jan 2024 00:00:00 GMT"
    });
});

test("Enrico localizes, deduplicates, caches, and matches holidays by month", () => {
    const { Enrico } = loadHolidays();
    const enrico = new Enrico();
    enrico.country = "usa";
    enrico.region = "global";

    enrico.addData([
        holiday("New Year", 2026, 1, 1),
        holiday("New Year", 2026, 1, 1),
        holiday("Second Name", 2026, 1, 1),
        holiday("Other Month", 2026, 2, 1)
    ], { year: 2026, region: "global" }, new Date().toUTCString());

    const holidays = enrico.matchMonth(2026, 1);

    assert.deepEqual(holidays.get("1/1"), ["New Year\nSecond Name", ["public_holiday"]]);
    assert.equal(holidays.has("2/1"), false);
    assert.equal(enrico.staleCache(2026), false);
});

test("Enrico setPlace treats a null region as the global region", () => {
    const { Enrico } = loadHolidays();
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("enrico.json"), JSON.stringify({
        usa: {
            years: { 2026: { global: new Date().toUTCString() } },
            holidays: [{ year: 2026, month: 1, day: 1, region: "global", name: "New Year", flags: [] }]
        }
    }));

    const enrico = new Enrico();
    let retrieved = false;
    enrico.retrieveForYear = function() {
        retrieved = true;
    };

    // regioned countries (usa, deu, esp, ...) default their region setting
    // to null; that must resolve to "global", not the lookup key "null"
    enrico.setPlace("usa", null);

    assert.equal(enrico.region, "global");
    assert.equal(enrico.staleCache(2026), false);
    assert.equal(retrieved, false);
    assert.deepEqual(enrico.matchMonth(2026, 1).get("1/1"), ["New Year", []]);
});

test("Enrico setPlace honors the retry backoff after a failed fetch", () => {
    const { Enrico } = loadHolidays();
    const year = new Date().getFullYear();

    const enrico = new Enrico();
    let retrieved = 0;
    enrico.retrieveForYear = function() {
        retrieved++;
    };

    enrico.setPlace("usa", "global");
    assert.equal(retrieved, 1, "an uncached region fetches immediately");

    // the fetch failed: an attempt is on record but no data arrived.
    // re-applying the same place (settings callbacks fire liberally) must
    // not turn into a request per callback while the service is down
    enrico.cache.recordAttempt(year, "global");
    enrico.setPlace("usa", "global");
    assert.equal(retrieved, 1, "a recent failed attempt suppresses refetch");

    enrico.setPlace("usa", "ny");
    assert.equal(retrieved, 2, "a region without data or attempts still fetches");

    enrico.cache.recordAttempt(year, "ny",
        new Date(Date.now() - (2 * 60 * 60 * 1000)).toUTCString());
    enrico.setPlace("usa", "ny");
    assert.equal(retrieved, 3, "an expired attempt allows the retry");
});

test("a corrupt cache file is ignored instead of breaking holidays", () => {
    const { Enrico } = loadHolidays();
    fs.mkdirSync(cachePath(), { recursive: true });

    const payloads = [
        "{ not json at all",
        "null",
        JSON.stringify({ usa: { years: null, holidays: "nope" } })
    ];

    for (const payload of payloads) {
        fs.writeFileSync(cachePath("enrico.json"), payload);

        const enrico = new Enrico();
        let retrievedYear = null;
        enrico.retrieveForYear = function(year) {
            retrievedYear = year;
        };

        enrico.setPlace("usa", "global");

        assert.deepEqual(enrico.cache.years, {}, `years for ${payload}`);
        assert.equal(retrievedYear, new Date().getFullYear(), `retrieve for ${payload}`);
        assert.equal(enrico.matchMonth(2026, 1).size, 0);
    }
});

test("Enrico setPlace loads cache and getHolidays retrieves stale years", () => {
    const { Enrico } = loadHolidays();
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("enrico.json"), JSON.stringify({
        usa: {
            years: { 2026: { global: "Fri, 01 Jan 2026 00:00:00 GMT" } },
            holidays: [{ year: 2026, month: 1, day: 1, region: "global", name: "Cached", flags: [] }]
        }
    }));

    const enrico = new Enrico();
    let retrievedYear = null;
    enrico.retrieveForYear = function(year, callback) {
        retrievedYear = year;
        this.cache.years[year] = { global: new Date().toUTCString() };
        this.cache.data.push({ year, month: 3, day: 8, region: "global", name: "Fetched", flags: [] });
        if (callback) {
            callback();
        }
    };

    enrico.setPlace("usa", "global");

    assert.equal(enrico.country, "usa");
    assert.equal(enrico.region, "global");
    assert.equal(retrievedYear, 2026);

    let holidays = null;
    enrico.getHolidays(2027, 3, (value) => {
        holidays = value;
    });

    assert.equal(retrievedYear, 2027);
    assert.deepEqual(holidays.get("3/8"), ["Fetched", []]);
});

test("Enrico retrieveForYear builds params and addData ignores provider errors", () => {
    const { Enrico, EnricoServiceAdapter, HolidayServiceFallbackAdapter } = loadHolidays();
    let captured = null;
    // Enrico's service is a fallback chain in production; a bare adapter is only a
    // fetchYear, so wrap it the way the applet does — the record contract (validate
    // and expand) is the chain's, not any one adapter's
    const primary = new EnricoServiceAdapter((url, params, callback) => {
        captured = { url, params };
        callback([holiday("Fetched", params.year, 7, 4)], params, "Sat, 04 Jul 2026 00:00:00 GMT");
    });
    const enrico = new Enrico();
    enrico.service = new HolidayServiceFallbackAdapter(primary, []);
    enrico.country = "usa";
    enrico.region = "ca";

    enrico.retrieveForYear(2026);

    assert.equal(captured.params.country, "usa");
    assert.equal(captured.params.region, "ca");
    assert.equal(captured.params.providerName, "Enrico");
    assert.ok(captured.url.includes("country=usa"));
    assert.deepEqual(enrico.matchMonth(2026, 7).get("7/4"), ["Fetched", ["public_holiday"]]);
    assert.equal(enrico.last_provider, "Enrico");

    const before = enrico.cache.data.length;
    const logged = [];
    global.logError = (message) => logged.push(message);
    enrico.addData({ error: "bad" }, { year: 2026, providerName: "Enrico" }, STAMP);
    assert.equal(enrico.cache.data.length, before);
    assert.deepEqual(logged, [
        "holiday provider Enrico returned invalid data for 2026: bad"
    ]);
});

// The provider's own error string reaches a Pango tooltip, an accessible name
// and global.logError, and it was the one remote string with no clamp and no
// type check on it.
test("a hostile provider error string cannot flood the tooltip or the log", () => {
    const { Enrico, HolidayCache, HOLIDAY_ERRORS } = loadHolidays();
    const enrico = new Enrico({ fetchYear() {}, validResponse: () => true, expandHoliday: () => [] },
        new HolidayCache(() => {}, () => {}));
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    enrico.addData({ error: "x".repeat(4 * 1024 * 1024) }, { year: 2026 }, STAMP);
    assert.ok(enrico.last_error.length <= 300,
        "a 4 MiB error string is laid out on the compositor thread");
    assert.ok(enrico.last_error.endsWith("…"));

    // newlines in it would forge lines in the Cinnamon log
    enrico.addData({ error: "boom\nJan 01 00:00:00 cinnamon: forged" }, { year: 2026 }, STAMP);
    assert.doesNotMatch(enrico.last_error, /\n/);

    // and a non-string error is an invalid response, not an object stringified
    // into the month label
    enrico.addData({ error: { code: 500 } }, { year: 2026 }, STAMP);
    assert.equal(enrico.last_error, HOLIDAY_ERRORS.INVALID_RESPONSE);
    assert.ok(logged.length >= 3);
});

test("Enrico validates remote payloads before caching", () => {
    const { Enrico, HOLIDAY_ERRORS } = loadHolidays();
    const enrico = new Enrico();
    enrico.country = "usa";
    enrico.region = "global";

    const logged = [];
    global.logError = (message) => logged.push(message);

    for (const payload of [
        null,
        { not: "array" },
        [{ date: { year: 2026, month: 1, day: 1 }, name: [], flags: [] }],
        [{ date: { year: "2026", month: 1, day: 1 }, name: [{ lang: "en", text: "Bad" }], flags: [] }],
        [{ date: { year: 2026, month: 1, day: 1 }, name: [{ lang: "en", text: "Bad" }], flags: "public" }]
    ]) {
        enrico.addData(payload, { year: 2026, region: "global", providerName: "Schema Test" }, STAMP);
    }

    assert.equal(enrico.cache.data.length, 0);
    assert.equal(enrico.cache.years[2026], undefined);
    assert.equal(enrico.last_error, HOLIDAY_ERRORS.INVALID_RESPONSE);
    assert.equal(logged.length, 4);
    assert.ok(logged.every((line) => line ===
        `holiday provider Schema Test returned invalid data for 2026: ${HOLIDAY_ERRORS.INVALID_RESPONSE}`));

    enrico.addData([holiday("Valid", 2026, 1, 1)], { year: 2026, region: "global" }, STAMP);
    assert.equal(enrico.cache.data.length, 1);
    assert.deepEqual(enrico.cache.years[2026], { global: STAMP });
    assert.equal(enrico.last_error, "");
});

test("Enrico surfaces provider errors to getHolidays callbacks", () => {
    const { Enrico } = loadHolidays();
    const service = {
        validResponse() {
            return false;
        },
        fetchYear(_country, _region, year, callback) {
            callback({ error: "Enrico unavailable" }, { year, region: "global", providerName: "Test Provider" }, null);
        }
    };
    const enrico = new Enrico(service);
    enrico.country = "usa";
    enrico.region = "global";
    let result = null;

    enrico.getHolidays(2026, 1, (dates, error, providerName) => {
        result = { dates, error, providerName };
    });

    assert.deepEqual(Array.from(result.dates.entries()), []);
    assert.equal(result.error, "Enrico unavailable");
    assert.equal(result.providerName, "Test Provider");
});

// The status ledger is keyed `${year}/${region}` with no country in it, so a
// failure recorded for France's 2026/global was read back by Germany — also
// "global" — whose data was cached and fresh, so nothing ever overwrote it.
test("a failure under one country is not reported under the next", () => {
    const { Enrico, HolidayCache } = loadHolidays();
    const year = new Date().getFullYear();
    let fail = true;

    const service = {
        validResponse: () => !fail,
        expandHoliday: (holiday) => [holiday],
        fetchYear(_country, _region, requested, callback) {
            callback(fail ? { error: "Holiday service unavailable" } :
                [{ year: requested, month: 7, day: 14, region: "global", name: "F\u00eate", flags: [] }],
            { year: requested, region: "global", providerName: "Enrico" }, STAMP);
        }
    };
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    const enrico = new Enrico(service, cache);

    // France fails
    enrico.setPlace("fra", "global");
    let seen = null;
    enrico.getHolidays(year, 7, (dates, error) => { seen = error; });
    assert.equal(seen, "Holiday service unavailable");

    // the user switches to Germany, which answers
    fail = false;
    enrico.setPlace("deu", "global");
    enrico.getHolidays(year, 7, (dates, error) => { seen = error; });

    assert.equal(seen, "", "Germany's holidays must not carry France's failure");
});

// Not a fuzz test: a for-loop over i % 12 and i % 27, building perfectly
// well-formed rows with no PRNG anywhere. It is a good example test and it is
// named as one now. (The real fuzz over this cache is "only well-formed rows
// survive the cache's own validator", below.)
test("HolidayCache indexes many rows into the month they fall in", () => {
    const { HolidayCache } = loadHolidays();
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    cache.setPlace("usa", "global");
    const expected = new Map();

    for (let i = 0; i < 40; i++) {
        const month = 1 + (i % 12);
        const day = 1 + (i % 27);
        const name = `Holiday ${i}`;
        cache.addUnique({ year: 2030, month, day, region: "global", name, flags: [] });

        if (month === 5) {
            expected.set(`${month}/${day}`, name);
        }
    }

    const may = cache.matchMonth(2030, 5);
    assert.equal(may.size, expected.size);
    assert.equal(cache._holidayIndex.size, cache.data.length);
    assert.ok(cache._monthIndex.has("2030/5/global"));
    for (const [date, name] of expected) {
        assert.equal(may.get(date)[0], name);
    }
});

test("HolidayCache indexes loaded data and syncs direct mutations", () => {
    const { HolidayCache } = loadHolidays();
    const cache = new HolidayCache(
        (_country, done) => done({
            years: {},
            holidays: [
                { year: 2031, month: 1, day: 1, region: "global", name: "One", flags: [] },
                { year: 2031, month: 1, day: 1, region: "global", name: "Uno", flags: [] },
                { year: 2031, month: 1, day: 6, region: "global", name: "Six", flags: [] }
            ]
        }),
        () => {}
    );

    cache.setPlace("usa", "global");

    assert.equal(cache.data.length, 2);
    assert.deepEqual(cache.matchMonth(2031, 1).get("1/1"), ["One\nUno", []]);

    cache.data.push({ year: 2031, month: 1, day: 7, region: "global", name: "Seven", flags: [] });

    assert.deepEqual(cache.matchMonth(2031, 1).get("1/7"), ["Seven", []]);
    assert.equal(cache._holidayIndex.size, cache.data.length);
});

test("HolidayCache memoizes derived month matches until data changes", () => {
    const { HolidayCache } = loadHolidays();
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    cache.setPlace("usa", "global");
    cache.addUnique({ year: 2031, month: 1, day: 1, region: "global", name: "One", flags: [] });

    const first = cache.matchMonth(2031, 1);
    const second = cache.matchMonth(2031, 1);
    assert.equal(first, second);

    cache.addUnique({ year: 2031, month: 1, day: 2, region: "global", name: "Two", flags: [] });
    const third = cache.matchMonth(2031, 1);
    assert.notEqual(third, first);
    assert.deepEqual(third.get("1/2"), ["Two", []]);
});

test("HolidayCache backs off after a failed fetch attempt", () => {
    const { HolidayCache } = loadHolidays();
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    cache.setPlace("usa", "global");

    assert.equal(cache.stale(2026, "global"), true);
    cache.recordAttempt(2026, "global", new Date().toUTCString());
    assert.equal(cache.stale(2026, "global"), false);

    cache.recordAttempt(2027, "global", new Date(Date.now() - (2 * 60 * 60 * 1000)).toUTCString());
    assert.equal(cache.stale(2027, "global"), true);
});

test("Enrico records the attempt when the fetch lands, not when it starts", () => {
    const { Enrico, HolidayCache } = loadHolidays();
    let fetched = false;
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    const service = {
        fetchYear(_country, _region, _year, callback) {
            fetched = true;
            callback({ error: "offline" }, { year: new Date().getFullYear() }, null);
        }
    };
    const enrico = new Enrico(service, cache);
    enrico.setPlace("usa", "global");

    assert.equal(fetched, true);
    // the failed attempt is recorded on completion, so RETRY_PERIOD applies
    assert.equal(enrico.staleCache(new Date().getFullYear()), false);
});

test("a fetch that lands after the country changed does not write to the new country", () => {
    const { Enrico, HolidayCache } = loadHolidays();
    const stored = { fra: { years: {}, holidays: [] }, jpn: { years: {}, holidays: [] } };
    const saved = [];
    const cache = new HolidayCache(
        (country, done) => done(JSON.parse(JSON.stringify(stored[country]))),
        (country, data) => saved.push([country, data])
    );

    const row = (country, year) => (country === "fra" ?
        { year, month: 7, day: 14, region: "global", name: "Bastille Day", flags: [] } :
        { year, month: 7, day: 20, region: "global", name: "Marine Day", flags: [] });
    const pending = [];
    const service = {
        fetchYear(country, region, year, callback) {
            pending.push(() => callback(
                [row(country, year)],
                { year, region, providerName: "Enrico" },
                new Date().toUTCString()
            ));
        },
        validResponse: () => true,
        expandHoliday: (single) => [single]
    };

    const enrico = new Enrico(service, cache);
    const year = new Date().getFullYear();

    enrico.setPlace("fra", "global");          // France asks...
    enrico.setPlace("jpn", "global");          // ...the user picks Japan...
    pending.forEach((land) => land());         // ...and both answers arrive

    const july = Array.from(enrico.matchMonth(year, 7).values()).map(([name]) => name);
    assert.deepEqual(july, ["Marine Day"],
        "France's holidays do not show up in Japan's calendar");

    const persisted = saved
        .filter(([country]) => country === "jpn")
        .flatMap(([, data]) => data.holidays.map((single) => single.name));
    assert.equal(persisted.includes("Bastille Day"), false,
        "and they are not written to disk under Japan either");
});

test("the per-year status record does not outlive the years the grid can reach", () => {
    const { Enrico, HolidayCache } = loadHolidays();
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    const service = {
        fetchYear(_country, _region, year, callback) {
            callback([], { year, providerName: "Enrico" }, new Date().toUTCString());
        },
        validResponse: () => true,
        expandHoliday: () => []
    };
    const enrico = new Enrico(service, cache);
    enrico.setPlace("usa", "global");

    const current = new Date().getFullYear();
    for (const year of [current - 6, current - 1, current, current + 1, current + 7]) {
        enrico.retrieveForYear(year);
    }

    // _inflight cleans up after itself; the status beside it used to grow one
    // entry per year+region ever browsed
    assert.deepEqual(Object.keys(enrico._status._status).sort(),
        [`${current - 1}/global`, `${current + 1}/global`, `${current}/global`].sort());
});

test("the cache persists only the reachable window but keeps the session's data", () => {
    const { HolidayCache } = loadHolidays();
    const saved = [];
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        (country, data) => saved.push([country, data])
    );
    cache.setPlace("usa", "global");

    const current = new Date().getFullYear();
    const old = current - 5;
    cache.years[old] = { global: "Thu, 01 Jan 2020 00:00:00 GMT" };
    cache.attempts[old] = { global: "Thu, 01 Jan 2020 00:00:00 GMT" };
    cache.setData([
        { year: old, month: 1, day: 1, region: "global", name: "Ancient", flags: [] },
        { year: current, month: 1, day: 1, region: "global", name: "Current", flags: [] }
    ]);

    cache.recordFetch(current, "global", null,
        [{ year: current, month: 7, day: 4, region: "global", name: "Fresh", flags: [] }]);
    cache.persist();

    // the live data keeps everything the session read — the out-of-window year
    // still renders and its freshness stamp still throttles it
    assert.deepEqual(cache.data.map((single) => single.name), ["Ancient", "Current", "Fresh"]);
    assert.deepEqual(cache.years[old], { global: "Thu, 01 Jan 2020 00:00:00 GMT" });
    assert.deepEqual(cache.attempts[old], { global: "Thu, 01 Jan 2020 00:00:00 GMT" });
    // but the file carries only the window the grid can reach
    assert.deepEqual(saved[0][1].holidays.map((single) => single.name), ["Current", "Fresh"]);
    assert.equal(saved[0][1].years[old], undefined);
});

// The bug this guards: pruning live state discarded a year browsed to that is
// outside the window, along with the stamp that throttles it, so every calendar
// update refetched it over the network and rewrote the disk, forever, while the
// holidays never rendered.
test("a fetched out-of-window year stays in memory and is not refetched", () => {
    const { HolidayCache } = loadHolidays();
    const saved = [];
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        (country, data) => saved.push([country, data])
    );
    cache.setPlace("usa", "global");

    const now = new Date();
    const current = now.getFullYear();
    const ahead = current + 3;
    const retrieved = now.toUTCString();

    cache.recordFetch(ahead, "global", retrieved,
        [{ year: ahead, month: 12, day: 25, region: "global", name: "Future", flags: [] }]);
    cache.persist(now);

    // it renders: the reading is in the live data and matchable
    assert.equal(cache.matchMonth(ahead, 12, "global").get("12/25")[0], "Future");
    // and it is not stale, so the next update does not refetch it
    assert.equal(cache.stale(ahead, "global", now), false);
    // the file stays bounded to the window
    assert.deepEqual(saved[0][1].holidays, []);
});

test("the cache file is read once for loading and written asynchronously", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/enrico.json");
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("enrico.json"), JSON.stringify({
        usa: { years: {}, holidays: [] }
    }));

    // the async reader is the only reader now: the synchronous load() it
    // replaced had no production caller left
    let reads = 0;
    const file = global.imports.gi.Gio.file_new_for_path(cachePath("enrico.json"));
    const finish = file.load_contents_finish.bind(file);
    global.imports.gi.Gio.file_new_for_path = () => Object.assign(Object.create(file), {
        load_contents_finish(result) {
            reads++;
            return finish(result);
        }
    });

    loadCountry(repository, "usa");
    loadCountry(repository, "ita");
    assert.equal(reads, 1, "the multi-country file is parsed once for reading, not per country");

    let fromMemo = "unset";
    repository.loadAsync("usa", (data) => {
        fromMemo = data;
    });
    assert.deepEqual(fromMemo, { years: {}, holidays: [] }, "a later read is answered from the memo");
    assert.equal(reads, 1, "and does not touch the file again");

    repository.save("usa", { years: { 2026: { global: "Mon, 05 Jan 2026 00:00:00 GMT" } }, holidays: [] });
    repository.save("ita", { years: {}, holidays: [] });

    // the write goes through the async Gio path, so it never blocks the shell
    const written = JSON.parse(fs.readFileSync(cachePath("enrico.json"), "utf8"));
    assert.deepEqual(Object.keys(written).sort(), ["ita", "usa"]);
    assert.deepEqual(written.usa.years, { 2026: { global: "Mon, 05 Jan 2026 00:00:00 GMT" } });
});

// ...and the merge above only covers writes that had already *settled*. The
// interlock is per repository instance, and the file is shared by every applet on
// every panel, so a second instance can land its write between our read and our
// write. Gio's etag is what turns that into a failed write instead of a silent
// overwrite.
test("a write that lost a race is merged again, not lost", () => {
    const { HolidayCacheRepository } = loadHolidays();

    // a file whose contents (and etag) another writer changes underneath us,
    // exactly once
    let contents = JSON.stringify({ usa: { years: {}, holidays: [] } });
    let etag = "v1";
    let interfered = false;

    global.imports.gi.Gio.file_new_for_path = (filePath) => ({
        query_exists: () => true,
        get_path: () => filePath,
        load_contents_async(_cancellable, callback) {
            callback(this, { ok: true });
        },
        load_contents_finish() {
            return [true, Buffer.from(contents), etag];
        },
        replace_contents_async(bytes, givenEtag, _backup, _flags, _cancellable, callback) {
            // the other applet instance writes Italy just before our write lands
            if (!interfered) {
                interfered = true;
                contents = JSON.stringify({ ita: { years: {}, holidays: [{ name: "Epifania" }] } });
                etag = "v2";
            }

            if (givenEtag && givenEtag !== etag) {
                callback(this, { error: new Error("Wrong etag") });
                return;
            }

            contents = Buffer.from(bytes).toString("utf8");
            etag = "v3";
            callback(this, { ok: true });
        },
        replace_contents_finish(result) {
            if (result.error) {
                throw result.error;
            }
            return true;
        }
    });

    const repository = new HolidayCacheRepository("/enrico.json");
    repository.save("usa", { years: {}, holidays: [{ name: "Independence Day" }] });

    const written = JSON.parse(contents);
    assert.deepEqual(Object.keys(written).sort(), ["ita", "usa"],
        "the write that lost the race merged again instead of overwriting");
    assert.equal(written.ita.holidays[0].name, "Epifania");
    assert.equal(written.usa.holidays[0].name, "Independence Day");
});

test("a save merges with the file instead of overwriting another writer's country", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/enrico.json");
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("enrico.json"), JSON.stringify({
        usa: { years: {}, holidays: [] }
    }));

    // this instance takes its snapshot...
    loadCountry(repository, "usa");

    // ...and a second applet instance, with its own repository, saves Italy
    // in the meantime
    const other = new HolidayCacheRepository("/enrico.json");
    other.save("ita", { years: {}, holidays: [{ year: 2026, month: 1, day: 6, region: "global", name: "Epifania", flags: [] }] });

    repository.save("usa", { years: {}, holidays: [{ year: 2026, month: 7, day: 4, region: "global", name: "Independence Day", flags: [] }] });

    const written = JSON.parse(fs.readFileSync(cachePath("enrico.json"), "utf8"));
    assert.deepEqual(Object.keys(written).sort(), ["ita", "usa"],
        "the stale snapshot no longer drops the other instance's country");
    assert.equal(written.ita.holidays[0].name, "Epifania");
    assert.equal(written.usa.holidays[0].name, "Independence Day");
});

// validCachedHoliday is the trust boundary for the on-disk cache - anything
// running as the user can rewrite that file - and it was only ever exercised
// transitively, always with rows that were already valid.
test("fuzz: only well-formed rows survive the cache's own validator", () => {
    const { validCachedHoliday } = require(holidayCachePath);
    const rand = makeRandom(0xca6e);
    const pick = (pool) => pool[Math.floor(rand() * pool.length)];
    const numbers = [2026, 1, 31, 0, -1, 1.5, NaN, Infinity, "2026", null, undefined, {}, []];
    const names = ["New Year", "", "x".repeat(500), 42, null, undefined, {}, ["a"]];
    const flagSets = [[], ["public_holiday"], "public_holiday", null, undefined, {}, 7];
    const regions = ["global", "ca", "", 42, null, undefined, {}];

    for (let round = 0; round < 500; round++) {
        const row = {
            year: pick(numbers),
            month: pick(numbers),
            day: pick(numbers),
            name: pick(names),
            flags: pick(flagSets),
            region: pick(regions)
        };
        // sometimes hand it something that is not a row at all
        const candidate = rand() < 0.1 ? pick([null, undefined, 42, "row", [], true]) : row;

        const accepted = validCachedHoliday(candidate);
        assert.equal(typeof accepted, "boolean");

        if (!accepted) {
            continue;
        }

        // whatever it accepts, the grid can render: the name reaches a Pango
        // tooltip and the flags decide whether the day is a working day
        assert.ok(Number.isInteger(candidate.year));
        assert.ok(Number.isInteger(candidate.month));
        assert.ok(Number.isInteger(candidate.day));
        assert.equal(typeof candidate.name, "string");
        assert.ok(Array.isArray(candidate.flags));
        assert.ok(candidate.region === undefined || typeof candidate.region === "string");
    }
});

test("a cache file with some bad rows keeps the good ones", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/enrico.json");
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("enrico.json"), JSON.stringify({
        usa: {
            years: { 2026: { global: "Thu, 01 Jan 2026 00:00:00 GMT" } },
            holidays: [
                { year: 2026, month: 7, day: 4, region: "global", name: "Independence Day", flags: [] },
                { year: "2026", month: 7, day: 5, region: "global", name: "Typed year", flags: [] },
                { year: 2026, month: 7, day: 6, region: "global", name: "No flags" },
                { year: 2026, month: 7, day: 7, region: 42, name: "Numeric region", flags: [] },
                null
            ]
        }
    }));

    assert.deepEqual(loadCountry(repository, "usa").holidays.map((single) => single.name),
        ["Independence Day"],
        "a file that parses is not a file that can be trusted row by row");
});

test("a tampered cache file cannot inject malformed holidays", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/enrico.json");
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("enrico.json"), JSON.stringify({
        usa: {
            years: { 2026: { global: "Thu, 01 Jan 2026 00:00:00 GMT" } },
            holidays: [
                { year: 2026, month: 1, day: 1, name: "New Year", flags: [], region: "global" },
                { year: 2026, month: 1, day: 2, name: 123, flags: [], region: "global" },
                { year: 2026, month: 1, day: 3, name: "No flags", region: "global" },
                "not even an object"
            ]
        }
    }));

    const loaded = loadCountry(repository, "usa");

    assert.deepEqual(loaded.holidays.map((single) => single.name), ["New Year"]);
});

test("an unbounded holiday span is rejected, not expanded", () => {
    const ServiceAdapters = require(holidayServiceAdaptersPath);
    // the validate-and-expand rule is the record contract's, not the adapter's;
    // the adapter is a fetchYear and forwards to this
    const record = new ServiceAdapters.HolidayRecordContract("en");

    const hostile = {
        date: { year: 2026, month: 1, day: 1 },
        dateTo: { year: 9999, month: 12, day: 31 },
        name: [{ lang: "en", text: "Forever" }],
        flags: []
    };

    assert.equal(record.validHoliday(hostile), false, "the payload must never reach the cache");
    // even reached directly, expansion stays bounded instead of freezing the shell
    assert.ok(record.expandHoliday(hostile, "global").length <= ServiceAdapters.MAX_HOLIDAY_SPAN_DAYS + 1);

    const yearLong = {
        date: { year: 2026, month: 1, day: 1 },
        dateTo: { year: 2026, month: 12, day: 31 },
        name: [{ lang: "en", text: "Long" }],
        flags: []
    };
    assert.equal(record.validHoliday(yearLong), true, "a normal multi-day holiday still passes");
});

test("holiday status is reported per year, not shared across months", () => {
    const { Enrico, HolidayCache, HOLIDAY_ERRORS } = loadHolidays();
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    const pending = {};
    const service = {
        fetchYear(_country, _region, year, callback) {
            pending[year] = callback;
        },
        validResponse: (data) => Array.isArray(data),
        expandHoliday: (single, region) => [{
            region, year: single.date.year, month: single.date.month, day: single.date.day,
            name: single.name[0].text, flags: single.flags
        }]
    };
    const enrico = new Enrico(service, cache);
    enrico.country = "usa";
    enrico.region = "global";

    // a December grid shows two years: one fetch fails, the other succeeds
    const reported = {};
    enrico.getHolidays(2026, 12, (_holidays, error) => { reported["2026"] = error; });
    enrico.getHolidays(2027, 1, (_holidays, error) => { reported["2027"] = error; });

    pending[2026](null, { year: 2026, region: "global", providerName: "Enrico" }, null);
    pending[2027]([holiday("New Year", 2027, 1, 1)],
        { year: 2027, region: "global", providerName: "Enrico" }, "Fri, 01 Jan 2027 00:00:00 GMT");

    assert.equal(reported["2026"], HOLIDAY_ERRORS.SERVICE_UNAVAILABLE);
    assert.equal(reported["2027"], "", "the healthy year must not inherit the other year's failure");
});

test("a throw while storing a fetch never wedges the year", () => {
    const { Enrico, HolidayCache, HOLIDAY_ERRORS } = loadHolidays();
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    let fetches = 0;
    const service = {
        fetchYear(_country, _region, _year, callback) {
            fetches++;
            callback([holiday("Boom", 2026, 1, 1)],
                { year: 2026, region: "global", providerName: "Enrico" }, null);
        },
        validResponse: () => true,
        expandHoliday() {
            throw new Error("bad payload");
        }
    };
    const enrico = new Enrico(service, cache);
    enrico.country = "usa";
    enrico.region = "global";
    global.logError = () => {};

    let callbacks = 0;
    enrico.retrieveForYear(2026, () => callbacks++);
    assert.equal(callbacks, 1, "the callback still runs");
    assert.equal(enrico.last_error, HOLIDAY_ERRORS.INVALID_RESPONSE);
    assert.equal(enrico.fetching(2026), false, "the in-flight key must be released");

    // a later fetch of the same year must still be possible
    enrico.retrieveForYear(2026, () => callbacks++);
    assert.equal(fetches, 2);
});

test("a fresh year answers from the cache without a fetch", () => {
    const { Enrico, HolidayCache } = loadHolidays();
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    const service = {
        fetchYear() {
            throw new Error("a fresh year must not be refetched");
        },
        validResponse: () => true,
        expandHoliday: (single, region) => [{
            region, year: single.date.year, month: single.date.month, day: single.date.day,
            name: single.name[0].text, flags: single.flags
        }]
    };
    const enrico = new Enrico(service, cache);
    enrico.country = "usa";
    enrico.region = "global";

    const year = new Date().getFullYear();
    cache.recordYear(year, "global", new Date().toUTCString());
    cache.setData([{ year, month: 7, day: 4, region: "global", name: "Cached", flags: [] }]);

    let answered = null;
    enrico.getHolidays(year, 7, (holidays, error, provider) => {
        answered = { holidays, error, provider };
    });

    assert.deepEqual(answered.holidays.get("7/4"), ["Cached", []]);
    assert.equal(answered.error, "");
    assert.equal(answered.provider, "");
});

test("setPlace repaints when the fetch for the new place lands", () => {
    const { Enrico, HolidayCache } = loadHolidays();
    let pending = null;
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    const service = {
        fetchYear(_country, _region, _year, callback) {
            pending = callback;
        },
        validResponse: () => false
    };
    const enrico = new Enrico(service, cache);
    let repaints = 0;

    enrico.setPlace("usa", "global", () => repaints++);
    assert.equal(repaints, 0, "the data has not arrived yet");

    pending({ error: "offline" }, { year: new Date().getFullYear(), region: "global" }, null);
    assert.equal(repaints, 1);
});

test("a second month of the same grid joins the in-flight year fetch", () => {
    const { Enrico, HolidayCache } = loadHolidays();
    let pending = null;
    let fetches = 0;
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    const service = {
        fetchYear(_country, _region, _year, callback) {
            fetches++;
            pending = callback;
        },
        validResponse: (data) => Array.isArray(data),
        expandHoliday: (single, region) => [Object.assign({ region }, {
            year: single.date.year, month: single.date.month, day: single.date.day,
            name: single.name[0].text, flags: single.flags
        })]
    };
    const enrico = new Enrico(service, cache);
    enrico.country = "usa";
    enrico.region = "global";

    // the 42-day grid spans two months of the same year: June starts the
    // fetch, July must wait for it rather than report an empty month
    const answers = [];
    enrico.getHolidays(2026, 6, (holidays) => answers.push(["6", holidays.size]));
    enrico.getHolidays(2026, 7, (holidays) => answers.push(["7", holidays.size]));

    assert.equal(fetches, 1);
    assert.deepEqual(answers, [], "no month may answer before the data lands");

    pending([holiday("Independence Day", 2026, 7, 4)],
        { year: 2026, region: "global", providerName: "Enrico" }, "Sat, 04 Jul 2026 00:00:00 GMT");

    assert.deepEqual(answers, [["6", 0], ["7", 1]]);
});

test("Enrico deduplicates in-flight year fetches", () => {
    const { Enrico, HolidayCache } = loadHolidays();
    let fetches = 0;
    let pending = null;
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    const service = {
        fetchYear(_country, _region, _year, callback) {
            fetches++;
            pending = callback;
        }
    };
    const enrico = new Enrico(service, cache);
    enrico.country = "usa";
    enrico.region = "global";
    let callbacks = 0;

    enrico.retrieveForYear(2026, () => callbacks++);
    enrico.retrieveForYear(2026, () => callbacks++);

    assert.equal(fetches, 1);
    pending({ error: "offline" }, { year: 2026, region: "global" }, null);
    assert.equal(callbacks, 2);
});

test("every country the settings offer can reach the fallback providers", () => {
    const { SUPPORTED_COUNTRIES, ENRICO_COUNTRY_TO_ISO2 } = require(holidayConstantsPath);

    // a country in the combobox with no ISO code cannot be asked of either
    // fallback provider: if Enrico is down it simply has no holidays, silently
    const unreachable = SUPPORTED_COUNTRIES.filter((country) => !ENRICO_COUNTRY_TO_ISO2[country]);

    assert.deepEqual(unreachable, []);
});

test("NagerDateServiceAdapter maps Enrico countries and regions", () => {
    const { NagerDateServiceAdapter } = loadHolidays();
    const { ENRICO_COUNTRY_TO_ISO2, ENRICO_REGION_TO_COUNTY } = require(holidayConstantsPath);
    const adapter = new NagerDateServiceAdapter(() => {});

    assert.equal(adapter.countryCode("usa"), "US");
    assert.equal(adapter.countryCode("esp"), "ES");
    assert.equal(adapter.countryCode("isr"), "IL");
    assert.equal(adapter.countryCode("xkx"), "XK");
    assert.equal(adapter.countryCode("nowhere"), null);
    assert.equal(adapter.countyCode("usa", "ca"), "US-CA");
    assert.equal(adapter.countyCode("esp", "ex"), "ES-EX");
    assert.equal(adapter.countyCode("gbr", "sct"), "GB-SCT");
    assert.equal(adapter.countyCode("usa", "global"), null);
    assert.equal(ENRICO_COUNTRY_TO_ISO2.che, "CH");
    assert.equal(ENRICO_REGION_TO_COUNTY.che.zh, "CH-ZH");

    const params = adapter.params("usa", "ca", 2026);
    assert.deepEqual(params, {
        year: 2026,
        country: "usa",
        region: "ca",
        countryCode: "US",
        countyCode: "US-CA"
    });
    assert.equal(adapter.url(params), "https://date.nager.at/api/v3/PublicHolidays/2026/US");
});

test("NagerDateServiceAdapter translates and filters Nager holidays", () => {
    const { HolidayRecordContract, NagerDateServiceAdapter } = loadHolidays();
    let capturedUrl = null;
    const adapter = new NagerDateServiceAdapter((url, params, callback) => {
        capturedUrl = url;
        callback([
            {
                date: "2026-01-01",
                localName: "Año Nuevo",
                name: "New Year's Day",
                global: true,
                counties: null,
                types: ["Public"]
            },
            {
                date: "2026-03-31",
                localName: "Cesar Chavez Day",
                name: "Cesar Chavez Day",
                counties: ["US-CA"],
                types: ["Public"]
            },
            {
                date: "2026-11-03",
                localName: "Election Day",
                name: "Election Day",
                counties: ["US-NY"],
                types: ["Public"]
            },
            {
                date: "not-a-date",
                name: "Bad Date",
                types: ["Public"]
            }
        ], params, "Mon, 01 Jan 2026 00:00:00 GMT");
    });
    let result = null;

    adapter.fetchYear("usa", "ca", 2026, (data, params, retrieved) => {
        result = { data, params, retrieved };
    });

    assert.equal(capturedUrl, "https://date.nager.at/api/v3/PublicHolidays/2026/US");
    assert.equal(result.retrieved, "Mon, 01 Jan 2026 00:00:00 GMT");
    assert.equal(result.data.length, 2);
    assert.deepEqual(result.data[0], {
        date: { year: 2026, month: 1, day: 1 },
        name: [
            { lang: "local", text: "Año Nuevo" },
            { lang: "en", text: "New Year's Day" }
        ],
        flags: ["public_holiday"]
    });
    assert.deepEqual(result.data[1].date, { year: 2026, month: 3, day: 31 });
    assert.equal(new HolidayRecordContract().validResponse(result.data), true);

    const globalRows = adapter.translateResponse([
        {
            date: "2026-07-04",
            localName: "Independence Day",
            name: "Independence Day",
            global: true,
            counties: ["US-CA"],
            types: ["Public"]
        },
        {
            date: "2026-09-01",
            name: "County Only",
            global: false,
            counties: ["US-CA"],
            types: ["Public"]
        }
    ], adapter.params("usa", "global", 2026));
    assert.deepEqual(globalRows.map((holiday) => holiday.name[0].text), ["Independence Day"]);
});

test("OpenHolidaysServiceAdapter maps countries, regions, and localized holidays", () => {
    const { HolidayRecordContract, OpenHolidaysServiceAdapter } = loadHolidays();
    const { OPEN_HOLIDAYS_COUNTRIES } = require(holidayConstantsPath);
    let capturedUrl = null;
    const adapter = new OpenHolidaysServiceAdapter((url, params, callback) => {
        capturedUrl = url;
        callback([
            {
                startDate: "2026-01-01",
                endDate: "2026-01-01",
                type: "Public",
                name: [{ language: "EN", text: "New Year's Day" }],
                nationwide: true
            },
            {
                startDate: "2026-01-02",
                endDate: "2026-01-02",
                type: "Optional",
                name: [{ language: "EN", text: "Berchtold's Day" }],
                nationwide: false,
                subdivisions: [{ code: "CH-ZH", shortName: "ZH" }]
            },
            {
                startDate: "2026-01-06",
                type: "Public",
                name: [{ language: "EN", text: "Epiphany" }],
                nationwide: false,
                subdivisions: [{ code: "CH-TI", shortName: "TI" }]
            },
            {
                startDate: "not-a-date",
                type: "Public",
                name: [{ language: "EN", text: "Bad Date" }],
                nationwide: true
            }
        ], params, OPENHOLIDAYS_STAMP);
    }, "en_US");
    let result = null;

    assert.equal(adapter.countryCode("che"), "CH");
    assert.equal(adapter.countryCode("usa"), null);
    assert.equal(OPEN_HOLIDAYS_COUNTRIES.che, true);

    adapter.fetchYear("che", "zh", 2026, (data, params, retrieved) => {
        result = { data, params, retrieved };
    });

    assert.equal(
        capturedUrl,
        "https://openholidaysapi.org/PublicHolidays?countryIsoCode=CH&validFrom=2026-01-01&validTo=2026-12-31&languageIsoCode=EN&subdivisionCode=CH-ZH"
    );
    assert.equal(result.retrieved, OPENHOLIDAYS_STAMP);
    assert.equal(result.data.length, 2);
    assert.deepEqual(result.data[0], {
        date: { year: 2026, month: 1, day: 1 },
        name: [{ lang: "en", text: "New Year's Day" }],
        flags: ["public_holiday"]
    });
    assert.deepEqual(result.data[1], {
        date: { year: 2026, month: 1, day: 2 },
        name: [{ lang: "en", text: "Berchtold's Day" }],
        flags: ["optional"]
    });
    assert.equal(new HolidayRecordContract().validResponse(result.data), true);

    const globalParams = adapter.params("che", "global", 2026);
    const globalRows = adapter.translateResponse([
        {
            startDate: "2026-05-01",
            endDate: "2026-05-03",
            type: "Public",
            name: [{ language: "EN", text: "May Holiday" }],
            nationwide: true,
            subdivisions: [{ code: "CH-ZH", shortName: "ZH" }]
        },
        {
            startDate: "2026-06-01",
            type: "Public",
            name: [{ language: "EN", text: "Canton Holiday" }],
            nationwide: false,
            subdivisions: [{ code: "CH-ZH", shortName: "ZH" }]
        }
    ], globalParams);

    assert.equal(adapter.url(globalParams).includes("subdivisionCode"), false);
    assert.deepEqual(globalRows, [{
        date: { year: 2026, month: 5, day: 1 },
        name: [{ lang: "en", text: "May Holiday" }],
        flags: ["public_holiday"],
        dateTo: { year: 2026, month: 5, day: 3 }
    }]);
});

test("OpenHolidaysServiceAdapter translates dates and subdivisions", () => {
    const { OpenHolidaysServiceAdapter } = loadHolidays();
    const adapter = new OpenHolidaysServiceAdapter(() => {}, "en");
    const params = adapter.params("che", "fr", 2030);
    const payload = [];

    for (let i = 0; i < 40; i++) {
        const month = 1 + (i % 12);
        const day = 1 + (i % 27);
        payload.push({
            startDate: `2030-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
            type: i % 2 === 0 ? "Public" : "Optional",
            name: [{ language: "EN", text: `Holiday ${i}` }],
            nationwide: false,
            subdivisions: [{ code: `CH-FR-LA-${i}`, shortName: "FR" }]
        });
    }
    payload.push({
        startDate: "2030-01-01",
        type: "Public",
        name: [{ language: "EN", text: "Other Canton" }],
        nationwide: false,
        subdivisions: [{ code: "CH-TI", shortName: "TI" }]
    });

    const translated = adapter.translateResponse(payload, params);

    assert.equal(params.subdivisionCode, "CH-FR");
    assert.equal(translated.length, 40);
    assert.equal(translated[0].flags[0], "public_holiday");
    assert.equal(translated[1].flags[0], "optional");
    for (const holiday of translated) {
        assert.equal(holiday.date.year, 2030);
        assert.equal(holiday.name[0].lang, "en");
    }
});

// A real one, over the same adapter: the old test built 40 perfectly well-formed
// rows and asserted translated.length === 40 — that *nothing* was rejected — so
// it exercised no rejection path at all. OpenHolidays is the second provider in
// the chain and its body is untrusted, so what matters is what it refuses.
test("fuzz: OpenHolidays translation keeps only rows it can actually place", () => {
    const { OpenHolidaysServiceAdapter } = loadHolidays();
    const adapter = new OpenHolidaysServiceAdapter(() => {}, "en");
    const params = adapter.params("che", "fr", 2030);
    const rand = makeRandom(0x0f00d);
    let kept = 0;
    let dropped = 0;

    const junkDates = [
        "2030-13-01", "2030-00-10", "2030-02-30", "not-a-date", "", null, 42,
        "2030-1-1", "20300101", "2030-01-01T00:00:00Z", undefined, {}
    ];
    const junkNames = [
        [], null, undefined, "a string", [{}], [{ language: "EN" }],
        [{ text: "no language" }], 42
    ];

    for (let round = 0; round < 300; round++) {
        const payload = [];

        for (let i = 0; i < 1 + Math.floor(rand() * 8); i++) {
            const wellFormed = rand() < 0.5;
            const month = 1 + Math.floor(rand() * 12);
            const day = 1 + Math.floor(rand() * 28);

            const row = {
                startDate: wellFormed ?
                    `2030-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` :
                    junkDates[Math.floor(rand() * junkDates.length)],
                type: rand() < 0.5 ? "Public" : ["Optional", "Bank", "", null][Math.floor(rand() * 4)],
                name: wellFormed && rand() < 0.8 ?
                    [{ language: "EN", text: `Holiday ${i}` }] :
                    junkNames[Math.floor(rand() * junkNames.length)],
                nationwide: rand() < 0.3,
                subdivisions: rand() < 0.7 ?
                    [{ code: "CH-FR", shortName: "FR" }] :
                    [{ code: "CH-TI", shortName: "TI" }]
            };

            payload.push(row);
        }

        let translated = null;
        assert.doesNotThrow(() => {
            translated = adapter.translateResponse(payload, params);
        }, JSON.stringify(payload).slice(0, 200));

        // Properties, not a reimplementation of the adapter's own rules: an
        // oracle that mirrors the code under test agrees with it even when both
        // are wrong.
        //
        // Every row it kept must be one the calendar can actually place — a real
        // date in the requested year, a name to show, and flags the annotator
        // understands — and it must never keep more rows than it was given.
        for (const holiday of translated) {
            assert.equal(holiday.date.year, 2030);
            assert.ok(holiday.date.month >= 1 && holiday.date.month <= 12,
                `month out of range: ${holiday.date.month}`);
            assert.ok(holiday.date.day >= 1 && holiday.date.day <= 31,
                `day out of range: ${holiday.date.day}`);
            assert.ok(Array.isArray(holiday.name) && holiday.name.length > 0);
            assert.ok(holiday.name.every((entry) => typeof entry.text === "string" && entry.text),
                "a holiday with no name cannot be shown");
            assert.ok(Array.isArray(holiday.flags) && holiday.flags.length > 0);
            assert.ok(holiday.flags.every((flag) => typeof flag === "string"));
        }

        assert.ok(translated.length <= payload.length, "it cannot invent rows");
        kept += translated.length;
        dropped += payload.length - translated.length;

        // the same body twice answers the same way: translation is a function of
        // its input, not of what came before it
        assert.deepEqual(adapter.translateResponse(payload, params), translated);
    }

    // a corpus that never triggered a rejection would satisfy everything above
    // and prove nothing — which is exactly what the test this replaces did
    assert.ok(kept > 0, "some rows must survive");
    assert.ok(dropped > 0, "and some must be rejected");
});

// Enrico is the *primary* provider: it parses first for every user with holidays
// on, and it was the one untrusted-JSON parser with no fuzz harness at all. The
// interlock that matters here is between validHoliday and expandHoliday —
// expandHoliday's `while (iter < limit)` is bounded only because validHoliday is
// supposed to have rejected oversized spans first, and nothing ever tested the
// two together.
test("fuzz: Enrico's parser cannot be made to run away or return junk", () => {
    const { HolidayRecordContract } = loadHolidays();
    const { MAX_HOLIDAY_SPAN_DAYS } = require(
        path.join(__dirname, "..", "files", "chronos@geraldo-netto", "holidayServiceAdapters.js"));
    // the parser under fuzz is the record contract's; the adapter forwards to it
    const record = new HolidayRecordContract("de");
    const rand = makeRandom(0xe27100);

    const junkDates = [
        null, undefined, 42, "2030-01-01", {}, { year: 2030 },
        { year: 2030, month: 13, day: 1 }, { year: 2030, month: 1, day: 40 },
        { year: 2030, month: 0, day: 0 }, { year: "2030", month: "1", day: "1" },
        { year: 9999, month: 12, day: 31 }, { year: -1, month: 1, day: 1 },
        { year: 2030, month: 2, day: 30 }
    ];
    const junkNames = [
        null, undefined, [], "text", 42, [{}], [{ lang: "de" }], [{ text: "no lang" }],
        [{ lang: 42, text: "wrong type" }], [{ lang: "de", text: "Tag der Arbeit" }]
    ];

    let accepted = 0;
    let rejected = 0;
    let expandedRows = 0;

    for (let round = 0; round < 400; round++) {
        const wellFormed = rand() < 0.5;
        const month = 1 + Math.floor(rand() * 12);
        const day = 1 + Math.floor(rand() * 28);

        const holiday = {
            date: wellFormed ?
                { year: 2030, month, day } :
                junkDates[Math.floor(rand() * junkDates.length)],
            name: wellFormed && rand() < 0.85 ?
                [{ lang: "de", text: "Feiertag" }, { lang: "en", text: "Holiday" }] :
                junkNames[Math.floor(rand() * junkNames.length)],
            flags: rand() < 0.85 ? ["public_holiday"] : [null, "text", 42, {}][Math.floor(rand() * 4)]
        };

        // a span, sometimes a sane one, sometimes one that would run the
        // expansion loop for a thousand years
        if (rand() < 0.4) {
            holiday.dateTo = rand() < 0.5 ?
                { year: 2030, month, day: Math.min(28, day + Math.floor(rand() * 5)) } :
                [{ year: 3030, month: 12, day: 31 },
                    { year: 2029, month: 1, day: 1 },
                    { year: 2030, month, day }][Math.floor(rand() * 3)];
        }

        const valid = record.validHoliday(holiday);
        if (valid) {
            accepted++;
        } else {
            rejected++;
            continue;
        }

        // the interlock: whatever validHoliday let through, expandHoliday must
        // be able to expand without running away
        let days = null;
        assert.doesNotThrow(() => {
            days = record.expandHoliday(holiday, "global");
        }, JSON.stringify(holiday));

        assert.ok(days.length >= 1, "a holiday is at least one day");
        assert.ok(days.length <= MAX_HOLIDAY_SPAN_DAYS + 1,
            `the expansion is bounded: ${days.length} days from ${JSON.stringify(holiday)}`);
        expandedRows += days.length;

        for (const single of days) {
            assert.ok(Number.isInteger(single.year));
            assert.ok(single.month >= 1 && single.month <= 12);
            assert.ok(single.day >= 1 && single.day <= 31);
            assert.equal(typeof single.name, "string");
            assert.ok(single.name.length > 0, "a holiday with no name cannot be shown");
            assert.equal(single.region, "global");
        }

        // the localized name is one the payload actually carried, and it prefers
        // the user's language (de) over English
        const localized = record.localizeName(holiday);
        const texts = holiday.name.map((entry) => entry.text);
        assert.ok(texts.includes(localized), "the name shown must be a name that was sent");

        const german = holiday.name.find((entry) => entry.lang === "de");
        if (german) {
            assert.equal(localized, german.text, "a German user gets the German name");
        }
    }

    // validResponse is the gate the whole chain leans on: one bad row must
    // condemn the body, not slip through with the good ones
    assert.equal(record.validResponse([
        { date: { year: 2030, month: 1, day: 1 }, name: [{ lang: "de", text: "x" }], flags: [] },
        { date: "broken", name: [], flags: [] }
    ]), false);
    assert.equal(record.validResponse("not an array"), false);
    assert.equal(record.validResponse([]), true, "an empty year is a valid answer");

    assert.ok(accepted > 0, "some payloads must be accepted");
    assert.ok(rejected > 0, "and some must be rejected");
    assert.ok(expandedRows > accepted, "and some must be multi-day spans");
});

// T78: seeded fuzz over the Nager payload shape — translation must drop
// malformed dates, respect county matching and normalize flags, and the
// second pass over identical input must agree with the first
test("NagerDateServiceAdapter fuzzes date, county and type translation", () => {
    const { NagerDateServiceAdapter } = loadHolidays();
    const adapter = new NagerDateServiceAdapter(() => {});
    const params = adapter.params("usa", "ca", 2030);
    assert.equal(params.countryCode, "US");
    assert.equal(params.countyCode, "US-CA");

    const rand = makeRandom(13579);

    const payload = [];
    for (let i = 0; i < 300; i++) {
        const month = 1 + Math.floor(rand() * 14);      // 13/14 are invalid
        const day = 1 + Math.floor(rand() * 33);        // up to 33: overflow days
        const badFormat = rand() < 0.15;
        const date = badFormat ?
            `2030/${month}/${day}` :
            `2030-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const countyRoll = rand();
        const counties = countyRoll < 0.4 ? ["US-CA"] :
            countyRoll < 0.6 ? ["US-TX"] :
                countyRoll < 0.8 ? [] : ["US-TX", "US-CA"];
        const types = rand() < 0.5 ? ["Public"] : (rand() < 0.5 ? ["Optional"] : []);
        payload.push({
            date,
            name: `Holiday ${i}`,
            localName: rand() < 0.5 ? `Feriado ${i}` : `Holiday ${i}`,
            global: rand() < 0.2,
            counties,
            types
        });
    }

    const translated = adapter.translateResponse(payload, params);
    const again = adapter.translateResponse(payload, params);
    assert.deepEqual(again, translated, "translation is deterministic");

    for (const holiday of translated) {
        // only real calendar dates survive
        const probe = new Date(holiday.date.year, holiday.date.month - 1, holiday.date.day, 12);
        assert.equal(probe.getFullYear(), holiday.date.year);
        assert.equal(probe.getMonth(), holiday.date.month - 1);
        assert.equal(probe.getDate(), holiday.date.day);

        for (const flag of holiday.flags) {
            assert.equal(flag, flag.toLowerCase());
        }
        assert.ok(holiday.flags.length > 0, "empty types default to public");
        assert.ok(holiday.name.length >= 1);
        assert.equal(holiday.name.at(-1).lang, "en");
    }

    // the excluded rows are exactly the malformed dates and foreign counties
    const expected = payload.filter((row) =>
        /^2030-\d{2}-\d{2}$/.test(row.date) &&
        !Number.isNaN(new Date(row.date + "T12:00:00").getTime()) &&
        new Date(row.date + "T12:00:00").getDate() === Number(row.date.slice(8)) &&
        new Date(row.date + "T12:00:00").getMonth() + 1 === Number(row.date.slice(5, 7)) &&
        (row.counties.length === 0 || row.counties.indexOf("US-CA") !== -1)).length;
    assert.equal(translated.length, expected);
    assert.ok(translated.length > 0, "fuzz corpus keeps some valid rows");
});

test("HolidayServiceFallbackAdapter retries Enrico failures with Nager data", () => {
    const { Enrico, EnricoServiceAdapter, HolidayCache, HolidayServiceFallbackAdapter, NagerDateServiceAdapter } = loadHolidays();
    const primary = new EnricoServiceAdapter((_url, params, callback) => {
        callback(null, params, "Enrico failed");
    });
    const fallback = new NagerDateServiceAdapter((_url, params, callback) => {
        callback([
            {
                date: "2026-03-31",
                localName: "Cesar Chavez Day",
                name: "Cesar Chavez Day",
                counties: ["US-CA"],
                types: ["Public"]
            }
        ], params, NAGER_STAMP);
    });
    let saved = null;
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        (_country, data) => {
            saved = data;
        }
    );
    const enrico = new Enrico(new HolidayServiceFallbackAdapter(primary, fallback), cache);

    enrico.country = "usa";
    enrico.region = "ca";
    enrico.retrieveForYear(2026);

    assert.equal(enrico.last_error, "");
    assert.equal(enrico.last_provider, "Nager.Date");
    assert.deepEqual(enrico.cache.years[2026], { ca: NAGER_STAMP });
    assert.deepEqual(enrico.matchMonth(2026, 3).get("3/31"), ["Cesar Chavez Day", ["public_holiday"]]);
    assert.equal(saved.holidays.length, 1);
});

test("destroying the applet stops the provider chain instead of advancing it", () => {
    const { HolidayServiceFallbackAdapter } = loadHolidays();
    const tried = [];
    const provider = (name) => ({
        name,
        fetchYear(_country, _region, year, callback) {
            tried.push(name);
            // this is what the aborted session looks like from here
            callback(null, { year, region: "global", providerName: name }, null);
        },
        validResponse: (data) => Array.isArray(data)
    });
    const service = new HolidayServiceFallbackAdapter(provider("Enrico"),
        [provider("OpenHolidays"), provider("Nager.Date")]);

    let alive = true;
    service.setLivenessCheck(() => alive);

    // the applet is removed from the panel while Enrico's request is in flight
    alive = false;
    let answered = false;
    service.fetchYear("usa", "global", 2026, () => {
        answered = true;
    });

    assert.deepEqual(tried, ["Enrico"],
        "the abort does not walk the chain on to the other two providers");
    assert.equal(answered, false, "and nothing calls back into the destroyed applet");

    // an adapter nobody hands a liveness check to is always alive
    service.setLivenessCheck(null);
    service.fetchYear("usa", "global", 2026, () => {
        answered = true;
    });

    assert.deepEqual(tried, ["Enrico", "Enrico", "OpenHolidays", "Nager.Date"]);
    assert.equal(answered, true);
});

test("an empty answer from the primary does not end the provider chain", () => {
    const { Enrico, EnricoServiceAdapter, HolidayCache, HolidayServiceFallbackAdapter, NagerDateServiceAdapter } = loadHolidays();
    // Enrico answers [] for the country/year pairs it does not cover: a
    // well-formed payload that says "no holidays here"
    const primary = new EnricoServiceAdapter((_url, params, callback) => {
        callback([], params, "Enrico answered empty");
    });
    const fallback = new NagerDateServiceAdapter((_url, params, callback) => {
        callback([
            { date: "2026-03-31", localName: "Cesar Chavez Day", name: "Cesar Chavez Day", counties: ["US-CA"], types: ["Public"] }
        ], params, NAGER_STAMP);
    });
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    const enrico = new Enrico(new HolidayServiceFallbackAdapter(primary, fallback), cache);

    enrico.country = "usa";
    enrico.region = "ca";
    enrico.retrieveForYear(2026);

    assert.equal(enrico.last_provider, "Nager.Date",
        "the chain runs on instead of believing the empty answer");
    assert.deepEqual(enrico.matchMonth(2026, 3).get("3/31"), ["Cesar Chavez Day", ["public_holiday"]]);
});

test("an empty answer is believed once every provider gives one", () => {
    const { Enrico, EnricoServiceAdapter, HolidayCache, HolidayServiceFallbackAdapter, NagerDateServiceAdapter } = loadHolidays();
    const empty = (_url, params, callback) => callback([], params, "Sat, 04 Jul 2026 00:00:00 GMT");
    const primary = new EnricoServiceAdapter(empty);
    const fallback = new NagerDateServiceAdapter(empty);
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    const enrico = new Enrico(new HolidayServiceFallbackAdapter(primary, fallback), cache);

    enrico.country = "usa";
    enrico.region = "ca";
    enrico.retrieveForYear(2026);

    // a country really can have no holidays on file; that is not an error
    assert.equal(enrico.last_error, "");
    assert.equal(enrico.matchMonth(2026, 3).size, 0);
    assert.equal(enrico.staleCache(2026), false, "and the year is recorded, not refetched in a loop");
});

test("HolidayServiceFallbackAdapter tries OpenHolidays before Nager", () => {
    const { Enrico, EnricoServiceAdapter, HolidayCache, HolidayServiceFallbackAdapter, NagerDateServiceAdapter, OpenHolidaysServiceAdapter } = loadHolidays();
    const primary = new EnricoServiceAdapter((_url, params, callback) => {
        callback(null, params, "Enrico failed");
    });
    const openHolidays = new OpenHolidaysServiceAdapter((_url, params, callback) => {
        callback([
            {
                startDate: "2026-01-02",
                type: "Optional",
                name: [{ language: "EN", text: "Berchtold's Day" }],
                nationwide: false,
                subdivisions: [{ code: "CH-ZH", shortName: "ZH" }]
            }
        ], params, OPENHOLIDAYS_STAMP);
    });
    const nager = new NagerDateServiceAdapter(() => {
        throw new Error("Nager should not be called when OpenHolidays succeeds");
    });
    let saved = null;
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        (_country, data) => {
            saved = data;
        }
    );
    const enrico = new Enrico(new HolidayServiceFallbackAdapter(primary, [openHolidays, nager]), cache);

    enrico.country = "che";
    enrico.region = "zh";
    enrico.retrieveForYear(2026);

    assert.equal(enrico.last_error, "");
    assert.equal(enrico.last_provider, "OpenHolidays");
    assert.deepEqual(enrico.cache.years[2026], { zh: OPENHOLIDAYS_STAMP });
    assert.deepEqual(enrico.matchMonth(2026, 1).get("1/2"), ["Berchtold's Day", ["optional"]]);
    assert.equal(saved.holidays.length, 1);
});

// The chain validates every provider's answer against the record contract — the
// shape the app owns. These tests are about ordering and failure reporting, so
// they hand it a record that accepts anything.
function anyRecord() {
    return {
        validResponse: (data) => Array.isArray(data),
        expandHoliday: (holiday, region) => [{ holiday, region }]
    };
}

test("HolidayServiceFallbackAdapter tries the last successful provider first", () => {
    const { HolidayServiceFallbackAdapter } = loadHolidays();
    const calls = [];
    const primary = {
        name: "Primary",
        fetchYear(_country, _region, year, callback) {
            calls.push(`primary:${year}`);
            callback(null, { year, region: "global", providerName: "Primary" }, null);
        },
        params() {},
        url() {},
        localizeName() {},
        validHoliday() {},
        validResponse(data) {
            return Array.isArray(data);
        },
        expandHoliday() {}
    };
    const fallback = {
        name: "Fallback",
        fetchYear(_country, _region, year, callback) {
            calls.push(`fallback:${year}`);
            // a real row: an empty array is no longer taken as an answer
            callback([{ year, month: 1, day: 1, name: "New Year", flags: [] }],
                { year, region: "global", providerName: "Fallback" }, STAMP);
        }
    };
    const service = new HolidayServiceFallbackAdapter(primary, fallback, anyRecord());

    service.fetchYear("usa", "global", 2026, () => {});
    service.fetchYear("usa", "global", 2027, () => {});

    assert.deepEqual(calls, ["primary:2026", "fallback:2026", "fallback:2027"]);
});

test("expandHoliday spans month boundaries without corrupting dates", () => {
    const { HolidayRecordContract } = loadHolidays();
    const record = new HolidayRecordContract("en");

    function expand(from, to) {
        return record.expandHoliday({
            date: from,
            dateTo: to,
            name: [{ lang: "en", text: "Span" }],
            flags: []
        }, "global").map(({ year, month, day }) => `${year}-${month}-${day}`);
    }

    assert.deepEqual(
        expand({ year: 2026, month: 1, day: 30 }, { year: 2026, month: 2, day: 2 }),
        ["2026-1-30", "2026-1-31", "2026-2-1", "2026-2-2"]);
    assert.deepEqual(
        expand({ year: 2026, month: 4, day: 30 }, { year: 2026, month: 5, day: 2 }),
        ["2026-4-30", "2026-5-1", "2026-5-2"]);
    assert.deepEqual(
        expand({ year: 2026, month: 12, day: 31 }, { year: 2027, month: 1, day: 1 }),
        ["2026-12-31", "2027-1-1"]);

    // a dateTo equal to (or before) the start date must not grow the
    // holiday by a phantom extra day
    assert.deepEqual(
        expand({ year: 2026, month: 7, day: 9 }, { year: 2026, month: 7, day: 9 }),
        ["2026-7-9"]);
    assert.deepEqual(
        expand({ year: 2026, month: 7, day: 9 }, { year: 2026, month: 7, day: 8 }),
        ["2026-7-9"]);
});

test("both fallback adapters share one default provider order", () => {
    const holidays = loadHolidays();
    const ServiceAdapters = require(holidayServiceAdaptersPath);
    const { HOLIDAY_PROVIDER_NAMES } = require(holidayConstantsPath);
    const expected = [
        HOLIDAY_PROVIDER_NAMES.ENRICO,
        HOLIDAY_PROVIDER_NAMES.OPEN_HOLIDAYS,
        HOLIDAY_PROVIDER_NAMES.NAGER_DATE
    ];

    for (const chain of [new holidays.HolidayServiceFallbackAdapter(),
        new ServiceAdapters.HolidayServiceFallbackAdapter()]) {
        assert.deepEqual([chain.primary.name].concat(chain.fallbacks.map((f) => f.name)),
            expected);
    }

    // explicit arguments still bypass the default chain
    const custom = new holidays.HolidayServiceFallbackAdapter(
        { name: "p", validResponse: () => true }, [{ name: "f" }]);
    assert.equal(custom.primary.name, "p");
    assert.deepEqual(custom.fallbacks.map((f) => f.name), ["f"]);
});

test("service adapters fail loudly without an injected JSON loader", () => {
    loadHolidays();
    const { EnricoServiceAdapter } = require(holidayServiceAdaptersPath);
    const adapter = new EnricoServiceAdapter(undefined);

    assert.throws(() => adapter.fetchYear("usa", "global", 2026, () => {}),
        /holiday service adapter has no JSON loader/);
});

test("IsoHolidayServiceAdapter owns generic translation and unsupported-country callbacks", () => {
    const { HOLIDAY_ERRORS } = loadHolidays();
    const { IsoHolidayServiceAdapter } = require(holidayServiceAdaptersPath);

    class TestIsoAdapter extends IsoHolidayServiceAdapter {
        constructor() {
            super((_url, params, callback) => {
                callback([{ date: "2026-01-01", name: "New Year", flags: ["public_holiday"] }], params, STAMP);
            });
            this.name = "TestIso";
        }

        params(country, _region, year) {
            return { year, countryCode: country === "missing" ? null : "TC" };
        }

        url() {
            return "https://example.test/holidays";
        }

        _validHoliday(holiday) {
            return holiday && typeof holiday.date === "string";
        }

        _matchesRegion() {
            return true;
        }

        _flags(holiday) {
            return holiday.flags;
        }

        _name(holiday) {
            return [{ lang: "en", text: holiday.name }];
        }
    }

    const adapter = new TestIsoAdapter();
    assert.deepEqual(adapter.translateResponse({ error: "upstream" }, {}), { error: "upstream" });

    let missing;
    adapter.fetchYear("missing", "global", 2026, (data, params, retrieved) => {
        missing = { data, params, retrieved };
    });
    assert.deepEqual(missing.data, { error: HOLIDAY_ERRORS.SERVICE_UNAVAILABLE });
    assert.equal(missing.retrieved, null);

    let translated;
    adapter.fetchYear("present", "global", 2026, (data, params, retrieved) => {
        translated = { data, params, retrieved };
    });
    assert.deepEqual(translated.data, [{
        date: { year: 2026, month: 1, day: 1 },
        name: [{ lang: "en", text: "New Year" }],
        flags: ["public_holiday"]
    }]);
    assert.equal(translated.params.providerName, "TestIso");
    assert.equal(translated.retrieved, STAMP);
});

test("EnricoServiceAdapter builds params and the record localizes and expands", () => {
    const { EnricoServiceAdapter, HolidayRecordContract } = loadHolidays();
    // params/url are the adapter's; validate/expand/localize are the record's
    const adapter = new EnricoServiceAdapter(() => {});
    const record = new HolidayRecordContract("it");
    const rows = record.expandHoliday({
        date: { year: 2026, month: 4, day: 24 },
        dateTo: { year: 2026, month: 4, day: 26 },
        name: [
            { lang: "en", text: "Liberation" },
            { lang: "it", text: "Liberazione" }
        ],
        flags: ["public_holiday"]
    }, "global");

    assert.equal(rows[0].name, "Liberazione");
    assert.ok(rows.length >= 2);
    assert.deepEqual(adapter.params("ita", "global", 2026), {
        year: 2026,
        country: "ita",
        holidayType: "public_holiday"
    });
    assert.deepEqual(adapter.params("ita", "rm", 2026), {
        year: 2026,
        country: "ita",
        holidayType: "public_holiday",
        region: "rm"
    });
    assert.ok(adapter.url(adapter.params("ita", "rm", 2026)).includes("region=rm"));
    assert.ok(adapter.url(adapter.params("u sa", "new york", 2026)).includes("country=u%20sa"));
    assert.ok(adapter.url(adapter.params("u sa", "new york", 2026)).includes("region=new%20york"));
});

test("the record contract falls back to the first holiday name", () => {
    const { HolidayRecordContract } = loadHolidays();
    const record = new HolidayRecordContract("it");

    assert.equal(record.localizeName({
        name: [
            { lang: "fr", text: "Fete" },
            { lang: "de", text: "Feiertag" }
        ]
    }), "Fete");
});

test("the version shim forwards the shared provider module", () => {
    const shared = {
        Provider: class {},
        HolidayCacheRepository: class {},
        HolidayCache: class {},
        EnricoServiceAdapter: class {},
        NagerDateServiceAdapter: class {},
        OpenHolidaysServiceAdapter: class {},
        HolidayServiceFallbackAdapter: class {},
        Enrico: class {},
        HolidayProviderFacade: class {},
        HOLIDAY_ERRORS: {}
    };
    const context = {
        module: { exports: null },
        imports: {
            ui: {
                appletManager: {
                    applets: {
                        "chronos@geraldo-netto": { holidays: shared }
                    }
                }
            }
        }
    };

    vm.createContext(context);
    vm.runInContext(fs.readFileSync(shimPath, "utf8"), context);

    assert.equal(context.module.exports, shared);
});

test("HolidayProviderFacade exposes only place and holiday retrieval", () => {
    const { HolidayProviderFacade } = loadHolidays();
    const calls = [];
    const provider = {
        country: "ita",
        region: "global",
        destroy: () => calls.push(["destroy"]),
        clearPlace: () => calls.push(["clear"]),
        setPlace: (country, region) => calls.push(["set", country, region]),
        matchMonth: (year, month) => new Map([["key", [year, month]]]),
        getHolidays: (year, month, callback) => {
            calls.push(["get", year, month]);
            callback(new Map(), "", "stub");
        }
    };
    const facade = new HolidayProviderFacade(provider);
    let holidays = null;

    assert.equal(facade.country, "ita");
    facade.setPlace("usa", "ca");
    facade.clearPlace();
    facade.getHolidays(2026, 7, (value) => { holidays = value; });
    facade.destroy();

    assert.ok(holidays instanceof Map);
    assert.deepEqual(calls, [
        ["set", "usa", "ca"],
        ["clear"],
        ["get", 2026, 7],
        ["destroy"]
    ]);
    assert.equal("retrieveForYear" in facade, false);
});

// The chain used to validate and expand every provider's payload with the
// *primary's* validator, so the port's contract was one vendor's payload shape:
// the two ISO adapters had to reshape their answers into Enrico's wire format to
// get past a check that belonged to Enrico. A provider that did not was rejected
// as INVALID_RESPONSE with nothing to say the validator was the wrong one.
test("the chain validates against the record contract, not against the primary", () => {
    const { HolidayServiceFallbackAdapter, HolidayRecordContract } = loadHolidays();
    // a primary with no validator of its own at all — which is what Nager.Date
    // and OpenHolidays are
    const primary = { name: "primary", fetchYear() {} };
    const adapter = new HolidayServiceFallbackAdapter(primary, [], new HolidayRecordContract("en"));

    const record = {
        date: { year: 2026, month: 7, day: 14 },
        name: [{ lang: "en", text: "Bastille Day" }],
        flags: []
    };

    assert.equal(adapter.validResponse([record]), true);
    assert.equal(adapter.validResponse([{ nope: true }]), false,
        "a payload that is not a holiday record is refused whoever sent it");
    assert.deepEqual(adapter.expandHoliday(record, "global"), [
        { year: 2026, month: 7, day: 14, name: "Bastille Day", flags: [], region: "global" }
    ]);
});

// and the contract can be handed in: a chain is free to speak a shape of its own
test("a chain can be given the record shape it speaks", () => {
    const { HolidayServiceFallbackAdapter } = loadHolidays();
    const adapter = new HolidayServiceFallbackAdapter(
        { name: "primary", fetchYear() {} }, [], anyRecord());

    assert.equal(adapter.validResponse([]), true);
    assert.deepEqual(adapter.expandHoliday("h", "global"), [{ holiday: "h", region: "global" }]);
});

test("HolidayServiceFallbackAdapter reports provider success and failure", () => {
    const { HolidayServiceFallbackAdapter } = loadHolidays();
    const good = {
        name: "good",
        fetchYear(_country, _region, year, cb) {
            cb([{ year }], { provider: "good" }, new Date(2026, 0, 1));
        }
    };
    const bad = {
        name: "bad",
        validResponse: (data) => Array.isArray(data),
        fetchYear(_country, _region, year, cb) {
            cb(null, { provider: "bad", year }, null);
        }
    };
    const adapter = new HolidayServiceFallbackAdapter(bad, [good], anyRecord());
    const callbacks = [];
    adapter.fetchYear("ita", "global", 2026, (...args) => callbacks.push(args));
    assert.deepEqual(callbacks[0][0], [{ year: 2026 }]);
    assert.equal(callbacks[0][1].provider, "good");
    assert.equal(adapter._last_provider, "good");

    const allBad = new HolidayServiceFallbackAdapter(bad, [], anyRecord());
    const failures = [];
    const exhaustedLogs = [];
    global.log = (message) => exhaustedLogs.push(message);
    allBad.fetchYear("ita", "global", 2027, (...args) => failures.push(args));
    assert.equal(failures[0][0], null);
    assert.equal(failures[0][1].provider, "bad");
    assert.equal(exhaustedLogs.at(-1), "all holiday providers failed for ita/global/2027");
});

// The point of the record contract: Enrico is the flakiest of the three
// providers, and dropping it used to break the other two — they were validated
// and expanded by *its* validator. A chain of the two ISO providers, with no
// Enrico anywhere in it, has to work.
test("the chain works with no Enrico in it at all", () => {
    const {
        HolidayServiceFallbackAdapter, HolidayRecordContract,
        OpenHolidaysServiceAdapter, NagerDateServiceAdapter
    } = loadHolidays();

    const openHolidays = new OpenHolidaysServiceAdapter((url, params, callback) => {
        void url;
        callback([{
            startDate: "2026-07-14",
            nationwide: true,
            type: "Public",
            name: [{ language: "EN", text: "Bastille Day" }]
        }], params, STAMP);
    }, "en");
    const nager = new NagerDateServiceAdapter((url, params, callback) => {
        void url;
        callback([], params, STAMP);
    });

    const chain = new HolidayServiceFallbackAdapter(
        openHolidays, [nager], new HolidayRecordContract("en"));

    const answers = [];
    chain.fetchYear("fra", "global", 2026, (data, params) => answers.push([data, params]));

    const [data, params] = answers[0];
    assert.equal(params.providerName, "OpenHolidays");
    assert.equal(chain.validResponse(data), true,
        "the ISO provider's answer is a record, and the record contract says so");
    assert.deepEqual(chain.expandHoliday(data[0], "global"), [{
        year: 2026, month: 7, day: 14, name: "Bastille Day",
        flags: ["public_holiday"], region: "global"
    }]);
});

// Enrico built a real HolidayCacheRepository in its constructor whether or not a
// cache was injected — resolving a path, creating a directory — for an object
// that could never be used.
test("a provider given a cache does not build a repository it cannot use", () => {
    const { Enrico } = loadHolidays();
    const cache = {
        country: "ita", region: "global", years: {}, data: [],
        setPlace() {}, setData() {}, clearPlace() {}, recordAttempt() {},
        recordFetch() {}, prune() {}, persist() {}, stale: () => false,
        matchMonth: () => new Map()
    };

    const enrico = new Enrico({ fetchYear() {} }, cache);

    assert.equal(enrico.cache, cache);
    assert.equal(enrico.cacheRepository, undefined,
        "no repository is built when nothing will back the cache with it");

    // ...and it is built, and used, when it is the thing backing the cache
    const loads = [];
    const repository = {
        loadAsync: (country, done) => { loads.push(country); done({ years: {}, holidays: [] }); },
        save: () => {}
    };
    const backed = new Enrico({ fetchYear() {} }, null, { cacheRepository: repository });
    backed.cache.setPlace("fra", "global", () => {});
    assert.deepEqual(loads, ["fra"]);
});

test("the status ledger keeps one record per year and region, and prunes", () => {
    const { HolidayStatusLedger } = loadHolidays();
    const ledger = new HolidayStatusLedger(1);

    assert.deepEqual(ledger.for("2026/global"), { error: "", provider: "" });

    ledger.lastError = "Holiday data unavailable";
    ledger.lastProvider = "Enrico";
    ledger.record("2026/global");
    assert.deepEqual(ledger.for("2026/global"),
        { error: "Holiday data unavailable", provider: "Enrico" });

    ledger.lastError = "";
    ledger.record("2019/global");
    ledger.prune(new Date(2026, 0, 1));
    assert.deepEqual(ledger.for("2019/global"), { error: "", provider: "" },
        "a year the grid can no longer reach is not worth a status record");
    assert.equal(ledger.for("2026/global").provider, "Enrico");

    ledger.clear();
    assert.equal(ledger.lastError, "");
    assert.equal(ledger.lastProvider, "");
    assert.deepEqual(ledger.for("2026/global"), { error: "", provider: "" });
});

test("the inflight ledger joins a running fetch instead of starting a second", () => {
    const { HolidayInflight } = loadHolidays();
    const inflight = new HolidayInflight();
    const answered = [];

    assert.equal(inflight.has("2026/global"), false);
    assert.equal(inflight.start("2026/global", () => answered.push("first")), true,
        "the first caller starts the fetch");
    assert.equal(inflight.has("2026/global"), true);
    assert.equal(inflight.start("2026/global", () => answered.push("second")), false,
        "the second month of the grid joins it");

    const callbacks = inflight.settle("2026/global");
    callbacks.forEach((callback) => callback());

    assert.deepEqual(answered, ["first", "second"], "everyone waiting is answered");
    assert.equal(inflight.has("2026/global"), false);

    // a fetch with nobody waiting is still a fetch in flight
    assert.equal(inflight.start("2027/global"), true);
    assert.equal(inflight.has("2027/global"), true);
    inflight.clear();
    assert.equal(inflight.has("2027/global"), false);
});

// ...and with nothing replaced at all, the root builds the real thing: one HTTP
// session, built on first fetch, shared by the three adapters and aborted on
// destroy.
test("the composition root builds one session, lazily, and aborts it", () => {
    const soup = makeSoup3({ data: JSON.stringify([]) });
    const { createHolidayProvider } = loadHolidays({ soup });

    const provider = createHolidayProvider({ lang: "en", cache: makeMemoryCache() });
    const enrico = provider._provider;

    assert.equal(soup.sessions.length, 0,
        "holidays may never be shown: no session until something asks");

    provider.setPlace("fra", "global", () => {});

    assert.equal(soup.sessions.length, 1, "one session for the whole chain");
    assert.equal(enrico._session.get(), soup.sessions[0], "and it is reused");

    provider.destroy();
    assert.equal(soup.sessions[0].aborted, true);
});

// The graph used to assemble itself through default arguments across three
// files, so nothing could substitute anything: the composition root is what
// makes one node replaceable without replacing the rest.
test("the holiday composition root wires the shipped graph", () => {
    const { createHolidayProvider, HolidayRecordContract } = loadHolidays();
    const requested = [];

    // one seam replaced — the HTTP loader — and everything above and below it is
    // still the wiring the applet ships
    const provider = createHolidayProvider({
        lang: "en",
        load: (url, params, callback) => {
            requested.push(url);
            callback([{
                date: { year: 2026, month: 7, day: 14 },
                name: [{ lang: "en", text: "Bastille Day" }],
                flags: []
            }], params, STAMP);
        },
        cache: makeMemoryCache()
    });

    const answers = [];
    provider.setPlace("fra", "global", () => answers.push("updated"));

    assert.ok(requested[0].startsWith("https://kayaposoft.com/enrico/"),
        "Enrico is still the primary");
    assert.deepEqual(answers, ["updated"]);

    const months = [];
    provider.getHolidays(2026, 7, (dates, error) => months.push([dates, error]));
    const [dates, error] = months[0];
    assert.equal(error, "");
    assert.deepEqual(dates.get("7/14"), ["Bastille Day", []]);

    // and the record contract is the chain's, not the primary adapter's
    assert.ok(new HolidayRecordContract("en").validResponse([{
        date: { year: 2026, month: 7, day: 14 },
        name: [{ lang: "en", text: "Bastille Day" }],
        flags: []
    }]));
});

function makeMemoryCache() {
    const { HolidayCache } = loadHolidays();
    return new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
}

// T352: the stale-generation branch used to delete the inflight entry
// unconditionally — but setPlace() had already emptied that map, and the NEW
// place's request had refilled it under the same `${year}/${region}` key. So the
// old country's response deleted the new country's callbacks: the new response
// found nobody waiting, nothing repainted, and the month label stayed on the old
// country until the user scrolled a month or reopened the menu.
test("a response from the country the user just left does not silence the new one", () => {
    const { createHolidayProvider } = loadHolidays();
    const pending = [];
    const provider = createHolidayProvider({
        lang: "en",
        cache: makeMemoryCache(),
        load: (url, params, callback) => pending.push({ params, callback })
    });
    const enrico = provider._provider;

    const repaints = [];
    provider.setPlace("bra", "global", () => repaints.push("bra"));
    assert.equal(pending.length, 1, "Brazil is being fetched");
    const brazil = pending.shift();

    // the user picks France while Brazil is still in flight
    provider.setPlace("fra", "global", () => repaints.push("fra"));
    assert.equal(pending.length, 1, "and France is fetched for the new place");
    const france = pending.shift();

    // Brazil's answer lands late. It belongs to a place that is gone.
    brazil.callback([{
        date: { year: new Date().getFullYear(), month: 9, day: 7 },
        name: [{ lang: "en", text: "Independência do Brasil" }],
        flags: []
    }], brazil.params, STAMP);

    assert.deepEqual(repaints, [], "the abandoned country repaints nothing");
    assert.equal(enrico.fetching(new Date().getFullYear()), true,
        "and France's request is still live, so nothing refetches it");

    // ...and France's answer still reaches the calendar
    france.callback([{
        date: { year: new Date().getFullYear(), month: 7, day: 14 },
        name: [{ lang: "en", text: "Bastille Day" }],
        flags: []
    }], france.params, STAMP);

    assert.deepEqual(repaints, ["fra"], "the country the user is actually on repaints");
    assert.equal(enrico.country, "fra");

    const months = [];
    provider.getHolidays(new Date().getFullYear(), 7, (dates) => months.push(dates));
    assert.deepEqual(months[0].get("7/14"), ["Bastille Day", []]);
});

// Every dimension of a holiday payload was bounded except the one that
// multiplies. The body is capped at 4 MiB and each holiday's span at 366 days —
// but nothing capped how MANY holidays it carries, and expandHoliday materialises
// holidays × span rows synchronously on the compositor thread, before any dedup
// can look at them. A 4 MiB body of ~33,000 minimal-but-valid entries, each
// spanning a year, is twelve million objects in one loop.
test("a payload with an absurd number of holidays is refused, not expanded", () => {
    const { HolidayRecordContract, MAX_HOLIDAYS_PER_YEAR } = loadHolidays();
    const record = new HolidayRecordContract("en");

    const holiday = (day) => ({
        date: { year: 2026, month: 1, day: (day % 28) + 1 },
        name: [{ lang: "en", text: "H" }],
        flags: []
    });

    const sane = Array.from({ length: MAX_HOLIDAYS_PER_YEAR }, (_u, i) => holiday(i));
    assert.equal(record.validResponse(sane), true, "a big but sane year is still fetched");

    const absurd = Array.from({ length: MAX_HOLIDAYS_PER_YEAR + 1 }, (_u, i) => holiday(i));
    assert.equal(record.validResponse(absurd), false,
        "no country has this many public holidays; this is a broken or hostile endpoint");
});

test("the rows a payload expands to are bounded too", () => {
    const { Enrico, MAX_EXPANDED_HOLIDAY_ROWS } = loadHolidays();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    const enrico = new Enrico({
        fetchYear() {},
        // a hundred holidays, each spanning a year: a valid payload, and 36,600
        // rows on the compositor thread
        expandHoliday: () => Array.from({ length: 366 }, (_u, day) => ({
            year: 2026, month: 1, day: (day % 28) + 1, name: "H", flags: [], region: "global"
        }))
    }, makeMemoryCache());

    const expanded = enrico.expandData(Array.from({ length: 100 }, () => ({})), "global");

    assert.equal(expanded.length, MAX_EXPANDED_HOLIDAY_ROWS,
        "the expansion stops at the cap instead of building 36,600 rows");
    assert.ok(logged.some((line) => /expands past/.test(line)), "and it says so");
});
