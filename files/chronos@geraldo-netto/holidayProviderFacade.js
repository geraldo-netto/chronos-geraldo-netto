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

// The calendar-facing provider contract and its source registry. The facade
// narrows HolidayService to place selection and month retrieval; the aggregate
// composes country, religious and installed calendar adapters through that same
// contract. File access and HTTP remain in the injected loader and providers.

const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const APPLET_MODULES = IS_NODE ?
    null : imports.ui.appletManager.applets["chronos@geraldo-netto"];

function sibling(name) {
    return APPLET_MODULES ? APPLET_MODULES[name] : require("./" + name); // NOSONAR [S7773] -- the Node guard is APPLET_MODULES
}

const HolidayConstants = sibling("holidayConstants");
const ReligiousHolidays = sibling("religiousHolidays");
const CalendarRegistry = sibling("calendarRegistry").CalendarRegistry;
const CalendarAdapters = sibling("calendarSourceAdapters");
const TextUtils = sibling("textUtils");

const GLOBAL_REGION = HolidayConstants.GLOBAL_REGION;

var HolidayProviderFacade = class HolidayProviderFacade { // NOSONAR [S3504] -- GJS importer export
    constructor(provider) {
        this._provider = provider;
    }

    get country() {
        return this._provider.country;
    }

    // whether this provider has anything to annotate: the calendar gates on
    // this, never on country-truthiness
    get active() {
        return Boolean(this._provider.country);
    }

    destroy() {
        this._provider.destroy();
    }

    clearPlace() {
        this._provider.clearPlace();
    }

    setPlace(country, region = GLOBAL_REGION, onUpdated) { // NOSONAR [S1788] -- accepted compatible form
        this._provider.setPlace(country, region, onUpdated);
    }

    getHolidays(year, month, callback) {
        this._provider.getHolidays(year, month, callback);
    }
};

// Keeps the existing provider entry point while aggregating every selected
// source. Registry ordering preserves the primary country's names first;
// each adapter owns its coverage and attribution. Religious catalogue memos
// remain shared across instances and are released at teardown.
var ReligiousHolidayProvider = class ReligiousHolidayProvider { // NOSONAR [S3504] -- GJS importer export
    constructor(provider, enabledIds = [], translateName = (text) => text, options = {}) {
        this._base = provider;
        this._translateName = translateName;
        this._registry = new CalendarRegistry();
        this._registry.register(CalendarAdapters.publicCalendar("builtin:country", provider));
        this._religionAdapters = [];
        this._countryAdapters = [];
        this._pluginAdapters = [];
        this._countries = [];
        this._region = GLOBAL_REGION;
        this._createCountry = options.createCountry;
        this._pluginLoader = options.pluginLoader;
        this._destroyed = false;
        this._placeGeneration = 0;
        this._countriesGeneration = 0;
        this.setEnabledIds(enabledIds);
    }

    get country() {
        return this._base.country;
    }

    get active() {
        return this._registry.active;
    }

    setEnabledIds(enabledIds) {
        if (this._destroyed) return;
        this._enabledIds = ReligiousHolidays.enabledReligionIds(enabledIds);
        const adapters = this._enabledIds.map((id) =>
            CalendarAdapters.religiousCalendar(id, this._translateName));
        this._religionAdapters = this._replaceAdapters(this._religionAdapters, adapters);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._pluginLoader?.destroy();
        this._registry.destroy();
        // The catalogue's memos are module scope and shared by every applet
        // instance, so nothing else would ever drop them: without this they
        // outlive the last applet for the rest of the login session.
        ReligiousHolidays.releaseMemos();
    }

    clearPlace() {
        if (this._destroyed) return;
        this._placeGeneration++;
        this._base.clearPlace();
        this._region = GLOBAL_REGION;
        this._rebuildCountries();
    }

    setPlace(country, region, onUpdated) {
        if (this._destroyed) return;
        const generation = ++this._placeGeneration;
        const update = this._deferredUpdate(onUpdated, () => generation === this._placeGeneration);
        this._base.setPlace(country, region, update.notify);
        this._region = region || GLOBAL_REGION;
        this._rebuildCountries(update.notify, false);
        update.publish(false);
    }

    // Synchronous cache answers must not expose a registry still being rebuilt.
    // Later asynchronous answers use the same notifier until their selection ends.
    _deferredUpdate(onUpdated = () => {}, current) {
        let published = false;
        let requested = false;
        const notify = () => {
            if (!published) {
                requested = true;
                return;
            }
            if (!this._destroyed && current()) onUpdated();
        };
        return { notify, publish(force) {
            published = true;
            if (force || requested) notify();
        } };
    }

    _replaceAdapters(previous, adapters) {
        previous.forEach((id) => this._registry.unregister(id));
        adapters.forEach((adapter) => this._registry.register(adapter));
        return adapters.map((adapter) => adapter.id);
    }

    setCountries(rows, onUpdated) {
        if (this._destroyed) return;
        this._countries = CalendarAdapters.countrySelections(rows);
        this._rebuildCountries(onUpdated);
    }

    _rebuildCountries(onUpdated = () => {}, forceUpdate = true) {
        if (this._destroyed) return;
        const generation = ++this._countriesGeneration;
        const update = this._deferredUpdate(onUpdated, () => generation === this._countriesGeneration);
        const changed = this._createCountry ? this._registerCountries(update.notify) : false;
        update.publish(forceUpdate || changed);
    }

    _registerCountries(onUpdated) {
        const rows = this._countries.filter(({ country, region }) =>
            country !== this.country || region !== this._region);
        const adapters = rows.map((row) => this._countryAdapter(row, onUpdated));
        const changed = this._countryAdapters.length > 0 || adapters.length > 0;
        this._countryAdapters = this._replaceAdapters(this._countryAdapters, adapters);
        return changed;
    }

    _countryAdapter({ country, region }, onUpdated) {
        const provider = this._createCountry(country, region);
        provider.setPlace(country, region, onUpdated);
        return CalendarAdapters.publicCalendar(`country:${country}:${region}`, provider,
            CalendarAdapters.countryCalendarName(country, region));
    }

    setPluginIds(ids, onUpdated = () => {}) {
        if (this._destroyed) return;
        this._pluginAdapters = this._replaceAdapters(this._pluginAdapters, []);
        if (!this._pluginLoader) return;
        this._pluginLoader.load(ids, (manifests) => {
            if (this._destroyed) return;
            this._pluginAdapters = this._replaceAdapters(this._pluginAdapters,
                manifests.map(CalendarAdapters.manifestCalendar));
            onUpdated();
        });
    }

    getHolidays(year, month, callback) {
        this._registry.getHolidays(TextUtils.numericInput(year), TextUtils.numericInput(month), callback);
    }
};

if (typeof module !== "undefined") {
    module.exports = { HolidayProviderFacade, ReligiousHolidayProvider };
}
