/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const Utils = typeof require === "function" ?
    require("./utils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].utils;
const HolidayAdapters = typeof require === "function" ?
    require("./holidayAdapters") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayAdapters;
const HolidayConstants = typeof require === "function" ?
    require("./holidayConstants") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayConstants;

const MSECS_IN_DAY = Utils.MSECS_IN_DAY;
const _lcLang = Utils.lazyLocaleValue("LC_ADDRESS", (info) => info.lang_ab);

const GLOBAL_REGION = HolidayConstants.GLOBAL_REGION;
var HOLIDAY_ERRORS = HolidayConstants.HOLIDAY_ERRORS;
var HOLIDAY_PROVIDER_NAMES = HolidayConstants.HOLIDAY_PROVIDER_NAMES;
var OPEN_HOLIDAYS_COUNTRIES = HolidayConstants.OPEN_HOLIDAYS_COUNTRIES;
var ENRICO_COUNTRY_TO_ISO2 = HolidayConstants.ENRICO_COUNTRY_TO_ISO2;
var ENRICO_REGION_TO_COUNTY = HolidayConstants.ENRICO_REGION_TO_COUNTY;
var ENRICO_URL = "https://kayaposoft.com/enrico/json/v2.0?action=getHolidaysForYear";

function unavailableLoadJsonAsync() {
    throw new Error("holiday service adapter has no JSON loader");
}

// A holiday never spans more than a year. Without a bound, a hostile or
// broken provider can send dateTo: 9999-12-31 and make expandHoliday build
// millions of rows on the compositor thread and persist them to the cache.
var MAX_HOLIDAY_SPAN_DAYS = 366;

// ...and every other dimension of the payload was bounded except the one that
// multiplies: the number of holidays in it.
//
// The body is capped at 4 MiB and each holiday's span at 366 days, but nothing
// capped the array's length — and expandHoliday materialises holidays × span
// rows synchronously, on the compositor thread, before any dedup can look at
// them. A 4 MiB body of ~33,000 minimal-but-valid entries, each spanning a
// year, expands to roughly twelve million objects in one loop: Cinnamon hangs,
// or the process is killed.
//
// A whole nation's public holidays are a few dozen a year. A hundred is
// generous; a thousand is already absurd, and is the point at which we say so.
var MAX_HOLIDAYS_PER_YEAR = 1000;
// and the rows they expand to, which is what actually reaches the grid and the
// cache file: 366 days × a handful of overlapping regional holidays
var MAX_EXPANDED_HOLIDAY_ROWS = 4000;

function _noonUtc(parts) {
    return Date.UTC(parts.year, parts.month - 1, parts.day, 12);
}

function holidaySpanDays(date, dateTo) {
    return Math.round((_noonUtc(dateTo) - _noonUtc(date)) / MSECS_IN_DAY);
}

function validHolidaySpan(date, dateTo) {
    return holidaySpanDays(date, dateTo) <= MAX_HOLIDAY_SPAN_DAYS;
}

function validDateParts(parts) {
    if (!parts ||
        !Number.isInteger(parts.year) ||
        !Number.isInteger(parts.month) ||
        !Number.isInteger(parts.day)) {
        return false;
    }

    const date = new Date(parts.year, parts.month - 1, parts.day, 12);
    return date.getFullYear() === parts.year &&
        date.getMonth() === parts.month - 1 &&
        date.getDate() === parts.day;
}

// The app's own holiday record, and the only shape the cache and the calendar
// ever see: a date, an optional dateTo, localizable names and flags.
//
// This shape existed already — it is Enrico's wire format — and that was the
// problem: the fallback chain validated and expanded *every* provider's payload
// with the *primary's* validator, so the port's contract was one vendor's
// payload. Nager.Date and OpenHolidays have no validator of their own;
// IsoHolidayServiceAdapter.translateResponse reshapes them into Enrico's format
// so that Enrico's check will accept them. Add a fourth provider that does not
// reverse-engineer that shape and its perfectly good data comes back as
// INVALID_RESPONSE, with nothing to say that the *validator*, not the data, was
// the wrong one — and dropping Enrico, the flakiest of the three, would have
// broken the other two.
//
// The contract belongs to the port. The adapters translate into it; it does not
// belong to any of them.
var HolidayRecordContract = class HolidayRecordContract {
    constructor(lang = _lcLang()) {
        this._lang = lang;
    }

    validHoliday(holiday) {
        return holiday &&
            validDateParts(holiday.date) &&
            (!holiday.dateTo ||
                (validDateParts(holiday.dateTo) && validHolidaySpan(holiday.date, holiday.dateTo))) &&
            Array.isArray(holiday.name) &&
            holiday.name.length > 0 &&
            holiday.name.every((entry) => entry && typeof entry.lang === "string" && typeof entry.text === "string") &&
            Array.isArray(holiday.flags);
    }

    validResponse(data) {
        if (!Array.isArray(data) || data.length > MAX_HOLIDAYS_PER_YEAR) {
            return false;
        }

        return data.every((holiday) => this.validHoliday(holiday));
    }

    localizeName(holiday) {
        const localized = holiday.name
            .filter((l) => l.lang === this._lang || l.lang === "en")
            .sort((a, b) => a.lang === "en" ? 1 : b.lang === "en" ? -1 : 0)[0];

        return (localized || holiday.name[0]).text;
    }

    expandHoliday(holiday, region) {
        const {year, month, day} = holiday.date;
        const name = this.localizeName(holiday);

        const flags = holiday.flags;
        const days = [{year, month, day, name, flags, region}];

        if (holiday.dateTo) {
            const {year: yearTo, month: monthTo, day: dayTo} = holiday.dateTo;

            // holiday dates are 1-based months; Date months are 0-based.
            // test before pushing: a provider reporting dateTo <= date must
            // not grow the holiday by a phantom extra day
            let iter = new Date(year, month - 1, day, 12);
            let limit = new Date(yearTo, monthTo - 1, dayTo, 12);
            // validHoliday already rejects oversized spans; this keeps the
            // loop bounded even when expandHoliday is reached another way
            while (iter < limit && days.length <= MAX_HOLIDAY_SPAN_DAYS) {
                iter.setTime(iter.getTime() + MSECS_IN_DAY);
                days.push({
                    year: iter.getFullYear(),
                    month: iter.getMonth() + 1,
                    day: iter.getDate(),
                    name,
                    flags,
                    region
                });
            }
        }

        return days;
    }
};

// An adapter is a fetchYear and nothing else: it builds the request and hands
// the raw payload back. Validating, expanding and localizing it is the record
// contract's job, owned by the fallback chain that composes the adapters — so
// this carries no record and no lang of its own.
var EnricoServiceAdapter = class EnricoServiceAdapter {
    constructor(loadJsonAsync = unavailableLoadJsonAsync) {
        this._loadJsonAsync = loadJsonAsync;
        this.name = HOLIDAY_PROVIDER_NAMES.ENRICO;
    }

    params(country, region, year) {
        const params = {
            year,
            country,
            holidayType: "public_holiday"
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

    fetchYear(country, region, year, callback) {
        const params = this.params(country, region, year);
        params.providerName = this.name;
        this._loadJsonAsync(this.url(params), params, callback);
    }
};

// both ISO-based fallback providers key their regions off the same
// Enrico county table and parse the same YYYY-MM-DD date strings
function enricoRegionCode(country, region) {
    const regions = ENRICO_REGION_TO_COUNTY[country];
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
var IsoHolidayServiceAdapter = class IsoHolidayServiceAdapter {
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
            name: this._name(holiday),
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

        this._loadJsonAsync(this.url(params), params, (data, requestParams, retrieved) => {
            callback(this.translateResponse(data, requestParams), requestParams, retrieved);
        });
    }
};

var NagerDateServiceAdapter = class NagerDateServiceAdapter extends IsoHolidayServiceAdapter {
    constructor(loadJsonAsync = unavailableLoadJsonAsync) {
        super(loadJsonAsync);
        this.name = HOLIDAY_PROVIDER_NAMES.NAGER_DATE;
    }

    countryCode(country) {
        return ENRICO_COUNTRY_TO_ISO2[country] || null;
    }

    countyCode(country, region) {
        return enricoRegionCode(country, region);
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
            typeof holiday.name === "string" &&
            (!holiday.localName || typeof holiday.localName === "string") &&
            (!holiday.counties || Array.isArray(holiday.counties)) &&
            (!holiday.types || Array.isArray(holiday.types));
    }

    _matchesRegion(holiday, params) {
        const counties = Array.isArray(holiday.counties) ? holiday.counties : [];
        if (params.region === GLOBAL_REGION || !params.countyCode) {
            return holiday.global === true || counties.length === 0;
        }

        return counties.length === 0 || counties.indexOf(params.countyCode) !== -1;
    }

    _flags(holiday) {
        const types = Array.isArray(holiday.types) && holiday.types.length ? holiday.types : ["Public"];

        return types.map((type) => type === "Public" ? "public_holiday" : type.toLowerCase());
    }

    _name(holiday) {
        if (holiday.localName && holiday.localName !== holiday.name) {
            return [
                {lang: "local", text: holiday.localName},
                {lang: "en", text: holiday.name}
            ];
        }

        return [{lang: "en", text: holiday.name}];
    }
};

var OpenHolidaysServiceAdapter = class OpenHolidaysServiceAdapter extends IsoHolidayServiceAdapter {
    constructor(loadJsonAsync = unavailableLoadJsonAsync, lang = _lcLang()) {
        super(loadJsonAsync);
        this._lang = String(lang || "en").slice(0, 2).toUpperCase();
        this.name = HOLIDAY_PROVIDER_NAMES.OPEN_HOLIDAYS;
    }

    countryCode(country) {
        if (!OPEN_HOLIDAYS_COUNTRIES[country]) {
            return null;
        }

        return ENRICO_COUNTRY_TO_ISO2[country] || null;
    }

    subdivisionCode(country, region) {
        return enricoRegionCode(country, region);
    }

    params(country, region, year) {
        const params = {
            year,
            country,
            region: region || GLOBAL_REGION,
            countryCode: this.countryCode(country),
            subdivisionCode: this.subdivisionCode(country, region),
            languageIsoCode: this._lang,
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
            (!holiday.endDate || typeof holiday.endDate === "string") &&
            (!holiday.type || typeof holiday.type === "string") &&
            Array.isArray(holiday.name) &&
            holiday.name.length > 0 &&
            holiday.name.every((entry) => entry && typeof entry.language === "string" && typeof entry.text === "string") &&
            (!holiday.subdivisions || Array.isArray(holiday.subdivisions));
    }

    _subdivisionMatches(code, expectedCode) {
        return code === expectedCode || code.indexOf(expectedCode + "-") === 0;
    }

    _matchesRegion(holiday, params) {
        const subdivisions = Array.isArray(holiday.subdivisions) ? holiday.subdivisions : [];
        if (params.region === GLOBAL_REGION || !params.subdivisionCode) {
            return holiday.nationwide === true || subdivisions.length === 0;
        }

        return holiday.nationwide === true ||
            subdivisions.some((subdivision) => subdivision && typeof subdivision.code === "string" &&
                this._subdivisionMatches(subdivision.code, params.subdivisionCode));
    }

    _flags(holiday) {
        const type = holiday.type || "Public";

        return [type === "Public" ? "public_holiday" : type.toLowerCase()];
    }

    _name(holiday) {
        return holiday.name.map((entry) => ({
            lang: entry.language.toLowerCase(),
            text: entry.text
        }));
    }

    _startDate(holiday) {
        return holiday.startDate;
    }

    _finishTranslation(translated, holiday) {
        if (holiday.endDate && holiday.endDate !== holiday.startDate) {
            const dateTo = this._dateParts(holiday.endDate);
            if (dateTo) {
                translated.dateTo = dateTo;
            }
        }

        return translated;
    }
};

// The one place that fixes the default provider order: Enrico primary,
// then OpenHolidays, then Nager.Date. A caller that wants a live HTTP
// loader injects the adapters; the defaults here stay loader-less.
var HolidayServiceFallbackAdapter = class HolidayServiceFallbackAdapter extends HolidayAdapters.HolidayServiceFallbackAdapter {
    constructor(primary = new EnricoServiceAdapter(),
        fallbacks = [new OpenHolidaysServiceAdapter(), new NagerDateServiceAdapter()],
        record = new HolidayRecordContract()) {
        super(primary, fallbacks, (data) => record.validResponse(data));
        this.record = record;
    }

    validResponse(data) {
        return this.record.validResponse(data);
    }

    expandHoliday(holiday, region) {
        return this.record.expandHoliday(holiday, region);
    }

};

if (typeof module !== "undefined") {
    module.exports = {
        validDateParts, validHolidaySpan, holidaySpanDays, MAX_HOLIDAY_SPAN_DAYS,
        MAX_HOLIDAYS_PER_YEAR, MAX_EXPANDED_HOLIDAY_ROWS,
        enricoRegionCode, isoDateParts, IsoHolidayServiceAdapter, HolidayRecordContract,
        EnricoServiceAdapter, NagerDateServiceAdapter, OpenHolidaysServiceAdapter,
        HolidayServiceFallbackAdapter
    };
}
