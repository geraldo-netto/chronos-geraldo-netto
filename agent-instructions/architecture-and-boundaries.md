# Architecture And Boundaries

Use this module for projects that need clear module, layer, and responsibility rules.

## General Architecture

- Separate I/O from business logic.
- Separate UI composition from data access.
- Keep pure transformations in helpers.
- Prefer composition over inheritance.
- Avoid god objects, god pages, god components, and mixed-responsibility modules.
- Keep dependencies flowing in one direction. Lower-level utilities must not import higher-level orchestration or presentation layers.
- Do not add architectural abstractions unless they remove real complexity or match an established project pattern.

## Single Responsibility

- Each file should own one coherent responsibility.
- Large files are a signal to inspect responsibility boundaries, not an automatic reason to split.
- Extract helpers for pure logic, services for orchestration, repositories/adapters for I/O, and components/views for presentation.
- If a file legitimately exceeds a local size cap while keeping one coherent responsibility, add a narrow allowlist entry with rationale instead of making an artificial split.

## Layering Pattern

When a project uses data-backed application layers, prefer:

- Repository/adapter: one external resource such as one table, bucket, API, queue, filesystem area, or RPC. Performs raw I/O and returns plain data or typed errors. No business policy.
- Service: composes repositories/adapters and applies business rules, branching, validation, and transformations. Does not directly import low-level clients when a repository exists.
- Flow/facade/use-case: thin entry point consumed by UI, CLI, jobs, or controllers. It should not accumulate business logic.
- Helper: pure formatting, mapping, validation, derivation, or calculations. No I/O and no framework state.

## Ports And Adapters

- Depend on app-owned contracts, not vendors.
- Third-party SDKs, APIs, model runtimes, storage providers, mail/calendar providers, and platform services should sit behind a port/interface.
- A vendor adapter should be the single import site for vendor classes.
- Wire adapters at the composition root.
- Domain services should see normalized domain requests and results, not raw provider payloads.

## REST/OpenAPI Tier Boundary

- For SPA/API systems, the REST/OpenAPI contract is the boundary between tiers.
- The frontend should know the backend only through the typed API client or generated contract types.
- The backend should not assume a specific client implementation.
- Contract changes should be deliberate, versioned when public, and covered by spec/routes parity checks.
- API errors should use a stable envelope and should never expose stack traces or sensitive internals.

## Plugin Extensibility

- A documented extension point must have a real registry, loader, or public registration API.
- Built-ins should use the same registry path as third-party implementations.
- Do not advertise "one-line provider/backend/ranker/extractor" support if dispatch remains closed behind private `if`/`elif` or `match` chains.

## State Machines

- Model lifecycle/status/phase transitions explicitly.
- Guard illegal transitions.
- Prevent terminal-state re-entry unless a reset path is explicit.
- Ensure cleanup and state reset on every error path, not only cancellation paths.
- Avoid mid-transition states being observed by callers unless the state is documented.

## Events And Outbox

- Side effects beyond the primary write should be listeners or jobs, not inline logic inside the primary service.
- Dispatch events after commit when listeners must not observe rolled-back state.
- External side effects such as email, calendar, webhooks, or provider sync should use a transactional outbox where reliability matters.
- Outbox dispatch should be idempotent, leased or claimed safely, retried with backoff, and observable.

## Dependency Management

- Declare optional dependencies intentionally, with extras/features where appropriate.
- Avoid load-bearing transitive dependencies; pin or declare them directly.
- Put upper bounds around API-volatile core dependencies.
- Avoid heavy imports on cold-start, CLI help, or UI render paths.
