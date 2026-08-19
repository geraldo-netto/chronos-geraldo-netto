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
    assert.deepEqual(cache.matchMonth(2026, 1).get("1/1"), { name: "New Year", flags: [] });
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

    enrico.addData([{ name: "Fetched" }], { year: 2026, region: "global" }, STAMP,
        { year: 2026, region: "global" });
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

    enrico.addData([{ junk: true }], { year: 2026, region: "global" }, STAMP,
        { year: 2026, region: "global" });

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

    // The stamp was valid when loaded, but the user then corrected the system
    // clock backwards. A negative persisted age is stale in the safe direction.
    cache.years = { 2026: { global: new Date(fixedNow + 1000).toUTCString() } };
    assert.equal(cache.stale(2026, "global", fixedNow), true);
    cache.years = {};
    cache.attempts = { 2026: { global: new Date(fixedNow + 1000).toUTCString() } };
    assert.equal(cache.stale(2026, "global", fixedNow), true);
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

    // T580: the cache file is user-writable, so its flags obey the same bound
    // the network contract enforces — a hostile row cannot re-enter unbounded
    assert.ok(!validCachedHoliday(
        { year: 2026, month: 5, day: 5, name: "X", flags: ["x".repeat(65)], region: "global" }));
    assert.ok(!validCachedHoliday(
        { year: 2026, month: 5, day: 5, name: "X", flags: [1], region: "global" }));
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
// is what HolidayPersistWindow.snapshot's comment warns about: it dropped a just-fetched
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

// T784: _rebuildIndex snapshots _yearUse before replaying the rows and restored
// that exact snapshot afterwards, discarding the _touchYear calls the replay
// performed. That is right for _pruneYears, which rebuilds a list that only
// shrinks — every year with rows is already in the snapshot. It was wrong for
// setData, which installs a row set read from disk whose years this cache never
// touched: they held rows in `data` and stamps in `years` with no _yearUse entry
// at all, so _pruneYears could never select them and _forgetYear could never
// reach them. Every LRU test drove recordFetch and matchMonth; none drove a load.
test("years read from disk are held by the LRU like the ones fetched", () => {
    const { HolidayCache } = loadHolidays();
    const { MAX_CACHED_YEARS } = require(holidayCachePath);
    const stamp = new Date().toUTCString();
    const stored = { years: {}, holidays: [] };
    const first = 2000;
    const loaded = MAX_CACHED_YEARS + 3;

    for (let offset = 0; offset < loaded; offset++) {
        const year = first + offset;
        stored.years[year] = { global: stamp };
        stored.holidays.push({
            year, month: 1, day: 1, region: "global", name: "New Year", flags: []
        });
    }

    const cache = new HolidayCache((_country, done) => done(stored), () => {});
    cache.setPlace("ita", "global");

    assert.equal(cache._yearUse.size, MAX_CACHED_YEARS,
        "a file holding more years than the cap does not raise the cap");
    assert.deepEqual(cache.cachedYears().sort((a, b) => a - b),
        Array.from({ length: MAX_CACHED_YEARS },
            (_unused, i) => first + loaded - MAX_CACHED_YEARS + i),
        "and cachedYears reports every year the cache is actually holding");

    // the years that survived are evictable like any other: fetching past the
    // cap must be able to reach them
    const survivor = first + loaded - MAX_CACHED_YEARS;
    cache.recordFetch(2100, "global", stamp,
        [{ year: 2100, month: 1, day: 1, region: "global", name: "New Year", flags: [] }]);

    assert.equal(cache._yearUse.size, MAX_CACHED_YEARS, "still bounded");
    assert.equal(cache.matchMonth(survivor, 1).size, 0,
        "the least recently used disk year is the one evicted");
    assert.equal(cache.stale(survivor, "global"), true,
        "and it loses the stamp that suppressed its refetch with its rows");
});

// A year can carry a stamp and no rows at all — a country with no holidays that
// year, or a recorded attempt that fetched nothing — and that stamp is what
// throttles the refetch. Deriving the LRU from the rows alone would leave it
// invisible to cachedYears and so to the status ledger that prunes in step.
test("a loaded year with a stamp but no rows is still held by the LRU", () => {
    const { HolidayCache } = loadHolidays();
    const stamp = new Date().toUTCString();
    const cache = new HolidayCache((_country, done) => done({
        years: { 2026: { global: stamp }, 2027: { global: stamp } },
        holidays: [{ year: 2026, month: 1, day: 1, region: "global", name: "New Year", flags: [] }]
    }), () => {});

    cache.setPlace("ita", "global");

    assert.deepEqual(cache.cachedYears().sort((a, b) => a - b), [2026, 2027]);
    assert.equal(cache.stale(2027, "global"), false,
        "the stamp still throttles the year it belongs to");
});

// matchMonth touches a year without pruning — reading the grid is not the
// moment to throw data away — so browsing back through many years inflates the
// LRU, and the next fetch evicts the whole backlog in one call. Each eviction
// used to filter the row list and then replay every survivor through
// _addUnique, clearing and refilling three Maps as it went; the rebuild is
// bookkeeping over what is left, and there is one "what is left" per prune.
test("pruning a batch of years rebuilds the index once, not once per year", () => {
    const { HolidayCache } = loadHolidays();
    const { MAX_CACHED_YEARS } = require(holidayCachePath);
    const row = (year) => ({
        year, month: 1, day: 1, region: "global", name: "New Year", flags: []
    });
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }), () => {});
    cache.setPlace("ita", "global");

    // one year with rows and a freshness stamp, one that only ever failed, then
    // a long scroll back
    cache.recordFetch(2000, "global", new Date().toUTCString(), [row(2000)]);
    cache.recordAttempt(1999, "global");
    const browsed = MAX_CACHED_YEARS * 2;
    for (let year = 2001; year <= 2000 + browsed; year++) {
        cache.matchMonth(year, 1);
    }
    assert.equal(cache._yearUse.size, browsed + 2, "browsing touches without pruning");
    assert.equal(cache.stale(1999, "global"), false,
        "a recent failed attempt throttles its own refetch");

    let rebuilds = 0;
    const realRebuild = cache._rebuildIndex.bind(cache);
    cache._rebuildIndex = () => {
        rebuilds++;
        realRebuild();
    };

    cache.recordFetch(2100, "global", new Date().toUTCString(), [row(2100)]);

    assert.equal(rebuilds, 1,
        `${browsed + 2 - MAX_CACHED_YEARS} years evicted, one rebuild`);
    assert.equal(cache._yearUse.size, MAX_CACHED_YEARS);

    // the batch really went, rows and stamps together
    assert.deepEqual(cache.data.map((single) => single.year), [2100],
        "the evicted year's rows went with it");
    assert.equal(cache.stale(2000, "global"), true,
        "and it is stale again, not silently empty");
    // the attempt stamp is what suppresses a refetch, so it cannot outlive the
    // year it belongs to: kept, it would throttle a year holding nothing
    assert.equal(cache.stale(1999, "global"), true,
        "the evicted year's attempt stamp went with it");

    // a record that evicts nothing rebuilds nothing. This has to be asked
    // before any matchMonth below: a read touches the year it reads, which is
    // what puts the LRU back over the cap.
    rebuilds = 0;
    cache.recordAttempt(2100, "global");
    assert.equal(rebuilds, 0);

    // ...and the indexes agree with the rows that are left
    assert.equal(cache.matchMonth(2100, 1).size, 1, "the year just fetched is there");
    assert.equal(cache.matchMonth(2000, 1).size, 0, "the oldest is gone");
});

