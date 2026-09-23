# Durable long-request handling for diagnoses and chat starts

## Problem

Two user-facing operations currently rely on a single long browser-owned request after the user has expressed intent:

- A production admin debug diagnosis for the last 24h can be lost if the phone/browser closes before `runDebugDiagnosis` finishes. The completed `debug_diagnoses` row is only inserted after the LLM/tool loop completes.
- Instant Cloudflare Container chat/session start can take 10-15s or longer. The initial task/session/message is persisted, but the same `POST /api/projects/:projectId/sessions/start` request continues through container launch, node-agent readiness, workspace creation, and ACP session start. If the client disconnects, accepted work can remain stuck in transient state or look lost to the user.

Goal: persist user intent quickly, return durable IDs/status quickly, continue long work in server-owned orchestration, and make refresh/navigation recover running or terminal state.

## Research findings

- `apps/api/src/routes/admin.ts` calls `runDebugDiagnosis(c.env, getUserId(c), body)` directly in `POST /api/admin/observability/diagnoses`, returning only after completion.
- `apps/api/src/services/debug-agent.ts` validates the diagnosis window and budget, runs the Workers AI/tool loop, then inserts `debug_diagnoses` only at the end. Failed/interrupted attempts have no durable run row.
- `apps/api/src/db/schema.ts` currently has `debug_diagnoses` for terminal diagnoses but no durable job/run table for queued/running/failed attempts.
- `apps/web/src/components/admin/ErrorList.tsx` and `apps/web/src/components/admin/DebugDiagnosisPanel.tsx` keep the in-flight diagnosis in component state and reload only completed diagnosis history.
- `apps/api/src/routes/chat-start.ts` persists a task with `executionStep='instant_persistence'`, then awaits `launchInstantSession` before returning `status: running`.
- `apps/api/src/services/instant-session.ts` persists workspace, ProjectData chat session, and initial user message before launching the container, but then synchronously waits for `launchVmAgentContainer`, `waitForNodeAgentReady`, `createWorkspaceOnNode`, and `startSamAwareAgentSession`.
- `apps/api/src/durable-objects/task-runner/index.ts` is the existing alarm-driven orchestration pattern: one DO per task, idempotent `start`, `ensureStarted`, persisted step state, alarms, and failure transitions.
- `tasks/backlog/2026-07-19-instant-launch-stuck-queued-on-disconnect.md` documents the exact Instant disconnect/stuck queued failure and requires a sweep/cron escape path.
- `.claude/rules/43-long-running-mcp-tools.md` generalizes the policy beyond MCP tools: long control-plane-to-VM/container work must quick-accept durable state and continue independently of the HTTP request context.

## Implementation checklist

### Admin debug diagnosis

- [x] Add schema/migration for durable debug diagnosis run/job records with queued/running/succeeded/failed, creator, input window/error id, timestamps, usage/error details, diagnosis linkage, retry lineage.
- [x] Refactor debug-agent logic so validation/window resolution can create a run immediately and the existing LLM/tool loop can complete a run server-side without changing budget/redaction semantics.
- [x] Add a Durable Object/alarm-backed runner or equivalent request-independent owner for diagnosis jobs.
- [x] Change `POST /api/admin/observability/diagnoses` to validate, create a run, start/ensure the runner, and return 202 with durable run/job id and status.
- [x] Add list/detail/retry APIs for diagnosis runs and preserve completed `debug_diagnoses` history.
- [x] Update `/admin/errors` UI to show running/recent diagnosis runs after refresh, terminal failures with retry, completed diagnosis result, and existing save-as-Idea flow.

### Instant/cf-container chat start

- [x] Refactor `launchInstantSession` into durable acceptance and server-owned launch phases, reusing/extending TaskRunner DO/alarm patterns where practical.
- [x] Change `POST /api/projects/:projectId/sessions/start` to persist task/session/user message and return durable `taskId/sessionId/status` before container launch, workspace creation, repo clone, agent readiness, or ACP startup.
- [x] Ensure route start uses an ambiguous-ack hardening pattern equivalent to `ensureTaskRunnerStarted` where the DO start RPC may have accepted but the client cannot prove it.
- [x] Ensure refresh/navigation can recover queued/starting/running/failed state for the new session.
- [x] Add/complete stale queued/instant_persistence sweep so accepted Instant starts cannot remain queued/creating indefinitely.
- [x] Evaluate follow-up prompt durability with existing VM `messageId` support. Include a small fix if scoped; otherwise file a precise backlog task with evidence.

### Tests and verification

- [x] Add API/service/DO tests for diagnosis run visibility while running, success with linked persisted diagnosis, durable failure state, and retry.
- [x] Add web tests for `/admin/errors` running/recent diagnosis history, failure/retry, completed diagnosis display, and save-as-Idea behavior.
- [x] Add API/DO tests proving Instant first-message start returns after durable acceptance and launch continues in server-owned context; include ambiguous/interrupted start coverage so accepted tasks do not stay queued forever.
- [x] Add web tests proving new chat submission navigates/recovers queued/starting state without depending on the original POST remaining open.
- [ ] Run migration/schema validation, typecheck, focused tests, full quality gates, local specialist reviews, staging verification, PR CI, merge, and production deploy monitoring per `/do`. Local and staging gates completed; PR CI/merge/prod monitoring remain before archive.

## Acceptance criteria

- [x] Admin can start a diagnosis, close/refresh/navigate away, return to `/admin/errors`, see the running job or terminal result, retry on failure, and save completed output as a draft Idea.
- [x] Starting a new Instant/cf-container chat returns quickly after durable acceptance; closing the browser/phone after acceptance does not lose the user message or session/task identity; returning shows queued/starting/running/failed state.
- [x] No known path leaves accepted Instant starts stuck indefinitely in queued/creating with no diagnosis.
- [x] Existing task-mode submission and existing diagnosis save-as-Idea behavior remain compatible.
- [x] One PR covers both fixes and includes combined test/verification evidence. Draft PR #1722 covers both tracks with combined validation evidence.

## Implementation notes

- Follow-up prompt durability was evaluated and deferred to `tasks/backlog/2026-08-03-durable-follow-up-prompt-delivery.md` because it requires a separate durable prompt-delivery state machine for existing sessions.
- Local verification completed: focused typechecks/tests, full `pnpm test`, full `pnpm build`, and D1/DO migration safety/order gates.
- Staging verification completed on 2026-08-03: deploy workflow 30797392483 passed; admin diagnosis quick-accepted and recovered run `01KZ3CNRZZQ8AHJB2CNWGSNFBT`; Instant cf-container start quick-accepted in 6.5s with task `01KZ3CNFTECCEA3NMFBAWMP6TA`, session `be166489-2f3e-44b6-b227-0c03d84570eb`, and direct task recovery showed persisted workspace `01KZ3CNG93WS8J4Q285EXKDBCZ`.
