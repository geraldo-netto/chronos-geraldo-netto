const {
    assert, test, vm, fs, makeSoup3, FIXED_YEAR, STAMP,
    holidayServiceAdaptersPath, shimPath,
    loadHolidays, holiday, anyRecord
} = require("./helpers/holidayFixture");

test("the version shim forwards the shared provider module", () => {
    const shared = {
        Provider: class {},
        HolidayCacheRepository: class {},
        HolidayCache: class {},
        EnricoServiceAdapter: class {},
        NagerDateServiceAdapter: class {},
        OpenHolidaysServiceAdapter: class {},
        HolidayFallbackChain: class {},
        HolidayService: class {},
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
// the two ISO adapters had to reshape their answers into HolidayService's wire format to
// get past a check that belonged to HolidayService. A provider that did not was rejected
// as INVALID_RESPONSE with nothing to say the validator was the wrong one.
// What a provider author has to implement had three different answers: the
// primary carried fetchYear plus five forwards to a contract it privately owned,
// the two ISO adapters carried none of them, and the chain forwarded two more on
// the domain's behalf. This is the port, and it is one method wide.
test("an adapter is a fetchYear and nothing else", () => {
    const {
        EnricoServiceAdapter, NagerDateServiceAdapter, OpenHolidaysServiceAdapter
    } = loadHolidays();

    const adapters = [
        new EnricoServiceAdapter(), new NagerDateServiceAdapter(),
        new OpenHolidaysServiceAdapter()
    ];

    for (const adapter of adapters) {
        assert.equal(typeof adapter.fetchYear, "function", `${adapter.name} cannot fetch a year`);
        for (const owed of ["validResponse", "expandHoliday", "localizeName", "validHoliday"]) {
            assert.equal(typeof adapter[owed], "undefined",
                `${adapter.name} still carries ${owed}, which belongs to the record contract`);
        }
    }
});

// and the port is enough on its own: a fourth provider that implements fetchYear
// and knows nothing about the record contract reaches the grid.
test("a fourth provider that only fetches years works in the shipped graph", () => {
    const { createHolidayProvider, HolidayCache } = loadHolidays();
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: []}), () => {});
    const newcomer = {
        name: "Newcomer",
        fetchYear(_country, _region, year, callback) {
            callback([holiday("Founding Day", year, 7, 14)],
                { year, region: "global", providerName: "Newcomer" }, STAMP);
        }
    };

    const provider = createHolidayProvider({ service: newcomer, cache });
    provider.setPlace("fra", "global");

    let matched = null;
    provider.getHolidays(2026, 7, (holidays) => { matched = holidays; });

    assert.deepEqual(matched.get("7/14"), ["Founding Day", ["public_holiday"]]);
});

test("the chain validates against the record contract, not against the primary", () => {
    const { HolidayRecordContract } = loadHolidays();
    // the contract is a thing of its own: no adapter, primary or otherwise, is
    // asked what a valid answer looks like
    const contract = new HolidayRecordContract("en");

    const record = {
        date: { year: 2026, month: 7, day: 14 },
        name: [{ lang: "en", text: "Bastille Day" }],
        flags: []
    };

    assert.equal(contract.validResponse([record]), true);
    assert.equal(contract.validResponse([{ nope: true }]), false,
        "a payload that is not a holiday record is refused whoever sent it");
    assert.deepEqual(contract.expandHoliday(record, "global"), [
        { year: 2026, month: 7, day: 14, name: "Bastille Day", flags: [], region: "global" }
    ]);
});

