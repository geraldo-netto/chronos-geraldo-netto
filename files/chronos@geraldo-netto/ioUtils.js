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

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const Gio = GjsImports.gi.Gio;
const GLib = GjsImports.gi.GLib;
const Soup = GjsImports.gi.Soup;
const IS_NODE = typeof process !== "undefined" &&
    Boolean(process.versions && process.versions.node); // NOSONAR [S6582] -- accepted compatible form
const TextUtils = IS_NODE ?
    require("./textUtils") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].textUtils;
const Diagnostics = IS_NODE ?
    require("./diagnostics") :
    GjsImports.ui.appletManager.applets["chronos@geraldo-netto"].diagnostics;

var urlForLog = TextUtils.urlForLog; // NOSONAR [S3504] -- GJS importer export

var HTTP_TIMEOUT_SECONDS = 30; // NOSONAR [S3504] -- GJS importer export
// Session:timeout above is a per-read socket timeout: an endpoint that keeps
// trickling bytes resets it forever, so one request could stay in flight for
// days while everything serialized behind it — the Nominatim queue, a year's
// in-flight holiday entry, the scheduler's settle — starved. This is the
// whole-request clock the socket timeout cannot provide.
var HTTP_DEADLINE_SECONDS = 2 * HTTP_TIMEOUT_SECONDS; // NOSONAR [S3504] -- GJS importer export
// Responses are parsed on the compositor thread and the holiday payloads are
// tens of kilobytes; anything past this is a broken or hostile endpoint, and
// parsing it would balloon the Cinnamon process.
var MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // NOSONAR [S3504] -- GJS importer export
// The same argument, for the same parse, on the same thread — the only
// difference is that this payload comes off the disk rather than the network.
// ~/.cache/chronos@geraldo-netto/holidays.json is writable by anything running
// as the user, and it was read with no bound at all while the network body it
// was built from was capped. A real cache file is tens of kilobytes.
var MAX_CACHE_FILE_BYTES = 4 * 1024 * 1024; // NOSONAR [S3504] -- GJS importer export

const JSON_UPDATE_QUEUES = new Map();

// Root modules are shared by applets in one Cinnamon process. Gio checks an
// etag before opening a replacement stream, so it cannot serialize overlapping
// publications. Keep the entire read/transform/write inside one per-file turn.
function updateJsonFileAsync(file, transform, onDone) {
    const key = file.get_path();
    const queued = JSON_UPDATE_QUEUES.has(key);
    const queue = JSON_UPDATE_QUEUES.get(key) || [];
    queue.push({ file, transform, onDone });
    JSON_UPDATE_QUEUES.set(key, queue);
    if (!queued) {
        _runJsonUpdate(key, queue);
    }
}

function _runJsonUpdate(key, queue) {
    const job = queue[0];
    let settled = false;
    const finish = (stale = false) => {
        if (settled) return;
        settled = true;
        queue.shift();
        try {
            job.onDone(stale);
        } finally {
            if (queue.length > 0) _runJsonUpdate(key, queue);
            else JSON_UPDATE_QUEUES.delete(key);
        }
    };
    readJsonFileAsync(job.file, (data, etag) => {
        if (settled) return;
        try {
            writeJsonFileAsync(job.file, job.transform(data), finish, etag);
        } catch (error) {
            Diagnostics.logSafely("logError", error);
            finish();
        }
    });
}

function tooBig(size, limit, what) {
    if (!Number.isFinite(size) || size <= limit) {
        return false;
    }

    Diagnostics.logSafely("logError", `${what} is ${size} bytes, past the ${limit}-byte cap; ignoring it`);
    return true;
}

// TextDecoder is present in every GJS that ships with Cinnamon 5.4 and in Node,
// which are the only two hosts this code runs in. The imports.byteArray fallback
// that used to sit here was a compat shim for a GJS this applet cannot be loaded
// by — deprecated upstream, and unreachable here.
function decodeUtf8(data) {
    return new TextDecoder().decode(data);
}

