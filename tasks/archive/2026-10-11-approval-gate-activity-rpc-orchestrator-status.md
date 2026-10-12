# Approval gate on /api/sam, dead ProjectData activity fetches, /sam get_project_status orchestrator RPC

SAM task `01M4MZSRFR6TC4JXNYE5HN8X4N` (Wave B of `reliability-wave-1011`, coordinator `01M4MXGVH4EMVNE1CT2XRH484J`).
Source idea: `01M4GJ17Y8K45D0J80ARSFFQEH` (line numbers there are from `3c263a779`; re-verified on `eb18d9c93`).

## Problem

1. **Security.** `/api/sam/*` applies only `requireAuth()` (`apps/api/src/routes/sam.ts:20`). Every other user
   surface also applies `requireApproved()`. With signup approval on, a `pending` account can call
   `POST /api/sam/chat` and spend the platform LLM budget (production had 10 pending users on 2026-10-11).
2. **Silent data loss.** Five callers record activity with `stub.fetch('https://do/activity')`, but
   `ProjectData.fetch` (`durable-objects/project-data/index.ts:2774`) only serves `/ws` and answers 404 for
   everything else. The callers never check `response.ok`, so `task.progress`, `task.awaiting_followup`,
   `task.completed` and `task.dispatched` never reach `activity_events`.
3. **/sam `get_project_status` always reports `orchestrator: null`.** It calls `fetch()` on
   `ProjectOrchestrator`, which exposes only RPC (`getStatus`); the error is swallowed.

## Research findings

### Approval-gate audit (every authenticated-user surface that skips `requireApproved()`)

Method: scanned every `requireAuth()` call site for a `requireApproved()` in the same chain (multi-line aware),
then enumerated the other ways a handler resolves a session user: `getAuthenticatedUser`
(`services/session-factory.ts`), `optionalAuth()`, direct `auth.api.getSession` (`routes/auth.ts`,
`src/index.ts` workspace proxy), and routers that declare no auth and inherit the `/api/projects/*` wildcard
from `projectsRoutes` (`routes/projects/index.ts:19`). BetterAuth has no bearer/API-key plugin
(`src/auth.ts`), so sessions are cookie-only; PATs are exchanged via `token-login`.

Admins can approve (`active`) or suspend (`routes/admin.ts` PATCH `/users/:userId`). A pending
account can already own resources created while approval was disabled; runtime off→on transitions
must deny existing account sessions immediately as well as new resource creation.

