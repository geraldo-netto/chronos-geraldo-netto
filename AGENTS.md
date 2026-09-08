# Cinnamon Chronos — agent instructions

Cinnamon applet (`files/chronos@geraldo-netto/`), GJS/cjs on the JS side and
GTK/Python on the settings side. `6.0/` is the multiversion tree Cinnamon loads.

## Compatibility policy

The maintainer does not require compatibility with previous implementations,
versions, runtimes, APIs, settings, cache/data formats, or calendar plugins.
Breaking changes are acceptable unless compatibility is explicitly requested
for a specific task. Do not add or retain shims, legacy aliases, fallback
branches, dual formats, migrations, or old-runtime workarounds solely to
preserve compatibility. When changing a component, remove compatibility-only
paths it replaces and update the affected tests and documentation to describe
the current behavior. Breaking compatibility alone is not a reason to block
work or request approval. This project policy takes precedence over conflicting
compatibility guidance in the imported instruction modules.

## Gates

Every confirmed behavioral bug fix must include a permanent automated
regression test. Add it before the fix, prove it reproduces the failure, and
verify that the same test passes afterward. Reference the TODO id in the test.
Temporary probes and manual checks supplement this test; they do not replace
it. Retain the regression permanently in the normal automated suite. Never
delete, skip, or weaken it because the bug is fixed; remove only the resolved
TODO row. If automation is unavailable, record the exact obstacle and missing
test in TODO.md and keep the bug unresolved.

For review-only tasks, record the reproduction and required regression coverage
in TODO.md; implement the tests with the fixes unless the maintainer requests
them during review. Documentation-only and policy-only findings do not need
artificial behavior tests.

Both must be green before a commit:

```sh
npm run lint   # eslint (JS) + pyflakes (Python) — pyflakes missing is a failure, not a skip
npm test       # node:test + python suite, each with its own per-file coverage gate
```

Coverage gates: JS and Python each require 80 % lines / 80 % branches / 80 %
functions per file. They fail the run — they are not advisory.

`TODO.md` is the audit ledger. Items are worked one commit per item, and the row
is deleted from the ledger in that same commit — but only when the work is
genuinely finished. An item implemented only in part keeps its row, and the
description gains exactly what is still missing, naming the specific remainder
rather than calling it partial. A row deleted after half the work silently loses
the rest: nothing records it and nobody finds it again. Work the resolution newly
reveals is a new row with a new id, not a note appended to the old one.

Every new actionable finding discovered during review, implementation, testing,
or maintenance must be added to the root `TODO.md` immediately. Never leave a
finding only in chat or defer recording it because it is outside the current
task.

## Change history

Git history, Conventional Commits, and annotated release tags are the sole
change record. Never create or maintain `CHANGELOG.md`, add changelog gates or
release steps, or file TODO items asking for changelog updates.

## Instruction domains

The reusable modules live in `agent-instructions/`, one file per domain, with
`agent-instructions/README.md` explaining the set and how to compose it for other
projects. The ones that apply to *this* project are imported below, so they are
in context from the start.

@agent-instructions/general-agent-behavior.md
@agent-instructions/architecture-and-boundaries.md
@agent-instructions/agent-workflow-context.md
@agent-instructions/testing-and-fuzzing.md
@agent-instructions/review-and-todo.md
@agent-instructions/git-workflow.md
@agent-instructions/security.md
@agent-instructions/reliability-observability.md

Not imported, because this project is not one of these, but available in
`agent-instructions/` if the scope ever changes: `typescript-react-supabase`,
`rust-systems`, `electron-local-first`, `python-ai-data`, `binding-parity`,
`multi-tenancy-data-governance`, `database-api-migrations`, `ui-ux`,
`performance`, `cli-config-docs`, `product-strategy-discovery`,
`release-deploy-backup`.
