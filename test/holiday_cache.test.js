const {
    assert, test, fs, makeRandom, makeSoup3, FIXED_YEAR, STAMP,
    holidayCachePath, holidayRecordPath, holidayServiceAdaptersPath,
    loadCountry, loadJson, cachePath, loadHolidays, holiday, anyRecord
} = require("./helpers/holidayFixture");

test("retrieveForYear without a country reports instead of throwing", () => {
    const Holidays = loadHolidays();
    const enrico = new Holidays.HolidayService({ fetchYear() { throw new Error("no fetch expected"); } }, {
        years: {}, country: null, region: "global", data: [],
        recordAttempt() {}, setData() {}
    });

    let called = 0;
    assert.doesNotThrow(() => enrico.retrieveForYear(2026, () => called++));
    assert.equal(called, 1, "callback still fires so the UI can settle");
    assert.equal(enrico.last_error, Holidays.HOLIDAY_ERRORS.SERVICE_UNAVAILABLE);
});

test("clearPlace disables the provider and resets status", () => {
    const { HolidayService } = loadHolidays();
    const cache = {
        years: {}, country: "ita", region: "global", data: [],
        recordAttempt() {}, setPlace() {}, setData() {},
        clearPlace() { this.country = null; }
    };
    const enrico = new HolidayService({ fetchYear() {} }, cache);
    enrico.last_error = "boom";
    enrico.clearPlace();
    assert.equal(enrico.country, null);
    assert.equal(enrico.last_error, "");
    assert.equal(enrico.last_provider, "");
});

