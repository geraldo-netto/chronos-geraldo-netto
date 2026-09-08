const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { makeRandom } = require("./helpers/prng");

const modulePath = path.join(__dirname, "..", "files", "chronos@geraldo-netto", "astronomy.js");
const Astronomy = require(modulePath);
const MINUTE_MS = 60000;

function minutesFrom(timestamp, expected) {
    return Math.abs(timestamp - expected) / MINUTE_MS;
}

test("astronomy input bounds reject malformed coordinates and civil days", () => {
    assert.equal(Astronomy.ASTRONOMY_DAY_MS, 86400000);
    assert.equal(Astronomy.ASTRONOMY_SAMPLE_MS, 20 * MINUTE_MS);
    assert.equal(Astronomy.ASTRONOMY_MAX_DAY_MS, 26 * 60 * MINUTE_MS);

    for (const [latitude, longitude] of [[-90, -180], [0, 0], [90, 180]]) {
        assert.equal(Astronomy.validCoordinates(latitude, longitude), true);
    }
    for (const pair of [[-90.1, 0], [90.1, 0], [0, -180.1], [0, 180.1],
        ["41", 12], [41, "12"], [NaN, 0], [0, Infinity]]) {
        assert.equal(Astronomy.validCoordinates(pair[0], pair[1]), false);
    }

    assert.equal(Astronomy.validDayBounds(0, 1), true);
    assert.equal(Astronomy.validDayBounds(0, Astronomy.ASTRONOMY_MAX_DAY_MS), true);
    for (const bounds of [[0, 0], [1, 0], [0, Astronomy.ASTRONOMY_MAX_DAY_MS + 1],
        [NaN, 1], [0, Infinity]]) {
        assert.equal(Astronomy.validDayBounds(bounds[0], bounds[1]), false);
    }
});

test("coordinate helpers return finite positions and expected reference angles", () => {
    assert.equal(Astronomy.julianDays(Date.UTC(2000, 0, 1, 12)), 0);
    assert.ok(Math.abs(Astronomy.rightAscension(0, 0)) < 1e-12);
    assert.ok(Math.abs(Astronomy.declination(0, 0)) < 1e-12);
    assert.ok(Math.abs(Astronomy.altitude(0, 0, 0) - Math.PI / 2) < 1e-12);
    assert.ok(Number.isFinite(Astronomy.siderealTime(1, 0.2)));
    assert.ok(Number.isFinite(Astronomy.solarMeanAnomaly(1)));
    assert.ok(Number.isFinite(Astronomy.solarEclipticLongitude(1)));

    for (const coordinates of [Astronomy.sunCoordinates(0), Astronomy.moonCoordinates(0)]) {
        assert.ok(Number.isFinite(coordinates.rightAscension));
        assert.ok(Number.isFinite(coordinates.declination));
    }
    const noon = Date.UTC(2026, 2, 20, 12);
    assert.ok(Number.isFinite(Astronomy.bodyAltitude(noon, 41.9, 12.48,
        Astronomy.sunCoordinates)));
    assert.ok(Number.isFinite(Astronomy.sunAltitude(noon, 41.9, 12.48)));
    assert.ok(Number.isFinite(Astronomy.moonAltitude(noon, 41.9, 12.48)));
});

test("unsupported absolute instants cannot enter the astronomy sampler", () => {
    const huge = 2 ** 74;
    assert.equal(huge + Astronomy.ASTRONOMY_SAMPLE_MS, huge);
    const outside = [[huge, huge + 2 ** 22], [-huge, -huge + 2 ** 22],
        [8.64e15, 8.64e15 + 1], [-8.64e15 - 1, -8.64e15],
        [0n, 1], [Symbol("timestamp"), 1], ["0", 1]];
    for (const [start, end] of outside) {
        // Fail before entering the sampler if a future guard regresses.
        assert.equal(Astronomy.validDayBounds(start, end), false);
        assert.equal(Astronomy.calculateAstronomyEvents(start, end, 0, 0), null);
    }
});

