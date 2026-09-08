// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

/* global imports */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const HolidayRecord = IS_NODE ?
    require("./holidayRecord") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayRecord;
const HolidayConstants = IS_NODE ?
    require("./holidayConstants") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].holidayConstants;
const ERRORS = HolidayConstants.HOLIDAY_ERRORS;
const SOURCE_GROUPS = new Map([["country", 1], ["religion", 2], ["plugin", 3]]);

function sourceGroup(id) {
    return id === "builtin:country" ? 0 : (SOURCE_GROUPS.get(id.split(":")[0]) || 4);
}

function compareAdapters(left, right) {
    const group = sourceGroup(left.id) - sourceGroup(right.id);
    if (group !== 0) return group;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
}

function enabledAdapter(adapter) {
    try {
        return adapter.enabled === true;
    } catch {
        return false;
    }
}

function validateAdapter(adapter) {
    if (!adapter || typeof adapter.id !== "string" || adapter.id.length > 128 ||
        !/^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(adapter.id)) {
        throw new Error("Calendar adapter requires a namespaced identifier");
    }
    for (const field of ["name", "category"]) {
        if (typeof adapter[field] !== "string" || !adapter[field].trim() || adapter[field].length > 160) {
            throw new Error(`Calendar adapter requires bounded ${field} text`);
        }
    }
    if (typeof adapter.enabled !== "boolean" || typeof adapter.available !== "function" ||
        typeof adapter.getHolidays !== "function") {
        throw new Error("Calendar adapter requires enabled, available and getHolidays");
    }
    if (adapter.destroy !== undefined && typeof adapter.destroy !== "function") {
        throw new Error("Calendar adapter destroy must be a function");
    }
}

function availableAdapter(adapter, year) {
    try {
        return adapter.available(year) === true;
    } catch {
        return false;
    }
}

function requestState(adapter, year) {
    const state = { adapter, answered: false, map: new Map(), error: "", provider: adapter.name };
    try {
        if (!adapter.enabled) return null;
        return adapter.available(year) === true ? state : null;
    } catch {
        state.answered = true;
        state.error = ERRORS.SERVICE_UNAVAILABLE;
        return state;
    }
}

function validMonthEntry(key, entry, year, month) {
    if (typeof key !== "string" || !new RegExp(`^${month}/(?:[1-9]|[12][0-9]|3[01])$`).test(key)) {
        return false;
    }
    const day = Number(key.split("/")[1]);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return entry && typeof entry.name === "string" &&
        HolidayRecord.validHolidayFlags(entry.flags) && date.getUTCDate() === day;
}

function copyMonthMap(map, year, month) {
    if (!(map instanceof Map) || map.size > 31) {
        throw new Error("Invalid calendar month map");
    }
    const copy = new Map();
    for (const [key, entry] of map) {
        if (!validMonthEntry(key, entry, year, month)) {
            throw new Error("Invalid calendar month entry");
        }
        copy.set(key, HolidayRecord.joinHolidayEntry(null, entry.name, entry.flags));
    }
    return copy;
}

function acceptAnswer(state, map, error, provider, year, month) {
    state.answered = true;
    state.error = error ? ERRORS.INVALID_RESPONSE : "";
    if (HolidayConstants.isHolidayErrorCode(error)) {
        state.error = error;
    }
    state.provider = typeof provider === "string" && provider.length <= 160 ? provider : state.adapter.name;
    try {
        state.map = copyMonthMap(map, year, month);
    } catch {
        state.map = new Map();
        state.error = ERRORS.INVALID_RESPONSE;
    }
}

function combinedAnswer(states) {
    const map = new Map();
    const providers = new Set();
    let error = "";
    for (const state of states) {
        error = error || state.error;
        if (state.provider) {
            providers.add(state.provider);
        }
        for (const [key, entry] of state.map) {
            map.set(key, HolidayRecord.joinHolidayEntry(map.get(key), entry.name, entry.flags));
        }
    }
    return { map, error, provider: Array.from(providers).join(", ") };
}

var CalendarRegistry = class CalendarRegistry { // NOSONAR [S3504] -- GJS importer export
    constructor() {
        this._adapters = new Map();
        this._generation = 0;
        this._destroyed = false;
    }

    register(adapter) {
        if (this._destroyed) {
            throw new Error("Calendar registry has been destroyed");
        }
        validateAdapter(adapter);
        if (this._adapters.has(adapter.id)) {
            throw new Error("Calendar adapter identifier is already registered");
        }
        if (this._adapters.size >= 64) {
            throw new Error("Calendar registry supports at most 64 adapters");
        }
        this._adapters.set(adapter.id, adapter);
        this._generation++;
    }

    unregister(id) {
        const adapter = this._adapters.get(id);
        if (!adapter) {
            return false;
        }
        this._adapters.delete(id);
        this._generation++;
        this._destroyAdapter(adapter);
        return true;
    }

    list(year) {
        return this._orderedAdapters()
            .filter((adapter) => availableAdapter(adapter, year));
    }

    get active() {
        return Array.from(this._adapters.values()).some(enabledAdapter);
    }

    _orderedAdapters() {
        return Array.from(this._adapters.values()).sort(compareAdapters);
    }

    _current(request) {
        return !this._destroyed && request.generation === this._generation;
    }

    _emit(request) {
        if (!this._current(request) || request.dispatching ||
            request.states.some((state) => !state.answered)) {
            return;
        }
        const result = combinedAnswer(request.states);
        request.callback(result.map, result.error, result.provider);
    }

    _receive(request, state, map, error, provider) {
        if (this._current(request)) {
            acceptAnswer(state, map, error, provider, request.year, request.month);
            this._emit(request);
        }
    }

    _dispatch(request, state) {
        if (state.answered || !this._current(request)) {
            return;
        }
        try {
            state.adapter.getHolidays(request.year, request.month, (map, error, provider) =>
                this._receive(request, state, map, error, provider));
        } catch {
            this._receive(request, state, new Map(), ERRORS.SERVICE_UNAVAILABLE, state.adapter.name);
        }
    }

    getHolidays(year, month, callback) {
        if (this._destroyed) {
            return;
        }
        if (!Number.isInteger(year) || year < 1 || year > 9999 ||
            !Number.isInteger(month) || month < 1 || month > 12) {
            callback(new Map(), ERRORS.INVALID_RESPONSE, "");
            return;
        }
        const request = {
            year, month, callback, generation: this._generation, dispatching: true,
            states: this._orderedAdapters()
                .map((adapter) => requestState(adapter, year)).filter(Boolean)
        };
        for (const state of request.states) {
            this._dispatch(request, state);
        }
        request.dispatching = false;
        this._emit(request);
    }

    _destroyAdapter(adapter) {
        if (typeof adapter.destroy !== "function") {
            return;
        }
        try {
            adapter.destroy();
        } catch {
            // A broken cleanup must not retain the other providers or revive callbacks.
        }
    }

    destroy() {
        if (this._destroyed) {
            return;
        }
        this._destroyed = true;
        this._generation++;
        const adapters = Array.from(this._adapters.values());
        this._adapters.clear();
        for (const adapter of adapters) {
            this._destroyAdapter(adapter);
        }
    }
};

if (typeof module !== "undefined") {
    module.exports = { CalendarRegistry };
}
