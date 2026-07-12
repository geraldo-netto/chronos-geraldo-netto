# Reliability And Observability

Use this module for systems that must survive partial failures, retries, concurrency, and long-running operations.

## Reliability Priorities

- Correctness
- Recoverability
- Idempotency
- Fault tolerance
- Consistency
- Predictability

## Idempotency

- Writes, jobs, queue handlers, and external API calls should be safe to retry when practical.
- Use idempotency keys, deduplication, state checks, and stable transitions.
- Avoid duplicate side effects.

## Retries

- Retry transient failures only.
- Use exponential backoff, jitter, and retry caps.
- Do not retry validation failures or known permanent failures.
- Make retry behavior visible in logs or metrics.

## Contracts And Invariants

- Define preconditions, postconditions, and failure conditions.
- Enforce invariants before and after mutation.
- Fail fast when a contract is violated.
- Examples: balance never negative, ownership preserved, state transition valid.

## Timeouts And Circuit Breakers

- Every external dependency needs a timeout: DB, HTTP, queues, filesystem, subprocesses, and model providers.
- Avoid unbounded waits.
- Consider circuit breakers for downstream systems to prevent cascading failure.
- Track open, half-open, and closed states explicitly when a circuit breaker exists.

## Graceful Degradation

- Prefer partial functionality over total failure where product requirements allow it.
- Use cached fallback, stale data, reduced features, or partial results when safe.
- Make degraded states visible to operators or users.

## Crash Recovery

- Persist enough state to resume, replay, or roll back.
- Use atomic writes or transactions for state changes.
- Clean up orphaned resources after failed or interrupted operations.
- Keep multi-step operations consistent if a process dies mid-flight.

## Observability

- Emit structured logs, metrics, and traces where the application has observability infrastructure.
- Track retries, failures, latency, throughput, success rates, queue depth, and state transitions.
- Avoid silent failures.
- Ensure logs are safe: no secrets or sensitive payloads.
- Use RED metrics for request/job paths: rate, errors, duration.
- Use USE metrics for resources: utilization, saturation, errors.
- Health surfaces should distinguish "scheduler fired" from "work completed successfully".
- Every detectable failure should point to an operator action or runbook when possible.

## Scheduling And Time

- Validate time zones at input boundaries.
- Be explicit about wall-clock time versus monotonic time.
- Account for DST, all-day events, recurrence catch-up, missed scheduler runs, and stale heartbeats where applicable.
- Long-running jobs need phase timeouts and progress-stall detection.

## Testing

- Unit-test invariants and edge cases.
- Failure-test retries, timeouts, downstream failures, and partial writes.
- Property-test invariant preservation where useful.
- Concurrency-test races and duplicate execution for idempotent paths.
