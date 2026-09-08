/* global ARGV, print */
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const modules = {};
const runtime = { gi: { Gio, GLib }, ui: { appletManager: {
    applets: { "chronos@geraldo-netto": modules }
} } };
for (const name of ["textUtils", "dateMath", "religiousCatalog", "holidayConstants",
    "holidayRecord", "calendarPluginData", "calendarPluginLoader"]) {
    const source = new TextDecoder().decode(GLib.file_get_contents(`${ARGV[0]}/${name}.js`)[1]);
    const module = { exports: {} };
    new Function("imports", "module", source)(runtime, module);
    modules[name] = module.exports;
}
const loop = GLib.MainLoop.new(null, false);
new modules.calendarPluginLoader.CalendarPluginLoader({ report: () => {} }).load(
    ["example.review"], (loaded) => {
        print(JSON.stringify(loaded.map(item => item.id)));
        loop.quit();
    });
loop.run();
