/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
// Under GJS this file is reached through the native importer, which provides
// neither require() nor module; Node (tests) provides both.
const Utils = typeof require === "function" ?
    require("./utils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].utils;
const HolidayConstants = typeof require === "function" ?
    require("./holidayConstants") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayConstants;
const HolidayCacheModule = typeof require === "function" ?
    require("./holidayCache") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayCache;
const HolidayServiceAdapters = typeof require === "function" ?
    require("./holidayServiceAdapters") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayServiceAdapters;

const _lcLang = Utils.lazyLocaleValue("LC_ADDRESS", (info) => info.lang_ab);

var HTTP_TIMEOUT_SECONDS = Utils.HTTP_TIMEOUT_SECONDS;

function _newHttpSession() {
    return Utils.createHttpSession({
        timeout: HTTP_TIMEOUT_SECONDS,
        idleTimeout: HTTP_TIMEOUT_SECONDS
    });
}

function logHolidayDataError(provider, year, reason) {
    if (global.logError) {
        global.logError(`holiday provider ${provider || "unknown"} returned invalid data for ${year || "unknown year"}: ${reason}`);
    }
}

const GLOBAL_REGION = HolidayConstants.GLOBAL_REGION;
var HOLIDAY_ERRORS = HolidayConstants.HOLIDAY_ERRORS;

var Provider = class Provider {
    // the session is per provider instance, not per module: a second applet
    // instance on the panel must not have its requests aborted when the first
    // one is removed
    static loaderFor(getSession) {
        return (url, params, callback) => {
            Utils.httpGetJson(getSession(), url, (data, message) => {
                const headers = message.get_response_headers();
                const retrieved = headers ? headers.get_one("date") : null;

                callback(data, params, retrieved);
            });
        };
    }
};

var HolidayCacheRepository = HolidayCacheModule.HolidayCacheRepository;
var HolidayCache = HolidayCacheModule.HolidayCache;

var EnricoServiceAdapter = HolidayServiceAdapters.EnricoServiceAdapter;
var NagerDateServiceAdapter = HolidayServiceAdapters.NagerDateServiceAdapter;
var OpenHolidaysServiceAdapter = HolidayServiceAdapters.OpenHolidaysServiceAdapter;
var HolidayServiceFallbackAdapter = HolidayServiceAdapters.HolidayServiceFallbackAdapter;
// the record shape the app owns: what an answer from *any* provider must be
var HolidayRecordContract = HolidayServiceAdapters.HolidayRecordContract;
var MAX_HOLIDAYS_PER_YEAR = HolidayServiceAdapters.MAX_HOLIDAYS_PER_YEAR;
var MAX_EXPANDED_HOLIDAY_ROWS = HolidayServiceAdapters.MAX_EXPANDED_HOLIDAY_ROWS;

// One HTTP session per provider, built on first fetch: holidays may never be
// shown, and a session at construction costs applet startup. The session is per
// provider *instance*, not per module — a second applet on the panel must not
// have its requests aborted when the first one is removed.
//
// HolidayService used to own this lifecycle itself, along with eight other things.
var HolidaySession = class HolidaySession {
    constructor(create = _newHttpSession) {
        this._create = create;
        this._session = null;
    }

    get() {
        if (!this._session) {
            this._session = this._create();
        }

        return this._session;
    }

    // pending requests keep their response buffers and callbacks alive for up to
    // the timeout after the applet is gone
    abort() {
        if (this._session && this._session.abort) {
            this._session.abort();
        }
    }
};

// the adapters are loader-agnostic; this is the single place that hands
// them an HTTP session, keeping the provider order intact
function httpBackedService(getSession, params = {}) {
    const lang = params.lang || _lcLang();
    const record = params.record || new HolidayRecordContract(lang);
    const load = params.load || Provider.loaderFor(getSession);

    return new HolidayServiceFallbackAdapter(
        new EnricoServiceAdapter(load),
        [
            new OpenHolidaysServiceAdapter(load, lang),
            new NagerDateServiceAdapter(load)
        ],
        record
    );
}

// The outcome of the last fetch for a year+region: what the month label shows.
//
// HolidayService kept this as a bare object and pruned it by hand, alongside the HTTP
// session, the provider chain, the cache repository, the cache, the inflight
// map, the place-generation counter, the staleness policy and the validation
// policy. It is a small thing with a rule of its own — the key carries no
// country, so it must be cleared whenever the place changes — and that rule is
// easier to see, and to test, on its own.
var HolidayStatusLedger = class HolidayStatusLedger {
    constructor(yearWindow = HolidayCacheModule.YEAR_WINDOW) {
        this._status = {};
        this._year_window = yearWindow;
        this.lastError = "";
        this.lastProvider = "";
    }

    for(key) {
        return this._status[key] || { error: "", provider: "" };
    }

    record(key) {
        this._status[key] = {
            error: this.lastError,
            provider: this.lastProvider
        };
    }

    // the inflight entry deletes itself when the fetch lands; the status beside
    // it stays, one entry per year+region ever browsed. The cache keeps only the
    // years the grid can reach, so the status follows it.
    prune(now = new Date()) {
        const current = now.getFullYear();

        Object.keys(this._status).forEach((key) => {
            const year = Number(key.split("/")[0]);
            if (Math.abs(year - current) > this._year_window) {
                delete this._status[key];
            }
        });
    }

    clear() {
        this._status = {};
        this.lastError = "";
        this.lastProvider = "";
    }
};

// The fetches in flight, and who is waiting for each. The 42-day grid always
// spans two months, so the second one asks for a year whose fetch is already
// running: it joins that one rather than issuing a second request.
var HolidayInflight = class HolidayInflight {
    constructor() {
        this._waiting = {};
    }

    has(key) {
        return Boolean(this._waiting[key]);
    }

    // Every entry is tagged with the place generation that started it, and only
    // that generation can settle it.
    //
    // Without the tag: change country mid-fetch, and the old (BR) response lands
    // after setPlace() has already emptied this map and the new (FR) request has
    // refilled it under the same `${year}/${region}` key. The old response then
    // deleted the *new* request's entry — so the FR response found no callbacks
    // and nothing repainted, and `fetching()` answered false while a request was
    // still live, which fired a duplicate. The month stayed on the old country's
    // holidays until the user scrolled a month or reopened the menu.
    //
    // returns true when this call started the fetch, false when it joined one
    start(key, callback, generation = 0) {
        const entry = this._waiting[key];
        if (entry) {
            if (callback) {
                entry.callbacks.push(callback);
            }
            return false;
        }

        this._waiting[key] = {
            generation,
            callbacks: callback ? [callback] : []
        };
        return true;
    }

    // a response for a generation that is no longer current owns nothing here:
    // it takes no callbacks and, crucially, removes nothing
    settle(key, generation = 0) {
        const entry = this._waiting[key];
        if (!entry || entry.generation !== generation) {
            return [];
        }

        delete this._waiting[key];
        return entry.callbacks;
    }

    clear() {
        this._waiting = {};
    }
};

var HolidayService = class HolidayService {
    constructor (service, cache, params = {}) {
        this._session = params.httpSession || new HolidaySession();
        this.service = service || httpBackedService(() => this._getHttpSession());
        // What a payload has to look like, and what a holiday expands to, is one
        // rule for all three providers — so it is held here, not asked of the
        // chain. The chain used to forward validResponse/expandHoliday to a
        // record it privately owned, which made "what an adapter must implement"
        // a different answer for every adapter in the tree.
        this.record = params.record || new HolidayRecordContract(_lcLang());
        // destroy() aborts the session; without this the abort reads as a
        // provider failure and the chain issues its next request on it
        if (this.service.setLivenessCheck) {
            this.service.setLivenessCheck(() => !this._destroyed);
        }
        // A repository was built here unconditionally — a real one, resolving a
        // real path — even when a cache was injected and it could never be used.
        // It is built only when it is the thing that backs the cache.
        this.cache = cache || this._fileBackedCache(params.cacheRepository);
        this._inflight = params.inflight || new HolidayInflight();
        // per year+region: two months of the same grid can be fetched
        // concurrently, and a shared status field would report the loser's
        // outcome against the winner's month
        this._status = params.status || new HolidayStatusLedger();
        this._destroyed = false;
        // A fetch is dispatched for one country and region and lands seconds
        // later, by which time the user may have picked another: the cache it
        // would write through is no longer the cache that asked. The counter
        // moves on every place change, and a response whose generation is
        // behind it is dropped.
        this._place_generation = 0;
    }

    _fileBackedCache(repository) {
        this.cacheRepository = repository || new HolidayCacheRepository(HolidayService.fn);

        return new HolidayCache(
            (country, done) => this.cacheRepository.loadAsync(country, done),
            // persist() passes the cache's own country, so writing it back
            // through the setter would be a no-op
            (country, data) => this.cacheRepository.save(country, data)
        );
    }

    // the status ledger owns these; the outside reads them as fields
    get last_error() {
        return this._status.lastError;
    }

    set last_error(value) {
        this._status.lastError = value;
    }

    get last_provider() {
        return this._status.lastProvider;
    }

    set last_provider(value) {
        this._status.lastProvider = value;
    }

    _isCurrentPlace(generation) {
        return !this._destroyed && generation === this._place_generation;
    }

    _getHttpSession() {
        return this._session.get();
    }

    destroy() {
        this._destroyed = true;
        this._inflight.clear();
        this._session.abort();
    }

    _statusFor(year) {
        return this._status.for(this._inflightKey(year));
    }

    get country() {
        return this.cache.country;
    }

    set country(value) {
        this.cache.country = value;
    }

    get region() {
        return this.cache.region;
    }

    set region(value) {
        this.cache.region = value;
    }

    // validResponse bounds how many holidays a payload may carry; this bounds
    // what they expand to, which is what actually reaches the grid and the cache
    // file. Both are needed: a hundred holidays each spanning a year is a valid
    // payload and 36,600 rows.
    expandData(data, region = this.region) {
        const expanded = [];
        for (const holiday of data) {
            for (const single of this.record.expandHoliday(holiday, region)) {
                if (expanded.length >= MAX_EXPANDED_HOLIDAY_ROWS) {
                    if (global.logError) {
                        global.logError("holiday payload expands past " +
                            MAX_EXPANDED_HOLIDAY_ROWS + " rows; keeping the first " +
                            MAX_EXPANDED_HOLIDAY_ROWS);
                    }
                    return expanded;
                }
                expanded.push(single);
            }
        }

        return expanded;
    }

    addData (data, params, retrieved) {
        this.last_provider = params && params.providerName ? params.providerName : "";

        if (!data) {
            this.last_error = HOLIDAY_ERRORS.SERVICE_UNAVAILABLE;
            return;
        }

        if (data.error) {
            // The provider's own error string, straight out of the JSON body.
            // It reaches the month-label tooltip, the label's accessible name
            // and global.logError, and it was the one remote string that skipped
            // the clamp every other one goes through: a hostile or broken
            // endpoint could make it the whole 4 MiB response, which Pango then
            // lays out on the compositor thread, or slip newlines into it and
            // forge lines in the Cinnamon log.
            this.last_error = HolidayCacheModule.clampHolidayName(
                typeof data.error === "string" ? data.error.replace(/[\r\n]+/g, " ") : "");
            if (!this.last_error) {
                this.last_error = HOLIDAY_ERRORS.INVALID_RESPONSE;
            }
            logHolidayDataError(this.last_provider, params && params.year, this.last_error);
            return;
        }

        if (!this.record.validResponse(data)) {
            this.last_error = HOLIDAY_ERRORS.INVALID_RESPONSE;
            logHolidayDataError(this.last_provider, params && params.year, this.last_error);
            return;
        }

        this.last_error = "";
        const regionId = params.region || GLOBAL_REGION;
        this.cache.recordFetch(params.year, regionId, retrieved, this.expandData(data, regionId));
        // a fetch that landed is written; persist() writes only the reachable
        // window but keeps the whole of the session's data in memory, so a year
        // the user browsed to still renders and is not refetched every update.
        // The cache used to do this from inside recordFetch, i.e. a disk write
        // from inside a data structure.
        this.cache.persist();
    }

    _inflightKey(year) {
        return `${year}/${this.region}`;
    }

    fetching (year) {
        return this._inflight.has(this._inflightKey(year));
    }

    retrieveForYear (year, callback) {
        if (this._destroyed) {
            return;
        }

        if (!this.country) {
            // this runs inside the async calendar-update path where a throw
            // has no local handler; report the error state instead
            this.last_error = HOLIDAY_ERRORS.SERVICE_UNAVAILABLE;
            this.last_provider = "";
            this._status.record(this._inflightKey(year));
            if (global.logError) {
                global.logError("holiday provider has no country configured");
            }
            if (callback) {
                callback();
            }
            return;
        }

        const inflightKey = this._inflightKey(year);
        const generation = this._place_generation;
        // the second month of the grid asks for a year already being fetched:
        // it joins that request rather than issuing another
        if (!this._inflight.start(inflightKey, callback, generation)) {
            return;
        }

        const region = this.region;
        this.service.fetchYear(this.country, region, year, (data, params, date) => {
            // The fetch may finish after the applet was removed from the panel
            // — running callbacks then would touch destroyed actors — or after
            // the user picked another country, in which case this.cache now
            // holds that country's data and writing to it would file France's
            // holidays under Japan, mark Japan's year fresh for the update
            // period, and persist the lot.
            // The place changed while this was in flight. setPlace() has already
            // emptied the inflight map, and the new place's request may already
            // have refilled it under this very key — so touching it here is how
            // the old response used to delete the *new* request's callbacks.
            // This response owns nothing any more. Leave it all alone.
            if (!this._isCurrentPlace(generation)) {
                return;
            }

            // recorded on completion, not on dispatch: an attempt recorded up
            // front makes the year look fresh to every other month in the
            // grid, which then renders no holidays at all
            this.cache.recordAttempt(year, region);

            let callbacks = [];
            try {
                this.addData(data, params, date);
            } catch (e) {
                // a payload that survives validation can still throw while
                // being expanded or persisted; leaving the key behind would
                // block every later fetch of this year for the whole session
                this.last_error = HOLIDAY_ERRORS.INVALID_RESPONSE;
                if (global.logError) {
                    global.logError(e);
                }
            } finally {
                this._status.record(inflightKey);
                callbacks = this._inflight.settle(inflightKey, generation);
                this._status.prune();
            }

            for (let waiting of callbacks) {
                waiting();
            }
        });
    }

    staleCache (year, now = Date.now()) {
        return this.cache.stale(year, this.region, now);
    }

    clearPlace () {
        this.cache.clearPlace();
        this._place_generation++;
        this._inflight.clear();
        this._status.clear();
    }

    setPlace (country, region = GLOBAL_REGION, onUpdated) {
        // a fetch still in flight was dispatched for the place we are leaving
        this._place_generation++;
        this._inflight.clear();
        // ...and so was every status record. The key is `${year}/${region}`,
        // with no country in it, so France failing to fetch 2026/global left an
        // error that Germany — also "global" — read back as its own: the month
        // label said "⚠ Holiday service unavailable" beside correctly-rendered
        // German holidays, because the German data was cached and fresh and
        // getHolidays never took the fetch branch that would have overwritten
        // the status. A stale *success* masking a real error is the same bug
        // pointing the other way. clearPlace() has always reset this; setPlace
        // never did.
        this._status.clear();
        const generation = this._place_generation;

        // the cached data is read asynchronously, so staleness cannot be
        // judged until it is in place: an empty cache looks stale and would
        // refetch a year that is already on disk
        this.cache.setPlace(country, region || GLOBAL_REGION, () => {
            if (!this._isCurrentPlace(generation)) {
                return;
            }

            const year = new Date().getFullYear();
            // a never-fetched region is already stale (data and attempts are
            // per-region), so this also honors RETRY_PERIOD after a failure
            if (this.staleCache(year)) {
                // the response lands long after the place change; without the
                // callback nothing would repaint the calendar with the new data
                this.retrieveForYear(year, onUpdated);
            } else if (onUpdated) {
                // the cache answered: repaint with what it holds
                onUpdated();
            }
        });
    }

    matchMonth (year, month) {
        return this.cache.matchMonth(year, month, this.region);
    }

    getHolidays (year, month, callback) {
        // the 42-day grid always spans two months, so the second one asks for
        // a year whose fetch is already running: join it instead of answering
        // from the still-empty cache
        const respond = () => {
            const status = this._statusFor(year);
            callback(this.matchMonth(year, month), status.error, status.provider);
        };

        if (this.fetching(year) || this.staleCache(year)) {
            this.retrieveForYear(year, respond);
        } else {
            respond();
        }
    }
};
// the on-disk cache. Renamed off the primary provider's name; the repository
// migrates a pre-rename enrico.json in on first load so no user loses their cache
HolidayService.fn = "/holidays.json";

// The composition root for the holiday half: the graph, written out once.
//
// It used to assemble itself through default arguments across three files — new
// HolidayProviderFacade() reached for new HolidayService(), which reached for
// httpBackedService(), which built the three adapters and the chain, and then
// the repository and the cache. Nothing could substitute anything, and the
// wiring lived in four constructors' parameter lists.
//
// Every node is a parameter with a default, so a caller replaces exactly the one
// it cares about and the rest of the graph is still the shipped one.
function createHolidayProvider(params = {}) {
    const lang = params.lang || _lcLang();
    const record = params.record || new HolidayRecordContract(lang);
    const session = params.httpSession || new HolidaySession();

    const service = params.service ||
        httpBackedService(() => session.get(), { lang, record, load: params.load });

    const provider = params.provider || new HolidayService(service, params.cache, {
        httpSession: session,
        record,
        cacheRepository: params.cacheRepository,
        status: params.status,
        inflight: params.inflight
    });

    return new HolidayProviderFacade(provider);
}

var HolidayProviderFacade = class HolidayProviderFacade {
    constructor(provider = new HolidayService()) {
        this._provider = provider;
    }

    get country() {
        return this._provider.country;
    }

    destroy() {
        this._provider.destroy();
    }

    clearPlace() {
        this._provider.clearPlace();
    }

    setPlace(country, region = GLOBAL_REGION, onUpdated) {
        this._provider.setPlace(country, region, onUpdated);
    }

    getHolidays(year, month, callback) {
        this._provider.getHolidays(year, month, callback);
    }
};

if (typeof module !== "undefined") {
    module.exports = {
        HTTP_TIMEOUT_SECONDS, Provider, HolidayCacheRepository, HolidayCache, EnricoServiceAdapter, NagerDateServiceAdapter, OpenHolidaysServiceAdapter, HolidayServiceFallbackAdapter, HolidayRecordContract, HolidayStatusLedger, HolidayInflight, HolidaySession, MAX_HOLIDAYS_PER_YEAR, MAX_EXPANDED_HOLIDAY_ROWS, httpBackedService, createHolidayProvider, HolidayService, HolidayProviderFacade, HOLIDAY_ERRORS };
}
