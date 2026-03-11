# Message Misrouting & Tool Metadata Loss Investigation

**Date:** 2026-03-11
**Trigger:** Two workspaces on one node; messages appeared in wrong project chat session; tool calls missing rich information.

## Summary

Three independent bugs found, two critical:

| # | Bug | Severity | Effect |
|---|-----|----------|--------|
| 1 | Shared message reporter singleton across concurrent workspaces | **Critical** | Messages from workspace A routed to workspace B's session |
| 2 | `safeParseJson` always returns `null` due to prototype chain check | **Critical** | ALL tool metadata silently dropped for every message |
| 3 | Unvalidated session routing when `chatSessionId` is NULL | Medium | Messages accepted with arbitrary sessionId during linking window |

---

## Bug 1: Shared Reporter Singleton Causes Cross-Workspace Contamination

### What broke

With two workspaces on the same node, messages from workspace A appear in workspace B's chat session.

### Root cause

The VM agent has a **single shared `messageReporter`** per node (created at boot in `server.go:219-234`). When a workspace is created, the reporter's workspace ID and session ID are overwritten:

- `workspaces.go:259` — `s.messageReporter.SetWorkspaceID(body.WorkspaceID)` on workspace creation
- `workspaces.go:550` — `s.messageReporter.SetSessionID(chatSID)` on agent session creation

With two concurrent workspaces:
1. Workspace A is created → `SetWorkspaceID("ws-A")`
2. Workspace B is created → `SetWorkspaceID("ws-B")` **(overwrites)**
3. Workspace A's agent starts producing messages → enqueued with session from reporter
4. Reporter flushes → all messages POST to `/api/workspaces/ws-B/messages` ← **WRONG**
5. API routes messages to workspace B's project/session

The reporter was designed for **sequential** warm node reuse (one workspace at a time), not **concurrent** multi-workspace scenarios. The 2026-03-04 cross-contamination postmortem fixed the sequential reuse case (clear outbox on session switch), but the concurrent case was never addressed.

### Code path

```
Workspace A agent → ACP SessionHost → MessageReporter.Enqueue()
  → reporter.go:212-215: reads r.sessionID and r.workspaceID (shared, mutable)
  → Enqueues with workspace B's session ID (overwritten by concurrent workspace B)
  → flush() → sendBatch() → reporter.go:355: reads r.workspaceID (workspace B's ID)
  → POSTs to /api/workspaces/ws-B/messages
  → API stores in workspace B's project DO
```

### Impact

All messages from all workspaces on a multi-workspace node are attributed to whichever workspace was created last. Earlier workspaces' messages are permanently misrouted.

### Fix direction

The reporter must be **per-workspace**, not per-node. Each workspace needs its own reporter instance with its own session ID, workspace ID, and outbox (or outbox partition). The `acpGatewayConfig.MessageReporter` should be set per-SessionHost, not globally.

---

## Bug 2: `safeParseJson` Always Returns `null` — All Tool Metadata Lost

### What broke

Tool calls in persisted chat sessions show no rich information (no file paths, no diff content, no tool inputs/outputs). The `toolMetadata` column in the DO SQLite is always `null`.

### Root cause

`apps/api/src/routes/workspaces.ts:114-123`:

```typescript
function safeParseJson(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    if ('__proto__' in parsed || 'constructor' in parsed || 'prototype' in parsed) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
```

The `in` operator in JavaScript checks the **prototype chain**, not just own properties:
- `'__proto__' in JSON.parse('{}')` → `true` (accessor on `Object.prototype`)
- `'constructor' in JSON.parse('{}')` → `true` (`Object.prototype.constructor`)

This means `safeParseJson` returns `null` for **every valid JSON object**, including all tool metadata.

Verified:
```
$ node -e "console.log('constructor' in JSON.parse('{\"a\":1}'))"
true
```

### Code path

```
VM agent sends toolMetadata as JSON string (message_extract.go:124,133)
  → API POST /api/workspaces/:id/messages (workspaces.ts:1613)
  → workspaces.ts:1736: safeParseJson(m.toolMetadata)
  → safeParseJson returns null (always, due to prototype chain)
  → null stored in DO SQLite
  → Tool metadata lost permanently, silently
```

