# W3: operations package and shared tool logic

Workstream W3 of `tasks/active/2026-11-12-worker-modularization.md` (core branch
`sam/help-identify-parts-worker-embcza`, coordinator task `01M77BJHHNW5714E98DEEMBCZA`).
SAM task `01M77GDY92WVEJAYW63F4TSC50`, branch `sam/w3-operations-turn-shared-4tsc50`.

## Goal

1. `apps/api/src/operations/**` becomes `packages/operations`
   (`@simple-agent-manager/operations`) with a narrow `OperationsEnv` and small
   injected ports for what it needs from the worker.
2. Tool logic duplicated between `routes/mcp` and `durable-objects/sam-session`
   moves onto shared operations so both surfaces call one function. Tool names,
   inputs, outputs, authorization and limits do not change.

## Baseline (core `bbb1c82ca`)

- `apps/api` `vitest list`: 16,012 cases in 1,084 files.
- `apps/api/tests/unit/operations`: 318 cases in 17 files.

## Plan

- [x] Step 1a: narrow `OperationsEnv`; `OperationContext.env` uses it
- [x] Step 1b: ports interface (`OperationPorts`) for worker-owned services; worker wiring in one place (`apps/api/src/operation-ports.ts`)
- [ ] Step 1c: operations import nothing from `routes/`, `durable-objects/`, `services/` except through ports
- [ ] Step 1d: move clearest sam-session / MCP duplicates onto shared functions
- [ ] Step 2: lift into `packages/operations` once W0 is ready (channel "W0 ready")
- [ ] Test counts before/after recorded; local gates; CI via `gh workflow run ci.yml`
- [ ] Specialist reviews; publish PR URL + head SHA on channel and to coordinator

## Progress log

- 2026-11-12: branch created from core `bbb1c82ca`; baseline counts recorded.
- 2026-11-12: step 1a/1b pushed. `OperationContext` = `OperationDeps` (`env: OperationsEnv`, `ports: OperationPorts`) + actor.
  Worker builds ports with `createOperationPorts(env)`; `operationDeps(env)` for helper calls outside a context;
  `webOperationContext` moved to `operation-ports.ts`; workspace JSON-RPC adapter moved to
  `routes/mcp/workspace-operation-adapter.ts`. Port signatures are still derived from worker modules via type-only
  imports (step 2 replaces them with declared types). Remaining runtime imports from the worker are pure helpers
  (route-helpers, sanitize, search-query-limits, utf8, message-roles, task-status, session-idleness, trigger-status,
  cron-utils, project-events error classes, agent-message-notice, ConnectorAnswerFields) -> step 2.
