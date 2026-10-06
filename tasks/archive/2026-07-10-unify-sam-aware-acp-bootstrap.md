# Unify SAM-Aware ACP Bootstrap for TaskRunner and Instant Sessions

## Problem

Instant `cf-container` sessions launched through `launchInstantSession()` bypass the TaskRunner agent-session bootstrap. They do not receive the injected `get_instructions` reminder that TaskRunner adds before starting an agent, and their taskless MCP tokens (`taskId: ''`) cannot call `get_instructions` because the handler currently requires a task row.

This means instant agents can start with tool access but without SAM knowledge directives, policy directives, project context, or the correct reporting instructions.

## Research Findings

- `apps/api/src/durable-objects/task-runner/agent-session-step.ts` currently mixes task prompt construction, D1 `agent_sessions` insertion, VM-agent registration, ProjectData ACP session transitions, MCP token minting, and VM-agent start.
- `buildTaskInitialPrompt()` appends the only SAM bootstrap reminder string. Instant sessions do not use it.
- `apps/api/src/services/instant-session.ts` duplicates much of the agent-session start sequence after container/workspace setup but sends `input.initialPrompt` unchanged.
- Instant sessions store taskless MCP token data with `taskId: ''`, `chatSessionId`, and `agentSessionId`.
- `apps/api/src/routes/mcp/instruction-tools.ts` queries `tasks` by `tokenData.taskId` before resolving project or knowledge/policy, so taskless tokens receive `Task not found`.
- `apps/api/src/routes/mcp/task-tools.ts` has the same task-row assumption for `update_task_status`; conversation instructions currently advertise the tool even though taskless calls fail.
- `apps/api/src/routes/workspaces/agent-sessions.ts` creates another taskless direct-workspace token shape.
- `apps/api/src/durable-objects/trial-orchestrator/steps.ts` currently uses a synthetic taskId for trial tokens; the new resolver should support explicit `trial` context without forcing fake task rows.
- `apps/api/src/services/node-agent.ts` should remain a low-level VM-agent transport client. SAM bootstrap policy belongs in Worker/control-plane services.
- Tests exist under `apps/api/tests/unit/services/instant-session.test.ts`, `apps/api/tests/unit/services/task-runner*.test.ts`, `apps/api/tests/unit/services/mcp-token*.test.ts`, and Worker/service tests can mock D1, KV, ProjectData DO, and VM-agent HTTP boundaries.

## Implementation Checklist

- [x] Create `apps/api/src/services/agent-bootstrap-prompt.ts` with shared visible-prompt and SAM bootstrap prompt helpers.
- [x] Update TaskRunner prompt construction to use the shared prompt builder while preserving current combined prompt output.
- [x] Extend `McpTokenData` with optional `contextType: 'task' | 'conversation' | 'trial' | 'direct-workspace'` and optional `taskMode`, preserving legacy token compatibility.
- [x] Refactor `handleGetInstructions()` into context resolution plus payload building.
- [x] Implement `resolveInstructionContext()` for:
  - [x] task tokens with a real task row;
  - [x] conversation tokens resolved from `projectId`, `chatSessionId`, `workspaceId`, and `agentSessionId`;
  - [x] trial tokens without a task row;
  - [x] direct-workspace tokens without a task row;
  - [x] malformed taskless tokens that fail closed.
- [x] Ensure knowledge and policy directives are retrieved for both task-backed and taskless project contexts.
- [x] Make `handleUpdateTaskStatus()` graceful for taskless session contexts by recording a ProjectData activity/progress event where possible instead of returning `Task not found`.
- [x] Create `apps/api/src/services/agent-session-bootstrap.ts` with `SamAwareAgentStartInput`, `SamAwareAgentStartResult`, and `startSamAwareAgentSession()`.
- [x] Move shared D1 agent session row creation/reuse, MCP token mint/reuse/store, VM-agent session registration, ProjectData ACP creation/transitions, prompt building, and VM-agent start into the bootstrap service.
- [x] Update TaskRunner agent-session step to call `startSamAwareAgentSession()` using existing step-state IDs/tokens for retry idempotency.
- [x] Update `launchInstantSession()` to call `startSamAwareAgentSession()` after container launch, readiness, and lightweight workspace creation, preserving `runContainerPhase()` timing hooks.
- [x] Do not create fake task rows and do not move SAM instruction policy into vm-agent.
- [x] Add unit tests proving TaskRunner prompt output remains compatible.
- [x] Add behavioral tests for each instruction context branch and malformed taskless token failure.
- [x] Add taskless `update_task_status` tests.
- [x] Add a vertical-slice instant-session test proving the VM-agent start payload includes the shared bootstrap reminder and a taskless token can successfully call `get_instructions`.

