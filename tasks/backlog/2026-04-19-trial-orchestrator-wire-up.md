# Task: Wire Up Trial Orchestrator + Fast GitHub Knowledge Events

**Task ID**: 01KPJE7RJ28J2TRT6W3DK15CX9
**Base branch**: `sam/trial-onboarding-mvp` (NOT main)
**Output branch**: `sam/trial-onboarding-wire-missing-01kpje`
**PR target**: `sam/trial-onboarding-mvp`

## Problem

The zero-friction trial onboarding MVP partially works on `sam/trial-onboarding-mvp` (deployed to staging). `POST /api/trial/create` inserts a D1 row, mirrors to KV, sets cookies, and returns 201. The frontend opens an SSE channel at `/api/trial/:trialId/events` and sits on a "Warming up the workspace…" empty-state.

**Nothing actually starts a workspace, runs an agent, or emits any trial events.** Verified on staging with `trial_df88c8e549c54bf89c52cfa0d934c7a4` — 5+ minutes with zero events. Grep confirms: `startDiscoveryAgent` and `emitTrialEvent` from `apps/api/src/services/trial/trial-runner.ts` have **no callers** in the repo — they are dead code.

## Research Findings

### What exists (don't break)

1. `apps/api/src/routes/trial/create.ts` — 6-step happy path: validate → kill-switch → GitHub probe → counter slot → persist trial row (D1 + KV) → issue cookies & return 201. Comments explicitly defer orchestration to "Track-B" and "the SSE orchestrator" that was never written.
2. `apps/api/src/services/trial/trial-runner.ts` — exports `startDiscoveryAgent(env, opts)` (creates chat + ACP sessions on a project via `projectDataService.createSession` and `createAcpSession`; returns `{ chatSessionId, acpSessionId, agentType, model, provider, promptVersion }`) and `emitTrialEvent()` / `emitTrialEventForProject()` (append to `TRIAL_EVENT_BUS` DO via fetch). Both unused.
3. `apps/api/src/durable-objects/trial-event-bus.ts` — per-trial DO, in-memory long-poll buffer, auto-closes on `trial.ready` / `trial.error` terminal events.
4. `apps/api/src/durable-objects/trial-counter.ts` — monthly slot counter.
5. `apps/api/src/routes/trial/events.ts` — SSE endpoint at `/:trialId/events` (mounted → `/api/trial/:trialId/events`) with fingerprint-cookie auth, long-polls `TRIAL_EVENT_BUS`.
6. `packages/shared/src/trial.ts` — `TrialEvent` discriminated union (`trial.started | trial.progress | trial.knowledge | trial.idea | trial.ready | trial.error`) and sentinel `TRIAL_ANONYMOUS_USER_ID = 'system_anonymous_trials'` (seeded by migration 0043).
7. `apps/api/src/services/trial/trial-store.ts` — `readTrial`, `readTrialByProject`, `writeTrial` (KV), `markTrialClaimed`.

### Provisioning pattern to mirror (TaskRunner DO)

`apps/api/src/durable-objects/task-runner/` is the canonical alarm-driven state-machine DO:

- `index.ts` — `start(input)` is idempotent (returns early if state already exists). Persists state via `ctx.storage.put('state', state)` + schedules alarm via `ctx.storage.setAlarm(ms)`. `alarm()` dispatches by `state.currentStep`. Transient errors retry with exponential backoff (`computeBackoffMs`); permanent errors → `failTask`.
- `node-steps.ts:handleNodeSelection` — tries warm pool (`tryClaimWarmNode` → `NodeLifecycle.tryClaim`) → existing capacity (`findNodeWithCapacity`) → provision new (`handleNodeProvisioning` with `MAX_NODES_PER_USER` enforcement). `handleNodeAgentReady` polls D1 heartbeat (cannot fetch VM directly in same-zone).
- `workspace-steps.ts:handleWorkspaceCreation` — inserts `workspaces` row (id, nodeId, projectId, userId, installationId, name, repository, branch, status='creating', vmSize, vmLocation, workspaceProfile, devcontainerConfigName), starts compute tracking, calls `ensureSessionLinked`, signs `callbackToken` via `signCallbackToken(workspaceId, env)`, calls `createWorkspaceOnNode(nodeId, env, userId, { workspaceId, repository, branch, callbackToken, lightweight, ... })`. `handleWorkspaceReady` polls D1 + awaits `advanceWorkspaceReady` callback.
- Timing via `DEFAULT_TASK_RUNNER_*` constants in `@simple-agent-manager/shared`, overridable by env vars.