// T725: eviction calls _rebuildIndex, which replays `data` through _addUnique —
// and _addUnique ends in _touchYear. Every eviction therefore rewrote the whole
// recency order into `data` insertion order, so the LRU degenerated to
// FIFO-by-first-fetch and the *most* recently used year could be evicted next.
test("eviction picks the least recently used year, not the first fetched", () => {
    const { HolidayCache } = loadHolidays();
    const { MAX_CACHED_YEARS } = require(holidayCachePath);
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    cache.setPlace("ita", "global");

    const fetchYear = (year) => cache.recordFetch(year, "global", new Date().toUTCString(),
        [{ year, month: 1, day: 1, region: "global", name: "New Year", flags: [] }]);

    // fill the cache newest-first, so data insertion order is the reverse of
    // recency and the two orders cannot be confused for each other
    fetchYear(2026);
    for (let year = 2025; year > 2025 - (MAX_CACHED_YEARS - 1); year--) {
        fetchYear(year);
    }
    assert.equal(cache._yearUse.size, MAX_CACHED_YEARS);

    // a failed attempt on a ninth year evicts one and touches 2027. The evicted
    // year must be 2026 — the oldest use — and 2027 must be the newest, which is
    // exactly what recordAttempt's own _touchYear is for.
    cache.recordAttempt(2027, "global");
    assert.equal(cache.cachedYears().includes(2026), false, "the oldest use is evicted");
    assert.equal(cache.cachedYears().at(-1), 2027, "the year just used is the newest");

    // and the retry throttle survives a sibling year, which is the point: with
    // the order rewritten, 2027 was evicted next and its stale() flipped back to
    // true, so a down provider was refetched on every update instead of hourly
    assert.equal(cache.stale(2027, "global"), false, "the retry backoff holds");
    cache.recordAttempt(2028, "global");
    assert.equal(cache.stale(2027, "global"), false,
        "a sibling year must not evict the attempt that throttles the retry");
});

test("destroying the provider drops the holidays it was holding", () => {
    const { HolidayCache } = loadHolidays();
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});

    cache.setPlace("ita", "global");
    for (let year = 2022; year < 2030; year++) {
        for (let day = 1; day <= 12; day++) {
            cache.addUnique({ year, month: 1, day, region: "global", name: "Holiday", flags: [] });
        }
        cache.recordAttempt(year, "global");
    }
    assert.ok(cache.data.length > 90, "the session's browsing, as the cache holds it");
    assert.ok(cache.matchMonth(2026, 1).size > 0, "and the derived month index");

    cache.release();

    assert.deepEqual(cache.data, []);
    assert.deepEqual(cache.years, {});
    assert.deepEqual(cache.attempts, {});
    assert.equal(cache.matchMonth(2026, 1).size, 0, "the indexes go with the data");
});

test("a cache load cannot repopulate or notify after release", () => {
    const { HolidayCache } = loadHolidays();
    let deliverLoad = null;
    let loads = 0;
    const cache = new HolidayCache((_country, done) => {
        loads++;
        deliverLoad = done;
    }, () => {});
    const callbacks = [];
    cache.setPlace("ita", "global", () => callbacks.push("place"));
    cache.whenReady(() => callbacks.push("waiter"));

    cache.release();
    deliverLoad({
        years: { 2026: { global: STAMP } },
        holidays: [{
            year: 2026,
            month: 1,
            day: 1,
            region: "global",
            name: "New Year",
            flags: []
        }]
    });

    assert.equal(cache.country, null);
    assert.deepEqual(cache.years, {});
    assert.deepEqual(cache.data, []);
    assert.deepEqual(callbacks, []);

    cache.setPlace("usa", "global", () => callbacks.push("reopened"));
    cache.whenReady(() => callbacks.push("late waiter"));
    assert.equal(loads, 1, "a released cache cannot be reopened");
    assert.deepEqual(callbacks, []);
});

test("a failing cache-ready callback cannot discard later waiters", () => {
    const { HolidayCache } = loadHolidays();
    let deliverLoad = null;
    const cache = new HolidayCache((_country, done) => { deliverLoad = done; }, () => {});
    const calls = [];
    const first = new Error("place repaint failed");

    cache.setPlace("ita", "global", () => {
        calls.push("place");
        throw first;
    });
    cache.whenReady(() => {
        calls.push("first waiter");
        throw new Error("waiter failed");
    });
    cache.whenReady(() => calls.push("last waiter"));

    assert.throws(() => deliverLoad({ years: {}, holidays: [] }),
        (error) => error === first);
    assert.deepEqual(calls, ["place", "first waiter", "last waiter"]);
    assert.equal(cache._loading, false);
    assert.deepEqual(cache._onReady, []);

    cache.whenReady(() => calls.push("after load"));
    assert.deepEqual(calls, ["place", "first waiter", "last waiter", "after load"]);
});

test("a released cache rejects every public re-entry path", () => {
    const { HolidayCache } = loadHolidays();
    let loads = 0;
    let saves = 0;
    const cache = new HolidayCache(() => { loads++; }, () => { saves++; });
    const row = {
        year: 2026, month: 1, day: 1, region: "global", name: "New Year", flags: []
    };
    const exercise = (name, action) => {
        cache.release();
        const refs = {
            data: cache.data,
            years: cache.years,
            attempts: cache.attempts,
            ready: cache._onReady
        };
        assert.doesNotThrow(action, name);
        assert.equal(cache.data, refs.data, `${name} replaced released data`);
        assert.equal(cache.years, refs.years, `${name} replaced released years`);
        assert.equal(cache.attempts, refs.attempts, `${name} replaced released attempts`);
        assert.equal(cache._onReady, refs.ready, `${name} replaced released waiters`);
        assert.deepEqual(cache.data, [], name);
        assert.deepEqual(cache.years, {}, name);
        assert.deepEqual(cache.attempts, {}, name);
        assert.equal(cache._yearUse.size, 0, name);
        assert.equal(cache._holidayIndex.size, 0, name);
        assert.equal(cache._monthIndex.size, 0, name);
        assert.equal(cache._matchedMonthCache.size, 0, name);
    };

    exercise("setData", () => cache.setData([Object.assign({}, row)]));
    exercise("addUnique", () => cache.addUnique(Object.assign({}, row)));
    exercise("recordYear", () => cache.recordYear(2026, "global", STAMP));
    exercise("recordFetch", () => cache.recordFetch(2026, "global", STAMP, {
        forEach() { throw new Error("released data was inspected"); }
    }));
    exercise("recordAttempt", () => cache.recordAttempt(2026, "global", STAMP));
    exercise("clearPlace", () => cache.clearPlace());

    cache.release();
    let ready = 0;
    cache.whenReady(() => ready++);
    cache.setPlace("usa", "global", () => ready++);
    assert.equal(ready, 0);
    assert.equal(loads, 0);

    const january = cache.matchMonth(2026, 1);
    assert.equal(january.size, 0);
    assert.equal(cache.matchMonth(2026, 1).size, 0);
    assert.equal(cache._yearUse.size, 0);
    assert.equal(cache._matchedMonthCache.size, 0);
    assert.deepEqual(cache.cachedYears(), []);
    assert.equal(cache.stale(2026, "global", Date.now()), true);

    cache.country = "usa";
    cache.persist();
    assert.equal(saves, 0, "released state wins over externally retained fields");
    cache.release();
    assert.doesNotThrow(() => cache.release(), "release is idempotent");
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

test("releasing a holiday repository drops its parsed snapshot and rejects re-entry", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json");

    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("holidays.json"), JSON.stringify(LEGACY_CACHE));
    assert.equal(loadCountry(repository, "usa").holidays.length, 1);
    assert.ok(repository._all);

    repository.release();

    assert.equal(repository._all, null);
    assert.equal(repository._load_waiters, null);
    assert.deepEqual(repository._pending, {});
    let answered = 0;
    repository.loadAsync("usa", () => answered++);
    repository.save("usa", { years: {}, holidays: [] });
    repository.release();
    assert.equal(answered, 0);
    assert.equal(repository._all, null);
    assert.deepEqual(repository._pending, {});
});