## Acceptance Criteria

- [x] Instant `cf-container` sessions receive the same SAM bootstrap instruction contract as TaskRunner task sessions.
- [x] An instant session agent can call `get_instructions` successfully even with no task row.
- [x] TaskRunner task sessions preserve current behavior and retry idempotency.
- [x] Runtime provisioning remains separate from Worker/control-plane agent bootstrap policy.
- [x] Prompt strings are not copied across TaskRunner and instant-session paths.
- [x] `node-agent.ts` remains a transport client, not a SAM policy owner.
- [x] Automated tests cover task-backed and taskless context resolution, taskless status updates, and instant-session start payload behavior.
- [x] Staging verification starts a real instant `cf-container` session and confirms `get_instructions` succeeds with project knowledge/policies and no `Task not found`.

## Validation Evidence

- Local validation: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passed.
- Targeted API validation: `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/task-runner-agent-session.test.ts tests/unit/cf-container-runtime-contract.test.ts tests/unit/durable-objects/trial-orchestrator-agent-boot.test.ts tests/unit/routes/mcp-instruction-context.test.ts` passed.
- Staging deploy coordination: waited for concurrent staging run `29116157441`, then redeployed this branch in run `29116784175`; deploy and smoke tests passed.
- Pre-verification branch check: latest successful `deploy-staging.yml` run was `29116784175` for `sam/implement-sam-idea-01kx4hff2y66rw1v7tvv1ztp7x-zmesab`.
- Live staging verification: started real instant `cf-container` session `151ac3ae-7e14-464f-8271-78b19b692f1d` in project `hono` with runtime `cf-container`; verifier observed marker `SAM_BOOTSTRAP_GET_INSTRUCTIONS_OK_1783710982052`, `hasTaskNotFound=false`, `hasKnowledgeEvidence=true`, and `hasPolicyEvidence=true`.
- Evidence artifacts: `apps/web/.codex/tmp/staging-evidence/sam-bootstrap-151ac3ae-7e14-464f-8271-78b19b692f1d.json` and `.png` were generated locally and left ignored.

## Task Completion Validation Report

**Task**: `tasks/archive/2026-07-10-unify-sam-aware-acp-bootstrap.md`  
**Branch**: `sam/implement-sam-idea-01kx4hff2y66rw1v7tvv1ztp7x-zmesab`  
**Date**: 2026-07-10

### Verdict: PASS

| Check | Status | Issues |
|-------|--------|--------|
| A: Research -> Checklist | PASS | 0 findings without checklist items |
| B: Checklist -> Diff | PASS | 0 checked items missing from diff |
| C: Criteria -> Tests | PASS | 0 criteria without test or manual verification |
| D: UI -> Backend | N/A | No UI input changes |
| E: Multi-Resource | N/A | No provider/resource selection change |
| F: Vertical Slice | PASS | Instant-session start payload and live staging flow verified |

### Notes

- The diff covers TaskRunner, instant-session, MCP token metadata, `get_instructions`, `update_task_status`, direct-workspace and trial token writers, shared prompt/bootstrap services, and focused tests.
- Unit tests cover all resolver context branches and taskless status updates. Instant-session tests assert the shared bootstrap prompt and taskless MCP token context.
- Live staging verification covers the full production-like path from API session start through cf-container runtime, ACP/agent session bootstrap, taskless MCP `get_instructions`, and project knowledge/policy response.

## References

- SAM idea `01KX4HFF2Y66RW1V7TVV1ZTP7X`.
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/32-cf-api-debugging.md`
- `.claude/rules/35-vertical-slice-testing.md`
