# cinnamon-chronos

Chronos Calendar is a merge of `calendar@ccprog` and `calendar@simonwiles.net`.
It keeps the public-holiday, event, weather, and modern settings work from
`calendar@ccprog` while preserving the world-clock focus of Simon Wiles'
calendar fork.

## Requirements

### To run the applet

- Cinnamon **5.4 or newer**, with its `cjs` JavaScript engine and the
  **libsoup 3** typelib (`gir1.2-soup-3.0`). Cinnamon ships both; libsoup 3 is
  what the 5.4 floor is really about, and it also covers the calendar server the
  event view talks to over DBus.
- Python 3 with GTK bindings (`python3-gi`) — the settings dialog runs in its
  own Python process, not inside Cinnamon.
- An internet connection, only for holiday and weather data. Weather is off by
  default. Holidays start automatically only when the operating-system timezone
  maps to a supported country; choose **None (disable holidays)** to opt out.
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
| Node.js | **≥ 22.13.0** | the JS suite and its coverage gate | `sudo apt install nodejs npm` |
| Python 3 | ≥ 3.8 | the settings-widget suite | already present |
| eslint | `^10` range in `package.json` (exact version in `package-lock.json`) | `npm run lint:js` | `npm install` |
| pyflakes | any | `npm run lint:py` — a gate: the step fails when it is missing | `python3 -m pip install pyflakes` |
| cinnamon-xlet-makepot | ships with Cinnamon | regenerating `po/*.pot` via `po/makepot` | part of the `cinnamon` package |
| gettext | any | compiling catalogs (`msgfmt`) and rejecting active fuzzy entries (`msgattrib`) | `sudo apt install gettext` |

Run `npm ci` (or `npm install` when changing dependencies) before the JavaScript
suite or linter. It installs the three direct development dependencies declared
in `package.json`; the applet itself does not ship them. The suites run on
Node's built-in test runner and Python's `unittest`.

## Installation

### Manual installation

1. Copy the applet directory into your local applets folder:

   ```sh
   git clone https://github.com/geraldo-netto/cinnamon-chronos.git
   # the applets folder does not exist yet on a machine that has never
   # installed a third-party applet; rsync only creates the last component
   mkdir -p ~/.local/share/cinnamon/applets
   # --exclude keeps stale Python bytecode out of the install
   rsync -a --exclude '__pycache__' \
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

3. Reload Cinnamon (press `Ctrl`+`Alt`+`Esc`, or log out and back in — on
   Wayland only the latter works).
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
and builds the Spices tree after the lint and test gates pass on Node 22.13.0.

### Releasing

Releases use strict `major.minor.patch` versions. Record user-visible changes as
bullets under **Unreleased** in `CHANGELOG.md`, then run:

```sh
npm run release:bump -- 0.0.2
npm run lint
npm test
npm run i18n:check
npm run package:spices
```

The bump command refuses an empty Unreleased section or a version that does not
increase. It moves those notes into a dated release section and updates
`metadata.json`, `package.json`, both version owners in `package-lock.json`, and
the changelog comparison links. Review the changes and commit them with a
`chore(release): 0.0.2` commit, replacing the example version as appropriate.

After that commit is merged to `main` and its CI is green, create and push an
annotated matching tag:

```sh
git tag -a v0.0.2 -m "Cinnamon Chronos 0.0.2"
git push origin v0.0.2
```

Tag CI reruns the Node 22.13.0 gates and packaging, then rejects any tag that does
not match all three manifests and the dated changelog entry. The packaging job
uploads the exact gated tree as `chronos-spices-<commit SHA>-<run attempt>`, and
the release job downloads that same immutable artifact. After the release job
is green, download that artifact from the workflow run and publish or submit its
contents; do not rebuild the release from a local checkout.

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

**Panel Label section** (on the Calendar page)

| Setting | Default | What it does |
|---|---|---|
| Show weather on the panel | off | A small weather readout in the applet label (see below), next to the local time on every panel orientation. |
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

From the repository root, after `npm ci`. The suites require Node ≥ 22.13.0 for the
JavaScript tests and Python 3 for the settings tests:

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

npm run lint      # eslint over the applet and the tests, pyflakes over the Python
npm run lint:js   # eslint only
npm run lint:py   # pyflakes only
```

The eslint rules live in [`eslint.config.mjs`](eslint.config.mjs). It lints the
applet under `files/` as GJS and the suites under `test/` as Node, so run it
before opening a pull request — a lint failure is a build failure. That is
literal: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `npm run
lint` and `npm test` — both suites and both coverage gates — on every push and
pull request.

### How the source is laid out (development)

`metadata.json` sets `"multiversion": true`, so Cinnamon loads the applet from
`files/chronos@geraldo-netto/5.4/` — that is where `applet.js`, the UI classes,
the stylesheet and the settings schema live. Everything one directory up
(`weather.js`, `holidays.js`, `eventsManager.js`, …) is shared, GJS-and-Node
portable logic with no St or Clutter in it, which is what lets the test suite run
it under plain Node. The one-line files in `5.4/` with the same names as those
modules are shims: they hand the `5.4` tree the single importer-loaded copy of a
root module rather than a second one.

