# Tasks: Local Mock Mode

**Input**: Design documents from `/specs/002-local-mock-mode/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: No explicit test requirements in spec. Tests are optional but recommended for providers.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

This is a monorepo with:
- `packages/providers/` - Provider implementations
- `apps/api/` - Hono API
- `apps/web/` - React UI
- `scripts/` - VM and utility scripts

---

## Phase 1: Setup (Cleanup & Preparation)

**Purpose**: Remove broken Docker-in-Docker code and prepare for new implementation

- [x] T001 Delete Docker provider file at packages/providers/src/docker.ts
- [x] T002 [P] Delete scripts/docker/ directory (Dockerfile, entrypoint.sh, nginx.conf, supervisord.conf)
- [x] T003 Remove DockerProvider export and import from packages/providers/src/index.ts
- [x] T004 Remove 'docker' case from createProvider factory in packages/providers/src/index.ts

**Checkpoint**: Codebase cleaned of broken DinD implementation

---

## Phase 2: Foundational (Core Infrastructure)

**Purpose**: Create base interfaces and services that ALL user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Extract DNSServiceInterface from apps/api/src/services/dns.ts (createRecord, deleteRecord, findRecord, recordExists methods)
- [x] T006 [P] Create MockDNSService implementing DNSServiceInterface in apps/api/src/services/mock-dns.ts
- [x] T007 [P] Create DevcontainerProvider skeleton implementing Provider interface in packages/providers/src/devcontainer.ts
- [x] T008 Add DevcontainerProvider export to packages/providers/src/index.ts
- [x] T009 Update createProvider factory to handle 'devcontainer' type in packages/providers/src/index.ts
- [x] T010 Create .env.mock template file at repository root with PROVIDER_TYPE=devcontainer and DNS_TYPE=mock
- [x] T011 Add [env.mock.vars] section to apps/api/wrangler.toml with PROVIDER_TYPE and DNS_TYPE

**Checkpoint**: Foundation ready - MockDNSService and DevcontainerProvider skeletons exist, environment configured

---

## Phase 3: User Story 1 - Run Control Plane Locally (Priority: P1) 🎯 MVP

**Goal**: Developer can run `pnpm dev:mock` and see the control plane UI without cloud credentials

**Independent Test**: Run `pnpm dev:mock`, open http://localhost:5173, verify dashboard loads with empty workspace list

### Implementation for User Story 1

- [x] T012 [US1] Add dev:mock script to root package.json that sets environment variables and runs turbo dev
- [x] T013 [US1] Add dev:mock script to apps/api/package.json that runs wrangler dev --env mock
- [x] T014 [US1] Implement provider selection in apps/api/src/index.ts based on PROVIDER_TYPE environment variable
- [x] T015 [US1] Implement DNS service selection in apps/api/src/index.ts based on DNS_TYPE environment variable
- [x] T016 [US1] Update WorkspaceService constructor in apps/api/src/services/workspace.ts to accept Provider and DNSService via dependency injection
- [x] T017 [US1] Implement DevcontainerProvider.listVMs() to return empty array (enables empty dashboard)
- [x] T018 [US1] Implement DevcontainerProvider.getSizeConfig() to return mock size configs in packages/providers/src/devcontainer.ts

**Checkpoint**: `pnpm dev:mock` starts API and UI, dashboard shows empty workspace list without errors

---

## Phase 4: User Story 2 - Create Local Workspace (Priority: P1)

**Goal**: Developer can create a workspace that runs as a local devcontainer

**Independent Test**: Create workspace via UI with public repo, verify devcontainer starts and status shows "running"

### Implementation for User Story 2

- [x] T019 [US2] Implement Docker availability check in DevcontainerProvider (throws actionable error if Docker not running)
- [x] T020 [US2] Implement devcontainer CLI availability check in DevcontainerProvider (throws actionable error if CLI missing)
- [x] T021 [US2] Implement single workspace enforcement in DevcontainerProvider.createVM() per FR-012
- [x] T022 [US2] Implement repository cloning to /tmp/cloud-ai-workspaces/{workspaceId}/ in DevcontainerProvider.createVM()
- [x] T023 [US2] Implement default devcontainer.json creation for repos without one in DevcontainerProvider.createVM()
- [x] T024 [US2] Implement devcontainer up execution with JSON output parsing in DevcontainerProvider.createVM()
- [x] T025 [US2] Implement container IP extraction from Docker inspect in DevcontainerProvider.createVM()
- [x] T026 [US2] Apply Docker labels (workspace-id, managed-by, provider, repo-url) in DevcontainerProvider.createVM()
- [x] T027 [US2] Implement DevcontainerProvider.getVM() to retrieve single workspace by container ID
- [x] T028 [US2] Update DevcontainerProvider.listVMs() to find containers by Docker labels
- [x] T029 [US2] Implement generateCloudInit() stub (returns minimal script, not used for devcontainer) in DevcontainerProvider

**Checkpoint**: Workspace creation works end-to-end, devcontainer runs locally, status shows "running"

---

## Phase 5: User Story 3 - Stop and Delete Local Workspace (Priority: P2)

**Goal**: Developer can stop a running workspace and it's removed from the list

**Independent Test**: Stop a running workspace via UI, verify container removed and workspace disappears from list

### Implementation for User Story 3

- [x] T030 [US3] Implement DevcontainerProvider.deleteVM() to run docker stop and docker rm
- [x] T031 [US3] Handle graceful deletion of already-stopped containers in DevcontainerProvider.deleteVM()
- [x] T032 [US3] Clean up workspace folder in /tmp/cloud-ai-workspaces/{id}/ on delete
- [x] T033 [US3] Update MockDNSService.deleteRecord() to remove record from in-memory Map

**Checkpoint**: Full workspace lifecycle works: create → view → stop → verify removed

---

## Phase 6: User Story 4 - Access Local Workspace Terminal (Priority: P3)

**Goal**: Developer can execute commands in a running workspace

**Independent Test**: With a running workspace, call exec endpoint and verify command output returned

### Implementation for User Story 4

- [x] T034 [US4] Add exec endpoint to apps/api/src/routes/vms.ts if not exists (POST /vms/:id/exec)
- [x] T035 [US4] Implement command execution using devcontainer exec --workspace-folder {path} {cmd}
- [x] T036 [US4] Return command stdout/stderr in API response

**Checkpoint**: Can execute commands in running devcontainer via API

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, error handling improvements, final validation

- [x] T037 [P] Add error handling for common failure scenarios with actionable messages per research.md
- [x] T038 [P] Update quickstart.md in specs/002-local-mock-mode/ with tested instructions
- [x] T039 Copy quickstart content to docs/guides/local-development.md
- [x] T040 Run full workflow validation: pnpm dev:mock → create workspace → view → stop → verify cleanup
- [x] T041 Update README.md with mock mode quick reference

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - US1 (Phase 3) must complete before US2 (Phase 4) can be tested
  - US2 (Phase 4) must complete before US3 (Phase 5) can be tested
  - US3 (Phase 5) must complete before US4 (Phase 6) can be tested
- **Polish (Phase 7)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - Enables running control plane
- **User Story 2 (P1)**: Depends on US1 - Needs control plane running to test workspace creation
- **User Story 3 (P2)**: Depends on US2 - Needs a workspace to stop/delete
- **User Story 4 (P3)**: Depends on US2 - Needs a running workspace to execute commands

### Within Each Phase

- Tasks marked [P] can run in parallel
- Tasks without [P] should run sequentially
- Complete all phase tasks before moving to next phase

### Parallel Opportunities

Phase 1 parallel group:
```
T001 and T002 can run in parallel (deleting different files)
```

Phase 2 parallel group:
```
T006 (MockDNSService) and T007 (DevcontainerProvider skeleton) can run in parallel
```

Phase 4 parallel group:
```
T019 (Docker check) and T020 (CLI check) can run in parallel
```

Phase 7 parallel group:
```
T037 (error handling) and T038 (quickstart) can run in parallel
```

---

## Parallel Example: Phase 2

```bash
# These can be launched together:
Task: "Create MockDNSService implementing DNSServiceInterface in apps/api/src/services/mock-dns.ts"
Task: "Create DevcontainerProvider skeleton implementing Provider interface in packages/providers/src/devcontainer.ts"
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2)

