# Manual mutation testing

Mutation campaigns, mutation tests, survivor review, and equivalent-mutant
decisions belong to the maintainer. Agents can maintain this launcher and test
its argument validation with a fake subprocess; they must not execute Stryker,
including its dry-run mode. The optional command is outside lint, ordinary
tests, coverage gates, CI, and release checks.

From the repository root, install the normal development dependencies and the
separately locked optional tool. Both require Node.js 22.13 or newer:

```sh
npm ci
npm ci --prefix tools/mutation --ignore-scripts
```

Stryker is pinned in `tools/mutation/package.json` and its own lockfile. Normal
`npm ci` does not install it. Review dependency updates and, when installed,
check its advisories separately with `npm audit --prefix tools/mutation`.
The pinned 9.6.1 release preserves the project's Node.js floor; Stryker 10's
Babel dependencies require a newer Node.js. A scoped override supplies
`typed-rest-client` with `qs` 6.16.0, which fixes its pinned version's
[denial-of-service advisories](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g).
Remove the override when the parent dependency accepts a patched release.

Inspect available scopes and their exact configuration without starting
Stryker or requiring its installation:

```sh
npm run mutation:manual -- --help
npm run mutation:manual -- --list
npm run mutation:manual -- holiday-record --print-config
```

Only the following command starts a campaign. The maintainer runs it manually:

```sh
npm run mutation:manual -- holiday-record
```

Each named scope in `tools/mutation/scopes.json` selects one production module
and existing ordinary tests. The launcher rejects unknown names and arbitrary
options. To change scope, review that file's source and test paths; preview the
result before running. Changes to test selection change what the result can
demonstrate. The [Stryker configuration documentation](https://stryker-mutator.io/docs/stryker-js/configuration/)
describes its underlying file and line-range selectors.

The command runner executes the selected `node --test` command for each
mutant, with one worker and coverage analysis disabled. It cannot distinguish
uncovered code from surviving mutations. Its five-second timeout allowance
is added to the measured test duration; it does not cap the complete campaign.
Stryker works on a sandbox copy under `.cache/chronos-mutation/sandbox`.
The [Node.js guide](https://stryker-mutator.io/docs/stryker-js/guides/nodejs/)
explains the command runner's role.

Reports stay in `.cache/chronos-mutation/reports/<scope>/index.html` and
`mutation.json`, and a later run of that scope replaces them. No dashboard
upload is configured. Only one campaign may run in a checkout at a time: the
launcher acquires `.cache/chronos-mutation/campaign.lock` before writing its
configuration and rejects overlapping launches, including different scopes.
This prevents campaigns from replacing each other's configuration, sandbox,
or reports. Normal completion and reported failures release the lock.

After an interrupted process or machine crash, a stale lock can remain. Read
`.cache/chronos-mutation/campaign.lock/owner.json` for the launcher's PID and
scope. Confirm both that launcher and its Stryker child have stopped before
removing the stale lock from the repository root:

```sh
rm -f .cache/chronos-mutation/campaign.lock/owner.json
rmdir .cache/chronos-mutation/campaign.lock
```

Help, listing, and configuration previews do not acquire the lock.

A surviving mutant means the chosen tests still passed;
the maintainer decides whether this exposes a missing behavior assertion,
insufficient scope, or equivalent behavior. A killed mutant caused a failure.
Timeouts count as detected; runtime and compile errors are excluded from the
score. Investigate infrastructure errors before interpreting results. See
[Stryker's report definitions](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/).

No score threshold fails the command. A zero exit status therefore does not
certify test quality; startup and execution failures still return a nonzero
status. No campaign result is claimed by merely installing or validating this
configuration.
