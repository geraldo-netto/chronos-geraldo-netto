/* global imports */
/* eslint camelcase: "off" */

const GjsImports = typeof imports === "undefined" ? globalThis.imports : imports;
const Gio = GjsImports.gi.Gio;
const Soup = GjsImports.gi.Soup;

var HTTP_TIMEOUT_SECONDS = 30;
// Responses are parsed on the compositor thread and the holiday payloads are
// tens of kilobytes; anything past this is a broken or hostile endpoint, and
// parsing it would balloon the Cinnamon process.
var MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// The same argument, for the same parse, on the same thread — the only
// difference is that this payload comes off the disk rather than the network.
// ~/.cache/chronos@geraldo-netto/holidays.json is writable by anything running
// as the user, and it was read with no bound at all while the network body it
// was built from was capped. A real cache file is tens of kilobytes.
var MAX_CACHE_FILE_BYTES = 4 * 1024 * 1024;

function tooBig(size, limit, what) {
    if (!Number.isFinite(size) || size <= limit) {
        return false;
    }

    if (global.logError) {
        global.logError(`${what} is ${size} bytes, past the ${limit}-byte cap; ignoring it`);
    }
    return true;
}

// TextDecoder is present in every GJS that ships with Cinnamon 5.4 and in Node,
// which are the only two hosts this code runs in. The imports.byteArray fallback
// that used to sit here was a compat shim for a GJS this applet cannot be loaded
// by — deprecated upstream, and unreachable here.
function decodeUtf8(data) {
    return new TextDecoder().decode(data);
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

    // a corrupt file may parse to null or a scalar
    return parsed && typeof parsed === "object" ? parsed : {};
}

function readJsonFileAsync (file, callback) {
    if (!file.query_exists(null)) {
        callback({});
        return;
    }

    try {
        file.load_contents_async(null, (source, result) => {
            let data = {};
            let etag = null;
            try {
                // the etag is the file's version as Gio saw it: handing it back
                // to replace_contents_async is what makes the write fail rather
                // than silently overwrite another writer who got there first
                const [ok, contents, tag] = source.load_contents_finish(result);
                etag = tag || null;
                data = _parseCacheFile(contents, ok);
            } catch (e) {
                if (global.logError) {
                    global.logError(e);
                }
            }
            callback(data, etag);
        });
    } catch (e) {
        if (global.logError) {
            global.logError(e);
        }
        callback({});
    }
}

// The cache write happens on the compositor thread, so it goes through Gio's
// async API. `onDone` fires whether the write succeeded or failed: the caller
// needs it to know when the file is settled, not whether it liked the outcome.
function writeJsonFileAsync (file, data, onDone, etag = null) {
    // `stale` says the file moved under us: another applet instance wrote it
    // between our read and our write, so the snapshot we merged into is no
    // longer the whole truth and the caller must merge again. Without the etag
    // the write simply won.
    const done = (stale = false) => {
        if (typeof onDone === "function") {
            onDone(stale);
        }
    };

    const bytes = new TextEncoder().encode(JSON.stringify(data));
    try {
        file.replace_contents_async(bytes, etag, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            (source, result) => {
                try {
                    source.replace_contents_finish(result);
                } catch (e) {
                    if (_isWrongEtag(e)) {
                        // not an error: someone else got there first
                        done(true);
                        return;
                    }
                    if (global.logError) {
                        global.logError(e);
                    }
                }
                done();
            });
    } catch (e) {
        if (global.logError) {
            global.logError(e);
        }
        done();
    }
}

function _isWrongEtag(error) {
    if (!error) {
        return false;
    }

    if (Gio.IOErrorEnum && typeof error.matches === "function") {
        return error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.WRONG_ETAG);
    }

    return /wrong.?etag/i.test(String(error && error.message ? error.message : error));
}

function _setRequestHeaders(message, headers) {
    if (!headers) {
        return;
    }

    // Soup 3 exposes request_headers both as a GObject property and via
    // the getter; accept either so plain test doubles keep working
    const requestHeaders = message.request_headers ||
        (message.get_request_headers ? message.get_request_headers() : null);
    if (!requestHeaders || !requestHeaders.append) {
        return;
    }

    for (let header of Object.keys(headers)) {
        requestHeaders.append(header, headers[header]);
    }
}

function urlForLog(url) {
    if (typeof url !== "string") {
        return "";
    }

    const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)?/i.exec(url);
    if (match) {
        return match[1] + (match[2] || "");
    }

    return url.split(/[?#]/)[0];
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
    const headers = message.response_headers ||
        (message.get_response_headers ? message.get_response_headers() : null);
    if (!headers) {
        return false;
    }

    const declared = headers.get_content_length ? headers.get_content_length() :
        Number(headers.get_one && headers.get_one("content-length"));

    return Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES;
}

// Read a body in bounded chunks and stop the instant the running total passes
// the cap, rather than letting the whole thing land in memory first. This is
// what closes the chunked-transfer hole: a response with no Content-Length slips
// past _declaredTooLarge, and send_and_read_finish would have spent the memory
// before any length check could look.
var READ_CHUNK_BYTES = 64 * 1024;

function _concatChunks(chunks, total) {
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
    }
    return body;
}

