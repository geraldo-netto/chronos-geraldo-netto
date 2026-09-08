/* global ARGV, print */
const GLib = imports.gi.GLib;
const CinnamonDesktop = imports.gi.CinnamonDesktop;
const modules = { localeText: { translate: text => text } };
const runtime = { gi: { GLib, CinnamonDesktop }, ui: { appletManager: {
    applets: { "chronos@geraldo-netto": modules }
} } };
for (const name of ["textUtils", "dateMath", "dateFormats"]) {
    const source = new TextDecoder().decode(GLib.file_get_contents(`${ARGV[0]}/${name}.js`)[1]);
    const module = { exports: {} };
    new Function("imports", "module", source)(runtime, module);
    modules[name] = module.exports;
}
const now = GLib.DateTime.new_from_iso8601("2026-09-09T12:34:56Z", null);
const clock = new CinnamonDesktop.WallClock();
const results = JSON.parse(ARGV[1]).map(input => {
    const format = modules.dateFormats.dateFormatOrDefault(input, "%H:%M");
    return { admitted: modules.dateFormats.dateFormatWithinLimit(input),
        format, glib: now.format(format), accepted: clock.set_format_string(format),
        clockVisible: Boolean(clock.get_clock_for_format(format)) };
});
print(JSON.stringify(results));
