// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* eslint camelcase: "off" */

var HOLIDAY_ERRORS = { // NOSONAR [S3504] -- GJS importer export
    SERVICE_UNAVAILABLE: "Holiday service unavailable",
    INVALID_RESPONSE: "Holiday data unavailable"
};
var HOLIDAY_PROVIDER_NAMES = { // NOSONAR [S3504] -- GJS importer export
    ENRICO: "Enrico",
    OPEN_HOLIDAYS: "OpenHolidays",
    NAGER_DATE: "Nager.Date"
};
var GLOBAL_REGION = "global"; // NOSONAR [S3504] -- GJS importer export
// Every public row receives an explicit flag before it is merged with local
// religious observances. Vendor rows are allowed to carry an empty flag list,
// so absence of the religious flag alone cannot distinguish a public-only row
// from a merged public+religious row.
var PUBLIC_HOLIDAY_FLAG = "public_holiday"; // NOSONAR [S3504] -- GJS importer export
var RELIGIOUS_HOLIDAY_FLAG = "religious_holiday"; // NOSONAR [S3504] -- GJS importer export
// the countries the settings combobox offers; a value outside this list
// cannot be picked in the UI and no provider can answer for it
var SUPPORTED_COUNTRIES = [ // NOSONAR [S3504] -- GJS importer export
    "ago", "arg", "aus", "aut", "bel", "bih", "blr", "bgr", "bra", "can",
    "chl", "chn", "col", "hrv", "cyp", "cze", "dnk", "slv",
    "est", "esp", "fin", "fra", "deu", "grc", "hkg", "hun",
    "isl", "irl", "imn", "isr", "ita", "jpn", "kor", "xkx",
    "lva", "ltu", "lux", "mkd", "mne", "mex", "nld", "nzl",
    "nor", "per", "phl", "pol", "prt", "rou", "rus", "srb",
    "sgp", "svk", "svn", "zaf", "swe", "che", "tur", "ukr",
    "gbr", "usa"
];

// The ISO-639-1 language Nager.Date writes a country's `localName` in.
//
// The adapter used to tag that name `lang: "local"`, which `localizeName` can
// never select — it keeps only the message language or `en` — so the local name
// was fetched, validated, and then discarded on every non-English desktop. A
// real language tag is what makes it selectable, and it has to be the country's
// language rather than a generic "local" marker: a Spanish desktop asking for
// German holidays must still get the English name, not the German one.
//
// Sampled from the live API rather than assumed, because the multilingual
// countries each pick one: Belgium answers in Dutch, Switzerland in German,
// Ireland in Irish, Luxembourg in Luxembourgish, the Philippines in Tagalog.
// Norwegian is tagged `nb` because that is what Nager writes and what a
// Norwegian desktop's message locale reports; `no` would never match.
// Countries that answer in English are absent: their `localName` equals `name`,
// and a second `en` entry would only make the selection ambiguous.
var COUNTRY_TO_LANGUAGE = { // NOSONAR [S3504] -- GJS importer export
    ago: "pt",
    arg: "es",
    aut: "de",
    bel: "nl",
    bih: "bs",
    blr: "be",
    bgr: "bg",
    bra: "pt",
    che: "de",
    chl: "es",
    chn: "zh",
    col: "es",
    cyp: "el",
    cze: "cs",
    deu: "de",
    dnk: "da",
    esp: "es",
    est: "et",
    fin: "fi",
    fra: "fr",
    grc: "el",
    hkg: "zh",
    hrv: "hr",
    hun: "hu",
    irl: "ga",
    isl: "is",
    isr: "he",
    ita: "it",
    jpn: "ja",
    kor: "ko",
    ltu: "lt",
    lux: "lb",
    lva: "lv",
    mex: "es",
    mkd: "mk",
    mne: "sr",
    nld: "nl",
    nor: "nb",
    per: "es",
    phl: "tl",
    pol: "pl",
    prt: "pt",
    rou: "ro",
    rus: "ru",
    slv: "es",
    srb: "sr",
    svk: "sk",
    svn: "sl",
    swe: "sv",
    tur: "tr",
    ukr: "uk",
    xkx: "sq"
};