// The one synchronous read this applet makes, and the two files it makes it on:
// /etc/timezone and /usr/share/zoneinfo/zone.tab, both on the once-per-install
// path that derives a holiday country from the OS zone.
//
// It lives here because this is the module that owns file reading. worldclockData
// carried its own copy - GLib.file_get_contents behind its own two byte caps -
// so it was a second I/O regime that nothing applied here could reach, and the
// two disagreed on failure: this one says an oversized file was ignored, that
// one answered "" without a word. The bound is the caller's, because these two
// files are nothing like a holiday cache in size.
// These system paths are trusted to be administrator-controlled. The check
// deliberately follows the read: it rejects oversized input but does not cap
// memory allocated by GLib. See docs/settings-behavior.md before using this
// helper for any path or contents an untrusted party can influence.
function readTextFileCapped(filename, maximumBytes, what = filename) {
    try {
        const [success, contents] = GLib.file_get_contents(filename);
        if (!success || contents === null || contents === undefined ||
            tooBig(contents.length, maximumBytes, what)) {
            return "";
        }
        return typeof contents === "string" ? contents : decodeUtf8(contents);
    } catch {
        return "";
    }
}

// The cache file is read while the applet is being constructed, i.e. on the
// compositor thread during Cinnamon startup and every reload. Reading it
// asynchronously keeps the shell responsive; callers repaint when it lands.
//
// There used to be a synchronous readJsonFile beside this, reached only when
// the file had no load_contents_async — which is to say never: Cinnamon 5.4,
// the oldest release this applet loads on, ships GLib 2.72, where every
// Gio.File has it. The only thing that ever took that branch was a test double
// too thin to have one. Same story for the sync write below.
// A file that is missing, oversized, corrupt or not an object all mean the same
// thing to a caller: there is no cache. Only the etag distinguishes them, and it
// is null unless Gio handed one back.
function _parseCacheFile(contents, ok) {
    if (!ok || tooBig(contents.length, MAX_CACHE_FILE_BYTES, "the holiday cache file")) {
        return {};
    }

    const parsed = JSON.parse(decodeUtf8(contents));

    // The cache is a country-keyed mapping. Arrays are objects in JavaScript,
    // but string-key properties written onto one disappear when JSON.stringify
    // serializes it, so accepting an array here would make the next save look
    // successful while dropping every pending country.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

// The cap was applied inside _parseCacheFile — that is, after
// load_contents_async had already put the whole file in the compositor's
// address space. The bound documented an intent nothing enforced: the network
// body it was written to mirror is refused by a declared-length check *before*
// the read and a chunked read that stops mid-stream, while the disk path let
// any size land first. Ask the filesystem how big it is and refuse before
// issuing the read; the post-read check in _parseCacheFile stays as the
// backstop for a file that grew between the two calls.
const FILE_SIZE_ATTRIBUTE = "standard::size";

function _cacheFileWithinCap(source, result) {
    const size = source.query_info_finish(result).get_size();
    return !tooBig(size, MAX_CACHE_FILE_BYTES, "the holiday cache file");
}

// The stat below answers "is there a cache file, and how big is it" in one
// asynchronous call, so a missing one is an ordinary G_IO_ERROR_NOT_FOUND
// rather than a fault. This used to be a `file.query_exists(null)` above the
// read — a blocking stat on the compositor thread, in the function whose header
// says the read is asynchronous so the shell stays responsive, on every applet
// construction and reload. It was load-bearing for one thing only: keeping the
// first run, where the cache has simply never been written, off the error log.
// That is this branch's job now.
function _whenCacheFileIsSane(file, callback, proceed) {
    file.query_info_async(FILE_SIZE_ATTRIBUTE, Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT, null, (source, result) => {
            let within = false;
            try {
                within = _cacheFileWithinCap(source, result);
            } catch (e) {
                if (!_isMissingFile(e)) {
                    Diagnostics.logSafely("logError", e);
                }
            }

            if (within) {
                proceed();
            } else {
                callback({});
            }
        });
}

function readJsonFileAsync (file, callback) {
    try {
        _whenCacheFileIsSane(file, callback, () => _loadCacheFile(file, callback));
    } catch (e) {
        Diagnostics.logSafely("logError", e);
        callback({});
    }
}

function _loadCacheFile(file, callback) {
    try {
        file.load_contents_async(null, (source, result) => {
            let data = {};
            let etag = null;
            try {
                // Etags detect changes before the replacement stream opens.
                // updateJsonFileAsync also excludes overlapping publications.
                const [ok, contents, tag] = source.load_contents_finish(result);
                etag = tag || null;
                data = _parseCacheFile(contents, ok);
            } catch (e) {
                Diagnostics.logSafely("logError", e);
            }
            callback(data, etag);
        });
    } catch (e) {
        Diagnostics.logSafely("logError", e);
        callback({});
    }
}

// The cache write happens on the compositor thread, so it goes through Gio's
// async API. `onDone` fires whether the write succeeded or failed: the caller
// needs it to know when the file is settled, not whether it liked the outcome.
function _notifyWriteDone(onDone, stale = false) {
    if (typeof onDone === "function") {
        onDone(stale);
    }
}

function _finishJsonWrite(source, result, onDone) {
    try {
        source.replace_contents_finish(result);
    } catch (e) {
        if (_isWrongEtag(e)) {
            // not an error: someone else got there first
            _notifyWriteDone(onDone, true);
            return;
        }
        Diagnostics.logSafely("logError", e);
    }
    _notifyWriteDone(onDone);
}

function writeJsonFileAsync (file, data, onDone, etag = null) {
    // `stale` detects an external edit before Gio opens the replacement stream;
    // callers updating shared snapshots use updateJsonFileAsync for exclusion.
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    // a file the read path would refuse must not be written: readJsonFileAsync
    // caps what it loads, so writing past the cap only parks bytes the next
    // startup throws away
    if (tooBig(bytes.length, MAX_CACHE_FILE_BYTES, "cache file write")) {
        _notifyWriteDone(onDone);
        return;
    }
    try {
        file.replace_contents_async(bytes, etag, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            (source, result) => _finishJsonWrite(source, result, onDone));
    } catch (e) {
        Diagnostics.logSafely("logError", e);
        _notifyWriteDone(onDone);
    }
}

// Gio reports both of these as a GError code; a host without IOErrorEnum, and a
// test double raising a plain Error, are matched on the message instead.
function _matchesIoError(error, codeName, fallbackPattern) {
    if (!error) {
        return false;
    }

    if (Gio.IOErrorEnum && typeof error.matches === "function") {
        return error.matches(Gio.io_error_quark(), Gio.IOErrorEnum[codeName]);
    }

    return fallbackPattern.test(String(error && error.message ? error.message : error)); // NOSONAR [S6582] -- accepted compatible form
}

function _isWrongEtag(error) {
    return _matchesIoError(error, "WRONG_ETAG", /wrong.?etag/i);
}

function _isMissingFile(error) {
    return _matchesIoError(error, "NOT_FOUND", /no such file|not found|ENOENT/i);
}

function _setRequestHeaders(message, headers) {
    if (!headers) {
        return;
    }

    const requestHeaders = message.request_headers;
    if (!requestHeaders || !requestHeaders.append) { // NOSONAR [S6582] -- accepted compatible form
        return;
    }

    for (let header of Object.keys(headers)) {
        requestHeaders.append(header, headers[header]);
    }
}

function createHttpSession(options = {}) {
    const session = new Soup.Session();
    if (options.timeout !== undefined) {
        session.timeout = options.timeout;
    }
    if (options.idleTimeout !== undefined) {
        session.idle_timeout = options.idleTimeout;
    }
    return session;
}

// Soup buffers the whole body before it hands it over, so checking the length
// afterwards proves only that the memory was already spent — a hostile or
// broken endpoint could make the compositor allocate gigabytes and the 4 MiB
// constant would document an intent nothing enforced. The declared length is
// the one thing available before the read, so refuse on that.
function _declaredTooLarge(message) {
    const headers = message.response_headers;
    if (!headers) {
        return false;
    }

    const declared = headers.get_content_length();

    return Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES;
}

// Read a body in bounded chunks and stop the instant the running total passes
// the cap, rather than letting the whole thing land in memory first. This is
// what closes the chunked-transfer hole: a response with no Content-Length slips
// past _declaredTooLarge, and a whole-body read would have spent the memory
// before any post-read length check could look.
var READ_CHUNK_BYTES = 64 * 1024; // NOSONAR [S3504] -- GJS importer export

function _concatChunks(chunks, total) {
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
    }
    return body;
}

