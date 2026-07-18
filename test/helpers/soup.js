function requestHeaderFixture() {
    const values = [];
    return {
        values,
        bag: {
            append(name, value) {
                values.push([name, value]);
            }
        }
    };
}

function responseHeaderBag(date) {
    return {
        get_content_length() {
            return null;
        },
        get_one(name) {
            return name.toLowerCase() === "date" ? date : null;
        }
    };
}

function buildMessage(fixture, method, url) {
    const requestHeaders = requestHeaderFixture();
    const responseHeaders = responseHeaderBag(fixture.date);
    const message = {
        method,
        url,
        requestHeaders: requestHeaders.values,
        request_headers: requestHeaders.bag,
        response_headers: responseHeaders,
        get_request_headers() {
            return requestHeaders.bag;
        },
        get_response_headers() {
            return responseHeaders;
        },
        get_status() {
            return fixture.status;
        },
        ...fixture.messageMethods
    };
    fixture.messages.push(message);
    if (fixture.onMessage) {
        fixture.onMessage(message);
    }
    return message;
}

function soupStream(data) {
    let delivered = false;
    return {
        read_bytes_async(_count, _priority, _cancellable, callback) {
            callback(this, {});
        },
        read_bytes_finish() {
            const chunk = delivered ? Buffer.alloc(0) : Buffer.from(data);
            delivered = true;
            return { get_data: () => chunk };
        }
    };
}

class SoupSession {
    constructor(fixture) {
        this.fixture = fixture;
        this.timeout = 0; // NOSONAR [S7757] -- deliberate test seam
        this.idle_timeout = 0;
        this.aborted = false;
        fixture.sessions.push(this);
    }

    abort() {
        this.aborted = true;
    }

    send_async(message, priority, cancellable, callback) {
        if (this.fixture.onSend) {
            this.fixture.onSend(message, priority, cancellable);
        }
        callback(this, {});
    }

    send_finish(result) {
        return this.fixture.onFinish ?
            this.fixture.onFinish(result) : soupStream(this.fixture.data);
    }
}

function boundSessionClass(fixture) {
    return class extends SoupSession {
        constructor() {
            super(fixture);
        }
    };
}

function fixtureOption(options, name, fallback) {
    return options[name] === undefined ? fallback : options[name];
}

function makeSoup3(options = {}) {
    const fixture = {
        data: fixtureOption(options, "data", '{"ok":true}'),
        status: fixtureOption(options, "status", 200),
        date: fixtureOption(options, "date", "Mon, 01 Jan 2024 00:00:00 GMT"),
        onMessage: fixtureOption(options, "onMessage", null),
        onSend: fixtureOption(options, "onSend", null),
        onFinish: fixtureOption(options, "onFinish", null),
        messageMethods: fixtureOption(options, "messageMethods", {}),
        messages: [],
        sessions: []
    };
    const Session = boundSessionClass(fixture);
    Object.assign(Session.prototype, fixtureOption(options, "sessionMethods", {}));
    return {
        MAJOR_VERSION: 3,
        MessagePriority: { NORMAL: 0 },
        Message: { new: (method, url) => buildMessage(fixture, method, url) },
        Session,
        messages: fixture.messages,
        sessions: fixture.sessions
    };
}

module.exports = { makeSoup3 };
