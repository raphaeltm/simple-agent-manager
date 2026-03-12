# Post-Mortem: Message Misrouting & Tool Metadata Loss

**Date:** 2026-03-12
**Severity:** Critical
**Investigation:** `docs/notes/2026-03-11-message-misrouting-investigation.md`

## What Broke

Two critical failures and one medium-severity issue:

1. **Cross-workspace message contamination**: On multi-workspace nodes, messages from workspace A appeared in workspace B's chat session. All messages routed to whichever workspace was created last.
2. **100% tool metadata loss**: Every tool call in every persisted session had null metadata (no file paths, no diff content, no tool inputs/outputs). Completely silent — no errors logged.
3. **Session linking window**: Messages accepted with arbitrary sessionId during the gap between workspace creation and session linking.

## Root Causes

### Bug 1: Shared Reporter Singleton (Concurrent Multi-Workspace)

The VM agent's `messageReporter` was a single shared instance per node. When a workspace was created, `SetWorkspaceID()` and `SetSessionID()` overwrote the reporter's shared mutable state. With concurrent workspaces, the last workspace's IDs won.

- **Root code**: `server.go:58` — `messageReporter *messagereport.Reporter` (single field)
- **Overwrite points**: `workspaces.go:259` (SetWorkspaceID), `workspaces.go:550` (SetSessionID)
- **Impact**: All messages from all workspaces attributed to the last-created workspace

### Bug 2: Prototype Chain Check in safeParseJson

`workspaces.ts:118` used `'constructor' in parsed` to check for prototype pollution. The `in` operator checks the **prototype chain**, not just own properties. Since `Object.prototype.constructor` exists on every object, this check returned `true` for ALL parsed objects, causing `safeParseJson` to return `null` for every valid JSON input.

- **Root code**: `workspaces.ts:118` — `if ('__proto__' in parsed || 'constructor' in parsed || 'prototype' in parsed) return null;`
- **Verified**: `node -e "console.log('constructor' in JSON.parse('{\"a\":1}'))"` → `true`
- **Impact**: 100% of tool metadata silently dropped, permanently

### Bug 3: Unvalidated Session Linking Window

Workspace created in D1 with `chatSessionId = NULL` at `task-runner.ts:609`. Session linked later at `task-runner.ts:638`. Messages arriving in between were accepted with a warning instead of rejected, and D1 link failure was non-blocking.

## Timeline

- **Unknown date**: Bug 2 (safeParseJson) introduced when the function was written — has been silently dropping all metadata since inception
- **2026-03-04**: Cross-contamination postmortem fixed sequential warm node reuse but not concurrent multi-workspace case (Bug 1)
- **2026-03-11**: Investigation revealed all three bugs during multi-workspace node testing

## Why It Wasn't Caught

1. **No unit test for `safeParseJson`**: The function was never tested with actual JSON objects. A single test case like `safeParseJson('{"a":1}')` would have caught it immediately.
2. **The `in` operator pitfall is well-known** but not caught by TypeScript or linters. The check was written with good intent (prototype pollution defense) but wrong semantics.
3. **No multi-workspace concurrent tests**: Existing tests only covered single-workspace and sequential warm node reuse scenarios.
4. **Silent failure mode**: `safeParseJson` returns `null` on failure, same as "no metadata provided." No error was logged, no observability event recorded. The admin dashboard showed nothing wrong.
5. **Source-contract tests gave false confidence**: The workspace-messages test file only checked that code strings existed in the source, not that the logic was correct.

## Class of Bug

1. **JavaScript prototype chain semantics** — using `in` when `Object.hasOwn()` was needed. Any use of `in` for security-sensitive own-property checks is a latent bug.
2. **Shared mutable state in concurrent context** — a singleton with mutable fields used by concurrent actors. The fix (per-workspace instances) follows the principle of isolation.
3. **Silent data loss** — a function that swallows errors by returning a default value, with no logging or observability. The data path appeared to work (no errors) while losing information.

## Process Fix

1. **Rule addition**: When implementing security checks on parsed objects, always use `Object.hasOwn()` instead of the `in` operator to check for own properties. The `in` operator checks the prototype chain and will produce false positives for `constructor`, `toString`, `valueOf`, etc.

2. **Observability requirement**: Any function that silently drops or transforms data (returns null, filters items, truncates content) must log when it does so. Silent data loss is the worst class of bug because it's invisible until someone notices the missing data.

3. **Concurrent workspace testing**: Multi-workspace scenarios must have at least one test that creates two workspaces simultaneously and verifies message isolation.
