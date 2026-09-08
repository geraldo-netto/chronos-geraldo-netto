#!/usr/bin/python3
# Chronos Calendar — a Cinnamon calendar applet.
# Copyright (C) Geraldo Netto <geraldonetto@gmail.com> and contributors.
# Derived from calendar@ccprog (Claus Colloseus) and
# calendar@simonwiles.net (Simon Wiles).
#
# SPDX-License-Identifier: GPL-2.0-or-later
# This program comes with ABSOLUTELY NO WARRANTY. See the LICENSE file beside
# this one, or <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.

"""Import the shipped applet in a disposable native Cinnamon desktop."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time


UUID = "chronos@geraldo-netto"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
TOOLS = ("cinnamon", "cjs", "csd-xsettings", "dbus-run-session", "xvfb-run")
XDG_DIRECTORIES = {"XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data",
                   "XDG_CACHE_HOME": "cache", "XDG_RUNTIME_DIR": "runtime"}
APPLET_LOOKUP = f"imports.ui.appletManager.get_object_for_uuid('{UUID}', '{UUID}')"


def private_environment(directory):
    environment = os.environ.copy()
    for key, name in XDG_DIRECTORIES.items():
        folder = directory / name
        folder.mkdir(mode=0o700)
        environment[key] = str(folder)
    environment.update(GSETTINGS_BACKEND="keyfile", GIO_USE_VFS="local",
                       NO_AT_BRIDGE="1", XDG_SESSION_TYPE="x11",
                       CHRONOS_ORIGINAL_DISPLAY=environment.get("DISPLAY", ""))
    return environment


def prepare_applet(directory, project_root):
    source = project_root / "files" / UUID
    destination = directory / "data" / "cinnamon" / "applets" / UUID
    shutil.copytree(source, destination,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*~"))
    schema = json.loads((destination / "6.0" / "settings-schema.json").read_text())
    for entry in schema.values():
        if isinstance(entry, dict) and "default" in entry:
            entry["value"] = entry["default"]
    choices = {"show-weather": False, "show-events": False, "country": "none",
               "show-religious-observances": False, "extra-country-calendars": [],
               "calendar-plugins": []}
    for key, value in choices.items():
        schema[key]["value"] = value
    profile = directory / "config" / "cinnamon" / "spices" / UUID / "1.json"
    profile.parent.mkdir(parents=True)
    profile.write_text(json.dumps(schema), encoding="utf-8")
    files = sorted(destination.rglob("*.js"), key=lambda path: (path.parent != destination, str(path)))
    if not files:
        raise ValueError("No shipped JavaScript modules found")
    inventory = {str(path.relative_to(destination)): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in files}
    (directory / "inventory.json").write_text(json.dumps(inventory), encoding="utf-8")
    return destination, inventory


def verify_isolation(directory):
    for key, name in XDG_DIRECTORIES.items():
        if os.environ.get(key) != str(directory / name):
            raise RuntimeError(f"Refusing native check without private {key}")
    display = os.environ.get("DISPLAY")
    if not display or display == os.environ.get("CHRONOS_ORIGINAL_DISPLAY"):
        raise RuntimeError("Refusing native check without a separate X display")
    if os.environ.get("GSETTINGS_BACKEND") != "keyfile":
        raise RuntimeError("Refusing native check without private keyfile settings")


def stop_process(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def evaluator():
    # Import only in the child, after its D-Bus and XDG environment exist.
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    def evaluate(code):
        success, body = bus.call_sync(
            "org.Cinnamon", "/org/Cinnamon", "org.Cinnamon", "Eval",
            GLib.Variant("(s)", (code,)), GLib.VariantType.new("(bs)"),
            Gio.DBusCallFlags.NONE, 5000, None).unpack()
        if not success:
            raise RuntimeError(body)
        return json.loads(body) if body else None

    return evaluate


def wait_for(evaluate, code, process, timeout=35):
    deadline = time.monotonic() + timeout
    last_error = "condition remained false"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Isolated Cinnamon exited before the check completed")
        try:
            result = evaluate(code)
            if result:
                return result
        except Exception as error:
            last_error = str(error)
        time.sleep(0.2)
    raise RuntimeError(f"Native Cinnamon check timed out: {last_error}")


def import_script(directory, names):
    applet = directory / "data" / "cinnamon" / "applets" / UUID
    return f"""(() => {{
        const applet = {APPLET_LOOKUP};
        const namespace = imports.ui.appletManager.applets[{json.dumps(UUID)}];
        const root = {json.dumps(str(applet))};
        const imported = [], failures = [];
        for (const name of {json.dumps(names)}) {{
            try {{
                const parts = name.split('/');
                const loaded = parts.length === 1 ? namespace[name.slice(0, -3)] :
                    imports.misc.fileUtils.requireModule(root + '/' + name,
                        root + '/' + parts.slice(0, -1).join('/'), applet._meta, 'applet');
                if (!loaded) throw new Error('module returned no namespace');
                imported.push(name);
            }} catch (error) {{ failures.push({{name, error: String(error)}}); }}
        }}
        return {{cinnamon: imports.misc.config.PACKAGE_VERSION,
            cjs: imports.system.version, constructed: applet._constructed,
            calendarCells: applet._calendar._gridView.dayCells.length, imported, failures}};
    }})()"""


def run_isolated(directory):
    verify_isolation(directory)
    with (directory / "cinnamon.log").open("w") as log:
        xsettings = subprocess.Popen(["csd-xsettings"], stdout=log, stderr=log)
        try:
            cinnamon = subprocess.Popen(["cinnamon", "--sm-disable", "--x11"], stdout=log, stderr=log)
            try:
                evaluate = evaluator()
                wait_for(evaluate, "Boolean(global.settings && imports.ui.appletManager.appletsLoaded)", cinnamon)
                evaluate(f"global.settings.set_strv('enabled-applets', ['panel1:right:0:{UUID}:1'])")
                wait_for(evaluate, f"(() => {{const a={APPLET_LOOKUP};return !!(a && a._constructed);}})()", cinnamon)
                evaluate(f"(() => {{{APPLET_LOOKUP}.menu.open(false);return true;}})()")
                wait_for(evaluate, f"{APPLET_LOOKUP}._calendar._gridView.dayCells.length === 42", cinnamon)
                inventory = json.loads((directory / "inventory.json").read_text())
                report = evaluate(import_script(directory, list(inventory)))
                report["sha256"] = inventory
                report["cjsVersion"] = subprocess.check_output(["cjs", "--version"], text=True).strip()
                print(json.dumps(report, indent=2), flush=True)
                return int(bool(report["failures"]))
            finally:
                stop_process(cinnamon)
        finally:
            stop_process(xsettings)


def run_session(directory, environment, child_script=None):
    child = "import runpy,sys; ns=runpy.run_path(sys.argv[1]); sys.exit(ns['run_isolated'](ns['Path'](sys.argv[2])))"
    command = ["dbus-run-session", "--", "xvfb-run", "-a", "-s", "-screen 0 1366x768x24",
               sys.executable, "-c", child,
               str(child_script or Path(__file__).resolve()), str(directory)]
    with (directory / "session.log").open("w") as log:
        process = subprocess.Popen(command, env=environment, stderr=log, start_new_session=True)
        try:
            return process.wait(timeout=100)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise


def main():
    missing = [name for name in TOOLS if shutil.which(name) is None]
    if missing:
        print("Missing native-check tools: " + ", ".join(missing), file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory(prefix="chronos-native-imports-") as temporary:
        directory = Path(temporary)
        environment = private_environment(directory)
        prepare_applet(directory, PROJECT_ROOT)
        try:
            status = run_session(directory, environment)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            status = 1
        if status:
            for name in ("session.log", "cinnamon.log"):
                path = directory / name
                if path.exists():
                    print(path.read_text(errors="replace")[-8000:], file=sys.stderr)
        return status


if __name__ == "__main__":
    raise SystemExit(main())
