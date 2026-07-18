const {
    assert, test, makeRandom, STAMP, NAGER_STAMP, OPENHOLIDAYS_STAMP,
    holidayConstantsPath, holidayRecordPath, holidayServiceAdaptersPath,
    loadHolidays, anyRecord
} = require("./helpers/holidayFixture");

test("every country the settings offer can reach the fallback providers", () => {
    const { SUPPORTED_COUNTRIES, COUNTRY_TO_ISO2 } = require(holidayConstantsPath);

    // a country in the combobox with no ISO code cannot be asked of either
    // fallback provider: if HolidayService is down it simply has no holidays, silently
    const unreachable = SUPPORTED_COUNTRIES.filter((country) => !COUNTRY_TO_ISO2[country]);

    assert.deepEqual(unreachable, []);
});

test("Argentina and Bulgaria have explicit fallback-provider coverage", () => {
    const { COUNTRY_TO_ISO2, OPEN_HOLIDAYS_COUNTRIES } = require(holidayConstantsPath);
    const { NagerDateServiceAdapter, OpenHolidaysServiceAdapter } = loadHolidays();
    const nager = new NagerDateServiceAdapter(() => {});
    const open = new OpenHolidaysServiceAdapter(() => {});

    assert.equal(COUNTRY_TO_ISO2.arg, "AR");
    assert.equal(COUNTRY_TO_ISO2.bgr, "BG");
    assert.equal(nager.countryCode("arg"), "AR");
    assert.equal(nager.countryCode("bgr"), "BG");
    assert.equal(open.countryCode("arg"), null,
        "OpenHolidays does not advertise Argentina, so Nager remains its fallback");
    assert.equal(open.countryCode("bgr"), "BG");
    assert.equal(OPEN_HOLIDAYS_COUNTRIES.bgr, true);
});

test("tzdata ISO2 countries map back to holiday country identifiers", () => {
    const {
        SUPPORTED_COUNTRIES,
        COUNTRY_TO_ISO2,
        ISO2_TO_COUNTRY,
        countryFromIso2
    } = require(holidayConstantsPath);

    for (const country of SUPPORTED_COUNTRIES) {
        const iso2 = COUNTRY_TO_ISO2[country];
        assert.equal(ISO2_TO_COUNTRY[iso2], country);
        assert.equal(countryFromIso2(iso2.toLowerCase()), country);
    }

    assert.equal(countryFromIso2(" IT "), "ita");
    assert.equal(countryFromIso2("SK"), "svk");
    assert.equal(countryFromIso2("ME"), "mne");
    assert.equal(countryFromIso2("SM"), "",
        "a valid tzdata country with no holiday provider stays unsupported");
    assert.equal(countryFromIso2("ZZ"), "");
    assert.equal(countryFromIso2(null), "");
});

test("fuzz: ISO2 holiday mapping accepts only supported normalized codes", () => {
    const {
        SUPPORTED_COUNTRIES,
        ISO2_TO_COUNTRY,
        countryFromIso2
    } = require(holidayConstantsPath);
    const rand = makeRandom(0x1502);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz 09_-\0";
    const supported = new Set(SUPPORTED_COUNTRIES);
    const knownCodes = Object.keys(ISO2_TO_COUNTRY);
    let mappedCount = 0;

    for (let round = 0; round < 500; round++) {
        const length = Math.floor(rand() * 8);
        const generated = Array.from({ length }, () =>
            alphabet[Math.floor(rand() * alphabet.length)]).join("");
        const known = knownCodes[Math.floor(rand() * knownCodes.length)];
        const decoratedKnown = rand() < 0.5 ? known.toLowerCase() : ` ${known} `;
        const candidates = [generated, decoratedKnown, null, undefined, 42, {}, [], true];
        const candidate = candidates[Math.floor(rand() * candidates.length)];
        const normalized = typeof candidate === "string" ? candidate.trim().toUpperCase() : "";
        const expected = ISO2_TO_COUNTRY[normalized] || "";
        const mapped = countryFromIso2(candidate);

        assert.equal(mapped, expected);
        assert.ok(mapped === "" || supported.has(mapped));
        mappedCount += Number(Boolean(mapped));
    }

    assert.ok(mappedCount > 0, "the fuzz corpus exercises accepted codes too");
});

test("NagerDateServiceAdapter maps HolidayService countries and regions", () => {
    const { NagerDateServiceAdapter } = loadHolidays();
    const { COUNTRY_TO_ISO2, REGION_TO_SUBDIVISION } = require(holidayConstantsPath);
    const adapter = new NagerDateServiceAdapter(() => {});

    assert.equal(adapter.countryCode("usa"), "US");
    assert.equal(adapter.countryCode("esp"), "ES");
    assert.equal(adapter.countryCode("isr"), "IL");
    assert.equal(adapter.countryCode("xkx"), "XK");
    assert.equal(adapter.countryCode("nowhere"), null);
    assert.equal(adapter.countyCode("usa", "ca"), "US-CA");
    assert.equal(adapter.countyCode("esp", "ex"), "ES-EX");
    assert.equal(adapter.countyCode("gbr", "sct"), "GB-SCT");
    assert.equal(adapter.countyCode("usa", "global"), null);
    assert.equal(COUNTRY_TO_ISO2.che, "CH");
    assert.equal(REGION_TO_SUBDIVISION.che.zh, "CH-ZH");

    const params = adapter.params("usa", "ca", 2026);
    assert.deepEqual(params, {
        year: 2026,
        country: "usa",
        region: "ca",
        countryCode: "US",
        countyCode: "US-CA"
    });
    assert.equal(adapter.url(params), "https://date.nager.at/api/v3/PublicHolidays/2026/US");
});

