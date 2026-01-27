# Tasks: Browser Terminal SaaS MVP

**Input**: Design documents from `/specs/003-browser-terminal-saas/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.yaml, contracts/agent.yaml

**Tests**: Not explicitly requested - tests are excluded from this task list.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US7)
- Include exact file paths in descriptions

## Path Conventions

Based on plan.md monorepo structure:
- **API**: `apps/api/src/`
- **Web**: `apps/web/src/`
- **Shared**: `packages/shared/src/`
- **Cloud-init**: `packages/cloud-init/src/`
- **VM Agent**: `packages/vm-agent/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic monorepo structure

- [x] T001 Create monorepo structure with apps/, packages/, scripts/, docs/ directories
- [x] T002 Initialize pnpm workspace with pnpm-workspace.yaml and package.json
- [x] T003 [P] Configure Turborepo with turbo.json for build orchestration
- [x] T004 [P] Configure TypeScript with root tsconfig.json and package-specific configs
- [x] T005 [P] Setup ESLint and Prettier with shared configuration
- [x] T006 [P] Configure Husky + lint-staged for pre-commit hooks
- [x] T007 [P] Configure commitlint for Conventional Commits enforcement
- [x] T008 Initialize apps/api package with Hono and wrangler.toml
- [x] T009 Initialize apps/web package with React + Vite + TailwindCSS
- [x] T010 [P] Initialize packages/shared with TypeScript types
- [x] T011 [P] Initialize packages/cloud-init with template utilities
- [x] T012 Initialize packages/vm-agent Go module with go.mod

**Checkpoint**: Monorepo structure complete, all packages can build

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T013 Create shared types in packages/shared/src/types.ts (User, Credential, Workspace, etc.)
- [x] T014 Create shared constants in packages/shared/src/constants.ts (status enums, VM sizes)
- [x] T015 Setup Drizzle ORM with D1 adapter in apps/api/src/db/schema.ts
- [x] T016 Create initial D1 migration for users, credentials, github_installations, workspaces tables in apps/api/src/db/migrations/
- [x] T017 [P] Implement AES-GCM encryption service in apps/api/src/services/encryption.ts
- [x] T018 [P] Implement error handling middleware in apps/api/src/middleware/error.ts
- [x] T019 Setup wrangler.toml with D1, KV, and R2 bindings
- [x] T020 Create Hono app entry point in apps/api/src/index.ts
- [x] T021 Create Vite config and entry point in apps/web/src/main.tsx
- [x] T022 [P] Create API client utility in apps/web/src/lib/api.ts
- [x] T023 [P] Setup React Router in apps/web/src/App.tsx

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Sign In with GitHub (Priority: P1) 🎯 MVP

**Goal**: Users can authenticate via GitHub OAuth and see their dashboard with profile info

**Independent Test**: Complete GitHub OAuth flow, land on dashboard with GitHub avatar and username

### Implementation for User Story 1

