# Tasks: Projects and Tasks Foundation MVP

**Input**: Design documents from `/specs/016-mvp-project-and/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/api.yaml`, `quickstart.md`

**Tests**: Tests are required for new behavior in this repository (see `AGENTS.md` Principle II and testing gate). Tasks below include API + UI tests per story.

**Organization**: Tasks are grouped by user story to preserve independent delivery and validation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency coupling)
- **[Story]**: User story label (US1, US2, US3, US4)
- Include exact file paths in task descriptions

## Path Conventions

- **Control Plane API**: `apps/api/src/`
- **Web UI**: `apps/web/src/`
- **Shared Types/Constants**: `packages/shared/src/`
- **API Tests**: `apps/api/tests/unit/` and `apps/api/tests/integration/`
- **Web Tests**: `apps/web/tests/unit/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Shared schema/types/config scaffolding used by all user stories.

- [x] T001 Add `Project`, `Task`, `TaskDependency`, `TaskStatusEvent`, request/response interfaces, and filter/sort types in `packages/shared/src/types.ts`
- [x] T002 [P] Export new shared types in `packages/shared/src/index.ts`
- [x] T003 [P] Add default project/task runtime limits in `packages/shared/src/constants.ts`
- [x] T004 Add D1 migration for project/task model tables and indexes in `apps/api/src/db/migrations/0011_projects_tasks_foundation.sql`
- [x] T005 Update Drizzle schema with `projects`, `tasks`, `task_dependencies`, `task_status_events` tables and indexes in `apps/api/src/db/schema.ts`
- [x] T006 Add new env vars to API bindings in `apps/api/src/index.ts` (`MAX_PROJECTS_PER_USER`, `MAX_TASKS_PER_PROJECT`, `MAX_TASK_DEPENDENCIES_PER_TASK`, `TASK_LIST_DEFAULT_PAGE_SIZE`, `TASK_LIST_MAX_PAGE_SIZE`, `TASK_CALLBACK_TIMEOUT_MS`, `TASK_CALLBACK_RETRY_MAX_ATTEMPTS`)
- [x] T007 Extend `apps/api/src/services/limits.ts` to parse and expose project/task limits with shared defaults
- [x] T008 Register new route modules in `apps/api/src/index.ts` (`/api/projects`, project-scoped task routes)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core business-rule services and route scaffolding that every story depends on.

**CRITICAL**: No user story implementation should start before this phase is complete.

- [x] T009 Create route scaffold for projects in `apps/api/src/routes/projects.ts`
- [x] T010 Create route scaffold for tasks/dependencies/delegation in `apps/api/src/routes/tasks.ts`
- [x] T011 Implement task status transition matrix helper in `apps/api/src/services/task-status.ts`
- [x] T012 Implement task graph service (cycle detection + blocked evaluation) in `apps/api/src/services/task-graph.ts`
- [x] T013 [P] Add unit tests for status transition service in `apps/api/tests/unit/services/task-status.test.ts`
- [x] T014 [P] Add unit tests for task graph service (self-edge, cycle, unblocked) in `apps/api/tests/unit/services/task-graph.test.ts`
- [x] T015 Add shared route-level ownership helper utilities for project/task resources in `apps/api/src/middleware/project-auth.ts`

**Checkpoint**: Project/task infrastructure exists and core rule engines are tested.

---

## Phase 3: User Story 1 - Create and Manage Projects as the Primary Unit (Priority: P1) 🎯 MVP

**Goal**: Users can create/list/view/update/delete repository-backed projects they own.

**Independent Test**: Create a project from an accessible installation repository, verify it appears in projects list/detail, and update metadata.

### Tests for User Story 1

- [x] T016 [P] [US1] Add API tests for project CRUD ownership and visibility in `apps/api/tests/unit/routes/projects.test.ts`
- [x] T017 [P] [US1] Add API tests for installation/repository access validation at create/update in `apps/api/tests/unit/routes/projects.test.ts`
- [x] T018 [P] [US1] Add web page tests for projects listing and project detail rendering in `apps/web/tests/unit/pages/projects.test.tsx` and `apps/web/tests/unit/pages/project.test.tsx`

### Implementation for User Story 1

- [x] T019 [US1] Implement `POST /api/projects` with normalized name uniqueness + installation ownership checks in `apps/api/src/routes/projects.ts`
- [x] T020 [US1] Implement `GET /api/projects` with pagination and owner-scoped filtering in `apps/api/src/routes/projects.ts`
- [x] T021 [US1] Implement `GET /api/projects/:id` with summary fields (task counts, linked workspaces count) in `apps/api/src/routes/projects.ts`
- [x] T022 [US1] Implement `PATCH /api/projects/:id` and `DELETE /api/projects/:id` in `apps/api/src/routes/projects.ts`
- [x] T023 [US1] Add project client methods (`listProjects`, `createProject`, `getProject`, `updateProject`, `deleteProject`) in `apps/web/src/lib/api.ts`
- [x] T024 [US1] Create projects list page in `apps/web/src/pages/Projects.tsx`
- [x] T025 [US1] Create project detail page shell in `apps/web/src/pages/Project.tsx`
- [x] T026 [US1] Add project routes in `apps/web/src/App.tsx` (`/projects`, `/projects/:id`)
- [x] T027 [US1] Add project navigation entry in `apps/web/src/components/UserMenu.tsx` and/or `apps/web/src/pages/Dashboard.tsx`
- [x] T028 [US1] Add project create/edit form component in `apps/web/src/components/project/ProjectForm.tsx`

**Checkpoint**: Project primitive is functional and independently usable.

---

## Phase 4: User Story 2 - Build and Triage a Project Task Backlog (Priority: P1)

**Goal**: Users can create/edit/list/filter/sort tasks and move through supported lifecycle states.

**Independent Test**: Create multiple tasks in a project, edit and reprioritize them, apply filters/sorts, transition `draft -> ready`.

### Tests for User Story 2

- [x] T029 [P] [US2] Add API tests for task CRUD, list/filter/sort, and ownership checks in `apps/api/tests/unit/routes/tasks.test.ts`
- [x] T030 [P] [US2] Add API tests for valid/invalid status transitions in `apps/api/tests/unit/routes/tasks.test.ts`
- [x] T031 [P] [US2] Add UI tests for task list/create/edit/filter/sort behavior in `apps/web/tests/unit/components/project/task-list.test.tsx` and `apps/web/tests/unit/pages/project.test.tsx`

### Implementation for User Story 2

- [x] T032 [US2] Implement `POST /api/projects/:projectId/tasks` and `GET /api/projects/:projectId/tasks` in `apps/api/src/routes/tasks.ts`
- [x] T033 [US2] Implement `GET/PATCH/DELETE /api/projects/:projectId/tasks/:taskId` in `apps/api/src/routes/tasks.ts`
- [x] T034 [US2] Implement `POST /api/projects/:projectId/tasks/:taskId/status` with transition validation in `apps/api/src/routes/tasks.ts`
- [x] T035 [US2] Persist status transitions as append-only events in `apps/api/src/routes/tasks.ts` and `apps/api/src/db/schema.ts` usage
- [x] T036 [US2] Add task API client methods in `apps/web/src/lib/api.ts`
- [x] T037 [US2] Create task form component in `apps/web/src/components/project/TaskForm.tsx`
- [x] T038 [US2] Create task list + filters components in `apps/web/src/components/project/TaskList.tsx` and `apps/web/src/components/project/TaskFilters.tsx`
- [x] T039 [US2] Integrate task backlog components into `apps/web/src/pages/Project.tsx`
- [x] T040 [US2] Add URL query-state syncing for task filters/sort in `apps/web/src/pages/Project.tsx`

**Checkpoint**: Task backlog is independently usable for planning without dependency/delegation features.

---

## Phase 5: User Story 3 - Model Task Dependencies Safely (Priority: P1)

**Goal**: Users can add/remove dependency edges, with DAG enforcement and blocked-state gating.

**Independent Test**: Add dependency edges, attempt cycle creation, and verify blocked tasks cannot enter executable states.

### Tests for User Story 3

- [x] T041 [P] [US3] Add API tests for dependency add/remove, self-edge rejection, cross-project rejection, and cycle rejection in `apps/api/tests/unit/routes/tasks.test.ts`
- [x] T042 [P] [US3] Add API tests verifying blocked tasks cannot transition to `queued`, `delegated`, `in_progress` in `apps/api/tests/unit/routes/tasks.test.ts`
- [x] T043 [P] [US3] Add UI tests for dependency editor interactions and blocked badges in `apps/web/tests/unit/components/project/task-dependencies.test.tsx`

### Implementation for User Story 3

- [x] T044 [US3] Implement `POST/DELETE /api/projects/:projectId/tasks/:taskId/dependencies` in `apps/api/src/routes/tasks.ts`
- [x] T045 [US3] Implement dependency projection in task detail (`GET /api/projects/:projectId/tasks/:taskId`) in `apps/api/src/routes/tasks.ts`
- [x] T046 [US3] Enforce blocked-state transition guard in status transition flow in `apps/api/src/routes/tasks.ts`
- [x] T047 [US3] Add dependency graph validation integration with `task-graph.ts` service in `apps/api/src/routes/tasks.ts`
- [x] T048 [US3] Create dependency editor component in `apps/web/src/components/project/TaskDependencyEditor.tsx`
- [x] T049 [US3] Show blocked/dependency metadata in task cards/rows in `apps/web/src/components/project/TaskList.tsx`
- [x] T050 [US3] Wire dependency editor into `apps/web/src/pages/Project.tsx`

**Checkpoint**: Dependency-safe planning is independently functional.

---

## Phase 6: User Story 4 - Manually Delegate a Task to a Workspace (Priority: P2)

**Goal**: Users can delegate ready+unblocked tasks to owned running workspaces and track execution metadata.

**Independent Test**: Delegate a task to a running workspace, update status via callback path, and view output summary/branch/PR URL in task detail.

### Tests for User Story 4

- [x] T051 [P] [US4] Add API tests for manual delegation eligibility (status, blocked, workspace ownership/running-state) in `apps/api/tests/unit/routes/tasks.test.ts`
- [x] T052 [P] [US4] Add API tests for trusted callback status update path and metadata persistence in `apps/api/tests/unit/routes/tasks.test.ts`
- [x] T053 [P] [US4] Add UI tests for delegate dialog/workspace picker and status/output rendering in `apps/web/tests/unit/components/project/task-delegate.test.tsx` and `apps/web/tests/unit/pages/project.test.tsx`

### Implementation for User Story 4

- [x] T054 [US4] Implement `POST /api/projects/:projectId/tasks/:taskId/delegate` in `apps/api/src/routes/tasks.ts`
- [x] T055 [US4] Add workspace eligibility checks using existing workspace data (`running`, ownership) in `apps/api/src/routes/tasks.ts`
- [x] T056 [US4] Implement callback-capable status update endpoint for delegated tasks in `apps/api/src/routes/tasks.ts`
- [x] T057 [US4] Persist execution metadata fields (`startedAt`, `completedAt`, `errorMessage`, `outputSummary`, `outputBranch`, `outputPrUrl`) in `apps/api/src/routes/tasks.ts`
- [x] T058 [US4] Add delegation + task-event client methods in `apps/web/src/lib/api.ts`
- [x] T059 [US4] Build task delegation dialog component with workspace picker in `apps/web/src/components/project/TaskDelegateDialog.tsx`
- [x] T060 [US4] Add task output metadata section in `apps/web/src/components/project/TaskDetailPanel.tsx`
- [x] T061 [US4] Integrate delegation and detail panel into `apps/web/src/pages/Project.tsx`

**Checkpoint**: Manual delegation bridge to existing runtime is independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation sync, mobile verification, and full quality gates.

- [x] T062 [P] Update API endpoint and env-var documentation in `AGENTS.md` and `CLAUDE.md` for new project/task surfaces and limits
- [x] T063 [P] Update `apps/api/.env.example` with new project/task limit and callback timeout variables
- [x] T064 [P] Update feature docs for final contract alignment in `specs/016-mvp-project-and/contracts/api.yaml`, `specs/016-mvp-project-and/quickstart.md`, and `specs/016-mvp-project-and/data-model.md`
- [x] T065 Run API tests for impacted modules (`pnpm --filter @simple-agent-manager/api test`) and fix regressions
- [x] T066 Run web tests for impacted modules (`pnpm --filter @simple-agent-manager/web test`) and fix regressions
- [x] T067 Run repository quality gates (`pnpm typecheck`, `pnpm lint`, `pnpm build`) and fix issues
- [x] T068 Perform required mobile viewport verification for new project/task UI with Playwright and store screenshots under `.codex/tmp/playwright-screenshots/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Phase 1.
- **User Stories (Phases 3-6)**: Depend on Phase 2.
- **Polish (Phase 7)**: Depends on all selected story work.