### Workspace creation signature (`apps/api/src/services/node-agent.ts:createWorkspaceOnNode`)

```typescript
createWorkspaceOnNode(
  nodeId: string,
  env: Env,
  userId: string,
  { workspaceId, repository, branch, callbackToken, gitUserName?, gitUserEmail?,
    githubId?, lightweight?, devcontainerConfigName? }
): Promise<unknown>
```

### Schema requirements

- `workspaces`: id, nodeId (nullable FK), projectId (nullable FK), userId (NOT NULL), installationId (nullable FK), name (NOT NULL), repository, branch, status='creating', vmSize, vmLocation, workspaceProfile, createdAt/updatedAt.
- `projects`: id, userId (NOT NULL, trial → `TRIAL_ANONYMOUS_USER_ID`), name, repository, installationId (NOT NULL, FK cascade), status='active', createdBy (NOT NULL, = userId for trials).

### GitHub installation for trial projects

`projects.installationId` is NOT NULL with cascade delete. Trials have no installation. **Open question for implementation**: either make `installationId` nullable for trial projects (schema migration) OR use a sentinel `system_anonymous` installation row (mirror of sentinel user). The cleanest path given constraints: **seed a sentinel installation row** (migration adds one) so we don't touch the schema type. If a migration isn't available in this task's scope, use `null` via raw SQL INSERT that bypasses Drizzle's type check — but document the assumption clearly. The sentinel approach is preferred.

**Action from research**: need to verify in migrations directory whether a sentinel installation exists (migration 0043 creates the sentinel user only). If absent, we'll add a new migration that inserts a sentinel `system_anonymous_trials_installation` row. This MUST be in the same PR — it's a merge-blocking infrastructure item per rule `22-infrastructure-merge-gate.md`.

### ACP event bridge hook points

Per Explore research, the bridge needs to hook at:

1. **`trial.ready`** — when the ACP session status transitions to the first assistant message / running. ProjectData DO transitions ACP session status via `transitionAcpSession(sql, sessionId, toStatus, opts, projectId)`. Find the RPC entry point and: `if (project.userId === TRIAL_ANONYMOUS_USER_ID && toStatus === 'running') emitTrialEventForProject(env, projectId, { type: 'trial.ready', ... })`.
2. **`trial.knowledge`** — when agents call the `add_knowledge` MCP tool: `if (project owner is trial) emitTrialEventForProject(env, projectId, { type: 'trial.knowledge', entity, observation, at })`.
3. **`trial.idea`** — when agents call `create_idea` MCP tool: analogous.
4. **`trial.error`** — on terminal ACP failure transitions OR orchestrator timeout.

### Fast GitHub knowledge events (Half 2)

From `c.executionCtx.waitUntil(...)` after step 6 of create.ts, issue parallel GitHub API probes:
- `GET /repos/:owner/:repo` — stars, forks, language, open_issues_count, description
- `GET /repos/:owner/:repo/contents` — top-level files (README, tests/, devcontainer.json, package.json)
- `GET /repos/:owner/:repo/commits?per_page=1` — most recent commit

Each emits a `trial.knowledge` event. Fire-and-forget, timeout-bounded, never blocks. Use GitHub App credentials (`GITHUB_APP_*` env vars) if unauthenticated rate limits become an issue — for now, unauthenticated is fine given the repo was already validated public in step 3.

### Configuration constraints (Constitution XI)

All new timing values MUST go through env vars with `DEFAULT_TRIAL_ORCHESTRATOR_*` / `DEFAULT_TRIAL_KNOWLEDGE_*` constants in `@simple-agent-manager/shared`. No hardcoded timeouts, retry counts, or limits.

### Post-mortems reviewed

- `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md` — aspirational docs without code paths; 8 tasks built on a non-existent "VM agent starts ACP session" claim. **Mitigation**: write a Data Flow Trace in the PR description citing specific code paths.
- `docs/notes/2026-03-14-scaleway-node-creation-failure-postmortem.md` — UI input silently discarded. **Mitigation**: Rule 06 UI-to-Backend checklist — ensure the SSE UI actually sees the events we emit (verified by capability test + Playwright).
- `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md` — infra verification gate must run. **Mitigation**: staging deploy + real VM provision + heartbeat confirmation is mandatory.
- `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md` — merged before reviewers completed. **Mitigation**: `.do-state.md` Review Tracker, PR description "Specialist Review Evidence" table populated before merge.
- `docs/notes/2026-04-18-project-credentials-security-hardening-postmortem.md` — credential resolution fallback branches untested. Not directly applicable (no credential branching in trials) but informs test rigor.

