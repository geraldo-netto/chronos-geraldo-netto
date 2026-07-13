# Rust And Systems

Use this module for Rust systems, kernel-adjacent work, C interop, embedded/no_std, and wire-format code.

## Safety

- Prefer safe Rust APIs.
- Every `unsafe` block must have a clear invariant and a small scope.
- Audit raw pointers, lifetimes, aliasing, DMA buffers, and ownership transfer.
- Use Miri, sanitizers, or equivalent tools when applicable.
- Do not rely on undefined behavior or layout assumptions without tests or explicit representation.

## ABI, FFI, And Wire Formats

- Preserve struct layout, ioctl/netlink formats, C ABI expectations, and uapi compatibility.
- Add tests for serialization, parsing, and boundary layout assumptions.
- Keep Rust and C-driver parity documented when replacing or mirroring a C implementation.
- Fuzz parsers, wire formats, ioctl inputs, and externally controlled binary inputs.

## Kernel And no_std

- Maintain `no_std` and host-stub parity where the project supports both.
- Host stubs must mirror real `kernel::` semantics closely; tests should not rely on fake behavior that cannot happen in kernel mode.
- Track supported kernel and architecture targets, such as Linux kernel 6.1+, x86_64, and aarch64, when relevant.
- Keep Cargo features and dual build modes discoverable and tested.

## Concurrency

- Validate SMP safety, lock granularity, interrupt/process context interactions, and cancellation paths.
- Avoid data races and deadlocks.
- Ensure terminal states cannot be re-entered accidentally.
- Check futures, worker threads, and async tasks for dropped errors.

## Reliability

- Guard device or resource lifecycle transitions such as probe, open, run, release, teardown, and error recovery.
- Ensure cleanup on every error path.
- Avoid orphaned resources after partial initialization.
- Add integration tests for edge and error paths, not only happy paths.

## Performance

- Prefer zero-copy slices, references, and borrowed buffers where ownership allows.
- Avoid avoidable clones and allocations in hot paths.
- Use iterators, batch processing, rayon, or SIMD where they improve measured throughput without harming clarity.

## Verification

- Run `cargo test` or narrower relevant test suites.
- Run formatting and lint gates used by the project.
- Run fuzz targets when touching parsers, ABI boundaries, or external input handling.

## Binding And Cross-Language Parity

- When Rust is the core for language bindings, keep native behavior, signatures, arities, constants, stubs, docs, and return shapes in sync.
- Use golden fixtures or native binding tests for runtime parity, not only source-level checks.
- Record intentional idiomatic binding differences in an allowlist with rationale.