test("HolidayCache owns fetched holiday persistence and place clearing", () => {
    const { HolidayCache } = loadHolidays();
    const saves = [];
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), (country, data) => {
        saves.push([country, data]);
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
    assert.deepEqual(saves, []);

    cache.persist();
    assert.equal(saves.length, 1);
    assert.equal(saves[0][0], "ita");
    assert.equal(saves[0][1].holidays.length, 1);

    cache.clearPlace();
    assert.equal(cache.country, null);
    cache.persist();
    assert.equal(saves.length, 1,
        "the real cache never asks its repository to save a null country");
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
    const { HolidayService } = loadHolidays();
    let fetchCallback = null;
    const service = {
        fetchYear: (_country, _region, _year, callback) => { fetchCallback = callback; },
        validResponse: () => true,
        expandHoliday: (holiday) => [holiday]
    };
    const enrico = new HolidayService(service, undefined, { record: service });
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

test("HolidayService expands provider rows before recording cache fetches", () => {
    const { HolidayService } = loadHolidays();
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
    const enrico = new HolidayService(service, cache, { record: service });

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
    const { HolidayService } = loadHolidays();
    const cache = {
        country: "ita", region: "global", years: {}, data: [],
        recordAttempt() {}, setPlace() {}, setData() {}, clearPlace() {},
        recordFetch() { this.recorded = true; },
        prune() { this.pruned = true; },
        persist() { this.persisted = true; }
    };
    const enrico = new HolidayService({
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

// The tests above feed out-of-range *integers*. Every type guard in the validator
// survived mutation because nothing ever fed it a wrong *type* — and the wire is
// where the wrong types come from: Enrico hands date:{year,month,day} straight off
// the network into this.
//
// A string month is the one that bites. The roundtrip check coerces ("5" - 1 is
// 4), so without Number.isInteger the record is accepted, persisted — and then
// rejected on reload by validCachedHoliday, which does check. The two validators
// would disagree about the same row.
test("a holiday date off the wire is rejected unless its parts are integers", () => {
    const Holidays = loadHolidays();
    const record = new Holidays.HolidayRecordContract();
    const base = { name: [{ lang: "en", text: "X" }], flags: [] };
    const valid = { year: 2026, month: 5, day: 5 };

    assert.ok(record.validHoliday({ ...base, date: valid }));

    for (const [field, hostile] of [
        ["year", "2026"], ["month", "5"], ["day", "5"],
        ["year", 2026.5], ["month", 5.5], ["day", 5.5],
        ["year", null], ["month", undefined], ["day", true],
        ["month", [5]], ["day", { valueOf: () => 5 }]
    ]) {
        const date = { ...valid, [field]: hostile };
        assert.ok(!record.validHoliday({ ...base, date }),
            `${field}=${JSON.stringify(hostile)} is not a date part`);
    }

    // and what the cache accepts on reload is the same rule, so a record that was
    // persisted can always be read back
    const { validCachedHoliday } = require(holidayCachePath);
    assert.ok(validCachedHoliday(
        { year: 2026, month: 5, day: 5, name: "X", flags: [], region: "global" }));
    assert.ok(!validCachedHoliday(
        { year: 2026, month: "5", day: 5, name: "X", flags: [], region: "global" }));
});

// Every per-row type guard in the two ISO adapters survived mutation: without
// them a *single* malformed row stops being "skip that row" and becomes "reject
// the whole country's payload", which fails the chain over to the next provider —
// so one bad row from Nager loses every good row with it.
test("one malformed row is dropped; the rest of the country's holidays survive", () => {
    const Holidays = loadHolidays();
    const params = { year: 2026, countryCode: "IT", region: "global", lang: "en" };

    const nager = new Holidays.NagerDateServiceAdapter(() => {});
    const nagerRows = [
        { date: "2026-01-01", name: "New Year", localName: "Capodanno" },
        { date: 20260101, name: "A number is not a date" },
        { date: "2026-05-01", name: 42 },
        { date: "2026-05-01", name: "Labour Day", counties: "not an array" },
        { date: "2026-12-25", name: "Christmas" }
    ];
    const nagerOut = nager.translateResponse(nagerRows, params);
    assert.deepEqual(nagerOut.map((holiday) => holiday.date.month), [1, 12],
        "the two well-formed rows come through, and only those");

    const open = new Holidays.OpenHolidaysServiceAdapter(() => {}, "en");
    const openRows = [
        { startDate: "2026-01-01", name: [{ language: "EN", text: "New Year" }] },
        { startDate: null, name: [{ language: "EN", text: "No date" }] },
        { startDate: "2026-05-01", name: "not a list" },
        { startDate: "2026-05-01", name: [] },
        { startDate: "2026-12-25", name: [{ language: "EN", text: "Christmas" }], endDate: 7 },
        { startDate: "2026-12-26", name: [{ language: "EN", text: "St Stephen" }] }
    ];
    const openOut = open.translateResponse(openRows, params);
    assert.deepEqual(openOut.map((holiday) => holiday.date.month), [1, 12],
        "a bad endDate, a bad name and a missing date each cost their own row");

    // the payload is a list of records either way — not the INVALID_RESPONSE that
    // a throw here would have been read as
    for (const out of [nagerOut, openOut]) {
        assert.ok(Array.isArray(out));
        assert.ok(new Holidays.HolidayRecordContract().validResponse(out));
    }
});

// REGRESSION: teardown released the timers, the signals and the HTTP session, and
// kept every heavy structure the applet had built. Cinnamon's Applet base class
// has no destroy(), and AppletContextMenu holds the applet's actor, which holds
// _delegate — so the applet object survives its removal from the panel, and with
// it a year of holidays for every year the user ever scrolled to. Ten add/remove
// cycles retained 38 MiB.
// The persisted copy was windowed to ±1 year; the live structures were not, so
// `data`, both indexes, `years` and `attempts` grew with every year the user
// scrolled to and kept growing for the session — 60 years of a 15-holiday country
// measured 469 KiB, and the ceiling is MAX_EXPANDED_HOLIDAY_ROWS × years browsed.
//
// The prune is an LRU on use rather than a window around today, because a window
// is what _windowedForPersist's comment warns about: it dropped a just-fetched
// out-of-window year and the stamp that throttles it, and the year was then
// refetched on every calendar update, forever.
test("the years the user scrolled past are not kept for the session", () => {
    const { HolidayCache } = loadHolidays();
    const { MAX_CACHED_YEARS } = require(holidayCachePath);
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    cache.setPlace("ita", "global");

    const fetchYear = (year) => cache.recordFetch(year, "global", new Date().toUTCString(),
        [{ year, month: 1, day: 1, region: "global", name: "New Year", flags: [] }]);

    for (let year = 2000; year < 2060; year++) {
        fetchYear(year);
    }

    assert.equal(cache._yearUse.size, MAX_CACHED_YEARS, "the browsing is bounded");
    assert.equal(cache.data.length, MAX_CACHED_YEARS);
    assert.deepEqual(Object.keys(cache.years).map(Number).sort((a, b) => a - b),
        Array.from({ length: MAX_CACHED_YEARS }, (_, i) => 2059 - MAX_CACHED_YEARS + 1 + i),
        "the years kept are the ones last used");

    // an evicted year keeps neither its rows nor its freshness stamp: it is stale
    // again, which is the only state that is not a lie
    assert.equal(cache.matchMonth(2000, 1).size, 0);
    assert.equal(cache.stale(2000, "global"), true);

    // and the year the user is looking at survives a fetch of another year — the
    // read touches it, so it is never the least recently used one
    cache.matchMonth(2055, 1);
    fetchYear(2060);
    assert.equal(cache.matchMonth(2055, 1).size, 1, "the year on screen is still there");
});

test("destroying the provider drops the holidays it was holding", () => {
    const { HolidayCache } = loadHolidays();
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});

    cache.setPlace("ita", "global");
    for (let year = 1990; year < 2030; year++) {
        for (let day = 1; day <= 12; day++) {
            cache.addUnique({ year, month: 1, day, region: "global", name: "Holiday", flags: [] });
        }
        cache.recordAttempt(year, "global");
    }
    assert.ok(cache.data.length > 400, "the session's browsing, as the cache holds it");
    assert.ok(cache.matchMonth(2026, 1).size > 0, "and the derived month index");

    cache.release();

    assert.deepEqual(cache.data, []);
    assert.deepEqual(cache.years, {});
    assert.deepEqual(cache.attempts, {});
    assert.equal(cache.matchMonth(2026, 1).size, 0, "the indexes go with the data");
});

test("HolidayService.destroy aborts its own session and silences late callbacks", () => {
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
    const enrico = new Holidays.HolidayService(service, cache, { record: service });
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

    const enrico = new Holidays.HolidayService();
    assert.equal(instances.length, 0, "still lazy after construction");

    enrico._getHttpSession();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].timeout, Holidays.HTTP_TIMEOUT_SECONDS);
    assert.equal(instances[0].idle_timeout, Holidays.HTTP_TIMEOUT_SECONDS);

    enrico._getHttpSession();
    assert.equal(instances.length, 1, "session reused");

    // a second applet instance owns a separate session, so destroying one
    // never aborts the other's in-flight requests
    const other = new Holidays.HolidayService();
    other._getHttpSession();
    assert.equal(instances.length, 2);

    // the default service fetches through the session its own provider owns
    const fetching = new Holidays.HolidayService();
    fetching.country = "usa";
    fetching.region = "global";
    fetching.retrieveForYear(2026);
    assert.equal(instances.length, 3);
    assert.equal(instances[2].timeout, Holidays.HTTP_TIMEOUT_SECONDS);
});

test("HolidayCacheRepository reads and writes the per-country cache file", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json");

    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("holidays.json"), JSON.stringify({
        usa: {
            years: { 2026: { global: "Mon, 05 Jan 2026 00:00:00 GMT" } },
            holidays: [{ year: 2026, month: 1, day: 1, region: "global", name: "New Year", flags: [] }]
        }
    }));

    assert.deepEqual(loadCountry(repository, "usa").years, { 2026: { global: "Mon, 05 Jan 2026 00:00:00 GMT" } });

    repository.save("usa", { years: {}, holidays: [] });

    assert.equal(HolidayCacheRepository.path, cachePath());
    const written = JSON.parse(fs.readFileSync(cachePath("holidays.json"), "utf8"));
    assert.deepEqual(Object.keys(written), ["usa"]);
    assert.deepEqual(written.usa.years, {});
    assert.deepEqual(written.usa.holidays, []);
    // when the blob was last written: what the country eviction sorts on
    assert.ok(Number.isFinite(written.usa.savedAt));
});

