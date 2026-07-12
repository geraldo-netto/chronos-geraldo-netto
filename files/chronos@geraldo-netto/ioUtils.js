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
// ~/.cache/chronos@geraldo-netto/enrico.json is writable by anything running
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
                if (ok && !tooBig(contents.length, MAX_CACHE_FILE_BYTES,
                    "the holiday cache file")) {
                    const parsed = JSON.parse(decodeUtf8(contents));
                    // a corrupt file may parse to null or a scalar
                    if (parsed && typeof parsed === "object") {
                        data = parsed;
                    }
                }
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

function _urlForLog(url) {
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

function httpGetJson(session, url, callback, options = {}) {
    const message = Soup.Message.new("GET", url);
    _setRequestHeaders(message, options.headers);

    // libsoup follows redirects by default, and would follow an https -> http
    // downgrade — putting the query string, which carries the user's location,
    // on the wire in cleartext. "restarted" fires before the redirected request
    // goes out, so cancelling there stops it rather than noticing afterwards.
    const cancellable = Gio.Cancellable ? new Gio.Cancellable() : null;
    if (cancellable && typeof message.connect === "function") {
        message.connect("restarted", () => {
            if (_downgraded(message, url)) {
                cancellable.cancel();
            }
        });
    }

    session.send_and_read_async(message, Soup.MessagePriority.NORMAL, cancellable, (source, result) => {
        let data = null;
        // the callback runs outside the try: if it throws, the error must
        // not be swallowed and the callback must not run a second time
        try {
            if (_declaredTooLarge(message)) {
                throw new Error("response from " + _urlForLog(url) + " declares more than " +
                    MAX_RESPONSE_BYTES + " bytes");
            }

            const bytes = source.send_and_read_finish(result);
            if (_downgraded(message, url)) {
                throw new Error("refusing a response from " + _urlForLog(url) + " redirected to plain http");
            }

            if (message.get_status() === 200) {
                const body = bytes.get_data();
                // the declared length can lie, or be absent entirely
                if (body && body.length > MAX_RESPONSE_BYTES) {
                    throw new Error("response from " + _urlForLog(url) + " exceeds " +
                        MAX_RESPONSE_BYTES + " bytes");
                }
                const parsed = JSON.parse(decodeUtf8(body));
                // "a string", 42 and null are all valid JSON and none of them is
                // a payload. Every caller then reaches for a property on it —
                // data.current_weather, data.error, data.length — and a scalar
                // answers undefined to all of them, so a broken endpoint reads
                // as an empty result rather than a failure. readJsonFile has
                // guarded this on the disk side all along; the network side did
                // not.
                data = parsed && typeof parsed === "object" ? parsed : null;
            } else if (global.logError) {
                global.logError("HTTP " + message.get_status() + " fetching " + _urlForLog(url));
            }
        } catch (e) {
            if (global.logError) {
                global.logError(e);
            }
        }
        callback(data, message);
    });
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

if (typeof module !== "undefined") {
    module.exports = {
        createHttpSession,
        decodeUtf8,
        HTTP_TIMEOUT_SECONDS,
        MAX_RESPONSE_BYTES,
        MAX_CACHE_FILE_BYTES,
        httpGetJson,
        _urlForLog,
        readJsonFileAsync,
        writeJsonFileAsync
    };
}
