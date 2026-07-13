# Binding Parity

Use this module for projects with a core library and generated or handwritten bindings in multiple languages.

## Core Is Source Of Truth

- Bindings must not drift from the core API.
- Core public functions, constants, signatures, arities, return shapes, and generated docs must stay synchronized.
- Hand-written language guides should link to generated API docs for constants and signatures instead of restating values.

## Required Gates

When changing a core public function, binding signature, binding constant, or documentation that restates API facts, run the project parity gates. For Rust `xtask` projects, common gates are:

```sh
cargo xtask parity
cargo xtask coverage
cargo xtask shapes --check
cargo xtask apidoc --check
cargo xtask pyi --check
cargo xtask dts --check
```

Adapt command names to the repository.

## Coverage Rules

- Every flat public core function should be bound in each supported language or listed in an allowlist with a reason.
- Cross-binding arities must agree or be recorded in an arity allowlist.
- Binding return shapes such as scalar, tuple, array, and object must not change accidentally.
- Real shape changes must update the binding shape snapshot in the same change.
- Stubs and generated docs must be regenerated or checked in the same change.
- Source-level parity is not enough for high-risk bindings; add native runtime parity tests or golden fixtures that call the built bindings and compare behavior to core.
- Intentional idiomatic differences, such as object-packed arguments in one language, must be recorded in an allowlist with rationale.

## Documentation

- Generated API docs should list constant values and per-language signatures.
- Hand-written docs may explain usage, tradeoffs, and examples, but should not duplicate values likely to drift.
- CI should block merges on parity failures.