// The cache file was named after one of the three providers; renaming it to
// holidays.json would orphan every installed user's cache — a year of holidays
// per country, refetched over the network — unless the old path is read once.
const LEGACY_CACHE = {
    usa: {
        years: { 2026: { global: "Mon, 05 Jan 2026 00:00:00 GMT" } },
        holidays: [{ year: 2026, month: 1, day: 1, region: "global", name: "New Year", flags: [] }]
    }
};

test("the service reads the renamed cache file, and knows the name it had before", () => {
    const { HolidayService, HolidayCacheRepository } = loadHolidays();

    assert.equal(HolidayService.fn, "/holidays.json");
    assert.equal(HolidayCacheRepository.LEGACY_FN, "/enrico.json");
});

test("an upgrade with no new cache file yet reads the pre-rename one", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json");

    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("enrico.json"), JSON.stringify(LEGACY_CACHE));

    const loaded = loadCountry(repository, "usa");
    assert.deepEqual(loaded.years, { 2026: { global: "Mon, 05 Jan 2026 00:00:00 GMT" } });
    assert.equal(loaded.holidays.length, 1, "the cached holidays survive the rename");
});

test("the migrated cache is written to the new file, and the old one is left alone", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json");

    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("enrico.json"), JSON.stringify(LEGACY_CACHE));

    loadCountry(repository, "usa");
    repository.save("ita", { years: {}, holidays: [] });

    const written = JSON.parse(fs.readFileSync(cachePath("holidays.json"), "utf8"));
    assert.deepEqual(Object.keys(written).sort(), ["ita", "usa"],
        "the migrated country is merged with the new save");

    // the old file is not rewritten and not deleted: a user who downgrades still
    // has it, and this applet never reads it again once the new one has content
    assert.deepEqual(JSON.parse(fs.readFileSync(cachePath("enrico.json"), "utf8")), LEGACY_CACHE);
});