test("NagerDateServiceAdapter translates and filters Nager holidays", () => {
    const { HolidayRecordContract, NagerDateServiceAdapter } = loadHolidays();
    let capturedUrl = null;
    const adapter = new NagerDateServiceAdapter((url, params, callback) => {
        capturedUrl = url;
        callback([
            {
                date: "2026-01-01",
                localName: "Año Nuevo",
                name: "New Year's Day",
                global: true,
                counties: null,
                types: ["Public"]
            },
            {
                date: "2026-03-31",
                localName: "Cesar Chavez Day",
                name: "Cesar Chavez Day",
                counties: ["US-CA"],
                types: ["Public"]
            },
            {
                date: "2026-11-03",
                localName: "Election Day",
                name: "Election Day",
                counties: ["US-NY"],
                types: ["Public"]
            },
            {
                date: "not-a-date",
                name: "Bad Date",
                types: ["Public"]
            }
        ], params, "Mon, 01 Jan 2026 00:00:00 GMT");
    });
    let result = null;

    adapter.fetchYear("usa", "ca", 2026, (data, params, retrieved) => {
        result = { data, params, retrieved };
    });

    assert.equal(capturedUrl, "https://date.nager.at/api/v3/PublicHolidays/2026/US");
    assert.equal(result.retrieved, "Mon, 01 Jan 2026 00:00:00 GMT");
    assert.equal(result.data.length, 2);
    assert.deepEqual(result.data[0], {
        date: { year: 2026, month: 1, day: 1 },
        name: [
            { lang: "local", text: "Año Nuevo" },
            { lang: "en", text: "New Year's Day" }
        ],
        flags: ["public_holiday"]
    });
    assert.deepEqual(result.data[1].date, { year: 2026, month: 3, day: 31 });
    assert.equal(new HolidayRecordContract().validResponse(result.data), true);

    const globalRows = adapter.translateResponse([
        {
            date: "2026-07-04",
            localName: "Independence Day",
            name: "Independence Day",
            global: true,
            counties: ["US-CA"],
            types: ["Public"]
        },
        {
            date: "2026-09-01",
            name: "County Only",
            global: false,
            counties: ["US-CA"],
            types: ["Public"]
        }
    ], adapter.params("usa", "global", 2026));
    assert.deepEqual(globalRows.map((holiday) => holiday.name[0].text), ["Independence Day"]);
});

test("CalDaysServiceAdapter maps and normalizes nationwide holidays", () => {
    const {
        CalDaysServiceAdapter, HolidayRecordContract, HOLIDAY_ERRORS
    } = loadHolidays();
    const requests = [];
    const adapter = new CalDaysServiceAdapter((url, params, callback) => {
        requests.push(url);
        callback([
            { date: "2026-01-01", name: "New Year's Day", type: "national" },
            { date: "2026-05-18", name: "Joint Leave", type: "joint" },
            { date: "2026-06-01", name: "Unknown Region Day", type: "regional" },
            { date: "not-a-date", name: "Bad Date", type: "national" },
            { date: "2026-07-01", name: "", type: "national" },
            { date: "2026-08-01", name: "Observance", type: "optional" },
            { date: 20260802, name: "Numeric Date", type: "national" },
            { date: "2026-08-03", name: 42, type: "national" },
            [], "not an object", null
        ], params, STAMP);
    });
    let result = null;

    adapter.fetchYear("usa", "global", 2026, (data, params, retrieved) => {
        result = { data, params, retrieved };
    });

    assert.deepEqual(adapter.params("usa", "global", 2026), {
        year: 2026,
        country: "usa",
        region: "global",
        countryCode: "us"
    });
    assert.equal(adapter.url(adapter.params("usa", "global", 2026)),
        "https://api.caldays.com/v1/us/holidays/2026");
    assert.deepEqual(result.data, [
        {
            date: { year: 2026, month: 1, day: 1 },
            name: [{ lang: "en", text: "New Year's Day" }],
            flags: ["public_holiday"]
        },
        {
            date: { year: 2026, month: 5, day: 18 },
            name: [{ lang: "en", text: "Joint Leave" }],
            flags: ["public_holiday"]
        }
    ]);
    assert.equal(result.params.providerName, "caldays");
    assert.equal(result.retrieved, STAMP);
    assert.equal(new HolidayRecordContract().validResponse(result.data), true);
    assert.equal(requests.length, 1);

    const unavailable = [];
    adapter.fetchYear("usa", "ca", 2026, (data, params) => {
        unavailable.push([data, params]);
    });
    adapter.fetchYear("nowhere", "global", 2026, (data, params) => {
        unavailable.push([data, params]);
    });

    assert.equal(requests.length, 1, "ambiguous or unsupported places never reach caldays");
    assert.equal(unavailable[0][0].error, HOLIDAY_ERRORS.SERVICE_UNAVAILABLE);
    assert.equal(unavailable[0][1].countryCode, null);
    assert.equal(unavailable[1][0].error, HOLIDAY_ERRORS.SERVICE_UNAVAILABLE);
    assert.equal(adapter.countryCode("usa", "ca"), null);
    assert.equal(adapter.countryCode("nowhere", "global"), null);
});

test("fuzz: CalDays translation accepts only placeable nationwide rows", () => {
    const { CalDaysServiceAdapter, HolidayRecordContract } = loadHolidays();
    const adapter = new CalDaysServiceAdapter(() => {});
    const contract = new HolidayRecordContract("en");
    const params = adapter.params("usa", "global", 2030);
    const rand = makeRandom(0xca1da7);
    const junk = [
        null, [], "row", 42, {},
        { date: "2030-02-30", name: "Bad date", type: "national" },
        { date: "2030-01-01", name: "", type: "national" },
        { date: "2030-01-01", name: 42, type: "national" },
        { date: "2030-01-01", name: "Wrong type", type: "optional" },
        { date: "2030-01-01", name: "Local only", type: "regional" }
    ];
    let kept = 0;
    let dropped = 0;

    for (let round = 0; round < 300; round++) {
        const valid = {
            date: `2030-${String(1 + Math.floor(rand() * 12)).padStart(2, "0")}` +
                `-${String(1 + Math.floor(rand() * 28)).padStart(2, "0")}`,
            name: `Holiday ${round}`,
            type: rand() < 0.5 ? "national" : "joint"
        };
        const payload = [valid, junk[Math.floor(rand() * junk.length)]];
        const translated = adapter.translateResponse(payload, params);

        assert.equal(contract.validResponse(translated), true);
        assert.equal(translated.length, 1);
        assert.equal(translated[0].name[0].text, valid.name);
        assert.deepEqual(adapter.translateResponse(payload, params), translated);
        kept += translated.length;
        dropped += payload.length - translated.length;
    }

    assert.equal(kept, 300);
    assert.equal(dropped, 300);
});