test("supported Date limits still produce bounded finite astronomy events", () => {
    const random = makeRandom(20260908);
    const maximum = 8.64e15;
    const span = Astronomy.ASTRONOMY_DAY_MS;
    const starts = [-maximum, maximum - span];
    for (let sample = 0; sample < 128; sample++)
        starts.push(Math.floor(random() * (2 * maximum - span) - maximum));
    for (const start of starts) {
        const result = Astronomy.calculateAstronomyEvents(start, start + span, 0, 0);
        assert.ok(result);
        for (const body of [result.sun, result.moon]) {
            for (const event of [body.rise, body.set])
                assert.ok(event === null || (Number.isFinite(event) && event >= start && event <= start + span));
        }
    }
});

test("crossing helpers classify and refine each horizon transition", () => {
    assert.equal(Astronomy.crossingDirection(-1, 0), "rise");
    assert.equal(Astronomy.crossingDirection(-1, 1), "rise");
    assert.equal(Astronomy.crossingDirection(1, 0), "set");
    assert.equal(Astronomy.crossingDirection(1, -1), "set");
    assert.equal(Astronomy.crossingDirection(0, 1), "");
    assert.equal(Astronomy.crossingDirection(1, 1), "");

    const line = (timestamp) => timestamp - 500;
    const crossing = Astronomy.refineCrossing(0, 1000, -500, line,
        { latitude: 0, longitude: 0, threshold: 0 });
    assert.ok(Math.abs(crossing - 500) <= 1);

    assert.equal(Astronomy.horizonState(1, null, -1, 1), "normal");
    assert.equal(Astronomy.horizonState(null, 1, -1, 1), "normal");
    assert.equal(Astronomy.horizonState(null, null, 1, 2), "alwaysUp");
    assert.equal(Astronomy.horizonState(null, null, -2, -1), "alwaysDown");
    assert.equal(Astronomy.horizonState(null, null, -1, 1), "normal");

    const events = { rise: null, set: null };
    Astronomy.recordCrossing(events, "rise", 10);
    Astronomy.recordCrossing(events, "rise", 20);
    Astronomy.recordCrossing(events, "set", 30);
    Astronomy.recordCrossing(events, "set", 40);
    Astronomy.recordCrossing(events, "other", 50);
    assert.deepEqual(events, { rise: 10, set: 30 });
});

test("the generic sampler finds a rise and set without leaving the requested day", () => {
    const start = 0;
    const end = 4 * 60 * MINUTE_MS;
    const wave = (timestamp) => -Math.cos(2 * Math.PI * timestamp / end);
    const events = Astronomy.altitudeEvents(start, end, 0, 0, wave, 0);

    assert.equal(events.state, "normal");
    assert.ok(minutesFrom(events.rise, 60 * MINUTE_MS) < 0.1);
    assert.ok(minutesFrom(events.set, 3 * 60 * MINUTE_MS) < 0.1);

    const shortDay = 20 * MINUTE_MS;
    const hiddenTrough = (timestamp) =>
        Math.pow((timestamp - shortDay / 2) / (6 * MINUTE_MS), 2) - 1;
    const troughEvents = Astronomy.altitudeEvents(0, shortDay, 0, 0, hiddenTrough, 0);
    assert.equal(troughEvents.state, "normal");
    assert.ok(minutesFrom(troughEvents.set, 4 * MINUTE_MS) < 0.1);
    assert.ok(minutesFrom(troughEvents.rise, 16 * MINUTE_MS) < 0.1);
});

