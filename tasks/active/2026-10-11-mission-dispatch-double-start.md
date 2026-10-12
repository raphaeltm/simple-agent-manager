# Mission tasks are started twice: dispatch_task and the ProjectOrchestrator both claim the task

SAM task `01M4MZT5TBPA4ABBHH0MEH88H7` (Wave C of `reliability-wave-1011`, coordinator `01M4MXGVH4EMVNE1CT2XRH484J`).
Source idea: `01M4KKNAZY6KSSCXR610T01E11`.

## Problem

A task dispatched with a `missionId` can be started by two owners.

1. `dispatch_task` inserts the task as `queued` with `chat_session_id = NULL`, creates chat session S1,
   and starts the TaskRunner with `chatSessionId = S1`. Nothing writes S1 to `tasks.chat_session_id`
   until the runner's `ensureSessionLinked`, which runs after the workspace claim, seconds later.
2. The ProjectOrchestrator's cycle (`scheduling.ts` `processMission`) recomputes scheduler states itself
   and then auto-dispatches mission tasks that are `schedulable`, `queued` and `chat_session_id IS NULL`.
   During that window it creates S2, persists the description into it, binds `tasks.chat_session_id = S2`
   and calls `startTaskRunnerDO` again (a no-op: one TaskRunner per task already exists).
3. The runner's `claimWorkspaceAllocationForTask` requires `tasks.chat_session_id = S1`, changes 0 rows,
   tombstones the workspace and fails the task with
   `Reserved task submission authority revoked before workspace assignment: task is queued`, which names
   neither the cause nor anything reserved.

Production, 2026-10-10 15:37Z: tasks `01M4K7CQPHMM31GS0R263JNNFN` and `01M4K7CYV774BHVRHC847Y5WES`,
mission `a3e6b0b1-0183-434b-9af9-69545ac37f48`, parent started from ChatGPT through the SAM Connector.
Each has two `session_summaries` rows; the task row ended on S2.

Production baseline (2026-10-11, read-only): **11 of 123 mission tasks ever created have more than one
`session_summaries` row** — 2026-05-11 (1 task, 6 sessions), 2026-08-08 (3), 2026-08-09 (3), 2026-08-12 (1),
2026-09-25 (1), 2026-10-10 (2). 9 of the 11 failed. The August failures are Instant tasks
(`standalone git clone failed …`) plus one `session already exists`. Two sessions on one mission task is
this race's signature, so the race very likely hit both runtimes long before the 14-day window the idea
looked at; that is an inference from the signature — the older incidents were not traced one by one.

## Research findings

- **Every mission-task creator starts its own task immediately.** The only writers of `tasks.mission_id`:
  MCP `dispatch_task` (`routes/mcp/dispatch-tool.ts`, VM and Instant branches), /sam `dispatch_task`
  (`durable-objects/sam-session/tools/dispatch-task.ts`) and /sam `retry_subtask`
  (`durable-objects/sam-session/tools/retry-subtask.ts`). REST task creation, MCP `retry_subtask`, trials,
  workspace-create and chat submit never set `mission_id`. No API creates a mission task that waits for the
  orchestrator, and `add_dependency` only links tasks that already exist (and are already started).
- **The orchestrator's gate keys on a proxy.** `chat_session_id IS NULL` stands in for "no starter owns this
  task". It diverges whenever a creator has claimed the task but not yet written the claim
  (rule 74). #1876 already patched one divergence (VM admission waiters) by excluding `vm_task_admissions`.
- **The orchestrator recomputes scheduler states in its own cycle** (`processMission` step 2), so binding the
  session "before dispatch_task's recompute" is not enough: any window between the task INSERT and the bind
  is visible. The only airtight claim is one committed in the INSERT itself.
- **Precedent for an INSERT-time claim.** Reserved submissions (triggers, schedules) insert the task with its
  pre-allocated `chat_session_id` and create the ProjectData session with that identity afterwards
  (`reserved-task-submission-storage.ts`, `createReservedTaskSession`). Chat submit binds right after
  `createSession` (`services/submit-task.ts:647`). `dispatch_task` is the outlier.
- **Instant branch is worse.** `launchDispatchedInstantSession` creates the session inside the background
  launch (`services/instant-session.ts`), so the task is unclaimed for the whole node/workspace/session setup.
  An orchestrator cycle there would start a VM TaskRunner for an Instant task.
- **The orchestrator's start is a degraded config**: `profile: null`, checkout of the project default
  branch, no task mode. It must never win against the creator.
- **TaskRunner tolerates an early claim.** `claimWorkspaceAllocationForTask` (`chat_session_id = ?`),
  `reserveWorkspacePlacement` (`requireChatSessionMatch = 0` for ordinary starts) and `ensureSessionLinked`
  (`chat_session_id IS NULL OR = ?`) all accept a task already bound to the runner's session.
