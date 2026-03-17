# Fix search_messages Cross-Token Matching

**Created**: 2026-03-17
**Context**: Discovered during investigation of token vs. message distinction in MCP tools

## Problem

The `search_messages` MCP tool searches individual token rows in `chat_messages` using SQL `LIKE`. If a search term spans two tokens (e.g., token 1 ends with `"the auth"`, token 2 starts with `"middleware is"`), the query `"auth middleware"` will **miss the match entirely** because `LIKE` operates per-row.

This makes `search_messages` unreliable for agents trying to find past discussions — search terms that happen to fall on token boundaries are invisible.

## Root Cause

- Each streaming chunk from Claude Code is stored as a separate row with its own UUID
- `searchMessages()` in `project-data.ts:599-655` runs `WHERE m.content LIKE ?` against individual rows
- No concatenation or grouping happens before search

## Proposed Fix

Concatenate consecutive same-role tokens into logical messages before searching. Options:

1. **SQL approach**: Use a CTE or window function to group consecutive same-role rows by `created_at`/`sequence` and concatenate content, then search the concatenated result
2. **Materialized view**: Store pre-concatenated messages alongside tokens for search purposes
3. **Application-level**: Fetch candidate tokens, group them, then search (less efficient but simpler)

## Acceptance Criteria

- [ ] Search terms that span token boundaries are found
- [ ] Snippets returned reflect the full concatenated message context, not just a single token
- [ ] Performance is acceptable (search should not require full table scan + in-memory concatenation for large sessions)
- [ ] Existing search behavior for terms within a single token is not regressed

## References

- `apps/api/src/durable-objects/project-data.ts:596-655` — current searchMessages implementation
- `apps/api/src/routes/mcp.ts:1710-1765` — MCP handler
- `apps/web/src/components/chat/ProjectMessageView.tsx:64-81` — frontend groupMessages (reference for grouping logic)
