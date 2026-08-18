# Eliminate ensureProjectId DO roundtrip and parallelize chat agent state lookups

**Status**: Complete
**Created**: 2026-08-18
**Program**: SAM UI Performance Plan (idea `01M09SKVNJGJNJY2WGCZ6D89XZ`) — Phase 3 / Workstream C
**Items**: Plan item #5 + item #6

## Problem

Two compounding sources of Durable Object latency on every project-scoped API request.

### Item #5 — every logical DO operation costs 2 roundtrips

`getStub()` (`apps/api/src/services/project-data.ts:43-48`) awaits
`stub.ensureProjectId(projectId)` as a real RPC before returning the stub. All 88 `getStub()` call
sites in the service therefore pay **2 DO roundtrips per logical operation**: one to ensure, one to
do the work. Endpoints that make several DO calls multiply this.

### Item #6 — `resolveChatAgentState` makes 4 strictly-sequential DO operations

`resolveChatAgentState` (`apps/api/src/routes/chat-agent-state.ts:14-111`) awaits, in series:

| # | Call | Line | Depends on |
|---|------|------|-----------|
| op1 | `listAcpSessions({ chatSessionId, limit: 1 })` | :25 | — |
| op2 | `getSessionState(agentSessionId)` | :42 | op1 |
| op3 | `getSessionState(input.sessionId)` | :58 | — (see proof below) |
| op4 | `getLatestPersistedPlan(input.sessionId)` | :72 | — |

With the item-#5 doubling that is **up to 8 sequential DO roundtrips**. It runs inside the polled
`/state` endpoint (`chat-state.ts:28`) and the session-detail endpoint (`chat.ts:345`).

## Research Findings

### R1 — the plan's suggested fix for #5 must not be implemented unverified

Idea `01M09SKVNJGJNJY2WGCZ6D89XZ` item #5 says `ensureProjectId` "is a legacy safety check that can
be replaced by a constructor-time assertion or removed entirely since the DO ID already encodes the
project binding."

The stated *rationale* is wrong: `DurableObjectId.toString()` returns a one-way hex digest and
`idFromName` has no inverse, so the DO ID as such does not encode a recoverable project binding.

**However — corrected after review — the conclusion is not settled.**
`@cloudflare/workers-types@5.20260707.1` declares `DurableObjectId.name?: string`, and an empirical
probe in the vitest workers pool showed workerd DOES populate it inside the DO, both on an
RPC-driven call and inside an `alarm()`-triggered instantiation:

```
viaRpc:   { name: "probe-91bb…", hasNameProp: true, idString: "34b82045…" }
viaAlarm: { name: "probe-91bb…", hasNameProp: true }
```

So `ensureProjectId` is **not** provably the only mechanism. It is retained here because:

1. `name` is typed optional and documented as present only for `idFromName`-derived ids;
2. this identity drives **D1 writes** (project summary write-back, workspace deletion), so an absent
   or unexpected value has real blast radius;
3. this workstream is explicitly barred from deploying to staging, so production behavior could not
   be confirmed — and workerd is not production.

Removing it therefore requires production verification, tracked in
`tasks/backlog/2026-08-18-project-data-id-name-identity-source.md`. Until then `do_meta.projectId`
stays authoritative and this PR only stops *repeating* the ensure, without weakening the guarantee.

### R2 — exact consumers of the persisted projectId

`getProjectId()` (`project-data/index.ts:75-80`) reads the cached value or `do_meta`. Consumers,
split by whether an inbound RPC could thread the value instead:

**Cannot be threaded — run with no inbound RPC in flight:**

| Consumer | Site | What breaks without projectId |
|---|---|---|
| `syncSummaryToD1()` | `index.ts:1511` | D1 write-back of `projects.last_activity_at` + `active_session_count`. Runs from a debounced `setTimeout`. |
| `idleCleanup.checkWorkspaceIdleTimeouts` | `index.ts:851` | D1 workspace deletion on idle timeout (alarm) |
| `idleCleanup.processExpiredCleanups` | `index.ts:860` | expired-cleanup processing (alarm) |
| `reconciliation.processReconciliationCandidates` | `index.ts:892` | task-mode reconciliation (alarm) |
| `sessionActivityReconciliation.probeStaleSessionActivity` | `index.ts:932` | stale-activity probe (alarm `waitUntil`) |
| `processTaskWaits` (`getProjectId` hook) | `index.ts:306` → `task-wait-supervisor.ts:146` | returns zero work — subtask waits never resolve |
| `durabilityHooks().getProjectId` | `index.ts:318` → `durability-foundation.ts:134,176,241` | durable-execution metrics + prompt-delivery claims |