### Impact

**100% of tool metadata is silently dropped.** Every tool call in every persisted session has null metadata. No error is logged, no observability event is recorded. The function silently swallows all data.

### Fix

Replace `in` with `Object.hasOwn()` (or `hasOwnProperty`):

```typescript
function safeParseJson(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    if (Object.hasOwn(parsed, '__proto__') || Object.hasOwn(parsed, 'constructor') || Object.hasOwn(parsed, 'prototype')) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
```

Additionally, add a warning log when `safeParseJson` returns null for a non-empty input, and integrate with the observability system via `persistError()`.

---

## Bug 3: Unvalidated Session Routing During Linking Window

### What broke

When a workspace is created, there is a window where `chatSessionId` is NULL in D1. During this window, messages are routed to whatever `sessionId` the VM agent provides, with only a warning logged.

### Root cause

`task-runner.ts:609-638`:
1. Line 609-625: Workspace inserted into D1 **without** `chatSessionId`
2. Line 638: `ensureSessionLinked()` called **after** workspace creation
3. If messages arrive between these operations, `workspaces.ts:1718-1724` logs a warning and routes to the provided `sessionId`

Additionally, `ensureSessionLinked()` (line 906-962) treats D1 link failure as non-blocking (line 927-933). If the D1 update fails, `chatSessionId` stays NULL permanently, leaving a permanent misrouting vulnerability.

### Code path

```
task-runner.ts:609 → INSERT workspace (chatSessionId = NULL)
  ... time passes ...
task-runner.ts:638 → ensureSessionLinked() updates chatSessionId

During the window:
  VM agent flushes messages → POST /api/workspaces/:id/messages
  → workspaces.ts:1701: workspace.chatSessionId is NULL, skip validation
  → workspaces.ts:1718-1724: only a console.warn
  → Messages routed to whatever sessionId VM provided (could be stale/wrong)
```

### Fix direction

1. Insert workspace WITH `chatSessionId` in a single operation (move session creation before workspace creation, or include it in the INSERT)
2. Alternatively, **reject** messages when `workspace.chatSessionId` is NULL instead of accepting with a warning
3. Make D1 link failure in `ensureSessionLinked()` a blocking error
4. Persist routing warnings to observability database via `persistError()`

---

## Missing Observability

All three bugs share a common failure: errors are only logged to `console.error/warn`, not persisted to the observability database (spec 023). The admin dashboard cannot show:

- How often tool metadata parsing fails
- How often messages are routed without session validation
- Which workspaces are affected

### Fix

All message routing error paths in `workspaces.ts` should call `persistError()` from `apps/api/src/services/observability.ts` to ensure admin visibility.

---

## Relationship to Previous Postmortems

| Postmortem | What it fixed | What remains |
|------------|--------------|--------------|
| 2026-03-04 cross-contamination | Sequential warm node reuse (clear outbox on session switch) | **Concurrent multi-workspace** on same node (Bug 1) |
| 2026-03-01 TDF message relay | Message relay initialization | Silent data loss in `safeParseJson` (Bug 2) |
| 2026-02-28 missing initial prompt | End-to-end verification gaps | API-side validation gaps (Bug 3) |

---

## Prioritized Fix Order

1. **Bug 2 (safeParseJson)** — One-line fix, restores all tool metadata immediately
2. **Bug 1 (shared reporter)** — Requires architectural change (per-workspace reporter), but is the root cause of cross-session messages
3. **Bug 3 (session linking window)** — Defense-in-depth, reduces blast radius of Bug 1

## Appendix: MessageReportEntry.SessionID Not Populated

A related code smell: in `session_host.go:564` and `session_host.go:1924`, the `MessageReportEntry` struct's `SessionID` field is never populated when enqueuing from the ACP gateway. This is currently harmless because the reporter ignores per-message session IDs and uses its own internal `sessionID`. However, if the reporter design changes to per-message routing, empty session IDs would cause enqueue rejections (reporter.go:222-228). The fix to Bug 1 (per-workspace reporters) should also populate `SessionID` in `MessageReportEntry` for correctness.
