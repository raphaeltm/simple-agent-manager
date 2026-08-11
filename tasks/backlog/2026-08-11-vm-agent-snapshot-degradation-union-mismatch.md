# VM Agent Session-Snapshot Degradation Value Missing From API Union/Allowlist

## Problem

The vm-agent can submit a session-snapshot completion with
`degradation: "agent-context-skipped"`, but this value is absent from every
application-layer allowlist on the control-plane side, so the control plane
rejects the submission with `400 Invalid snapshot degradation` instead of
recording the (otherwise complete) snapshot. This is a pre-existing bug,
discovered incidentally while auditing runtime-boundary validation call sites
for `tasks/archive/2026-08-10-ai-slop-debt-burndown.md`; it is not caused by
and not fixed by that task.

## Context

`packages/vm-agent/internal/server/session_snapshot.go:282-288` sets:

```go
if agentContextSkipped && manifest.Degradation == "none" {
    // Both artifacts were captured but the snapshot has no resumable harness
    // identity. Status flips to degraded below; a "none" degradation label
    // alongside that would be misleading, so record a distinct reason. A more
    // severe artifact-based degradation, if set above, takes precedence.
    manifest.Degradation = "agent-context-skipped"
}
```

This fires when both the `home` and `wip` artifacts were captured
successfully (so neither of the other degradation branches — `wip-only`,
`transcript-only`, `home-skipped` — applied), but the resumable agent-session
identity (`agentType`/`acpSessionId`) was unavailable, so the snapshot can't
be resumed into a live agent session even though its file artifacts are
intact. `manifest.Degradation` is then sent to the control plane via
`s.completeSnapshot(...)`, which POSTs the manifest to
`/api/workspaces/:id/session-snapshot/complete`.

On the control-plane side, `apps/api/src/routes/workspaces/session-snapshots.ts`
rejects this value in **two** separate places, both of which need the new
value added together (a partial fix that only updates one would still 400):

1. The top-level `body.degradation` field, checked against a hardcoded `Set`:
   ```ts
   const DEGRADATIONS = new Set<SessionSnapshotDegradation>([
     'none',
     'home-skipped',
     'wip-only',
     'transcript-only',
   ]);
   // ...
   if (!DEGRADATIONS.has(degradation)) throw errors.badRequest('Invalid snapshot degradation');
   ```
2. The nested `body.manifest.degradation` field, checked by a Valibot picklist
   inside `SessionSnapshotManifestSchema`:
   ```ts
   degradation: v.picklist(['none', 'home-skipped', 'wip-only', 'transcript-only']),
   ```

Both draw from the same source-of-truth type,
`SessionSnapshotDegradation` in `apps/api/src/services/session-snapshots.ts:20`:

```ts
export type SessionSnapshotDegradation = 'none' | 'home-skipped' | 'wip-only' | 'transcript-only';
```

which is also missing `'agent-context-skipped'`.

No database migration is needed — the `degradation` column
(`apps/api/src/db/migrations/0091_session_snapshots.sql:12`,
`apps/api/src/db/schema.ts:1191`) is a plain `TEXT NOT NULL DEFAULT 'none'`
with no `CHECK` constraint, so the DB layer already accepts any string; only
the two application-layer allowlists above reject it.

### Impact

Whenever a workspace's snapshot completes with intact `home`+`wip` artifacts
but no resumable agent-session identity (e.g., the agent process exited
before `LoadSession` capability/session-ID could be captured), the vm-agent's
completion POST is rejected with 400. The snapshot is silently lost even
though its artifacts were successfully uploaded to R2 moments earlier in the
same request flow (`sessionSnapshotRoutes.put('/:id/session-snapshot/artifacts/:artifact')`
already succeeded before `/complete` 400s) — a resumable file-level restore
opportunity is thrown away because of an app-layer type mismatch, not a real
data problem.

## Acceptance Criteria

- [ ] `SessionSnapshotDegradation` (`apps/api/src/services/session-snapshots.ts:20`)
      includes `'agent-context-skipped'`.
- [ ] The route's `DEGRADATIONS` Set (`apps/api/src/routes/workspaces/session-snapshots.ts:30-35`)
      includes `'agent-context-skipped'`.
- [ ] `SessionSnapshotManifestSchema`'s `degradation` picklist
      (`apps/api/src/routes/workspaces/session-snapshots.ts:56`) includes
      `'agent-context-skipped'`.
- [ ] Regression test: POST `/session-snapshot/complete` with
      `degradation: 'agent-context-skipped'` (both at the top level and nested
      in `manifest.degradation`) returns 200, not 400, and the row persists
      with that degradation value.
- [ ] Check for any other consumer of `SessionSnapshotDegradation` (web UI
      display of snapshot status, restore-path messaging) that would need a
      display label for the new value.
- [ ] Search for any other vm-agent-emitted enum/string literal that has a
      similar hardcoded-allowlist-vs-source-enum drift, since this is the
      second instance of this class of bug in the snapshot subsystem area
      (see `.claude/rules/23-cross-boundary-contract-tests.md`).

## References

- `packages/vm-agent/internal/server/session_snapshot.go:282-288`
- `apps/api/src/routes/workspaces/session-snapshots.ts:19-35,199-269`
- `apps/api/src/services/session-snapshots.ts:20`
- `tasks/archive/2026-08-10-ai-slop-debt-burndown.md` (discovered during this task's boundary validation audit)
- `.claude/rules/23-cross-boundary-contract-tests.md` (inter-service contract verification)