test("OpenHolidaysServiceAdapter maps countries, regions, and localized holidays", () => {
    const { HolidayRecordContract, OpenHolidaysServiceAdapter } = loadHolidays();
    const { OPEN_HOLIDAYS_COUNTRIES } = require(holidayConstantsPath);
    let capturedUrl = null;
    const adapter = new OpenHolidaysServiceAdapter((url, params, callback) => {
        capturedUrl = url;
        callback([
            {
                startDate: "2026-01-01",
                endDate: "2026-01-01",
                type: "Public",
                name: [{ language: "EN", text: "New Year's Day" }],
                nationwide: true
            },
            {
                startDate: "2026-01-02",
                endDate: "2026-01-02",
                type: "Optional",
                name: [{ language: "EN", text: "Berchtold's Day" }],
                nationwide: false,
                subdivisions: [{ code: "CH-ZH", shortName: "ZH" }]
            },
            {
                startDate: "2026-01-06",
                type: "Public",
                name: [{ language: "EN", text: "Epiphany" }],
                nationwide: false,
                subdivisions: [{ code: "CH-TI", shortName: "TI" }]
            },
            {
                startDate: "not-a-date",
                type: "Public",
                name: [{ language: "EN", text: "Bad Date" }],
                nationwide: true
            }
        ], params, OPENHOLIDAYS_STAMP);
    }, "en_US");
    let result = null;

    assert.equal(adapter.countryCode("che"), "CH");
    assert.equal(adapter.countryCode("usa"), null);
    assert.equal(OPEN_HOLIDAYS_COUNTRIES.che, true);

    adapter.fetchYear("che", "zh", 2026, (data, params, retrieved) => {
        result = { data, params, retrieved };
    });

    assert.equal(
        capturedUrl,
        "https://openholidaysapi.org/PublicHolidays?countryIsoCode=CH&validFrom=2026-01-01&validTo=2026-12-31&languageIsoCode=EN&subdivisionCode=CH-ZH"
    );
    assert.equal(result.retrieved, OPENHOLIDAYS_STAMP);
    assert.equal(result.data.length, 2);
    assert.deepEqual(result.data[0], {
        date: { year: 2026, month: 1, day: 1 },
        name: [{ lang: "en", text: "New Year's Day" }],
        flags: ["public_holiday"]
    });
    assert.deepEqual(result.data[1], {
        date: { year: 2026, month: 1, day: 2 },
        name: [{ lang: "en", text: "Berchtold's Day" }],
        flags: ["optional"]
    });
    assert.equal(new HolidayRecordContract().validResponse(result.data), true);

    const globalParams = adapter.params("che", "global", 2026);
    const globalRows = adapter.translateResponse([
        {
            startDate: "2026-05-01",
            endDate: "2026-05-03",
            type: "Public",
            name: [{ language: "EN", text: "May Holiday" }],
            nationwide: true,
            subdivisions: [{ code: "CH-ZH", shortName: "ZH" }]
        },
        {
            startDate: "2026-06-01",
            type: "Public",
            name: [{ language: "EN", text: "Canton Holiday" }],
            nationwide: false,
            subdivisions: [{ code: "CH-ZH", shortName: "ZH" }]
        }
    ], globalParams);

    assert.equal(adapter.url(globalParams).includes("subdivisionCode"), false);
    assert.deepEqual(globalRows, [{
        date: { year: 2026, month: 5, day: 1 },
        name: [{ lang: "en", text: "May Holiday" }],
        flags: ["public_holiday"],
        dateTo: { year: 2026, month: 5, day: 3 }
    }]);
});

