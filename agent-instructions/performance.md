# Performance

Use this module when throughput, latency, memory efficiency, vectorization, or allocation behavior matters.

## Principle

- Never optimize blindly.
- Preserve correctness first.
- Measure or provide a benchmark strategy for non-trivial performance changes.
- Focus on hot paths and high-volume data paths.

## Vectorization

- Always check whether work is data-parallel.
- Prefer bulk transforms, batch processing, SIMD, columnar processing, GPU kernels, or contiguous arrays.
- Avoid scalar loops, branch-heavy hot loops, and virtual dispatch in hot paths when vectorization is practical.
- If vectorization is not possible, explain why.

## Zero-Copy

- Avoid unnecessary data movement.
- Prefer slices, views, spans, references, borrowed buffers, memoryviews, mmap, and streaming APIs.
- Avoid cloning, copying, reallocating, and intermediate buffers.
- Justify unavoidable copies.

## Memory Layout

- Prefer cache-friendly structures and contiguous memory.
- Use structure-of-arrays for batch/vector-heavy access patterns.
- Use array-of-structures when row/object locality dominates.
- Avoid pointer chasing and linked structures in hot paths.
- Optimize for sequential reads, cache lines, and predictable access.

## Allocation

- Preallocate when sizes are known.
- Reuse buffers.
- Prefer stack allocation, arenas, object pools, or project-native pooling when suitable.
- Avoid repeated transient allocations in loops.

## Branches And Algorithms

- Reduce unpredictable branches in hot loops.
- Prefer lookup tables, partitioning, or branchless arithmetic when it improves clarity and speed.
- Prefer O(n) or O(log n) algorithms over naive O(n^2) paths.
- Use bounded data structures and avoid unbounded growth.

## Streaming And Batching

- Prefer `process_batch(items)` over `process(item)` on high-volume paths.
- Stream large inputs instead of buffering whole payloads.
- Keep batch sizes configurable or adaptive when memory pressure matters.

## Checklist

- Vectorization evaluated.
- Zero-copy evaluated.
- Memory layout considered.
- Allocations minimized.
- Branches reviewed.
- Batching used where useful.
- Streaming considered for large data.
- Benchmark or profiling path identified.