test("a repository read landing after release restores no cache snapshot", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const payload = Buffer.from(JSON.stringify(LEGACY_CACHE));
    let settleStat = null;
    let settleLoad = null;
    global.imports.gi.Gio.file_new_for_path = (filePath) => ({
        get_path: () => filePath,
        query_info_async(_attributes, _flags, _priority, _cancellable, callback) {
            settleStat = () => callback(this, { ok: true });
        },
        query_info_finish: () => ({ get_size: () => payload.length }),
        load_contents_async(_cancellable, callback) {
            settleLoad = () => callback(this, { ok: true });
        },
        load_contents_finish: () => [true, payload]
    });
    const repository = new HolidayCacheRepository("/holidays.json");
    let answered = 0;

    repository.loadAsync("usa", () => answered++);
    repository.release();
    settleStat();
    settleLoad();

    assert.equal(answered, 0);
    assert.equal(repository._all, null);
    assert.equal(repository._load_waiters, null);
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

// The memo is bounded by Map iteration order, so whether a read reorders is
// what decides which month it drops — and "scrolling back is free" is the
// thing it exists for. Evicting by insertion drops the month being returned to.
test("the month-match memo keeps the months being read, not the first seen", () => {
    const { HolidayCache } = loadHolidays();
    const { MAX_MEMOIZED_MONTHS } = require(holidayCachePath);
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    cache.setPlace("usa");
    cache.addUnique({
        year: 2026, month: 1, day: 1, region: "global", name: "New Year", flags: []
    });

    const january = cache.matchMonth(2026, 1);

    // fill the memo to its cap with months passed through once
    for (let month = 1; month < MAX_MEMOIZED_MONTHS; month++) {
        cache.matchMonth(2020 + Math.floor(month / 12), (month % 12) + 1);
        // ...and keep coming back to January, the month actually on screen
        assert.equal(cache.matchMonth(2026, 1), january);
    }
    assert.equal(cache._matchedMonthCache.size, MAX_MEMOIZED_MONTHS);

    // one more scrolled-past month has to displace something
    cache.matchMonth(2019, 6);
    assert.equal(cache.matchMonth(2026, 1), january,
        "the month being read is not the one thrown away");
});

// T990: the cache and the religious layer each had their own "join two rows
// that fall on the same day", under comments in three files claiming the two
// agreed. They did not — one repeated a name it already carried, left the
// joined string unbounded and kept insertion order where the other sorted.
test("the shared same-day join bounds, deduplicates and orders", () => {
    const {
        joinHolidayEntry, withHolidayFlag, sameHolidayFlags,
        MAX_HOLIDAY_NAME_LENGTH
    } = require(holidayRecordPath);

    // a first row is the row, with one flag order
    assert.deepEqual(joinHolidayEntry(null, "Christmas", ["religious_holiday", "christianity"]),
        { name: "Christmas", flags: ["christianity", "religious_holiday"] });
    assert.deepEqual(joinHolidayEntry(null, "Christmas"), { name: "Christmas", flags: [] });

    // a name already present is not appended again
    const known = joinHolidayEntry(null, "Christmas", ["public_holiday"]);
    assert.deepEqual(joinHolidayEntry(known, "Christmas", ["christianity"]),
        { name: "Christmas", flags: ["christianity", "public_holiday"] });
    assert.deepEqual(known, { name: "Christmas", flags: ["public_holiday"] },
        "the existing entry is not mutated");

    // and a joined cell is bounded like any other holiday name
    let cell = { name: "", flags: [] };
    for (let i = 0; i < 200; i++) {
        cell = joinHolidayEntry(cell, "Observance " + i, ["religious_holiday"]);
    }
    assert.ok(Array.from(cell.name).length <= MAX_HOLIDAY_NAME_LENGTH);

    // PART_DAY is a claim about the day: it survives a merge only when both
    // rows agree, but tagging one row public leaves it alone
    assert.deepEqual(
        joinHolidayEntry({ name: "Eve", flags: ["PART_DAY_HOLIDAY"] }, "Public Eve", ["public_holiday"]).flags,
        ["public_holiday"]);
    assert.deepEqual(
        joinHolidayEntry({ name: "Eve", flags: ["PART_DAY_HOLIDAY"] }, "Other Eve", ["PART_DAY_HOLIDAY"]).flags,
        ["PART_DAY_HOLIDAY"]);
    assert.deepEqual(withHolidayFlag(["PART_DAY_HOLIDAY"], "public_holiday"),
        ["PART_DAY_HOLIDAY", "public_holiday"]);

    assert.ok(sameHolidayFlags(["a", "b"], ["a", "b"]));
    assert.ok(!sameHolidayFlags(["a"], ["a", "b"]));
    assert.ok(!sameHolidayFlags(["a"], ["b"]));
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

test("repository release lets queued writes settle without retaining their snapshot", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const settle = [];
    const writes = [];
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
    repository.save("ita", { years: {}, holidays: [{ name: "queued" }] });
    repository.release();
    assert.equal(repository._all, null);

    settle.shift()();
    assert.equal(writes.length, 2, "the write queued before release still persists");
    assert.deepEqual(writes[1].ita.holidays, [{ name: "queued" }]);
    assert.equal(repository._all, null, "the late merge is not retained");

    settle.shift()();
    assert.deepEqual(repository._pending, {});
    assert.equal(repository._all, null);
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

test("reselecting a country rejects its older cache load", () => {
    const { HolidayCache } = loadHolidays();
    const pending = [];
    const cache = new HolidayCache(
        (country, done) => pending.push({ country, done }),
        () => {}
    );
    const loaded = (name) => ({
        years: {},
        holidays: [{ year: 2026, month: 7, day: 14,
            region: "global", name, flags: [] }]
    });
    const ready = [];

    cache.setPlace("fra", "global", () => ready.push("old France"));
    cache.setPlace("jpn", "global", () => ready.push("Japan"));
    cache.setPlace("fra", "global", () => ready.push("current France"));
    cache.whenReady(() => ready.push("waiter"));

    pending[2].done(loaded("current"));
    assert.deepEqual(cache.data.map((single) => single.name), ["current"]);
    assert.deepEqual(ready, ["current France", "waiter"]);

    pending[0].done(loaded("obsolete"));
    pending[1].done(loaded("wrong country"));
    assert.deepEqual(cache.data.map((single) => single.name), ["current"],
        "an older request for the same country cannot overwrite the current read");
    assert.deepEqual(ready, ["current France", "waiter"],
        "obsolete loads cannot release or invoke current readers");
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

// T745: clearPlace() set country to null and stopped, so choosing "None
// (disable holidays)" kept the previous country's rows, both indexes, the month
// memo, the year LRU and the freshness stamps alive for the rest of the
// session. Nothing reads them again — the facade reports inactive with no
// country, and re-selecting the same country reloads from disk anyway.
test("clearing the place releases the rows it was holding", () => {
    const { HolidayCache } = loadHolidays();
    const { GLOBAL_REGION } = require(holidayCachePath);
    let loads = 0;
    const stored = {
        years: { 2026: { [GLOBAL_REGION]: new Date().toUTCString() } },
        holidays: [
            { year: 2026, month: 1, day: 1, region: GLOBAL_REGION, name: "Capodanno", flags: [] },
            { year: 2026, month: 8, day: 15, region: GLOBAL_REGION, name: "Ferragosto", flags: [] }
        ]
    };
    const cache = new HolidayCache((_country, done) => {
        loads++;
        done({ years: { ...stored.years }, holidays: stored.holidays.map((row) => ({ ...row })) });
    }, () => {});

    cache.setPlace("ita", GLOBAL_REGION);
    cache.recordAttempt(2026, GLOBAL_REGION);
    assert.equal(cache.matchMonth(2026, 1).size, 1, "the month memo is warm");
    assert.equal(cache.data.length, 2);
    assert.deepEqual(cache.cachedYears(), [2026]);

    cache.clearPlace();

    assert.equal(cache.country, null);
    assert.deepEqual(cache.data, [], "the rows go with the place");
    assert.deepEqual(cache.years, {}, "and so do the freshness stamps");
    assert.deepEqual(cache.attempts, {}, "and the retry stamps");
    assert.deepEqual(cache.cachedYears(), [], "and the year LRU");
    assert.equal(cache.matchMonth(2026, 1).size, 0,
        "so a month the grid asks for after the clear is genuinely empty");

    // and nothing was lost that mattered: the same country reloads from disk
    cache.setPlace("ita", GLOBAL_REGION);
    assert.equal(loads, 2, "re-selecting a cleared country reads it again");
    assert.equal(cache.matchMonth(2026, 1).get("1/1").name, "Capodanno");
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
    assert.deepEqual(enrico.matchMonth(FIXED_YEAR, 1).get("1/1"), { name: "New Year", flags: [] });
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
    ], { year: 2026, region: "global" }, new Date().toUTCString(),
    { year: 2026, region: "global" });

    const holidays = enrico.matchMonth(2026, 1);

    assert.deepEqual(holidays.get("1/1"), { name: "New Year\nSecond Name", flags: ["public_holiday"] });
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
    assert.deepEqual(enrico.matchMonth(2026, 1).get("1/1"), { name: "New Year", flags: [] });
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
    assert.deepEqual(holidays.get("3/8"), { name: "Fetched", flags: [] });
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
    assert.deepEqual(enrico.matchMonth(2026, 7).get("7/4"), { name: "Fetched", flags: ["public_holiday"] });
    assert.equal(enrico.last_provider, "Enrico");

    const before = enrico.cache.data.length;
    const logged = [];
    global.logError = (message) => logged.push(message);
    enrico.addData({ error: "bad" }, { year: 2026, providerName: "Enrico" }, STAMP);
    assert.equal(enrico.cache.data.length, before);
    // the operator gets the provider's own words; the user does not
    assert.deepEqual(logged, [
        "holiday provider Enrico could not supply 2026: bad"
    ]);
    assert.equal(enrico.last_error, "Holiday data unavailable");
});

// T800: _validFetchedData checked only that params.year was an integer, and the
// rows were then filed under whatever the adapter echoed back, while _acceptYear
// throttled the *requested* year. The port contract says params carries "at
// least providerName and year" without requiring it to match the request, so a
// provider that stamped one year and answered another would leave the requested
// year rendering empty, suppressed for RETRY_PERIOD, with last_error "".
test("a response filed under the wrong year is refused, not stored under it", () => {
    const { HolidayService, HolidayCache, HOLIDAY_ERRORS } = loadHolidays();
    const record = {
        validResponse: () => true,
        expandHoliday: (entry) => [entry]
    };
    const service = new HolidayService({ fetchYear() {} },
        new HolidayCache(() => {}, () => {}), { record });
    global.logError = () => {};
    const rows = [holiday("New Year", 2026, 1, 1)];

    service.addData(rows, { year: 2027, region: "global", providerName: "Drifty" },
        STAMP, { year: 2026, region: "global" });
    assert.equal(service.cache.data.length, 0, "not under 2027, and not under 2026");
    assert.equal(service.cache.years[2026], undefined);
    assert.equal(service.last_error, HOLIDAY_ERRORS.INVALID_RESPONSE,
        "and the year says why rather than rendering empty and fresh");

    // the region half of the envelope is the same contract
    service.addData(rows, { year: 2026, region: "ca", providerName: "Drifty" },
        STAMP, { year: 2026, region: "global" });
    assert.equal(service.cache.data.length, 0);

    // an envelope that agrees is stored under the request, which is what the
    // grid and the throttle both ask about
    service.addData(rows, { year: 2026, region: "global", providerName: "Drifty" },
        STAMP, { year: 2026, region: "global" });
    assert.equal(service.cache.data.length, 1);
    assert.deepEqual(service.cache.years[2026], { global: STAMP });
    assert.equal(service.last_error, "");
});

// T799: IsoHolidayServiceAdapter signals "I cannot serve this country" with an
// explicit HOLIDAY_ERRORS member, and _rejectHolidayData funnelled every
// data.error through one branch that hard-coded INVALID_RESPONSE. Reachable
// because _last_provider ordering is never reset by setPlace: succeed on a
// covered country, switch to one absent from OPEN_HOLIDAYS_COUNTRIES, and
// OpenHolidays runs first and its synthetic error becomes the first failure. The
// month label then read "Holiday data unavailable" - a payload problem - for
// what is a reachability problem.
test("an adapter's own failure state survives to the label", () => {
    const { HolidayService, HolidayCache, HOLIDAY_ERRORS } = loadHolidays();
    const service = new HolidayService(
        { fetchYear() {}, validResponse: () => true, expandHoliday: () => [] },
        new HolidayCache(() => {}, () => {}));
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    service.addData({ error: HOLIDAY_ERRORS.SERVICE_UNAVAILABLE },
        { year: 2026, providerName: "OpenHolidays" }, STAMP);
    assert.equal(service.last_error, HOLIDAY_ERRORS.SERVICE_UNAVAILABLE);
    assert.equal(logged.at(-1),
        "holiday provider OpenHolidays could not supply 2026: " +
        HOLIDAY_ERRORS.SERVICE_UNAVAILABLE,
        "and the log no longer calls a reachability failure invalid data");

    // a vendor's own sentence is not the app's vocabulary and still collapses
    service.addData({ error: "Bad Gateway" },
        { year: 2026, providerName: "OpenHolidays" }, STAMP);
    assert.equal(service.last_error, HOLIDAY_ERRORS.INVALID_RESPONSE);

    // ...and so does a payload that fails the schema, which names no error
    service.record.validResponse = () => false;
    service.addData([], { year: 2026, providerName: "OpenHolidays" }, STAMP);
    assert.equal(service.last_error, HOLIDAY_ERRORS.INVALID_RESPONSE);
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

    // C0/C1 controls can forge lines, erase terminal output, or start ANSI/OSC
    // sequences when a maintainer inspects the Cinnamon log.
    enrico.addData({
        error: "boom\u0000\n\u001b[2J\u007f\u0085Jan 01 00:00:00 cinnamon: forged"
    }, { year: 2026 }, STAMP);
    assert.equal(Array.from(logged.at(-1)).some((character) => {
        const code = character.codePointAt(0);
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    }), false);

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
        [{ date: { year: 2026, month: 1, day: 1 }, name: [{ lang: "en", text: "Bad" }], flags: "public" }],
        [holiday("Wrong year", 2027, 1, 1)]
    ]) {
        enrico.addData(payload, { year: 2026, region: "global", providerName: "Schema Test" },
            STAMP, { year: 2026, region: "global" });
    }

    assert.equal(enrico.cache.data.length, 0);
    assert.equal(enrico.cache.years[2026], undefined);
    assert.equal(enrico.last_error, HOLIDAY_ERRORS.INVALID_RESPONSE);
    assert.equal(logged.length, 5);
    assert.ok(logged.every((line) => line ===
        `holiday provider Schema Test could not supply 2026: ${HOLIDAY_ERRORS.INVALID_RESPONSE}`));

    enrico.addData([holiday("Valid", 2026, 1, 1)], { year: 2026, region: "global" }, STAMP,
        { year: 2026, region: "global" });
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
            // a vendor sentence, deliberately not one of the app's own error
            // constants: those now survive to the label (T799)
            callback(fail ? { error: "502 Bad Gateway" } :
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

// T533 regression: _acceptYear recorded the failure and then pruned the status
// ledger by the ±1-year persist window, deleting the record it had just written
// for any year further out — while recordAttempt's stamp lived on in the LRU
// and suppressed the refetch. Paging two years ahead while offline rendered a
// bare month with no warning, indistinguishable from a country without holidays.
test("a failed fetch outside the persist window still reports its error", () => {
    const { HolidayService, HolidayCache, HOLIDAY_ERRORS } = loadHolidays();
    const service = {
        validResponse: () => false,
        fetchYear(_country, _region, requested, callback) {
            callback({ error: "502 Bad Gateway" },
                { year: requested, region: "global", providerName: "Enrico" }, null);
        }
    };
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    const enrico = new HolidayService(service, cache, { record: service });
    enrico.setPlace("fra", "global");

    let seen = null;
    enrico.getHolidays(FIXED_YEAR + 2, 7, (_dates, error) => { seen = error; });

    assert.equal(seen, HOLIDAY_ERRORS.INVALID_RESPONSE,
        "a far year's failure must survive the ledger prune that follows it");
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
        assert.equal(may.get(date).name, name);
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
    assert.deepEqual(cache.matchMonth(2031, 1).get("1/1"), { name: "One\nUno", flags: [] });

    cache.addUnique({ year: 2031, month: 1, day: 7, region: "global", name: "Seven", flags: [] });

    assert.deepEqual(cache.matchMonth(2031, 1).get("1/7"), { name: "Seven", flags: [] });
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
    assert.deepEqual(third.get("1/2"), { name: "Two", flags: [] });
});

test("same-date holiday flags merge independently of provider row order", () => {
    const { HolidayCache } = loadHolidays();
    const partial = { flags: ["PART_DAY_HOLIDAY", "optional"], name: "Partial" };
    const full = { flags: ["public_holiday", "bank"], name: "Full" };

    for (const rows of [[partial, full], [full, partial]]) {
        const cache = new HolidayCache((_country, done) =>
            done({ years: {}, holidays: [] }), () => {});
        rows.forEach((row) => cache.addUnique({
            year: 2031, month: 1, day: 1, region: "global", ...row
        }));

        assert.deepEqual(cache.matchMonth(2031, 1).get("1/1").flags,
            ["bank", "optional", "public_holiday"]);
    }
});

test("a duplicate holiday refreshes a memoized month", () => {
    const { HolidayCache } = loadHolidays();
    const cache = new HolidayCache((_country, done) =>
        done({ years: {}, holidays: [] }), () => {});
    cache.addUnique({
        year: 2031, month: 1, day: 1, region: "global",
        name: "One", flags: ["PART_DAY_HOLIDAY"]
    });
    const before = cache.matchMonth(2031, 1);

    cache.addUnique({
        year: 2031, month: 1, day: 1, region: "global",
        name: "Uno", flags: ["PART_DAY_HOLIDAY", "optional"]
    });
    const after = cache.matchMonth(2031, 1);

    assert.notEqual(after, before);
    assert.deepEqual(after.get("1/1"),
        { name: "One\nUno", flags: ["PART_DAY_HOLIDAY", "optional"] });
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

    const july = Array.from(enrico.matchMonth(year, 7).values()).map((entry) => entry.name);
    assert.deepEqual(july, ["Marine Day"],
        "France's holidays do not show up in Japan's calendar");

    const persisted = saved
        .filter(([country]) => country === "jpn")
        .flatMap(([, data]) => data.holidays.map((single) => single.name));
    assert.equal(persisted.includes("Bastille Day"), false,
        "and they are not written to disk under Japan either");
});

test("the per-year status record does not outlive the years the cache holds", () => {
    const { HolidayService, HolidayCache } = loadHolidays();
    const { MAX_CACHED_YEARS } = require(holidayCachePath);
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
    for (let offset = 0; offset <= MAX_CACHED_YEARS; offset++) {
        enrico.retrieveForYear(current + offset);
    }

    // _inflight cleans up after itself; the status beside it used to grow one
    // entry per year+region ever browsed. It follows the cache's LRU: the one
    // year the LRU evicted takes its status record with it, the rest stay.
    assert.deepEqual(Object.keys(enrico._status._status).sort(),
        Array.from({ length: MAX_CACHED_YEARS },
            (_, i) => `${current + i + 1}/global`).sort());
});

// T525 regression: Cinnamon runs the first grid update in the same call stack
// as applet construction, while setPlace's disk read is still in flight — the
// cache looked empty, staleCache answered true, and a real HTTP fetch went out
// for data already fresh on disk, on every applet load. The fixture answers
// loads synchronously, so this test defers the load by hand like Gio does.
test("the first grid read waits for the disk cache instead of fetching", () => {
    const { HolidayCache, HolidayService } = loadHolidays();
    const year = FIXED_YEAR;
    const stamp = new Date(Date.now() - 60 * 60 * 1000).toUTCString();
    let deliverLoad = null;
    const cache = new HolidayCache((_country, done) => {
        deliverLoad = () => done({
            years: { [year]: { global: stamp } },
            holidays: [{ year, month: 7, day: 4, name: "Cached Day", flags: [], region: "global" }]
        });
    }, () => {});
    const fetches = [];
    const service = {
        fetchYear(country, region, y) { fetches.push(`${country}/${region}/${y}`); },
        validResponse: () => true
    };
    const enrico = new HolidayService(service, cache, { record: service });

    const updates = [];
    enrico.setPlace("usa", "global", () => updates.push("place"));
    const answers = [];
    enrico.getHolidays(year, 7, (dates, error) => answers.push([dates, error]));

    assert.deepEqual(fetches, [], "no fetch is dispatched before the disk read lands");
    assert.deepEqual(answers, [], "the grid answer waits for the cache");

    deliverLoad();
    assert.deepEqual(fetches, [], "a fresh disk cache satisfies startup without a fetch");
    assert.deepEqual(updates, ["place"]);
    assert.equal(answers.length, 1);
    assert.deepEqual(answers[0][0].get("7/4"), { name: "Cached Day", flags: [] });
    assert.equal(answers[0][1], "");
});

// the queue must never wedge: leaving the place while a load is in flight
// answers the abandoned waiters without inventing a provider failure
test("clearing the place releases readers queued behind a pending load", () => {
    const { HolidayCache, HolidayService } = loadHolidays();
    const cache = new HolidayCache(() => {}, () => {});
    const service = { fetchYear() { throw new Error("no fetch expected"); }, validResponse: () => true };
    const enrico = new HolidayService(service, cache, { record: service });
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    enrico.setPlace("usa", "global");
    const answers = [];
    enrico.getHolidays(FIXED_YEAR, 7, (dates, error) => answers.push([dates.size, error]));
    assert.deepEqual(answers, []);

    enrico.clearPlace();
    assert.deepEqual(answers, [[0, ""]]);
    assert.deepEqual(logged, [], "an intentional opt-out is not a provider failure");
});

test("a failing abandoned holiday reader cannot interrupt place retirement", () => {
    const { HolidayCache, HolidayService } = loadHolidays();
    const cache = new HolidayCache(() => {}, () => {});
    const service = { fetchYear() { throw new Error("no fetch expected"); }, validResponse: () => true };
    const enrico = new HolidayService(service, cache, { record: service });
    const failure = new Error("calendar was already rebuilt");

    enrico.setPlace("usa", "global");
    enrico.getHolidays(FIXED_YEAR, 7, () => { throw failure; });
    enrico._inflight.start("2027/global", () => {}, enrico._place_generation);
    enrico.last_error = "old failure";
    enrico.last_provider = "old provider";
    enrico._status.record("2027/global");
    const generation = enrico._place_generation;

    assert.throws(() => enrico.clearPlace(), (error) => error === failure);
    assert.equal(enrico._place_generation, generation + 1);
    assert.equal(enrico.fetching(2027), false);
    assert.equal(enrico.last_error, "");
    assert.equal(enrico.last_provider, "");
});

// T975: after destroy the actors a repaint would touch are gone, so a late grid
// read must not fetch — but it must still settle. calendarAnnotations counts one
// callback per getHolidays() and reconciles only at zero, so a silent return left
// the month label pending and the previous country's cells on the grid forever.
test("a grid read after destroy settles empty without fetching", () => {
    const { HolidayCache, HolidayService } = loadHolidays();
    const fresh = new Date(Date.now() - 60000).toUTCString();
    const cache = new HolidayCache((_country, done) => done({
        years: { [FIXED_YEAR]: { global: fresh } }, holidays: []
    }), () => {});
    const service = { fetchYear() { throw new Error("no fetch expected"); }, validResponse: () => true };
    const enrico = new HolidayService(service, cache, { record: service });
    enrico.setPlace("usa", "global");
    enrico.destroy();

    const answers = [];
    assert.doesNotThrow(() => enrico.getHolidays(
        FIXED_YEAR, 7, (dates, error, provider) => answers.push([dates.size, error, provider])));
    assert.deepEqual(answers, [[0, "", ""]],
        "settled empty, and not as a transient provider failure");
});

test("destroy settles a pending read without reading through the cache", () => {
    const { HolidayService } = loadHolidays();
    let deliverReady = null;
    let matches = 0;
    const cache = {
        country: "usa",
        region: "global",
        whenReady(callback) { deliverReady = callback; },
        stale: () => false,
        matchMonth() {
            matches++;
            return new Map();
        }
    };
    const service = { fetchYear() { throw new Error("no fetch expected"); } };
    const enrico = new HolidayService(service, cache, { record: service });
    let answered = 0;

    enrico.getHolidays(FIXED_YEAR, 7, () => answered++);
    enrico.destroy();
    deliverReady();

    assert.equal(answered, 1, "the pending read settles rather than stranding the annotator");
    assert.equal(matches, 0, "the dead service does not read through its cache");
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

function regionRows(year, region) {
    const rows = [];
    for (let day = 1; day <= 28; day++) {
        for (let month = 1; month <= 4; month++) {
            rows.push({ year, month, day, region, name: `${region} ${month}/${day}`, flags: [] });
        }
    }
    return rows;
}

function fillRegionHeavySession(cache, years, regions, stamp) {
    for (const year of years) {
        for (let index = 0; index < regions; index++) {
            cache.recordFetch(year, `region${index}`, stamp, regionRows(year, `region${index}`));
        }
    }
}

// T524 regression: the loader accepts at most MAX_EXPANDED_HOLIDAY_ROWS rows
// per country and wipes every freshness stamp when a snapshot comes back
// truncated — so a persisted snapshot above the cap turned into a refetch and
// a rewrite on every applet load, forever. The persist side now evicts whole
// years, stamps together with rows, until the snapshot fits the loader.
test("an oversized session persists a snapshot the loader accepts whole", () => {
    const { HolidayCache, HolidayCacheRepository } = loadHolidays();
    const { MAX_EXPANDED_HOLIDAY_ROWS } = require(holidayRecordPath);
    const saved = [];
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        (country, data) => saved.push([country, data])
    );
    cache.setPlace("deu", "global");

    const now = new Date();
    const current = now.getFullYear();
    const stamp = new Date(now.getTime() - 60000).toUTCString();
    fillRegionHeavySession(cache, [current - 1, current, current + 1], 16, stamp);
    assert.ok(cache.data.length > MAX_EXPANDED_HOLIDAY_ROWS,
        "the session accumulated more in-window rows than the loader accepts");
    cache.persist(now);

    const [, snapshot] = saved[0];
    assert.ok(snapshot.holidays.length > 0);
    assert.ok(snapshot.holidays.length <= MAX_EXPANDED_HOLIDAY_ROWS,
        "the persisted snapshot fits the loader's per-country cap");
    // the farthest year went first, rows and stamps together
    assert.deepEqual(Object.keys(snapshot.years).map(Number).sort((a, b) => a - b),
        [current, current + 1]);
    assert.equal(snapshot.holidays.some((single) => single.year === current - 1), false);
    // the live session keeps everything it fetched
    assert.equal(cache.data.length, 3 * 16 * regionRows(current, "region0").length);

    const repository = new HolidayCacheRepository("/holidays.json");
    const loaded = repository._country(
        { deu: Object.assign({ savedAt: Date.now() }, snapshot) }, "deu");
    assert.equal(loaded.holidays.length, snapshot.holidays.length);
    assert.deepEqual(loaded.years, snapshot.years,
        "no freshness stamp is wiped on the way back in");
});

// the degenerate corner of the same cap: one year alone above the loader's cap
// is truncated, and its stamp goes with the dropped rows so the incomplete year
// is refetched instead of trusted as complete
test("a single year above the loader cap persists truncated and unstamped", () => {
    const { HolidayCache, HolidayCacheRepository } = loadHolidays();
    const { MAX_EXPANDED_HOLIDAY_ROWS } = require(holidayRecordPath);
    const saved = [];
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        (country, data) => saved.push([country, data])
    );
    cache.setPlace("deu", "global");

    const now = new Date();
    const current = now.getFullYear();
    const stamp = new Date(now.getTime() - 60000).toUTCString();
    fillRegionHeavySession(cache, [current], 40, stamp);
    assert.ok(cache.data.length > MAX_EXPANDED_HOLIDAY_ROWS);
    cache.persist(now);

    const [, snapshot] = saved[0];
    assert.equal(snapshot.holidays.length, MAX_EXPANDED_HOLIDAY_ROWS);
    assert.equal(snapshot.years[current], undefined,
        "a truncated year carries no freshness stamp");

    const repository = new HolidayCacheRepository("/holidays.json");
    const loaded = repository._country(
        { deu: Object.assign({ savedAt: Date.now() }, snapshot) }, "deu");
    assert.equal(loaded.holidays.length, MAX_EXPANDED_HOLIDAY_ROWS);
    assert.deepEqual(loaded.years, {});
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
    assert.equal(cache.matchMonth(ahead, 12, "global").get("12/25").name, "Future");
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

test("concurrent country loads share the repository's first file read", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const contents = Buffer.from(JSON.stringify({
        usa: { years: {}, holidays: [{ year: 2026, month: 7, day: 4,
            region: "global", name: "USA", flags: [] }] },
        ita: { years: {}, holidays: [{ year: 2026, month: 6, day: 2,
            region: "global", name: "Italy", flags: [] }] }
    }));
    const reads = [];
    const file = {
        get_path: () => cachePath("holidays.json"),
        query_info_async(_attributes, _flags, _priority, _cancellable, callback) {
            callback(this, { ok: true });
        },
        query_info_finish: () => ({ get_size: () => contents.length }),
        load_contents_async(_cancellable, callback) {
            reads.push(() => callback(this, { ok: true }));
        },
        load_contents_finish: () => [true, contents, "v1"]
    };
    global.imports.gi.Gio.file_new_for_path = () => file;
    const repository = new HolidayCacheRepository("/holidays.json");
    const answers = [];

    repository.loadAsync("usa", (data) => answers.push(data.holidays[0].name));
    repository.loadAsync("ita", (data) => answers.push(data.holidays[0].name));

    assert.equal(reads.length, 1, "one in-flight read owns the shared file");
    assert.deepEqual(answers, []);
    reads[0]();
    assert.deepEqual(answers, ["USA", "Italy"],
        "every queued consumer receives its own country projection");
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
        query_info_async(_attributes, _flags, _priority, _cancellable, callback) {
            callback(this, { ok: true });
        },
        query_info_finish() {
            return { get_size: () => Buffer.byteLength(contents) };
        },
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
    const { validDateParts } = require(holidayRecordPath);
    const rand = makeRandom(0xca6e);
    const pick = (pool) => pool[Math.floor(rand() * pool.length)];
    const numbers = [
        2024, 2026, 1, 2, 28, 29, 30, 31, 99, 0, -1, 1.5, NaN, Infinity,
        "2026", null, undefined, {}, []
    ];
    const names = [
        "New Year", "", "   ", "\t\n", "x".repeat(500),
        42, null, undefined, {}, ["a"]
    ];
    const flagSets = [[], ["public_holiday"], "public_holiday", null, undefined, {}, 7];
    const regions = ["global", "ca", "", 42, null, undefined, {}];

    for (const name of ["", " ", "\t\n"]) {
        assert.equal(validCachedHoliday({
            year: 2026, month: 1, day: 1, name, flags: [], region: "global"
        }), false);
    }

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
        assert.ok(validDateParts(candidate), "accepted parts form a real calendar date");
        assert.equal(typeof candidate.name, "string");
        assert.ok(candidate.name.trim(), "accepted names remain visible");
        assert.ok(Array.isArray(candidate.flags));
        assert.ok(candidate.region === undefined || typeof candidate.region === "string");
    }
});

test("one impossible cached date invalidates freshness but a leap day survives", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const { validCachedHoliday } = require(holidayCachePath);
    const repository = new HolidayCacheRepository("/holidays.json");
    const leap = {
        year: 2024, month: 2, day: 29, region: "global", name: "Leap Day", flags: []
    };
    const impossible = [
        { year: 2026, month: 99, day: 99, region: "global", name: "Impossible", flags: [] },
        { year: 2026, month: 2, day: 29, region: "global", name: "False Leap Day", flags: [] }
    ];

    assert.equal(validCachedHoliday(leap), true);
    for (const row of impossible) {
        assert.equal(validCachedHoliday(row), false);
    }

    const loaded = repository._country({
        usa: {
            years: { 2024: { global: STAMP }, 2026: { global: STAMP } },
            holidays: [leap, ...impossible]
        }
    }, "usa");

    assert.deepEqual(loaded.holidays, [leap], "the valid leap day remains renderable");
    assert.deepEqual(loaded.years, {}, "one rejected row makes every snapshot stamp stale");
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
                { year: 2026, month: 1, day: 4, name: "", flags: [], region: "global" },
                { year: 2026, month: 1, day: 5, name: "   ", flags: [], region: "global" },
                "not even an object"
            ]
        }
    }));

    const loaded = loadCountry(repository, "usa");

    assert.deepEqual(loaded.holidays.map((single) => single.name), ["New Year"]);
});