// libsoup hands the response body over as a GInputStream, and holds the
// connection behind it until that stream is closed. GJS closes it on
// finalization — and a compositor process does not collect promptly, so a
// stream simply dropped parks a connection for an indefinite time. The applet
// issues one holiday fetch plus up to nine weather requests every refresh
// period (the panel and eight cities, each a geocode and a forecast), so they
// accumulate. A failure to close is not actionable here: the body has either
// been read to the end or been abandoned deliberately.
function _closeStream(stream) {
    if (!stream || typeof stream.close !== "function") {
        return;
    }

    try {
        stream.close(null);
    } catch (e) {
        Diagnostics.logSafely("logError", e);
    }
}

// Every way this read can end goes through here, so the stream is released
// exactly once whether the body finished, outgrew the cap, or errored.
function _settleRead(stream, deliver, error, body) {
    _closeStream(stream);
    deliver(error, body);
}

// Cancel first: that is what stops the session delivering more of a body we
// have decided not to take, and the close releases what it already has.
function _abortRead(stream, cancellable, deliver, error) {
    if (cancellable) {
        cancellable.cancel();
    }
    _settleRead(stream, deliver, error, null);
}

// One chunk, and which of the three exits it takes.
function _acceptChunk(source, result, state, url, exits) {
    let chunk;
    try {
        chunk = source.read_bytes_finish(result).get_data();
    } catch (e) {
        exits.abort(e);
        return;
    }

    if (!chunk || chunk.length === 0) {
        exits.settle(_concatChunks(state.chunks, state.total));
        return;
    }

    state.total += chunk.length;
    if (state.total > MAX_RESPONSE_BYTES) {
        exits.abort(_tooLarge(url, "exceeds"));
        return;
    }

    state.chunks.push(chunk);
    exits.readMore();
}

