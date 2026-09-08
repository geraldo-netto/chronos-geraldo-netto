/* global ARGV, print */
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const modules = {};
const runtime = { gi: { Gio, GLib }, ui: { appletManager: {
    applets: { "chronos@geraldo-netto": modules }
} } };
const counts = { started: 0, completed: 0, delivered: 0, validated: 0, decodedBytes: 0,
    realTokens: true, errors: 0, timedOut: false };
const NativeDecoder = TextDecoder;
class CountingDecoder extends NativeDecoder {
    decode(bytes) {
        counts.decodedBytes += bytes.byteLength;
        return super.decode(bytes);
    }
}
for (const name of ["textUtils", "dateMath", "religiousCatalog", "holidayConstants",
    "holidayRecord", "calendarPluginData", "calendarPluginLoader"]) {
    const source = new NativeDecoder().decode(GLib.file_get_contents(`${ARGV[0]}/${name}.js`)[1]);
    const module = { exports: {} };
    new Function("imports", "module", "TextDecoder", source)(runtime, module, CountingDecoder);
    modules[name] = module.exports;
}
globalThis.global = { logError: () => counts.errors++ };
const loop = GLib.MainLoop.new(null, false);
const cancelled = ARGV[1] !== "active";
const target = cancelled ? 3 : 1;
const { CalendarPluginLoader, readInstalledPlugin } = modules.calendarPluginLoader;
const loader = new CalendarPluginLoader({
    read(id, cancellable, done) {
        counts.started++;
        counts.realTokens &&= cancellable instanceof Gio.Cancellable;
        readInstalledPlugin(id, cancellable, raw => {
            counts.completed++;
            done(raw);
            if (counts.completed === target) loop.quit();
        });
    }, report: () => counts.errors++
});
const validate = loader._validate.bind(loader);
loader._validate = (id, raw) => { counts.validated++; return validate(id, raw); };
for (let generation = 0; generation < target; generation++) {
    loader.load(["example.large"], () => counts.delivered++);
}
if (ARGV[1] === "destroy") loader.destroy();
if (ARGV[1] === "empty") loader.load([], () => {});
const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
    counts.timedOut = true;
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
if (!counts.timedOut) GLib.source_remove(timeout);
loader.destroy();
print(JSON.stringify(counts));
