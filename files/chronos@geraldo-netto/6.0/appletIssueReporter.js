// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later
// This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
// this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

// A message-aggregation model with one St call in it: `label.set_text`. It was
// a class inside appletMenuBuilder.js, which builds the whole popup — and the
// builder owning it was one of that class's four unrelated reasons to change.

const TextUtils = require("./textUtils");

const ISSUE_MARKER = TextUtils.WARNING_MARKER;

// One footer owns every current user-facing problem. Sources update their own
// key, so a recovered weather request cannot erase a simultaneous calendar
// failure, and repeated ticks cannot duplicate the same sentence.
class AppletIssueReporter {
    constructor(label) {
        this.label = label;
        this._issues = new Map();
        this._rendered = null;
        this._render();
    }

    set(source, message) {
        const key = String(source || "").trim();
        if (!key) {
            return;
        }

        const text = typeof message === "string" ? message.trim() : "";
        if (text) {
            if (this._issues.get(key) === text) {
                return;
            }
            this._issues.set(key, text);
        } else if (!this._issues.delete(key)) {
            return;
        }
        this._render();
    }

    _messages() {
        const seen = new Set();
        const messages = [];
        for (const issue of this._issues.values()) {
            for (const line of issue.split(/\n+/)) {
                const message = line.trim();
                if (message && !seen.has(message)) {
                    seen.add(message);
                    messages.push(message);
                }
            }
        }
        return messages;
    }

    // Teardown steps that run after the menu is destroyed — provider aborts,
    // settings finalize — can still report issues, and this label's actor dies
    // with the menu. A detached reporter swallows them instead of writing into
    // a disposed St.Label.
    detach() {
        this.label = null;
    }

    _render() {
        if (!this.label) {
            return;
        }
        const text = this._messages()
            .map((message) => ISSUE_MARKER + " " + message)
            .join("\n");
        if (text === this._rendered) {
            return;
        }
        this._rendered = text;
        this.label.set_text(text);
        this.label.visible = Boolean(text);
        if (this.label.set_accessible_name) {
            this.label.set_accessible_name(text);
        }
    }
}

if (typeof module !== "undefined") {
    module.exports = { AppletIssueReporter };
}
