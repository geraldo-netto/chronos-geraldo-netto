# Agent Workflow And Context Management

Use this module for larger agentic coding sessions, especially when subagents or long context windows are available.

## Subagents

- Delegate read-heavy exploration, broad searches, and "where is X / what calls Y" work to subagents when available.
- Return conclusions, anchors, and risks from subagents; avoid dumping raw file contents back into the main thread.
- Launch independent subagents concurrently when subtasks do not depend on each other.
- Scope each subagent narrowly with one objective, the files or areas to inspect, and the exact return shape.
- Match model strength to task risk: faster/cheaper models for mechanical lookup or narrow edits, stronger models for multi-file reasoning and correctness-critical work.
- Reuse an existing subagent context for follow-ups when it already has the needed working set.

## Context Hygiene

- Keep the working set lean. Prefer targeted reads over whole-file dumps.
- Drop stale mechanical details once captured in a checkpoint, plan file, or TODO row.
- Persist durable facts, decisions, anchors, and gotchas in a maintained project artifact when they must survive chat compaction.
- For long tasks, checkpoint progress periodically with what is done, what remains, key decisions, and file/line anchors.

## User Updates

- Before substantial work, briefly state the intended approach.
- Provide short progress updates at phase changes or when findings change the plan.
- Keep updates outcome-based: what was learned, what changed, and what is next.
- Do not treat progress updates as final answers.