test("a tampered cache cannot claim the local religious marker", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json");
    const stamp = "Thu, 01 Jan 2026 00:00:00 GMT";
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("holidays.json"), JSON.stringify({
        usa: {
            years: { 2026: { global: stamp } },
            holidays: [{
                year: 2026,
                month: 12,
                day: 25,
                name: "Provider Christmas",
                flags: ["public_holiday", "religious_holiday", "bank"],
                region: "global"
            }]
        }
    }));

    const loaded = loadCountry(repository, "usa");

    assert.deepEqual(loaded.holidays[0].flags, ["public_holiday", "bank"]);
    assert.equal(loaded.years[2026].global, stamp,
        "sanitizing one flag keeps the otherwise complete snapshot fresh");
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

// REGRESSION: the key was marked in flight and *then* dispatched, with no
// finally on the dispatch itself — so a fetchYear that raised left the key
// behind and blocked every later fetch of that year for the life of the place
// selection, stranding the month label on its pending marker. The same hazard
// _acceptYear's finally already prevents, on the path that dispatches.
test("a fetch that raises on dispatch never wedges the year", () => {
    const { HolidayService, HolidayCache, HOLIDAY_ERRORS } = loadHolidays();
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    let fetches = 0;
    const service = {
        fetchYear() {
            fetches++;
            throw new Error("session disposed mid-reload");
        },
        validResponse: () => true
    };
    const enrico = new HolidayService(service, cache, { record: service });
    enrico.country = "usa";
    enrico.region = "global";
    global.logError = () => {};

    let callbacks = 0;
    enrico.retrieveForYear(2026, () => callbacks++);
    assert.equal(callbacks, 1, "the waiting callback still runs");
    assert.equal(enrico.last_error, HOLIDAY_ERRORS.SERVICE_UNAVAILABLE);
    assert.equal(enrico.fetching(2026), false, "the in-flight key must be released");

    enrico.retrieveForYear(2026, () => callbacks++);
    assert.equal(fetches, 2, "and the year can be fetched again");
});

