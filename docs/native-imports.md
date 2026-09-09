# Native Cinnamon import check

From the repository root, run:

```sh
python3 scripts/check_cinnamon_imports.py > /tmp/chronos-native-imports.json
```

The check requires Cinnamon, CJS, `csd-xsettings`, Python GI bindings,
`dbus-run-session` and `xvfb-run`. It creates private configuration, data, cache
and runtime directories **before** starting a separate D-Bus session and Xvfb
display. It copies the applet into that temporary profile, disables remote
providers, and starts a fresh Cinnamon. The user's desktop and applet settings
are not involved. The processes and temporary directories are cleaned up when
the check exits, including reported failures and timeouts.

The applet must construct successfully and open a 42-cell month grid. Every
root JavaScript file is then accessed through Cinnamon's actual applet-folder
importer, and every versioned module through its real
`fileUtils.requireModule` loader. No GI/UI stubs, Node VM or parser-only
substitute participates. The JSON report includes the installed Cinnamon and
CJS versions, imported paths, failures and SHA-256 hashes of the copied source.
A failed import returns a nonzero status and prints the isolated session logs
to stderr.

The ordinary Python suite runs this check, including real popup focus
regressions for asynchronous event and holiday arrivals. It also tests the
harness's isolation and teardown with fake processes. The native runtime and
display dependencies above are required for `npm test`, including in CI.
`npm run check:cjs-syntax` remains the lightweight parser check; it cannot prove
that a real module imports or that the applet constructs.

The integrated production tree was verified on Cinnamon 6.6.9 / CJS 115.1:
all 93 modules imported successfully (49 root modules and 44 versioned
modules, including `6.0/menuViewport.js`), the applet constructed, and its month
grid contained 42 cells. Reported source hashes matched the worktree exactly.
The `6.0/` directory is the loader selected by this desktop. Previous Cinnamon
versions are not compatibility targets. The import check does not replace
visual layout, keyboard navigation or provider tests.
