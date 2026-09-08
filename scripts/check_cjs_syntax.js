// Chronos Calendar — a Cinnamon calendar applet.
// Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* global imports, print, printerr */

// Compile every shipped JavaScript file with the runtime that actually runs it.
//
// The Node suite and eslint parse this tree with espree, and the release job
// parses it again with Node's own parser. Neither is cjs: the applet runs on
// SpiderMonkey behind Cinnamon's cjs, and a form both Node parsers accept and
// that runtime does not would ship green. This closes that gap for syntax.
//
// It compiles rather than imports. Importing a shipped module needs
// imports.gi.St, imports.ui.appletManager and a running Cinnamon, none of which
// exist in a bare cjs process; `new Function(source)` runs the same parser over
// the same bytes without executing a line of it.
//
// This exercises the installed cjs parser. Real module loading and UI behavior
// are verified separately inside Cinnamon.

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

const APPLET_DIR = "files/chronos@geraldo-netto";

function readText(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok) {
        throw new Error("could not read " + path);
    }
    return new TextDecoder().decode(bytes);
}

function javascriptFiles(directory, found) {
    const enumerator = Gio.File.new_for_path(directory).enumerate_children(
        "standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null);

    let info = enumerator.next_file(null);
    while (info) {
        const name = info.get_name();
        const path = directory + "/" + name;
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            javascriptFiles(path, found);
        } else if (name.endsWith(".js")) {
            found.push(path);
        }
        info = enumerator.next_file(null);
    }

    return found;
}

function compileFailure(path) {
    try {
        new Function(readText(path)); // NOSONAR [S7773] -- compiling it *is* the check
        return "";
    } catch (error) {
        return path + ": " + error;
    }
}

function main() {
    const paths = javascriptFiles(APPLET_DIR, []).sort();
    if (!paths.length) {
        printerr("no shipped JavaScript found under " + APPLET_DIR +
            "; run this from the repository root");
        return 1;
    }

    const failures = paths.map(compileFailure).filter((message) => message);
    failures.forEach((message) => printerr(message));
    if (failures.length) {
        return 1;
    }

    print("cjs " + imports.system.version + " compiles " + paths.length +
        " shipped files (syntax only, and only on this cjs release)");
    return 0;
}

imports.system.exit(main());
