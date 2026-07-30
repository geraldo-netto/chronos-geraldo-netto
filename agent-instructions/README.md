# Agent Instruction Domains

This directory contains composable instruction modules. Use one or more files to
build a project-specific `AGENTS.md`.

## Suggested Base

Start most projects with:

- `general-agent-behavior.md`
- `architecture-and-boundaries.md`
- `testing-and-fuzzing.md`
- `review-and-todo.md` when the project uses `TODO.md` as a ledger
- `agent-workflow-context.md` for long-running agent sessions or subagent-heavy work
- `git-workflow.md` when agents may prepare commits or release changes

## Domain Files

- `general-agent-behavior.md` - universal agent conduct, editing rules, communication, and code quality.
- `architecture-and-boundaries.md` - layering, single responsibility, plugin seams, dependencies, and state machines.
- `agent-workflow-context.md` - subagents, context checkpoints, working-set hygiene, and user progress updates.
- `testing-and-fuzzing.md` - unit tests, coverage, fuzz/property tests, and verification.
- `review-and-todo.md` - TODO ledger rules, review categories, wiring gaps, dead code, and major-change rescans.
- `git-workflow.md` - staging/commit rules, Conventional Commits, hooks, lockfiles, release-history policy, and no AI self-attribution.
- `typescript-react-supabase.md` - TypeScript, React, hooks, UI layering, Supabase repositories/services/flows.
- `ui-ux.md` - interface quality, responsive layout, states, controls, visual design, and content safety.
- `python-ai-data.md` - Python structure, CLI/config, ingestion, ML, retrieval, RAG, vectorization, memory, and distributed work.
- `rust-systems.md` - Rust safety, ABI/FFI, kernel/no_std, concurrency, lifecycle, and systems verification.
- `electron-local-first.md` - Electron main/renderer isolation, secure preload/IPC, local AI/TTS sidecars, jobs, and derived artifacts.
- `database-api-migrations.md` - database boundaries, migrations, API/IPC contracts, and schema/type parity.
- `multi-tenancy-data-governance.md` - tenant isolation, data lifecycle, egress/consent, and key custody.
- `performance.md` - vectorization, zero-copy, memory layout, allocation, algorithms, streaming, and batching.
- `security.md` - threat modeling, validation, sanitization, safe APIs, secrets, auth, least privilege, and dependency risk.
- `reliability-observability.md` - idempotency, retries, invariants, timeouts, circuit breakers, crash recovery, and telemetry.
- `cli-config-docs.md` - CLI integrity, config discoverability, docs parity, data governance, and product engineering.
- `product-strategy-discovery.md` - product engineering, design thinking, JTBD, PMF, strategy, prioritization, and governance.
- `release-deploy-backup.md` - release/deploy engineering, production gates, backup/restore, and software lifecycle management.
- `binding-parity.md` - core/binding drift prevention, parity gates, generated docs, stubs, and shape snapshots.

## Example Composition

For a React/Supabase app:

```sh
cat \
  agent-instructions/general-agent-behavior.md \
  agent-instructions/agent-workflow-context.md \
  agent-instructions/architecture-and-boundaries.md \
  agent-instructions/testing-and-fuzzing.md \
  agent-instructions/review-and-todo.md \
  agent-instructions/git-workflow.md \
  agent-instructions/typescript-react-supabase.md \
  agent-instructions/database-api-migrations.md \
  agent-instructions/ui-ux.md \
  agent-instructions/security.md \
  > AGENTS.md
```

For a Python RAG project:

```sh
cat \
  agent-instructions/general-agent-behavior.md \
  agent-instructions/agent-workflow-context.md \
  agent-instructions/architecture-and-boundaries.md \
  agent-instructions/testing-and-fuzzing.md \
  agent-instructions/review-and-todo.md \
  agent-instructions/git-workflow.md \
  agent-instructions/python-ai-data.md \
  agent-instructions/performance.md \
  agent-instructions/security.md \
  agent-instructions/reliability-observability.md \
  agent-instructions/cli-config-docs.md \
  > AGENTS.md
```

For an Electron local-first app:

```sh
cat \
  agent-instructions/general-agent-behavior.md \
  agent-instructions/agent-workflow-context.md \
  agent-instructions/architecture-and-boundaries.md \
  agent-instructions/testing-and-fuzzing.md \
  agent-instructions/git-workflow.md \
  agent-instructions/typescript-react-supabase.md \
  agent-instructions/ui-ux.md \
  agent-instructions/electron-local-first.md \
  agent-instructions/database-api-migrations.md \
  agent-instructions/security.md \
  agent-instructions/reliability-observability.md \
  agent-instructions/release-deploy-backup.md \
  > AGENTS.md
```

For a multi-tenant SPA/API product:

```sh
cat \
  agent-instructions/general-agent-behavior.md \
  agent-instructions/agent-workflow-context.md \
  agent-instructions/architecture-and-boundaries.md \
  agent-instructions/testing-and-fuzzing.md \
  agent-instructions/review-and-todo.md \
  agent-instructions/git-workflow.md \
  agent-instructions/database-api-migrations.md \
  agent-instructions/multi-tenancy-data-governance.md \
  agent-instructions/ui-ux.md \
  agent-instructions/security.md \
  agent-instructions/reliability-observability.md \
  agent-instructions/product-strategy-discovery.md \
  agent-instructions/release-deploy-backup.md \
  > AGENTS.md
```
