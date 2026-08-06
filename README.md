# cinnamon-chronos

Chronos Calendar is a merge of `calendar@ccprog` and `calendar@simonwiles.net`.
It keeps the public-holiday, event, weather, and modern settings work from
`calendar@ccprog` while preserving the world-clock focus of Simon Wiles'
calendar fork.

## Requirements

### To run the applet

- Cinnamon **6.0 or newer**, with its `cjs` JavaScript engine and the
  **libsoup 3** typelib (`gir1.2-soup-3.0`). Cinnamon ships both; libsoup 3 is
  what the 6.0 floor is really about, and it also covers the calendar server the
  event view talks to over DBus.
- Python **3.10 or newer** with GTK bindings (`python3-gi`) — the settings
  dialog runs in its own Python process, not inside Cinnamon. Linux Mint 21.3,
  the oldest desktop release covered by the Cinnamon 6.0 floor, ships Python
  3.10.
- An internet connection, only for public-holiday and weather data. Religious
  observances use bundled local data and need no connection. Weather is off by
  default. Public-holiday lookup starts automatically only when the
  operating-system timezone maps to a supported country. Choose **None (disable holidays)** to opt out.
- Optional: the Python 3 `pytz` module (`python3-pytz` on Mint/Debian/Ubuntu),
  used by the settings dialog to auto-complete and validate the timezone you
  type. Without it, Python's built-in `zoneinfo` database serves the same
  suggestions when available; if neither timezone database is available, the
  dialog falls back to plain typed timezone entry.
- `gettext`, for `msgfmt` and `msgattrib` — to compile translations at install
  time and reject ignored fuzzy entries in the i18n gate (step 2 below). Mint
  ships `gettext-base`, which does not carry these tools.

There is no build step for the code. Cinnamon loads the JavaScript from `files/`
as it is written — nothing is compiled, bundled, or transpiled. The one thing
that *is* compiled is the translations: the applet reads `po/*.mo` catalogs, and
only `po/*.po` sources are in the repository. Nothing compiles them for you —
not Cinnamon, not the applet — so a copy-and-reload install is English-only until
you run the one command in step 2 below, which is why it is a step and not a
footnote.

On Linux Mint everything above is already installed except `pytz` and `gettext`:

```sh
sudo apt install python3-pytz gettext
```

### To work on the applet

Only needed if you are running the suites or the linters — none of it ships
with the applet:

| Tool | Version | Needed for | Install |
| --- | --- | --- | --- |
| Node.js | **≥ 22.13.0** | the JS suite and its coverage gate | install with `nvm` as described below |
| Python 3 | ≥ 3.12 | the development gates and settings-widget suite | use your distribution or `pyenv` |
| eslint | `^10` range in `package.json` (exact version in `package-lock.json`) | `npm run lint:js` | `npm install` |
| pyflakes | any | `npm run lint:py` — a gate: the step fails when it is missing | `python3 -m pip install pyflakes` |
| cinnamon-xlet-makepot | ships with Cinnamon | regenerating `po/*.pot` via `po/makepot` | part of the `cinnamon` package |
| gettext | any | compiling catalogs (`msgfmt`) and rejecting active fuzzy entries (`msgattrib`) | `sudo apt install gettext` |

