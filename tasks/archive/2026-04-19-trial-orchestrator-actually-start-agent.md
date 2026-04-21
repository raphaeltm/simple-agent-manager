# Task: Trial Orchestrator Actually Starts Discovery Agent on VM + Detects Default Branch

**Date**: 2026-04-19
**Base branch**: `sam/trial-onboarding-mvp` (NOT main)
**Output branch**: `sam/trial-agent-boot`
**PR target**: `sam/trial-onboarding-mvp`

## Problem

The trial orchestrator ships two merge-blocking bugs that keep staging from completing the demo:

1. **Discovery agent subprocess is never booted on the VM.** `handleDiscoveryAgentStart` in
   `apps/api/src/durable-objects/trial-orchestrator/steps.ts` calls `startDiscoveryAgent()`
   which inserts a chat-session row and an ACP-session row (status = `pending`), but the
   orchestrator **never** calls `createAgentSessionOnNode()` + `startAgentSessionOnNode()`.
   The VM agent never launches the agent subprocess. The ACP session sits in `pending`
   forever, the `transitionAcpSession('running')` → `bridgeAcpSessionTransition` →
   `trial.ready` chain never fires, and the UI hangs at 90% "agent is booting up".

2. **Hardcoded `'main'` default branch.** `handleProjectCreation` writes
   `defaultBranch: 'main'` into the `projects` row (line ~125) and `handleWorkspaceCreation`
   passes `branch: 'main'` twice (into the D1 `workspaces` row AND into
   `createWorkspaceOnNode`). Repos whose default is `master` (e.g. `octocat/Hello-World`)
   fail the VM-side `git clone` with `fatal: Remote branch main not found`. The workspace
   never reaches `status='running'` and the orchestrator stalls at `workspace_ready`.

User directive is explicit: "Don't stop working on this until we have a fully functioning
demo in staging. All the way from submitting the repo, seeing all the interim messages,
seeing the knowledge graph etc populate, and then seeing a workspace."

## Research Findings

### Orchestrator flow (current state on `sam/trial-onboarding-mvp`)

`apps/api/src/durable-objects/trial-orchestrator/steps.ts` exports the following step
handlers, dispatched by `alarm()` via `state.currentStep`:

```
project_creation → node_selection → [node_provisioning → node_agent_ready] →
  workspace_creation → workspace_ready → discovery_agent_start → running
```

- `project_creation`: inserts `projects` row with `defaultBranch: 'main'` (hardcoded, bug 2).
- `workspace_creation`: inserts `workspaces` row with `branch: 'main'` + calls
  `createWorkspaceOnNode(nodeId, env, userId, { workspaceId, repository, branch: 'main', ... })`
  (hardcoded twice, bug 2).
- `discovery_agent_start`: only calls `startDiscoveryAgent(env, { projectId, workspaceId, sessionTopic })`
  then advances to `running` (bug 1 — no VM subprocess boot).

### TaskRunner reference implementation

`apps/api/src/durable-objects/task-runner/agent-session-step.ts` is the proven 3-step
idempotent pattern the orchestrator must mirror for the agent-boot piece:

1. **Create session record + tell VM to register it.** Insert D1 `agent_sessions` row →
   `createAgentSessionOnNode(nodeId, workspaceId, sessionId, label, env, userId, chatSessionId, projectId)`.
   Guarded by `state.stepResults.agentSessionId` for idempotency.
2. **Generate + store MCP token** for the agent's platform-awareness tools.
   `generateMcpToken()` + `storeMcpToken(env.KV, token, { taskId | projectId, userId, workspaceId, createdAt }, env)`.
   Guarded by `state.stepResults.mcpToken`.
3. **Start the subprocess with the initial prompt** via
   `startAgentSessionOnNode(nodeId, workspaceId, sessionId, agentType, initialPrompt, env, userId, { url, token }, { model, permissionMode, opencodeProvider, opencodeBaseUrl })`.
   Guarded by `state.stepResults.agentStarted`.

**Trial-specific deviation**: TaskRunner uses the D1 `agent_sessions` table; the trial flow
uses the ProjectData-DO-owned ACP session (`startDiscoveryAgent` already creates this in
`pending` state). The orchestrator therefore must NOT insert into D1 `agent_sessions`; it
must pass the `acpSessionId` as the `sessionId` argument to the VM agent calls, AND it must
drive the ACP state-machine transitions itself because no UI is involved.

### ACP state machine

`packages/shared/src/types/session.ts` defines `ACP_SESSION_VALID_TRANSITIONS`:

```
pending   → assigned
assigned  → running | failed | interrupted
running   → completed | failed | interrupted
completed / failed / interrupted → (terminal)
```