function _readNextChunk(stream, cancellable, url, state, exits) {
    let callbackStarted = false;
    _dispatchOrFail(
        () => stream.read_bytes_async(READ_CHUNK_BYTES, 0, cancellable, (source, result) => {
            callbackStarted = true;
            _acceptChunk(source, result, state, url, exits);
        }),
        () => callbackStarted,
        exits.abort);
}

function _readCapped(stream, cancellable, url, deliver) {
    const state = { chunks: [], total: 0 };
    const exits = {
        settle: (body) => _settleRead(stream, deliver, null, body),
        abort: (error) => _abortRead(stream, cancellable, deliver, error),
        readMore: () => _readNextChunk(stream, cancellable, url, state, exits)
    };

    exits.readMore();
}

function _tooLarge(url, what) {
    return new Error("response from " + urlForLog(url) + " " + what + " " +
        MAX_RESPONSE_BYTES + " bytes");
}

// A declared length that lies, or is absent, is the chunked-transfer hole: this
// is the pre-read guard, and the capped read is the one that closes it.
function _refuseDeclaredTooLarge(message, url) {
    if (_declaredTooLarge(message)) {
        throw _tooLarge(url, "declares more than");
    }
}

// Throws on anything that is not a payload; the caller turns a throw into a null
// result, which is what every caller of httpGetJson already treats as failure.
function _jsonFromBody(message, url, body) {
    if (_downgraded(message, url)) {
        throw new Error("refusing a response from " + urlForLog(url) + " redirected to plain http");
    }

    if (message.get_status() !== 200) {
        Diagnostics.logSafely("logError", "HTTP " + message.get_status() + " fetching " + urlForLog(url));
        return null;
    }

    // the declared length can lie, or be absent entirely; the capped read already
    // enforced this on the streaming path
    if (body && body.length > MAX_RESPONSE_BYTES) {
        throw _tooLarge(url, "exceeds");
    }

    const parsed = JSON.parse(decodeUtf8(body));

    // "a string", 42 and null are all valid JSON and none of them is a payload.
    // Every caller then reaches for a property on it — data.current_weather,
    // data.error, data.length — and a scalar answers undefined to all of them, so
    // a broken endpoint reads as an empty result rather than a failure.
    // readJsonFile has guarded this on the disk side all along; the network side
    // did not.
    return parsed && typeof parsed === "object" ? parsed : null;
}

// libsoup follows redirects by default, and would follow an https -> http
// downgrade — putting the query string, which carries the user's location, on the
// wire in cleartext. "restarted" fires before the redirected request goes out, so
// cancelling there stops it rather than noticing afterwards.
function _cancelOnDowngrade(message, url, cancellable) {
    if (cancellable && typeof message.connect === "function") {
        message.connect("restarted", () => {
            if (_downgraded(message, url)) {
                cancellable.cancel();
            }
        });
    }
}

