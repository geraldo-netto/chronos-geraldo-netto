// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* global imports */

const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node);
const APPLET_MODULES = IS_NODE ? null :
    imports.ui.appletManager.applets["chronos@geraldo-netto"];
function sibling(name) {
    return APPLET_MODULES ? APPLET_MODULES[name] : require("./" + name);
}
const Constants = sibling("holidayConstants");
const Religious = sibling("religiousHolidays");
const PluginData = sibling("calendarPluginData");

function validCountrySelection(row) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const enabled = Object.hasOwn(row, "enabled") ? row.enabled : true;
    const rawRegion = Object.hasOwn(row, "region") ? row.region : "global";
    if (typeof enabled !== "boolean" || typeof rawRegion !== "string" ||
        !Constants.SUPPORTED_COUNTRIES.includes(row.country)) return null;
    const region = rawRegion.trim().toLowerCase() || "global";
    if (region !== "global" && !Object.getOwnPropertyDescriptor(
        Constants.REGION_TO_SUBDIVISION[row.country] || {}, region)) return null;
    return { country: row.country, region, enabled };
}

function countrySelections(rows) {
    if (!Array.isArray(rows)) return [];
    const selected = new Map();
    for (const row of rows.slice(0, 64)) {
        const value = validCountrySelection(row);
        if (!value) continue;
        const key = `${value.country}:${value.region}`;
        if (!selected.has(key)) selected.set(key, value);
    }
    return [...selected.values()].filter((value) => value.enabled).slice(0, 16)
        .map(({ country, region }) => ({ country, region }));
}

function publicMonthMap(map, label) {
    const result = new Map();
    for (const [key, entry] of map) {
        const name = label ? `${entry.name} (${label})` : entry.name;
        result.set(key, Constants.monthHolidayEntry(name, entry.flags));
    }
    return result;
}

function publicCalendar(id, provider, label = "") {
    return {
        id, name: label || "Public holidays", category: "country",
        get enabled() { return provider.active; },
        available: () => true,
        getHolidays(year, month, callback) {
            provider.getHolidays(year, month, (map, error, source) =>
                callback(publicMonthMap(map, label), error, source));
        },
        destroy: () => provider.destroy()
    };
}

function religiousCalendar(id, translate) {
    return {
        id: `religion:${id}`, name: id, category: "religious", enabled: true,
        available: (year) => Religious.uncoveredReligions(year, [id]).length === 0,
        getHolidays(year, month, callback) {
            callback(Religious.monthMap(year, month, [id], translate), "", "");
        }
    };
}

function manifestCalendar(manifest) {
    return {
        id: `plugin:${manifest.id}`, name: manifest.name, category: manifest.category,
        enabled: true,
        available: (year) => PluginData.manifestAvailable(manifest, year),
        getHolidays(year, month, callback) {
            callback(PluginData.manifestMonthMap(manifest, year, month), "", "");
        }
    };
}

function countryCalendarName(country, region) {
    const name = new Intl.DisplayNames(["en"], { type: "region" })
        .of(Constants.COUNTRY_TO_ISO2[country]);
    return region === "global" ? name : `${name} / ${region.toUpperCase()}`;
}

if (typeof module !== "undefined") {
    module.exports = { countrySelections, publicCalendar, religiousCalendar,
        manifestCalendar, countryCalendarName };
}
