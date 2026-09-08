/* global ARGV, print */

const GLib = imports.gi.GLib;
imports.searchPath.unshift(ARGV[0]);
const modules = {
    dateMath: imports.dateMath, styleUtils: imports.styleUtils, textUtils: imports.textUtils,
    civilTime: imports.civilTime
};
const shellImports = {
    gi: { GLib, Cinnamon: { util_get_week_start: () => Number(ARGV[3]) } },
    ui: { appletManager: { applets: { "chronos@geraldo-netto": modules } } }
};
function load(name, symbols) {
    const source = imports.byteArray.toString(GLib.file_get_contents(ARGV[0] + "/" + name + ".js")[1]);
    return new Function("imports", source + "\nreturn {" + symbols + "};")(shellImports);
}
modules.eventData = load("eventData", "date_only, month_year_only, dt_equals, js_date_to_gdatetime, EventData");
const { EventWindowCoordinator } = load("eventWindow", "EventWindowCoordinator");
const coordinator = new EventWindowCoordinator({ reset() {} });
const format = unix => GLib.DateTime.new_from_unix_local(unix).format("%F %T");
let bounds;
coordinator.fetchMonthEvents(GLib.DateTime.new_local(Number(ARGV[1]), Number(ARGV[2]), 1, 0, 0, 0),
    false, (start, end) => {
        bounds = { start: format(start), end: format(end), startUnix: start, endUnix: end,
            startOffset: GLib.DateTime.new_from_unix_local(start).get_utc_offset() / 1000000,
            endOffset: GLib.DateTime.new_from_unix_local(end).get_utc_offset() / 1000000 };
    },
    () => 1, () => {});
// Real event day keys must agree with the fetch boundary for either copy of a
// repeated midnight. These are provider timestamps, not constructed local times.
bounds.eventDays = JSON.parse(ARGV[4] || "[]").map(unix => {
    const event = new modules.eventData.EventData({
        deep_unpack: () => ["event", "#fff", "Event", false, unix, unix + 60, 1]
    }, 0);
    return event.start_date.to_unix();
});
print(JSON.stringify(bounds));
