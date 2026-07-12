# Database, API Contracts, And Migrations

Use this module for projects with schemas, migrations, REST/OpenAPI contracts, local databases, or typed IPC/API contracts.

## Database Boundaries

- UI layers must not access databases directly.
- Use repositories, stores, or adapters as the only raw database access points.
- Services own orchestration and transactions.
- Keep SQL, query builders, and schema-specific details out of presentation code.

## Migrations

- Every schema change needs a migration generated through the project command.
- Do not consider a task complete only because the migration command succeeded.
- Verify the real database after migration:
  - migration history table
  - altered table structure
  - indexes
  - constraints
  - column types
  - extensions
- Include migration verification in the final summary when migrations are part of the task.
- For local-first apps, distinguish canonical database state from derived filesystem artifacts.

## API Contracts

- The public API or IPC contract is a compatibility artifact, not just documentation.
- Spec and routes should match in both directions: no undocumented routes, no dead spec paths.
- Every operation should declare its full error surface, including auth, validation, conflict, rate-limit, and not-found cases.
- Schemas should be fully typed. Avoid loose `additionalProperties` bags unless intentional.
- Public ids should remain opaque; do not leak internal primary keys.
- PATCH and PUT semantics should be explicit.
- Idempotency requirements should be declared per mutation where relevant.
- Generated client types should stay in CI-enforced lockstep with the contract.
- Breaking changes must be deliberate, named, and versioned when the API is public.

## Schema And Type Parity

- Keep migrations, schema files, generated types, API contracts, and runtime code in sync.
- For Supabase/Postgres projects, maintain migration to schema to generated TypeScript type ordering.
- For Drizzle/PGlite projects, keep Drizzle schema as canonical and verify generated migrations against the live local database.