var OPEN_HOLIDAYS_COUNTRIES = { // NOSONAR [S3504] -- GJS importer export
    aut: true,
    bel: true,
    blr: true,
    bgr: true,
    bra: true,
    che: true,
    cze: true,
    deu: true,
    esp: true,
    est: true,
    fra: true,
    hrv: true,
    hun: true,
    irl: true,
    ita: true,
    ltu: true,
    lux: true,
    lva: true,
    mex: true,
    nld: true,
    pol: true,
    prt: true,
    rou: true,
    srb: true,
    svk: true,
    svn: true,
    swe: true,
    zaf: true
};
var COUNTRY_TO_ISO2 = { // NOSONAR [S3504] -- GJS importer export
    ago: "AO",
    arg: "AR",
    aus: "AU",
    aut: "AT",
    bel: "BE",
    bih: "BA",
    blr: "BY",
    bgr: "BG",
    bra: "BR",
    can: "CA",
    che: "CH",
    chl: "CL",
    chn: "CN",
    col: "CO",
    cyp: "CY",
    cze: "CZ",
    deu: "DE",
    dnk: "DK",
    esp: "ES",
    est: "EE",
    fin: "FI",
    fra: "FR",
    gbr: "GB",
    grc: "GR",
    hkg: "HK",
    hrv: "HR",
    hun: "HU",
    imn: "IM",
    irl: "IE",
    isl: "IS",
    isr: "IL",
    ita: "IT",
    jpn: "JP",
    kor: "KR",
    ltu: "LT",
    lux: "LU",
    lva: "LV",
    mex: "MX",
    mkd: "MK",
    mne: "ME",
    nld: "NL",
    nor: "NO",
    nzl: "NZ",
    per: "PE",
    phl: "PH",
    pol: "PL",
    prt: "PT",
    rou: "RO",
    rus: "RU",
    sgp: "SG",
    slv: "SV",
    srb: "RS",
    svk: "SK",
    svn: "SI",
    swe: "SE",
    tur: "TR",
    ukr: "UA",
    usa: "US",
    // Kosovo has no assigned ISO 3166-1 code; XK is the user-assigned one both
    // fallback providers key on
    xkx: "XK",
    zaf: "ZA"
};
var ISO2_TO_COUNTRY = {}; // NOSONAR [S3504] -- GJS importer export
for (let country of Object.keys(COUNTRY_TO_ISO2)) {
    ISO2_TO_COUNTRY[COUNTRY_TO_ISO2[country]] = country;
}

function countryFromIso2(code) {
    if (typeof code !== "string") {
        return "";
    }

    return ISO2_TO_COUNTRY[code.trim().toUpperCase()] || "";
}

