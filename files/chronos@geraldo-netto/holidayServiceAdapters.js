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

// The holiday provider port and its built-in adapters.
//
//     fetchYear(country, region, year, callback)
//         callback(data, params, retrieved, received) — data is the provider response,
//         normalized into the app-owned record shape when it is a holiday list;
//         params carries at least providerName and year, retrieved is the Date
//         response header or null; received is the local receipt timestamp.
//
// That is the whole port. What normalized data has to look like, how a holiday is
// localized and what it expands to is the record contract (HolidayRecordContract),
// which the *domain* owns — an adapter neither implements it nor is asked for it.
// The chain consults the contract for one decision only: whether a provider's
// answer counts, or whether the next provider should be tried.
const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const HolidayAdapters = IS_NODE ?
    require("./holidayAdapters") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayAdapters;
const HolidayConstants = IS_NODE ?
    require("./holidayConstants") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayConstants;
const HolidayRecord = IS_NODE ?
    require("./holidayRecord") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayRecord;
const Diagnostics = IS_NODE ?
    require("./diagnostics") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].diagnostics;

const validDateParts = HolidayRecord.validDateParts;
const normalizeProviderFlags = HolidayRecord.normalizeProviderFlags;
const nonBlankText = HolidayRecord.nonBlankText;
const HolidayRecordContract = HolidayRecord.HolidayRecordContract;

const GLOBAL_REGION = HolidayConstants.GLOBAL_REGION;
const ENRICO_PUBLIC_HOLIDAY_TYPE = "public_holiday";
var HOLIDAY_ERRORS = HolidayConstants.HOLIDAY_ERRORS; // NOSONAR [S3504] -- GJS importer export
var HOLIDAY_PROVIDER_NAMES = HolidayConstants.HOLIDAY_PROVIDER_NAMES; // NOSONAR [S3504] -- GJS importer export
var OPEN_HOLIDAYS_COUNTRIES = HolidayConstants.OPEN_HOLIDAYS_COUNTRIES; // NOSONAR [S3504] -- GJS importer export
var COUNTRY_TO_ISO2 = HolidayConstants.COUNTRY_TO_ISO2; // NOSONAR [S3504] -- GJS importer export
var COUNTRY_TO_LANGUAGE = HolidayConstants.COUNTRY_TO_LANGUAGE; // NOSONAR [S3504] -- GJS importer export
var REGION_TO_SUBDIVISION = HolidayConstants.REGION_TO_SUBDIVISION; // NOSONAR [S3504] -- GJS importer export
var ENRICO_URL = "https://kayaposoft.com/enrico/json/v2.0/?action=getHolidaysForYear"; // NOSONAR [S3504] -- GJS importer export

function unavailableLoadJsonAsync() {
    throw new Error("holiday service adapter has no JSON loader");
}

function deliverTranslated(adapter, data, params, retrieved, callback, received = new Date().toISOString()) {
    let translated;
    try {
        translated = adapter.translateResponse(data, params);
    } catch (e) {
        Diagnostics.logSafely("logError", e);
        callback(null, params, retrieved, received);
        return;
    }

    callback(translated, params, retrieved, received);
}

// An adapter is a fetchYear and nothing else: it builds the request and translates
// the vendor response. Validating, expanding and localizing it is the record
// contract's job, owned by the fallback chain that composes the adapters — so
// this carries no record and no lang of its own.
var EnricoServiceAdapter = class EnricoServiceAdapter { // NOSONAR [S3504] -- GJS importer export
    constructor(loadJsonAsync = unavailableLoadJsonAsync) {
        this._loadJsonAsync = loadJsonAsync;
        this.name = HOLIDAY_PROVIDER_NAMES.ENRICO;
    }

    params(country, region, year) {
        const params = {
            year,
            country,
            holidayType: ENRICO_PUBLIC_HOLIDAY_TYPE
        };

        if (region !== GLOBAL_REGION) {
            params.region = region;
        }

        return params;
    }

    url(params) {
        let url = ENRICO_URL;
        for (let key of Object.keys(params)) {
            url += "&" + encodeURIComponent(key) + "=" + encodeURIComponent(params[key]);
        }

        return url;
    }

    // v2.0 rows carry an optional `flags` array beside `holidayType`; when it is
    // absent the type is the only claim the row makes about itself. Either way
    // the strings are the vendor's, and normalizeProviderFlags is what keeps
    // them out of the applet's own flag namespace: `holidayType` happens to
    // spell the app's public sentinel, so publicness is decided here — this
    // adapter only ever asks for public holidays — rather than copied through.
    _flags(holiday) {
        const hasFlags = Array.isArray(holiday.flags);
        if (!hasFlags && typeof holiday.holidayType !== "string") {
            return null;
        }

        return normalizeProviderFlags(hasFlags ? holiday.flags : [holiday.holidayType],
            holiday.holidayType === ENRICO_PUBLIC_HOLIDAY_TYPE);
    }

    _translateHoliday(holiday) {
        if (!holiday || typeof holiday !== "object" || Array.isArray(holiday)) {
            return holiday;
        }

        const translated = {
            date: holiday.date,
            name: holiday.name,
            flags: this._flags(holiday)
        };
        if (holiday.dateTo) {
            translated.dateTo = holiday.dateTo;
        }

        return translated;
    }

    translateResponse(data) {
        if (!Array.isArray(data)) {
            return data;
        }

        return data.map((holiday) => this._translateHoliday(holiday));
    }

    fetchYear(country, region, year, callback) {
        const params = this.params(country, region, year);
        // url() serializes every own key, and providerName is the chain's
        // params contract, not a wire parameter: build the URL first
        const url = this.url(params);
        params.providerName = this.name;
        this._loadJsonAsync(url, params, (data, requestParams, retrieved, received) => {
            deliverTranslated(this, data, requestParams, retrieved, callback, received);
        });
    }
};

