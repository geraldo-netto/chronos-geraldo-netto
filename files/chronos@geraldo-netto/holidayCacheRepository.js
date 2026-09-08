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

// The holiday cache's file: an async Gio read and write, the etag-style merge
// retry and the per-country LRU eviction.
//
// holidayCache.js is the store this fills — rows, two indexes, a month memo and
// a year LRU — and it is a data structure with no I/O in it. The two shared a
// module, and the coupling bit at *import* time: this file resolves a real path
// with GLib.build_filenamev the moment it loads, so the pure store could not be
// loaded without a GLib stub. test/helpers/holidayFixture.js stubbing
// build_filenamev, get_user_cache_dir and mkdir_with_parents is what that cost.
//
// The dependency runs one way: the file knows the store's shape (it validates
// what it reads against it), and the store knows nothing about a file.

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const APPLET_MODULES = IS_NODE ?
    null : GjsImports.ui.appletManager.applets["chronos@geraldo-netto"];

function sibling(name) {
    return APPLET_MODULES ? APPLET_MODULES[name] : require("./" + name); // NOSONAR [S7773] -- the Node guard is APPLET_MODULES
}

const Gio = GjsImports.gi.Gio;
const GLib = GjsImports.gi.GLib;
const IoUtils = sibling("ioUtils");
const ProviderUtils = sibling("providerUtils");
const HolidayRecord = sibling("holidayRecord");
const HolidayCacheModule = sibling("holidayCache");

const MAX_CACHED_COUNTRIES = HolidayCacheModule.MAX_CACHED_COUNTRIES;
const MAX_EXPANDED_HOLIDAY_ROWS = HolidayCacheModule.MAX_EXPANDED_HOLIDAY_ROWS;
const MAX_MERGE_RETRIES = HolidayCacheModule.MAX_MERGE_RETRIES;
const validCachedHoliday = HolidayCacheModule.validCachedHoliday;
const validCachedYears = HolidayCacheModule.validCachedYears;

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

        const now = this._now();
        const savedAt = (country) => {
            const stamp = allData[country] && allData[country].savedAt;
            return Number.isFinite(stamp) && stamp >= 0 && stamp <= now ? stamp : 0;
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
            struct.years = validCachedYears(stored.years, this._now());
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

    _acceptLoad(all) {
        if (this._released) {
            return;
        }
        this._all = all;
        this._releaseLoadWaiters();
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

        IoUtils.readJsonFileAsync(file, (all) => this._acceptLoad(all));
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

if (typeof module !== "undefined") {
    module.exports = { HolidayCacheRepository };
}