test("a new cache file with content wins over the pre-rename one", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json");

    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("enrico.json"), JSON.stringify(LEGACY_CACHE));
    fs.writeFileSync(cachePath("holidays.json"), JSON.stringify({
        usa: {
            years: { 2026: { global: "Fri, 10 Jul 2026 10:00:00 GMT" } },
            holidays: []
        }
    }));

    // the migration is one-shot: once the new file has anything, the old one is
    // stale by definition and reading it back would resurrect evicted countries
    assert.deepEqual(loadCountry(repository, "usa").years,
        { 2026: { global: "Fri, 10 Jul 2026 10:00:00 GMT" } });
});

test("a repository pointed at the pre-rename file does not fall back to itself", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository(HolidayCacheRepository.LEGACY_FN);

    fs.mkdirSync(cachePath(), { recursive: true });

    assert.deepEqual(loadCountry(repository, "usa"), { years: {}, holidays: [] });
});

// prune() trims the years of the country in use; the per-country blobs of every
// country the user ever tried were kept forever, and _flush re-reads the whole
// file on every successful fetch.
test("the cache file keeps a handful of countries, not every one ever tried", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const { MAX_CACHED_COUNTRIES } = require(holidayCachePath);
    let clock = 1000;
    const repository = new HolidayCacheRepository("/holidays.json", { now: () => clock++ });

    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("holidays.json"), "{}");

    const tried = ["usa", "ita", "fra", "deu", "jpn", "bra", "can"];
    for (const country of tried) {
        repository.save(country, { years: {}, holidays: [] });
    }

    const written = JSON.parse(fs.readFileSync(cachePath("holidays.json"), "utf8"));
    assert.equal(Object.keys(written).length, MAX_CACHED_COUNTRIES);

    // the ones kept are the ones most recently looked at
    assert.deepEqual(Object.keys(written).sort(),
        tried.slice(-MAX_CACHED_COUNTRIES).sort());

    // ...and the in-memory pending map is not a second, unbounded copy of the
    // file. It held a year-of-holidays blob for every country the session ever
    // selected — up to all 58 while the user browses the settings dialog — and
    // re-merged the lot into the file on every later flush, which is the bound
    // MAX_CACHED_COUNTRIES was added to enforce.
    assert.deepEqual(repository._pending, {},
        "what is on disk is not also held in memory");
});

test("the month-match memo is bounded, and scrolling back is still free", () => {
    const { HolidayCache } = loadHolidays();
    const { MAX_MEMOIZED_MONTHS } = require(holidayCachePath);
    assert.equal(MAX_MEMOIZED_MONTHS, 32, "the memo cap is a product limit, not its own oracle");
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

    // REGRESSION: it sliced UTF-16 units, so a provider whose holiday name carried
    // an emoji at the cap handed Pango half a surrogate pair. It counts code
    // points now — the same rule the clock labels and the panel suffix use.
    const clamped = clampHolidayName("y".repeat(MAX_HOLIDAY_NAME_LENGTH - 1) + "🎉");
    assert.equal(Array.from(clamped).length, MAX_HOLIDAY_NAME_LENGTH);
    assert.doesNotMatch(clamped, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);

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

    const repository = new HolidayCacheRepository("/holidays.json");
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
    const { HolidayCacheRepository, HolidayCache, HolidayService } = loadHolidays();
    const logged = [];
    global.logError = (error) => logged.push(error);
    global.imports.gi.GLib.mkdir_with_parents = () => {
        throw new Error("read-only home");
    };

    const repository = new HolidayCacheRepository("/holidays.json");

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
    assert.equal(fs.existsSync(cachePath("holidays.json")), false, "nothing is written");
    assert.ok(logged.length > 0, "and the failure is reported, not swallowed");

    // the whole applet still works, it just cannot remember anything
    const cache = new HolidayCache(
        (country, done) => repository.loadAsync(country, done),
        (country, data) => repository.save(country, data)
    );
    const enrico = new HolidayService({
        fetchYear(_country, region, year, callback) {
            callback([{ year, month: 1, day: 1, region, name: "New Year", flags: [] }],
                { year, region, providerName: "Enrico" }, new Date().toUTCString());
        }
    }, cache, { record: anyRecord({ expandHoliday: (single) => [single] }) });

    assert.doesNotThrow(() => enrico.setPlace("usa", "global"));
    assert.deepEqual(enrico.matchMonth(FIXED_YEAR, 1).get("1/1"), ["New Year", []]);
});

