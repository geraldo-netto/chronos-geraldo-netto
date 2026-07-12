# Testing And Fuzzing

Use this module for projects where generated or modified code must be backed by tests.

## Baseline

- Every behavior change should have a test unless the project explicitly lacks a test harness or the change is documentation-only.
- Every new public function or method should have unit coverage and, when input space is broad or externally controlled, a fuzz/property harness.
- Tests must be deterministic, isolated, and meaningful.
- Cover normal cases, edge cases, and failure paths.
- Use mocks, stubs, fakes, or fixtures where they keep tests focused.
- Bug fixes should ship a regression test that reproduces the bug first whenever feasible.
- Refactors should be protected by behavior-lock tests over the public or composed seam.

## Coverage

- Target at least 80% coverage for new functions and files.
- For projects with stronger gates, follow the project gate.
- Complexity rules apply to tests too: keep each test helper and test body easy to read.

## Fuzz And Property Tests

- Fuzz public APIs that parse, validate, transform, serialize, deserialize, route, or accept external input.
- Explore boundary values, malformed inputs, randomized sequences, empty inputs, large inputs, and invalid encodings.
- Use language-appropriate tooling:
  - Python: Hypothesis or project-specific deterministic fuzz harnesses.
  - Rust: cargo-fuzz, libFuzzer, proptest, or arbitrary.
  - TypeScript: fast-check or project-specific fuzz utilities.
  - C/C++: libFuzzer, AFL, honggfuzz, or sanitizers.
- Ensure fuzz targets assert invariants and never accept panics, crashes, hangs, UB, or silent corrupt output.

## Verification

- Run the narrowest relevant tests first, then broader suites when risk or blast radius warrants it.
- If a command is unavailable or too expensive to run, report that clearly.
- For bug fixes, prefer a test that fails before the fix and passes after it.
- For refactors, prove behavior is unchanged with existing or added tests.

## Integration And E2E

- Unit tests check one function or module in isolation.
- Integration tests exercise real seams between layers, such as repository to database mock, service to repository, API route to handler, edge function to database, or page to flow to service.
- Any change spanning two or more layers should carry an integration test over the composed round trip, asserting actual call order and arguments when contract drift is the risk.
- E2E tests should cover core successful user journeys, not only abuse cases.
- Security-sensitive changes should include denied-path tests and, when applicable, browser/API E2E specs.