test("OpenHolidaysServiceAdapter translates dates and subdivisions", () => {
    const { OpenHolidaysServiceAdapter } = loadHolidays();
    const adapter = new OpenHolidaysServiceAdapter(() => {}, "en");
    const params = adapter.params("che", "fr", 2030);
    const payload = [];

    for (let i = 0; i < 40; i++) {
        const month = 1 + (i % 12);
        const day = 1 + (i % 27);
        payload.push({
            startDate: `2030-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
            type: i % 2 === 0 ? "Public" : "Optional",
            name: [{ language: "EN", text: `Holiday ${i}` }],
            nationwide: false,
            subdivisions: [{ code: `CH-FR-LA-${i}`, shortName: "FR" }]
        });
    }
    payload.push({
        startDate: "2030-01-01",
        type: "Public",
        name: [{ language: "EN", text: "Other Canton" }],
        nationwide: false,
        subdivisions: [{ code: "CH-TI", shortName: "TI" }]
    });

    const translated = adapter.translateResponse(payload, params);

    assert.equal(params.subdivisionCode, "CH-FR");
    assert.equal(translated.length, 40);
    assert.equal(translated[0].flags[0], "public_holiday");
    assert.equal(translated[1].flags[0], "optional");
    for (const holiday of translated) {
        assert.equal(holiday.date.year, 2030);
        assert.equal(holiday.name[0].lang, "en");
    }
});

// A real one, over the same adapter: the old test built 40 perfectly well-formed
// rows and asserted translated.length === 40 — that *nothing* was rejected — so
// it exercised no rejection path at all. OpenHolidays is the second provider in
// the chain and its body is untrusted, so what matters is what it refuses.
// The OpenHolidays wire shape, as the service might send it: usually usable,
// often not. The tables live out here so the body below is a loop and an assert.
const OPEN_HOLIDAYS_JUNK_DATES = [
    "2030-13-01", "2030-00-10", "2030-02-30", "not-a-date", "", null, 42,
    "2030-1-1", "20300101", "2030-01-01T00:00:00Z", undefined, {}
];
const OPEN_HOLIDAYS_JUNK_NAMES = [
    [], null, undefined, "a string", [{}], [{ language: "EN" }],
    [{ text: "no language" }], 42
];

function pickFrom(rand, list) {
    return list[Math.floor(rand() * list.length)];
}

function fuzzOpenHolidaysRow(rand, index) {
    const wellFormed = rand() < 0.5;
    const month = 1 + Math.floor(rand() * 12);
    const day = 1 + Math.floor(rand() * 28);

    return {
        startDate: wellFormed ?
            `2030-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` :
            pickFrom(rand, OPEN_HOLIDAYS_JUNK_DATES),
        type: rand() < 0.5 ? "Public" : pickFrom(rand, ["Optional", "Bank", "", null]),
        name: wellFormed && rand() < 0.8 ?
            [{ language: "EN", text: `Holiday ${index}` }] :
            pickFrom(rand, OPEN_HOLIDAYS_JUNK_NAMES),
        nationwide: rand() < 0.3,
        subdivisions: rand() < 0.7 ?
            [{ code: "CH-FR", shortName: "FR" }] : [{ code: "CH-TI", shortName: "TI" }]
    };
}

// Every row the adapter kept must be one the calendar can actually place: a real
// date in the requested year, a name to show, and flags the annotator understands.
// This is a property of the row, not a second copy of the adapter's rules — an
// oracle that mirrors the code under test agrees with it even when both are wrong.
// what a translated Nager row has to be: a real date, lowercase flags (the
// annotator matches on them), and a name in English to fall back on
function assertPlaceableNagerHoliday(holiday) {
    const { year, month, day } = holiday.date;
    const probe = new Date(year, month - 1, day, 12);
    assert.equal(probe.getFullYear(), year);
    assert.equal(probe.getMonth(), month - 1);
    assert.equal(probe.getDate(), day);

    holiday.flags.forEach((flag) => assert.equal(flag, flag.toLowerCase()));
    assert.ok(holiday.flags.length > 0, "empty types default to public");
    assert.ok(holiday.name.length >= 1);
    assert.equal(holiday.name.at(-1).lang, "en");
}

function assertPlaceableHoliday(holiday) {
    assert.equal(holiday.date.year, 2030);
    assert.ok(holiday.date.month >= 1 && holiday.date.month <= 12,
        `month out of range: ${holiday.date.month}`);
    assert.ok(holiday.date.day >= 1 && holiday.date.day <= 31,
        `day out of range: ${holiday.date.day}`);
    assert.ok(Array.isArray(holiday.name) && holiday.name.length > 0);
    assert.ok(holiday.name.every((entry) => typeof entry.text === "string" && entry.text),
        "a holiday with no name cannot be shown");
    assert.ok(Array.isArray(holiday.flags) && holiday.flags.length > 0);
    assert.ok(holiday.flags.every((flag) => typeof flag === "string"));
}

test("fuzz: OpenHolidays translation keeps only rows it can actually place", () => {
    const { OpenHolidaysServiceAdapter } = loadHolidays();
    const adapter = new OpenHolidaysServiceAdapter(() => {}, "en");
    const params = adapter.params("che", "fr", 2030);
    const rand = makeRandom(0x0f00d);
    let kept = 0;
    let dropped = 0;

    for (let round = 0; round < 300; round++) {
        const payload = Array.from({ length: 1 + Math.floor(rand() * 8) },
            (_unused, index) => fuzzOpenHolidaysRow(rand, index));

        let translated = null;
        assert.doesNotThrow(() => {
            translated = adapter.translateResponse(payload, params);
        }, JSON.stringify(payload).slice(0, 200));

        // Properties, not a reimplementation of the adapter's own rules: an
        // oracle that mirrors the code under test agrees with it even when both
        // are wrong.
        //
        // Every row it kept must be one the calendar can actually place — a real
        // date in the requested year, a name to show, and flags the annotator
        // understands — and it must never keep more rows than it was given.
        translated.forEach(assertPlaceableHoliday);

        assert.ok(translated.length <= payload.length, "it cannot invent rows");
        kept += translated.length;
        dropped += payload.length - translated.length;

        // the same body twice answers the same way: translation is a function of
        // its input, not of what came before it
        assert.deepEqual(adapter.translateResponse(payload, params), translated);
    }

    // a corpus that never triggered a rejection would satisfy everything above
    // and prove nothing — which is exactly what the test this replaces did
    assert.ok(kept > 0, "some rows must survive");
    assert.ok(dropped > 0, "and some must be rejected");
});

// The primary provider's wire shape, junk and all. The date tables carry every way
// a date can be wrong — out-of-range months, a February 30th, strings where numbers
// belong — and the spans carry one that would run the expansion loop for a
// thousand years.
const RECORD_JUNK_DATES = [
    null, undefined, 42, "2030-01-01", {}, { year: 2030 },
    { year: 2030, month: 13, day: 1 }, { year: 2030, month: 1, day: 40 },
    { year: 2030, month: 0, day: 0 }, { year: "2030", month: "1", day: "1" },
    { year: 9999, month: 12, day: 31 }, { year: -1, month: 1, day: 1 },
    { year: 2030, month: 2, day: 30 }
];
const RECORD_JUNK_NAMES = [
    null, undefined, [], "text", 42, [{}], [{ lang: "de" }], [{ text: "no lang" }],
    [{ lang: 42, text: "wrong type" }], [{ lang: "de", text: "Tag der Arbeit" }]
];
const RECORD_JUNK_FLAGS = [null, "text", 42, {}];

function fuzzHolidayRecord(rand) {
    const wellFormed = rand() < 0.5;
    const month = 1 + Math.floor(rand() * 12);
    const day = 1 + Math.floor(rand() * 28);

    const holiday = {
        date: wellFormed ?
            { year: 2030, month, day } : pickFrom(rand, RECORD_JUNK_DATES),
        name: wellFormed && rand() < 0.85 ?
            [{ lang: "de", text: "Feiertag" }, { lang: "en", text: "Holiday" }] :
            pickFrom(rand, RECORD_JUNK_NAMES),
        flags: rand() < 0.85 ? ["public_holiday"] : pickFrom(rand, RECORD_JUNK_FLAGS)
    };

    if (rand() < 0.4) {
        holiday.dateTo = rand() < 0.5 ?
            { year: 2030, month, day: Math.min(28, day + Math.floor(rand() * 5)) } :
            pickFrom(rand, [
                { year: 3030, month: 12, day: 31 },
                { year: 2029, month: 1, day: 1 },
                { year: 2030, month, day }
            ]);
    }

    return holiday;
}

// The interlock: whatever validHoliday let through, expandHoliday has to expand
// without running away — its `while (iter < limit)` is bounded only because
// validHoliday is supposed to have rejected the oversized spans first. Returns the
// rows it expanded to, so the caller can insist that some payloads really did span.
function assertExpandsSafely(record, holiday, maxSpanDays) {
    let days = null;
    assert.doesNotThrow(() => {
        days = record.expandHoliday(holiday, "global");
    }, JSON.stringify(holiday));

    assert.ok(days.length >= 1, "a holiday is at least one day");
    assert.ok(days.length <= maxSpanDays + 1,
        `the expansion is bounded: ${days.length} days from ${JSON.stringify(holiday)}`);

    days.forEach((single) => {
        assert.ok(Number.isInteger(single.year));
        assert.ok(single.month >= 1 && single.month <= 12);
        assert.ok(single.day >= 1 && single.day <= 31);
        assert.equal(typeof single.name, "string");
        assert.ok(single.name.length > 0, "a holiday with no name cannot be shown");
        assert.equal(single.region, "global");
    });

    // the localized name is one the payload actually carried, and it prefers the
    // user's language (de) over English
    const localized = record.localizeName(holiday);
    assert.ok(holiday.name.map((entry) => entry.text).includes(localized),
        "the name shown must be a name that was sent");

    const german = holiday.name.find((entry) => entry.lang === "de");
    assert.equal(german ? localized : german, german ? german.text : german,
        "a German user gets the German name");

    return days.length;
}

// HolidayService is the *primary* provider: it parses first for every user with holidays
// on, and it was the one untrusted-JSON parser with no fuzz harness at all. The
// interlock that matters here is between validHoliday and expandHoliday —
// expandHoliday's `while (iter < limit)` is bounded only because validHoliday is
// supposed to have rejected oversized spans first, and nothing ever tested the
// two together.
test("fuzz: HolidayService's parser cannot be made to run away or return junk", () => {
    const { HolidayRecordContract } = loadHolidays();
    const { MAX_HOLIDAY_SPAN_DAYS } = require(holidayRecordPath);
    // the parser under fuzz is the record contract's; adapters normalize into
    // this shape before the chain asks the contract whether it can be used
    const record = new HolidayRecordContract("de");
    const rand = makeRandom(0xe27100);

    let accepted = 0;
    let rejected = 0;
    let expandedRows = 0;

    for (let round = 0; round < 400; round++) {
        const holiday = fuzzHolidayRecord(rand);

        if (!record.validHoliday(holiday)) {
            rejected++;
            continue;
        }

        accepted++;
        expandedRows += assertExpandsSafely(record, holiday, MAX_HOLIDAY_SPAN_DAYS);
    }

    // validResponse is the gate the whole chain leans on: one bad row must
    // condemn the body, not slip through with the good ones
    assert.equal(record.validResponse([
        { date: { year: 2030, month: 1, day: 1 }, name: [{ lang: "de", text: "x" }], flags: [] },
        { date: "broken", name: [], flags: [] }
    ]), false);
    assert.equal(record.validResponse("not an array"), false);
    assert.equal(record.validResponse([]), true, "an empty year is a valid answer");

    assert.ok(accepted > 0, "some payloads must be accepted");
    assert.ok(rejected > 0, "and some must be rejected");
    assert.ok(expandedRows > accepted, "and some must be multi-day spans");
});

// T78: seeded fuzz over the Nager payload shape — translation must drop
// malformed dates, respect county matching and normalize flags, and the
// second pass over identical input must agree with the first
// Nager's wire shape. Months run to 14 and days to 33, so the corpus carries every
// kind of impossible date, and a slice of the rows use slashes instead of dashes.
function fuzzNagerRow(rand, index) {
    const month = 1 + Math.floor(rand() * 14);      // 13/14 are invalid
    const day = 1 + Math.floor(rand() * 33);        // up to 33: overflow days
    const countyRoll = rand();

    return {
        date: rand() < 0.15 ?
            `2030/${month}/${day}` :
            `2030-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        name: `Holiday ${index}`,
        localName: rand() < 0.5 ? `Feriado ${index}` : `Holiday ${index}`,
        global: rand() < 0.2,
        counties: countyRoll < 0.4 ? ["US-CA"] :
            countyRoll < 0.6 ? ["US-TX"] :
                countyRoll < 0.8 ? [] : ["US-TX", "US-CA"],
        types: rand() < 0.5 ? ["Public"] : (rand() < 0.5 ? ["Optional"] : [])
    };
}

// "2030-02-30" parses and then rolls over into March: a date is real only when the
// calendar gives back the day and month it was handed.
function isRealCalendarDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return false;
    }

    const [year, month, day] = date.split("-").map(Number);
    const probe = new Date(year, month - 1, day, 12);
    return probe.getFullYear() === year && probe.getMonth() === month - 1 &&
        probe.getDate() === day;
}

test("NagerDateServiceAdapter fuzzes date, county and type translation", () => {
    const { NagerDateServiceAdapter } = loadHolidays();
    const adapter = new NagerDateServiceAdapter(() => {});
    const params = adapter.params("usa", "ca", 2030);
    assert.equal(params.countryCode, "US");
    assert.equal(params.countyCode, "US-CA");

    const rand = makeRandom(13579);
    const payload = Array.from({ length: 300 },
        (_unused, index) => fuzzNagerRow(rand, index));

    const translated = adapter.translateResponse(payload, params);
    assert.deepEqual(adapter.translateResponse(payload, params), translated,
        "translation is deterministic");

    translated.forEach(assertPlaceableNagerHoliday);

    // Which rows survive, stated as a property of the row rather than as a second
    // copy of the adapter's filter: a row is keepable when its date is a real
    // calendar date and it is not another county's holiday. The count has to agree
    // both ways — nothing keepable is dropped, and nothing else is kept.
    const keepable = payload.filter((row) => isRealCalendarDate(row.date) &&
        (row.counties.length === 0 || row.counties.includes("US-CA")));

    assert.equal(translated.length, keepable.length);
    assert.ok(keepable.length > 0, "fuzz corpus keeps some valid rows");
    assert.ok(keepable.length < payload.length, "and drops some");
});

test("the fallback chain retries HolidayService failures with Nager data", () => {
    const { HolidayService, EnricoServiceAdapter, HolidayCache, createHolidayServiceChain, NagerDateServiceAdapter } = loadHolidays();
    const primary = new EnricoServiceAdapter((_url, params, callback) => {
        callback(null, params, "Enrico failed");
    });
    const fallback = new NagerDateServiceAdapter((_url, params, callback) => {
        callback([
            {
                date: "2026-03-31",
                localName: "Cesar Chavez Day",
                name: "Cesar Chavez Day",
                counties: ["US-CA"],
                types: ["Public"]
            }
        ], params, NAGER_STAMP);
    });
    let saved = null;
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        (_country, data) => {
            saved = data;
        }
    );
    const enrico = new HolidayService(createHolidayServiceChain(primary, fallback), cache);

    enrico.country = "usa";
    enrico.region = "ca";
    enrico.retrieveForYear(2026);

    assert.equal(enrico.last_error, "");
    assert.equal(enrico.last_provider, "Nager.Date");
    assert.deepEqual(enrico.cache.years[2026], { ca: NAGER_STAMP });
    assert.deepEqual(enrico.matchMonth(2026, 3).get("3/31"), ["Cesar Chavez Day", ["public_holiday"]]);
    assert.equal(saved.holidays.length, 1);
});