- [x] T024 [US1] Configure BetterAuth with better-auth-cloudflare in apps/api/src/auth.ts
- [x] T025 [US1] Create auth routes handler in apps/api/src/routes/auth.ts
- [x] T026 [US1] Mount auth routes at /api/auth/* in apps/api/src/index.ts
- [x] T027 [US1] Implement session validation middleware in apps/api/src/middleware/auth.ts
- [x] T028 [US1] Create /api/auth/me endpoint for current user in apps/api/src/routes/auth.ts
- [x] T029 [US1] Create BetterAuth client in apps/web/src/lib/auth.ts
- [x] T030 [US1] Create AuthProvider context in apps/web/src/components/AuthProvider.tsx
- [x] T031 [US1] Create Landing page with GitHub sign-in button in apps/web/src/pages/Landing.tsx
- [x] T032 [US1] Create Dashboard page showing user profile in apps/web/src/pages/Dashboard.tsx
- [x] T033 [US1] Implement sign-out functionality in apps/web/src/components/UserMenu.tsx
- [x] T034 [US1] Add protected route wrapper in apps/web/src/components/ProtectedRoute.tsx

**Checkpoint**: User Story 1 complete - users can sign in with GitHub and see their dashboard

---

## Phase 4: User Story 2 - Connect Hetzner Cloud Account (Priority: P2)

**Goal**: Users can add their Hetzner API token, which is validated and stored encrypted

**Independent Test**: Add Hetzner token, see "Connected" status in Settings

### Implementation for User Story 2

- [x] T035 [US2] Implement Hetzner token validation in apps/api/src/services/hetzner.ts
- [x] T036 [US2] Create credentials routes in apps/api/src/routes/credentials.ts (GET, POST, DELETE)
- [x] T037 [US2] Mount credentials routes at /api/credentials in apps/api/src/index.ts
- [x] T038 [US2] Create Settings page layout in apps/web/src/pages/Settings.tsx
- [x] T039 [US2] Create HetznerTokenForm component in apps/web/src/components/HetznerTokenForm.tsx
- [x] T040 [US2] Display credential status (connected/not connected) in Settings page
- [x] T041 [US2] Handle token update/delete in Settings page

**Checkpoint**: User Story 2 complete - users can connect their Hetzner account

---

## Phase 5: User Story 3 - Install GitHub App for Repository Access (Priority: P3)

**Goal**: Users can install the GitHub App and see accessible repositories

**Independent Test**: Install GitHub App, return to platform, see list of repositories

### Implementation for User Story 3

- [x] T042 [US3] Implement GitHub App JWT generation in apps/api/src/services/github-app.ts
- [x] T043 [US3] Implement installation token generation in apps/api/src/services/github-app.ts
- [x] T044 [US3] Create github routes in apps/api/src/routes/github.ts (installations, install-url, repositories, webhook)
- [x] T045 [US3] Mount github routes at /api/github in apps/api/src/index.ts
- [x] T046 [US3] Handle GitHub App webhook events (installation created/deleted) in apps/api/src/routes/github.ts
- [x] T047 [US3] Add GitHub App install section to Settings page in apps/web/src/pages/Settings.tsx
- [x] T048 [US3] Create RepoSelector component for listing repos in apps/web/src/components/RepoSelector.tsx

**Checkpoint**: User Story 3 complete - users can install GitHub App and see repos

---

## Phase 6: User Story 4 - Create a Workspace (Priority: P4)

**Goal**: Users can create workspaces that provision VMs, clone repos, and show status transitions

**Independent Test**: Create workspace, see it transition through Creating → Running

### Implementation for User Story 4

- [ ] T049 [US4] Implement Hetzner server creation in apps/api/src/services/hetzner.ts
- [ ] T050 [US4] Implement Hetzner server deletion in apps/api/src/services/hetzner.ts
- [ ] T051 [US4] Implement DNS record creation in apps/api/src/services/dns.ts
- [ ] T052 [US4] Implement DNS record deletion in apps/api/src/services/dns.ts
- [ ] T053 [US4] Create cloud-init template in packages/cloud-init/src/template.ts
- [ ] T054 [US4] Implement cloud-init generation with variables in packages/cloud-init/src/generate.ts
- [ ] T055 [US4] Create workspaces routes in apps/api/src/routes/workspaces.ts (GET list, POST create, GET single)
- [ ] T056 [US4] Mount workspaces routes at /api/workspaces in apps/api/src/index.ts
- [ ] T057 [US4] Implement workspace provisioning flow (create VM, create DNS, update status) in apps/api/src/routes/workspaces.ts
- [ ] T058 [US4] Create CreateWorkspace page with form in apps/web/src/pages/CreateWorkspace.tsx
- [ ] T059 [US4] Create WorkspaceCard component in apps/web/src/components/WorkspaceCard.tsx
- [ ] T060 [US4] Create StatusBadge component in apps/web/src/components/StatusBadge.tsx
- [ ] T061 [US4] Update Dashboard to list workspaces in apps/web/src/pages/Dashboard.tsx
- [ ] T062 [US4] Implement workspace heartbeat endpoint in apps/api/src/routes/workspaces.ts
- [ ] T063 [US4] Add polling for workspace status updates in apps/web/src/pages/Dashboard.tsx

**Checkpoint**: User Story 4 complete - users can create and see workspaces

---

## Phase 7: User Story 5 - Access Terminal in Browser (Priority: P5)

**Goal**: Users can open a browser terminal connected to their workspace VM

**Independent Test**: Click "Open Terminal" on running workspace, execute commands

### Control Plane (JWT + Agent Binary)

- [ ] T064 [US5] Implement JWT signing service in apps/api/src/services/jwt.ts
- [ ] T065 [US5] Create JWKS endpoint at /.well-known/jwks.json in apps/api/src/routes/terminal.ts
- [ ] T066 [US5] Create terminal token endpoint at /api/terminal/token in apps/api/src/routes/terminal.ts
- [ ] T067 [US5] Mount terminal routes in apps/api/src/index.ts
- [ ] T068 [US5] Create agent download endpoint at /api/agent/download in apps/api/src/routes/agent.ts
- [ ] T069 [US5] Mount agent routes in apps/api/src/index.ts

### VM Agent (Go Binary)

- [ ] T070 [P] [US5] Create VM Agent config loader in packages/vm-agent/internal/config/config.go
- [ ] T071 [P] [US5] Implement JWKS-based JWT validation in packages/vm-agent/internal/auth/jwt.go
- [ ] T072 [P] [US5] Implement session cookie management in packages/vm-agent/internal/auth/session.go
- [ ] T073 [US5] Implement PTY session in packages/vm-agent/internal/pty/session.go
- [ ] T074 [US5] Implement PTY session manager in packages/vm-agent/internal/pty/manager.go
- [ ] T075 [US5] Implement HTTP server in packages/vm-agent/internal/server/server.go
- [ ] T076 [US5] Implement route handlers in packages/vm-agent/internal/server/routes.go
- [ ] T077 [US5] Implement WebSocket terminal handler in packages/vm-agent/internal/server/websocket.go
- [ ] T078 [US5] Create Go embed directive in packages/vm-agent/embed.go
- [ ] T079 [US5] Create main entry point in packages/vm-agent/main.go
- [ ] T080 [US5] Create Makefile for building VM Agent in packages/vm-agent/Makefile

### VM Agent Embedded UI

- [ ] T081 [P] [US5] Initialize React app in packages/vm-agent/ui/
- [ ] T082 [US5] Create Terminal component with xterm.js in packages/vm-agent/ui/src/components/Terminal.tsx
- [ ] T083 [US5] Create StatusBar component in packages/vm-agent/ui/src/components/StatusBar.tsx
- [ ] T084 [US5] Create App with routing in packages/vm-agent/ui/src/App.tsx
- [ ] T085 [US5] Configure Vite for embedding in packages/vm-agent/ui/vite.config.ts

### Web UI Terminal Access

- [ ] T086 [US5] Create Workspace detail page in apps/web/src/pages/Workspace.tsx
- [ ] T087 [US5] Add "Open Terminal" button with JWT redirect in apps/web/src/pages/Workspace.tsx

**Checkpoint**: User Story 5 complete - users can access terminal in browser

---

## Phase 8: User Story 6 - Automatic Idle Shutdown (Priority: P6)

**Goal**: Workspaces auto-shutdown after idle period, with warning before shutdown

**Independent Test**: Leave workspace idle for 30 minutes, verify it transitions to Stopped

### Implementation for User Story 6

- [ ] T088 [US6] Implement idle detection in packages/vm-agent/internal/idle/detector.go
- [ ] T089 [US6] Integrate idle detector with PTY session manager in packages/vm-agent/internal/pty/manager.go
- [ ] T090 [US6] Send heartbeat to control plane in packages/vm-agent/internal/server/server.go
- [ ] T091 [US6] Handle shutdown action from heartbeat response in packages/vm-agent/main.go
- [ ] T092 [US6] Add idle warning display in packages/vm-agent/ui/src/components/StatusBar.tsx
- [ ] T093 [US6] Handle idle timeout in control plane heartbeat endpoint in apps/api/src/routes/workspaces.ts
- [ ] T094 [US6] Implement workspace cleanup on idle timeout in apps/api/src/routes/workspaces.ts

**Checkpoint**: User Story 6 complete - idle workspaces auto-shutdown

---

## Phase 9: User Story 7 - Manual Workspace Management (Priority: P7)

**Goal**: Users can manually stop, restart, or delete workspaces

**Independent Test**: Stop a running workspace, see it transition to Stopped

### Implementation for User Story 7

- [ ] T095 [US7] Implement stop endpoint at /api/workspaces/:id/stop in apps/api/src/routes/workspaces.ts
- [ ] T096 [US7] Implement restart endpoint at /api/workspaces/:id/restart in apps/api/src/routes/workspaces.ts
- [ ] T097 [US7] Implement delete endpoint at /api/workspaces/:id (DELETE) in apps/api/src/routes/workspaces.ts
- [ ] T098 [US7] Add Stop/Restart/Delete buttons to WorkspaceCard in apps/web/src/components/WorkspaceCard.tsx
- [ ] T099 [US7] Add confirmation dialog for delete in apps/web/src/components/ConfirmDialog.tsx
- [ ] T100 [US7] Handle orphaned resource cleanup in apps/api/src/routes/workspaces.ts

**Checkpoint**: User Story 7 complete - users can manage workspaces

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Deployment tooling, documentation, and final polish

### Deployment Scripts

- [ ] T101 [P] Create setup wizard script in scripts/setup.ts
- [ ] T102 [P] Create key generation script in scripts/generate-keys.ts
- [ ] T103 Create deploy-staging script in scripts/deploy-staging.ts
- [ ] T104 Create deploy script in scripts/deploy.ts
- [ ] T105 Create teardown script in scripts/teardown.ts
- [ ] T106 Create goreleaser config in packages/vm-agent/.goreleaser.yml

### Documentation

- [ ] T107 [P] Create getting-started guide in docs/guides/getting-started.md
- [ ] T108 [P] Create self-hosting guide in docs/guides/self-hosting.md
- [ ] T109 [P] Create ADR for GitHub App decision in docs/adr/001-github-app-over-oauth.md
- [ ] T110 Update README.md with project overview and quickstart

### Final Validation

- [ ] T111 Run quickstart.md end-to-end validation
- [ ] T112 Verify all deploy/teardown scripts work correctly
- [ ] T113 Review and cleanup unused code

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 - BLOCKS all user stories
- **User Stories (Phase 3-9)**: All depend on Phase 2 completion
  - US1 (Auth): No dependencies on other stories
  - US2 (Credentials): Requires US1 (user must be authenticated)
  - US3 (GitHub App): Requires US1 (user must be authenticated)
  - US4 (Create Workspace): Requires US2 (Hetzner token) + US3 (GitHub App for repos)
  - US5 (Terminal): Requires US4 (workspace must exist)
  - US6 (Idle Shutdown): Requires US5 (terminal must work)
  - US7 (Management): Requires US4 (workspace must exist)
- **Polish (Phase 10)**: Depends on all user stories being complete

### User Story Dependencies

```
US1 (Auth) ──┬──► US2 (Credentials) ──┐
             │                        ├──► US4 (Workspace) ──┬──► US5 (Terminal) ──► US6 (Idle)
             └──► US3 (GitHub App) ───┘                      └──► US7 (Management)
```

### Within Each User Story

- Models/Types before services
- Services before routes
- API routes before UI pages
- Core implementation before integration

### Parallel Opportunities

**Phase 1 (Setup):**
- T003, T004, T005, T006, T007 can run in parallel after T001-T002
- T010, T011 can run in parallel after T008-T009

**Phase 2 (Foundational):**
- T017, T018 can run in parallel
- T022, T023 can run in parallel after T021

**Phase 7 (Terminal - US5):**
- T070, T071, T072 can run in parallel (Go packages)
- T081 can run in parallel with Go work

---

## Parallel Example: User Story 5

```bash
# Launch parallel Go package development:
Task: "Create VM Agent config loader in packages/vm-agent/internal/config/config.go"
Task: "Implement JWKS-based JWT validation in packages/vm-agent/internal/auth/jwt.go"
Task: "Implement session cookie management in packages/vm-agent/internal/auth/session.go"

# Launch UI development in parallel with Go:
Task: "Initialize React app in packages/vm-agent/ui/"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1 (Auth)
4. **STOP and VALIDATE**: Test GitHub OAuth flow independently
5. Deploy/demo if ready - you now have working auth!

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 (Auth) → Test independently → Deploy/Demo (MVP!)
3. Add US2 (Credentials) → Test token storage
4. Add US3 (GitHub App) → Test repo listing
5. Add US4 (Workspace) → Full workspace creation flow
6. Add US5 (Terminal) → Browser terminal working
7. Add US6 + US7 → Full lifecycle management
8. Add Polish → Production ready

### Suggested MVP Scope

**Minimum Viable Product**: Phase 1-3 (Setup + Foundational + Auth)
- Users can sign in with GitHub
- Basic dashboard structure
- Foundation for all other features

**Extended MVP**: Add Phase 4-5 (Credentials + GitHub App)
- Users can connect Hetzner and GitHub App
- Ready for workspace creation

---

## Summary

| Phase | Tasks | Parallel Opportunities |
|-------|-------|----------------------|
| Setup | T001-T012 (12) | 7 tasks |
| Foundational | T013-T023 (11) | 4 tasks |
| US1 - Auth | T024-T034 (11) | 0 (sequential) |
| US2 - Credentials | T035-T041 (7) | 0 |
| US3 - GitHub App | T042-T048 (7) | 0 |
| US4 - Workspace | T049-T063 (15) | 0 |
| US5 - Terminal | T064-T087 (24) | 5 tasks |
| US6 - Idle | T088-T094 (7) | 0 |
| US7 - Management | T095-T100 (6) | 0 |
| Polish | T101-T113 (13) | 4 tasks |

**Total**: 113 tasks
**Parallel opportunities**: 20 tasks marked [P]

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently testable after completion
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- VM Agent is Go, control plane is TypeScript - they can be developed in parallel within US5
