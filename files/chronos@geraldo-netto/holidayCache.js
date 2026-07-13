/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const Gio = GjsImports.gi.Gio;
const GLib = GjsImports.gi.GLib;
const Utils = typeof require === "function" ?
    require("./utils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].utils;
const TextUtils = typeof require === "function" ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;
const HolidayConstants = typeof require === "function" ?
    require("./holidayConstants") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayConstants;

// Named so the number the README quotes ("once every 50 days") has one place
// to read it from; schema_static.test.js asserts the two agree.
var UPDATE_PERIOD_DAYS = 50;
var UPDATE_PERIOD = UPDATE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
var RETRY_PERIOD = 60 * 60 * 1000;
// Holiday names come from three third-party services and land in a Pango
// tooltip. Same-day names are joined, so a provider that repeats itself grows
// the string without limit; a megabyte of tooltip stalls the compositor on
// layout. Real names are a few words, and this is the whole joined cell.
var MAX_HOLIDAY_NAME_LENGTH = 300;
// months of match results kept around: enough that scrolling a year back and
// forth stays free, small enough that a long session cannot grow on it
var MAX_MEMOIZED_MONTHS = 32;
// years kept on either side of the current one; the 42-day grid can reach at
// most one month into a neighbouring year
var YEAR_WINDOW = 1;
// countries kept in the cache file. The user has one at a time, but trying a
// few and going back is normal, and each blob is a nation's year of holidays.
// Without a bound the file keeps every country ever selected, forever.
var MAX_CACHED_COUNTRIES = 4;
// re-merges attempted when another applet instance wrote the file underneath
// us; the loser of the last round simply gives up and refetches later
var MAX_MERGE_RETRIES = 3;
var GLOBAL_REGION = HolidayConstants.GLOBAL_REGION;

// The cache file is plain JSON in the user's cache dir: anything running as
// the user can rewrite it. Network payloads are schema-checked before they
// are stored, so check the stored rows too instead of trusting the file.
function validCachedHoliday(single) {
    return Boolean(single) &&
        typeof single === "object" &&
        Number.isInteger(single.year) &&
        Number.isInteger(single.month) &&
        Number.isInteger(single.day) &&
        typeof single.name === "string" &&
        Array.isArray(single.flags) &&
        (single.region === undefined || typeof single.region === "string");
}

function clampHolidayName(name) {
    return TextUtils.clampText(name, MAX_HOLIDAY_NAME_LENGTH);
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
var HolidayCacheRepository = class HolidayCacheRepository {
    constructor(fn, params = {}) {
        this.fn = fn;
        // the file holds the countries recently visited; parsing it again on
        // each read meant a full sync read per fetch
        this._all = null;
        // the newest data per country, and whether a write is settling: see
        // _flush
        this._pending = {};
        this._writing = false;
        this._dirty = false;
        this._now = params.now || (() => Date.now());
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
        countries.sort((a, b) => savedAt(b) - savedAt(a))
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

        if (stored && typeof stored === "object") {
            if (stored.years && typeof stored.years === "object") {
                struct.years = validCachedYears(stored.years);
            }
            if (Array.isArray(stored.holidays)) {
                struct.holidays = stored.holidays.filter(validCachedHoliday);
            }
        }

        return struct;
    }

    // The read happens while the applet is being constructed, so a synchronous
    // one blocks the compositor at every Cinnamon start and reload. Callers
    // hand in a callback and repaint when the data lands.
    loadAsync(country, callback) {
        const file = this._file();
        if (!file) {
            callback({ years: {}, holidays: []});
            return;
        }

        if (this._all !== null) {
            callback(this._country(this._all, country));
            return;
        }

        Utils.readJsonFileAsync(file, (all) => {
            if (all && Object.keys(all).length > 0) {
                this._all = all;
                callback(this._country(all, country));
                return;
            }

            // the new cache file is absent or empty: one-shot fallback to the
            // pre-rename enrico.json so upgrading does not throw a user's cached
            // holidays away. Once anything is saved the new file is no longer
            // empty and this never runs again.
            this._loadLegacy((legacy) => {
                this._all = legacy || {};
                this._migrate(file);
                callback(this._country(this._all, country));
            });
        });
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

        Utils.readJsonFileAsync(legacyFile, (all) => callback(all));
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
    _flush(file, merges = 0) {
        this._writing = true;
        this._dirty = false;

        Utils.readJsonFileAsync(file, (data, etag) => {
            Object.keys(this._pending).forEach((country) => {
                data[country] = this._pending[country];
            });
            const allData = this._pruneCountries(data);
            this._all = allData;

            // Two writes in flight at once race, and the loser's payload is the
            // older snapshot: let one settle before starting the next. That
            // interlock is per repository *instance*, though, and the file is
            // shared by every applet on every panel — so the read above only
            // merges writes that had already settled. The etag closes the rest:
            // if the file moved between our read and our write, the write fails
            // and we merge again against what is actually there.
            Utils.writeJsonFileAsync(file, allData, (stale) => {
                this._writing = false;

                if (stale && merges < MAX_MERGE_RETRIES) {
                    // our snapshot is out of date, not our data: re-read, merge
                    // the pending countries into the newer file, write again.
                    // Bounded: a cache is a cache, and spinning against a busy
                    // writer would be worse than losing a holiday refetch.
                    this._all = null;
                    this._flush(file, merges + 1);
                    return;
                }

                if (this._dirty) {
                    this._flush(file);
                }
            }, etag);
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
        const file = this._file();
        if (!file) {
            return;
        }

        // stamped when it was saved, not when it happens to be flushed: the
        // eviction sorts on this, and a pending entry that waits out a write in
        // flight must not look newer than one saved after it
        this._pending[country] = Object.assign({}, data, { savedAt: this._now() });
        this._scheduleFlush(file);
    }
};
HolidayCacheRepository.path = GLib.build_filenamev([GLib.get_user_cache_dir(), "chronos@geraldo-netto"]);
// the cache filename before it was renamed off the primary provider; loadAsync
// reads it once when the current file has nothing, so an upgrade keeps its cache
HolidayCacheRepository.LEGACY_FN = "/enrico.json";

var HolidayCache = class HolidayCache {
    constructor(load, save) {
        this._load = load;
        this._save = save;
        this.country = null;
        this.region = GLOBAL_REGION;
        this.years = {};
        this.attempts = {};
        this.data = [];
        this._holidayIndex = new Map();
        this._monthIndex = new Map();
        this._matchedMonthCache = new Map();
        this._indexedDataLength = 0;
    }

    // `onReady` runs once the country's cached data is in place — the load is
    // asynchronous, so a caller that fetches or repaints has to wait for it.
    setPlace(country, region = GLOBAL_REGION, onReady) {
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
            ready();
            return;
        }

        this._load(country, (data) => {
            // a second place change can land while the first is still reading
            if (this.country !== country) {
                return;
            }

            this.years = data.years;
            this.attempts = {};
            this.setData(data.holidays);
            ready();
        });
    }

    setData(data) {
        this.data = Array.isArray(data) ? data : [];
        this._rebuildIndex();
    }

    // What gets persisted is the window the grid can actually reach, so the file
    // does not grow for every year ever browsed and startup does not re-parse all
    // of it. This is a *copy*: the live data, years and attempts are left whole.
    // Pruning them in place discarded a just-fetched out-of-window year and the
    // freshness stamp that throttles it, so browsing two years ahead refetched
    // over the network and rewrote the disk on every calendar update, forever,
    // and the holidays never rendered.
    _windowedForPersist(now = new Date()) {
        const current = now.getFullYear();
        const keep = (year) => Math.abs(Number(year) - current) <= YEAR_WINDOW;

        const years = {};
        for (const year of Object.keys(this.years)) {
            if (keep(year)) {
                years[year] = this.years[year];
            }
        }

        return { years, holidays: this.data.filter((single) => keep(single.year)) };
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

    _rebuildIndex() {
        const holidays = this.data;
        this.data = [];
        this._holidayIndex.clear();
        this._monthIndex.clear();
        this._matchedMonthCache.clear();

        holidays.forEach((single) => this.addUnique(single));
        this._indexedDataLength = this.data.length;
    }

    _syncIndex() {
        if (this._indexedDataLength !== this.data.length) {
            this._rebuildIndex();
        }
    }

    addUnique (single) {
        single.region = single.region || GLOBAL_REGION;
        single.name = clampHolidayName(single.name);
        const known = this._holidayIndex.get(this._holidayKey(single));

        if (known) {
            if (!known.name.split('\n').includes(single.name)) {
                known.name = clampHolidayName(known.name + '\n' + single.name);
            }
        } else {
            this.data.push(single);
            this._indexHoliday(single);
            this._matchedMonthCache.clear();
            this._indexedDataLength = this.data.length;
        }
    }

    recordYear(year, region, retrieved) {
        if (this.years[year]) {
            this.years[year][region] = retrieved;
        } else {
            this.years[year] = {[region]: retrieved};
        }
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
    }

    clearPlace() {
        this.country = null;
    }

    recordAttempt(year, region, attempted = new Date().toUTCString()) {
        if (this.attempts[year]) {
            this.attempts[year][region] = attempted;
        } else {
            this.attempts[year] = {[region]: attempted};
        }
    }

    // `now` is injectable so staleness math is testable with a fixed clock
    stale(year, region = this.region, now = Date.now()) {
        if (this.years[year]) {
            const retrieved = this.years[year][region];
            if (retrieved && now - new Date(retrieved).getTime() < UPDATE_PERIOD) {
                return false;
            }
        }

        if (this.attempts[year]) {
            const attempted = this.attempts[year][region];
            if (attempted && now - new Date(attempted).getTime() < RETRY_PERIOD) {
                return false;
            }
        }

        return true;
    }

    matchMonth(year, month, region = this.region) {
        this._syncIndex();
        const monthKey = this._monthKey(year, month, region);
        const cached = this._matchedMonthCache.get(monthKey);
        if (cached) {
            return cached;
        }

        const holidays = this._monthIndex.get(monthKey);

        if (!holidays) {
            return this._rememberMonth(monthKey, new Map());
        }

        const matched = new Map(Array.from(holidays.entries()).map(([date, holiday]) => [date, [holiday.name, holiday.flags]]));
        return this._rememberMonth(monthKey, matched);
    }

    persist(now = new Date()) {
        // an inflight fetch can land after clearPlace(); saving then
        // would write the payload under a "null" country key
        if (!this.country) {
            return;
        }

        this._save(this.country, this._windowedForPersist(now));
    }
};


if (typeof module !== "undefined") {
    module.exports = { HolidayCacheRepository, HolidayCache, validCachedHoliday, validCachedStamp, validCachedYears, clampHolidayName, MAX_HOLIDAY_NAME_LENGTH, MAX_MEMOIZED_MONTHS, MAX_CACHED_COUNTRIES, UPDATE_PERIOD_DAYS, UPDATE_PERIOD, RETRY_PERIOD, YEAR_WINDOW, GLOBAL_REGION };
}