test("Rome results track the US Naval Observatory within low-precision tolerances", () => {
    // USNO Complete Sun and Moon Data for 2026-03-05, Rome (41.9 N, 12.48 E):
    // Sun 06:39/18:05, Moon 20:29/07:19 in Europe/Rome (UTC+1).
    const start = Date.parse("2026-03-05T00:00:00+01:00");
    const end = Date.parse("2026-03-06T00:00:00+01:00");
    const events = Astronomy.calculateAstronomyEvents(start, end, 41.9, 12.48);
    const expected = {
        sunrise: Date.parse("2026-03-05T06:39:00+01:00"),
        sunset: Date.parse("2026-03-05T18:05:00+01:00"),
        moonrise: Date.parse("2026-03-05T20:29:00+01:00"),
        moonset: Date.parse("2026-03-05T07:19:00+01:00")
    };

    assert.equal(events.sun.state, "normal");
    assert.equal(events.moon.state, "normal");
    assert.ok(minutesFrom(events.sun.rise, expected.sunrise) <= 2);
    assert.ok(minutesFrom(events.sun.set, expected.sunset) <= 2);
    assert.ok(minutesFrom(events.moon.rise, expected.moonrise) <= 15);
    assert.ok(minutesFrom(events.moon.set, expected.moonset) <= 15);
});

test("polar days and nights are explicit results rather than invented times", () => {
    const summerStart = Date.UTC(2026, 5, 21);
    const winterStart = Date.UTC(2026, 11, 21);
    const summer = Astronomy.calculateAstronomyEvents(
        summerStart, summerStart + Astronomy.ASTRONOMY_DAY_MS, 78.2232, 15.6469);
    const winter = Astronomy.calculateAstronomyEvents(
        winterStart, winterStart + Astronomy.ASTRONOMY_DAY_MS, 78.2232, 15.6469);

    assert.deepEqual(summer.sun, { rise: null, set: null, state: "alwaysUp" });
    assert.deepEqual(winter.sun, { rise: null, set: null, state: "alwaysDown" });
    assert.equal(winter.moon.state, "alwaysUp");
    assert.equal(Astronomy.calculateAstronomyEvents(0, 0, 0, 0), null);
    assert.equal(Astronomy.calculateAstronomyEvents(0, 1, 91, 0), null);
});

test("grazing solar and lunar crossings survive one coarse sample interval", () => {
    const cases = [
        {
            body: "sun", latitude: 68.2, date: "2026-01-05",
            rise: "2026-01-05T12:00:13.923Z", set: "2026-01-05T12:11:24.470Z"
        },
        {
            body: "moon", latitude: 61.6, date: "2026-01-16",
            rise: "2026-01-16T10:02:15.901Z", set: "2026-01-16T10:19:44.480Z"
        }
    ];

    for (const row of cases) {
        const start = Date.parse(row.date + "T00:00:00Z");
        const events = Astronomy.calculateAstronomyEvents(
            start, start + Astronomy.ASTRONOMY_DAY_MS, row.latitude, 0)[row.body];
        assert.equal(events.state, "normal");
        assert.ok(minutesFrom(events.rise, Date.parse(row.rise)) < 1);
        assert.ok(minutesFrom(events.set, Date.parse(row.set)) < 1);
    }
});

test("seeded observations always return bounded, finite event timestamps", () => {
    const random = makeRandom(20260804);
    const start = Date.UTC(2026, 0, 1);

    for (let sample = 0; sample < 200; sample++) {
        const day = Math.floor(random() * 365);
        const dayStart = start + day * Astronomy.ASTRONOMY_DAY_MS;
        const latitude = random() * 180 - 90;
        const longitude = random() * 360 - 180;
        const result = Astronomy.calculateAstronomyEvents(
            dayStart, dayStart + Astronomy.ASTRONOMY_DAY_MS, latitude, longitude);

        for (const body of [result.sun, result.moon]) {
            assert.ok(["normal", "alwaysUp", "alwaysDown"].includes(body.state));
            for (const event of [body.rise, body.set]) {
                assert.ok(event === null ||
                    (Number.isFinite(event) && event >= dayStart &&
                        event <= dayStart + Astronomy.ASTRONOMY_DAY_MS));
            }
        }
    }
});
