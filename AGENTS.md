# Cinnamon Chronos — agent instructions

Cinnamon applet (`files/chronos@geraldo-netto/`), GJS/cjs on the JS side and
GTK/Python on the settings side. `5.4/` is the multiversion tree Cinnamon loads.

## Gates

Both must be green before a commit:

```sh
npm run lint   # eslint (JS) + pyflakes (Python) — pyflakes missing is a failure, not a skip
npm test       # node:test + python suite, each with its own per-file coverage gate
```

Coverage gates: JS 98 % lines / 90 % branches / 100 % functions per file;
Python 98 % lines per file. They fail the run — they are not advisory.

`TODO.md` is the audit ledger. Items are worked one commit per item, and the row
is deleted from the ledger in that same commit.

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