## Architectural Decision

**Use a new `TrialOrchestrator` Durable Object** (alarm-driven state machine) rather than `c.executionCtx.waitUntil(...)`-only orchestration. Reasons:
1. Worker restart durability — alarms survive.
2. Idempotency via DO state (`state.workspaceId` guard).
3. Mirrors TaskRunner — code review is faster when patterns match.
4. Timeouts and retries are clean with alarms.

`c.executionCtx.waitUntil(...)` IS still used, but only to:
- Kick off `TRIAL_ORCHESTRATOR.start(...)` with the trialId (fire-and-forget).
- Fire the fast GitHub knowledge events (unrelated to orchestrator lifetime).

## Implementation Checklist

### Shared constants (build order: shared first)

- [ ] Add `DEFAULT_TRIAL_ORCHESTRATOR_*` constants to `packages/shared/src/constants/` (new file `trial-orchestrator.ts`, or extend existing): step max retries (5), retry base delay (1s), retry max delay (60s), overall timeout (5 min = 300000ms), workspace ready timeout (300s), agent ready timeout (60s), node agent poll interval (5s).
- [ ] Add `DEFAULT_TRIAL_KNOWLEDGE_*` constants: github timeout (5s), max events (10).
- [ ] Export new constants from `packages/shared/src/index.ts`.
- [ ] `pnpm --filter @simple-agent-manager/shared build`.

### env.ts + wrangler.toml bindings

- [ ] Add `TRIAL_ORCHESTRATOR: DurableObjectNamespace;` to `apps/api/src/env.ts`.
- [ ] Add optional env vars: `TRIAL_ORCHESTRATOR_OVERALL_TIMEOUT_MS`, `TRIAL_ORCHESTRATOR_STEP_MAX_RETRIES`, `TRIAL_ORCHESTRATOR_RETRY_BASE_DELAY_MS`, `TRIAL_ORCHESTRATOR_RETRY_MAX_DELAY_MS`, `TRIAL_ORCHESTRATOR_WORKSPACE_READY_TIMEOUT_MS`, `TRIAL_ORCHESTRATOR_WORKSPACE_READY_POLL_INTERVAL_MS`, `TRIAL_ORCHESTRATOR_AGENT_READY_TIMEOUT_MS`, `TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS`, `TRIAL_KNOWLEDGE_MAX_EVENTS`.
- [ ] Add `[[durable_objects.bindings]] name = "TRIAL_ORCHESTRATOR" class_name = "TrialOrchestrator"` to `apps/api/wrangler.toml`.
- [ ] Add `[[migrations]] tag = "v9" new_classes = ["TrialOrchestrator"]` to `apps/api/wrangler.toml`.
- [ ] **Merge-blocking per rule 22**: verify binding appears in staging deploy output.

### Sentinel GitHub installation (schema)

- [ ] Check existing migrations for a `system_anonymous_trials_installation` row. If absent, add migration `0044_trial_sentinel_installation.sql` seeding one (owner='anonymous-trials', installationId = a stable identifier matching the sentinel pattern, userId = TRIAL_ANONYMOUS_USER_ID).
- [ ] Alternative if migration isn't possible: investigate nullable `projects.installationId` for trial-owned projects (schema change).
- [ ] Document the decision in the orchestrator file header.

### TrialOrchestrator DO

- [ ] Create `apps/api/src/durable-objects/trial-orchestrator/` directory (following TaskRunner pattern) with:
  - `index.ts` — DO class, `start()`, `alarm()`, state machine dispatch.
  - `types.ts` — `TrialOrchestratorState`, `TrialOrchestratorStep` enum (`project_creation | node_selection | node_provisioning | node_agent_ready | workspace_creation | workspace_ready | discovery_agent_start | running | failed | succeeded`).
  - `steps.ts` — step handlers (smaller than TaskRunner — no task, no chat session follow-ups).
  - `helpers.ts` — local helpers or import from shared TaskRunner helpers.
