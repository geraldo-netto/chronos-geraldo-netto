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
// findExtensionSubdirectory has already repointed at the 6.0/ directory — and the
// applet would fail to load, because localeUtils.js is not in there.
//
// Node is what this asks about, because Node is the only host that requires these
// files directly. Cinnamon's cjs has no `process`.
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const Gio = GjsImports.gi.Gio;
const GLib = GjsImports.gi.GLib;
const IoUtils = IS_NODE ?
    require("./ioUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].ioUtils;
const ProviderUtils = IS_NODE ?
    require("./providerUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].providerUtils;
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;
const HolidayConstants = IS_NODE ?
    require("./holidayConstants") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayConstants;
const HolidayRecord = IS_NODE ?
    require("./holidayRecord") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayRecord;

// Named so the number the README quotes ("once every 50 days") has one place
// to read it from; schema_static.test.js asserts the two agree.
var UPDATE_PERIOD_DAYS = 50; // NOSONAR [S3504] -- GJS importer export
var UPDATE_PERIOD = UPDATE_PERIOD_DAYS * 24 * 60 * 60 * 1000; // NOSONAR [S3504] -- GJS importer export
var RETRY_PERIOD = 60 * 60 * 1000; // NOSONAR [S3504] -- GJS importer export
// Holiday names come from three third-party services and land in a Pango
// tooltip. Same-day names are joined, so a provider that repeats itself grows
// the string without limit; a megabyte of tooltip stalls the compositor on
// layout. Real names are a few words, and this is the whole joined cell.
var MAX_HOLIDAY_NAME_LENGTH = 300; // NOSONAR [S3504] -- GJS importer export

function compareCodeUnits(left, right) {
    if (left < right) {
        return -1;
    }
    return left > right ? 1 : 0;
}
// months of match results kept around: enough that scrolling a year back and
// forth stays free, small enough that a long session cannot grow on it
var MAX_MEMOIZED_MONTHS = 32; // NOSONAR [S3504] -- GJS importer export
// The years the applet keeps in memory, as opposed to the ±YEAR_WINDOW it
// persists. The grid straddles two months, so it reads at most two years; this
// leaves room to page around and come back without refetching, and bounds what a
// session of scrolling can hold. Held whole, `data`, the two indexes, `years` and
// `attempts` grew with every year the user ever scrolled to — 60 years of a
// 15-holiday country is 469 KiB, and MAX_EXPANDED_HOLIDAY_ROWS × years browsed is
// the ceiling.
//
// It is an LRU on use, not a window around today: a hard window is what the
// comment on HolidayPersistWindow.snapshot warns about — it discarded a *just-fetched*
// out-of-window year together with the freshness stamp that throttles it, so the
// year was refetched on every calendar update, forever. The year the user is
// looking at is by definition the most recently used one.
var MAX_CACHED_YEARS = 8; // NOSONAR [S3504] -- GJS importer export
// years kept on either side of the current one; the 42-day grid can reach at
// most one month into a neighbouring year
var YEAR_WINDOW = 1; // NOSONAR [S3504] -- GJS importer export
// countries kept in the cache file. The user has one at a time, but trying a
// few and going back is normal, and each blob is a nation's year of holidays.
// Without a bound the file keeps every country ever selected, forever.
var MAX_CACHED_COUNTRIES = 4; // NOSONAR [S3504] -- GJS importer export
// re-merges attempted when another applet instance wrote the file underneath
// us; the loser of the last round simply gives up and refetches later
var MAX_MERGE_RETRIES = 3; // NOSONAR [S3504] -- GJS importer export
var PART_DAY_HOLIDAY = HolidayConstants.PART_DAY_HOLIDAY; // NOSONAR [S3504] -- GJS importer export
var GLOBAL_REGION = HolidayConstants.GLOBAL_REGION; // NOSONAR [S3504] -- GJS importer export
var MAX_EXPANDED_HOLIDAY_ROWS = HolidayRecord.MAX_EXPANDED_HOLIDAY_ROWS; // NOSONAR [S3504] -- GJS importer export

// The cache file is plain JSON in the user's cache dir: anything running as
// the user can rewrite it. Network payloads are schema-checked before they
// are stored, so check the stored rows too instead of trusting the file.
function validCachedHoliday(single) {
    return Boolean(single) &&
        typeof single === "object" &&
        HolidayRecord.validDateParts(single) &&
        HolidayRecord.nonBlankText(single.name) &&
        HolidayRecord.validHolidayFlags(single.flags) &&
        (single.region === undefined || typeof single.region === "string");
}

function clampHolidayName(name) {
    return TextUtils.clampText(name, MAX_HOLIDAY_NAME_LENGTH);
}

function mergeHolidayFlags(current, incoming) {
    const bothPartDay = current.includes(PART_DAY_HOLIDAY) &&
        incoming.includes(PART_DAY_HOLIDAY);
    return Array.from(new Set(current.concat(incoming)))
        .filter((flag) => bothPartDay || flag !== PART_DAY_HOLIDAY)
        .sort(compareCodeUnits);
}

// The rows are checked; the freshness record has to be too. stale() only asks
// whether `now - retrieved` is still inside UPDATE_PERIOD, so a stamp planted
// in the future keeps whatever rows sit beside it fresh forever and suppresses
// every refetch. An unparseable or future stamp is dropped, which at worst
// makes the year stale — the safe direction.
function validCachedStamp(stamp, now = Date.now()) {
    if (typeof stamp !== "string") {
        return false;
    }

    const parsed = new Date(stamp).getTime();
    return Number.isFinite(parsed) && parsed <= now;
}

function validCachedYears(years, now = Date.now()) {
    const checked = {};

    Object.keys(years).forEach((year) => {
        const regions = years[year];
        if (!regions || typeof regions !== "object") {
            return;
        }

        const kept = {};
        Object.keys(regions).forEach((region) => {
            if (validCachedStamp(regions[region], now)) {
                kept[region] = regions[region];
            }
        });

        if (Object.keys(kept).length > 0) {
            checked[year] = kept;
        }
    });

    return checked;
}

function cachedStampIsFresh(stamp, now, period) {
    const age = now - new Date(stamp).getTime();
    return Number.isFinite(age) && age >= 0 && age < period;
}
var HolidayCacheRepository = class HolidayCacheRepository { // NOSONAR [S3504] -- GJS importer export
    constructor(fn, params = {}) {
        this.fn = fn;
        // the file holds the countries recently visited; parsing it again on
        // each read meant a full sync read per fetch
        this._all = null;
        this._load_waiters = null;
        // the newest data per country, and whether a write is settling: see
        // _flush
        this._pending = {};
        this._writing = false;
        this._dirty = false;
        this._now = params.now || (() => Date.now());
        this._released = false;
    }

    // Terminal: the applet object outlives its panel, while async file
    // callbacks can outlive this call. Drop every completed snapshot now and
    // refuse new work. A write already in flight retains only its pending
    // countries until it settles, so teardown never loses a fetched cache row
    // merely to save memory.
    release() {
        if (this._released) {
            return;
        }
        this._released = true;
        this._all = null;
        this._load_waiters = null;
        this._fileHandle = null;
        if (!this._writing) {
            this._pending = {};
            this._dirty = false;
        }
    }

    // prune() trims the *years* of the country in use; the per-country blobs of
    // every country the user has ever tried were kept forever, and each one is a
    // year's holidays for a whole nation. Nothing ever removed them, so the file
    // — which _flush re-reads on every successful fetch — grew for the life of
    // the install. Keeping a handful means switching back to a recent country is
    // still free.
    _pruneCountries(allData) {
        const countries = Object.keys(allData);
        if (countries.length <= MAX_CACHED_COUNTRIES) {
            return allData;
        }

        const savedAt = (country) => {
            const stamp = allData[country] && Number(allData[country].savedAt);
            return Number.isFinite(stamp) ? stamp : 0;
        };

        const kept = {};
        countries.sort((a, b) => savedAt(b) - savedAt(a)) // NOSONAR [S4043] -- accepted compatible form
            .slice(0, MAX_CACHED_COUNTRIES)
            .forEach((country) => {
                kept[country] = allData[country];
            });

        return kept;
    }

    // loadFile() creates the cache directory, and it used to run on every load
    // and every save. The directory does not come and go while the shell runs;
    // resolve it once.
    _file() {
        if (this._fileHandle === undefined) {
            this._fileHandle = HolidayCacheRepository.loadFile(this.fn);
        }

        return this._fileHandle;
    }

    _country(all, country) {
        const struct = { years: {}, holidays: []};
        const stored = all[country];

        if (!stored || typeof stored !== "object") {
            return struct;
        }
        if (stored.years && typeof stored.years === "object") {
            struct.years = validCachedYears(stored.years);
        }
        if (!Array.isArray(stored.holidays)) {
            struct.years = {};
            return struct;
        }

        const bounded = stored.holidays.slice(0, MAX_EXPANDED_HOLIDAY_ROWS);
        struct.holidays = bounded
            .filter(validCachedHoliday)
            .map((single) => ({
                ...single,
                flags: HolidayRecord.publicHolidayFlags(single.flags)
            }));

        // Freshness describes the complete row snapshot. If validation or the
        // safety cap drops anything, keeping the stamps would suppress the
        // fetch that can repair the incomplete cache.
        if (struct.holidays.length !== stored.holidays.length) {
            struct.years = {};
        }

        return struct;
    }

    _releaseLoadWaiters() {
        const waiting = this._load_waiters || [];
        this._load_waiters = null;
        ProviderUtils.notifyAll(waiting.map(({ country, callback }) =>
            () => callback(this._country(this._all, country))));
    }

    _acceptLegacyLoad(file, legacy) {
        if (this._released) {
            return;
        }
        this._all = legacy || {};
        this._migrate(file);
        this._releaseLoadWaiters();
    }

    _acceptCurrentLoad(file, all) {
        if (this._released) {
            return;
        }
        if (all && Object.keys(all).length > 0) {
            this._all = all;
            this._releaseLoadWaiters();
            return;
        }

        // The new cache file is absent or empty: one-shot fallback to the
        // pre-rename enrico.json so upgrading does not throw a user's cached
        // holidays away. Once anything is saved the new file is no longer
        // empty and this never runs again.
        this._loadLegacy((legacy) => this._acceptLegacyLoad(file, legacy));
    }

    // The read happens while the applet is being constructed, so a synchronous
    // one blocks the compositor at every Cinnamon start and reload. Callers
    // hand in a callback and repaint when the data lands.
    loadAsync(country, callback) {
        if (this._released) {
            return;
        }
        const file = this._file();
        if (!file) {
            callback({ years: {}, holidays: []});
            return;
        }

        if (this._all !== null) {
            callback(this._country(this._all, country));
            return;
        }

        if (this._load_waiters !== null) {
            this._load_waiters.push({ country, callback });
            return;
        }
        this._load_waiters = [{ country, callback }];

        IoUtils.readJsonFileAsync(file, (all) => this._acceptCurrentLoad(file, all));
    }

    // Copy what the old file held into the new one, through the same pending/
    // flush path a save takes. It cannot just be left in `this._all`: _flush
    // merges the pending countries into what is *on disk*, and on disk the new
    // file is still empty — so the next save would write its own country and
    // drop every migrated one, which is the loss the migration exists to avoid.
    _migrate(file) {
        const countries = Object.keys(this._all);
        if (countries.length === 0) {
            return;
        }

        countries.forEach((country) => {
            this._pending[country] = this._all[country];
        });
        this._scheduleFlush(file);
    }

    // reads the old cache path when the new one has nothing; a repository pointed
    // straight at the legacy file has nothing older to fall back to
    _loadLegacy(callback) {
        if (this.fn === HolidayCacheRepository.LEGACY_FN) {
            callback(null);
            return;
        }

        const legacyFile = HolidayCacheRepository.loadFile(HolidayCacheRepository.LEGACY_FN);
        if (!legacyFile) {
            callback(null);
            return;
        }

        IoUtils.readJsonFileAsync(legacyFile, (all) => callback(all));
    }

    static loadFile (fn) {
        try {
            GLib.mkdir_with_parents(HolidayCacheRepository.path, 0o700);
            return Gio.file_new_for_path(HolidayCacheRepository.path + fn);
        } catch(e) {
            // a failed cache dir is an error, and callers get an explicit
            // null rather than an implicit undefined
            if (global.logError) {
                global.logError(e);
            }
            return null;
        }
    }

    // A second applet instance on the panel has its own repository, hence its
    // own snapshot of the file, and the file holds every country. Writing a
    // snapshot back wholesale therefore drops whatever the other instance
    // saved since we read it. Re-reading here is what makes the write a merge.
    //
    // The read is asynchronous, like every other read in this module: it used to
    // be a synchronous read — on the compositor thread, in the file that added
    // an async reader precisely to keep this parse off it — and the file it
    // parses grows with every country the user has ever tried.
    // What survived the prune is on disk, so holding it here as well kept a full
    // year-of-holidays blob for every country the session ever selected — up to
    // all 58 while a user browses the settings dialog — and every later flush
    // re-merged the lot into the freshly-read file before pruning it again. That
    // is precisely the bound MAX_CACHED_COUNTRIES exists to enforce.
    //
    // Only the entries this round actually wrote are dropped, and only if a save
    // has not replaced them since: a save that lands mid-write belongs to the next
    // round.
    _releasePending(flushed) {
        for (const country of Object.keys(flushed)) {
            if (this._pending[country] === flushed[country]) {
                delete this._pending[country];
            }
        }
    }

    _mergePending(data, flushing) {
        Object.keys(flushing).forEach((country) => {
            data[country] = flushing[country];
        });
        const allData = this._pruneCountries(data);
        if (!this._released) {
            this._all = allData;
        }
        return allData;
    }

    _settleFlush(file, flushing, merges, stale) {
        this._writing = false;

        if (stale && merges < MAX_MERGE_RETRIES) {
            // Our snapshot is out of date, not our data: re-read and merge the
            // pending countries into the newer file. The pending entries stay
            // put because the retry is what writes them.
            this._all = null;
            this._flush(file, merges + 1);
            return;
        }

        this._releasePending(flushing);
        if (this._dirty) {
            this._flush(file);
        } else if (this._released) {
            this._pending = {};
        }
    }

    _flush(file, merges = 0) {
        this._writing = true;
        this._dirty = false;

        const flushing = Object.assign({}, this._pending); // NOSONAR [S6661] -- accepted compatible form

        IoUtils.readJsonFileAsync(file, (data, etag) => {
            const allData = this._mergePending(data, flushing);

            // Two writes in flight at once race, and the loser's payload is the
            // older snapshot: let one settle before starting the next. That
            // interlock is per repository *instance*, though, and the file is
            // shared by every applet on every panel — so the read above only
            // merges writes that had already settled. The etag closes the rest:
            // if the file moved between our read and our write, the write fails
            // and we merge again against what is actually there.
            IoUtils.writeJsonFileAsync(file, allData,
                (stale) => this._settleFlush(file, flushing, merges, stale), etag);
        });
    }

    // one write settles at a time; a save that lands during one is folded into
    // the next round rather than racing it
    _scheduleFlush(file) {
        if (this._writing) {
            this._dirty = true;
            return;
        }

        this._flush(file);
    }

    save(country, data) {
        if (this._released) {
            return;
        }
        const file = this._file();
        if (!file) {
            return;
        }

        // stamped when it was saved, not when it happens to be flushed: the
        // eviction sorts on this, and a pending entry that waits out a write in
        // flight must not look newer than one saved after it
        this._pending[country] = Object.assign({}, data, { savedAt: this._now() }); // NOSONAR [S6661] -- accepted compatible form
        this._scheduleFlush(file);
    }
};
HolidayCacheRepository.path = GLib.build_filenamev([GLib.get_user_cache_dir(), "chronos@geraldo-netto"]);
// the cache filename before it was renamed off the primary provider; loadAsync
// reads it once when the current file has nothing, so an upgrade keeps its cache
HolidayCacheRepository.LEGACY_FN = "/enrico.json";


// When a stored stamp stops being trusted.
//
// The store below is a data structure - rows, two indexes and a year LRU - and
// this is release policy: how long a fetch is believed, and how long a failure
// suppresses the next attempt. It used to be a third responsibility of that
// class, alongside a month memo and the persistence windowing, and the cache is
// given it now instead of owning it.
var HolidayFreshness = class HolidayFreshness { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._update_period = params.updatePeriod || UPDATE_PERIOD;
        this._retry_period = params.retryPeriod || RETRY_PERIOD;
    }

    // A year has to be asked for again unless a fetch inside the update period,
    // or a failed attempt inside the retry period, says otherwise. The second
    // is what stops a provider being hammered while it is down.
    stale(fetched, attempted, now) {
        return !cachedStampIsFresh(fetched, now, this._update_period) &&
            !cachedStampIsFresh(attempted, now, this._retry_period);
    }
};

// Which of the cache's years and rows reach the disk.
//
// Two rules, both about the file rather than about the data structure: the
// ±YEAR_WINDOW the 42-day grid can reach, and the row ceiling the loader treats
// a snapshot as complete below. recordFetch's own comment explains why
// persistence was pulled out of the store; persist() and this pair stayed.
var HolidayPersistWindow = class HolidayPersistWindow { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._year_window = Number.isInteger(params.yearWindow) ?
            params.yearWindow : YEAR_WINDOW;
        this._max_rows = params.maxRows || MAX_EXPANDED_HOLIDAY_ROWS;
    }

    // A *copy*: the live years, attempts and rows are left whole. Pruning them
    // in place discarded a just-fetched out-of-window year and the freshness
    // stamp that throttles it, so browsing two years ahead refetched over the
    // network and rewrote the disk on every calendar update, forever, and the
    // holidays never rendered.
    snapshot(allYears, allHolidays, now = new Date()) {
        const current = now.getFullYear();
        const keep = (year) => Math.abs(Number(year) - current) <= this._year_window;

        const years = {};
        for (const year of Object.keys(allYears)) {
            if (keep(year)) {
                years[year] = allYears[year];
            }
        }

        return this._bounded(years,
            allHolidays.filter((single) => keep(single.year)), current);
    }

    // The loader accepts at most MAX_EXPANDED_HOLIDAY_ROWS rows per country and
    // treats a longer snapshot as incomplete, wiping every stamp beside it — so
    // persisting more than that turned one region-heavy session into a refetch
    // and rewrite on every applet load, forever. Evict whole years from the
    // snapshot, farthest from today first, stamps together with rows (in this
    // copy only), until it fits: what is persisted is then loaded back whole,
    // freshness included.
    _bounded(years, holidays, current) {
        if (holidays.length <= this._max_rows) {
            return { years, holidays };
        }

        const rowsPerYear = new Map();
        holidays.forEach((single) => {
            const year = Number(single.year);
            rowsPerYear.set(year, (rowsPerYear.get(year) || 0) + 1);
        });

        const evicted = new Set();
        let total = holidays.length;
        const farthestFirst = Array.from(rowsPerYear.keys())
            .sort((a, b) => Math.abs(b - current) - Math.abs(a - current) || a - b);
        for (const year of farthestFirst) {
            if (total <= this._max_rows || evicted.size === rowsPerYear.size - 1) {
                break;
            }
            evicted.add(year);
            total -= rowsPerYear.get(year);
            delete years[year];
        }

        let kept = holidays.filter((single) => !evicted.has(Number(single.year)));
        if (kept.length > this._max_rows) {
            // one year alone overflows the loader's cap: persist what fits and
            // drop that year's stamp, so the truncated year is refetched rather
            // than trusted as complete
            delete years[Number(kept[0].year)];
            kept = kept.slice(0, this._max_rows);
        }

        return { years, holidays: kept };
    }
};

