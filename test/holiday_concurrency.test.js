const { assert, test, fs, cachePath, loadHolidays, ioUtilsPath } = require("./helpers/holidayFixture");

const NOW = Date.parse("2026-09-08T12:00:00Z");
const PROVIDER_DATE = "Thu, 01 Jan 2026 00:00:00 GMT";

function row(year, day, region = "global") {
    return { year, month: 1, day, region, name: `Observance ${day}`, flags: [] };
}

function cachePair(initial = [row(2026, 1)]) {
    const { HolidayCacheRepository, HolidayCache } = loadHolidays();
    const create = () => {
        const repository = new HolidayCacheRepository("/holidays.json", { now: () => NOW });
        const cache = new HolidayCache((country, done) => repository.loadAsync(country, done),
            (country, data) => repository.save(country, data));
        cache.setPlace("usa", "global");
        return cache;
    };
    const first = create();
    first.recordFetch(2026, "global", PROVIDER_DATE, initial,
        new Date(NOW - 3600000).toISOString());
    first.persist(new Date(NOW));
    return [first, create()];
}

function persistFetch(cache, year, region, rows, received = NOW) {
    cache.recordFetch(year, region, PROVIDER_DATE, rows, new Date(received).toISOString());
    cache.persist(new Date(NOW));
}

function stored() {
    return JSON.parse(fs.readFileSync(cachePath("holidays.json"), "utf8")).usa;
}

function delayedPublications() {
    const gio = global.imports.gi.Gio;
    const createFile = gio.file_new_for_path;
    const publications = [];
    const reads = [];
    gio.file_new_for_path = (filename) => {
        const file = createFile(filename);
        const publish = file.replace_contents_async.bind(file);
        const read = file.load_contents_async.bind(file);
        file.load_contents_async = (...args) => {
            reads.push(filename);
            read(...args);
        };
        file.replace_contents_async = (...args) => publications.push(() => publish(...args));
        return file;
    };
    return { publications, reads };
}

function snapshot(year = 2026) {
    return { years: { [year]: { global: PROVIDER_DATE } }, holidays: [row(year, 1)],
        updates: [{ year, region: "global", received: new Date(NOW).toISOString() }] };
}

test("independent repositories serialize reads through completed publication", () => {
    const { HolidayCacheRepository } = loadHolidays();
    fs.mkdirSync(cachePath(), { recursive: true });
    fs.writeFileSync(cachePath("holidays.json"), "{}");
    const { publications, reads } = delayedPublications();
    const first = new HolidayCacheRepository("/holidays.json", { now: () => NOW });
    const second = new HolidayCacheRepository("/holidays.json", { now: () => NOW });
    first.save("usa", snapshot());
    second.save("ita", snapshot());
    first.save("usa", snapshot(2027));
    second.release();
    assert.equal(reads.length, 1, "later writers cannot read an unpublished snapshot");
    assert.equal(publications.length, 1, "only one replacement stream may be open");
    while (publications.length) publications.shift()();
    const disk = JSON.parse(fs.readFileSync(cachePath("holidays.json"), "utf8"));
    assert.deepEqual(Object.keys(disk).sort(), ["ita", "usa"]);
    assert.deepEqual(disk.usa.holidays.map((event) => event.year), [2026, 2027]);
    assert.deepEqual(second._pending, {});
    assert.equal(second._all, null, "release does not retain the merged snapshot");
});

test("cache transactions on different files proceed independently", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const { publications } = delayedPublications();
    for (const filename of ["/holidays.json", "/regional.json"]) {
        new HolidayCacheRepository(filename, { now: () => NOW }).save("usa", snapshot());
    }
    assert.equal(publications.length, 2);
    while (publications.length) publications.shift()();
});

test("first creation hides partial bytes from readers and preserves both creators", () => {
    const { HolidayCacheRepository } = loadHolidays();
    const { publications, reads } = delayedPublications();
    const first = new HolidayCacheRepository("/holidays.json", { now: () => NOW });
    const reader = new HolidayCacheRepository("/holidays.json", { now: () => NOW });
    const second = new HolidayCacheRepository("/holidays.json", { now: () => NOW });
    first.save("usa", snapshot());
    fs.writeFileSync(cachePath("holidays.json"), '{"usa":', "utf8");
    let loaded;
    reader.loadAsync("usa", (data) => { loaded = data; });
    second.save("ita", snapshot());
    assert.equal(loaded, undefined, "a reader waits while the initial target is incomplete");
    assert.equal(reads.length, 0, "neither a reader nor a later writer loads partial bytes");
    publications.shift()();
    assert.deepEqual(loaded.holidays, snapshot().holidays);
    publications.shift()();
    const disk = JSON.parse(fs.readFileSync(cachePath("holidays.json"), "utf8"));
    assert.deepEqual(Object.keys(disk).sort(), ["ita", "usa"]);
    assert.deepEqual(first._pending, {});
    assert.deepEqual(second._pending, {});
});