The orchestrator must transition `pending → assigned → running` itself (trial has no UI to
call `POST /:id/acp-sessions/:id/assign`; VM agent does NOT currently POST
`/:id/acp-sessions/:id/status` — grep confirms the only `/status` route in vm-agent code is
the git-status endpoint). Verified via:

```bash
grep -rn "acp-sessions.*/status" packages/vm-agent  # no matches for VM-agent → API call
```

`projectDataService.transitionAcpSession(env, projectId, sessionId, toStatus, opts)` is the
internal RPC entry point — `apps/api/src/services/project-data.ts:390`. It accepts optional
`acpSdkSessionId` and fires `bridgeAcpSessionTransition` which emits `trial.ready` when
`toStatus === 'running'` for any trial-owned project.

### GitHub default branch detection

Public-repo metadata: `GET https://api.github.com/repos/{owner}/{repo}` returns
`default_branch` (string). Unauthenticated rate limit is 60/hour per IP — fine for trial
volumes. Authenticated via GitHub App token would raise to 5000/hour if needed later. The
trial flow already fetches this repo in `apps/api/src/routes/trial/create.ts` step 3 but
discards the response — we can either refetch in `handleProjectCreation` (simpler, keeps
step separation) or thread the value from `create.ts` through `TrialOrchestrator.start()`
input. **Decision: refetch in orchestrator.** The orchestrator is the source of truth for
provisioning state; tying it to an HTTP request lifecycle creates coupling we don't want.

Fallback on API failure: `'main'` (most common default; only cost is re-breaking the
master-default case, which is exactly what this task fixes — but acceptable as a retry
window for transient GitHub 5xx).

### ACP → Trial bridge (already in place on `sam/trial-onboarding-mvp`)

`apps/api/src/services/trial/bridge.ts`:
- `bridgeAcpSessionTransition(env, projectId, toStatus, opts)` — emits `trial.ready` when
  `toStatus === 'running'`.
- `bridgeKnowledgeAdded` — emits `trial.knowledge` from MCP `add_knowledge` calls.
- `bridgeIdeaCreated` — emits `trial.idea` from MCP `create_idea` calls.

`trial.ready` payload includes `workspaceUrl: https://ws-{workspaceId}.{BASE_DOMAIN}`.
Already correct; do not modify.

### Discovery-agent prompt and MCP-token necessity

`startDiscoveryAgent` creates the chat session but does NOT send an initial prompt to any
running agent (the agent isn't running yet — that's the bug). We need to craft a prompt
that tells the agent "explore this repo, populate the knowledge graph via
`add_knowledge`, surface ideas via `create_idea`, and keep the user updated".

MCP token IS required: the discovery agent's whole value is calling `add_knowledge` /
`create_idea` (which require the MCP server URL + a token for Bearer auth on
`https://api.{BASE_DOMAIN}/mcp`). Skipping the token means zero `trial.knowledge` events,
which breaks the primary demo beat.

### Post-mortems reviewed

- `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md` — "VM agent starts ACP
  session" assumed but no code existed. This task is the fix — write a data-flow trace in
  the PR description citing every function on the path.