| Group                                                                                                                                                                                 | Mount                              | Gate today                                                                                                                                          | Do pending users legitimately need it?                                                                                                                                                                                                                                                              | Decision                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `samRoutes` (`routes/sam.ts`)                                                                                                                                                         | `/api/sam/*`                       | `requireAuth()` only                                                                                                                                | No. LLM chat on the platform budget.                                                                                                                                                                                                                                                                | **Fix**: `requireAuth(), requireApproved()`                                                                |
| `projectAgentRoutes` (`routes/project-agent.ts`)                                                                                                                                      | `/api/projects/:projectId/agent/*` | per-route `requireAuth()` only; blocked in practice only because the `projectsRoutes` `/*` wildcard is mounted first (`src/index.ts:825` vs `:851`) | No. Project LLM agent.                                                                                                                                                                                                                                                                              | **Fix**: add `requireApproved()` to each route so mount order is not load-bearing                          |
| `apiTokenRoutes` list/create/revoke (`routes/api-tokens.ts`)                                                                                                                          | `/api/auth/api-tokens*`            | `getAuthenticatedUser` (suspension check only)                                                                                                      | No. A pending account has no use for a PAT (every redemption re-checks approval), and minting a durable credential before approval is exactly what the gate exists to stop; `/api/credentials` already requires approval.                                                                           | **Fix**: per-route `requireAuth(), requireApproved()`                                                      |
| `claimRoutes` (`routes/trial/claim.ts`)                                                                                                                                               | `POST /api/trial/claim`            | `requireAuth()` only                                                                                                                                | Yes. It completes signup by moving the caller's own anonymous trial project (HMAC claim cookie) to their account. D1 only, no compute or LLM; the project stays unreachable until approval because every project route is gated. Blocking it would lose the trial work before an admin can approve. | **Keep**                                                                                                   |
| `authRoutes` (`/me`, BetterAuth sign-in/callback/sign-out/session)                                                                                                                    | `/api/auth/*`                      | session + suspension                                                                                                                                | Yes. Current user, approval status, sign in/out.                                                                                                                                                                                                                                                    | **Keep**                                                                                                   |
| `POST /api/auth/token-login`                                                                                                                                                          | `/api/auth`                        | approval enforced (`assertUserCanCreateSession`)                                                                                                    | n/a                                                                                                                                                                                                                                                                                                 | Already gated                                                                                              |
| Device flow `/device/approve`                                                                                                                                                         | `/api/auth/device/*`               | `getAuthenticatedUser`                                                                                                                              | Binds a 15-minute KV device code; mints nothing. The only credential-issuing step, `/device/token`, enforces approval (`assertUserCanCreateSession`).                                                                                                                                               | **Keep**                                                                                                   |
| GitHub App install callback (`routes/github.ts` `/callback`)                                                                                                                          | `/api/github/callback`             | `optionalAuth()`                                                                                                                                    | Onboarding: links an installation GitHub confirms the caller owns. No platform spend; repos stay unusable until approval (all project/GitHub list routes are gated).                                                                                                                                | **Keep**                                                                                                   |
| Workspace subdomain proxy (`src/index.ts` ws-* session path)                                                                                                                          | `ws-*.${BASE_DOMAIN}`              | session + suspension, `workspaces.user_id = caller`                                                                                                 | No. A pending owner may retain resources provisioned while approval was off.                                                                                                                                                                                                                        | **Fix**: shared `assertSessionUserApproved` before routing; terminal tokens already check current approval |
| Published workspace ports / port-access links                                                                                                                                         | port-specific workspace subdomains | explicit public publication or scoped signed port capability                                                                                        | Anonymous/capability access intentionally independent of account sessions.                                                                                                                                                                                                                          | **Keep**; no account-session bypass claimed                                                                |
| `analytics-ingest`, `client-errors`                                                                                                                                                   | `/api/t`, `/api/client-errors`     | `optionalAuth()`                                                                                                                                    | Anonymous by design.                                                                                                                                                                                                                                                                                | **Keep**                                                                                                   |
| Inherited-auth project sub-routers (`project-comments`, `project-event-channels`, `project-event-subscriptions`, `project-schedules`, `project-standing-watches`, `library-comments`) | `/api/projects/:projectId/...`     | no own auth; the `/api/projects/*` wildcard runs `requireAuth(), requireApproved()` (documented in `project-comments.ts`)                           | No                                                                                                                                                                                                                                                                                                  | **Keep** (already gated); pinned by a real-worker test                                                     |
| Callback-JWT, MCP-token, connector, webhook, AI-proxy routes                                                                                                                          | various                            | non-session auth                                                                                                                                    | Callback/workspace credentials authorize existing scoped runtime capabilities, including resources predating approval-on; they are not account-session auth. Connector PAT/OAuth re-checks current approval (`assertConnectorUserActive`, connector consent/settings use `requireApproved()`)       | n/a                                                                                                        |

Reference implementation: Connector (`connector-oauth.ts:167`, `connector-settings.ts:77`,
`assertSessionUserApproved` in `services/connector-pat.ts`).

### Dead activity fetches

Callers (all `stub.fetch(new Request('https://do/activity', …))`):

- `routes/mcp/task-tools.ts:137` `task.progress` (task-backed `update_task_status`)
- `routes/mcp/task-tools.ts:281` `task.awaiting_followup` (conversation-mode `complete_task`)
- `routes/mcp/task-tools.ts:418` `task.completed` (task-mode `complete_task`)
- `routes/mcp/dispatch-activity.ts:24` `task.dispatched` (MCP `dispatch_task`)
- `durable-objects/sam-session/tools/dispatch-task.ts:558` `task.dispatched` (/sam `dispatch_task`)

The working path is the service `projectDataService.recordActivityEvent` → DO RPC `recordActivityEvent` →
`activity.recordActivityEventInternal` (used by the taskless `update_task_status` branch at
`task-tools.ts:68`). No shared operation for these tools exists under `apps/api/src/operations/`, so the
shared piece is that service.

Retention: `event-log-cleanup.ts` deletes activity rows only by joining `chat_sessions` on `session_id`
(stopped/failed sessions). `ACTIVITY_RETENTION_DAYS` is declared but unused. So the restored events must carry
the chat session id, or they are retained until the emergency purge. Task-runner MCP tokens carry
`chatSessionId` (`services/agent-session-bootstrap.ts`).

