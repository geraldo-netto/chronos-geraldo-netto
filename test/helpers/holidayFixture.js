const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeRandom } = require("./prng");
const { makeSoup3 } = require("./soup");
const { FIXED_YEAR, freezeClock } = require("./clock");

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

const modulePath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "holidays.js");
const ioUtilsPath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "ioUtils.js");
const holidayCachePath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "holidayCache.js");
const holidayConstantsPath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "holidayConstants.js");
const holidayRecordPath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "holidayRecord.js");
const holidayServiceAdaptersPath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "holidayServiceAdapters.js");
const religiousCatalogPath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "religiousCatalog.js");
const shimPath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "6.0", "holidays.js");
const localeQueryPath = path.join(__dirname, "..", "..", "files", "chronos@geraldo-netto", "localeQuery.js");

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
        // Gio's async stat, as used by readJsonFileAsync's pre-read cap: the
        // size is checked before the read is issued, so the compositor never
        // allocates a hostile cache file
        query_info_async(_attributes, _flags, _priority, _cancellable, callback) {
            callback(this, { ok: true });
        },
        query_info_finish() {
            return { get_size: () => fs.statSync(filePath).size };
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
    delete require.cache[require.resolve(ioUtilsPath)];
    delete require.cache[require.resolve(holidayCachePath)];
    delete require.cache[require.resolve(holidayConstantsPath)];
    delete require.cache[require.resolve(holidayRecordPath)];
    delete require.cache[require.resolve(holidayServiceAdaptersPath)];
    // localeQuery captures GLib at load, and the message locale decides which
    // translation of a holiday name the record picks: reload it with the rest
    // so it binds this call's GLib rather than an earlier test file's
    delete require.cache[require.resolve(localeQueryPath)];

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
                FileQueryInfoFlags: { NONE: 0 },
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
                get_language_names: () => ["C"],
                PRIORITY_DEFAULT: 0,
                timeout_add_seconds: () => 1,
                source_remove: () => {},
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

// A row as Enrico puts it on the wire. `holidayType` is what says the day is
// public — the adapter mints the app's own flag from it — and a wire row that
// only *claims* "public_holiday" in its free-text flags no longer gets one
// (T991), so a fixture without the type would be testing the denied path.
function holiday(name, year, month, day, flags = ["public_holiday"]) {
    return {
        date: { year, month, day },
        name: [{ lang: "en", text: name }],
        holidayType: "public_holiday",
        flags
    };
}

function anyRecord(overrides = {}) {
    return Object.assign({ // NOSONAR [S6661] -- deliberate test seam
        validResponse: (data) => Array.isArray(data),
        expandHoliday: (entry, region) => [{ holiday: entry, region }]
    }, overrides);
}

let unfreezeClock;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-holidays-"));
    originalImports = global.imports;
    originalLog = global.log;
    originalLogError = global.logError;
    global.log = function() {};
    global.logError = function() {};
    // the cache windows its years around the current one and its staleness rule
    // reads Date.now(): a run that straddles New Year's Eve would compare one
    // year against the other
    unfreezeClock = freezeClock();
});

afterEach(() => {
    unfreezeClock();
    global.imports = originalImports;
    global.log = originalLog;
    global.logError = originalLogError;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

module.exports = {
    assert, test, vm, fs, os, path, makeRandom, makeSoup3, FIXED_YEAR,
    STAMP, NAGER_STAMP, OPENHOLIDAYS_STAMP,
    modulePath, ioUtilsPath, holidayCachePath, holidayConstantsPath,
    holidayRecordPath, holidayServiceAdaptersPath, religiousCatalogPath, shimPath,
    loadCountry, loadJson, cachePath, loadHolidays, holiday, anyRecord
};