- **Claim-failure message.** `workspace-reserved-allocation.ts:221-231` prefixes every failure with
  "Reserved task submission authority revoked" and reports only `task is <status>`, even for ordinary starts
  and even when the real mismatch is the chat session. Consumers: the TaskRunner step handler (permanent →
  `failTask`); no code parses the text (only `tests/unit/routes/task-workspace-metering.test.ts`).
- Not changed: MCP `retry_subtask` drops `mission_id` (separate behaviour; not a double-start).

## Decision

The creator is the only authoritative starter. Every mission-task creator commits its chat-session identity
in the same INSERT that creates the task (a pre-allocated UUID), then creates the ProjectData session with
that identity. The orchestrator never sees an unclaimed creator task, so its existing `chat_session_id IS NULL`
gate becomes exact; its code is unchanged.

Rejected: removing orchestrator auto-dispatch (no legitimate trigger exists today, but it touches MCP tools,
REST routes, config knobs and mission budgets — larger blast radius than the bug); binding after
`createSession` only (leaves an INSERT-to-bind window the orchestrator's own recompute can see);
time- or runner-existence-based orchestrator heuristics (proxies with residual windows).

## Implementation checklist

- [x] `createSession` (service, ProjectData DO RPC, `sessions.createSession`) accepts an optional pre-allocated session id
- [x] MCP `dispatch_task`: allocate the session id before the INSERT, insert `chat_session_id`, create the VM session with it
- [x] MCP `dispatch_task` Instant branch: pass the allocated id to `launchDispatchedInstantSession` → `launchInstantSession`
- [x] `launchInstantSession`: optional `chatSessionId` input used for the session
- [x] /sam `dispatch_task` and /sam `retry_subtask`: same INSERT-time claim
- [x] `claimWorkspaceAllocationForTask`: name the first failed predicate (task missing / not queued / assigned elsewhere / chat-session mismatch / session revoked / workspace not allocatable / reserved checkpoint); ordinary starts no longer say "reserved submission authority"
- [x] Workers vertical slice: real `handleDispatchTask` with `missionId`, runner paused, one real orchestrator cycle, then the real runner to workspace assignment; assert one session per task and assignment
- [x] Workers test for the Instant branch: orchestrator cycle while the launch is parked does not start the task
- [x] Claim-failure reason tests against real SQLite for every reason, ordinary and reserved
- [x] /sam creator tests: the inserted `chat_session_id` equals the created session id
- [x] Prove discrimination: revert the INSERT-time claim (keep exports) → vertical slice red; record in PR
- [x] Docs: search for dispatch/session-link descriptions and update
- [x] SHARED_FILE notices on `reliability-wave-1011` for files Wave B also edits

## Implementation notes

- Session ids are pre-allocated with `crypto.randomUUID()` (the DO's own format), not the trigger flow's
  `chat_<taskId>`, so dispatched session URLs keep their shape.
- Discrimination (surgical revert of the INSERT column to `null`, everything else kept):
  - VM vertical slice: the orchestrator auto-dispatched both tasks (decisions "Auto-dispatched
    schedulable task (slot 1/5)" and "(slot 2/5)"); each task had 2 sessions and its row ended on the
    orchestrator's session — the exact production signature.
  - Instant: the orchestrator started a VM TaskRunner for the Instant task.
  - /sam: the /sam-dispatched mission task got a second session.
- Docs: no public or agent doc describes the session-link timing, the auto-dispatch, or the old error
  text (searched `apps/www/src/content/docs/docs`, `.claude/skills/api-reference`). No public/reference doc change required. MCP descriptions/response wording and the scoped ownership rule were updated.
- `dispatch-tool.ts` is at 796 lines (hard limit 800); not split here to avoid colliding with Wave B's
  concurrent edits in the same files.

## Acceptance criteria

- [x] A mission task dispatched through MCP has exactly one chat session, even when an orchestrator cycle runs before the runner links it
- [x] That task reaches workspace assignment (`delegated`, `workspace_id` set, workspace bound to the dispatch session)
- [x] The same holds for the Instant branch and the /sam creators (no orchestrator start of a creator-owned task)
- [x] The vertical slice fails on pre-fix code
- [x] Claim-failure messages name the real mismatch; ordinary starts never say "reserved submission authority"
- [ ] Staging: a real mission with ≥2 dispatched tasks, one session per task, resources cleaned up
- [ ] Production: idea query returns 0 duplicate sessions for missions created after the deploy

## References

- `apps/api/src/routes/mcp/dispatch-tool.ts`, `apps/api/src/durable-objects/project-orchestrator/scheduling.ts`
- `apps/api/src/durable-objects/task-runner/workspace-reserved-allocation.ts`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `.claude/rules/74-proxy-signals-must-match-the-condition.md`
- `apps/api/.claude/rules/72-error-categories-must-match-the-recovery-action.md`, `.claude/rules/61-guards-must-cover-every-runtime.md`

## Recovery validation (Sol, 2026-10-11)

Recovery task `01M4NAW17AVHSJCF4FNZGVRX1C` reuses this branch and PR #2302. The original coordinator handoff was verified by recovery coordinator `01M4NA4ERCGYH3VK5ARVN317N6`; its writer release permits source validation, while staging, migrations, merge and production remain sequenced separately.

The original saved HEAD (`ee5999104`) contains the three happy-path Workers cases but not the failure-window tests mentioned in the quota-interrupted transcript. Current SAM MCP exposes no snapshot-content recovery operation, so retained WIP metadata cannot establish completeness. Missing validation is reconstructed without replacing the substantive implementation.

Failure-window coverage drives task INSERT rejection through a real D1 trigger, holds ProjectData creation after the INSERT across a real orchestrator cycle, rejects session creation or initial-message persistence, and exercises real terminal-session reconciliation and queued-timeout recovery. A rejected task INSERT leaves neither a task nor a session; a reserved session ID cannot make the orchestrator a second starter. An actual process crash before startup is bounded by existing queued-timeout failure, rather than introducing a second start path.

The existing terminal-session-ledger reconciliation includes active sessions with no workspace/ACP assignment and fails them after the owning task becomes terminal. No dispatcher retries the session-creation RPC today, so new replay infrastructure is unnecessary. A failed task can retain a reserved ID whose session was never created; the coordinator clarified that retaining this diagnostic reservation is acceptable if terminal readers and fresh retry remain safe. Clearing it on transport ambiguity could discard a committed or late-arriving session identity; no cosmetic cleanup or unused replay mechanism is added.

- [x] Preserve original workflow state locally; remove accidental tracked `.do-state.md` in additive commit `84f369dce` (history and local contents retained)
- [x] Correct PR title/body and restore preflight/review evidence with pending gates stated
- [x] Affected unit tests: 273 passed; runtime-state and instruction-context-budget checks passed
- [x] Expanded Workers failure-window tests: 10 passed, zero unhandled errors (47.91 s final clean rerun after discrimination, restored workspace; real SQL failure captured through existing test-only DO adapter)
- [x] Recovery API typecheck passed; changed-file lint passed (full API lint at prior candidate had only new import-order error, corrected; current CI lint also passed)
- [x] Coordinator confirmed original runtime may be preserved when failure readers/retry and bounded recovery are verified; shared source ownership granted, no startup cleanup added
- [ ] Final staging, CI, CodeRabbit and production gates remain as above

Session-identity audit: writers are the three mission creator INSERTs, ProjectData `sessions.createSession`, Instant `acceptInstantSession`, and TaskRunner `session-linking.ensureSessionLinked`. Relevant readers are orchestrator scheduling eligibility (`chat_session_id IS NULL`) and queued concurrency, workspace-allocation ownership, terminal failure/reconciliation, and retry deletion fencing. `/sam retrySubtask` never reads the predecessor's session ID and allocates a fresh task/session identity while inheriting the mission. MCP `orchestration-tools` retry likewise generates new identities; its existing omission of mission ID is unchanged. `replacement-deletion-fence` permits a predecessor without a workspace. Sleeping snapshot recovery and reserved trigger/schedule creators use their existing explicit identity guards and are not changed.

Independent Sol failure review revised to PASS for this scoped contract after checking `project-data/terminal-session-reconciliation.ts` and `scheduled/terminal-session-ledger-reconciliation.ts`; no claim of a new independent executed suite. Reconciliation's existing completion-drain protection can defer a newly failed session, so tests advance its input clock rather than disable the production guard. Final test execution remains required.

Restored-task validation: SAM autosaved the reconstructed test/docs delta as `388d9d0ba` before sleeping. Same-task wake restored the clean original branch but omitted local `.do-state.md` and ignored test logs; no previous process or local reviewer remained. State was reconstructed without deleting/replacing original commits. The restored test fix extends the existing `captureProjectDataExpectedError` test adapter with `createSession`, catching the actual SQL trigger rejection inside the DO rather than suppressing an unhandled error or self-calling an RPC. Independent fresh local Sol test-engineer/task-completion review: PASS, no blocking finding.

Final discrimination (restored workspace): setting only the MCP task INSERT `chat_session_id` binding to NULL made exactly the two selected regressions fail: the new pre-session midpoint lost its claim, and the original real orchestrator cycle auto-dispatched both held VM tasks. Eight unrelated tests were skipped; no compilation or unhandled-error failure was used as proof. The dispatcher file was restored with an EXIT trap and verified identical to HEAD before the final clean run. The midpoint test drains its released creator in `finally`, including when a mutation assertion fails.

Final clean rerun after restoring the mutation: all 10 Workers tests passed (47.91 s, zero unhandled errors). Current PR preflight and specialist-review evidence both validate locally. Final CI and live staging/production remain pending; task stays active.
