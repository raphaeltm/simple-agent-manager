# Fix search_messages LIKE pattern too complex errors

## Problem

While researching the daily journal on 2026-05-06, the SAM MCP `search_messages` tool failed for ordinary multi-word queries with:

```text
LIKE or GLOB pattern too complex: SQLITE_ERROR
```

Observed failing queries included:

- `compact mode lazy-load tool content payload reduction`
- `WORKSPACE_STOPPED_TTL_MS stopped workspaces auto delete`

Shorter or different queries sometimes succeeded, so this appears to be a query-building or fallback-search robustness issue rather than a total search outage.

## Context

The failure happened while reviewing conversations from the past 24 hours for a blog post. Conversation search is part of SAM's agent workflow, so query failures make agents less able to recover project context.

Likely code path to inspect: `searchMessages()` and `searchMessagesLike()` in `apps/api/src/durable-objects/project-data/messages.ts`.

## Acceptance Criteria

- [ ] Multi-word message searches do not throw SQLite `LIKE or GLOB pattern too complex` errors.
- [ ] FTS fallback behavior is covered by a behavioral test using a query similar to the failing examples.
- [ ] If a query must be simplified, the tool returns partial results or an empty result with diagnostics instead of a tool-level failure.
