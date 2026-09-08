/* global ARGV, print */

const GLib = imports.gi.GLib;
imports.searchPath.unshift(ARGV[0]);
const modules = {
    dateMath: imports.dateMath, styleUtils: imports.styleUtils, textUtils: imports.textUtils
};
const shellImports = {
    gi: { GLib, Cinnamon: { util_get_week_start: () => Number(ARGV[3]) } },
    ui: { appletManager: { applets: { "chronos@geraldo-netto": modules } } }
};
function load(name, symbols) {
    const source = imports.byteArray.toString(GLib.file_get_contents(ARGV[0] + "/" + name + ".js")[1]);
    return new Function("imports", source + "\nreturn {" + symbols + "};")(shellImports);
}
modules.eventData = load("eventData", "date_only, month_year_only, dt_equals, js_date_to_gdatetime");
const { EventWindowCoordinator } = load("eventWindow", "EventWindowCoordinator");
const coordinator = new EventWindowCoordinator({ reset() {} });
const format = unix => GLib.DateTime.new_from_unix_local(unix).format("%F %T");
let bounds;
coordinator.fetchMonthEvents(GLib.DateTime.new_local(Number(ARGV[1]), Number(ARGV[2]), 1, 0, 0, 0),
    false, (start, end) => { bounds = { start: format(start), end: format(end) }; },
    () => 1, () => {});
print(JSON.stringify(bounds));
