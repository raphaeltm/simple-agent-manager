# Implementation Plan: Projects and Tasks Foundation MVP

**Branch**: `016-mvp-project-and` | **Date**: 2026-02-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/016-mvp-project-and/spec.md`

## Summary

Implement the Phase 1 orchestration foundation from the design vision: make GitHub repositories first-class Project entities and add project-scoped Task management with dependency DAG constraints. MVP scope remains intentionally narrow:

- Project CRUD + repository linkage (single primary repository per project)
- Task CRUD + lifecycle + dependency management
- Manual task delegation to existing workspaces (no automated scheduler/orchestrator)
- Ownership-first access control and callback-safe status updates

Web research informs two key MVP choices:
- Keep SAM task/project state as system-of-record before external sync automation.
- Model dependencies as explicit edges with cycle prevention and blocked-state gating.

## Technical Context

**Language/Version**: TypeScript 5.x (API + Web)
**Primary Dependencies**: Hono (API), Drizzle ORM + D1 (data layer), React 18 + Vite (Web), BetterAuth (auth)
**Storage**: Cloudflare D1 (new project/task tables), existing KV/R2 unchanged for this feature
**Testing**: Vitest + Miniflare (API), Vitest + React Testing Library (Web)
**Target Platform**: Cloudflare Workers (API), Cloudflare Pages (Web)
**Project Type**: Web monorepo (`apps/api`, `apps/web`, `packages/shared`)
**Performance Goals**: Meet spec success criteria (project list/detail P95 < 500ms, task CRUD P95 < 300ms under normal load)
**Constraints**:
- Preserve current single-user ownership model
- Preserve existing workspace lifecycle behavior
- No hardcoded internal URLs/timeouts/limits (Constitution Principle XI)
- Error format stays `{ error, message }`
**Scale/Scope**:
- MVP: one repository reference per project
- Target usage: dozens of projects/user, hundreds of tasks/project (bounded by configurable limits)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source Sustainability | PASS | Core planning/workflow capabilities remain OSS |
| II. Infrastructure Stability | PASS | Critical path tests required for lifecycle transitions, dependency validation, ownership checks |
| III. Documentation Excellence | PASS | `/speckit.plan` artifacts generated in this directory |
| IV. Approachable Code & UX | PASS | Workspace-first UX evolves to project-first without removing current flows |
| V. Transparent Roadmap | PASS | Feature spec + plan under `specs/016-mvp-project-and/` |
| VI. Automated Quality Gates | PASS | Implementation will use existing lint/typecheck/test/build pipelines |
| VII. Inclusive Contribution | N/A | No contribution-process changes in this feature |
| VIII. AI-Friendly Repository | PASS | New concepts explicitly documented as structured entities/contracts |
| IX. Clean Code Architecture | PASS | Changes remain within existing package boundaries |
| X. Simplicity & Clarity | PASS | Manual delegation bridge first; orchestration automation deferred |
| XI. No Hardcoded Values | PASS | New limits/timeouts planned as env-configurable with defaults |

**Principle XI planned configuration additions** (names finalized during implementation):
- `MAX_PROJECTS_PER_USER`
- `MAX_TASKS_PER_PROJECT`
- `MAX_TASK_DEPENDENCIES_PER_TASK`
- `TASK_CALLBACK_TIMEOUT_MS`
- `TASK_CALLBACK_RETRY_MAX_ATTEMPTS`

**Gate Result**: PASS.

## Project Structure

### Documentation (this feature)

```text
specs/016-mvp-project-and/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── api.yaml
└── tasks.md             # Created by /speckit.tasks (not by /speckit.plan)
```

### Source Code (repository root)

```text
apps/
├── api/
│   ├── src/
│   │   ├── db/
│   │   │   ├── schema.ts
│   │   │   └── migrations/
│   │   ├── routes/
│   │   │   ├── projects.ts          # NEW
│   │   │   └── tasks.ts             # NEW (or nested in projects route)
│   │   ├── services/
│   │   │   └── task-graph.ts        # NEW (cycle detection + blocked evaluation)
│   │   └── index.ts                 # register routes + Env additions
│   └── tests/
│       └── integration/
├── web/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Projects.tsx         # NEW
│   │   │   └── Project.tsx          # NEW
│   │   ├── components/
│   │   │   └── project/             # NEW: task list/board/forms
│   │   └── lib/api.ts               # project/task client methods
│   └── tests/
│       └── unit/

packages/
└── shared/
    └── src/
        └── types.ts                 # Project/Task/Dependency types
```

**Structure Decision**: This feature is an API + Web + shared-types enhancement with no new deployable components.

## Complexity Tracking

No constitution violations requiring justification were identified for this planning phase.

## Phase 0: Research Plan (Output: `research.md`)

Research questions:
1. What project/task concepts from GitHub Projects and Issues should influence MVP fields and workflows?
2. What dependency modeling patterns (sub-item vs dependency edge) are practical for MVP?
3. What API/auth constraints affect near-term external sync options?
4. What scaling risks (too many links, cyclic links) should drive validation and configurable limits?

Primary sources:
- GitHub Docs (Projects, issue dependencies, sub-issues, REST API auth)
- Linear Docs (issue relations/dependencies)
- Atlassian Jira support docs (issue links, cyclic/overlinked issue risks)

## Phase 1: Design & Contracts (Outputs in this directory)

Design deliverables:
- `data-model.md`: entities, relationships, state machine, validation rules, configurable limits
- `contracts/api.yaml`: Project + Task + dependency + manual-delegation endpoints
- `quickstart.md`: implementation phases, key files, testing strategy

Design guardrails:
- Project and task ownership must be enforced on every route.
- Task dependencies are project-scoped only.
- Cycle detection and blocked-state gating are server-side invariants.
- Existing workspace APIs remain source of execution runtime in MVP.

## Phase 2: Stop Point

This `/speckit.plan` run ends after creating:
- `research.md`
- `data-model.md`
- `quickstart.md`
- `contracts/api.yaml`

Task breakdown and execution sequencing are deferred to `/speckit.tasks`.