Linux Mint's package repository can provide a Node.js release older than this
project supports. Install the maintained [Node Version Manager
(`nvm`)](https://github.com/nvm-sh/nvm#installing-and-updating), then install and
verify the supported floor before installing project dependencies:

```sh
nvm install 22.13.0
nvm use 22.13.0
node --version                 # must print v22.13.0 or newer
npm ci
```

Use `npm install` instead when changing dependencies. npm installs the three
direct development dependencies declared in `package.json`; the applet itself
does not ship them. The suites run on Node's built-in test runner and Python's
`unittest`.

## Installation

### Manual installation

1. Copy the applet directory into your local applets folder:

   ```sh
   git clone https://github.com/geraldo-netto/cinnamon-chronos.git
   # the applets folder does not exist yet on a machine that has never
   # installed a third-party applet; rsync only creates the last component
   mkdir -p ~/.local/share/cinnamon/applets
   # --delete removes files upstream no longer ships; --delete-excluded also
   # clears stale bytecode and editor backups that the source omits
   rsync -a --delete --delete-excluded \
         --exclude '__pycache__' --exclude '*~' \
         "cinnamon-chronos/files/chronos@geraldo-netto" \
         ~/.local/share/cinnamon/applets/
   ```

2. Compile the translations. Copying the applet does not do this, and neither
   does Cinnamon: without it every string is English, whatever your locale.

   ```sh
   # msgfmt each po/*.po into ~/.local/share/locale/<lang>/LC_MESSAGES/,
   # which is where the applet looks the catalogs up
   cinnamon-xlet-makepot -i ~/.local/share/cinnamon/applets/chronos@geraldo-netto
   ```

   Re-run it after every update — a `.po` that changed upstream is a `.mo` that
   is stale here.

3. Restart Cinnamon (press `Ctrl`+`Alt`+`Esc`, or log out and back in — on
   Wayland only the latter works). After an in-place update, restart Cinnamon
   fully; do not use the Applets manager's **Reload** action or `ReloadXlet`,
   because they keep the previous root modules cached.
4. Right-click a panel → **Applets** → **Manage**, select **Chronos Calendar**
   and click **+** to add it to the panel.

Since it replaces the stock clock, you may want to right-click the stock
**Calendar** applet and remove it from the panel afterwards.

### From Cinnamon Spices

Not yet published. Once the applet is accepted into the
[Cinnamon Spices](https://cinnamon-spices.linuxmint.com/applets) catalogue you
will be able to install it from a panel's **Applets → Download** tab by
searching for **Chronos Calendar**; until then, use the manual installation
above.

### Preparing a Cinnamon Spices submission

Run `npm run package:spices` after the gates. It recreates
`dist/chronos@geraldo-netto/` with only `info.json`, `screenshot.png`,
`README.md`, and `files/` — the applet subtree that belongs in the Spices
catalogue. Development files such as the test suite, npm metadata, audit ledger,
and CI configuration are deliberately excluded. The staged files come from the
Git index, so ignored or untracked artifacts cannot enter it. Tracked symlinks
are accepted only when their final target is also tracked inside the source
tree, and are copied as real files for archive-based delivery.

`npm run i18n:check` validates every language catalog with `msgfmt`, rejects
active fuzzy translations with `msgattrib`, and regenerates the translation
template in a temporary directory to prove it is current. CI runs every check
and builds the Spices tree after the lint and test gates pass on the supported
Node 22.13.0 and development Python 3.12 floors, and on the current Node 26 /
Python 3.14 pair. The lint gate separately parses every shipped Python module
with Python 3.10's grammar, so raising the development-tool floor does not
silently raise the applet's runtime floor.

### Releasing

Releases use strict `major.minor.patch` versions. Git history, Conventional
Commits, and annotated tags are the change record. The upstream default and release
branch is `develop`. Version `0.0.1` records the untagged development baseline,
not a published release, so public releases begin with `0.0.2`. Prepare it with:

```sh
npm run release:bump -- 0.0.2
npm run lint
npm test
npm run i18n:check
git diff --check
git add package.json package-lock.json files/chronos@geraldo-netto/metadata.json \
        files/chronos@geraldo-netto/po/chronos@geraldo-netto.pot
git commit -m "chore(release): 0.0.2"
npm run package:spices
```

The bump command refuses a version that does not increase and atomically updates
`metadata.json`, `package.json`, both version owners in `package-lock.json`, and
the `Project-Id-Version` header of the translation template, which `po/makepot`
stamps from `metadata.json` and `npm run i18n:check` verifies.
Review the changes before staging them, and replace the example version in both
the command and commit message. Packaging comes after the commit because the
submission is built from Git-index bytes; this guarantees the staged artifact
contains the version that just passed the gates instead of pre-bump metadata.

**A new export on an already-shipped root module can break the update itself.**
Cinnamon reloads an applet after a Spices update, and that reload does not clear
the GJS importer's cached `imports.ui.appletManager.applets[uuid]` subtree. The
`6.0/` tree is re-read; everything one directory up is not. So a release whose
`6.0/` code calls something that exists only in the *new* copy of a root module
runs against the old one and throws — the applet lands broken on an ordinary
update, and stays broken until the user restarts Cinnamon, which nothing in the
update prompts them to do. Within a release, prefer additive changes that keep
new cross-module APIs out of already-shipped root modules: put the new code in
the `6.0/` tree, which is re-read on reload. When a root-module export genuinely
has to change, treat it as needing a Cinnamon restart and say so in the release
notes.

After that commit is pushed to `develop` and its branch CI is green, create and
push an annotated matching tag:

```sh
git tag -a v0.0.2 -m "Cinnamon Chronos 0.0.2"
git push origin v0.0.2
```

Tag CI reruns both gate matrix pairs, packages on the supported Node floor, then
rejects any tag that disagrees with `metadata.json`, `package.json`, either
version owner in `package-lock.json`, or the translation template's
`Project-Id-Version`. The packaging job puts the exact gated tree and its
SHA-256 manifest in a mode-preserving `chronos-spices.tar`, then uploads it as
`chronos-spices-<commit SHA>`, replacing that same deterministic artifact when
all jobs are rerun. The archive sorts paths and normalizes timestamps,
ownership, and portable file modes while preserving which tracked files are
executable. The release job
downloads the tar, verifies every checksum and executable mode, and extracts the
Spices tree. After the release job is green, download that artifact from the
workflow run, extract `chronos-spices.tar`, and publish or submit the
`chronos@geraldo-netto/` directory; do not rebuild the release from a local
checkout.

### Configuration

Right-click the applet → **Configure...**. Everything the applet ships:

**Calendar page**

| Setting | Default | What it does |
|---|---|---|
| Show calendar events | on | Shows the event column beside the grid, from your Evolution/GNOME calendars. |
| Show week numbers in calendar | off | Adds the week-number gutter. |
| Mark as weekend days | two days | How many days a week are styled as non-working; which days come from your locale. |
| Date formats | `%d %b %H:%M` | The always-visible **Date format** and **Date format for tooltip** fields control the panel label and each tooltip row; the **Show information on date format syntax** button opens the reference. |
| Country / Region | country from the operating-system timezone, or None | Marks that country's nationwide public holidays in the grid (see below). Type into the field to filter the country list instead of scrolling it; any country you select overrides the inferred default. |
| Religious observances / religions | off / none selected | Shows locally calculated observances for the religions you select. They are underlined but remain working days; see the date limits below. |
| Show calendar (under **Keyboard shortcuts**) | `<Super>c` | Opens the calendar menu. |

The panel label and world-clock rows use **Date format**. Every tooltip location
row uses **Date format for tooltip**, followed by its temperature and weather
description when available. The weather readout, when enabled, follows the panel
label.

**World Clocks page**

| Setting | Default | What it does |
|---|---|---|
| Show world clocks in the calendar menu | on | Shows the clock rows under the calendar, including the built-in UTC and local time. |
| World Clocks | empty | Up to 8 timezones on top of the built-in rows. |

**Weather and location services section** (on the Calendar page)

| Setting | Default | What it does |
|---|---|---|
| Show weather on the panel | off | A small weather readout in the applet label (see below), next to the local time on every panel orientation. |
| Show sun and moon times | on when weather is enabled | Shows sunrise, sunset, moonrise, and moonset in the popup. The switch is available only while weather is enabled because it reuses weather's resolved location. |
| Weather location / units | your timezone's city / SI | The place to forecast and the temperature scale. The location field suggests city names as you type. The suggestions come from the timezone database already on the machine (the few hundred cities it names, the same list the world clocks complete against), so nothing is sent anywhere while you type — and because that is not a full gazetteer, a smaller town will not be suggested. The field stays free text: any name you type is still saved and sent to the geocoder when the applet next refreshes. |

**The location fills itself in.** An empty location is filled with the city your
own timezone names — `Europe/Rome` becomes `Rome` — so the weather works before
you have typed anything. This is read off the machine: no IP address is sent to a
geolocation service to work out where you are. A timezone names its region's
reference city and not necessarily your town, so the city is written *into the
field* rather than used invisibly: if you are in Genoa it will say Rome, and you
can correct it. Clearing the field saves an empty location and the panel shows
its setup warning. Reopening the settings dialog or reloading the applet restores
the timezone-derived city when one is available; typing another city replaces it.

When weather and **Show sun and moon times** are enabled, the popup also shows
today's sunrise, sunset, moonrise, and moonset. It reuses the geocoder's retained
latitude and longitude: the event times are calculated locally, with no
astronomy service or additional network request. When the weather geocoder
returns the place's timezone, it also defines which civil day and wall-clock
times the popup shows; a fallback geocoder without timezone data uses the
machine's local timezone. Polar days and nights are shown as continuous above-
or below-horizon states instead of invented event times. Disabling weather hides
these rows along with stopping the location lookup.

The world clocks never appear on the panel. The panel is one line, which the date
and the weather readout already share; the clocks are a table, and they are shown
in the two places with room for them — the panel's tooltip and the popup.

For a new settings profile, the holiday country is filled from the operating-system timezone:
`Europe/Rome` becomes **Italy**. This uses the local timezone database, not IP
geolocation. UTC, an unsupported timezone country, or unavailable timezone data
leaves holidays disabled. The timezone cannot identify a state or province, so
the inferred region stays **Nationwide only**. Any country or region you choose
afterwards is preserved; choose **None (disable holidays)** to turn holiday
marking off. Upgrades also preserve an existing country or **None** instead of
reinterpreting it as a new default. An enabled holiday lookup sends the selected
country and region to third-party holiday services.

In the menu the grid is keyboard-navigable: arrows move by day and week,
PageUp/PageDown by month, Home returns to today.

### Running the tests and linters (development)

From the repository root, after `npm ci`. The suites require Node ≥ 22.13.0 for
the JavaScript tests and Python ≥ 3.12 for the settings tests:

```sh
npm test          # both suites, behind the coverage gate
npm run test:js   # JS only
npm run test:py   # Python settings widgets only
```

The linters do need the two tools listed under
[Requirements](#to-work-on-the-applet). Neither is optional: `lint:py` fails when
pyflakes is missing rather than skipping itself, because a lint step that passes
by not running is worse than no lint step at all.

```sh
npm ci                           # installs the locked JavaScript tooling
python3 -m pip install pyflakes   # required: the Python lint step is a gate

npm run lint                  # Python 3.10 syntax, eslint, and pyflakes
npm run check:python-runtime  # shipped settings code against Python 3.10 grammar
npm run lint:js               # eslint only
npm run lint:py               # pyflakes over shipped code, scripts, and tests
```

The eslint rules live in [`eslint.config.mjs`](eslint.config.mjs). It lints the
applet under `files/` as GJS and the suites under `test/` as Node, so run it
before opening a pull request — a lint failure is a build failure. That is
literal: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `npm run
lint` and `npm test` — both suites and both coverage gates — on every pull
request and on pushes to `develop` and `v*` tags. Maintainers can run the same
pipeline manually from GitHub Actions or with `gh workflow run CI --ref develop`
when a push event does not create a run.

### How the source is laid out (development)

`metadata.json` sets `"multiversion": true`, so Cinnamon loads the applet from
`files/chronos@geraldo-netto/6.0/` — that is where `applet.js`, the UI classes,
the stylesheet and the settings schema live. Everything one directory up
(`weather.js`, `holidays.js`, `eventsManager.js`, …) is shared, GJS-and-Node
portable logic with no St or Clutter in it, which is what lets the test suite run
it under plain Node. The one-line files in `6.0/` with the same names as those
modules are shims: they hand the `6.0` tree the single importer-loaded copy of a
root module rather than a second one.

Two things about that split will bite you:

- **The two trees are loaded by different loaders.** Cinnamon's `require()` loads
  the `6.0/` tree and hands back a plain `module.exports`, so `const` and `class`
  export fine there. The root modules are loaded by the *GJS importer*, which
  only exposes top-level `var` and `function` declarations — a `const` reads back
  as `undefined` from another module. `test/applet_static.test.js` enforces this;
  Node cannot see the difference on its own.
- **Changing a root module needs a full Cinnamon restart.** GJS caches importer
  modules for the life of the process, so reloading the applet (`Alt`+`F2` → `r`,
  or the Applets manager's reload) re-runs the `6.0/` tree against the *old* copy
  of everything above it. Verified on Cinnamon 6.6.9: after a reload that had
  added `NetworkState` to `ioUtils.js`, a freshly re-read
  `6.0/appletLifecycle.js` ran against the cached `ioUtils` and threw
  `IoUtils.NetworkState is not a constructor` until `global.reexec_self()`. The
  `6.0/` shims resolve through that same cached
  `imports.ui.appletManager.applets[uuid]` subtree, so they are not a way around
  it. This is a release constraint as much as a development one — see
  [Releasing](#releasing).

`po/` stays outside `6.0/` because a translation domain belongs to the applet,
not to a Cinnamon version: `cinnamon-xlet-makepot` extracts from the whole tree,
and both trees call the same `_()`.

## Features

Public holidays are underlined in the calendar grid and styled as non-working
days like the weekend. Optional religious observances are also underlined, but
remain working days unless a public holiday falls on the same date. Hovering a
marked day names every matching holiday or observance. World clocks show
additional time zones, and the event view works like the stock Cinnamon
calendar.

Choose the Country and region for which to show the public holidays in the applet
"Calendar" settings page. For a new settings profile, the country defaults from the machine's
IANA timezone when that timezone maps to a supported country; otherwise it stays
**None (disable holidays)**. This is a one-time default, so later user choices are
never overwritten. The world-clock list in the calendar menu always
shows UTC, your local time, and the digital readouts for any configured
timezones; uncheck **Show world clocks in the calendar menu** to hide the whole
block. Add more timezones in the applet "World Clocks" settings page: up
to 8 extra clocks can be configured. Type the city into the timezone field and
pick it from the suggestions ("Buenos Aires (America / Argentina)"), or type an
IANA timezone identifier (e.g. `America/Sao_Paulo`) or a bare city name (e.g.
`tokyo`) yourself.

Religious observances are disabled by default. Enable **Show religious
observances**, then select one or more of Christianity, Islam, Hinduism,
Buddhism, Sikhism, Judaism, the Bahá'í Faith, Jainism, Shinto, and Taoism. The
catalogue and every religion selection stay on this computer: enabling them
makes no network request and writes no religious preference outside Cinnamon's
local applet settings.

Fixed-date observances and Gregorian Easter-relative Christian dates can be
calculated for any supported calendar year. Dates tied to observational,
astronomical, lunar, or lunisolar calendars are bundled only for **2025–2027**;
outside that window those entries are omitted. Such dates can differ by
community, location, and moon sighting. Sunset-starting and multi-day
observances are represented by their first listed civil day. Treat the display
as a calendar aid, not an authority for leave, worship, or travel planning.

The optional weather readout uses Open-Meteo, falling back to the NOAA
Aviation Weather METAR service and then to MET Norway. The applet remembers
which service answered last and asks that one first for the rest of the session,
so after one Open-Meteo failure it will keep going to NOAA first — the order
above is the starting order, not a fixed priority. When enabled, the
configured weather location is sent to `geocoding-api.open-meteo.com` to
resolve coordinates (falling back to `nominatim.openstreetmap.org` when
Open-Meteo cannot resolve the place), then the coordinates are sent to
`api.open-meteo.com` for the current forecast about every 30 minutes; if that
fails, `aviationweather.gov` is asked for the METARs around the place and the
nearest reporting airport is used, and `api.met.no` is the last resort. The
applet keeps resolved coordinates in memory while it is running; disabling
weather stops these lookups.

Nominatim search data is © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
All panel and world-clock Nominatim fallbacks share one process-wide queue:
requests are single-flight and start no more than once per second.

With weather on, each configured world-clock city is resolved and read the same
way, so the tooltip can show a temperature next to every clock. That is one
lookup per city, on the same 30-minute period; with weather off, no city is
looked up and the tooltip shows times only.

Hovering the panel gives the whole table — UTC first, then local time, then
each configured city — as `city  date time  temperature  condition`. The
tooltip remains only that table. The popup visibly shows each city's time and
temperature; its world-clock table's accessible name credits every weather
service that supplied a displayed reading. Each tooltip row uses **Date format
for tooltip**, whose default is the fixed day-month, 24-hour order `11 Jul
22:52`, independent of the desktop clock preference. The columns are as wide as
their longest cell, so any city name lines up, and the condition is spelled out
rather than drawn: the weather emoji are taller than the text font and would
space the rows unevenly. UTC is a time scale, not a place, so it carries no
temperature; a reading nobody has managed to refresh for an hour is marked as
the last known one rather than shown as current.

The city a world clock's weather is looked up for comes from its **timezone**,
not from the name you gave the clock: a clock called "Mom's place" is looked up
as the city its timezone names, and the name you typed never leaves the machine.

Public-holiday data are obtained from the web service [Enrico](https://kayaposoft.com/enrico/)
by Kayaposoft.com, with [OpenHolidays](https://www.openholidaysapi.org/) and
[Nager.Date](https://date.nager.at/) as fallbacks. After a provider answers, it
is tried first for the rest of the session. When the operating-system timezone
supplies the initial holiday country, lookup starts automatically; otherwise
nothing is sent until you pick one. The selected country, and the region where
a provider supports it, are sent to the providers at most once every 50 days
per year of data (sooner after a failure), and the response is cached under
`~/.cache/chronos@geraldo-netto/`.

Religious-observance data are bundled with the applet and computed locally.
Neither the enabled religions nor their dates are sent to Enrico, OpenHolidays,
Nager.Date, or any other service.

### Third-party data

Weather and public-holiday readouts fetch from third-party services over HTTPS;
religious observances do not. Weather is off by default; public holidays start
automatically only when the operating-system timezone maps to a supported
country. Responses are treated as untrusted: they are size-capped,
shape-checked, and colors or text taken from them are never interpolated into
markup. No account or API key is involved. The network-visible values are the
weather location and world-clock cities used for forecasts, plus the holiday
country and region you configure.

The applet maintains its own supported-country and region mappings because the
three holiday providers cover different sets and formats. Enrico Service 2.0 is
[MIT-licensed open-source software](https://github.com/jurajmajer/enrico); its
[service page](https://holidays.kayaposoft.com/) lists Enrico's own coverage.
If a holiday looks wrong, report the country, region, year, and observed result
to the [Chronos issue tracker](https://github.com/geraldo-netto/cinnamon-chronos/issues)
first so the adapter and fallback path can be identified. Provider-specific
source-data corrections can then be reported to Enrico, OpenHolidays, or
Nager.Date through the links above.

## About Events and Holidays

Most people using calendars today have adopted the logic behind the iCalendar
format (RFC 5545). Applications using it may gloss over that, but the available
categories for things entered in a calendar are limited to event, to-do,
journal, free/busy, and alarm.

Holidays do not really fit any of those. And because of that, they mostly get entered as
all-day (probably recurring) events, without any more distinction from the rest.

Suppose your calendar mentions someone's birthday. You will add it as an all-day
event. If the calendar also mentions your country's national holiday, neither
entry has a feature that makes it possible to mark one, but not the other, as a
non-working day.

This applet distinguishes between holidays and events. They have separate data
sources and are visualized differently.

Public holidays are marked as non-working days, the same as a weekend day.
Religious observances use the same underline and tooltip but do not change a
working day into a non-working one.

Events are marked separately, and their details are shown in a side column.

## Authors and credits

Chronos Calendar is maintained by **Geraldo Netto** (`geraldo-netto`) at
[github.com/geraldo-netto/cinnamon-chronos](https://github.com/geraldo-netto/cinnamon-chronos).

It is a derived work. The original applets, and their authors, are:

- **`calendar@ccprog`** — Claus Colloseus (`ccprog`): public holidays, events,
  weather, the settings dialog, the world-clock settings workflow, and the
  locale-aware weekend handling. The shipped icon is an original Chronos
  design and the screenshot is a current Chronos capture; neither is a
  `calendar@ccprog` asset anymore.
- **`calendar@simonwiles.net`** — Simon Wiles (`simonwiles`): the world-clock
  focus that Chronos keeps in the popup and the panel tooltip.

Both upstreams live in
[linuxmint/cinnamon-spices-applets](https://github.com/linuxmint/cinnamon-spices-applets).
The translations under `files/chronos@geraldo-netto/po/` keep their original
translator credits.

## License

GPL-2.0-or-later, the same license as the applets it derives from.
