// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
// Derived from calendar@ccprog (Claus Colloseus) and
// calendar@simonwiles.net (Simon Wiles).
//
// SPDX-License-Identifier: GPL-2.0-or-later

// The single spawn site for gnome-calendar. This is process I/O, not
// presentation: it lives beside the event view rather than inside it so the
// argv handling — the option-injection guard and the UID length contract —
// is reviewed on its own.

/* global imports */

const GLib = imports.gi.GLib;
const Util = imports.misc.util;
const EventDataModule = require("./eventData");

// One UID contract for the whole applet, owned by the data module: it keeps
// externally supplied UIDs well below the kernel's per-argv limit, so a spawn
// request handed to the compositor can never fail on length.
var MAX_EVENT_UID_LENGTH = EventDataModule.MAX_EVENT_UID_LENGTH; // NOSONAR [S3504] -- exported for boundary tests

function eventUidCanLaunch(uuid) {
    return typeof uuid === "string" && uuid.length <= MAX_EVENT_UID_LENGTH;
}

class CalendarLauncher {
    // find_program_in_path stats every entry in $PATH, and every event row asks
    // this while it is being built — a day with twenty events meant twenty full
    // PATH scans on the compositor thread, on each rebuild. gnome-calendar does
    // not come and go while the shell runs, so ask once.
    isAvailable() {
        if (this._available === undefined) {
            this._available = Boolean(GLib.find_program_in_path("gnome-calendar"));
        }

        return this._available;
    }

    launchDate(gdate) {
        if (!this.isAvailable()) {
            return false;
        }

        // --date will be broken anywhere but Mint 20.3 and upstream releases > 41.2
        // (unless some fixes are backported). Maintainer can patch this to comment
        // out either line here.

        // Util.trySpawn(["gnome-calendar"], false);
        try {
            Util.trySpawn(["gnome-calendar", "--date", gdate.format("%x")], false);
            return true;
        } catch {
            global.log("Chronos: gnome-calendar could not open the requested date");
            return false;
        }
    }

    launchUuid(uuid) {
        if (!this.isAvailable()) {
            return false;
        }

        if (!eventUidCanLaunch(uuid)) {
            global.log("Chronos: refused a calendar event identifier that exceeds the launch limit");
            return false;
        }

        // The uid comes off whatever ICS or CalDAV feed the user subscribed to.
        // This is the argv form, so there is no shell and no command injection
        // — but as a separate argument, a uid beginning with a dash reaches
        // gnome-calendar's option parser as an option. Attaching it to the
        // switch keeps it a value.
        try {
            Util.trySpawn(["gnome-calendar", "--uuid=" + uuid], false);
            return true;
        } catch {
            // Do not echo the feed-controlled UID (or an error that may contain
            // argv) into the shell log.
            global.log("Chronos: gnome-calendar could not open the requested event");
            return false;
        }
    }
}

if (typeof module !== "undefined") {
    module.exports = { CalendarLauncher, eventUidCanLaunch, MAX_EVENT_UID_LENGTH };
}
