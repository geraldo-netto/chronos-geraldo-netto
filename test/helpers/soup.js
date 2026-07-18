function makeSoup3({
    data = '{"ok":true}',
    status = 200,
    date = "Mon, 01 Jan 2024 00:00:00 GMT",
    onMessage = null,
    onSend = null,
    onFinish = null,
    messageMethods = {},
    sessionMethods = {}
} = {}) {
    const messages = [];
    // how many sessions were built, and whether they were aborted: a session per
    // applet at startup, or one left running after the applet is gone, are both
    // things worth being able to assert
    const sessions = [];

    const soup = {
        MAJOR_VERSION: 3,
        MessagePriority: { NORMAL: 0 },
        Message: {
            new(method, url) {
                const requestHeaders = [];
                const requestHeaderBag = {
                    append(name, value) {
                        requestHeaders.push([name, value]);
                    }
                };
                const responseHeaderBag = {
                    get_content_length() {
                        return null;
                    },
                    get_one(name) {
                        return name.toLowerCase() === "date" ? date : null;
                    }
                };
                const message = {
                    method,
                    url,
                    requestHeaders,
                    request_headers: requestHeaderBag,
                    response_headers: responseHeaderBag,
                    get_request_headers() {
                        return requestHeaderBag;
                    },
                    get_response_headers() {
                        return responseHeaderBag;
                    },
                    get_status() {
                        return status;
                    },
                    ...messageMethods
                };
                messages.push(message);
                if (onMessage) {
                    onMessage(message);
                }
                return message;
            }
        },
        Session: class {
            constructor() {
                this.timeout = 0; // NOSONAR [S7757] -- deliberate test seam
                this.idle_timeout = 0;
                this.aborted = false;
                sessions.push(this);
            }

            abort() {
                this.aborted = true;
            }

            send_async(message, priority, cancellable, callback) {
                if (onSend) {
                    onSend(message, priority, cancellable);
                }
                callback(this, {});
            }

            send_finish(result) {
                if (onFinish) {
                    return onFinish(result);
                }
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
        },
        messages,
        sessions
    };

    Object.assign(soup.Session.prototype, sessionMethods);
    return soup;
}

module.exports = { makeSoup3 };