**Could be threaded, but are on the RPC path anyway:**
`createAcpSession` (`:630`), `transitionAcpSession` (`:669`, feeds the trial bridge),
`prepareAcpSessionForFreshStart` (`:707`), `updateHeartbeat` (`:714`), `forkAcpSession` (`:799`),
`updateNodeHeartbeats` (`:812`).

**Conclusion**: the guarantee is real and must be preserved. Threading `projectId` through all 88
RPC signatures would not help the alarm/timer consumers at all.

### R3 — no consumer performs a wrong-project write on `null`

Verified. Six of the seven skip the work outright; the seventh relaxes a
secondary guard but has no path across a project boundary:

- `task-wait-supervisor.ts:146-147` — `if (!projectId) return result;` (skips)
- `index.ts:1511-1515` — logs `summary_sync_skipped_no_project_id` and returns (skips)
- `idle-cleanup.ts:289`, `:516` — `if (!projectId || …) continue` (skips)
- `session-activity-reconciliation.ts:402` — `if (!projectId || row.project_id !== projectId)` (skips; also a cross-project guard)
- `durability-foundation.ts:134,176,241` — nullable telemetry field (degrades)
- `index.ts:671` — trial bridge is inside `if (projectId)` (skips)
- `reconciliation.ts:267` → `resolveWorkspaceDeliveryTarget` (`reconciliation.ts:561`) —
  **does NOT skip.** Its guard is
  `if (projectId && wsRow.project_id && wsRow.project_id !== projectId)`, so a null
  projectId means the cross-project check is not applied and the function proceeds.
  Pre-existing behavior, unchanged by this PR, and contained: candidates are already
  selected from this DO's own rows, so there is no path to another project's data.

### R4 — `do_meta` is durable and is never deleted

`grep` across `apps/api/src/durable-objects/` finds **no** `deleteAll()`, no `DROP TABLE do_meta`,
and no `DELETE FROM do_meta`. `migrations.ts:111` only `CREATE TABLE do_meta`. The single writer is
`ensureProjectId`'s `INSERT OR IGNORE`. Therefore: **once any caller has ensured a given DO, the row
is present forever**, across DO eviction, hibernation, and isolate recycling.

This is what makes a per-isolate memo sound: the memo records "this DO has been ensured at least
once", and that fact is durable in DO SQLite, not isolate-local state.

### R5 — item #6 dependency proof: op3 runs iff `agentSessionId !== input.sessionId`

The guard at `chat-agent-state.ts:56` is `if (!state || agentSessionId !== input.sessionId)`, which
appears to depend on op2's result (`state`). It does not. Case analysis:

1. `agentSessionId !== input.sessionId` (includes `agentSessionId === null`) → the second disjunct is
   true → op3 runs **regardless of `state`**.
2. `agentSessionId === input.sessionId` and `state` truthy → guard false → op3 skipped,
   `chatSessionState` stays `null`.
3. `agentSessionId === input.sessionId` and `state` falsy → guard true → op3 runs, but it is the
   *identical* call to op2 (`getSessionState(input.sessionId)` === `getSessionState(agentSessionId)`)
   on a read-only method, so it returns the same `null`. `chatSessionState` ends `null` — the same
   value as case 2.

In cases 2 and 3 `chatSessionState` is `null`. So op3's *observable contribution* is non-null only
when `agentSessionId !== input.sessionId`, which is decided entirely by op1. **op3 does not depend on
op2.**

### R6 — the plan-merge rebuild drops optional snapshot fields