### User Story Dependencies

- **US1 (Projects)**: No dependency on other stories after Phase 2.
- **US2 (Task Backlog)**: Depends on US1 project routes/pages being present.
- **US3 (Dependencies)**: Depends on US2 task lifecycle CRUD.
- **US4 (Manual Delegation)**: Depends on US2 + US3 (`ready` + unblocked gating).

### Within Each Story

- Tests should be written/updated before implementation changes in that story.
- API contract and service logic before UI integration.
- Core implementation before polish/telemetry/docs.

### Parallel Opportunities

- Setup tasks marked **[P]** can run in parallel.
- Service-level tests and UI tests in each story marked **[P]** can run in parallel.
- API and UI implementation tasks for a story can run in parallel once route contracts are stable.

---

## Parallel Examples

### US1

```bash
Task T016: API project CRUD tests in apps/api/tests/unit/routes/projects.test.ts
Task T018: Web page tests in apps/web/tests/unit/pages/projects.test.tsx and apps/web/tests/unit/pages/project.test.tsx
Task T024: Projects page implementation in apps/web/src/pages/Projects.tsx
```

### US3

```bash
Task T041: Dependency API rule tests in apps/api/tests/unit/routes/tasks.test.ts
Task T043: Dependency editor UI tests in apps/web/tests/unit/components/project/task-dependencies.test.tsx
Task T048: Dependency editor implementation in apps/web/src/components/project/TaskDependencyEditor.tsx
```

---

## Implementation Strategy

### MVP First (US1 + US2 + US3)

1. Complete Phase 1 + Phase 2.
2. Deliver US1 (projects).
3. Deliver US2 (task backlog).
4. Deliver US3 (dependency safety).
5. Validate planning-only workflow end-to-end.

### Incremental Delivery

1. US1 deploy/demo (project primitive).
2. US2 deploy/demo (task backlog).
3. US3 deploy/demo (dependency-safe planning).
4. US4 deploy/demo (manual delegation bridge).

### Parallel Team Strategy

- Developer A: API route/service tasks.
- Developer B: Web page/component tasks.
- Developer C: Test-first work (API + UI), then integration and polish.

---

## Notes

- [P] tasks should avoid same-file conflicts.
- Keep task status/event logging append-only for auditability.
- Maintain error payload contract `{ error, message }` across all new routes.
- Keep all new limits/timeouts configurable (Principle XI).