test("a cached freshness stamp in the future is not believed", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const { validCachedStamp, validCachedYears } = require(holidayCachePath);
    const repository = new HolidayCacheRepository("/holidays.json");
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
    fs.writeFileSync(cachePath("holidays.json"), JSON.stringify({
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

test("HolidayService localizes, deduplicates, caches, and matches holidays by month", () => {
    const { HolidayService } = loadHolidays();
    const enrico = new HolidayService();
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

test("HolidayService setPlace treats a null region as the global region", () => {
    const { HolidayService } = loadHolidays();
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("holidays.json"), JSON.stringify({
        usa: {
            years: { 2026: { global: new Date().toUTCString() } },
            holidays: [{ year: 2026, month: 1, day: 1, region: "global", name: "New Year", flags: [] }]
        }
    }));

    const enrico = new HolidayService();
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

test("HolidayService setPlace honors the retry backoff after a failed fetch", () => {
    const { HolidayService } = loadHolidays();
    const year = FIXED_YEAR;

    const enrico = new HolidayService();
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
    const { HolidayService } = loadHolidays();
    fs.mkdirSync(cachePath(), { recursive: true });

    const payloads = [
        "{ not json at all",
        "null",
        JSON.stringify({ usa: { years: null, holidays: "nope" } }),
        JSON.stringify({ usa: { years: { 2026: { global: STAMP } }, holidays: "nope" } })
    ];

    for (const payload of payloads) {
        fs.writeFileSync(cachePath("holidays.json"), payload);

        const enrico = new HolidayService();
        let retrievedYear = null;
        enrico.retrieveForYear = function(year) {
            retrievedYear = year;
        };

        enrico.setPlace("usa", "global");

        assert.deepEqual(enrico.cache.years, {}, `years for ${payload}`);
        assert.equal(retrievedYear, FIXED_YEAR, `retrieve for ${payload}`);
        assert.equal(enrico.matchMonth(2026, 1).size, 0);
    }
});

test("HolidayService setPlace loads cache and getHolidays retrieves stale years", () => {
    const { HolidayService } = loadHolidays();
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("holidays.json"), JSON.stringify({
        usa: {
            years: { 2026: { global: "Fri, 01 Jan 2026 00:00:00 GMT" } },
            holidays: [{ year: 2026, month: 1, day: 1, region: "global", name: "Cached", flags: [] }]
        }
    }));

    const enrico = new HolidayService();
    let retrievedYear = null;
    enrico.retrieveForYear = function(year, callback) {
        retrievedYear = year;
        this.cache.years[year] = { global: new Date().toUTCString() };
        this.cache.addUnique({ year, month: 3, day: 8, region: "global", name: "Fetched", flags: [] });
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

test("HolidayService retrieveForYear builds params and addData ignores provider errors", () => {
    const { HolidayService, EnricoServiceAdapter, createHolidayServiceChain } = loadHolidays();
    let captured = null;
    // HolidayService's service is a fallback chain in production; a bare adapter is only a
    // fetchYear, so wrap it the way the applet does — the record contract (validate
    // and expand) is the chain's, not any one adapter's
    const primary = new EnricoServiceAdapter((url, params, callback) => {
        captured = { url, params };
        callback([holiday("Fetched", params.year, 7, 4)], params, "Sat, 04 Jul 2026 00:00:00 GMT");
    });
    const enrico = new HolidayService();
    enrico.service = createHolidayServiceChain(primary, []);
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
    // the operator gets the provider's own words; the user does not
    assert.deepEqual(logged, [
        "holiday provider Enrico returned invalid data for 2026: bad"
    ]);
    assert.equal(enrico.last_error, "Holiday data unavailable");
});

// The provider's own error string reaches a Pango tooltip, an accessible name
// and global.logError, and it was the one remote string with no clamp and no
// type check on it.
test("a hostile provider error string cannot flood the tooltip or the log", () => {
    const { HolidayService, HolidayCache, HOLIDAY_ERRORS } = loadHolidays();
    const enrico = new HolidayService({ fetchYear() {}, validResponse: () => true, expandHoliday: () => [] },
        new HolidayCache(() => {}, () => {}));
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    // what the user is told is always the applet's own message, in their language:
    // the vendor's sentence is a diagnostic and goes to the log
    enrico.addData({ error: "x".repeat(4 * 1024 * 1024) }, { year: 2026 }, STAMP);
    assert.equal(enrico.last_error, HOLIDAY_ERRORS.INVALID_RESPONSE);
    assert.ok(logged.at(-1).length <= 400,
        "a 4 MiB error string is laid out on the compositor thread");
    assert.ok(logged.at(-1).endsWith("…"));

    // newlines in it would forge lines in the Cinnamon log
    enrico.addData({ error: "boom\nJan 01 00:00:00 cinnamon: forged" }, { year: 2026 }, STAMP);
    assert.doesNotMatch(logged.at(-1), /\n/);

    // and a non-string error is an invalid response, not an object stringified
    // into the month label
    enrico.addData({ error: { code: 500 } }, { year: 2026 }, STAMP);
    assert.equal(enrico.last_error, HOLIDAY_ERRORS.INVALID_RESPONSE);
    assert.ok(logged.length >= 3);
});

test("HolidayService validates remote payloads before caching", () => {
    const { HolidayService, HOLIDAY_ERRORS } = loadHolidays();
    const enrico = new HolidayService();
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

test("HolidayService surfaces provider errors to getHolidays callbacks", () => {
    const { HolidayService } = loadHolidays();
    const service = {
        validResponse() {
            return false;
        },
        fetchYear(_country, _region, year, callback) {
            callback({ error: "Enrico unavailable" }, { year, region: "global", providerName: "Test Provider" }, null);
        }
    };
    const enrico = new HolidayService(service, undefined, { record: service });
    enrico.country = "usa";
    enrico.region = "global";
    let result = null;

    enrico.getHolidays(2026, 1, (dates, error, providerName) => {
        result = { dates, error, providerName };
    });

    assert.deepEqual(Array.from(result.dates.entries()), []);
    // the vendor said "Enrico unavailable"; the grid is told the applet's own
    // error identifier, which the UI has a translation for
    assert.equal(result.error, "Holiday data unavailable");
    assert.equal(result.providerName, "Test Provider");
});

// The status ledger is keyed `${year}/${region}` with no country in it, so a
// failure recorded for France's 2026/global was read back by Germany — also
// "global" — whose data was cached and fresh, so nothing ever overwrote it.
test("a failure under one country is not reported under the next", () => {
    const { HolidayService, HolidayCache } = loadHolidays();
    const year = FIXED_YEAR;
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
    const enrico = new HolidayService(service, cache, { record: service });

    // France fails — reported as the applet's own error, not as the vendor's
    // sentence, which is what an untranslatable English string in a French UI was
    enrico.setPlace("fra", "global");
    let seen = null;
    enrico.getHolidays(year, 7, (dates, error) => { seen = error; });
    assert.equal(seen, "Holiday data unavailable");

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

test("HolidayCache indexes loaded data and API mutations", () => {
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

    cache.addUnique({ year: 2031, month: 1, day: 7, region: "global", name: "Seven", flags: [] });

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

test("HolidayService records the attempt when the fetch lands, not when it starts", () => {
    const { HolidayService, HolidayCache } = loadHolidays();
    let fetched = false;
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    const service = {
        fetchYear(_country, _region, _year, callback) {
            fetched = true;
            callback({ error: "offline" }, { year: FIXED_YEAR }, null);
        }
    };
    const enrico = new HolidayService(service, cache);
    enrico.setPlace("usa", "global");

    assert.equal(fetched, true);
    // the failed attempt is recorded on completion, so RETRY_PERIOD applies
    assert.equal(enrico.staleCache(FIXED_YEAR), false);
});

test("a fetch that lands after the country changed does not write to the new country", () => {
    const { HolidayService, HolidayCache } = loadHolidays();
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

    const enrico = new HolidayService(service, cache, { record: service });
    const year = FIXED_YEAR;

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
    const { HolidayService, HolidayCache } = loadHolidays();
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    const service = {
        fetchYear(_country, _region, year, callback) {
            callback([], { year, providerName: "Enrico" }, new Date().toUTCString());
        },
        validResponse: () => true,
        expandHoliday: () => []
    };
    const enrico = new HolidayService(service, cache, { record: service });
    enrico.setPlace("usa", "global");

    const current = FIXED_YEAR;
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

    const current = FIXED_YEAR;
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
    const repository = new HolidayCacheRepository("/holidays.json");
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("holidays.json"), JSON.stringify({
        usa: { years: {}, holidays: [] }
    }));

    // the async reader is the only reader now: the synchronous load() it
    // replaced had no production caller left
    let reads = 0;
    const file = global.imports.gi.Gio.file_new_for_path(cachePath("holidays.json"));
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
    const written = JSON.parse(fs.readFileSync(cachePath("holidays.json"), "utf8"));
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

    const repository = new HolidayCacheRepository("/holidays.json");
    repository.save("usa", { years: {}, holidays: [{ name: "Independence Day" }] });

    const written = JSON.parse(contents);
    assert.deepEqual(Object.keys(written).sort(), ["ita", "usa"],
        "the write that lost the race merged again instead of overwriting");
    assert.equal(written.ita.holidays[0].name, "Epifania");
    assert.equal(written.usa.holidays[0].name, "Independence Day");
});

test("a save merges with the file instead of overwriting another writer's country", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json");
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("holidays.json"), JSON.stringify({
        usa: { years: {}, holidays: [] }
    }));

    // this instance takes its snapshot...
    loadCountry(repository, "usa");

    // ...and a second applet instance, with its own repository, saves Italy
    // in the meantime
    const other = new HolidayCacheRepository("/holidays.json");
    other.save("ita", { years: {}, holidays: [{ year: 2026, month: 1, day: 6, region: "global", name: "Epifania", flags: [] }] });

    repository.save("usa", { years: {}, holidays: [{ year: 2026, month: 7, day: 4, region: "global", name: "Independence Day", flags: [] }] });

    const written = JSON.parse(fs.readFileSync(cachePath("holidays.json"), "utf8"));
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
    const repository = new HolidayCacheRepository("/holidays.json");
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("holidays.json"), JSON.stringify({
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

    const loaded = loadCountry(repository, "usa");

    assert.deepEqual(loaded.holidays.map((single) => single.name),
        ["Independence Day"],
        "a file that parses is not a file that can be trusted row by row");
    assert.deepEqual(loaded.years, {}, "discarded rows make the snapshot stale");
});

test("a tampered cache file cannot load more than the expanded-row cap", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json");
    const holiday = (day) => ({
        year: 2026,
        month: 1,
        day: (day % 28) + 1,
        region: "global",
        name: `Holiday ${day}`,
        flags: []
    });
    const stored = Array.from({ length: 4001 }, (_unused, day) => holiday(day));

    const loaded = repository._country({ usa: { years: {}, holidays: stored } }, "usa");

    assert.equal(loaded.holidays.length, 4000);
    assert.equal(loaded.holidays.at(-1).name, "Holiday 3999");
});

test("truncating cached rows also invalidates their freshness stamps", () => {
    const { HolidayCacheRepository, HolidayCache } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json");
    const holiday = (year, number) => ({
        year,
        month: 1,
        day: (number % 28) + 1,
        region: "global",
        name: `Holiday ${year}-${number}`,
        flags: []
    });
    const stored = Array.from({ length: 4000 }, (_unused, number) => holiday(2025, number));
    stored.push(holiday(2026, 4000));
    const loaded = repository._country({
        usa: {
            years: { 2025: { global: STAMP }, 2026: { global: STAMP } },
            holidays: stored
        }
    }, "usa");
    const cache = new HolidayCache((_country, done) => done(loaded), () => {});

    cache.setPlace("usa", "global");

    assert.equal(loaded.holidays.some((single) => single.year === 2026), false,
        "the cap demonstrates that the later year was omitted");
    assert.deepEqual(loaded.years, {}, "an incomplete snapshot carries no fresh years");
    assert.equal(cache.stale(2026, "global"), true, "the omitted year will be refetched");
});

test("a tampered cache file cannot inject malformed holidays", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json");
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("holidays.json"), JSON.stringify({
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
    const HolidayRecord = require(holidayRecordPath);
    // the validate-and-expand rule is the record contract's, not the adapter's;
    // the adapter is a fetchYear and forwards to this
    const record = new HolidayRecord.HolidayRecordContract("en");

    const hostile = {
        date: { year: 2026, month: 1, day: 1 },
        dateTo: { year: 9999, month: 12, day: 31 },
        name: [{ lang: "en", text: "Forever" }],
        flags: []
    };

    assert.equal(record.validHoliday(hostile), false, "the payload must never reach the cache");
    // even reached directly, expansion stays bounded instead of freezing the shell
    assert.ok(record.expandHoliday(hostile, "global").length <= HolidayRecord.MAX_HOLIDAY_SPAN_DAYS + 1);

    const yearLong = {
        date: { year: 2026, month: 1, day: 1 },
        dateTo: { year: 2026, month: 12, day: 31 },
        name: [{ lang: "en", text: "Long" }],
        flags: []
    };
    assert.equal(record.validHoliday(yearLong), true, "a normal multi-day holiday still passes");
});

test("the holiday record contract is vendor-free", () => {
    const recordSource = fs.readFileSync(holidayRecordPath, "utf8");
    const adapterSource = fs.readFileSync(holidayServiceAdaptersPath, "utf8");

    assert.doesNotMatch(recordSource, /kayaposoft|openholidaysapi|date\.nager/i);
    assert.doesNotMatch(adapterSource, /class HolidayRecordContract/);
    assert.equal(typeof require(holidayRecordPath).HolidayRecordContract, "function");
});

test("holiday status is reported per year, not shared across months", () => {
    const { HolidayService, HolidayCache, HOLIDAY_ERRORS } = loadHolidays();
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
    const enrico = new HolidayService(service, cache, { record: service });
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
    const { HolidayService, HolidayCache, HOLIDAY_ERRORS } = loadHolidays();
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
    const enrico = new HolidayService(service, cache, { record: service });
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
    const { HolidayService, HolidayCache } = loadHolidays();
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
    const enrico = new HolidayService(service, cache, { record: service });
    enrico.country = "usa";
    enrico.region = "global";

    const year = FIXED_YEAR;
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
    const { HolidayService, HolidayCache } = loadHolidays();
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
    const enrico = new HolidayService(service, cache, { record: service });
    let repaints = 0;

    enrico.setPlace("usa", "global", () => repaints++);
    assert.equal(repaints, 0, "the data has not arrived yet");

    pending({ error: "offline" }, { year: FIXED_YEAR, region: "global" }, null);
    assert.equal(repaints, 1);
});

test("a stale cache-load callback cannot act on the next place", () => {
    const { HolidayService } = loadHolidays();
    const loads = [];
    let staleChecks = 0;
    const cache = {
        country: null,
        region: "global",
        setPlace(country, region, callback) {
            this.country = country;
            this.region = region;
            loads.push(callback);
        },
        stale() {
            staleChecks++;
            return false;
        }
    };
    const enrico = new HolidayService({}, cache);
    let repaints = 0;

    enrico.setPlace("fra", "global", () => repaints++);
    enrico.setPlace("deu", "global", () => repaints++);

    loads[0]();
    assert.equal(staleChecks, 0,
        "France's late disk read cannot inspect Germany's cache state");
    assert.equal(repaints, 0);

    loads[1]();
    assert.equal(staleChecks, 1);
    assert.equal(repaints, 1, "the current place still completes normally");
});

test("a second month of the same grid joins the in-flight year fetch", () => {
    const { HolidayService, HolidayCache } = loadHolidays();
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
    const enrico = new HolidayService(service, cache, { record: service });
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

test("HolidayService deduplicates in-flight year fetches", () => {
    const { HolidayService, HolidayCache } = loadHolidays();
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
    const enrico = new HolidayService(service, cache);
    enrico.country = "usa";
    enrico.region = "global";
    let callbacks = 0;

    enrico.retrieveForYear(2026, () => callbacks++);
    enrico.retrieveForYear(2026, () => callbacks++);

    assert.equal(fetches, 1);
    pending({ error: "offline" }, { year: 2026, region: "global" }, null);
    assert.equal(callbacks, 2);
});
