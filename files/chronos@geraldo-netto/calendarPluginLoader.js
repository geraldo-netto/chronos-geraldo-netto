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
const PluginData = APPLET_MODULES ? APPLET_MODULES.calendarPluginData : require("./calendarPluginData");
const MAX_PLUGIN_BYTES = 1024 * 1024;
const PLUGIN_READ_CHUNK = 65536;

function selectedPluginIds(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.filter((id) => typeof id === "string" && id.length <= 96 &&
        /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(id)))].slice(0, 32);
}

function reportWithoutThrowing(report, error) {
    try {
        report(error);
    } catch {
        // Reporting cannot prevent stream cleanup or settlement of other files.
    }
}

function reportPluginError(error) {
    reportWithoutThrowing((failure) => globalThis.global?.logError?.(failure), error);
}

function finishIo(work, success, failure) {
    let value;
    try {
        value = work();
    } catch (error) {
        failure(error);
        return;
    }
    success(value);
}

function startIo(start, success, failure) {
    let callbackStarted = false;
    try {
        start((source, result) => {
            callbackStarted = true;
            success(source, result);
        });
    } catch (error) {
        if (callbackStarted) throw error;
        failure(error);
    }
}

function checkPluginInfo(info, expectedType, maximum) {
    if (info.get_is_symlink() || info.get_file_type() !== expectedType ||
        info.get_size() > maximum) {
        throw new Error("Calendar plugin: expected a regular file below 1 MiB and no symbolic links");
    }
}

function continuePluginRead(state, next) {
    if (state.cancellable.is_cancelled()) {
        state.finish(null);
        return;
    }
    next();
}

function queryPluginInfo(file, expectedType, state, success) {
    const { Gio, GLib } = state.runtime.gi;
    const maximum = expectedType === Gio.FileType.REGULAR ? MAX_PLUGIN_BYTES : Infinity;
    startIo((done) => file.query_info_async("standard::type,standard::is-symlink,standard::size",
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, state.cancellable, done),
    (source, result) => finishIo(() => source.query_info_finish(result), (info) =>
        continuePluginRead(state, () => finishIo(() => checkPluginInfo(info, expectedType, maximum),
            success, state.fail)), state.fail), state.fail);
}

function closePluginStream(state, next) {
    if (!state.stream) {
        next();
        return;
    }
    const onError = (error) => { reportPluginError(error); next(); };
    startIo((done) => state.stream.close_async(state.priority, null, done),
        (source, result) => finishIo(() => source.close_finish(result), next, onError), onError);
}

