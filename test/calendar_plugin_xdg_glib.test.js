const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../files/chronos@geraldo-netto");
const importer = "import sys;sys.dont_write_bytecode=True;sys.path.insert(0,sys.argv[1]);" +
    "import chronos_calendar_plugin_data as p;p.import_plugin(sys.argv[2]);print(p.plugin_directory())";

test("native Gio loads Python-installed plugins with absolute, relative, empty and unset XDG data", context => {
    const probe = spawnSync("cjs", ["--version"], { encoding: "utf8", timeout: 10000 });
    if (probe.error?.code === "ENOENT") {
        context.skip("cjs is not installed; native plugin directory parity requires GLib");
        return;
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-plugin-xdg-"));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const source = path.join(temporary, "source.json");
    fs.writeFileSync(source, JSON.stringify({ apiVersion: 1, id: "example.review", name: "Review",
        category: "custom", coverage: { from: 2025, through: 2027 }, source: { name: "Fixture" }, events: [] }));
    for (const [index, configured] of ["relative", path.join(temporary, "absolute"), "", undefined].entries()) {
        const homeDirectory = path.join(temporary, String(index));
        fs.mkdirSync(homeDirectory);
        const environment = { ...process.env, HOME: homeDirectory, PYTHONDONTWRITEBYTECODE: "1" };
        if (configured === undefined) delete environment.XDG_DATA_HOME;
        else environment.XDG_DATA_HOME = configured;
        const options = { encoding: "utf8", timeout: 10000, cwd: temporary, env: environment };
        const installed = spawnSync("python3", ["-B", "-c", importer, root, source], options);
        assert.equal(installed.status, 0, installed.stderr || String(installed.error));
        const base = configured && path.isAbsolute(configured) ? configured : path.join(homeDirectory, ".local/share");
        assert.equal(installed.stdout.trim(), path.join(base, "chronos@geraldo-netto/calendars"));
        const loaded = spawnSync("cjs", [path.join(__dirname, "helpers/calendarPluginXdgGlib.js"), root], options);
        assert.equal(loaded.status, 0, loaded.stderr || String(loaded.error));
        assert.deepEqual(JSON.parse(loaded.stdout), ["example.review"], String(configured));
    }
});
