/* global ARGV, print */

const GLib = imports.gi.GLib;
imports.searchPath.unshift(ARGV[0]);
const astronomy = imports.astronomy;
const civilTime = imports.civilTime;
const source = imports.byteArray.toString(
    GLib.file_get_contents(ARGV[0] + "/astronomyDay.js")[1]);
// Load the actual module with a shell namespace stub; all date operations use
// the installed GLib and tzdata. Only Cinnamon's UI importer is substituted.
const day = new Function("imports", source + "\nreturn { civilDayBounds };")({
    gi: { GLib },
    ui: { appletManager: { applets: { "chronos@geraldo-netto": { astronomy, civilTime } } } }
});
const results = JSON.parse(ARGV[1]).map(({ now, zone }) =>
    day.civilDayBounds(new Date(now), GLib.TimeZone.new_identifier(zone)));
print(JSON.stringify(results));