// Stream and cap incrementally where the Soup supports it (Soup 3): the declared
// length is guarded before the read, and the body is bounded as it arrives.
function _sendStreaming(session, message, url, cancellable, deliver, fail) {
    session.send_async(message, Soup.MessagePriority.NORMAL, cancellable, (source, result) => {
        let stream;
        let skipBody;
        try {
            // Finish first, then judge the declared length. Gio requires every
            // async result to be finished, and the stream it yields is what
            // holds the connection — refusing before taking it left both
            // unreclaimed. send_finish does not read the body, so a refusal
            // still costs nothing but the headers.
            stream = source.send_finish(result);
            skipBody = message.get_status() !== 200;
            if (!skipBody) {
                _refuseDeclaredTooLarge(message, url);
            }
        } catch (e) {
            _closeStream(stream);
            fail(e);
            return;
        }
        if (skipBody) {
            _closeStream(stream);
            // Keep status logging and null-result semantics in the one parser
            // exit that already owns them, without feeding it an error body.
            deliver(null);
            return;
        }
        _readCapped(stream, cancellable, url, (err, body) =>
            err ? fail(err) : deliver(body));
    });
}

// send_async can raise before it has a callback to answer through: the
// four-argument Soup 3 signature on a libsoup 2.4 host, a session Cinnamon
// disposed while the applet was reloading, a priority that fails to marshal.
// Nothing above settles then — the deadline stays armed for its full 60 s and
// the caller, which reads "no answer yet" as "still in flight", waits forever.
// Report it through the same null-data port every other network failure uses.
//
// A throw out of the caller's own callback arrives here the same way once the
// send has already delivered, and that one is not ours to convert: it belongs
// to the caller, and reporting it would call back a second time.
function _dispatchOrFail(send, hasSettled, fail) {
    try {
        send();
    } catch (e) {
        if (hasSettled()) {
            throw e;
        }
        fail(e);
    }
}

function _newRequestMessage(url, headers) {
    try {
        const message = Soup.Message.new("GET", url);
        if (!message) {
            throw new Error("Soup returned no message");
        }
        _setRequestHeaders(message, headers);
        return message;
    } catch {
        Diagnostics.logSafely("logError", new Error(
            "could not construct HTTP request for " + urlForLog(url)));
        return null;
    }
}

// Cancelling the request makes Gio error the pending send or read, so the
// ordinary failure path settles everything waiting on it. Disarming after a
// fire is a no-op: the id is spent.
function _armRequestDeadline(cancellable, url) {
    if (!cancellable) {
        return () => {};
    }

    let id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, HTTP_DEADLINE_SECONDS, () => {
        id = 0;
        Diagnostics.logSafely("logError", "request to " + urlForLog(url) + " passed the " +
            HTTP_DEADLINE_SECONDS + " s deadline; cancelling it");
        cancellable.cancel();
        return false;
    });

    return () => {
        if (id) {
            GLib.source_remove(id);
            id = 0;
        }
    };
}

function httpGetJson(session, url, callback, options = {}) {
    const message = _newRequestMessage(url, options.headers);

    // Soup rejects an invalid or excessive URI before a session owns the
    // request. Report that through the same null-data port as every later
    // network failure so provider failover and scheduler settlement still run.
    if (!message) {
        callback(null, null);
        return;
    }
    const cancellable = Gio.Cancellable ? new Gio.Cancellable() : null;
    _cancelOnDowngrade(message, url, cancellable);
    const disarmDeadline = _armRequestDeadline(cancellable, url);

    // Each path below calls back exactly once, and always outside its try: a
    // throw from the callback must not be swallowed as if it were a read error.
    // `settled` is how _dispatchOrFail tells a failed send apart from such a
    // throw travelling back out through a send that answered synchronously.
    let settled = false;

    const fail = (e) => {
        settled = true;
        disarmDeadline();
        Diagnostics.logSafely("logError", e);
        callback(null, message);
    };

    const deliver = (body) => {
        // Preserve completed-body receipt before decoding or validating JSON.
        const received = new Date().toISOString();
        settled = true;
        disarmDeadline();
        let data = null;
        try {
            data = _jsonFromBody(message, url, body);
        } catch (e) {
            Diagnostics.logSafely("logError", e);
        }
        callback(data, message, received);
    };

    _dispatchOrFail(
        () => _sendStreaming(session, message, url, cancellable, deliver, fail),
        () => settled,
        fail);
}

