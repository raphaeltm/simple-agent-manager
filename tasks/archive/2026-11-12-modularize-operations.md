# W3: operations package and shared tool logic

Workstream W3 of `tasks/archive/2026-11-12-worker-modularization.md` (core branch
`sam/help-identify-parts-worker-embcza`, coordinator task `01M77BJHHNW5714E98DEEMBCZA`).
SAM task `01M77GDY92WVEJAYW63F4TSC50`, branch `sam/w3-operations-turn-shared-4tsc50`, draft PR #2685.

## Goal

1. `apps/api/src/operations/**` becomes `packages/operations`
   (`@simple-agent-manager/operations`) with a narrow `OperationsEnv` and small
   injected ports for what it needs from the worker.
2. Tool logic duplicated between `routes/mcp` and `durable-objects/sam-session`
   moves onto shared operations so both surfaces call one function. Tool names,
   inputs, outputs, authorization and limits do not change.

## Status

- [x] Narrow `OperationsEnv` (`packages/operations/src/env.ts`); the worker `Env` extends it and no
      longer redeclares its fields (except `DATABASE`, which the whole worker uses).
- [x] Ports: `ports.ts`, `project-data-port.ts`, value shapes in `port-types.ts` (each mirrors the
      worker type it names). Implemented once by the worker in `apps/api/src/operation-ports.ts`
      (`createOperationPorts(env)`, `operationDeps(env)`, `webOperationContext`). Groups: config,
      projectData, settings, access, connector, chat, tasks, triggers, account, workspaces, missions.
- [x] Operations import nothing from the worker; only `@simple-agent-manager/shared`,
      `@simple-agent-manager/worker-core`, drizzle-orm, valibot, `@valibot/to-json-schema`.
- [x] Shared tool cores (both the workspace `sam-mcp` handler and the /sam tool call them; the
      project agent reuses the /sam tools). Surface-specific authorization, parsing, wording and
      output stay in the adapters:
  - `workspace-history.ts`: `readArchivedToolPayloads` (get_archived_tool_payloads),
    `readResourceHistory` (get_resource_history).
  - `session-list.ts`: `listSessionSummaries` (list_sessions).
  - `missions.ts`: `missionTextLimits`, `createMissionRecord` (create_mission).
  - Parity test: `apps/api/tests/unit/operations/shared-tool-cores.test.ts` (10 cases, drives both
    real handlers, discriminating).
- [x] Lifted into `packages/operations` following the W0 template; public entry `src/index.ts`;
      test-only `./internal/*` entry for apps/api tests that mock one operations module (generic
      lint rule `packageInternalPath` in `eslint.config.mjs`, proven in
      `scripts/quality/worker-module-boundaries.test.ts`).
- [x] Wiring: apps/api dependency, `@valibot/to-json-schema` in the pnpm catalog, CI (`api`, `cli`)
      and e2e-smoke path filters, runtime-boundary scan, AST checks, node-pool boundary scanner
      roots and inventory, build order in `local-development.md`, path references in backlog tasks
      and a blog link.
- [x] Worker-owned glue moved out of the package: workspace JSON-RPC adapter
      (`apps/api/src/routes/mcp/workspace-operation-adapter.ts`), `webOperationContext`.
- [x] Helpers only operations need moved into the package with re-export files at the old paths
      (template decision 1): sanitize-user-input, utf8, message-roles, idea-content-limit,
      operation-effect-boundary, connector-limits, connector-read-settings-definition,
      message-groups; `ConnectorAnswerFields` became `connector-answer-input.ts`.
- [x] Reviews: architecture (no CRITICAL/HIGH; MEDIUMs addressed), security (no CRITICAL/HIGH/MEDIUM),
      task-completion (no CRITICAL/HIGH; this note was its MEDIUM).

## Remaining duplicates (not moved in this PR)

- get_session_messages / search_task_messages vs `readChat` / `searchChats` (role handling differs).
- add_knowledge / get_project_knowledge, list_policies / add_policy.
- get_task_details / search_tasks (scope: owner join vs token project).
- get_mission summary; pause/resume/cancel_mission (thin).
- stop_subtask cancel-and-finalize step; retry_subtask / dispatch_task pipelines.
- list_ideas / find_related_ideas: /sam `list_ideas` has no `is_idea` filter and
  `find_related_ideas` searches every status, so sharing them changes one surface. Needs a decision.

## Known nuances

- /sam archived-payload limits now parse their env vars with `parsePositiveInt` (as MCP did) instead
  of a local `isSafeInteger` variant; identical for any sane value.
- Importing `operation-ports.ts` loads every port's worker module, so a test that imports a module
  depending on it pays that cost (test-only; the deployed Worker is one bundle).

## Test counts

- Baseline (core `bbb1c82ca`): apps/api 16,012 cases / 1,084 files; `tests/unit/operations` 318 / 17.
- After: see the PR body (filled from the final full run).
