# Track D: SAM Integration Design and Feature-Flagged Vertical Slice

**Created:** 2026-05-02
**Parent Idea:** 01KQM8JT6CPHGS16Y91XJF67FS
**Branch:** sam/execute-task-using-skill-01kqmh

## Problem Statement

The first-wave prototypes (Go harness, AI Gateway tool-call experiment, Sandbox SDK) produced concrete evidence about what works. Track D synthesizes these into a formal integration design and, where safe, a first feature-flagged vertical slice.

**Goal:** Produce a concrete integration design document that lives in the repo, bridging the prototype evidence to SAM's production architecture. If code is added, it must be behind `SANDBOX_ENABLED` + admin gate.

## Research Findings

### From the Prototypes (PR #880, this branch)

1. **Go harness (`packages/harness/`)**: 28 tests passing. Core loop (think→act→observe), 4 tools (read, write, edit, bash), mock provider, transcript, CLI. Clean-room architecture.

2. **AI Gateway experiment (`experiments/ai-gateway-tool-call/`)**: Workers AI Qwen 2.5 Coder does structured tool calls with `tool_choice: "required"`. `content: null` → `""` workaround needed. Model registry extended with capability metadata (`toolCallSupport`, `intendedRole`, `allowedScopes`, `unifiedApiModelId`).

3. **Sandbox SDK prototype (`apps/api/src/routes/admin-sandbox.ts`)**:
   - Cold start: ~2.7s server-side / 4.4s wall
   - Warm exec: 37-48ms server / ~1s wall
   - File I/O: 32-37ms server
   - Git clone (240 files): 742ms server
   - Streaming: ~855ms wall, ~200ms first byte
   - Backup/restore: FAILED (internal beta error)
   - Must use `docker.io/cloudflare/sandbox:0.9.2` base image
   - `SANDBOX_ENABLED` kill switch, admin-only, already on staging

### From Architecture Analysis (`.library/05-sam-architecture-gaps.md`)

- 5 external agent types, all black-box proprietary binaries
- 3-tier credential resolution (project → user → platform)
- Agent profiles resolve: explicit → profile → project default → platform default
- SamSession DO (Mastra), ProjectOrchestrator DO (rule-based), VM Agent (Go)
- MCP tools: 40+ tools for knowledge, dispatch, policies, ideas, etc.

### From Knowledge Graph

- Architecture preference: Sandbox SDK targets top-level/project-level SAM agents, NOT replacing task workspace agents
- Preference: one agent per workspace
- Code quality: Valibot over Zod for validation
- Constitution: no hardcoded values

## Integration Design

The design document will be placed at `docs/architecture/agent-harness-integration.md` and cover:

1. **Runtime Selection** — How the system decides between Sandbox SDK (project/SAM agents) vs VM (workspace agents) vs CLI (local dev)
2. **Data Flow** — From user message through SamSession/ProjectAgent DO → Sandbox SDK → exec/files → streaming response
3. **Feature Flags** — `SANDBOX_ENABLED` + admin gate for all new paths
4. **Auth/Credential Flow** — How AI Gateway credentials and MCP tokens flow to sandbox-based agents
5. **Model Routing** — Using `PlatformAIModel.unifiedApiModelId` for path selection
6. **Tool Execution** — Sandbox SDK as the I/O layer for coding tools
7. **Event Streaming** — SSE from sandbox exec to project chat UI
8. **Rollback** — Kill switch disables all sandbox paths; existing agents unaffected
9. **Backup/Restore Exclusion** — Why and when to revisit

## Implementation Checklist

- [x] Read and synthesize all library research docs
- [x] Read prototype code on this branch (harness, sandbox routes, AI Gateway experiment)
- [x] Review existing architecture (agents.ts, model registry, task runner, sandbox routes)
- [ ] Write integration design document (`docs/architecture/agent-harness-integration.md`)
- [ ] Add `SandboxAgentRuntime` type to shared constants (not a new AgentType — keeps existing paths clean)
- [ ] Add `HARNESS_AGENT_ENABLED` env var to Env type (feature flag for the harness agent type)
- [ ] Write unit test for model registry capability filtering (toolCallSupport ≥ 'good' for agent loops)
- [ ] Update CLAUDE.md Recent Changes section with Track D summary
- [ ] Verify lint/typecheck/test/build pass

## Acceptance Criteria

- [ ] Integration design document exists at `docs/architecture/agent-harness-integration.md`
- [ ] Document describes runtime selection, data flow, feature flags, auth, model routing, tool execution, event streaming, and rollback
- [ ] Document explicitly states why backup/restore is excluded from production path
- [ ] Track E can use the output for go/no-go evaluation
- [ ] If code is added, it is behind explicit flag/admin gate
- [ ] Existing production user paths remain unchanged
- [ ] All quality gates pass (lint, typecheck, test, build)

## References

- PR #880 (prototype outputs)
- Library docs: `03-cloudflare-containers-research.md`, `04-multi-model-ai-gateway.md`, `05-sam-architecture-gaps.md`, `08-recommendation-and-action-plan.md`
- `docs/notes/2026-05-02-cloudflare-sandbox-prototype-recommendation.md`
- `experiments/ai-gateway-tool-call/FINDINGS.md`
- `packages/shared/src/constants/ai-services.ts` (model registry)
- `packages/shared/src/agents.ts` (agent type definitions)