Consumers of the new rows: `ActivityFeed` (generic `task.*` rendering), `GET /api/projects/:id/activity`,
`getSummary().lastActivityAt` → `projects.last_activity_at` (project ordering only; no cleanup logic reads it).
No duplicate: REST close records its own `task.completed` (`routes/tasks/crud.ts:925`).

Why tests missed it: `tests/unit/routes/mcp.test.ts` mocks the DO stub's `fetch` to answer 200 for every path.

### get_project_status

`orchestratorService.getOrchestratorStatus(env, projectId)` (`services/project-orchestrator.ts:68`) already
wraps the `getStatus` RPC and is used by the REST route, the MCP tool, and /sam `get_orchestrator_status`.

### Sibling check

Every other internal `stub.fetch('https://…')` targets a DO with a matching `fetch` handler
(SamSession, ProjectAgent, TrialEventBus, CodexRefreshLock). Only the six calls above are dead.

## Implementation checklist

- [x] `routes/sam.ts`: `app.use('/*', requireAuth(), requireApproved())`
- [x] `routes/project-agent.ts`: `requireApproved()` after `requireAuth()` on all four routes
- [x] `routes/api-tokens.ts`: per-route `requireAuth(), requireApproved()` on list/create/revoke; use `getUserId`
- [x] Update unit-test auth mocks (`tests/unit/routes/sam.test.ts`, `tests/unit/routes/project-agent.test.ts`, api-token tests if any)
- [x] Shared helper for MCP agent activity (one try/catch, actor = agent session or workspace, workspace + chat session columns); use it for taskless progress, task progress, awaiting_followup, completed, dispatched
- [x] Delete the dead `https://do/activity` fetches (task-tools x3, dispatch-activity, /sam dispatch-task)
- [x] /sam `dispatch-task.ts`: `projectDataService.recordActivityEvent(…'task.dispatched', 'user', userId, null, sessionId, taskId, …)`
- [x] /sam `get-project-status.ts`: call `orchestratorService.getOrchestratorStatus`; warn-log failures
- [x] Workers test (real worker, real session cookies, real approval setting): per fixed group pending → 403 `APPROVAL_REQUIRED`, approved passes; pending `GET /api/auth/me` → 200 (liveness); approval-off control; project-agent router mounted alone (discriminating); trial claim still reachable; inherited project sub-routers pinned
- [x] Workers test (real `/mcp`, real DO): task-backed `update_task_status` → `task.progress` row; conversation `complete_task` → `task.awaiting_followup`; task-mode `complete_task` → `task.completed`; dispatch helper → `task.dispatched` row
- [x] Unit: MCP `dispatch_task` reaches the activity RPC; /sam `dispatch_task` records `task.dispatched` via the service
- [x] Workers test: /sam `get_project_status` returns real orchestrator status for an active mission (fails pre-fix)
- [x] Original guard discrimination runs recorded in implementation notes
- [ ] Copy exact-head discrimination and validation evidence into the draft PR (2026-10-12
      reconciliation: left unticked. The #2307 body carries the exact-head CI, SonarCloud and
      staging evidence for `44543a67c` and `40b84b721`. The per-guard discrimination runs exist
      only in this file's Implementation notes. Moot now that #2307 has merged.)
- [x] Docs: public self-hosting guide states what a pending account can reach
- [x] File sizes: `task-tools.ts` below 500 after the change

## Acceptance criteria

- [x] Pending account (approval on) gets 403 `APPROVAL_REQUIRED` on every `/api/sam/*`, `/api/projects/:id/agent/*` and `/api/auth/api-tokens*` route; an approved account reaches the handlers.
- [x] With approval off, a pending account is not blocked (control).
- [x] Pending account can still call `GET /api/auth/me` and `POST /api/trial/claim` (reaches the handler).
- [x] A task-backed `update_task_status` writes a `task.progress` row to `activity_events` through the real DO, with task id and chat session id.
- [x] `complete_task` writes `task.awaiting_followup` / `task.completed`; dispatch writes `task.dispatched`.
- [x] No `https://do/activity` fetch remains in `apps/api/src`.
- [x] /sam `get_project_status` returns orchestrator status (not `null`) for a project with an active mission.
- [x] Security-auditor review plus a new independent adversarial re-verification (policy 034747da), including recovery delta (final-head attestation pending).
- [x] Existing pending workspace owner is denied after runtime approval off→on, through real worker/session/settings.
- [x] All four ProjectAgent routes enforce approval mounted alone (pending denial and approved controls).

## Implementation notes

- Commits: `130bcd090` (approval gate), `b5f866a90` (activity RPC), `fe8afa115` (orchestrator status).
- Pre-fix reproduction: with the gate removed, the pending account's `POST /api/sam/chat` created a real
  SamSession conversation ("Spend the platform budget"); with the activity fix removed, all four MCP activity
  cases found zero `activity_events` rows.
- Discrimination (each guard removed once, then restored):
  - `sam.ts` gate removed: the 4 pending `/api/sam/*` tests and "starts no SAM conversation" go red.
  - `project-agent.ts` gate removed: only "project-agent router enforces approval on its own" goes red. Through
    `SELF` the `/api/projects/*` wildcard still blocks pending accounts, which is why the router-alone test exists.
  - `api-tokens.ts` gate removed: the 3 pending token-management tests and "does not mint an API token" go red.
  - activity fix removed (`task-tools.ts`, `dispatch-activity.ts`): all 4 workers activity tests go red.
  - `/sam` dispatch fix removed: `sam-dispatch-activity` and the `mcp.test.ts` dispatch happy path go red.
  - `get-project-status.ts` fix removed: the active-mission test goes red; the failure and ownership controls stay green.
- `task-tools.ts` went from 525 to 454 lines. `/sam` `dispatch-task.ts` is 602 lines (was 610): pre-existing and
  over the 500-line guideline but under the 800 mandatory split; this change only shrinks it, and /sam tool code is
  slated for the shared-operations/Mastra rebuild (policy 5cb362e8).
- Workers pool note: a fake that returns an already-rejected promise is reported as an unhandled rejection before the
  service's `return stub.getStatus()` adoption attaches a handler; the failure fake rejects on a later tick instead.

## References

- `apps/api/src/middleware/auth.ts`, `apps/api/src/services/signup-approval.ts`
- `apps/api/.claude/rules/06-api-patterns.md` (wildcard middleware scoping, test through the combined app)
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`
- Policies 5cb362e8 (shared operations), 034747da (verified security fixes)

## Recovery verification (2026-10-11)

Resumed the original branch at `80ae7d1a594b9bf5525d531c9daa3e508a8ba234`; preserved all substantive commits.
Initial full lint, typecheck and build passed; real activity/status workers passed 7/7. Independent Sol
security review passed the existing guards and 29/29 approval workers. Fresh adversarial review found
the workspace audit assumption invalid after runtime approval off→on and the router-alone test
covered only one of four guards. Recovery applied the existing `assertSessionUserApproved` in the cookie proxy path; real-worker
approval tests now pass 37/37. Before that fix, the runtime-toggle probe alone failed (36 passed,
503 instead of expected 403). Independent security delta review and a new fresh adversarial
review pass the corrected candidate; final committed-head attestations are being recorded.
The full monorepo test's first run hit an unrelated cloud-init cgroup-test 5s timeout; the bounded
concurrency rerun passed cloud-init 181/181 and is still running. No staging or merge grant yet; no
PR created. Snapshot/WIP metadata does not establish content completeness; read-only content access
remains requested from the coordinator. Dispatch proof is caller-unit plus helper-to-real-DO, not
a full provisioning test.

## Reconciliation 2026-10-12 (weekly queue audit): archived

Shipped and live. The "no PR created" status in the recovery note above is superseded.

- Landing PR: #2307, merge commit `af4341f90` (2026-10-11 17:51Z). The merged head `43fccea52`
  adds only two SAM auto-commits after `40b84b721`, and they cancel out: `cba976fa1` added
  `.do-state.md` and `43fccea52` removed it.
- First successful production deploy: Deploy Production run 38162201788 (head `af4341f90`).
- Known limit, recorded in #2307: the live pending-user 403 was not exercised on staging,
  because no authorized pending identity existed. Coverage comes from the 37 real-worker
  approval tests plus independent security and adversarial reviews. Raphaël's 2026-10-11 recovery
  clarification says not to make that optional live case a merge gate.