var REGION_TO_SUBDIVISION = { // NOSONAR [S3504] -- GJS importer export
    aus: {
        act: "AU-ACT",
        nsw: "AU-NSW",
        nt: "AU-NT",
        qld: "AU-QLD",
        sa: "AU-SA",
        tas: "AU-TAS",
        vic: "AU-VIC",
        wa: "AU-WA"
    },
    bel: {
        bru: "BE-BRU",
        vlg: "BE-VLG",
        wal: "BE-WAL"
    },
    can: {
        ab: "CA-AB",
        bc: "CA-BC",
        mb: "CA-MB",
        nb: "CA-NB",
        nl: "CA-NL",
        ns: "CA-NS",
        nt: "CA-NT",
        nu: "CA-NU",
        on: "CA-ON",
        pe: "CA-PE",
        qc: "CA-QC",
        sk: "CA-SK",
        yt: "CA-YT"
    },
    che: {
        ag: "CH-AG",
        ai: "CH-AI",
        ar: "CH-AR",
        be: "CH-BE",
        bl: "CH-BL",
        bs: "CH-BS",
        fr: "CH-FR",
        ge: "CH-GE",
        gl: "CH-GL",
        gr: "CH-GR",
        ju: "CH-JU",
        lu: "CH-LU",
        ne: "CH-NE",
        nw: "CH-NW",
        ow: "CH-OW",
        sg: "CH-SG",
        sh: "CH-SH",
        so: "CH-SO",
        sz: "CH-SZ",
        tg: "CH-TG",
        ti: "CH-TI",
        ur: "CH-UR",
        vd: "CH-VD",
        vs: "CH-VS",
        zg: "CH-ZG",
        zh: "CH-ZH"
    },
    deu: {
        bb: "DE-BB",
        be: "DE-BE",
        bw: "DE-BW",
        by: "DE-BY",
        hb: "DE-HB",
        he: "DE-HE",
        hh: "DE-HH",
        mv: "DE-MV",
        ni: "DE-NI",
        nw: "DE-NW",
        rp: "DE-RP",
        sh: "DE-SH",
        sl: "DE-SL",
        sn: "DE-SN",
        st: "DE-ST",
        th: "DE-TH"
    },
    esp: {
        an: "ES-AN",
        ar: "ES-AR",
        as: "ES-AS",
        cb: "ES-CB",
        ce: "ES-CE",
        cl: "ES-CL",
        cm: "ES-CM",
        cn: "ES-CN",
        ct: "ES-CT",
        ex: "ES-EX",
        ga: "ES-GA",
        ib: "ES-IB",
        mc: "ES-MC",
        md: "ES-MD",
        ml: "ES-ML",
        nc: "ES-NC",
        pv: "ES-PV",
        ri: "ES-RI",
        vc: "ES-VC"
    },
    gbr: {
        eng: "GB-ENG",
        nir: "GB-NIR",
        sct: "GB-SCT",
        wls: "GB-WLS"
    },
    nzl: {
        auk: "NZ-AUK",
        bop: "NZ-BOP",
        can: "NZ-CAN",
        cit: "NZ-CIT",
        gis: "NZ-GIS",
        hkb: "NZ-HKB",
        mbh: "NZ-MBH",
        mwt: "NZ-MWT",
        nsn: "NZ-NSN",
        ntl: "NZ-NTL",
        ota: "NZ-OTA",
        stl: "NZ-STL",
        tas: "NZ-TAS",
        tki: "NZ-TKI",
        wgn: "NZ-WGN",
        wko: "NZ-WKO",
        wtc: "NZ-WTC"
    },
    svk: {
        bc: "SK-BC",
        bl: "SK-BL",
        ki: "SK-KI",
        ni: "SK-NI",
        pv: "SK-PV",
        ta: "SK-TA",
        tc: "SK-TC",
        zi: "SK-ZI"
    },
    usa: {
        al: "US-AL",
        ak: "US-AK",
        ar: "US-AR",
        az: "US-AZ",
        ca: "US-CA",
        co: "US-CO",
        ct: "US-CT",
        dc: "US-DC",
        de: "US-DE",
        fl: "US-FL",
        ga: "US-GA",
        hi: "US-HI",
        ia: "US-IA",
        id: "US-ID",
        il: "US-IL",
        in: "US-IN",
        ks: "US-KS",
        ky: "US-KY",
        la: "US-LA",
        ma: "US-MA",
        md: "US-MD",
        me: "US-ME",
        mi: "US-MI",
        mn: "US-MN",
        mo: "US-MO",
        ms: "US-MS",
        mt: "US-MT",
        nc: "US-NC",
        nd: "US-ND",
        ne: "US-NE",
        nh: "US-NH",
        nj: "US-NJ",
        nm: "US-NM",
        nv: "US-NV",
        ny: "US-NY",
        oh: "US-OH",
        ok: "US-OK",
        or: "US-OR",
        pa: "US-PA",
        ri: "US-RI",
        sc: "US-SC",
        sd: "US-SD",
        tn: "US-TN",
        tx: "US-TX",
        ut: "US-UT",
        va: "US-VA",
        vt: "US-VT",
        wa: "US-WA",
        wi: "US-WI",
        wv: "US-WV",
        wy: "US-WY"
    }
};

// Which countries get a region selector is a property of the release, not a
// user choice, but it used to be a `generic` schema default read back out of the
// *instance* file. Cinnamon keeps the stored value for a generic key across an
// upgrade, so the array froze at whatever shipped on first install: a release
// that added a region-capable country still rendered its new combobox — the
// `dependency: country=<new>` is satisfied by the country key alone — while
// `bindRegions()` never bound the key, so every choice made in it was discarded
// and nationwide holidays were requested silently. Deriving it from the
// subdivision table also removes the second place the list could be wrong.
var REGION_COUNTRIES = Object.keys(REGION_TO_SUBDIVISION); // NOSONAR [S3504] -- GJS importer export


if (typeof module !== "undefined") {
    module.exports = { HOLIDAY_ERRORS, HOLIDAY_PROVIDER_NAMES, GLOBAL_REGION, PUBLIC_HOLIDAY_FLAG, RELIGIOUS_HOLIDAY_FLAG, SUPPORTED_COUNTRIES, OPEN_HOLIDAYS_COUNTRIES, COUNTRY_TO_ISO2, ISO2_TO_COUNTRY, countryFromIso2, REGION_TO_SUBDIVISION, REGION_COUNTRIES, COUNTRY_TO_LANGUAGE };
}