- `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md` — infra-verification gate.
  Trial orchestrator changes don't touch cloud-init/vm-agent, so we don't need the full
  infra gate, but `Rule 27` still applies if we modified vm-agent code (we don't).
- `docs/notes/2026-03-14-scaleway-node-creation-failure-postmortem.md` — UI input silently
  discarded. Analogue: branch field collected but never forwarded. Our fix must actually
  thread `state.defaultBranch` through the VM-agent call, not just store it in D1.
- `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md` — dispatched reviewers must
  complete before merge. Populate Phase 5 Review Tracker + PR "Specialist Review Evidence"
  table before merging.

## Implementation Checklist

### Orchestrator state additions

- [ ] Add `defaultBranch: string | null` to `TrialOrchestratorState` in
      `apps/api/src/durable-objects/trial-orchestrator/types.ts`.
- [ ] Add `mcpToken: string | null` to `TrialOrchestratorState` (for idempotent token
      reuse across retries of `handleDiscoveryAgentStart`).
- [ ] Add `agentStartedOnVm: boolean` flag (for idempotent `startAgentSessionOnNode` guard).

### GitHub default-branch detection (`handleProjectCreation`)

- [ ] Before the `db.insert(schema.projects)` call, fetch
      `https://api.github.com/repos/{owner}/{repo}` with a 5 s timeout (new
      `TRIAL_GITHUB_PROBE_TIMEOUT_MS` env var, default `DEFAULT_TRIAL_GITHUB_PROBE_TIMEOUT_MS = 5000`
      in `packages/shared/src/constants/trial-orchestrator.ts`).
- [ ] On success: set `state.defaultBranch = data.default_branch`. Persist via
      `ctx.storage.put('state', state)`.
- [ ] On failure (timeout, 404, 5xx, network): `log.warn('trial_orchestrator.default_branch_probe_failed', {...})`
      and fall back to `state.defaultBranch = 'main'` so the flow can continue.
- [ ] Replace hardcoded `defaultBranch: 'main'` in the `db.insert` with `state.defaultBranch`.

### Thread default branch into workspace creation (`handleWorkspaceCreation`)

- [ ] Guard: if `!state.defaultBranch`, throw `{ permanent: true }` error (this can't
      happen unless project_creation was skipped — fail loud, don't silently fall back).
- [ ] Replace both `branch: 'main'` occurrences (the D1 workspaces insert AND the
      `createWorkspaceOnNode(...)` call) with `state.defaultBranch`.

### Boot discovery agent on the VM (`handleDiscoveryAgentStart`)

Mirror TaskRunner's 3-step idempotent pattern. After the existing `startDiscoveryAgent()`
call and the chat-session-to-workspace link:

- [ ] **Step 1 — Register session on VM agent.** Guarded by a new
      `state.agentSessionCreatedOnVm` flag. Call:
      ```ts
      await createAgentSessionOnNode(
        state.nodeId,
        state.workspaceId,
        state.acpSessionId,   // use ACP session id (NOT a new D1 agent_sessions row)
        `Discovery: ${state.repoOwner}/${state.repoName}`,
        rc.env,
        trialAnonymousUserId,
        state.chatSessionId,
        state.projectId,
      );
      ```
- [ ] **Step 2 — Generate + store MCP token.** Guarded by `state.mcpToken`. Call
      `generateMcpToken()` + `storeMcpToken(rc.env.KV, token, { projectId: state.projectId, userId: trialAnonymousUserId, workspaceId: state.workspaceId, createdAt: new Date().toISOString() }, rc.env)`.
- [ ] **Step 3 — Start subprocess with initial prompt.** Guarded by
      `state.agentStartedOnVm`. Build the discovery prompt (see
      `buildDiscoveryPrompt()` below). Call:
      ```ts
      await startAgentSessionOnNode(
        state.nodeId,
        state.workspaceId,
        state.acpSessionId,
        agentType,              // from startDiscoveryAgent result
        discoveryPrompt,
        rc.env,
        trialAnonymousUserId,
        { url: `https://api.${rc.env.BASE_DOMAIN}/mcp`, token: state.mcpToken },
        { model, permissionMode: 'bypassPermissions', opencodeProvider, opencodeBaseUrl },
      );
      ```
- [ ] **Step 4 — Drive ACP state transitions.** Call
      `projectDataService.transitionAcpSession(rc.env, state.projectId, state.acpSessionId, 'assigned', { actorType: 'system', actorId: trialAnonymousUserId, workspaceId: state.workspaceId, nodeId: state.nodeId })`.
      Then immediately call the same function with `'running'` (pass
      `acpSdkSessionId: state.acpSessionId` as a stable placeholder — the internal RPC
      doesn't enforce the route-level validation that the HTTP `/status` endpoint does).
      The `running` transition triggers `bridgeAcpSessionTransition` → emits `trial.ready`.
- [ ] Each step persists state via `ctx.storage.put('state', state)` immediately after
      success so a retry after partial progress picks up where it left off.

### Discovery-agent prompt builder

- [ ] Add `buildDiscoveryPrompt(repoOwner, repoName)` to
      `apps/api/src/services/trial/trial-runner.ts` (or a new `discovery-prompt.ts`).
      Content: greet the user, announce that the agent will explore `{owner}/{repo}`,
      instruct the agent to call `get_instructions` first, then iteratively use
      `add_knowledge` (to populate the trial knowledge graph in real time) and
      `create_idea` (for actionable follow-ups), and end by inviting the user to ask a
      follow-up question. Close with the standard MCP-awareness boilerplate (`IMPORTANT:
      Before starting any work, you MUST call the get_instructions tool from the sam-mcp
      MCP server.`).

### Capability test

- [ ] Add `apps/api/tests/integration/trial-orchestrator-agent-boot.test.ts`. Mocks:
      GitHub API (returns `{ default_branch: 'master' }` for one repo and `'main'` for
      another), VM agent endpoints (`createAgentSessionOnNode`, `startAgentSessionOnNode`),
      KV, and the ProjectData DO `transitionAcpSession`. Asserts:
  1. Both `createAgentSessionOnNode` and `startAgentSessionOnNode` are called with the
     correct payloads (including `branch = 'master'` in the `createWorkspaceOnNode` call
     for the master-default mock).
  2. `transitionAcpSession` is called twice — once with `'assigned'`, once with
     `'running'`.
  3. `trial.ready` is emitted on the event bus after the second transition.
- [ ] Add an idempotency test: invoke `handleDiscoveryAgentStart` twice — VM-agent mocks
      should be called exactly once each (guarded by the new state flags).

### Staging verification (BLOCKING per rule 13)

- [ ] Delete existing trial-project nodes on staging first (rule 27 only if vm-agent
      changed — this task doesn't modify vm-agent, so this step is optional, but do a
      clean run anyway to avoid reusing a pre-fix node).
- [ ] Deploy: `gh workflow run deploy-staging.yml --ref sam/trial-agent-boot`.
- [ ] Playwright: open `https://app.sammy.party/try` (fresh context), submit
      `https://github.com/octocat/Hello-World` (master-default). Verify SSE stream:
      `trial.started` → `trial.progress` (creating_project → finding_node →
      creating_workspace → starting_agent → agent_booting) → ≥1 `trial.knowledge` →
      `trial.ready` with a `workspaceUrl`. Open the workspace URL and confirm it loads.
- [ ] Repeat with `https://github.com/sindresorhus/is-odd` (main-default) in a fresh
      Playwright context. Same event assertions.
- [ ] Capture SSE event stream as JSONL (use `browser.network_requests` or
      `page.request.get` streaming) and screenshots at T+0, T+30s, T+terminal for both
      runs.
- [ ] Upload evidence to library at `/trials/agent-boot-staging-verification/`
      (`upload_to_library` MCP tool) with tags `trial-onboarding`, `staging-verification`,
      `agent-boot`.

### Docs sync

- [ ] Update `docs/guides/trial-configuration.md` with the new
      `TRIAL_GITHUB_PROBE_TIMEOUT_MS` env var.
- [ ] Add a post-mortem at `docs/notes/2026-04-19-trial-orchestrator-agent-boot-postmortem.md`:
      class of bug is "aspirational DO state machine — orchestrator assumed downstream
      code would drive ACP transitions, but the downstream code didn't exist for the
      trial path". Process fix: add a rule requiring new DO state machines to include a
      data-flow trace for every state transition showing which actor drives it.
- [ ] Update `CLAUDE.md` "Recent Changes" with one-liner.

### Review (Phase 5)

- [ ] Dispatch `task-completion-validator`, `cloudflare-specialist`, `test-engineer`,
      `doc-sync-validator`, `constitution-validator`.
- [ ] Populate Phase 5 Review Tracker in `.do-state.md` AND the PR description's
      "Specialist Review Evidence" section.
- [ ] Address every CRITICAL/HIGH finding in-branch (no backlog deferrals).

## Acceptance Criteria

- [ ] Submitting `https://github.com/octocat/Hello-World` on `https://app.sammy.party/try`
      produces a continuous SSE event stream ending in `trial.ready`, and the resulting
      workspace URL loads a live Claude-Code / OpenCode session — verified on staging.
- [ ] Submitting `https://github.com/sindresorhus/is-odd` (main-default) produces the same
      — verified on staging.
- [ ] At least one `trial.knowledge` event arrives between `trial.progress agent_booting`
      and `trial.ready` in both runs (proves the discovery agent actually ran and called
      `add_knowledge`).
- [ ] Capability test + idempotency test pass locally and in CI.
- [ ] VM-agent calls `createAgentSessionOnNode` and `startAgentSessionOnNode` are
      observable in `wrangler tail --env staging` during the run (log lines
      `trial_orchestrator.step.agent_session_created` and
      `trial_orchestrator.step.agent_session_started`).
- [ ] All dispatched reviewers `PASS` or `ADDRESSED` in PR description.
- [ ] Screenshots + `event-stream.jsonl` uploaded to library.
- [ ] PR merged to `sam/trial-onboarding-mvp` (NOT main).

## References

- Current orchestrator: `apps/api/src/durable-objects/trial-orchestrator/{index,steps,types,helpers}.ts` (on `sam/trial-onboarding-mvp`)
- TaskRunner reference: `apps/api/src/durable-objects/task-runner/agent-session-step.ts`
- VM-agent calls: `apps/api/src/services/node-agent.ts` (`createAgentSessionOnNode`, `startAgentSessionOnNode`)
- MCP token: `apps/api/src/services/mcp-token.ts` (`generateMcpToken`, `storeMcpToken`)
- ACP bridge: `apps/api/src/services/trial/bridge.ts` (`bridgeAcpSessionTransition`)
- ACP transitions: `apps/api/src/services/project-data.ts:390` (`transitionAcpSession`)
- State machine: `packages/shared/src/types/session.ts` (`ACP_SESSION_VALID_TRANSITIONS`)
- Rules: 02 (quality gates), 10 (e2e verification), 11 (fail-fast), 13 (staging), 14 (do-state), 23 (cross-boundary contracts), 25 (review merge gate), 27 (vm-agent refresh)