1. Complete Phase 1: Setup (cleanup) - ~15 min
2. Complete Phase 2: Foundational - ~30 min
3. Complete Phase 3: User Story 1 (run control plane) - ~30 min
4. **STOP and VALIDATE**: Run `pnpm dev:mock`, verify dashboard loads
5. Complete Phase 4: User Story 2 (create workspace) - ~1 hour
6. **STOP and VALIDATE**: Create a workspace, verify devcontainer runs

### Incremental Delivery

1. Setup + Foundational → Clean codebase with new infrastructure
2. Add User Story 1 → Control plane runs locally (MVP!)
3. Add User Story 2 → Can create workspaces
4. Add User Story 3 → Can stop/delete workspaces
5. Add User Story 4 → Can execute commands (optional enhancement)
6. Polish → Documentation and error handling

### Suggested MVP Scope

**Minimum**: User Stories 1 + 2 (run control plane + create workspace)
**Recommended**: User Stories 1 + 2 + 3 (add stop/delete for full lifecycle)
**Full**: All 4 user stories

---

## Notes

- All tasks use existing interfaces (Provider, DNSService) - no new contracts needed
- DevcontainerProvider uses child process execution (execa) for devcontainer CLI
- MockDNSService is purely in-memory - no persistence
- Single workspace limit simplifies implementation
- Docker labels enable container discovery across API restarts
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