test("destroying the applet stops the provider chain instead of advancing it", () => {
    const { createHolidayServiceChain } = loadHolidays();
    const tried = [];
    const provider = (name) => ({
        name,
        fetchYear(_country, _region, year, callback) {
            tried.push(name);
            // this is what the aborted session looks like from here
            callback(null, { year, region: "global", providerName: name }, null);
        },
        validResponse: (data) => Array.isArray(data)
    });
    const service = createHolidayServiceChain(provider("Enrico"),
        [provider("OpenHolidays"), provider("Nager.Date")]);

    let alive = true;
    service.setLivenessCheck(() => alive);

    // the applet is removed from the panel while HolidayService's request is in flight
    alive = false;
    let answered = false;
    service.fetchYear("usa", "global", 2026, () => {
        answered = true;
    });

    assert.deepEqual(tried, ["Enrico"],
        "the abort does not walk the chain on to the other two providers");
    assert.equal(answered, false, "and nothing calls back into the destroyed applet");

    // an adapter nobody hands a liveness check to is always alive
    service.setLivenessCheck(null);
    service.fetchYear("usa", "global", 2026, () => {
        answered = true;
    });

    assert.deepEqual(tried, ["Enrico", "Enrico", "OpenHolidays", "Nager.Date"]);
    assert.equal(answered, true);
});