// T777: releasing the key was only half of it. _acceptYear also records the
// attempt on entry and the status in its finally; _abandonYear did neither.
// respond() reads the *key* through _statusFor, and the ledger answers
// {error: "", provider: ""} for a key it never saw — so the month rendered
// bare, with no warning marker and no tooltip, while last_error said the
// service was unavailable. The missing attempt was the other half: the
// RETRY_PERIOD throttle was never armed, so every later calendar update
// re-dispatched and re-raised for the rest of the session.
test("a dispatch that raises warns the month and arms the retry throttle", () => {
    const { HolidayService, HolidayCache, HOLIDAY_ERRORS } = loadHolidays();
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    let fetches = 0;
    const service = {
        fetchYear() {
            fetches++;
            throw new Error("session disposed mid-reload");
        },
        validResponse: () => true
    };
    const enrico = new HolidayService(service, cache, { record: service });
    enrico.country = "usa";
    enrico.region = "global";
    enrico.last_provider = "openholidays";
    global.logError = () => {};

    const answers = [];
    const collect = (map, error, provider) => answers.push({ map, error, provider });

    enrico.getHolidays(2026, 3, collect);

    assert.equal(fetches, 1);
    assert.equal(answers.length, 1);
    assert.equal(answers[0].error, HOLIDAY_ERRORS.SERVICE_UNAVAILABLE,
        "the month says why it is empty instead of rendering bare");
    assert.equal(answers[0].provider, "",
        "a dispatch that reached no provider is attributed to none");

    // the 42-day grid always spans two months, and the calendar updates on
    // every tick: the attempt stamp is the only thing standing between one
    // failed dispatch and a fetch storm for the rest of the session
    enrico.getHolidays(2026, 4, collect);

    assert.equal(fetches, 1, "the RETRY_PERIOD throttle is armed");
    assert.equal(answers[1].error, HOLIDAY_ERRORS.SERVICE_UNAVAILABLE,
        "and the second month is warned from the same record");
});