`chat-agent-state.ts:84-98` rebuilds `state` field-by-field and **omits** the optional
`activitySource` and `activityReason` members of `SessionStateSnapshot`
(`packages/shared/src/types/session.ts:349,354`). Consequence: eagerly populating `chatSessionState`
in a case where the original left it `null` could flip `planSource` from falsy to truthy and thereby
silently drop those two fields. The refactor must keep `chatSessionState` `null` in exactly the cases
the original did (i.e. gate on R5's condition, not on "did the call succeed").

### R7 — the existing unit test is order-dependent

`apps/api/tests/unit/chat-agent-state.test.ts:19-29` drives `getSessionState` with two
`mockResolvedValueOnce` calls, i.e. it asserts on **call order**, not arguments. Any reordering or
parallelization breaks it for the wrong reason. It must be converted to argument-keyed mocking
(which is also the more realistic form per `.claude/rules/35`).

### R8 — rule 45 (DO concurrency) analysis

All four operations are **read-only** (`listAcpSessions`, `getSessionState`, `getLatestPersistedPlan`
issue only `SELECT`s) and `resolveChatAgentState` issues **no writes at all** — it assembles a
response object in the Worker. There is therefore no check-then-act critical section to race:
nothing reads state, decides, and writes back. Parallelizing changes only which reads are in flight
together.

Snapshot skew: the function was already a non-atomic multi-read (4 sequential reads, each seeing a
possibly-different DO state). Grouping op2/op3/op4 into one concurrent batch makes the plan read and
the state reads *temporally closer* than the original (which read the plan strictly last), so
snapshot coherence improves rather than regresses.

## Design

### Item #5 — per-isolate "already ensured" memo

New module `apps/api/src/services/project-data-ensure-memo.ts`:

- Memo keyed by `DurableObjectId.toString()` (the hex id), **not** the raw projectId. The hex is
  derived from the namespace + name, so two different DO namespaces cannot collide inside one
  isolate.
- Bounded FIFO, cap from `PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES` with
  `DEFAULT_PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES = 2000` (constitution Principle XI).
- In-flight promise dedup so N concurrent first-calls for the same project issue **one** ensure RPC.
- `forget(key)` invoked when a DO call throws, so a DO reset / transient failure re-ensures on the
  next attempt (defence in depth against R4 ever ceasing to hold).

`getStub()` becomes: build the id, take the stub, and `await ensureProjectId` **only on memo miss**.

Result: **1 ensure RPC per (isolate, project) lifetime** instead of one per operation. The
persistence guarantee is unchanged — the very first operation for a project still ensures before any
work runs, exactly as today.

### Item #6 — two-hop fan-out

- Hop 1: `listAcpSessions` (op1) — genuinely required first, everything else keys off its result.
- Hop 2: `Promise.all` of op2 (only when `agentSessionId`), op3 (only when
  `agentSessionId !== input.sessionId`, per R5), op4 (always).

Each call keeps its own `.catch()` so one failure logs its original event and leaves the others
intact — matching the four independent `try/catch` blocks in the original. Never issues a call the
original would not have issued.

## Implementation Checklist

- [x] Create `apps/api/src/services/project-data-ensure-memo.ts` (bounded memo + in-flight dedup + `forget`)
- [x] Add `PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES` to the API `Env` interface and `.env.example`
- [x] Rewrite `getStub()` in `apps/api/src/services/project-data.ts` to consult the memo
- [x] Evict the memo entry on DO call failure inside `callProjectDataWithRetry`
- [x] Document on `ensureProjectId` (`project-data/index.ts`) why it cannot be removed (R1/R2)
- [x] Refactor `resolveChatAgentState` to the two-hop shape, preserving the R5 condition and R6 nullability
- [x] Convert `apps/api/tests/unit/chat-agent-state.test.ts` to argument-keyed mocks (R7)
- [x] Add roundtrip-count tests for `getStub` memo (discriminating: must fail pre-fix)
- [x] Add fail-closed test: DO with no persisted projectId skips D1 write-back
- [x] Add response-equivalence tests for `resolveChatAgentState` across all branches
- [x] Add roundtrip-count test for `resolveChatAgentState` (discriminating)
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

## Acceptance Criteria

- [x] A logical `projectDataService` operation costs **1** DO roundtrip on a warm isolate (was 2)
- [x] The first operation per (isolate, project) still ensures `do_meta.projectId` before doing work
- [x] All alarm/timer consumers listed in R2 continue to see a non-null projectId
- [x] Absent projectId still fails closed (no wrong-project D1 write)
- [x] `resolveChatAgentState` costs **2** sequential DO hops (was 4 logical / up to 8 roundtrips)
- [x] `resolveChatAgentState` returns byte-identical results to the pre-fix implementation for:
      no ACP session; ACP session with state; ACP session without state; `agentSessionId === sessionId`;
      persisted plan present; persisted plan absent with `chatSessionState.currentPlan`; each of the
      four calls failing independently
- [x] Optional `activitySource` / `activityReason` are preserved in exactly the cases they were before
- [x] Discriminating tests verified to fail against the pre-fix implementation

## References

- Idea `01M09SKVNJGJNJY2WGCZ6D89XZ` items #5, #6
- `.claude/rules/45-durable-object-concurrency-mutex.md` — DO await-interleaving
- `.claude/rules/60-request-io-and-bundle-budgets.md` — DO roundtrip budget
- `.claude/rules/59-understand-before-adding.md` — trace the lifecycle before changing a shared path
- `.claude/rules/39-debug-before-redesign.md` — do not delete a check without proving what it protects
- `.claude/rules/35-vertical-slice-testing.md` — realistic DO state in tests
- `.claude/rules/03-constitution.md` — Principle XI (no hardcoded limits)
