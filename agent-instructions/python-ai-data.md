# Python, AI, Data, And RAG

Use this module for Python packages, CLIs, data pipelines, semantic indexing, ML, retrieval, and RAG systems.

## Python Structure

- Keep modules small and single-purpose.
- Avoid mixing CLI parsing, business logic, and I/O in the same function.
- Use helpers for pure logic.
- Prefer explicit readable code over clever abstractions.
- Keep cognitive complexity below project limits.
- Use typed config accessors instead of raw nested dictionary access when the project provides them.
- Run the project Python gates before finishing, commonly ruff, pyright/mypy, tests, coverage, and fuzz/property suites.

## CLI And Config

- CLI declarations, aliases, help text, defaults, exit codes, and behavior must stay aligned.
- Legacy command aliases must expose the same flags and behavior as the unified command group.
- Every new config knob needs:
  - default
  - documentation or docstring
  - example or commented entry in config files when appropriate
  - typed accessor
- validation error
- test fixture
- A CLI should print usage/errors to the correct stream, validate arguments at parse time when possible, and provide `--help`.

## Ingestion And Format Coverage

- Every file extension under configured data directories should map to a real extractor or explicit skip.
- Binary formats must not fall through to UTF-8 text fallback.
- OCR routing should distinguish parse failure, empty text, and needs-OCR cases.
- Cross-check corpus extension histograms, indexer logs, extractor registry, and routing rules.

## Retrieval And RAG Quality

- RAG changes must preserve citation enforcement: cited markers point at live retrieved rows.
- No-answer behavior should be programmatic and share the same refusal phrase between prompt and detector.
- Prompt-template tests should assert:
  - all slots are filled
  - required no-answer phrase is present verbatim
  - query fence/sentinel placement is intact
  - citation IDs match displayed order
  - locale directive matches resolved locale
- Retrieval, rerank, fusion, dedup, FLARE, HyDE, or query-decomposition changes should report metric deltas where an eval harness exists:
  - context recall
  - context precision
  - NDCG@k
  - MRR@k
  - diversity
- Tuned runtime parameters must not drift from measured defaults without a recorded reason.

## Machine Learning

- Couple model version, embedding dimension, distance metric, and persisted index metadata.
- Detect same-model-id/different-dimension swaps.
- Normalize scores consistently and convert distances to similarities where needed.
- Re-normalize matryoshka embeddings after truncation.
- Keep ranking deterministic with seeds and stable tie-breaking.
- Ensure metric calculations deduplicate consistently between open and closed gold sets.

## Vectorization

- Numerical hot paths should use batched array operations, not Python loops.
- Prefer NumPy, BLAS, Polars, vector databases, or framework tensor ops.
- Use one batched `embed()` call over merged batches rather than per-file or per-row calls.
- Use `float32` on embedding, storage, and query paths unless there is a measured reason not to.
- Keep arrays contiguous and avoid repeated list-to-ndarray round trips.
- Use matrix multiplication for pairwise similarity instead of nested per-vector loops.

## Memory And CPU

- Avoid whole-corpus and whole-file materialization on long-running paths.
- Stream large inputs.
- Bound caches and collections.
- Ensure BLAS, OMP, tokenizer, and Torch thread caps are set before native libraries load.
- Size batches under memory pressure.
- Avoid retaining large intermediate objects after use.

## Distributed And Long-Running Work

- Make file locks safe across processes and hosts.
- Account for PID reuse and cross-host mtime/clock assumptions.
- Fsync parent directories where lock durability matters.
- Make reruns idempotent.
- Handle shared-filesystem SQLite contention.
- Roll back partial writes across multiple collections.
- Add watchdogs for long-running indexers and worker pools: phase timeouts, progress-stall detection, hung-future reaping, and idle deadlines.

## Native Helpers Paired With Python

- Native parsers, chunkers, or indexers should maintain differential tests against the Python pipeline.
- Subprocess bridges should supervise workers with deadline, graceful termination, and forced termination.
- Use bounded channels for backpressure.
- Check every worker result and propagate failures.