// both ISO-based fallback providers key their regions off the same
// region-to-subdivision table and parse the same YYYY-MM-DD date strings
function regionSubdivisionCode(country, region) {
    const regions = REGION_TO_SUBDIVISION[country];
    if (!regions || !region || region === GLOBAL_REGION) {
        return null;
    }

    return regions[region] || null;
}

function isoDateParts(date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) {
        return null;
    }

    const parts = {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3])
    };

    // Invalid calendar dates would create phantom month buckets and Date
    // rollover in expandHoliday.
    if (!validDateParts(parts)) {
        return null;
    }

    return parts;
}

// Common scaffolding for adapters over ISO-8601 date APIs: shared date
// parsing, response translation and fetch flow. Subclasses supply
// _validHoliday/_matchesRegion/_flags/_name plus params()/url(), and may
// override _startDate/_finishTranslation for shape differences.
var IsoHolidayServiceAdapter = class IsoHolidayServiceAdapter { // NOSONAR [S3504] -- GJS importer export
    constructor(loadJsonAsync = unavailableLoadJsonAsync) {
        this._loadJsonAsync = loadJsonAsync;
    }

    _dateParts(date) {
        return isoDateParts(date);
    }

    _startDate(holiday) {
        return holiday.date;
    }

    _finishTranslation(translated, holiday) {
        return translated;
    }

    // Both ISO vendors describe a holiday's kind as type strings, and both
    // spell the public one "Public". Publicness is decided here rather than
    // copied through, and every other type is lowercased into the applet's own
    // flag namespace; an empty list means an ordinary public holiday.
    _publicOrLowercase(types) {
        const list = types.length > 0 ? types : ["Public"];

        return normalizeProviderFlags(
            list.filter((type) => type !== "Public").map((type) => type.toLowerCase()),
            list.indexOf("Public") >= 0); // NOSONAR [S7765] -- accepted compatible form
    }

    // One region rule for both, with the vendor's field names behind hooks:
    // _regionList/_regionCode name the row's regions, _isNationwide names its
    // "applies everywhere" field, _appliesToAllRegions says what an unscoped
    // row means once a region *was* requested — Nager rows carry no nationwide
    // marker there and say it by listing no counties — and _subdivisionMatches
    // refines the comparison for vendors with hierarchical codes.
    _regionList(holiday) {
        return [];
    }

    _regionCode(entry) {
        return "";
    }

    _isNationwide(holiday) {
        return false;
    }

    _requestedRegionCode(params) {
        return "";
    }

    _subdivisionMatches(code, expectedCode) {
        return code === expectedCode;
    }

    _appliesToAllRegions(holiday, regions) {
        return this._isNationwide(holiday);
    }

    _matchesRegion(holiday, params) {
        const regions = this._regionList(holiday);
        const expected = this._requestedRegionCode(params);
        if (params.region === GLOBAL_REGION || !expected) {
            return this._isNationwide(holiday) || regions.length === 0;
        }

        return this._appliesToAllRegions(holiday, regions) ||
            regions.some((entry) => {
                const code = this._regionCode(entry);
                return Boolean(code) && this._subdivisionMatches(code, expected);
            });
    }

    _translateHoliday(holiday, params) {
        if (!this._validHoliday(holiday) || !this._matchesRegion(holiday, params)) {
            return null;
        }

        const date = this._dateParts(this._startDate(holiday));
        if (!date) {
            return null;
        }

        return this._finishTranslation({
            date,
            name: this._name(holiday, params),
            flags: this._flags(holiday)
        }, holiday);
    }

    translateResponse(data, params) {
        if (!Array.isArray(data)) {
            return data;
        }

        return data
            .map((holiday) => this._translateHoliday(holiday, params))
            .filter((holiday) => holiday !== null);
    }

    fetchYear(country, region, year, callback) {
        const params = this.params(country, region, year);
        params.providerName = this.name;
        if (!params.countryCode) {
            callback({error: HOLIDAY_ERRORS.SERVICE_UNAVAILABLE}, params, null);
            return;
        }

        this._loadJsonAsync(this.url(params), params, (data, requestParams, retrieved, received) => {
            deliverTranslated(this, data, requestParams, retrieved, callback, received);
        });
    }
};