// every endpoint this applet speaks to is https; a redirect that lands on
// plain http is either a hijack or a broken provider, and either way the
// request carried the user's location
function _downgraded(message, url) {
    if (!url.startsWith("https:") || !message.get_uri) {
        return false;
    }

    const uri = message.get_uri();
    const scheme = uri && uri.get_scheme ? uri.get_scheme() : ""; // NOSONAR [S6582] -- accepted compatible form

    return Boolean(scheme) && scheme !== "https";
}

// One HTTP session per owner, built on the first request: weather is off by
// default and holidays stay off when timezone inference finds no supported
// country. A session at construction would cost startup even when neither is
// used. The session is per *instance*, not per
// module — a second applet on the panel must not have its requests aborted when
// the first one is removed.
//
// This lifecycle was written three times over: once in each weather provider and
// once in holidays.js, with the same lazy create, the same two timeouts and the
// same guarded abort. A cancellable, a connection cap or a proxy setting was
// three edits, two of them in the providers that fan out to eight cities.
// The network monitor is the one authority on whether dispatching an HTTP
// request has any point: at login the applet raced NetworkManager and burned
// its whole first refresh on DNS failures — five stack-traced error rounds —
// while the link was still coming up, then waited out a blind backoff timer
// that the actual network-up moment could have replaced. Lazy like the HTTP
// session, for the same reason: weather may be off. Fail open — a host with
// no usable monitor must degrade to the old always-try behavior, never to
// weather that silently stays off.
var NetworkState = class NetworkState { // NOSONAR [S3504] -- GJS importer export
    constructor(params = {}) {
        this._create = params.createMonitor || (() => Gio.NetworkMonitor.get_default());
        this._monitor = null;
        this._signal_id = 0;
    }

    _get() {
        if (this._monitor === null) {
            try {
                // `false` remembers a failed construction so a broken host pays
                // for it once, not on every refresh tick
                this._monitor = this._create() || false;
            } catch (e) {
                Diagnostics.logSafely("logError", e);
                this._monitor = false;
            }
        }
        return this._monitor;
    }

    isOnline() {
        const monitor = this._get();
        return monitor?.network_available !== false;
    }

    // The callback fires only when availability actually flips: the monitor
    // emits network-changed for VPNs, metering and captive-portal probes that
    // do not change whether dispatch is worthwhile.
    onChanged(callback) {
        const monitor = this._get();
        if (!monitor || typeof monitor.connect !== "function" || this._signal_id) {
            return;
        }
        let lastAvailable = this.isOnline();
        this._signal_id = monitor.connect("network-changed", () => {
            const available = this.isOnline();
            if (available === lastAvailable) {
                return;
            }
            lastAvailable = available;
            callback(available);
        });
    }

    destroy() {
        if (this._monitor && this._signal_id) {
            this._monitor.disconnect(this._signal_id);
        }
        this._signal_id = 0;
    }
};

var LazyHttpSession = class LazyHttpSession { // NOSONAR [S3504] -- GJS importer export
    constructor(create) {
        this._create = create || (() => createHttpSession({
            timeout: HTTP_TIMEOUT_SECONDS,
            idleTimeout: HTTP_TIMEOUT_SECONDS
        }));
        this._session = null;
        this._aborted = false;
    }

    // null until something has asked: "no session yet" and "a session that was
    // never used" are different states, and only the first costs nothing
    get created() {
        return this._session;
    }

    // abort() is terminal, not a reset: both owners call it from destroy(), and a
    // request arriving after that would otherwise build a Soup graph nothing is
    // left to abort. httpGetJson reports a null session through the same
    // failed-dispatch port as any other network failure.
    get() {
        if (this._aborted) {
            return null;
        }
        if (!this._session) {
            this._session = this._create();
        }

        return this._session;
    }

    // pending requests keep their response buffers and their callbacks alive for
    // up to the timeout after the applet is gone
    abort() {
        const session = this._session;
        this._session = null;
        this._aborted = true;
        if (session && session.abort) { // NOSONAR [S6582] -- accepted compatible form
            session.abort();
        }
    }
};

if (typeof module !== "undefined") {
    module.exports = {
        createHttpSession,
        LazyHttpSession,
        NetworkState,
        decodeUtf8,
        HTTP_TIMEOUT_SECONDS,
        HTTP_DEADLINE_SECONDS,
        MAX_RESPONSE_BYTES,
        MAX_CACHE_FILE_BYTES,
        httpGetJson,
        urlForLog,
        readTextFileCapped,
        readJsonFileAsync,
        updateJsonFileAsync,
        writeJsonFileAsync
    };
}
