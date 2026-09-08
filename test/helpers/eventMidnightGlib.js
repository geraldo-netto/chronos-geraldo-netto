/* global ARGV, print */
const GLib = imports.gi.GLib;
imports.searchPath.unshift(ARGV[0]);
const modules = { dateMath: imports.dateMath, styleUtils: imports.styleUtils,
    textUtils: imports.textUtils, civilTime: imports.civilTime };
const runtime = { gi: { GLib }, ui: { appletManager: {
    applets: { "chronos@geraldo-netto": modules }
} } };
for (const name of ["eventData", "eventIndex"]) {
    const source = new TextDecoder().decode(GLib.file_get_contents(`${ARGV[0]}/${name}.js`)[1]);
    const module = { exports: {} };
    new Function("imports", "module", source)(runtime, module);
    modules[name] = module.exports;
}
const results = JSON.parse(ARGV[1]).map(({ start, end }) => {
    const unix = iso => GLib.DateTime.new_from_iso8601(iso, null).to_unix();
    const event = new modules.eventData.EventData({ deep_unpack: () =>
        ["boundary", "#abc", "Midnight event", false, unix(start), unix(end), 1] }, 1);
    const index = new modules.eventIndex.EventIndex();
    index.register(event, 1, event.start_date);
    return { end: event.end.to_unix(), days: Object.keys(index.eventsByDate).map(key =>
        GLib.DateTime.new_from_unix_local(Number(key)).format("%F")) };
});
print(JSON.stringify(results));
