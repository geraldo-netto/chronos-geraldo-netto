/* global ARGV, print */

const GLib = imports.gi.GLib;
imports.searchPath.unshift(ARGV[0]);
const results = JSON.parse(ARGV[1]).map(([zone, year, month, day]) => {
    const start = imports.civilTime.civilDayStart(year, month, day,
        GLib.TimeZone.new_identifier(zone));
    return { zone, year: start.get_year(), month: start.get_month(),
        day: start.get_day_of_month(), unix: start.to_unix(),
        offset: start.get_utc_offset() / 1000000 };
});
print(JSON.stringify(results));