// the other half: once the year has settled, a throw coming back out through a
// waiting callback the fetch ran synchronously is that callback's own
test("a throw from a settled year's callback is not reported as a fetch failure", () => {
    const { HolidayService, HolidayCache } = loadHolidays();
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    const service = {
        fetchYear(_country, _region, _year, callback) {
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

    assert.throws(() => enrico.retrieveForYear(2026, () => {
        throw new Error("consumer exploded");
    }), /consumer exploded/);
    assert.equal(enrico.fetching(2026), false,
        "the year settled before the callback ran, and stays settled");
});

test("a successful year fetch settles every waiting month", () => {
    const { HolidayService, HolidayCache } = loadHolidays();
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    let answer = null;
    const service = {
        fetchYear(_country, _region, _year, callback) { answer = callback; },
        validResponse: () => true,
        expandHoliday: () => []
    };
    const enrico = new HolidayService(service, cache, { record: service });
    enrico.country = "usa";
    enrico.region = "global";
    const calls = [];
    const first = new Error("first month failed");

    enrico.retrieveForYear(2026, () => { calls.push("first"); throw first; });
    enrico.retrieveForYear(2026, () => calls.push("second"));

    assert.throws(() => answer([], {
        year: 2026, region: "global", providerName: "test"
    }, new Date().toUTCString()), (error) => error === first);
    assert.deepEqual(calls, ["first", "second"]);
    assert.equal(enrico.fetching(2026), false);
});

test("a failed year dispatch settles every waiting month", () => {
    const { HolidayService, HolidayCache } = loadHolidays();
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        () => {}
    );
    const calls = [];
    const first = new Error("first month failed");
    let enrico = null;
    const service = {
        fetchYear() {
            enrico.retrieveForYear(2026, () => calls.push("second"));
            throw new Error("dispatch failed");
        },
        validResponse: () => true
    };
    enrico = new HolidayService(service, cache, { record: service });
    enrico.country = "usa";
    enrico.region = "global";
    global.logError = () => {};

    assert.throws(() => enrico.retrieveForYear(2026, () => {
        calls.push("first");
        throw first;
    }), (error) => error === first);
    assert.deepEqual(calls, ["first", "second"]);
    assert.equal(enrico.fetching(2026), false);
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

    assert.deepEqual(answered.holidays.get("7/4"), { name: "Cached", flags: [] });
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

// T803: HolidayCache held five unrelated responsibilities - the row store and
// its two indexes, a year LRU, a month memo with its own eviction, the
// freshness policy and the persistence windowing. T784 was a direct consequence
// of the last two sharing a helper with the first. These two are collaborators
// the store is given now, and each can be driven without a cache at all.
test("the freshness policy answers on its own, with no store around it", () => {
    const { HolidayFreshness, UPDATE_PERIOD, RETRY_PERIOD } = loadHolidays();
    const freshness = new HolidayFreshness();
    const now = Date.UTC(2026, 6, 14, 12);
    const stamp = (msAgo) => new Date(now - msAgo).toUTCString();

    assert.equal(freshness.stale(null, null, now), true, "never asked is stale");
    assert.equal(freshness.stale(stamp(UPDATE_PERIOD - 60_000), null, now), false);
    assert.equal(freshness.stale(stamp(UPDATE_PERIOD + 60_000), null, now), true);

    // a failure inside the retry period is what stops a provider being hammered
    // while it is down, and it is a different period from the fetch's
    assert.equal(freshness.stale(null, stamp(RETRY_PERIOD - 60_000), now), false);
    assert.equal(freshness.stale(null, stamp(RETRY_PERIOD + 60_000), now), true);
    assert.equal(
        freshness.stale(stamp(UPDATE_PERIOD + 60_000), stamp(RETRY_PERIOD - 60_000), now),
        false, "an old fetch and a recent failure still hold the refetch off");

    // and the periods are the collaborator's, so a caller can hold a different
    // policy without the store knowing
    const impatient = new HolidayFreshness({ updatePeriod: 1000, retryPeriod: 1 });
    assert.equal(impatient.stale(stamp(2000), null, now), true);
});

test("the persist window answers on its own, and copies rather than prunes", () => {
    const { HolidayPersistWindow } = loadHolidays();
    const window = new HolidayPersistWindow({ yearWindow: 1, maxRows: 3 });
    const now = new Date(Date.UTC(2026, 6, 14));
    const row = (year, day) => ({ year, month: 1, day, region: "global",
        name: `H${year}/${day}`, flags: [] });
    const years = { 2025: { global: "a" }, 2026: { global: "b" },
        2028: { global: "far" } };
    const rows = [row(2025, 1), row(2026, 1), row(2028, 1)];

    const snapshot = window.snapshot(years, rows, now);

    assert.deepEqual(Object.keys(snapshot.years), ["2025", "2026"],
        "out of the ±1-year window and off the disk");
    assert.deepEqual(snapshot.holidays.map((single) => single.year), [2025, 2026]);
    assert.deepEqual(Object.keys(years), ["2025", "2026", "2028"],
        "and the live tables are untouched: pruning them in place lost a "
        + "just-fetched year and the stamp that throttles it");

    // over the row ceiling, whole years go, farthest from today first
    const many = [row(2025, 1), row(2025, 2), row(2026, 1), row(2026, 2)];
    const bounded = window.snapshot(
        { 2025: { global: "a" }, 2026: { global: "b" } }, many, now);
    assert.deepEqual(Object.keys(bounded.years), ["2026"]);
    assert.deepEqual(bounded.holidays.map((single) => single.year), [2026, 2026]);

    // one year alone over the ceiling: what fits is written, and its stamp is
    // dropped so the truncated year is refetched rather than trusted
    const single = [row(2026, 1), row(2026, 2), row(2026, 3), row(2026, 4)];
    const truncated = window.snapshot({ 2026: { global: "b" } }, single, now);
    assert.equal(truncated.holidays.length, 3);
    assert.deepEqual(truncated.years, {});
});

test("the cache can be given a different freshness and a different window", () => {
    const { HolidayCache, HolidayFreshness, HolidayPersistWindow } = loadHolidays();
    const saved = [];
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        (country, snapshot) => saved.push([country, snapshot]),
        {
            freshness: new HolidayFreshness({ updatePeriod: 1, retryPeriod: 1 }),
            persistWindow: new HolidayPersistWindow({ yearWindow: 0, maxRows: 10 })
        });
    cache.setPlace("fra", "global");
    const now = Date.UTC(2026, 6, 14, 12);
    cache.recordFetch(2026, "global", new Date(now).toUTCString(),
        [{ year: 2026, month: 7, day: 14, region: "global", name: "Fête", flags: [] }]);
    cache.addUnique({ year: 2027, month: 1, day: 1, region: "global",
        name: "Next", flags: [] });

    assert.equal(cache.stale(2026, "global", now + 10), true,
        "a one-millisecond update period is the policy the cache was given");

    cache.persist(new Date(Date.UTC(2026, 6, 14)));
    assert.deepEqual(saved.at(-1)[1].holidays.map((single) => single.year), [2026],
        "and a zero-year window keeps only this year");
});

// T987: the two policies were re-exported from the barrel under a comment
// saying the composition root could hand the cache different ones without
// reaching past it — and nothing forwarded them, so the only way in was to
// build the whole cache by hand and inject it as `cache`.
test("the composition root can hand the cache its staleness policy", () => {
    const { createHolidayProvider, HolidayFreshness, HolidayPersistWindow } = loadHolidays();
    const provider = createHolidayProvider({
        freshness: new HolidayFreshness({ updatePeriod: 1, retryPeriod: 1 }),
        persistWindow: new HolidayPersistWindow({ yearWindow: 0, maxRows: 3 }),
        service: { fetch() {} }
    });
    const cache = provider._base._provider.cache;

    cache.setPlace("fra", "global");
    const now = Date.UTC(2026, 6, 14, 12);
    cache.recordFetch(2026, "global", new Date(now).toUTCString(),
        [{ year: 2026, month: 7, day: 14, region: "global", name: "Fête", flags: [] }]);

    assert.equal(cache.stale(2026, "global", now + 10), true,
        "the injected one-millisecond update period is the policy in force");
    assert.equal(cache._persist_window._year_window, 0,
        "and the persistence window is the injected one too");
});

// T986: each incoming row is capped at MAX_HOLIDAY_FLAGS on the way in, and the
// merge of two same-day rows was not — so a union of disjoint flag sets could
// mint a row the loader would reject, at which point _country saw a row count
// that no longer matched what had been written and threw away *every* freshness
// stamp for the country. The country then refetched at every login, forever.
test("merging same-day holiday rows keeps the flag count inside the loader's bound", () => {
    const { HolidayCache } = loadHolidays();
    const { MAX_HOLIDAY_FLAGS, validHolidayFlags } = require(holidayRecordPath);
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    cache.setPlace("ita", "global");

    const row = (name, flags) => ({
        year: 2026, month: 1, day: 1, region: "global", name, flags
    });
    cache.addUnique(row("First", ["a", "b", "c", "d", "e", "f", "g", "h"]));
    cache.addUnique(row("Second", ["i", "j", "k", "l", "m", "n", "o", "p"]));

    const [merged] = cache.data;
    assert.ok(merged.flags.length <= MAX_HOLIDAY_FLAGS,
        `merged row carries ${merged.flags.length} flags, past the bound of ${MAX_HOLIDAY_FLAGS}`);
    assert.equal(validHolidayFlags(merged.flags), true,
        "and the row the loader reads back survives its own validator");
});

// T997: past MAX_HOLIDAY_NAME_LENGTH the clamp cuts the trailing names off, so
// the `includes` membership test could never find them again and every later
// same-day row evicted the month memo for a string that had not moved.
test("a same-day row that cannot lengthen the clamped name leaves the memo alone", () => {
    const { HolidayCache } = loadHolidays();
    const makeCache = () =>
        new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    const row = (name) => ({ year: 2026, month: 1, day: 1, region: "global", name, flags: [] });

    // read the bound off the clamp rather than importing it: holidayCache.js
    // cannot be required outside this fixture's GLib stubs (see T988)
    const probe = makeCache();
    probe.setPlace("ita", "global");
    probe.addUnique(row("x".repeat(4000)));
    const nameLimit = probe.data[0].name.length;
    assert.ok(nameLimit > 0 && nameLimit < 4000, "the name is clamped at all");

    const cache = makeCache();
    cache.setPlace("ita", "global");
    cache.addUnique(row("x".repeat(nameLimit)));

    let invalidations = 0;
    const realInvalidate = cache._invalidateMonth.bind(cache);
    cache._invalidateMonth = (single) => {
        invalidations++;
        realInvalidate(single);
    };

    // the first join genuinely changes the string — it gains the ellipsis the
    // clamp writes — so it is a change and must invalidate
    cache.addUnique(row("Overflowing name one"));
    assert.equal(invalidations, 1);
    const settled = cache.data[0].name;

    // every join after that re-clamps to the same bytes, and used to invalidate
    // the month memo anyway, once per row, forever
    cache.addUnique(row("Overflowing name two"));
    cache.addUnique(row("Overflowing name three"));
    assert.equal(cache.data[0].name, settled, "the clamped name cannot grow further");
    assert.equal(invalidations, 1,
        "so no later row is a change, and the month memo is not rebuilt for nothing");
});

// T996: release() reset the region and clearPlace() did not, so two methods
// that both mean "no place is selected" left the cache in two different states
// and stale()/matchMonth() kept defaulting to the departed place's region.
test("clearing the place resets the region, exactly as releasing does", () => {
    const { HolidayCache } = loadHolidays();
    const makeCache = () =>
        new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});

    // a cache that has never held a place is the definition of the default
    const defaultRegion = makeCache().region;

    const cleared = makeCache();
    cleared.setPlace("ita", "veneto");
    assert.equal(cleared.region, "veneto");
    cleared.clearPlace();
    assert.equal(cleared.region, defaultRegion);

    const released = makeCache();
    released.setPlace("ita", "veneto");
    released.release();
    assert.equal(released.region, defaultRegion, "the two paths agree");
});