test("an empty answer from the primary does not end the provider chain", () => {
    const { HolidayService, EnricoServiceAdapter, HolidayCache, createHolidayServiceChain, NagerDateServiceAdapter } = loadHolidays();
    // HolidayService answers [] for the country/year pairs it does not cover: a
    // well-formed payload that says "no holidays here"
    const primary = new EnricoServiceAdapter((_url, params, callback) => {
        callback([], params, "Enrico answered empty");
    });
    const fallback = new NagerDateServiceAdapter((_url, params, callback) => {
        callback([
            { date: "2026-03-31", localName: "Cesar Chavez Day", name: "Cesar Chavez Day", counties: ["US-CA"], types: ["Public"] }
        ], params, NAGER_STAMP);
    });
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    const enrico = new HolidayService(createHolidayServiceChain(primary, fallback), cache);

    enrico.country = "usa";
    enrico.region = "ca";
    enrico.retrieveForYear(2026);

    assert.equal(enrico.last_provider, "Nager.Date",
        "the chain runs on instead of believing the empty answer");
    assert.deepEqual(enrico.matchMonth(2026, 3).get("3/31"), ["Cesar Chavez Day", ["public_holiday"]]);
});

test("an empty answer is believed once every provider gives one", () => {
    const { HolidayService, EnricoServiceAdapter, HolidayCache, createHolidayServiceChain, NagerDateServiceAdapter } = loadHolidays();
    const empty = (_url, params, callback) => callback([], params, "Sat, 04 Jul 2026 00:00:00 GMT");
    const primary = new EnricoServiceAdapter(empty);
    const fallback = new NagerDateServiceAdapter(empty);
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    const enrico = new HolidayService(createHolidayServiceChain(primary, fallback), cache);

    enrico.country = "usa";
    enrico.region = "ca";
    enrico.retrieveForYear(2026);

    // a country really can have no holidays on file; that is not an error
    assert.equal(enrico.last_error, "");
    assert.equal(enrico.matchMonth(2026, 3).size, 0);
    assert.equal(enrico.staleCache(2026), false, "and the year is recorded, not refetched in a loop");
});

test("an empty answer followed by a hard failure is not cached as success", () => {
    const { HolidayService, EnricoServiceAdapter, HolidayCache,
        createHolidayServiceChain, NagerDateServiceAdapter } = loadHolidays();
    const primary = new EnricoServiceAdapter((_url, params, callback) => {
        callback([], params, "Enrico answered empty");
    });
    const fallback = new NagerDateServiceAdapter((_url, params, callback) => {
        callback(null, params, null);
    });
    const cache = new HolidayCache((_country, done) => done({ years: {}, holidays: [] }), () => {});
    const service = new HolidayService(createHolidayServiceChain(primary, [fallback]), cache);

    service.country = "usa";
    service.region = "global";
    service.retrieveForYear(2026);

    assert.equal(service.last_error, "Holiday service unavailable");
    assert.equal(service.staleCache(2026), false, "the one-hour failure backoff still applies");
    assert.equal(service.staleCache(2026, Date.now() + 2 * 60 * 60 * 1000), true,
        "a hard failure cannot make an earlier empty response fresh for 50 days");
    assert.equal(service.cache.years[2026], undefined);
});