Two things about that split will bite you:

- **The two trees are loaded by different loaders.** Cinnamon's `require()` loads
  the `5.4/` tree and hands back a plain `module.exports`, so `const` and `class`
  export fine there. The root modules are loaded by the *GJS importer*, which
  only exposes top-level `var` and `function` declarations — a `const` reads back
  as `undefined` from another module. `test/applet_static.test.js` enforces this;
  Node cannot see the difference on its own.
- **Changing a root module needs a full Cinnamon restart.** GJS caches importer
  modules for the life of the process, so reloading the applet (`Alt`+`F2` → `r`,
  or the Applets manager's reload) re-runs the `5.4/` tree against the *old* copy
  of everything above it.

`po/` stays outside `5.4/` because a translation domain belongs to the applet,
not to a Cinnamon version: `cinnamon-xlet-makepot` extracts from the whole tree,
and both trees call the same `_()`.

## Features

Public holidays are underlined in the calendar grid, and styled as non-working
days like the weekend; hovering one names it. World clocks show additional time
zones, and the event view works like the stock Cinnamon calendar.

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
service that answered is named in the world-clock popup rather than under the
table, which is a table of times. Each row uses **Date format for tooltip**, whose
default is the fixed day-month, 24-hour order `11 Jul 22:52`, independent of the
desktop clock preference. The columns are as wide as their longest cell, so any
city name lines up, and the condition is spelled out rather than drawn: the
weather emoji are taller than the text font and would space the rows unevenly.
UTC is a time scale, not a place, so it carries no temperature; a reading nobody
has managed to refresh for an hour is marked as the last known one rather than
shown as current.

The city a world clock's weather is looked up for comes from its **timezone**,
not from the name you gave the clock: a clock called "Mom's place" is looked up
as the city its timezone names, and the name you typed never leaves the machine.

The holiday data are obtained from the webservice [Enrico](https://kayaposoft.com/enrico/)
by Kayaposoft.com, with [OpenHolidays](https://www.openholidaysapi.org/) and
[Nager.Date](https://date.nager.at/) as fallbacks. When the operating-system
timezone supplies the initial holiday country, lookup starts automatically;
otherwise nothing is sent until you pick one. The selected country, and the
region where a provider supports it, are sent to those services at most once
every 50 days per year of data (sooner after a failure), and the response is
cached under
`~/.cache/chronos@geraldo-netto/`.

### Third-party data

Both the weather and holiday readouts fetch from third-party services over
HTTPS. Weather is off by default; holidays start automatically only when the
operating-system timezone maps to a supported country. Responses are treated as untrusted: they
are size-capped, shape-checked, and colors or text taken from them are never
interpolated into markup. No account, API key, or personal data beyond the
location or country you configure is involved.

> Enrico Service 2.0 is a free service written in PHP providing public holidays for several 
  countries. You can use Enrico Service to display public holidays on your website or in your 
  desktop application written in any programming language.  
  Enrico Service 2.0 is an open-source software licensed under the MIT License so you can 
  study, contribute, change or use it. See Enrico source code on Github.

See [here](https://holidays.kayaposoft.com/) for a list of supported countries and
its regions. It needs to be noted that each change to their list needs to be reflected
by an update to this applet. While I will try to keep track, if you notice something
missing in the applet that the service offers, let me know about it.

Both the list of supported countries and the actual holiday data are provided
by Enrico. If you find errors or have suggestions, please contact them directly
at enrico@kayaposoft.com or raise an issue at [Github](https://github.com/jurajmajer/enrico).

If you find bugs in the applet itself or know about other sources of holiday information
that can be included as webservices, please
[tell me about them](https://github.com/geraldo-netto/cinnamon-chronos/issues).

## About Events and Holidays

Most people using calendars today have adopted the logic behind the iCalendar format (RFC 5545).
Applications using it may gloss over that, but the available categories for things to be
entered in a calendar are limited to: event, to-do, journal, free/busy and alarm.

Holidays do not really fit any of those. And because of that, they mostly get entered as
all-day (probably recurring) events, without any more distinction from the rest.

Suppose your calendar mentions someone's birthday. You will add it
to your calendar as a whole-day event. If the calendar also mentions your country's National
Holiday, both have no distinguishing feature that would make it possible to mark one and
not the other as a non-working day.

This applet distinguishes between holidays and events. They have separate data sources, and they 
are visualised in a different way.

Holidays are marked as non-working days, the same as a weekend day. (Religious observances are
not yet implemented).

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
  focus that Chronos keeps in the panel and the popup.

Both upstreams live in
[linuxmint/cinnamon-spices-applets](https://github.com/linuxmint/cinnamon-spices-applets).
The translations under `files/chronos@geraldo-netto/po/` keep their original
translator credits.

## License

GPL-2.0-or-later, the same license as the applets it derives from.