var NagerDateServiceAdapter = class NagerDateServiceAdapter extends IsoHolidayServiceAdapter { // NOSONAR [S3504] -- GJS importer export
    constructor(loadJsonAsync = unavailableLoadJsonAsync) {
        super(loadJsonAsync);
        this.name = HOLIDAY_PROVIDER_NAMES.NAGER_DATE;
    }

    countryCode(country) {
        return COUNTRY_TO_ISO2[country] || null;
    }

    countyCode(country, region) {
        return regionSubdivisionCode(country, region);
    }

    params(country, region, year) {
        return {
            year,
            country,
            region: region || GLOBAL_REGION,
            countryCode: this.countryCode(country),
            countyCode: this.countyCode(country, region)
        };
    }

    url(params) {
        return "https://date.nager.at/api/v3/PublicHolidays/" +
            encodeURIComponent(params.year) + "/" + encodeURIComponent(params.countryCode);
    }

    _validHoliday(holiday) {
        return holiday &&
            typeof holiday.date === "string" &&
            nonBlankText(holiday.name) &&
            (!holiday.localName || typeof holiday.localName === "string") &&
            (!holiday.counties || Array.isArray(holiday.counties)) &&
            (!holiday.types || (Array.isArray(holiday.types) &&
                holiday.types.every((type) => typeof type === "string")));
    }

    _regionList(holiday) {
        return Array.isArray(holiday.counties) ? holiday.counties : [];
    }

    _regionCode(entry) {
        return typeof entry === "string" ? entry : "";
    }

    _isNationwide(holiday) {
        return holiday.global === true;
    }

    _requestedRegionCode(params) {
        return params.countyCode;
    }

    // A Nager row that lists no counties is the nationwide one; `global` is a
    // separate field the vendor sets on those same rows.
    _appliesToAllRegions(holiday, regions) {
        return regions.length === 0;
    }

    _flags(holiday) {
        return this._publicOrLowercase(Array.isArray(holiday.types) ? holiday.types : []);
    }

    // The local name was tagged `lang: "local"`, which `localizeName` can never
    // select: it keeps only the message language or `en`. So Nager's Spanish
    // "Año Nuevo" was fetched, validated, and thrown away on a Spanish desktop,
    // which read the English name instead. Tag it with the country's real
    // language — a generic marker would be wrong, because a Spanish desktop
    // asking for German holidays must still get the English name.
    //
    // An English-speaking country contributes nothing here: its `localName`
    // equals `name`, and a second `en` entry would make the selection
    // ambiguous. A country with no mapping is likewise left English-only; the
    // static parity test holds every supported country to a language, so that
    // is an unreachable guard rather than a silent loss.
    _name(holiday, params) {
        const name = holiday.name.trim();
        const localName = typeof holiday.localName === "string" ?
            holiday.localName.trim() : "";
        const lang = COUNTRY_TO_LANGUAGE[params?.country];
        if (lang && localName && localName !== name) {
            return [
                {lang, text: localName},
                {lang: "en", text: name}
            ];
        }

        return [{lang: "en", text: name}];
    }
};

