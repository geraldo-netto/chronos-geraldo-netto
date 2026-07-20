# Changelog

All notable changes to Cinnamon Chronos are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Development tooling and CI now require Node.js 22; Node.js 20 is no longer
  supported.
- The applet now uses original Chronos artwork instead of the inherited
  calendar@ccprog icon.

### Fixed

- Calendar, weather, clock, and runtime failures now share a visible popup
  footer, clear independently after recovery, and leave the current year visible
  in the calendar header.
- Zip-based installs now receive the complete applet icon instead of a corrupt
  12-byte symlink payload.

## [0.0.1] - 2026-07-17

### Added

- Initial development release of the Cinnamon 5.4+ calendar applet with calendar
  events, public holidays, weather, and world clocks.
- Reproducible Cinnamon Spices packaging, complete translation catalogs, and CI
  gates for the supported Node runtimes.

[Unreleased]: https://github.com/geraldo-netto/cinnamon-chronos/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/geraldo-netto/cinnamon-chronos/releases/tag/v0.0.1
