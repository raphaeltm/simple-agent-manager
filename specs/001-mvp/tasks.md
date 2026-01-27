# Tasks: Cloud AI Coding Workspaces MVP

**Input**: Design documents from `/specs/001-mvp/`
**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/ ✓, quickstart.md ✓
**Created**: 2026-01-24
**Updated**: 2026-01-25

## Key Implementation Notes

**Critical Changes (2026-01-25)**:
1. ⚠️ **No Anthropic API Key**: Users authenticate via `claude login` in CloudCLI terminal
2. ⚠️ **GitHub App with Write Permissions**: `contents: read and write` enables clone AND push
3. ⚠️ **Docker Provider**: Enables E2E testing without cloud credentials
4. ⚠️ **US0 Added**: GitHub connection is now P0 priority (before workspace creation)

**Tests**: Tests are included as the Constitution (Principle II) requires >90% coverage for critical paths.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US0-US5)
- File paths follow monorepo structure from plan.md

---

## Phase 1: Setup (Project Initialization)

**Purpose**: Create monorepo structure, configure tooling, and establish development environment

- [x] T001 Initialize pnpm workspace with pnpm-workspace.yaml at repository root
- [x] T002 Create Turborepo configuration in turbo.json at repository root
- [x] T003 [P] Create root package.json with workspace scripts at repository root
- [x] T004 [P] Create base tsconfig.json with TypeScript 5.x config at repository root
- [x] T005 [P] Create .env.example with required environment variables at repository root
- [x] T006 [P] Create .gitignore with Node.js, pnpm, and secret patterns at repository root
- [x] T007 Create apps/api package structure with package.json in apps/api/
- [x] T008 [P] Create apps/web package structure with package.json in apps/web/
- [x] T009 [P] Create packages/shared package structure with package.json in packages/shared/
- [x] T010 [P] Create packages/providers package structure with package.json in packages/providers/
- [x] T011 Configure Vitest for testing in each package (apps/api/vitest.config.ts, packages/*/vitest.config.ts)
- [x] T012 [P] Configure ESLint and Prettier with lint-staged in root package.json
- [x] T013 [P] Create CLAUDE.md with project context at repository root
- [x] T014 [P] Create AGENTS.md with agent instructions at repository root

**Checkpoint**: Monorepo initialized, `pnpm install` succeeds, `pnpm build` succeeds (empty builds)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core types, provider interface, and shared infrastructure that ALL user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Shared Types (packages/shared)

- [x] T015 Create WorkspaceStatus type enum in packages/shared/src/types.ts
- [x] T016 [P] Create Workspace interface in packages/shared/src/types.ts
- [x] T017 [P] Create CreateWorkspaceRequest interface (NO anthropicApiKey) in packages/shared/src/types.ts
- [x] T018 [P] Create WorkspaceSummary interface in packages/shared/src/types.ts
- [ ] T019 [P] Create GitHubConnectionStatus type in packages/shared/src/types.ts
- [ ] T020 [P] Create GitHubConnection interface in packages/shared/src/types.ts
- [ ] T021 [P] Create GitHubInstallationToken interface with `permissions: { contents: 'write' }` in packages/shared/src/types.ts
- [x] T022 Create generateWorkspaceId utility function in packages/shared/src/lib/id.ts
- [x] T023 Create validation schemas for CreateWorkspaceRequest (NO anthropicApiKey) in packages/shared/src/lib/validation.ts
- [x] T024 Create package exports in packages/shared/src/index.ts

### Provider Package (packages/providers)

- [x] T025 Create Provider interface in packages/providers/src/types.ts
- [x] T026 [P] Create VMConfig interface (NO anthropicApiKey) in packages/providers/src/types.ts
- [x] T027 [P] Create VMInstance interface in packages/providers/src/types.ts
- [x] T028 [P] Create SizeConfig interface in packages/providers/src/types.ts
- [x] T029 Implement HetznerProvider class in packages/providers/src/hetzner.ts
- [x] T030 Implement HetznerProvider.createVM method in packages/providers/src/hetzner.ts
- [x] T031 [P] Implement HetznerProvider.deleteVM method in packages/providers/src/hetzner.ts
- [x] T032 [P] Implement HetznerProvider.listVMs method in packages/providers/src/hetzner.ts
- [x] T033 [P] Implement HetznerProvider.getVM method in packages/providers/src/hetzner.ts
- [x] T034 Implement HetznerProvider.getSizeConfig method in packages/providers/src/hetzner.ts
- [x] T035 Create package exports in packages/providers/src/index.ts
- [x] T036 Write unit tests for HetznerProvider in packages/providers/tests/unit/hetzner.test.ts

### API Foundation (apps/api)

- [x] T037 Create wrangler.toml with Cloudflare Workers config in apps/api/wrangler.toml
- [x] T038 Create Hono app entry point in apps/api/src/index.ts
- [x] T039 [P] Implement bearer token auth middleware in apps/api/src/lib/auth.ts
- [x] T040 [P] Create error response helper in apps/api/src/lib/errors.ts
- [x] T041 Create DNSService class with Cloudflare DNS API in apps/api/src/services/dns.ts
- [x] T042 Implement DNSService.createRecord method in apps/api/src/services/dns.ts
- [x] T043 [P] Implement DNSService.deleteRecord method in apps/api/src/services/dns.ts
- [x] T044 Write unit tests for auth middleware in apps/api/tests/unit/lib/auth.test.ts
- [x] T045 [P] Write unit tests for DNSService in apps/api/tests/unit/services/dns.test.ts

### Web Foundation (apps/web)

- [x] T046 Create Vite + React project structure in apps/web/
- [x] T047 [P] Configure Cloudflare Pages in apps/web/package.json scripts
- [x] T048 Create API client service in apps/web/src/services/api.ts
- [x] T049 [P] Create authentication utility in apps/web/src/lib/auth.ts
- [x] T050 Create base layout component in apps/web/src/components/layout.tsx

**Checkpoint**: Foundation ready - `pnpm test` passes, all types compile, provider/DNS services have >90% test coverage

---

## Phase 3: User Story 0 - Connect GitHub Account (Priority: P0) 🎯 MVP

**Goal**: Users can install GitHub App to grant access to private repositories with read AND write permissions

**Independent Test**: Initiate GitHub App installation, select repositories, verify installation is saved and accessible repos are listed

### Tests for User Story 0

- [ ] T051 [P] [US0] Write integration test for GET /github/status in apps/api/tests/integration/routes/github.test.ts
- [ ] T052 [P] [US0] Write integration test for GET /github/repos in apps/api/tests/integration/routes/github.test.ts
- [ ] T053 [P] [US0] Write integration test for DELETE /github/disconnect in apps/api/tests/integration/routes/github.test.ts

### API Implementation for User Story 0

- [ ] T054 [US0] Implement GitHub App JWT generation in apps/api/src/services/github.ts
- [ ] T055 [US0] Implement installation access token generation with `permissions: { contents: 'write' }` in apps/api/src/services/github.ts
- [ ] T056 [US0] Implement installation storage in Cloudflare KV in apps/api/src/services/github.ts
- [ ] T057 [US0] Implement GET /github/connect redirect handler in apps/api/src/routes/github.ts
- [ ] T058 [US0] Implement GET /github/callback handler in apps/api/src/routes/github.ts
- [ ] T059 [US0] Implement GET /github/status endpoint in apps/api/src/routes/github.ts
- [ ] T060 [US0] Implement GET /github/repos endpoint in apps/api/src/routes/github.ts
- [ ] T061 [US0] Implement DELETE /github/disconnect endpoint in apps/api/src/routes/github.ts
- [ ] T062 [US0] Register /github routes in Hono app in apps/api/src/index.ts
- [ ] T063 [US0] Write unit tests for GitHub service in apps/api/tests/unit/services/github.test.ts

### UI Implementation for User Story 0

- [ ] T064 [P] [US0] Create ConnectGitHub button component in apps/web/src/components/ConnectGitHub.tsx
- [ ] T065 [P] [US0] Create GitHubStatus display component in apps/web/src/components/GitHubStatus.tsx
- [ ] T066 [US0] Handle GitHub callback query params in apps/web/src/pages/HomePage.tsx
- [ ] T067 [US0] Create Settings page with GitHub connection in apps/web/src/pages/SettingsPage.tsx
- [ ] T068 [US0] Write component tests for ConnectGitHub in apps/web/tests/unit/components/ConnectGitHub.test.tsx

**Checkpoint**: Users can connect GitHub, see accessible repos, and disconnect if needed

---

## Phase 4: User Story 1 - Create AI Coding Workspace (Priority: P1) 🎯 MVP

**Goal**: User can create a new workspace from a git repository URL and receive a "creating" status

**Independent Test**: Create workspace via API with valid repo URL, verify 201 response with workspace ID and "creating" status

**Note**: NO Anthropic API key required - users authenticate via `claude login` in CloudCLI

### Tests for User Story 1

- [x] T069 [P] [US1] Write integration test for POST /vms success case in apps/api/tests/integration/routes/vms.test.ts
- [x] T070 [P] [US1] Write integration test for POST /vms validation errors in apps/api/tests/integration/routes/vms.test.ts
- [x] T071 [P] [US1] Write integration test for POST /vms provider errors in apps/api/tests/integration/routes/vms.test.ts
- [x] T072 [P] [US1] Write integration test for POST /vms with private repo (GitHub required) in apps/api/tests/integration/routes/vms.test.ts

### Implementation for User Story 1

- [x] T073 [US1] Create cloud-init template (NO ANTHROPIC_API_KEY) in scripts/vm/cloud-init.yaml
- [x] T074 [P] [US1] Create devcontainer default template in scripts/vm/default-devcontainer.json
- [x] T075 [US1] Implement CloudInitService.generate method in apps/api/src/services/cloud-init.ts
- [x] T076 [US1] Implement WorkspaceService class in apps/api/src/services/workspace.ts
- [x] T077 [US1] Implement WorkspaceService.create method in apps/api/src/services/workspace.ts
- [x] T078 [US1] Implement private repo validation (check GitHub connection) in apps/api/src/services/workspace.ts
- [x] T079 [US1] Generate GitHub installation token for private repo clone in apps/api/src/services/workspace.ts
- [x] T080 [US1] Implement POST /vms route handler in apps/api/src/routes/vms.ts
- [x] T081 [US1] Add request validation for POST /vms (NO anthropicApiKey) in apps/api/src/routes/vms.ts
- [x] T082 [US1] Register /vms routes in Hono app in apps/api/src/index.ts
- [x] T083 [US1] Write unit tests for CloudInitService in apps/api/tests/unit/services/cloud-init.test.ts
- [x] T084 [US1] Write unit tests for WorkspaceService.create in apps/api/tests/unit/services/workspace.test.ts

**Checkpoint**: POST /vms creates VM via Hetzner API and DNS record, returns workspace with "creating" status

---

## Phase 5: User Story 1.5 - Authenticate Claude Code (Priority: P1) 🎯 MVP

**Goal**: Users can authenticate Claude Code with their Claude Max subscription via `claude login`

**Independent Test**: Open CloudCLI terminal, run `claude login`, complete browser auth, verify Claude Code responds

**Note**: This is primarily verification that cloud-init does NOT set ANTHROPIC_API_KEY

### Implementation for User Story 1.5

- [x] T085 [US1.5] Verify cloud-init.yaml does NOT set ANTHROPIC_API_KEY environment variable
- [x] T086 [US1.5] Verify VM startup scripts do NOT inject API keys
- [x] T087 [P] [US1.5] Create AuthInstructions component with `claude login` guidance in apps/web/src/components/AuthInstructions.tsx
- [x] T088 [US1.5] Add authentication step instructions to workspace detail view
- [x] T089 [US1.5] Update quickstart.md with Claude Max authentication flow

**Checkpoint**: Users understand how to authenticate Claude Code, cloud-init verified to not set API keys

---

## Phase 6: User Story 2 - Access Running Workspace (Priority: P1) 🎯 MVP

**Goal**: User can access a running workspace via web browser with CloudCLI interface AND push to private repos

**Independent Test**: Navigate to workspace URL, authenticate with basic auth, verify CloudCLI loads, push changes to private repo

### Implementation for User Story 2

- [x] T090 [US2] Create Caddy configuration template in scripts/vm/Caddyfile.template
- [x] T091 [P] [US2] Create setup-caddy.sh script in scripts/vm/setup-caddy.sh
- [x] T092 [P] [US2] Create setup-cloudcli.sh script in scripts/vm/setup-cloudcli.sh
- [x] T093 [US2] Update cloud-init.yaml to include Caddy and CloudCLI setup in scripts/vm/cloud-init.yaml
- [x] T094 [US2] Add basic auth password generation to WorkspaceService.create in apps/api/src/services/workspace.ts
- [x] T095 [US2] Include auth credentials in workspace creation response in apps/api/src/routes/vms.ts
- [x] T096 [US2] Inject GitHub token into VM for push operations via cloud-init
- [x] T097 [US2] Configure git credential helper for GitHub push in cloud-init

**Checkpoint**: Created workspace is accessible via HTTPS URL with basic auth, CloudCLI shows project files, git push works

---

## Phase 7: User Story 3 - View Workspace List (Priority: P2)

**Goal**: User can see all their workspaces with status and access URLs in the control plane dashboard

**Independent Test**: Create multiple workspaces, verify dashboard lists all with correct status and clickable URLs

### Tests for User Story 3

- [x] T098 [P] [US3] Write integration test for GET /vms in apps/api/tests/integration/routes/vms.test.ts
- [x] T099 [P] [US3] Write integration test for GET /vms/:id in apps/api/tests/integration/routes/vms.test.ts

### API Implementation for User Story 3

- [x] T100 [US3] Implement WorkspaceService.list method in apps/api/src/services/workspace.ts
- [x] T101 [P] [US3] Implement WorkspaceService.get method in apps/api/src/services/workspace.ts
- [x] T102 [US3] Implement GET /vms route handler in apps/api/src/routes/vms.ts
- [x] T103 [P] [US3] Implement GET /vms/:id route handler in apps/api/src/routes/vms.ts
- [x] T104 [US3] Write unit tests for WorkspaceService.list in apps/api/tests/unit/services/workspace.test.ts
- [x] T105 [P] [US3] Write unit tests for WorkspaceService.get in apps/api/tests/unit/services/workspace.test.ts

### UI Implementation for User Story 3

- [x] T106 [US3] Create WorkspaceCard component in apps/web/src/components/workspace-card.tsx
- [x] T107 [P] [US3] Create WorkspaceList component in apps/web/src/components/workspace-list.tsx
- [x] T108 [US3] Create Dashboard page in apps/web/src/pages/dashboard.tsx
- [x] T109 [US3] Add routing for dashboard in apps/web/src/main.tsx
- [x] T110 [US3] Write component tests for WorkspaceCard in apps/web/tests/unit/components/workspace-card.test.tsx
- [x] T111 [P] [US3] Write component tests for WorkspaceList in apps/web/tests/unit/components/workspace-list.test.tsx

**Checkpoint**: Dashboard shows list of workspaces with accurate status, running workspaces have clickable access URLs

---

## Phase 8: User Story 4 - Manually Stop Workspace (Priority: P2)

**Goal**: User can stop a running workspace from the control plane to immediately terminate it

**Independent Test**: Create workspace, click Stop, verify VM terminated and DNS record removed

### Tests for User Story 4

- [x] T112 [P] [US4] Write integration test for DELETE /vms/:id in apps/api/tests/integration/routes/vms.test.ts
- [x] T113 [P] [US4] Write integration test for DELETE /vms/:id not found in apps/api/tests/integration/routes/vms.test.ts

### API Implementation for User Story 4

- [x] T114 [US4] Implement WorkspaceService.stop method in apps/api/src/services/workspace.ts
- [x] T115 [US4] Implement DELETE /vms/:id route handler in apps/api/src/routes/vms.ts
- [x] T116 [US4] Write unit tests for WorkspaceService.stop in apps/api/tests/unit/services/workspace.test.ts

### UI Implementation for User Story 4

- [x] T117 [US4] Add Stop button to WorkspaceCard component in apps/web/src/components/workspace-card.tsx
- [x] T118 [P] [US4] Add stop confirmation (using window.confirm) in apps/web/src/components/workspace-card.tsx
- [x] T119 [US4] Implement stop functionality in Dashboard page in apps/web/src/pages/dashboard.tsx
- [x] T120 [US4] Write component tests for stop confirmation in apps/web/tests/unit/components/workspace-card.test.tsx

**Checkpoint**: Stop button triggers workspace deletion, VM terminates, DNS cleaned up, UI updates to show "stopped"

---

## Phase 9: User Story 5 - Automatic Idle Shutdown (Priority: P3)

**Goal**: Workspaces automatically shut down after 30 minutes of inactivity to minimize costs

**Independent Test**: Create workspace, leave idle for 35 minutes, verify VM self-terminates and DNS cleaned up

### Tests for User Story 5

- [x] T121 [P] [US5] Write integration test for POST /vms/:id/cleanup in apps/api/tests/integration/routes/cleanup.test.ts
- [x] T122 [P] [US5] Write integration test for idempotent cleanup in apps/api/tests/integration/routes/cleanup.test.ts

### API Implementation for User Story 5

- [x] T123 [US5] Implement WorkspaceService.cleanup method in apps/api/src/services/workspace.ts
- [x] T124 [US5] Create cleanup route handler in apps/api/src/routes/cleanup.ts
- [x] T125 [US5] Register /vms/:id/cleanup route in Hono app in apps/api/src/index.ts
- [x] T126 [US5] Write unit tests for WorkspaceService.cleanup in apps/api/tests/unit/services/workspace.test.ts

### VM Scripts for User Story 5

- [x] T127 [US5] Create idle-check.sh script (embedded in scripts/vm/cloud-init.yaml)
- [x] T128 [P] [US5] Create self-terminate logic (embedded in idle-check.sh in cloud-init.yaml)
- [x] T129 [US5] Update cloud-init.yaml to install idle monitoring cron in scripts/vm/cloud-init.yaml
- [x] T130 [US5] Idle detection logic tested via integration tests (no separate unit tests needed)

**Checkpoint**: Idle VMs call cleanup endpoint and self-terminate after 30 minutes, DNS records removed

---

## Phase 10: Docker Provider for E2E Testing

**Goal**: Enable end-to-end testing without cloud credentials

**Independent Test**: Run E2E tests locally using Docker provider, verify full workspace lifecycle

### Implementation for Docker Provider

- [ ] T131 [P] Create DockerProvider class in packages/providers/src/docker.ts
- [ ] T132 [P] Implement DockerProvider.createVM in packages/providers/src/docker.ts
- [x] T133 [P] Implement DockerProvider.deleteVM in packages/providers/src/docker.ts
- [x] T134 [P] Implement DockerProvider.listVMs in packages/providers/src/docker.ts
- [x] T135 [P] Implement DockerProvider.getVM in packages/providers/src/docker.ts
- [x] T136 Create Dockerfile for DinD workspace container in scripts/docker/Dockerfile
- [x] T137 Adapt cloud-init for Docker environment in scripts/docker/entrypoint.sh
- [x] T138 Add provider factory with environment-based selection in packages/providers/src/index.ts
- [x] T139 Write unit tests for DockerProvider in packages/providers/tests/unit/docker.test.ts
- [x] T140 Create E2E test suite using Docker provider in apps/api/tests/e2e/workspace.test.ts

**Checkpoint**: E2E tests run locally without Hetzner credentials, full workspace lifecycle verified

---

## Phase 11: User Story 1 UI - Create Workspace Form (Priority: P1) 🎯 MVP

**Goal**: User can create workspaces via the web UI (completing the MVP user flow)

**Independent Test**: Fill out form with repo URL, submit, verify workspace appears in list with "creating" status

**Note**: NO Anthropic API key field - users authenticate via `claude login` after workspace creation

### Tests for User Story 1 UI

- [x] T141 [P] [US1] Write component tests for WorkspaceForm in apps/web/tests/unit/components/workspace-form.test.tsx

### Implementation for User Story 1 UI

- [x] T142 [US1] Create WorkspaceForm component (NO anthropicApiKey field) in apps/web/src/components/workspace-form.tsx
- [x] T143 [US1] Add form validation for repo URL in apps/web/src/components/workspace-form.tsx
- [x] T144 [US1] Add RepoSelector with autocomplete from GitHub repos in apps/web/src/components/RepoSelector.tsx
- [x] T145 [US1] Add WorkspaceForm to Dashboard page in apps/web/src/pages/dashboard.tsx
- [x] T146 [US1] Implement create workspace API call in apps/web/src/services/api.ts
- [x] T147 [US1] Add loading state and error handling to WorkspaceForm in apps/web/src/components/workspace-form.tsx

**Checkpoint**: Full MVP user flow works - connect GitHub, create workspace via UI, see it in list, access via URL

---

## Phase 12: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, deployment, and finishing touches

### Documentation

- [x] T148 [P] Create getting-started.md guide in docs/guides/getting-started.md
- [x] T149 [P] Create ADR for monorepo structure in docs/adr/001-monorepo-structure.md
- [x] T150 [P] Create ADR for stateless architecture in docs/adr/002-stateless-architecture.md
- [x] T151 [P] Create CONTRIBUTING.md at repository root
- [x] T152 [P] Create ROADMAP.md at repository root
- [ ] T153 [P] Update quickstart.md to remove API key references

### Deployment & CI

- [x] T154 Create GitHub Actions workflow for CI in .github/workflows/ci.yml
- [x] T155 [P] Create GitHub Actions workflow for deployment in .github/workflows/deploy.yml
- [x] T156 Add Wrangler deployment scripts to apps/api/package.json
- [x] T157 [P] Add Cloudflare Pages deployment config to apps/web/package.json
- [x] T158 Create staging environment config in apps/api/wrangler.toml

### Final Validation

- [x] T159 Run full test suite and verify tests pass
- [ ] T160 Run quickstart.md validation to verify development setup works
- [ ] T161 Manual end-to-end test: connect GitHub → create workspace → authenticate Claude → access → push → stop

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup)
    ↓
Phase 2 (Foundational) ← BLOCKS all user stories
    ↓
Phase 3 (US0 GitHub) ← CRITICAL: Must complete before private repo creation
    ↓
Phase 4 (US1 API) ──┬──► Phase 5 (US1.5 Claude Auth)
                    │         ↓
                    └──► Phase 6 (US2 VM Access)
                              ↓
                         Phase 11 (US1 UI)

Phase 7 (US3 List) ← depends on Phase 4 (workspaces exist to list)
    ↓
Phase 8 (US4 Stop)

Phase 9 (US5 Idle) ← depends on Phase 4 (workspaces exist to idle)

Phase 10 (Docker Provider) ← can start after Phase 2 (independent)

Phase 12 (Polish) ← after desired stories complete
```

### User Story Dependencies

| Story | Depends On | Can Start After |
|-------|------------|-----------------|
| US0 (GitHub) | Foundational | Phase 2 complete |
| US1 (Create) | Foundational, US0 for private repos | Phase 3 complete |
| US1.5 (Auth) | US1 | Phase 4 complete (VM must exist) |
| US2 (Access) | US1 | Phase 4 complete (VM must exist) |
| US3 (List) | US1 | Phase 4 complete (workspaces must exist) |
| US4 (Stop) | US1, US3 | Phase 7 complete (need list UI) |
| US5 (Idle) | US1 | Phase 4 complete (VM must exist) |

### Within Each User Story

1. Tests FIRST (if included) - ensure they fail
2. Backend/API implementation
3. VM scripts (if applicable)
4. Frontend/UI implementation
5. Integration and validation

### Parallel Opportunities

**Phase 2** (after sequential setup):
- T016-T018, T019-T021 (Types can run in parallel)
- T026-T028 (Provider interfaces)
- T031-T033 (Provider methods)
- T039, T040 (API middleware)
- T044, T045 (tests)

**Phase 3** (US0):
- T051-T053 (tests can run in parallel)
- T064, T065 (UI components can run in parallel)

**Phase 10** (Docker Provider):
- T131-T135 (all provider methods can run in parallel)

---

## MVP Implementation Strategy

### Minimum Viable Product

**Must complete in order**:
1. Phase 1: Setup
2. Phase 2: Foundational
3. Phase 3: US0 - Connect GitHub (P0)
4. Phase 4: US1 - Create Workspace (P1)
5. Phase 5: US1.5 - Claude Auth (P1)
6. Phase 6: US2 - Access Workspace (P1)
7. Phase 11: US1 UI - Create Form (P1)

**MVP Deliverable**: User can connect GitHub, create a workspace from private repo via web UI, authenticate Claude, access CloudCLI, and push changes

### Post-MVP Features

- Phase 7: US3 - View Workspace List (P2)
- Phase 8: US4 - Manually Stop Workspace (P2)
- Phase 9: US5 - Automatic Idle Shutdown (P3)
- Phase 10: Docker Provider (for local testing)
- Phase 12: Polish

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| **Total Tasks** | 161 |
| **Phase 1 (Setup)** | 14 |
| **Phase 2 (Foundational)** | 36 |
| **Phase 3 (US0 GitHub)** | 18 |
| **Phase 4 (US1 Create)** | 16 |
| **Phase 5 (US1.5 Auth)** | 5 |
| **Phase 6 (US2 Access)** | 8 |
| **Phase 7 (US3 List)** | 14 |
| **Phase 8 (US4 Stop)** | 9 |
| **Phase 9 (US5 Idle)** | 10 |
| **Phase 10 (Docker)** | 10 |
| **Phase 11 (US1 UI)** | 7 |
| **Phase 12 (Polish)** | 14 |
| **New Tasks (2026-01-25)** | 43 |
| **Parallelizable [P]** | ~55 |

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story (US0-US5)
- Tests are included per Constitution Principle II (Infrastructure Stability)
- Commit after each task or logical group
- Stop at any checkpoint to validate independently
- Critical paths require >90% test coverage

### Critical Implementation Details

1. ⚠️ **GitHub Token Generation**: Use `permissions: { contents: 'write' }` for push support
2. ⚠️ **CreateWorkspaceRequest**: Does NOT include anthropicApiKey field
3. ⚠️ **VMConfig**: Does NOT include anthropicApiKey field
4. ⚠️ **cloud-init.yaml**: MUST NOT set ANTHROPIC_API_KEY environment variable
5. ⚠️ **GitHubInstallationToken.permissions**: `{ contents: 'write' }` (not 'read')
