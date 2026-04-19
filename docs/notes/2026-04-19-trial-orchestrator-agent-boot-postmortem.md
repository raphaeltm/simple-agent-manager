# Trial Orchestrator Never Booted the Discovery Agent on the VM

**Date:** 2026-04-19
**Severity:** High — the primary trial demo flow was unusable end-to-end.
**Affected:** `app.sammy.party/try` anonymous trial onboarding, both staging and production (feature had never worked).
**Related PRs:** #760 (introduced), this PR (fix)

## What Broke

Submitting a public GitHub repo URL at `/try` appeared to work: the user saw
progress events (`creating_project` → `finding_node` → `creating_workspace` →
`starting_agent` → `agent_booting`), the GitHub knowledge fast-path populated
the graph, and the UI displayed "agent is booting up" at 90%.

It then hung at 90% forever. `trial.ready` never fired. The VM was healthy, the
workspace was reachable, but the chat never unlocked.

On `octocat/Hello-World` (master-default) the failure was different and even
more subtle: the VM-side `git clone --branch main` failed because the repo's
default branch is `master`. The trial got a workspace but no code.

## Root Cause

Two distinct bugs in the same code path:

### 1. VM agent subprocess was never started

`handleDiscoveryAgentStart` in
`apps/api/src/durable-objects/trial-orchestrator/steps.ts` called
`startDiscoveryAgent()` — which creates the chat + ACP session *records* in the
ProjectData DO — and stopped there. It never:

- Registered the agent-session row on the VM agent (`createAgentSessionOnNode`)
- Minted an MCP token so the agent could call MCP tools
- Told the VM agent to actually launch the subprocess (`startAgentSessionOnNode`)
- Transitioned the ACP session `pending → assigned → running`

The ACP bridge (`bridgeAcpSessionTransition`) only emits `trial.ready` when
the session reaches the `running` state, so it never fired.

The equivalent 3-step pattern had existed all along in
`apps/api/src/durable-objects/task-runner/agent-session-step.ts`
(`handleAgentSession`). The trial orchestrator was a half-port of the task
runner that stopped after the DO-side session records and never booted the VM
side.

### 2. Hardcoded `'main'` branch

`handleProjectCreation` wrote `defaultBranch: 'main'` to the `projects` row,
and `handleWorkspaceCreation` passed `branch: 'main'` twice in the workspace-
creation payload (volume clone + bootstrap args). Any repo whose default
branch is `master`, `trunk`, `develop`, etc. failed the clone.

## Timeline

- **PR #760** (2026-04-17): Introduced `TrialOrchestrator` DO. The VM-side
  boot section was left as a TODO that said "Track A owns the workspace
  lifecycle and will call the VM agent once the workspace is provisioned."
  This never got wired.
- **PR #761/#763** (2026-04-18/19): Trial UX polish + SSE bridge fixes. All
  assumed the agent was actually booting; the fixes made the hang visible
  but didn't address it.
- **2026-04-19**: Discovered during manual end-to-end staging verification on
  `octocat/Hello-World` — the branch bug surfaced immediately (clone failed),
  which led to investigating the agent-boot gap.

## Why It Wasn't Caught

The existing unit tests for `handleDiscoveryAgentStart` covered two paths:
1. Permanent failure when `projectId`/`workspaceId` were missing.
2. Idempotent no-op when the ACP session was already linked.

Neither test asserted that the cross-boundary calls to the VM agent ever
happened. The capability test rule (`.claude/rules/10-e2e-verification.md`)
exists precisely for this — it says every multi-component feature needs a
test that "asserts the final outcome, not just intermediate state." The trial
flow had no such test.

The hardcoded `'main'` was not caught because the primary test repo
(`sindresorhus/is-odd`) is main-default. Master-default was never exercised in
tests and was first tried during staging verification for this PR.

## Class of Bug

**Stub handler that looks implemented.** The function existed, had a real
docstring, emitted a `trial.progress` event, and read/wrote DO state. From a
naming-honesty perspective (Rule 10) the name `handleDiscoveryAgentStart`
implied the discovery agent is *started*. It only started the DO-side session
records; the VM-side subprocess never started.

This is the same class of bug as the 2026-02-28 "missing initial prompt"
incident — a half-ported pattern where the call site intent doesn't match
the call site behavior, and the name hides the gap.

## Fix

See commit `feat(trial): boot discovery agent on VM + detect real default branch`:

1. `handleDiscoveryAgentStart` now runs the full 3-step VM boot pattern
   (`createAgentSessionOnNode` → MCP token → `startAgentSessionOnNode`) and
   drives the ACP session through `pending → assigned → running`. All five
   steps are gated by explicit idempotency flags on DO state
   (`agentSessionCreatedOnVm`, `agentStartedOnVm`, `acpAssignedOnVm`,
   `acpRunningOnVm`) so a crash mid-flight re-enters without double-booking.
2. `fetchDefaultBranch()` probes GitHub's public API with a 5s AbortController
   timeout and falls back to `'main'` on any failure. The result is
   persisted to `state.defaultBranch`, threaded into `projects.defaultBranch`,
   and used for both `git clone --branch` sites in `handleWorkspaceCreation`.
3. New capability test
   (`apps/api/tests/unit/durable-objects/trial-orchestrator-agent-boot.test.ts`)
   asserts:
   - `createAgentSessionOnNode` is called with the correct payload
   - `generateMcpToken` + `storeMcpToken` are called with trialId as synthetic taskId
   - `startAgentSessionOnNode` is called with discovery prompt + MCP server URL
   - Two `transitionAcpSession` calls fire in order (`assigned`, then `running`)
   - Crash/retry is idempotent when all flags are set
   - Partial crash (mcpToken persisted but subprocess not started) resumes at step 4
   - `fetchDefaultBranch` returns `master` when GitHub says so, falls back
     to `main` on 404 / network error / already-resolved state

## Process Fix

This post-mortem surfaced a rule-level gap: when we port a well-established
pattern (e.g., TaskRunner's agent-session-step) to a new consumer (e.g., the
trial orchestrator), we need an explicit checklist item saying "assert
cross-boundary calls in the new consumer's unit tests." The existing rules
cover this in principle (Rule 10 capability tests, Rule 23 cross-boundary
contract tests), but only if someone remembers to apply them.

Added a bullet to `.claude/rules/10-e2e-verification.md` under "Capability
Test Checklist" making port-of-pattern coverage explicit:

> When porting a multi-step pattern (VM boot, credential rotation, agent
> session lifecycle) from an existing consumer to a new one, the new
> consumer's tests MUST mock each cross-boundary target and assert **every
> step of the pattern fired** with the correct payload. A test that asserts
> "step 1 fired" but not "step 3 fired" does not prove the port is complete.