- [ ] `start(input: { trialId, repoUrl, repoOwner, repoName })` — idempotent via `getState()` check. Initial state emits `trial.started`. Schedules alarm immediately.
- [ ] `alarm()` — switch on `currentStep`:
  - `project_creation`: insert `projects` row under `TRIAL_ANONYMOUS_USER_ID` + sentinel installation, update KV trial record with projectId, re-issue claim cookie payload stored in KV (client hasn't refreshed — ok, claim validation works with trialId alone per create.ts comment). Emit `trial.progress { stage: 'creating_project', progress: 0.1 }`.
  - `node_selection`: reuse `handleNodeSelection` logic or duplicate the minimal path (warm pool → capacity → provision). Emit `trial.progress { stage: 'finding_node', progress: 0.2 }`.
  - `node_provisioning`: if new node, wait for heartbeat. Emit `trial.progress { stage: 'provisioning_node', progress: 0.3 }`.
  - `workspace_creation`: insert `workspaces` row, call `createWorkspaceOnNode` with `lightweight: true` and `workspaceProfile: 'lightweight'`. Emit `trial.progress { stage: 'creating_workspace', progress: 0.5 }`.
  - `workspace_ready`: poll D1 workspace status OR wait for callback. Emit `trial.progress { stage: 'starting_agent', progress: 0.7 }`.
  - `discovery_agent_start`: call `startDiscoveryAgent(env, { projectId, workspaceId, sessionTopic: repo slug })`. Persist `chatSessionId` + `acpSessionId` in state. Emit `trial.progress { stage: 'agent_booting', progress: 0.9 }`.
  - `running`: terminal for the orchestrator — the ACP bridge (see below) will emit `trial.ready` when the agent starts producing output.
  - On any transient error: retry with backoff. On permanent or timeout-exceeded: emit `trial.error` and transition to `failed` (terminal).
- [ ] Idempotency guard: on re-entry from alarm, check `state.workspaceId` — if non-null and step <= workspace_creation, advance past.
- [ ] Overall timeout guard: if `Date.now() - state.createdAt > OVERALL_TIMEOUT_MS`, emit `trial.error { error: 'trials_disabled', message: 'Trial provisioning timed out' }` and transition to `failed`.
- [ ] Export `TrialOrchestrator` from `apps/api/src/index.ts`.

### ACP → Trial event bridge

- [ ] Find the ProjectData DO entry point that transitions ACP sessions (`transitionAcpSession` wrapper). Add a trial-aware branch: if the project's owning userId is `TRIAL_ANONYMOUS_USER_ID` AND the new status is `running` (first successful agent turn), call `emitTrialEventForProject(env, projectId, { type: 'trial.ready', trialId: <resolved>, projectId, workspaceUrl, at })`.
- [ ] Find `add_knowledge` MCP tool handler. Add trial-aware branch: if project owner is anonymous trials, `emitTrialEventForProject(env, projectId, { type: 'trial.knowledge', entity, observation, at })`.
- [ ] Find `create_idea` MCP tool handler. Add trial-aware branch: `emitTrialEventForProject(env, projectId, { type: 'trial.idea', ideaId, title, summary, at })`.
- [ ] If ACP transitions to `failed`: `emitTrialEventForProject(env, projectId, { type: 'trial.error', error: 'trials_disabled', message, at })`.
- [ ] **Rule 10 data flow trace**: document in PR desc — user action → ACP notification → ProjectData DO RPC → trial bridge → TRIAL_EVENT_BUS → SSE stream → browser.

### create.ts wiring

- [ ] Add `c.executionCtx.waitUntil(...)` AFTER step 6 response is built (before `return new Response(...)`), dispatching two concurrent tasks:
  1. `TrialOrchestrator.start({ trialId, repoUrl, repoOwner, repoName })`.
  2. `emitGithubKnowledgeEvents(env, trialId, repo)` (new service in `apps/api/src/services/trial/github-knowledge.ts`).
- [ ] Keep the 6-step happy path unchanged — do not reorder, do not add synchronous calls to these new code paths.

### GitHub knowledge service (Half 2)

- [ ] Create `apps/api/src/services/trial/github-knowledge.ts`:
  - `emitGithubKnowledgeEvents(env, trialId, { owner, name })` — fires 3-4 parallel GitHub API probes with `TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS` timeout each. For each successful probe, formats and emits a `trial.knowledge` event via `emitTrialEvent(env, trialId, ...)`.
  - Probes: repo metadata (stars/forks/language/description), top-level contents (README/tests/devcontainer), recent commit.
  - Any failure → silently skipped (log.warn only). NEVER throws.
  - Uses `Promise.all` but caps at `TRIAL_KNOWLEDGE_MAX_EVENTS`.

### Tests (mandatory per rules 02 + 10)

- [ ] **Capability test** (`apps/api/tests/integration/trial-orchestrator.test.ts`): simulates full flow: POST /api/trial/create → orchestrator DO runs → emits `trial.started` → at least one `trial.knowledge` event → `trial.progress` events → terminal `trial.ready`. Mocks VM agent and ACP, but asserts exact event ordering and shapes.
- [ ] **Idempotency test**: invoke `TrialOrchestrator.start()` twice with same trialId → only one workspace provisioned.
- [ ] **GitHub API failure test**: probes 404/timeout → orchestrator provisions workspace normally, no knowledge events emitted, no `trial.error`.
- [ ] **Terminal failure test**: workspace provisioning timeout → `trial.error` emitted, orchestrator enters `failed` state, TrialEventBus closed, no zombie workspace row in D1 (or marked failed).
- [ ] **Cross-boundary contract test** (rule 23): mock ProjectData DO's `transitionAcpSession` and verify the trial bridge emits correct event shape.

### Docs sync

- [ ] Update `docs/guides/trial-configuration.md` to list new env vars and describe the orchestrator DO lifecycle.
- [ ] Add a Data Flow Trace section to the PR description citing specific code paths (rule 10).
- [ ] Update CLAUDE.md "Recent Changes" with one-line summary of the orchestrator.

### Review (Phase 5)

- [ ] Dispatch `task-completion-validator` (required).
- [ ] Dispatch `cloudflare-specialist` (DO + D1 + KV + wrangler binding patterns).
- [ ] Dispatch `security-auditor` (cookie re-issue, trial claim flow, anonymous user isolation).
- [ ] Dispatch `test-engineer` (capability + idempotency + failure coverage).
- [ ] Populate PR description "Specialist Review Evidence" table with each reviewer's status.

### Staging verification (Phase 6)

- [ ] `gh workflow run deploy-staging.yml --ref sam/trial-onboarding-wire-missing-01kpje`.
- [ ] Wait for green deploy.
- [ ] **Delete all existing nodes** before testing VM-agent-affecting changes (rule 27).
- [ ] Playwright in scripted mode: open https://app.sammy.party/try (fresh context, no trial cookies), paste `https://github.com/sindresorhus/is-online`, screenshot at T+0 / T+2s / T+10s / T+30s / T+60s / T+terminal.
- [ ] Capture full SSE event stream as JSONL.
- [ ] Upload screenshots + JSONL to project library at `/trials/orchestrator-staging-verification/` with tags `trial-onboarding`, `staging-verification`, `orchestrator-task` (via `upload_to_library` MCP tool).
- [ ] Include screenshot grid + timing breakdown in PR description.

## Acceptance Criteria

- [ ] Pasting a public repo URL on `https://app.sammy.party/try` results in a continuous stream of trial events ending in `trial.ready` (or a clear `trial.error` on bad input) — verified on staging.
- [ ] First `trial.knowledge` event arrives within 3s of paste (GitHub-API derived) — verified with SSE JSONL capture.
- [ ] Workspace is actually provisioned (D1 workspaces row with status='running' or 'ready', real vmIp) — verified via admin dashboard or D1 query.
- [ ] Discovery agent runs an ACP session (ProjectData DO has a chat session + ACP session for the trial project) — verified via D1/DO inspection or API call.
- [ ] Capability test + idempotency test + GitHub-failure test + terminal-failure test all pass locally and in CI.
- [ ] All 4 specialist reviewers `PASS`/`ADDRESSED` — visible in PR description.
- [ ] Screenshots + `event-stream.jsonl` uploaded to library.
- [ ] PR merged to `sam/trial-onboarding-mvp` (NOT main).
- [ ] No new wrangler binding check failures (`pnpm quality:wrangler-bindings`).
- [ ] `.do-state.md` deleted after merge.

## References

- Task details: MCP `get_task_details` → `01KPJE7RJ28J2TRT6W3DK15CX9`
- Create.ts flow: `apps/api/src/routes/trial/create.ts`
- Trial runner primitives: `apps/api/src/services/trial/trial-runner.ts`
- TaskRunner DO pattern: `apps/api/src/durable-objects/task-runner/{index,node-steps,workspace-steps,types,helpers}.ts`
- Workspace VM-agent call: `apps/api/src/services/node-agent.ts:createWorkspaceOnNode`
- Event types: `packages/shared/src/trial.ts`
- SSE endpoint: `apps/api/src/routes/trial/events.ts`
- Rules: 06 (API patterns), 10 (E2E verification), 11 (fail-fast), 13 (staging), 14 (do state), 22 (infra merge gate), 23 (cross-boundary contracts), 25 (review merge gate), 27 (VM agent refresh)
- Config docs: `docs/guides/trial-configuration.md`
