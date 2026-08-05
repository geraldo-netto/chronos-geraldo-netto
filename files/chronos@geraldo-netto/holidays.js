// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
// Which host is loading this file — and it is asked of the *host*, not of
// require(). It used to test `typeof require === "function"`, on the stated
// assumption that "Cinnamon provides neither require() nor module". That was true
// of 5.4 through 6.4 and is not true of Cinnamon master, which sets
// globalThis.require = xletRequire (js/ui/extension.js). There the test would
// invert: the root modules would take the require() branch, _requireLocal would
// resolve "./localeUtils" against extension.meta.path — which
// findExtensionSubdirectory has already repointed at the 5.4/ directory — and the
// applet would fail to load, because localeUtils.js is not in there.
//
// Node is what this asks about, because Node is the only host that requires these
// files directly. Cinnamon's cjs has no `process`.
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
// Under GJS this file is reached through the native importer, which provides
// neither require() nor module; Node (tests) provides both.
const IoUtils = IS_NODE ?
    require("./ioUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].ioUtils;
const LocaleQuery = IS_NODE ?
    require("./localeQuery") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].localeQuery;
const LocaleText = IS_NODE ?
    require("./localeText") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].localeText;
const HolidayConstants = IS_NODE ?
    require("./holidayConstants") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayConstants;
const HolidayCacheModule = IS_NODE ?
    require("./holidayCache") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayCache;
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;
const HolidayServiceAdapters = IS_NODE ?
    require("./holidayServiceAdapters") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayServiceAdapters;
const HolidayRecord = IS_NODE ?
    require("./holidayRecord") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayRecord;
const ReligiousHolidays = IS_NODE ?
    require("./religiousHolidays") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].religiousHolidays;

const _lcLang = LocaleQuery.messageLanguage;

var HTTP_TIMEOUT_SECONDS = IoUtils.HTTP_TIMEOUT_SECONDS; // NOSONAR [S3504] -- GJS importer export

function logHolidayDataError(provider, year, reason) {
    if (global.logError) {
        global.logError(`holiday provider ${provider || "unknown"} returned invalid data for ${year || "unknown year"}: ${reason}`);
    }
}

// same discipline as religiousHolidays' month/year guard: numbers and numeric
// strings coerce, everything else reads as not-a-year
function _numericInput(value) {
    return typeof value === "number" || typeof value === "string" ?
        Number(value) : NaN;
}

const GLOBAL_REGION = HolidayConstants.GLOBAL_REGION;
var HOLIDAY_ERRORS = HolidayConstants.HOLIDAY_ERRORS; // NOSONAR [S3504] -- GJS importer export

var Provider = class Provider { // NOSONAR [S3504] -- GJS importer export
    // the session is per provider instance, not per module: a second applet
    // instance on the panel must not have its requests aborted when the first
    // one is removed
    static loaderFor(getSession) {
        return (url, params, callback) => {
            IoUtils.httpGetJson(getSession(), url, (data, message) => {
                // a request Soup refused to construct arrives with no message;
                // it must settle through the same path as a failed fetch
                const headers = message ? message.get_response_headers() : null;
                const retrieved = headers ? headers.get_one("date") : null;

                callback(data, params, retrieved);
            });
        };
    }
};

var HolidayCacheRepository = HolidayCacheModule.HolidayCacheRepository; // NOSONAR [S3504] -- GJS importer export
var HolidayCache = HolidayCacheModule.HolidayCache; // NOSONAR [S3504] -- GJS importer export

var EnricoServiceAdapter = HolidayServiceAdapters.EnricoServiceAdapter; // NOSONAR [S3504] -- GJS importer export
var NagerDateServiceAdapter = HolidayServiceAdapters.NagerDateServiceAdapter; // NOSONAR [S3504] -- GJS importer export
var OpenHolidaysServiceAdapter = HolidayServiceAdapters.OpenHolidaysServiceAdapter; // NOSONAR [S3504] -- GJS importer export
var createHolidayServiceChain = HolidayServiceAdapters.createHolidayServiceChain; // NOSONAR [S3504] -- GJS importer export
// the record shape the app owns: what an answer from *any* provider must be
var HolidayRecordContract = HolidayRecord.HolidayRecordContract; // NOSONAR [S3504] -- GJS importer export
var MAX_HOLIDAYS_PER_YEAR = HolidayRecord.MAX_HOLIDAYS_PER_YEAR; // NOSONAR [S3504] -- GJS importer export
var MAX_EXPANDED_HOLIDAY_ROWS = HolidayRecord.MAX_EXPANDED_HOLIDAY_ROWS; // NOSONAR [S3504] -- GJS importer export