test("the fallback chain tries OpenHolidays before Nager", () => {
    const { HolidayService, EnricoServiceAdapter, HolidayCache, createHolidayServiceChain, NagerDateServiceAdapter, OpenHolidaysServiceAdapter } = loadHolidays();
    const primary = new EnricoServiceAdapter((_url, params, callback) => {
        callback(null, params, "Enrico failed");
    });
    const openHolidays = new OpenHolidaysServiceAdapter((_url, params, callback) => {
        callback([
            {
                startDate: "2026-01-02",
                type: "Optional",
                name: [{ language: "EN", text: "Berchtold's Day" }],
                nationwide: false,
                subdivisions: [{ code: "CH-ZH", shortName: "ZH" }]
            }
        ], params, OPENHOLIDAYS_STAMP);
    });
    const nager = new NagerDateServiceAdapter(() => {
        throw new Error("Nager should not be called when OpenHolidays succeeds");
    });
    let saved = null;
    const cache = new HolidayCache(
        (_country, done) => done({ years: {}, holidays: [] }),
        (_country, data) => {
            saved = data;
        }
    );
    const enrico = new HolidayService(createHolidayServiceChain(primary, [openHolidays, nager]), cache);

    enrico.country = "che";
    enrico.region = "zh";
    enrico.retrieveForYear(2026);

    assert.equal(enrico.last_error, "");
    assert.equal(enrico.last_provider, "OpenHolidays");
    assert.deepEqual(enrico.cache.years[2026], { zh: OPENHOLIDAYS_STAMP });
    assert.deepEqual(enrico.matchMonth(2026, 1).get("1/2"), ["Berchtold's Day", ["optional"]]);
    assert.equal(saved.holidays.length, 1);
});

// The chain validates every provider's answer against the record contract — the
// shape the app owns. These tests are about ordering and failure reporting, so
// they hand it a record that accepts anything.
// The record contract is the domain's, not the port's: an adapter owes fetchYear
// and nothing else, and both the chain (to decide whether a provider's answer
// counts) and HolidayService (to validate and expand what it stores) are handed
// the contract. This is the stand-in for it.
test("the fallback chain tries the last successful provider first", () => {
    const { createHolidayServiceChain } = loadHolidays();
    const calls = [];
    const primary = {
        name: "Primary",
        fetchYear(_country, _region, year, callback) {
            calls.push(`primary:${year}`);
            callback(null, { year, region: "global", providerName: "Primary" }, null);
        },
        params() {},
        url() {},
        localizeName() {},
        validHoliday() {},
        validResponse(data) {
            return Array.isArray(data);
        },
        expandHoliday() {}
    };
    const fallback = {
        name: "Fallback",
        fetchYear(_country, _region, year, callback) {
            calls.push(`fallback:${year}`);
            // a real row: an empty array is no longer taken as an answer
            callback([{ year, month: 1, day: 1, name: "New Year", flags: [] }],
                { year, region: "global", providerName: "Fallback" }, STAMP);
        }
    };
    const service = createHolidayServiceChain(primary, fallback, anyRecord());

    service.fetchYear("usa", "global", 2026, () => {});
    service.fetchYear("usa", "global", 2027, () => {});

    assert.deepEqual(calls, ["primary:2026", "fallback:2026", "fallback:2027"]);
});

test("expandHoliday spans month boundaries without corrupting dates", () => {
    const { HolidayRecordContract } = loadHolidays();
    const record = new HolidayRecordContract("en");

    function expand(from, to) {
        return record.expandHoliday({
            date: from,
            dateTo: to,
            name: [{ lang: "en", text: "Span" }],
            flags: []
        }, "global").map(({ year, month, day }) => `${year}-${month}-${day}`);
    }

    assert.deepEqual(
        expand({ year: 2026, month: 1, day: 30 }, { year: 2026, month: 2, day: 2 }),
        ["2026-1-30", "2026-1-31", "2026-2-1", "2026-2-2"]);
    assert.deepEqual(
        expand({ year: 2026, month: 4, day: 30 }, { year: 2026, month: 5, day: 2 }),
        ["2026-4-30", "2026-5-1", "2026-5-2"]);
    assert.deepEqual(
        expand({ year: 2026, month: 12, day: 31 }, { year: 2027, month: 1, day: 1 }),
        ["2026-12-31", "2027-1-1"]);

    // a dateTo equal to (or before) the start date must not grow the
    // holiday by a phantom extra day
    assert.deepEqual(
        expand({ year: 2026, month: 7, day: 9 }, { year: 2026, month: 7, day: 9 }),
        ["2026-7-9"]);
    assert.deepEqual(
        expand({ year: 2026, month: 7, day: 9 }, { year: 2026, month: 7, day: 8 }),
        ["2026-7-9"]);
});

test("both composition exports share one default provider order", () => {
    const holidays = loadHolidays();
    const ServiceAdapters = require(holidayServiceAdaptersPath);
    const { HOLIDAY_PROVIDER_NAMES } = require(holidayConstantsPath);
    const expected = [
        HOLIDAY_PROVIDER_NAMES.ENRICO,
        HOLIDAY_PROVIDER_NAMES.OPEN_HOLIDAYS,
        HOLIDAY_PROVIDER_NAMES.NAGER_DATE,
        HOLIDAY_PROVIDER_NAMES.CALDAYS
    ];

    for (const chain of [holidays.createHolidayServiceChain(),
        ServiceAdapters.createHolidayServiceChain()]) {
        assert.deepEqual([chain.primary.name].concat(chain.fallbacks.map((f) => f.name)),
            expected);
    }

    // explicit arguments still bypass the default chain
    const custom = holidays.createHolidayServiceChain(
        { name: "p", validResponse: () => true }, [{ name: "f" }]);
    assert.equal(custom.primary.name, "p");
    assert.deepEqual(custom.fallbacks.map((f) => f.name), ["f"]);
});

