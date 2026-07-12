# TypeScript, React, And Supabase

Use this module for TypeScript/React projects, especially Supabase-backed apps.

## TypeScript Rules

- Never use `any`.
- Use `unknown` in `catch` and narrow before reading fields.
- For untyped Supabase tables, prefer `from("table_name" as never)` and then cast data through `unknown` to a real domain type.
- For dynamic update keys required by Supabase typing, use the narrowest safe cast, commonly `as never`, not `as any`.
- Do not use empty interfaces such as `interface Props extends Base {}`; use `type Props = Base`.
- Do not use `require()` in `.ts` or `.tsx`; use imports or dynamic `import()`.
- Prefer `const` over `let` when the binding is not reassigned.
- Keep cognitive complexity below project limits.

## React Rules

- Pages compose screens; they should stay thin.
- Components present reusable visual blocks and may own local UI state only.
- Hooks own state, effects, async loading, and handlers; hooks return data and callbacks, not JSX.
- Helpers contain pure logic and must not use React hooks or perform I/O.
- Contexts are for state shared across screens, not a dumping ground for unrelated state.
- Components must not import from `src/pages/**`.
- Pages and components must not import the Supabase client directly when a flow/service/repository layer exists.
- If a `useEffect` intentionally runs only on mount while using a function defined in the component, place `// eslint-disable-next-line react-hooks/exhaustive-deps` directly above the dependency array and only when that mount-only behavior is intentional.

## Supabase Layering

- Repository: `src/lib/repositories/*-repository.ts`
  - Accesses one table, bucket, RPC, or resource.
  - Performs raw I/O.
  - Can import `@/integrations/supabase/client`.
  - Contains no business orchestration.
- Service: `src/lib/services/*-service.ts`
  - Orchestrates repositories and applies business rules.
  - Must not import the Supabase client directly.
- Flow/facade: `src/lib/*-flows.ts`
  - Thin entry point for pages/hooks.
  - Re-exports or delegates to repositories/services.

## Testing

- Repositories test with the project Supabase mock or integration harness.
- Services test by mocking repositories and should run without a database.
- If a "service" can only be tested with the Supabase mock, it is probably a repository.

## Checklist

- `npm run lint` passes with zero errors.
- No `: any`, `as any`, or `catch (error: any)`.
- No `require()` in TypeScript.
- No empty interfaces.
- New functions have appropriate unit and fuzz/property tests.
- Pages do not import Supabase directly.
- Services do not import Supabase directly.
- UI logic is in the right layer: page, component, hook, helper, or context.

## Vanilla JavaScript Frontends

- Build DOM through `document.createElement`, properties, and `textContent`; avoid inline HTML injection.
- Keep modules focused: API client owns fetch and URL construction, rendering modules own rendering, state modules own state.
- If using JSDoc types, keep `tsc --noEmit` or the project check command green.
- Sanitize or escape every stored value before it reaches the DOM.