// the adapters are loader-agnostic; this is the single place that hands
// them an HTTP session, keeping the provider order intact
function httpBackedService(getSession, params = {}) {
    // No explicit language means the session's message language. Hand the
    // resolver down whole so requests and displayed names share one source.
    const lang = params.lang || _lcLang;
    const record = params.record || new HolidayRecordContract(lang);
    const load = params.load || Provider.loaderFor(getSession);

    return createHolidayServiceChain(
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
var HolidayStatusLedger = class HolidayStatusLedger { // NOSONAR [S3504] -- GJS importer export
    constructor() {
        this._status = {};
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

    // The inflight entry deletes itself when the fetch lands; the status beside
    // it stays, one entry per year+region ever browsed. The cache evicts years
    // LRU-style, so the status follows the years the cache still stamps: pruning
    // by calendar distance instead deleted the record the moment it was written
    // for any year past the persist window, while the attempt stamp it belonged
    // to lived on and suppressed the refetch — a failure two years out rendered
    // a bare month with no warning at all.
    prune(liveYears) {
        const keep = new Set(liveYears.map(Number));

        Object.keys(this._status).forEach((key) => {
            if (!keep.has(Number(key.split("/")[0]))) {
                delete this._status[key];
            }
        });
    }

    clear() { // NOSONAR [S4144] -- distinct provider contract
        this._status = {};
        this.lastError = "";
        this.lastProvider = "";
    }
};

// The fetches in flight, and who is waiting for each. The 42-day grid always
// spans two months, so the second one asks for a year whose fetch is already
// running: it joins that one rather than issuing a second request.
var HolidayInflight = class HolidayInflight { // NOSONAR [S3504] -- GJS importer export
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
        if (!entry || entry.generation !== generation) { // NOSONAR [S6582] -- accepted compatible form
            return [];
        }

        delete this._waiting[key];
        return entry.callbacks;
    }

    clear() {
        this._waiting = {};
    }
};

var HolidayService = class HolidayService { // NOSONAR [S3504] -- GJS importer export
    constructor (service, cache, params = {}) {
        this._session = params.httpSession || new IoUtils.LazyHttpSession();
        this.service = service || httpBackedService(() => this._getHttpSession());
        // What a payload has to look like, and what a holiday expands to, is one
        // rule for all providers — so it is held here, not asked of the
        // chain. The chain used to forward validResponse/expandHoliday to a
        // record it privately owned, which made "what an adapter must implement"
        // a different answer for every adapter in the tree.
        this.record = params.record || new HolidayRecordContract(_lcLang);
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
        this._status.clear();
        if (this.cache && this.cache.release) { // NOSONAR [S6582] -- accepted compatible form
            this.cache.release();
        }
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
        this.last_provider = params && params.providerName ? params.providerName : ""; // NOSONAR [S6582] -- accepted compatible form

        if (!data) {
            this.last_error = HOLIDAY_ERRORS.SERVICE_UNAVAILABLE;
            return;
        }

        if (data.error) {
            // The provider's own error string is a diagnostic, not UI text. It
            // used to *become* the UI text: translateHolidayError is a lookup with
            // a passthrough fallback, so an untranslated English sentence from a
            // vendor was pinned under the month name in an otherwise French
            // interface, in the label, its accessible name and the tooltip — and a
            // broken or hostile endpoint chose that sentence.
            //
            // What the user is told is that the data did not arrive, in their own
            // language. What the maintainer is told is what the provider said,
            // clamped and stripped of controls: it is the one remote string that
            // skipped the clamp every other one goes through, so a 4 MiB response
            // could be laid out by Pango on the compositor thread, or forge lines
            // in the Cinnamon log.
            this._rejectHolidayData(params, this._remoteErrorText(data.error));
            return;
        }

        if (!this._validFetchedData(data, params)) {
            this._rejectHolidayData(params, HOLIDAY_ERRORS.INVALID_RESPONSE);
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

    _remoteErrorText(error) {
        const bounded = HolidayCacheModule.clampHolidayName(error);
        return TextUtils.sanitizeControlCharacters(bounded) ||
            HOLIDAY_ERRORS.INVALID_RESPONSE;
    }

    _validFetchedData(data, params) {
        return Boolean(params) &&
            Number.isInteger(params.year) &&
            this.record.validResponse(data, params.year);
    }

    _rejectHolidayData(params, reported) {
        this.last_error = HOLIDAY_ERRORS.INVALID_RESPONSE;
        logHolidayDataError(
            this.last_provider,
            params && params.year, // NOSONAR [S6582] -- accepted compatible form
            reported);
    }

    _inflightKey(year) {
        return `${year}/${this.region}`;
    }

    fetching (year) {
        return this._inflight.has(this._inflightKey(year));
    }

    // Holidays are on but no country is set — nothing to ask, and this runs
    // inside the async calendar-update path where a throw has no local handler,
    // so it reports the error state instead.
    _reportNoCountry(year, callback) {
        this.last_error = HOLIDAY_ERRORS.SERVICE_UNAVAILABLE;
        this.last_provider = "";
        this._status.record(this._inflightKey(year));
        if (global.logError) {
            global.logError("holiday provider has no country configured");
        }
        if (callback) {
            callback();
        }
    }

    // Everything the answer touches, once it is known to belong to the place that
    // is still selected. The attempt is recorded on completion, not on dispatch:
    // an attempt recorded up front makes the year look fresh to every other month
    // in the grid, which then renders no holidays at all.
    _acceptYear(year, region, inflightKey, generation, data, params, date) {
        this.cache.recordAttempt(year, region);

        let callbacks;
        try {
            this.addData(data, params, date);
        } catch (e) {
            // a payload that survives validation can still throw while being
            // expanded or persisted; leaving the key behind would block every
            // later fetch of this year for the whole session
            this.last_error = HOLIDAY_ERRORS.INVALID_RESPONSE;
            if (global.logError) {
                global.logError(e);
            }
        } finally {
            this._status.record(inflightKey);
            callbacks = this._inflight.settle(inflightKey, generation);
            this._status.prune(this.cache.cachedYears());
        }

        for (let waiting of callbacks) {
            waiting();
        }
    }

    retrieveForYear (year, callback) {
        if (this._destroyed) {
            return;
        }

        if (!this.country) {
            this._reportNoCountry(year, callback);
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
            // The fetch may finish after the applet was removed from the panel —
            // running callbacks then would touch destroyed actors — or after the
            // user picked another country, in which case this.cache now holds that
            // country's data and writing to it would file France's holidays under
            // Japan, mark Japan's year fresh for the update period, and persist the
            // lot. setPlace() has already emptied the inflight map, and the new
            // place's request may already have refilled it under this very key — so
            // touching it here is how the old response used to delete the *new*
            // request's callbacks. This response owns nothing any more.
            if (!this._isCurrentPlace(generation)) {
                return;
            }

            this._acceptYear(year, region, inflightKey, generation, data, params, date);
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

    setPlace (country, region = GLOBAL_REGION, onUpdated) { // NOSONAR [S1788] -- accepted compatible form
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
        if (this._destroyed) {
            return;
        }
        // The annotator splits its "YYYY/M" month keys, so both arrive as
        // strings; the staleness gate and the record contract compare numbers,
        // and a string year used to read every provider's valid payload as
        // invalid data. Coerce once here and everything below sees integers.
        const numericYear = _numericInput(year);
        const numericMonth = _numericInput(month);
        if (!Number.isInteger(numericYear) || !Number.isInteger(numericMonth)) {
            callback(new Map(), HOLIDAY_ERRORS.INVALID_RESPONSE, "");
            return;
        }

        // the 42-day grid always spans two months, so the second one asks for
        // a year whose fetch is already running: join it instead of answering
        // from the still-empty cache
        const respond = () => {
            const status = this._statusFor(numericYear);
            callback(this.matchMonth(numericYear, numericMonth), status.error, status.provider);
        };

        // Cinnamon runs the first grid update in the same call stack as applet
        // construction, while setPlace's disk read is still in flight: judged
        // at that instant every year looks stale, and a real HTTP fetch went
        // out for data already fresh on disk — bypassing the 50-day and 1-hour
        // throttles the cache exists to enforce. Staleness is judged once the
        // cache has answered; with no load pending this path is synchronous.
        this.cache.whenReady(() => {
            if (this._destroyed) {
                return;
            }
            if (this.fetching(numericYear) || this.staleCache(numericYear)) {
                this.retrieveForYear(numericYear, respond);
            } else {
                respond();
            }
        });
    }
};
// the on-disk cache. Renamed off the primary provider's name; the repository
// migrates a pre-rename enrico.json in on first load so no user loses their cache
HolidayService.fn = "/holidays.json";

// The composition root for the holiday half: the graph, written out once.
//
// It used to assemble itself through default arguments across three files — new
// HolidayProviderFacade() reached for new HolidayService(), which reached for
// httpBackedService(), which built the adapters and the chain, and then
// the repository and the cache. Nothing could substitute anything, and the
// wiring lived in four constructors' parameter lists.
//
// Every node is a parameter with a default, so a caller replaces exactly the one
// it cares about and the rest of the graph is still the shipped one.
function createHolidayProvider(params = {}) {
    // Like httpBackedService, an unspecified language stays a live resolver.
    const lang = params.lang || _lcLang;
    const record = params.record || new HolidayRecordContract(lang);
    const session = params.httpSession || new IoUtils.LazyHttpSession();

    const service = params.service ||
        httpBackedService(() => session.get(), { lang, record, load: params.load });

    const provider = params.provider || new HolidayService(service, params.cache, {
        httpSession: session,
        record,
        cacheRepository: params.cacheRepository,
        status: params.status,
        inflight: params.inflight
    });

    return new ReligiousHolidayProvider(
        new HolidayProviderFacade(provider), params.religiousIds,
        params.translateName || LocaleText.translate);
}

var HolidayProviderFacade = class HolidayProviderFacade { // NOSONAR [S3504] -- GJS importer export
    constructor(provider) {
        this._provider = provider;
    }

    get country() {
        return this._provider.country;
    }

    // whether this provider has anything to annotate: the calendar gates on
    // this, never on country-truthiness
    get active() {
        return Boolean(this._provider.country);
    }

    destroy() {
        this._provider.destroy();
    }

    clearPlace() {
        this._provider.clearPlace();
    }

    setPlace(country, region = GLOBAL_REGION, onUpdated) { // NOSONAR [S1788] -- accepted compatible form
        this._provider.setPlace(country, region, onUpdated);
    }

    getHolidays(year, month, callback) {
        this._provider.getHolidays(year, month, callback);
    }
};

// Decorates the facade with the locally-computed religious observances the
// catalogue module expands: the merged month keeps the public provider's
// names first, the way the cache joins same-day rows. The catalogue stays a
// pure helper; the provider contract lives here, beside the facade it wraps.
var ReligiousHolidayProvider = class ReligiousHolidayProvider { // NOSONAR [S3504] -- GJS importer export
    constructor(provider, enabledIds = [], translateName = (text) => text) {
        this._base = provider;
        this._translateName = translateName;
        this.setEnabledIds(enabledIds);
    }

    get country() {
        return this._base.country;
    }

    get active() {
        return this._base.active || this._enabledIds.length > 0;
    }

    setEnabledIds(enabledIds) {
        this._enabledIds = ReligiousHolidays.enabledReligionIds(enabledIds);
    }

    destroy() {
        this._base.destroy();
    }

    clearPlace() {
        this._base.clearPlace();
    }

    setPlace(country, region, onUpdated) {
        this._base.setPlace(country, region, onUpdated);
    }

    // The observance tables cover a bounded window, and past its end a
    // table-backed religion rendered zero rows with no marker, no tooltip and
    // no status line — indistinguishable from a month that simply has none.
    // The provider status channel already reaches the month label, so say it
    // there. A real provider failure still wins: the network is the more
    // actionable problem, and the two would otherwise contend for one label.
    _coverageError(year) {
        return ReligiousHolidays.uncoveredReligions(_numericInput(year), this._enabledIds)
            .length > 0 ? HOLIDAY_ERRORS.RELIGIOUS_DATES_UNAVAILABLE : "";
    }

    getHolidays(year, month, callback) {
        const religious = ReligiousHolidays.monthMap(
            year, month, this._enabledIds, this._translateName);
        const coverage = this._coverageError(year);
        if (!this._base.active) {
            callback(religious, coverage, "");
            return;
        }

        this._base.getHolidays(year, month, (publicHolidays, error, providerName) => {
            callback(ReligiousHolidays.mergeMonthMaps(publicHolidays, religious),
                error || coverage, providerName);
        });
    }
};

if (typeof module !== "undefined") {
    module.exports = {
        HTTP_TIMEOUT_SECONDS, Provider, HolidayCacheRepository, HolidayCache, EnricoServiceAdapter, NagerDateServiceAdapter, OpenHolidaysServiceAdapter, createHolidayServiceChain, HolidayRecordContract, HolidayStatusLedger, HolidayInflight, MAX_HOLIDAYS_PER_YEAR, MAX_EXPANDED_HOLIDAY_ROWS, httpBackedService, createHolidayProvider, HolidayService, HolidayProviderFacade, ReligiousHolidayProvider, HOLIDAY_ERRORS };
}