function decodePluginChunks(state) {
    const bytes = new Uint8Array(state.size);
    let offset = 0;
    for (const chunk of state.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
}

function acceptPluginChunk(state, chunk) {
    state.size += chunk.length;
    if (state.size > MAX_PLUGIN_BYTES) {
        state.fail(new Error("Calendar plugin: file exceeds 1 MiB"));
        return;
    }
    if (chunk.length === 0) {
        finishIo(() => decodePluginChunks(state), state.finish, state.fail);
        return;
    }
    state.chunks.push(chunk);
    readPluginChunk(state);
}

function readPluginChunk(state) {
    const limit = Math.min(PLUGIN_READ_CHUNK, MAX_PLUGIN_BYTES + 1 - state.size);
    startIo((done) => state.stream.read_bytes_async(limit, state.priority, state.cancellable, done),
        (source, result) => finishIo(() => source.read_bytes_finish(result), (bytes) =>
            continuePluginRead(state, () => finishIo(() => bytes.get_data(),
                (chunk) => acceptPluginChunk(state, chunk), state.fail)), state.fail), state.fail);
}

function pluginReadState(runtime, cancellable, callback) {
    const state = { runtime, cancellable, priority: runtime.gi.GLib.PRIORITY_DEFAULT,
        chunks: [], size: 0, stream: null };
    let settled = false;
    state.finish = (raw) => {
        if (settled) return;
        settled = true;
        state.chunks = [];
        closePluginStream(state, () => callback(cancellable.is_cancelled() ? null : raw));
    };
    state.fail = (error) => {
        if (!cancellable.is_cancelled()) reportPluginError(error);
        state.finish(null);
    };
    return state;
}

function openPluginFile(file, state) {
    startIo((done) => file.read_async(state.priority, state.cancellable, done),
        (source, result) => finishIo(() => source.read_finish(result), (stream) => {
            state.stream = stream;
            continuePluginRead(state, () => readPluginChunk(state));
        }, state.fail), state.fail);
}

function readInstalledPlugin(id, cancellable, callback) {
    if (selectedPluginIds([id]).length !== 1 || cancellable.is_cancelled()) {
        callback(null);
        return;
    }
    const runtime = typeof imports === "undefined" ? globalThis.imports : imports;
    const { Gio, GLib } = runtime.gi;
    const configured = GLib.get_user_data_dir();
    const dataHome = GLib.path_is_absolute(configured) ? configured :
        GLib.build_filenamev([GLib.get_home_dir(), ".local", "share"]);
    const directory = GLib.build_filenamev([dataHome, "chronos@geraldo-netto", "calendars"]);
    const file = Gio.file_new_for_path(GLib.build_filenamev([directory, `${id}.json`]));
    const state = pluginReadState(runtime, cancellable, callback);
    queryPluginInfo(Gio.file_new_for_path(directory), Gio.FileType.DIRECTORY, state, () =>
        queryPluginInfo(file, Gio.FileType.REGULAR, state, () => openPluginFile(file, state)));
}

function createPluginCancellable() {
    const runtime = typeof imports === "undefined" ? globalThis.imports : imports;
    return new runtime.gi.Gio.Cancellable();
}

var CalendarPluginLoader = class CalendarPluginLoader {
    constructor(params = {}) {
        this._read = params.read || readInstalledPlugin;
        this._createCancellable = params.createCancellable || createPluginCancellable;
        this._report = params.report || reportPluginError;
        this._generation = 0;
        this._cancellable = null;
        this._destroyed = false;
    }

    load(selection, callback) {
        if (this._destroyed) return;
        const generation = this._retireGeneration();
        if (!this._isCurrent(generation)) return;
        const ids = selectedPluginIds(selection);
        const results = new Array(ids.length);
        let remaining = ids.length;
        if (!remaining) {
            callback([]);
            return;
        }
        const cancellable = this._createCancellable();
        this._cancellable = cancellable;
        ids.forEach((id, index) => this._loadOne(id, generation, cancellable, (manifest) => {
            if (!this._isCurrent(generation)) return;
            results[index] = manifest;
            remaining--;
            if (!remaining) callback(results.filter(Boolean));
        }));
    }

    _retireGeneration() {
        // Cancellation can synchronously complete reads from the old generation.
        const generation = ++this._generation;
        const previous = this._cancellable;
        this._cancellable = null;
        previous?.cancel();
        return generation;
    }

    _isCurrent(generation) {
        return !this._destroyed && generation === this._generation;
    }

    _loadOne(id, generation, cancellable, callback) {
        if (!this._isCurrent(generation)) return;
        let settled = false;
        let callbackStarted = false;
        const finish = (raw) => {
            if (settled || !this._isCurrent(generation)) return;
            settled = true;
            callbackStarted = true;
            callback(this._validate(id, raw));
        };
        try {
            this._read(id, cancellable, finish);
        } catch (error) {
            if (callbackStarted) throw error;
            if (!this._isCurrent(generation)) return;
            reportWithoutThrowing(this._report, error);
            finish(null);
        }
    }

    _validate(id, raw) {
        try {
            const manifest = PluginData.validateCalendarManifest(raw);
            if (manifest.id !== id) throw new Error(`Calendar plugin ${id}: filename and id differ`);
            return manifest;
        } catch (error) {
            reportWithoutThrowing(this._report, error);
            return null;
        }
    }

    destroy() {
        this._destroyed = true;
        this._retireGeneration();
    }
};

if (typeof module !== "undefined") {
    module.exports = { CalendarPluginLoader, selectedPluginIds, readInstalledPlugin };
}
