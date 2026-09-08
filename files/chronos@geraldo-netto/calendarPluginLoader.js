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

function checkPluginInfo(source, result, expectedType, maximum) {
    const info = source.query_info_finish(result);
    if (info.get_is_symlink() || info.get_file_type() !== expectedType ||
        info.get_size() > maximum) {
        throw new Error("Calendar plugin: expected a regular file below 1 MiB and no symbolic links");
    }
}

function queryPluginInfo(file, expectedType, runtime, success, failure) {
    const { Gio, GLib } = runtime.gi;
    const maximum = expectedType === Gio.FileType.REGULAR ? MAX_PLUGIN_BYTES : Infinity;
    startIo((done) => file.query_info_async("standard::type,standard::is-symlink,standard::size",
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null, done),
    (source, result) => finishIo(() => checkPluginInfo(source, result, expectedType, maximum), success, failure), failure);
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
    startIo((done) => state.stream.read_bytes_async(limit, state.priority, null, done),
        (source, result) => finishIo(() => source.read_bytes_finish(result).get_data(),
            (chunk) => acceptPluginChunk(state, chunk), state.fail), state.fail);
}

function openPluginFile(file, runtime, callback) {
    const state = { priority: runtime.gi.GLib.PRIORITY_DEFAULT, chunks: [], size: 0, stream: null };
    let settled = false;
    state.finish = (raw) => {
        if (settled) return;
        settled = true;
        closePluginStream(state, () => callback(raw));
    };
    state.fail = (error) => { reportPluginError(error); state.finish(null); };
    startIo((done) => file.read_async(state.priority, null, done),
        (source, result) => finishIo(() => source.read_finish(result), (stream) => {
            state.stream = stream;
            readPluginChunk(state);
        }, state.fail), state.fail);
}

function readInstalledPlugin(id, callback) {
    if (selectedPluginIds([id]).length !== 1) {
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
    const failure = (error) => { reportPluginError(error); callback(null); };
    queryPluginInfo(Gio.file_new_for_path(directory), Gio.FileType.DIRECTORY, runtime, () =>
        queryPluginInfo(file, Gio.FileType.REGULAR, runtime,
            () => openPluginFile(file, runtime, callback), failure), failure);
}

var CalendarPluginLoader = class CalendarPluginLoader {
    constructor(params = {}) {
        this._read = params.read || readInstalledPlugin;
        this._report = params.report || reportPluginError;
        this._generation = 0;
        this._destroyed = false;
    }

    load(selection, callback) {
        if (this._destroyed) return;
        const generation = ++this._generation;
        const ids = selectedPluginIds(selection);
        const results = new Array(ids.length);
        let remaining = ids.length;
        if (!remaining) {
            callback([]);
            return;
        }
        ids.forEach((id, index) => this._loadOne(id, (manifest) => {
            if (this._destroyed || generation !== this._generation) return;
            results[index] = manifest;
            remaining--;
            if (!remaining) callback(results.filter(Boolean));
        }));
    }

    _loadOne(id, callback) {
        let settled = false;
        let callbackStarted = false;
        const finish = (raw) => {
            if (settled) return;
            settled = true;
            callbackStarted = true;
            callback(this._validate(id, raw));
        };
        try {
            this._read(id, finish);
        } catch (error) {
            if (callbackStarted) throw error;
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
        this._generation++;
    }
};

if (typeof module !== "undefined") {
    module.exports = { CalendarPluginLoader, selectedPluginIds, readInstalledPlugin };
}