// The chain's one use of the contract: a provider whose answer the contract
// refuses has not answered, so the next provider is tried. That decision is the
// only thing the chain needs the contract for — it forwards none of it onward.
test("a provider whose payload the contract refuses falls through to the next", () => {
    const { createHolidayServiceChain } = loadHolidays();
    const primary = {
        name: "primary",
        fetchYear(_country, _region, _year, callback) {
            callback({ not: "a list" }, { providerName: "primary" }, STAMP);
        }
    };
    const fallback = {
        name: "fallback",
        fetchYear(_country, _region, year, callback) {
            callback([{ year }], { providerName: "fallback" }, STAMP);
        }
    };
    const adapter = createHolidayServiceChain(primary, [fallback], anyRecord());

    const answers = [];
    adapter.fetchYear("fra", "global", 2026, (data, params) => answers.push([data, params]));

    assert.equal(answers.length, 1);
    assert.deepEqual(answers[0][0], [{ year: 2026 }]);
    assert.equal(answers[0][1].providerName, "fallback",
        "the primary's non-record answer is not an answer");

    // and the chain exposes no contract of its own: an adapter owes fetchYear
    assert.equal(typeof adapter.validResponse, "undefined");
    assert.equal(typeof adapter.expandHoliday, "undefined");
});

test("a provider answer for another year falls through before the cache is stamped", () => {
    const { HolidayRecordContract, createHolidayServiceChain } = loadHolidays();
    const row = (year, text) => ({
        date: { year, month: 1, day: 1 },
        name: [{ lang: "en", text }],
        flags: []
    });
    const calls = [];
    const primary = {
        name: "Wrong year",
        fetchYear(_country, _region, _year, callback) {
            calls.push(this.name);
            callback([row(2027, "Too late")],
                { year: 2026, region: "global", providerName: this.name }, STAMP);
        }
    };
    const fallback = {
        name: "Requested year",
        fetchYear(_country, _region, year, callback) {
            calls.push(this.name);
            callback([row(year, "New Year")],
                { year, region: "global", providerName: this.name }, STAMP);
        }
    };
    const chain = createHolidayServiceChain(
        primary, [fallback], new HolidayRecordContract("en"));

    let answer;
    chain.fetchYear("ita", "global", 2026, (data, params) => {
        answer = { data, params };
    });

    assert.deepEqual(calls, ["Wrong year", "Requested year"]);
    assert.deepEqual(answer.data, [row(2026, "New Year")]);
    assert.equal(answer.params.providerName, "Requested year");
});

test("a provider parse failure falls through and credits the successful source", () => {
    const { createHolidayServiceChain } = loadHolidays();
    const calls = [];
    const primary = {
        name: "Broken parser",
        fetchYear(_country, _region, year, callback) {
            calls.push(this.name);
            callback([{ broken: true }], { year }, STAMP);
        }
    };
    const fallback = {
        name: "Backup source",
        fetchYear(_country, _region, year, callback) {
            calls.push(this.name);
            callback([{ year }], { year }, STAMP);
        }
    };
    const record = anyRecord({
        validResponse(data) {
            if (data[0] && data[0].broken) {
                throw new Error("cannot parse provider payload");
            }
            return Array.isArray(data);
        }
    });
    const service = createHolidayServiceChain(primary, [fallback], record);

    let answer;
    assert.doesNotThrow(() => {
        service.fetchYear("ita", "global", 2026, (data, params) => {
            answer = { data, params };
        });
    });

    assert.deepEqual(calls, ["Broken parser", "Backup source"]);
    assert.deepEqual(answer.data, [{ year: 2026 }]);
    assert.equal(answer.params.providerName, "Backup source");
    assert.equal(service._last_provider, "Backup source");
});

test("an adapter translation failure becomes failover instead of escaping", () => {
    const { createHolidayServiceChain } = loadHolidays();
    const { IsoHolidayServiceAdapter } = require(holidayServiceAdaptersPath);
    class BrokenAdapter extends IsoHolidayServiceAdapter {
        constructor() {
            super((_url, params, callback) => callback([], params, STAMP));
            this.name = "Broken adapter";
        }

        params(_country, _region, year) {
            return { year, countryCode: "IT" };
        }

        url() {
            return "https://example.test/broken";
        }

        translateResponse() {
            throw new Error("translation failed");
        }
    }
    const fallback = {
        name: "Usable source",
        fetchYear(_country, _region, year, callback) {
            callback([{ year }], { year }, STAMP);
        }
    };
    const service = createHolidayServiceChain(new BrokenAdapter(), [fallback], anyRecord());

    let answer;
    assert.doesNotThrow(() => {
        service.fetchYear("ita", "global", 2026, (data, params) => {
            answer = { data, params };
        });
    });

    assert.deepEqual(answer.data, [{ year: 2026 }]);
    assert.equal(answer.params.providerName, "Usable source");
});