test("service adapters fail loudly without an injected JSON loader", () => {
    loadHolidays();
    const { EnricoServiceAdapter } = require(holidayServiceAdaptersPath);
    const adapter = new EnricoServiceAdapter(undefined);

    assert.throws(() => adapter.fetchYear("usa", "global", 2026, () => {}),
        /holiday service adapter has no JSON loader/);
});

test("IsoHolidayServiceAdapter owns generic translation and unsupported-country callbacks", () => {
    const { HOLIDAY_ERRORS } = loadHolidays();
    const { IsoHolidayServiceAdapter } = require(holidayServiceAdaptersPath);

    class TestIsoAdapter extends IsoHolidayServiceAdapter {
        constructor() {
            super((_url, params, callback) => {
                callback([{ date: "2026-01-01", name: "New Year", flags: ["public_holiday"] }], params, STAMP);
            });
            this.name = "TestIso";
        }

        params(country, _region, year) {
            return { year, countryCode: country === "missing" ? null : "TC" };
        }

        url() {
            return "https://example.test/holidays";
        }

        _validHoliday(holiday) {
            return holiday && typeof holiday.date === "string";
        }

        _matchesRegion() {
            return true;
        }

        _flags(holiday) {
            return holiday.flags;
        }

        _name(holiday) {
            return [{ lang: "en", text: holiday.name }];
        }
    }

    const adapter = new TestIsoAdapter();
    assert.deepEqual(adapter.translateResponse({ error: "upstream" }, {}), { error: "upstream" });

    let missing;
    adapter.fetchYear("missing", "global", 2026, (data, params, retrieved) => {
        missing = { data, params, retrieved };
    });
    assert.deepEqual(missing.data, { error: HOLIDAY_ERRORS.SERVICE_UNAVAILABLE });
    assert.equal(missing.retrieved, null);

    let translated;
    adapter.fetchYear("present", "global", 2026, (data, params, retrieved) => {
        translated = { data, params, retrieved };
    });
    assert.deepEqual(translated.data, [{
        date: { year: 2026, month: 1, day: 1 },
        name: [{ lang: "en", text: "New Year" }],
        flags: ["public_holiday"]
    }]);
    assert.equal(translated.params.providerName, "TestIso");
    assert.equal(translated.retrieved, STAMP);
});

test("EnricoServiceAdapter builds params and the record localizes and expands", () => {
    const { EnricoServiceAdapter, HolidayRecordContract } = loadHolidays();
    // params/url are the adapter's; validate/expand/localize are the record's
    const adapter = new EnricoServiceAdapter(() => {});
    const record = new HolidayRecordContract("it");
    const rows = record.expandHoliday({
        date: { year: 2026, month: 4, day: 24 },
        dateTo: { year: 2026, month: 4, day: 26 },
        name: [
            { lang: "en", text: "Liberation" },
            { lang: "it", text: "Liberazione" }
        ],
        flags: ["public_holiday"]
    }, "global");

    assert.equal(rows[0].name, "Liberazione");
    assert.ok(rows.length >= 2);
    assert.deepEqual(adapter.params("ita", "global", 2026), {
        year: 2026,
        country: "ita",
        holidayType: "public_holiday"
    });
    assert.deepEqual(adapter.params("ita", "rm", 2026), {
        year: 2026,
        country: "ita",
        holidayType: "public_holiday",
        region: "rm"
    });
    assert.equal(adapter.url(adapter.params("ita", "global", 2026)),
        "https://kayaposoft.com/enrico/json/v2.0/?action=getHolidaysForYear" +
        "&year=2026&country=ita&holidayType=public_holiday");
    assert.ok(adapter.url(adapter.params("ita", "rm", 2026)).includes("region=rm"));
    assert.ok(adapter.url(adapter.params("u sa", "new york", 2026)).includes("country=u%20sa"));
    assert.ok(adapter.url(adapter.params("u sa", "new york", 2026)).includes("region=new%20york"));
});

test("EnricoServiceAdapter normalizes live rows whose optional flags are absent", () => {
    const { EnricoServiceAdapter, HolidayRecordContract } = loadHolidays();
    const wireRows = [
        {
            date: { year: 2026, month: 1, day: 1, dayOfWeek: 4 },
            name: [{ lang: "it", text: "Capodanno" }, { lang: "en", text: "New Year's Day" }],
            holidayType: "public_holiday"
        },
        {
            date: { year: 2026, month: 12, day: 24, dayOfWeek: 4 },
            dateTo: { year: 2026, month: 12, day: 25, dayOfWeek: 5 },
            name: [{ lang: "en", text: "Christmas Eve" }],
            flags: ["PART_DAY_HOLIDAY"],
            holidayType: "public_holiday"
        }
    ];
    const adapter = new EnricoServiceAdapter((_url, params, callback) => {
        callback(wireRows, params, STAMP);
    });

    let answer;
    adapter.fetchYear("ita", "global", 2026, (data, params, retrieved) => {
        answer = { data, params, retrieved };
    });

    assert.deepEqual(answer.data, [
        {
            date: wireRows[0].date,
            name: wireRows[0].name,
            flags: ["public_holiday"]
        },
        {
            date: wireRows[1].date,
            dateTo: wireRows[1].dateTo,
            name: wireRows[1].name,
            flags: ["PART_DAY_HOLIDAY"]
        }
    ]);
    assert.equal(new HolidayRecordContract("it").validResponse(answer.data), true);
    assert.equal(answer.params.providerName, "Enrico");
    assert.equal(answer.retrieved, STAMP);
});

test("the record contract falls back to the first holiday name", () => {
    const { HolidayRecordContract } = loadHolidays();
    const record = new HolidayRecordContract("it");

    assert.equal(record.localizeName({
        name: [
            { lang: "fr", text: "Fete" },
            { lang: "de", text: "Feiertag" }
        ]
    }), "Fete");
});