test("a throwing cache reader cannot strand the next queued update", () => {
    loadHolidays();
    const io = require(ioUtilsPath);
    const { publications } = delayedPublications();
    fs.mkdirSync(cachePath(), { recursive: true });
    const file = global.imports.gi.Gio.file_new_for_path(cachePath("holidays.json"));
    io.updateJsonFileAsync(file, () => ({ first: true }), () => {});
    let reads = 0;
    io.readJsonFileAsync(file, () => { reads++; throw new Error("reader"); });
    io.updateJsonFileAsync(file, (data) => ({ ...data, second: true }), () => {});
    publications.shift()();
    publications.shift()();
    assert.equal(reads, 1, "a throwing callback is never redelivered");
    assert.deepEqual(JSON.parse(fs.readFileSync(file.get_path(), "utf8")), { first: true, second: true });
});

test("a failed transform releases its transaction for the next update", () => {
    loadHolidays();
    const io = require(ioUtilsPath);
    const file = global.imports.gi.Gio.file_new_for_path(cachePath("holidays.json"));
    fs.mkdirSync(cachePath(), { recursive: true });
    let completed = 0;
    io.updateJsonFileAsync(file, () => { throw new Error("bad snapshot"); }, () => completed++);
    io.updateJsonFileAsync(file, () => ({ healthy: true }), () => completed++);
    assert.equal(completed, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(file.get_path(), "utf8")), { healthy: true });
});

test("a throwing completion still releases the next queued transaction", () => {
    loadHolidays();
    const io = require(ioUtilsPath);
    const { publications } = delayedPublications();
    fs.mkdirSync(cachePath(), { recursive: true });
    const file = global.imports.gi.Gio.file_new_for_path(cachePath("holidays.json"));
    io.updateJsonFileAsync(file, () => ({ first: true }), () => { throw new Error("completion"); });
    io.updateJsonFileAsync(file, (data) => ({ ...data, second: true }), () => {});
    assert.throws(() => publications.shift()(), /completion/);
    publications.shift()();
    assert.deepEqual(JSON.parse(fs.readFileSync(file.get_path(), "utf8")), { first: true, second: true });
});

test("an independent year update preserves another instance's corrected dates", () => {
    const [first, second] = cachePair();
    persistFetch(second, 2026, "global", [row(2026, 2)], NOW - 1000);
    persistFetch(first, 2027, "global", [row(2027, 3)]);
    assert.deepEqual(stored().holidays, [row(2026, 2), row(2027, 3)]);
});

test("independent regions remain complete when their instances save stale country views", () => {
    const [first, second] = cachePair();
    persistFetch(second, 2026, "ny", [row(2026, 2, "ny")], NOW - 1000);
    persistFetch(first, 2026, "ca", [row(2026, 3, "ca")]);
    assert.deepEqual(stored().holidays, [row(2026, 1), row(2026, 2, "ny"), row(2026, 3, "ca")]);
});

test("an explicitly empty corrected snapshot remains empty after an unrelated save", () => {
    const [first, second] = cachePair();
    persistFetch(second, 2026, "global", [], NOW - 1000);
    persistFetch(first, 2027, "global", [row(2027, 3)]);
    assert.deepEqual(stored().holidays, [row(2027, 3)]);
    assert.equal(stored().years[2026].global, PROVIDER_DATE,
        "an empty complete snapshot retains its independent freshness");
});

test("a late write cannot replace a snapshot received more recently", () => {
    const [first, second] = cachePair();
    persistFetch(second, 2026, "global", [row(2026, 2)], NOW - 1000);
    persistFetch(first, 2026, "global", [row(2026, 3)], NOW - 2000);
    assert.deepEqual(stored().holidays, [row(2026, 2)]);
});

test("invalid update descriptors cannot overwrite a healthy snapshot", () => {
    cachePair();
    const { HolidayCacheRepository } = loadHolidays();
    const repository = new HolidayCacheRepository("/holidays.json", { now: () => NOW });
    const update = { year: 2026, region: "global", received: new Date(NOW).toISOString() };
    const invalid = [null, { ...update, year: 0 }, { ...update, region: 3 },
        { ...update, region: "__proto__" }, { ...update, received: "invalid" },
        { ...update, received: new Date(NOW + 1).toISOString() }];
    repository.save("usa", { years: {}, holidays: [row(2026, 3)], updates: invalid });
    assert.deepEqual(stored().holidays, [row(2026, 1)]);
    assert.throws(() => repository.save("usa", { years: {}, holidays: [] }),
        /explicit snapshot updates/);
});

test("equal receipt times use write order and cleared caches forget pending updates", () => {
    const [first, second] = cachePair();
    persistFetch(second, 2026, "global", [row(2026, 2)]);
    persistFetch(first, 2026, "global", [row(2026, 3)]);
    assert.deepEqual(stored().holidays, [row(2026, 3)]);
    first.recordFetch(2026, "ny", PROVIDER_DATE, [row(2026, 4, "ny")]);
    first.clearPlace();
    first.setPlace("usa", "global");
    first.persist(new Date(NOW));
    assert.deepEqual(stored().holidays, [row(2026, 3)], "clearing a place drops unsaved descriptors");
});