test("the fallback chain reports provider success and failure", () => {
    const { createHolidayServiceChain } = loadHolidays();
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
    const adapter = createHolidayServiceChain(bad, [good], anyRecord());
    const callbacks = [];
    adapter.fetchYear("ita", "global", 2026, (...args) => callbacks.push(args));
    assert.deepEqual(callbacks[0][0], [{ year: 2026 }]);
    assert.equal(callbacks[0][1].provider, "good");
    assert.equal(adapter._last_provider, "good");

    const allBad = createHolidayServiceChain(bad, [], anyRecord());
    const failures = [];
    const exhaustedLogs = [];
    global.log = (message) => exhaustedLogs.push(message);
    allBad.fetchYear("ita", "global", 2027, (...args) => failures.push(args));
    assert.equal(failures[0][0], null);
    assert.equal(failures[0][1].provider, "bad");
    assert.equal(exhaustedLogs.at(-1), "all holiday providers failed for ita/global/2027");
});

// The point of the record contract: HolidayService is the flakiest of the three
// providers, and dropping it used to break the other two — they were validated
// and expanded by *its* validator. A chain of the two ISO providers, with no
// HolidayService anywhere in it, has to work.
test("the chain works with no HolidayService in it at all", () => {
    const {
        createHolidayServiceChain, HolidayRecordContract,
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

    const chain = createHolidayServiceChain(
        openHolidays, [nager], new HolidayRecordContract("en"));

    const answers = [];
    chain.fetchYear("fra", "global", 2026, (data, params) => answers.push([data, params]));

    const contract = new HolidayRecordContract("en");
    const [data, params] = answers[0];
    assert.equal(params.providerName, "OpenHolidays");
    assert.equal(contract.validResponse(data), true,
        "the ISO provider's answer is a record, and the record contract says so");
    assert.deepEqual(contract.expandHoliday(data[0], "global"), [{
        year: 2026, month: 7, day: 14, name: "Bastille Day",
        flags: ["public_holiday"], region: "global"
    }]);
});

// HolidayService built a real HolidayCacheRepository in its constructor whether or not a
// cache was injected — resolving a path, creating a directory — for an object
// that could never be used.
test("a provider given a cache does not build a repository it cannot use", () => {
    const { HolidayService } = loadHolidays();
    const cache = {
        country: "ita", region: "global", years: {}, data: [],
        setPlace() {}, setData() {}, clearPlace() {}, recordAttempt() {},
        recordFetch() {}, prune() {}, persist() {}, stale: () => false,
        matchMonth: () => new Map()
    };

    const enrico = new HolidayService({ fetchYear() {} }, cache);

    assert.equal(enrico.cache, cache);
    assert.equal(enrico.cacheRepository, undefined,
        "no repository is built when nothing will back the cache with it");

    // ...and it is built, and used, when it is the thing backing the cache
    const loads = [];
    const repository = {
        loadAsync: (country, done) => { loads.push(country); done({ years: {}, holidays: [] }); },
        save: () => {}
    };
    const backed = new HolidayService({ fetchYear() {} }, null, { cacheRepository: repository });
    backed.cache.setPlace("fra", "global", () => {});
    assert.deepEqual(loads, ["fra"]);
});

test("the status ledger keeps one record per year and region, and prunes", () => {
    const { HolidayStatusLedger } = loadHolidays();
    const ledger = new HolidayStatusLedger();

    assert.deepEqual(ledger.for("2026/global"), { error: "", provider: "" });

    ledger.lastError = "Holiday data unavailable";
    ledger.lastProvider = "Enrico";
    ledger.record("2026/global");
    assert.deepEqual(ledger.for("2026/global"),
        { error: "Holiday data unavailable", provider: "Enrico" });

    ledger.lastError = "";
    ledger.record("2019/global");
    ledger.prune([2026]);
    assert.deepEqual(ledger.for("2019/global"), { error: "", provider: "" },
        "a year the cache no longer stamps is not worth a status record");
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

// The generation guard in settle() was never executed by any test: replacing the
// whole condition with `if (false)` survived mutation, which is proof no test ever
// reached it — it would have thrown on entry.callbacks.
//
// It is the stale-response defence. Change country mid-fetch and the old (BR)
// response lands after setPlace() has emptied the map and the new (FR) request has
// refilled it under the same year/region key. Without the tag the old response
// deletes the *new* request's entry: the FR response then finds no callbacks and
// nothing repaints, while fetching() answers false for a request that is still
// live, which fires a duplicate. The month stays on the old country's holidays
// until the user scrolls away and back.
test("a response for a place the user has left settles nothing", () => {
    const { HolidayInflight } = loadHolidays();
    const inflight = new HolidayInflight();
    const answered = [];

    // Brazil's fetch starts, in generation 1
    assert.equal(inflight.start("2026/global", () => answered.push("brazil"), 1), true);

    // the user picks France: the map is emptied and refilled under the same key,
    // in generation 2
    inflight.clear();
    assert.equal(inflight.start("2026/global", () => answered.push("france"), 2), true);

    // now Brazil's response lands
    assert.deepEqual(inflight.settle("2026/global", 1), [],
        "it takes no callbacks that are not its own");
    assert.equal(inflight.has("2026/global"), true,
        "and it removes nothing: France's fetch is still in flight");

    // ...and France's own response still finds its caller
    const callbacks = inflight.settle("2026/global", 2);
    callbacks.forEach((callback) => callback());
    assert.deepEqual(answered, ["france"]);
    assert.equal(inflight.has("2026/global"), false);

    // a response for a key nobody is waiting on is not an error either
    assert.deepEqual(inflight.settle("2030/global", 2), []);
});

// ...and with nothing replaced at all, the root builds the real thing: one HTTP
// session, built on first fetch, shared by all adapters and aborted on
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
    const chain = provider._provider.service;

    const answers = [];
    provider.setPlace("fra", "global", () => answers.push("updated"));

    assert.ok(requested[0].startsWith("https://kayaposoft.com/enrico/"),
        "Enrico is still the primary");
    assert.deepEqual(chain.fallbacks.map((fallback) => fallback.name),
        ["OpenHolidays", "Nager.Date"]);
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
        date: { year: FIXED_YEAR, month: 9, day: 7 },
        name: [{ lang: "en", text: "Independência do Brasil" }],
        flags: []
    }], brazil.params, STAMP);

    assert.deepEqual(repaints, [], "the abandoned country repaints nothing");
    assert.equal(enrico.fetching(FIXED_YEAR), true,
        "and France's request is still live, so nothing refetches it");

    // ...and France's answer still reaches the calendar
    france.callback([{
        date: { year: FIXED_YEAR, month: 7, day: 14 },
        name: [{ lang: "en", text: "Bastille Day" }],
        flags: []
    }], france.params, STAMP);

    assert.deepEqual(repaints, ["fra"], "the country the user is actually on repaints");
    assert.equal(enrico.country, "fra");

    const months = [];
    provider.getHolidays(FIXED_YEAR, 7, (dates) => months.push(dates));
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
    assert.equal(MAX_HOLIDAYS_PER_YEAR, 1000,
        "the network row cap is a product limit, not its own oracle");
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
    const { HolidayService, MAX_EXPANDED_HOLIDAY_ROWS } = loadHolidays();
    const logged = [];
    global.logError = (message) => logged.push(String(message));

    const enrico = new HolidayService({ fetchYear() {} }, makeMemoryCache(), {
        record: anyRecord({
            // a hundred holidays, each spanning a year: a valid payload, and
            // 36,600 rows on the compositor thread
            expandHoliday: () => Array.from({ length: 366 }, (_u, day) => ({
                year: 2026, month: 1, day: (day % 28) + 1, name: "H", flags: [], region: "global"
            }))
        })
    });

    const expanded = enrico.expandData(Array.from({ length: 100 }, () => ({})), "global");

    assert.equal(expanded.length, MAX_EXPANDED_HOLIDAY_ROWS,
        "the expansion stops at the cap instead of building 36,600 rows");
    assert.ok(logged.some((line) => /expands past/.test(line)), "and it says so");
});