function _readCapped(stream, cancellable, url, deliver) {
    const chunks = [];
    let total = 0;
    const readMore = () => {
        stream.read_bytes_async(READ_CHUNK_BYTES, 0, cancellable, (source, result) => {
            try {
                const chunk = source.read_bytes_finish(result).get_data();
                if (!chunk || chunk.length === 0) {
                    deliver(null, _concatChunks(chunks, total));
                    return;
                }
                total += chunk.length;
                if (total > MAX_RESPONSE_BYTES) {
                    throw new Error("response from " + urlForLog(url) + " exceeds " +
                        MAX_RESPONSE_BYTES + " bytes");
                }
                chunks.push(chunk);
                readMore();
            } catch (e) {
                if (cancellable) {
                    cancellable.cancel();
                }
                deliver(e, null);
            }
        });
    };
    readMore();
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
        if (global.logError) {
            global.logError("HTTP " + message.get_status() + " fetching " + urlForLog(url));
        }
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
        let stream = null;
        try {
            _refuseDeclaredTooLarge(message, url);
            stream = source.send_finish(result);
        } catch (e) {
            fail(e);
            return;
        }
        _readCapped(stream, cancellable, url, (err, body) =>
            err ? fail(err) : deliver(body));
    });
}

// The whole-body path, for a Soup with no send_async: only the declared length
// bounds it, which is what the streaming path exists to improve on.
function _sendAtOnce(session, message, url, cancellable, deliver, fail) {
    session.send_and_read_async(message, Soup.MessagePriority.NORMAL, cancellable, (source, result) => {
        let body = null;
        try {
            _refuseDeclaredTooLarge(message, url);
            body = source.send_and_read_finish(result).get_data();
        } catch (e) {
            fail(e);
            return;
        }
        deliver(body);
    });
}

function httpGetJson(session, url, callback, options = {}) {
    const message = Soup.Message.new("GET", url);
    _setRequestHeaders(message, options.headers);

    const cancellable = Gio.Cancellable ? new Gio.Cancellable() : null;
    _cancelOnDowngrade(message, url, cancellable);

    // Each path below calls back exactly once, and always outside its try: a
    // throw from the callback must not be swallowed as if it were a read error.
    const fail = (e) => {
        if (global.logError) {
            global.logError(e);
        }
        callback(null, message);
    };

    const deliver = (body) => {
        let data = null;
        try {
            data = _jsonFromBody(message, url, body);
        } catch (e) {
            if (global.logError) {
                global.logError(e);
            }
        }
        callback(data, message);
    };

    const send = typeof session.send_async === "function" ? _sendStreaming : _sendAtOnce;
    send(session, message, url, cancellable, deliver, fail);
}

// every endpoint this applet speaks to is https; a redirect that lands on
// plain http is either a hijack or a broken provider, and either way the
// request carried the user's location
function _downgraded(message, url) {
    if (!url.startsWith("https:") || !message.get_uri) {
        return false;
    }

    const uri = message.get_uri();
    const scheme = uri && uri.get_scheme ? uri.get_scheme() : "";

    return Boolean(scheme) && scheme !== "https";
}

// One HTTP session per owner, built on the first request: weather and holidays
// are both off by default, and a session at construction costs applet startup for
// every user who never turns them on. The session is per *instance*, not per
// module — a second applet on the panel must not have its requests aborted when
// the first one is removed.
//
// This lifecycle was written three times over: once in each weather provider and
// once in holidays.js, with the same lazy create, the same two timeouts and the
// same guarded abort. A cancellable, a connection cap or a proxy setting was
// three edits, two of them in the providers that fan out to eight cities.
var LazyHttpSession = class LazyHttpSession {
    constructor(create) {
        this._create = create || (() => createHttpSession({
            timeout: HTTP_TIMEOUT_SECONDS,
            idleTimeout: HTTP_TIMEOUT_SECONDS
        }));
        this._session = null;
    }

    // null until something has asked: "no session yet" and "a session that was
    // never used" are different states, and only the first costs nothing
    get created() {
        return this._session;
    }

    get() {
        if (!this._session) {
            this._session = this._create();
        }

        return this._session;
    }

    // pending requests keep their response buffers and their callbacks alive for
    // up to the timeout after the applet is gone
    abort() {
        if (this._session && this._session.abort) {
            this._session.abort();
        }
    }
};

if (typeof module !== "undefined") {
    module.exports = {
        createHttpSession,
        LazyHttpSession,
        decodeUtf8,
        HTTP_TIMEOUT_SECONDS,
        MAX_RESPONSE_BYTES,
        MAX_CACHE_FILE_BYTES,
        httpGetJson,
        urlForLog,
        readJsonFileAsync,
        writeJsonFileAsync
    };
}