var HolidayCache = class HolidayCache { // NOSONAR [S3504] -- GJS importer export
    constructor(load, save, params = {}) {
        this._load = load;
        this._save = save;
        // the two policies this class used to hold alongside the row store, the
        // indexes, the year LRU and the month memo
        this._freshness = params.freshness || new HolidayFreshness();
        this._persist_window = params.persistWindow || new HolidayPersistWindow();
        this.country = null;
        this.region = GLOBAL_REGION;
        this.years = {};
        this.attempts = {};
        this.data = [];
        this._holidayIndex = new Map();
        this._monthIndex = new Map();
        this._matchedMonthCache = new Map();
        // insertion order is recency: re-touching deletes and re-adds
        this._yearUse = new Map();
        this._loading = false;
        this._load_generation = 0;
        this._onReady = [];
        this._released = false;
    }

    _isActive() {
        return !this._released;
    }

    // The disk read setPlace starts is asynchronous, and Cinnamon runs the
    // first grid update in the same stack as applet construction — before the
    // read lands. Staleness judged at that instant sees no years at all, so a
    // caller that acts on it dispatches a network fetch for data that is
    // already fresh on disk. Anyone whose answer depends on the cached years
    // waits here; with no load pending this is a plain synchronous call.
    whenReady(callback) {
        if (!this._isActive()) {
            return;
        }
        if (this._loading) {
            this._onReady.push(callback);
            return;
        }

        callback();
    }

    _flushReady(first = null) {
        this._loading = false;
        const waiting = this._onReady;
        this._onReady = [];
        if (first) {
            waiting.unshift(first);
        }
        ProviderUtils.notifyAll(waiting);
    }

    _touchYear(year) {
        const key = Number(year);
        if (!Number.isFinite(key)) {
            return;
        }

        this._yearUse.delete(key);
        this._yearUse.set(key, true);
    }

    // A year and its freshness stamp go together: dropping the rows but keeping
    // the stamp would leave the year looking fetched and rendering nothing.
    _forgetYear(year) {
        this._yearUse.delete(year);
        delete this.years[year];
        delete this.attempts[year];
    }

    // Choosing the victims is per year; rebuilding the indexes is not. Each
    // eviction used to filter the whole row list and then replay every survivor
    // through _addUnique, clearing and refilling three Maps as it went — so
    // evicting k years paid k full rebuilds of a list that only ever shrinks.
    _pruneYears() {
        const evicted = new Set();
        while (this._yearUse.size > MAX_CACHED_YEARS) {
            const oldest = this._yearUse.keys().next().value;
            this._forgetYear(oldest);
            evicted.add(oldest);
        }

        if (evicted.size === 0) {
            return;
        }

        this.data = this.data.filter((single) => !evicted.has(Number(single.year)));
        this._rebuildIndex();
    }

    // `onReady` runs once the country's cached data is in place — the load is
    // asynchronous, so a caller that fetches or repaints has to wait for it.
    setPlace(country, region = GLOBAL_REGION, onReady) { // NOSONAR [S1788] -- accepted compatible form
        if (!this._isActive()) {
            return;
        }
        // regioned countries default the region setting to null, which
        // bypasses the parameter default (null !== undefined)
        region = region || GLOBAL_REGION;
        const ready = () => {
            if (onReady) {
                onReady();
            }
        };

        const changed = this.country !== country;
        this.country = country;
        this.region = region;

        if (!changed) {
            // a load for this country may still be in flight; the caller's
            // answer is only meaningful once it has landed
            this.whenReady(ready);
            return;
        }

        const generation = ++this._load_generation;
        this._loading = true;
        this._load(country, (data) => {
            // Country equality alone cannot reject A1 after A→B→A. Only
            // the read started by the current selection may install data or
            // release callers waiting behind it.
            if (!this._isActive() || generation !== this._load_generation) {
                return;
            }

            this.years = data.years;
            this.attempts = {};
            this.setData(data.holidays);
            this._flushReady(ready);
        });
    }

    setData(data) {
        if (!this._isActive()) {
            return;
        }
        this.data = Array.isArray(data) ? data : [];
        // a brand-new row set, so the LRU is derived from it rather than carried
        // over from the rows it replaces — and the cap applies to it at once,
        // rather than waiting for the next fetch to notice
        this._rebuildIndex(false);
        this._pruneYears();
    }

    // The memo gains an entry for every month scrolled to, empty ones
    // included, and scrolling needs no fetch — so prune(), which only runs on
    // the write path, cannot bound it. The grid never reads more than the two
    // months it straddles; the rest is kept only to make scrolling back cheap.
    _rememberMonth(monthKey, matched) {
        if (this._matchedMonthCache.size >= MAX_MEMOIZED_MONTHS) {
            const oldest = this._matchedMonthCache.keys().next().value;
            this._matchedMonthCache.delete(oldest);
        }

        this._matchedMonthCache.set(monthKey, matched);
        return matched;
    }

    _holidayKey(single) {
        return `${single.year}/${single.month}/${single.day}/${single.region}`;
    }

    _monthKey(year, month, region) {
        return `${year}/${month}/${region}`;
    }

    _invalidateMonth(single) {
        this._matchedMonthCache.delete(
            this._monthKey(single.year, single.month, single.region));
    }

    _indexHoliday(single) {
        this._holidayIndex.set(this._holidayKey(single), single);

        const monthKey = this._monthKey(single.year, single.month, single.region);
        let month = this._monthIndex.get(monthKey);
        if (!month) {
            month = new Map();
            this._monthIndex.set(monthKey, month);
        }

        month.set(`${single.month}/${single.day}`, single);
    }

    // Replaying `data` runs `_addUnique`, which ends in `_touchYear` — so the
    // rebuild used to rewrite the whole recency order into `data` insertion
    // order, discarding everything `matchMonth` and `recordAttempt` had
    // recorded. Eviction then picked the first-fetched year instead of the
    // least-recently-used one, and a just-recorded failed attempt became the
    // next victim after a single sibling year, losing the RETRY_PERIOD guard
    // that `recordAttempt`'s own `_touchYear` exists to hold. Reindexing is
    // bookkeeping, not use: restore the order the replay overwrote.
    //
    // The snapshot is exact rather than merged, because every year with rows is
    // in it by construction — `_addUnique` touched it when the row first
    // arrived — and years with no rows at all (an attempt recorded but nothing
    // fetched) must survive too, since their stamp is what the retry throttle
    // reads.
    //
    // "By construction" is true of `_pruneYears`, which rebuilds a list that
    // only ever shrinks. It is false of `setData`, which installs a row set read
    // from disk whose years this cache never touched: restoring the snapshot
    // there left them holding rows in `data` and stamps in `years` with no
    // `_yearUse` entry at all, so `_pruneYears` could never select them,
    // `_forgetYear` could never reach them, and MAX_CACHED_YEARS was bypassed
    // for the life of the place selection. Hence `preserveOrder`: a new row set
    // derives its recency from the rows and stamps actually installed.
    _rebuildIndex(preserveOrder = true) {
        const holidays = this.data;
        const yearOrder = preserveOrder ? Array.from(this._yearUse.keys()) : null;
        this.data = [];
        this._holidayIndex.clear();
        this._monthIndex.clear();
        this._matchedMonthCache.clear();
        if (!preserveOrder) {
            this._yearUse.clear();
        }

        holidays.forEach((single) => this.addUnique(single));

        if (yearOrder) {
            this._yearUse = new Map(yearOrder.map((year) => [year, true]));
            return;
        }

        // a year may carry a freshness or attempt stamp and no rows at all, and
        // that stamp is what suppresses its refetch: cachedYears() has to see it
        Object.keys(this.years).forEach((year) => this._touchYear(year));
    }

    addUnique (single) {
        if (!this._isActive()) {
            return;
        }
        this._addUnique(single);
    }

    _addUnique(single) {
        single.region = single.region || GLOBAL_REGION;
        single.name = clampHolidayName(single.name);
        const known = this._holidayIndex.get(this._holidayKey(single));

        if (known) {
            let changed = false;
            if (!known.name.split('\n').includes(single.name)) {
                known.name = clampHolidayName(known.name + '\n' + single.name);
                changed = true;
            }

            const flags = mergeHolidayFlags(known.flags, single.flags);
            if (flags.length !== known.flags.length ||
                flags.some((flag, index) => flag !== known.flags[index])) {
                known.flags = flags;
                changed = true;
            }

            if (changed) {
                this._invalidateMonth(known);
            }
        } else {
            this.data.push(single);
            this._indexHoliday(single);
            this._invalidateMonth(single);
        }

        this._touchYear(single.year);
    }

    recordYear(year, region, retrieved) {
        if (!this._isActive()) {
            return;
        }
        if (this.years[year]) {
            this.years[year][region] = retrieved;
        } else {
            this.years[year] = {[region]: retrieved};
        }

        this._touchYear(year);
    }

    // `received` is injectable like recordAttempt's clock; a response
    // without a Date header must not leave the year forever stale (and
    // refetched every RETRY_PERIOD), so fall back to the receive time.
    //
    // This records; it does not write. It used to call prune() and persist() at
    // the end, so recording a fetch result triggered a disk write from inside
    // the data structure and a caller that wanted to record without persisting
    // had no path to it. Whether a result is worth writing to disk is the
    // fetch's decision, and the fetch is the provider's.
    recordFetch(year, region, retrieved, holidays, received = new Date().toUTCString()) {
        if (!this._isActive()) {
            return;
        }
        // The stamp is the provider's raw Date response header. validCachedStamp
        // exists precisely because a stamp in the future keeps its year fresh
        // forever — stale() only asks whether now - retrieved is inside
        // UPDATE_PERIOD — but it was only ever applied on the way *out* of the
        // cache file, never to the value coming off the network. A provider
        // with a skewed clock (or a hostile one) answering "Date: … 2050" got
        // that year pinned as fresh for the rest of the session, and persisted.
        // Falling back to the receive time is the same safe direction the
        // header-less case already takes.
        const stamp = validCachedStamp(retrieved) ? retrieved : received;
        this.recordYear(year, region, stamp);
        holidays.forEach((single) => this.addUnique(single));
        // the year that just landed is the most recently used one, so the prune
        // can never drop it
        this._pruneYears();
    }

    // The rows, the two indexes, the month memo, the year LRU and the freshness
    // stamps all describe a country that is no longer selected, and nothing
    // reads them again: with no country the facade reports inactive, so the
    // annotator never asks, and re-selecting the same country takes setPlace's
    // `changed` branch and reloads from disk regardless. Held, they kept up to
    // MAX_EXPANDED_HOLIDAY_ROWS rows and their indexes alive for the rest of the
    // session for a user who simply switched holidays off.
    _dropCachedPlace() {
        this.data = [];
        this.years = {};
        this.attempts = {};
        this._yearUse.clear();
        this._holidayIndex.clear();
        this._monthIndex.clear();
        this._matchedMonthCache.clear();
    }

    clearPlace() {
        if (!this._isActive()) {
            return;
        }
        this._load_generation++;
        this.country = null;
        this._dropCachedPlace();
        // a load still in flight was for a place that no longer exists; whoever
        // queued behind it gets the no-country answer now instead of never
        this._flushReady();
    }

    // The applet is gone: the persisted copy is already on disk, and every
    // structure below is a month of the user's browsing that nothing will read
    // again. Held, they keep a year of holidays per year browsed alive for the
    // rest of the login session — the applet object outlives its removal (see
    // AppletContextMenu's sourceActor), so nothing else drops them.
    release() {
        // waiters would repaint actors the removal has already destroyed
        this._released = true;
        this._load_generation++;
        this.country = null;
        this.region = GLOBAL_REGION;
        this._onReady = [];
        this._loading = false;
        this._dropCachedPlace();
    }

    recordAttempt(year, region, attempted = new Date().toUTCString()) {
        if (!this._isActive()) {
            return;
        }
        if (this.attempts[year]) {
            this.attempts[year][region] = attempted;
        } else {
            this.attempts[year] = {[region]: attempted};
        }

        // a failed fetch stores no rows, so nothing else registers the year:
        // without this its attempt stamp is invisible to the LRU and outlives
        // every year that actually holds data
        this._touchYear(year);
        this._pruneYears();
    }

    // the years the LRU holds, oldest first: the status ledger prunes in step
    // with this, so a year's error record lives exactly as long as the attempt
    // stamp that suppresses its refetch
    cachedYears() {
        return Array.from(this._yearUse.keys());
    }

    // `now` is injectable so staleness math is testable with a fixed clock
    stale(year, region = this.region, now = Date.now()) {
        const stampFor = (table) => (table[year] ? table[year][region] : null);
        return this._freshness.stale(
            stampFor(this.years), stampFor(this.attempts), now);
    }

    matchMonth(year, month, region = this.region) {
        if (!this._isActive()) {
            return new Map();
        }
        // the grid is reading this year: that is what keeps it out of the prune
        this._touchYear(year);
        const monthKey = this._monthKey(year, month, region);
        const cached = this._matchedMonthCache.get(monthKey);
        if (cached) {
            // _rememberMonth evicts by Map iteration order, and this memo
            // exists to make scrolling back cheap — so a month that is being
            // read has to become the newest, or the eviction drops the months
            // the user keeps returning to and keeps the ones passed through
            // once on the way there.
            this._matchedMonthCache.delete(monthKey);
            this._matchedMonthCache.set(monthKey, cached);
            return cached;
        }

        const holidays = this._monthIndex.get(monthKey);

        if (!holidays) {
            return this._rememberMonth(monthKey, new Map());
        }

        const matched = new Map(Array.from(holidays.entries()).map(
            ([date, holiday]) => [date, HolidayConstants.monthHolidayEntry(holiday.name, holiday.flags)]));
        return this._rememberMonth(monthKey, matched);
    }

    persist(now = new Date()) {
        if (!this._isActive()) {
            return;
        }
        // an inflight fetch can land after clearPlace(); saving then
        // would write the payload under a "null" country key
        if (!this.country) {
            return;
        }

        this._save(this.country,
            this._persist_window.snapshot(this.years, this.data, now));
    }
};


if (typeof module !== "undefined") {
    module.exports = { HolidayCacheRepository, HolidayCache, HolidayFreshness, HolidayPersistWindow, validCachedHoliday, validCachedStamp, validCachedYears, clampHolidayName, MAX_HOLIDAY_NAME_LENGTH, MAX_MEMOIZED_MONTHS, MAX_CACHED_YEARS, MAX_CACHED_COUNTRIES, PART_DAY_HOLIDAY, UPDATE_PERIOD_DAYS, UPDATE_PERIOD, RETRY_PERIOD, YEAR_WINDOW, GLOBAL_REGION };
}