var OpenHolidaysServiceAdapter = class OpenHolidaysServiceAdapter extends IsoHolidayServiceAdapter { // NOSONAR [S3504] -- GJS importer export
    constructor(loadJsonAsync = unavailableLoadJsonAsync, lang = "en") {
        super(loadJsonAsync);
        this._lang = lang;
        this.name = HOLIDAY_PROVIDER_NAMES.OPEN_HOLIDAYS;
    }

    // A resolver is consulted per fetch. The shipped resolver follows the
    // message locale independently of LC_ADDRESS regional formatting, and the
    // composition root injects it; a bare adapter stays inert in English.
    _langCode() {
        const lang = typeof this._lang === "function" ? this._lang() : this._lang;
        return String(lang || "en").slice(0, 2).toUpperCase();
    }

    countryCode(country) {
        if (!OPEN_HOLIDAYS_COUNTRIES[country]) {
            return null;
        }

        return COUNTRY_TO_ISO2[country] || null;
    }

    subdivisionCode(country, region) {
        return regionSubdivisionCode(country, region);
    }

    params(country, region, year) {
        const params = {
            year,
            country,
            region: region || GLOBAL_REGION,
            countryCode: this.countryCode(country),
            subdivisionCode: this.subdivisionCode(country, region),
            languageIsoCode: this._langCode(),
            validFrom: `${year}-01-01`,
            validTo: `${year}-12-31`
        };

        return params;
    }

    url(params) {
        let url = "https://openholidaysapi.org/PublicHolidays?countryIsoCode=" +
            encodeURIComponent(params.countryCode) +
            "&validFrom=" + encodeURIComponent(params.validFrom) +
            "&validTo=" + encodeURIComponent(params.validTo) +
            "&languageIsoCode=" + encodeURIComponent(params.languageIsoCode);

        if (params.subdivisionCode) {
            url += "&subdivisionCode=" + encodeURIComponent(params.subdivisionCode);
        }

        return url;
    }

    _validHoliday(holiday) {
        return holiday &&
            typeof holiday.startDate === "string" &&
            (!Object.hasOwn(holiday, "endDate") ||
                typeof holiday.endDate === "string") &&
            (!holiday.type || typeof holiday.type === "string") &&
            Array.isArray(holiday.name) &&
            holiday.name.length > 0 &&
            holiday.name.every((entry) => entry && typeof entry.language === "string" && typeof entry.text === "string") &&
            holiday.name.some((entry) => nonBlankText(entry.text)) &&
            (!holiday.subdivisions || Array.isArray(holiday.subdivisions));
    }

    // OpenHolidays writes hierarchical subdivision codes, so a request for a
    // state also takes its districts.
    _subdivisionMatches(code, expectedCode) {
        return code === expectedCode || code.indexOf(expectedCode + "-") === 0;
    }

    _regionList(holiday) {
        return Array.isArray(holiday.subdivisions) ? holiday.subdivisions : [];
    }

    _regionCode(entry) {
        return entry && typeof entry.code === "string" ? entry.code : "";
    }

    _isNationwide(holiday) {
        return holiday.nationwide === true;
    }

    _requestedRegionCode(params) {
        return params.subdivisionCode;
    }

    _flags(holiday) {
        return this._publicOrLowercase(holiday.type ? [holiday.type] : []);
    }

    _name(holiday) {
        return holiday.name
            .filter((entry) => nonBlankText(entry.text))
            .map((entry) => ({
                lang: entry.language.toLowerCase(),
                text: entry.text.trim()
            }));
    }

    _startDate(holiday) {
        return holiday.startDate;
    }

    _finishTranslation(translated, holiday) {
        if (!Object.hasOwn(holiday, "endDate")) {
            return translated;
        }

        const dateTo = this._dateParts(holiday.endDate);
        if (!dateTo) {
            return null;
        }
        if (holiday.endDate !== holiday.startDate) {
            translated.dateTo = dateTo;
        }

        return translated;
    }
};

// The one place that fixes the default provider order: Enrico primary, then
// OpenHolidays and Nager.Date. A caller that wants a live HTTP
// loader injects the adapters; the defaults here stay loader-less.
//
// The chain uses the record contract for one thing — deciding whether a
// provider's answer counts, so a bad one falls through to the next provider. It
// used to also forward validResponse/expandHoliday to it on the domain's behalf,
// which put the contract's whole surface on the port: a fourth provider's author
// could not tell which of the six methods an adapter owed. The domain holds the
// contract itself now, so the port is fetchYear and nothing else.
// A subclass here bound a *second* class to the name HolidayFallbackChain already
// had, with an incompatible third parameter — a record where the base takes a
// validator — so constructing the base with what the subclass takes threw
// `this._validResponse is not a function` inside an HTTP callback, where it read
// as a provider failure. It only ever existed to bind default arguments, and a
// factory says that without shadowing anything.
function createHolidayServiceChain(primary = new EnricoServiceAdapter(),
    fallbacks = [
        new OpenHolidaysServiceAdapter(),
        new NagerDateServiceAdapter()
    ],
    record = new HolidayRecordContract()) {
    return new HolidayAdapters.HolidayFallbackChain(
        primary, fallbacks, (data, year) => record.validResponse(data, year));
}

if (typeof module !== "undefined") {
    module.exports = {
        regionSubdivisionCode, isoDateParts, IsoHolidayServiceAdapter,
        EnricoServiceAdapter, NagerDateServiceAdapter, OpenHolidaysServiceAdapter,
        createHolidayServiceChain
    };
}
