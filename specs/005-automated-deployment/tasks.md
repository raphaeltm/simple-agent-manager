# Tasks: Automated Self-Hosting Deployment (Pulumi)

**Input**: Design documents from `/specs/005-automated-deployment/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Tests are requested (constitution principle II: Infrastructure Stability requires TDD for critical paths). Pulumi unit tests with mocks.

**Organization**: Tasks grouped by user story. US1 and US2 combined (P1 priority, same codebase).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Exact file paths included in descriptions

## Path Conventions (from plan.md)

```
infra/                          # NEW: Pulumi infrastructure
├── Pulumi.yaml
├── Pulumi.prod.yaml
├── package.json
├── tsconfig.json
├── index.ts
├── resources/
│   ├── database.ts
│   ├── kv.ts
│   ├── storage.ts
│   └── dns.ts
└── __tests__/
    └── index.test.ts

scripts/deploy/
├── sync-wrangler-config.ts     # NEW: Pulumi → wrangler.toml

.github/workflows/
├── deploy-setup.yml            # MODIFY: Pulumi-based
└── teardown-setup.yml          # MODIFY: Pulumi destroy
```

---

## Phase 1: Setup (Pulumi Project Initialization)

**Purpose**: Create `infra/` directory with Pulumi TypeScript project

- [x] T001 Create `infra/` directory at repository root
- [x] T002 Initialize Pulumi project with `Pulumi.yaml` in `infra/Pulumi.yaml`
- [x] T003 Create `infra/package.json` with dependencies: `@pulumi/pulumi`, `@pulumi/cloudflare`, `typescript`
- [x] T004 [P] Create `infra/tsconfig.json` with TypeScript 5.x CommonJS configuration
- [x] T005 [P] Create `infra/.gitignore` to exclude `node_modules/`, `bin/`
- [x] T006 Install dependencies by running `pnpm install` in `infra/`
- [x] T007 Create `infra/Pulumi.prod.yaml` stack configuration for production

**Checkpoint**: ✅ Pulumi project structure ready, `pulumi preview` runs (with no resources yet)

---

## Phase 2: Foundational (Core Pulumi Resources)

**Purpose**: Implement all Pulumi resource modules that enable deployment

**⚠️ CRITICAL**: No user story workflows can function until these resources exist

### Pulumi Resource Modules

- [x] T008 [P] Create D1 database resource in `infra/resources/database.ts` per data-model.md
- [x] T009 [P] Create KV namespace resource in `infra/resources/kv.ts` per data-model.md
- [x] T010 [P] Create R2 bucket resource in `infra/resources/storage.ts` per data-model.md
- [x] T011 [P] Create DNS records resource in `infra/resources/dns.ts` per data-model.md
- [x] T012 Create main entry point `infra/index.ts` that imports and exports all resources

### Pulumi Unit Tests

- [x] T013 Create test setup with `pulumi.runtime.setMocks()` in `infra/__tests__/setup.ts`
- [x] T014 [P] Add unit tests for D1 database resource in `infra/__tests__/database.test.ts`
- [x] T015 [P] Add unit tests for KV namespace resource in `infra/__tests__/kv.test.ts`
- [x] T016 [P] Add unit tests for R2 bucket resource in `infra/__tests__/storage.test.ts`
- [x] T017 [P] Add unit tests for DNS records resource in `infra/__tests__/dns.test.ts`
- [x] T018 Verify all tests pass with `pnpm test` in `infra/`

**Checkpoint**: ✅ Foundation ready - all Pulumi resources defined and tested. `pulumi preview` shows resources.

---

## Phase 3: User Stories 1+2 - Deployment (Priority: P1) 🎯 MVP

**Goal**: Single-action deployment via GitHub Actions with idempotency (US1: first-time, US2: re-run)

**Independent Test**: Fork repo, create R2 state bucket, configure secrets, run Deploy workflow twice. Both runs should succeed, second run should show no changes needed.

### Configuration Bridge (Pulumi → Wrangler)

- [x] T019 [US1] Create `scripts/deploy/sync-wrangler-config.ts` to read Pulumi outputs and update `apps/api/wrangler.toml`
- [x] T020 [US1] Add `@iarna/toml` dependency to root `package.json` for TOML parsing
- [x] T021 [US1] Create TypeScript types for Pulumi outputs in `scripts/deploy/types.ts`

### Security Key Generation

- [x] T022 [US1] Create `scripts/deploy/generate-keys.ts` to generate JWT key pair and encryption key if not provided

### Deploy Workflow

- [x] T023 [US1] Update `.github/workflows/deploy-setup.yml` Phase 1: Pulumi login to R2 backend
- [x] T024 [US1] Update `.github/workflows/deploy-setup.yml` Phase 2: Pulumi up with `pulumi/actions@v5`
- [x] T025 [US1] Update `.github/workflows/deploy-setup.yml` Phase 3: Run sync-wrangler-config.ts
- [x] T026 [US1] Update `.github/workflows/deploy-setup.yml` Phase 4: Wrangler deploy API Worker
- [x] T027 [US1] Update `.github/workflows/deploy-setup.yml` Phase 5: Wrangler Pages deploy Web UI
- [x] T028 [US1] Update `.github/workflows/deploy-setup.yml` Phase 6: Wrangler d1 migrations
- [x] T029 [US1] Update `.github/workflows/deploy-setup.yml` Phase 7: Wrangler secrets configuration
- [x] T030 [US1] Update `.github/workflows/deploy-setup.yml` Phase 8: Build and upload VM Agent binaries
- [x] T031 [US1] Update `.github/workflows/deploy-setup.yml` Phase 9: Health check validation
- [x] T032 [US1] Update `.github/workflows/deploy-setup.yml` Phase 10: Output deployment URLs

### Idempotency Verification (US2)

- [x] T033 [US2] Add workflow job summary with Pulumi diff output showing idempotency
- [x] T034 [US2] Document idempotency behavior in workflow comments

**Checkpoint**: ✅ US1 + US2 complete. Deploy workflow provisions infrastructure and deploys application. Re-running shows "no changes" for existing resources.

---

## Phase 4: User Story 3 - Clean Teardown (Priority: P2)

**Goal**: Single-action removal of all Pulumi-managed resources

**Independent Test**: Run Teardown after successful Deploy. All resources removed. Run Deploy again - fresh deployment succeeds.

### Teardown Workflow

- [x] T035 [US3] Update `.github/workflows/teardown-setup.yml` to use Pulumi login to R2 backend
- [x] T036 [US3] Update `.github/workflows/teardown-setup.yml` to run `pulumi destroy` with confirmation
- [x] T037 [US3] Add workflow input for confirmation (type "DELETE" to confirm)
- [x] T038 [US3] Add option to preserve data (`--keep-data` flag for partial teardown)
- [x] T039 [US3] Add workflow summary showing destroyed resources

**Checkpoint**: ✅ US3 complete. Teardown removes all Pulumi-managed resources. State bucket preserved for user.

---

## Phase 5: User Story 4 - GitHub App Configuration (Priority: P2)

**Goal**: Clear guidance and graceful handling of optional GitHub App credentials

**Independent Test**: Deploy without GitHub secrets, then add them and re-deploy. Both scenarios work correctly.

### GitHub App Support in Workflow

- [x] T040 [US4] Update deploy workflow to handle optional `GITHUB_APP_ID` secret gracefully
- [x] T041 [US4] Update deploy workflow to handle optional `GITHUB_APP_PRIVATE_KEY` secret gracefully
- [x] T042 [US4] Update deploy workflow to handle optional `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
- [x] T043 [US4] Add workflow log message when GitHub App not configured (non-blocking warning)

**Checkpoint**: ✅ US4 complete. Deployment works with or without GitHub App credentials. Clear messaging for unconfigured state.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup, documentation updates, validation

### Cleanup Old Implementation

- [x] T044 Remove old custom API code from `scripts/deploy/provision.ts`
- [x] T045 Remove old `scripts/deploy/utils/cloudflare.ts` (replaced by Pulumi)
- [x] T046 Remove old `scripts/deploy/deploy-worker.ts` if no longer needed
- [x] T047 Update `scripts/deploy/index.ts` to remove deprecated exports

### Documentation Updates

- [x] T048 [P] Update `docs/guides/self-hosting.md` to reference Pulumi approach and quickstart.md
- [x] T049 [P] Add troubleshooting section to quickstart.md for common Pulumi errors (in quickstart.md)
- [x] T050 Update `CLAUDE.md` Active Technologies section with Pulumi (already done by agent context script)

### Integration with Monorepo

- [x] T051 Add `infra` to root `pnpm-workspace.yaml` if using workspace dependencies
- [x] T052 Add Pulumi test command to root `package.json` scripts
- [x] T053 Update CI workflow to run Pulumi tests in `infra/`

### Final Validation

- [ ] T054 Run quickstart.md validation (simulate fresh deployment)
- [x] T055 Verify constitution compliance (Principle X: Official SDKs used)
- [ ] T056 Update feature spec status from "Draft" to "Complete"

**Checkpoint**: Feature nearly complete. Old code cleanup done, documentation updated, CI integrated. Pending: fresh deployment validation (T054) and spec status update (T056).

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup)           → No dependencies
        ↓
Phase 2 (Foundational)    → Depends on Phase 1
        ↓
Phase 3 (US1+US2)         → Depends on Phase 2 (BLOCKS teardown)
        ↓
Phase 4 (US3)             → Can start after Phase 2, but typically after US1+US2
        ↓
Phase 5 (US4)             → Can run in parallel with US3
        ↓
Phase 6 (Polish)          → Depends on all user stories
```

### User Story Dependencies

- **US1+US2 (P1)**: Depends on Foundational - Core deployment functionality
- **US3 (P2)**: Technically independent of US1/US2, but typically run after deployment works
- **US4 (P2)**: Independent - Just workflow input handling

### Within Each Phase

- Resource modules (T008-T011) can run in parallel
- Tests (T014-T017) can run in parallel after setup
- Workflow updates (T023-T032) are sequential (single file)

---

## Parallel Execution Examples

### Phase 2 Parallel Opportunities

```bash
# All resource modules can be developed in parallel:
Task: "Create D1 database resource in infra/resources/database.ts"
Task: "Create KV namespace resource in infra/resources/kv.ts"
Task: "Create R2 bucket resource in infra/resources/storage.ts"
Task: "Create DNS records resource in infra/resources/dns.ts"

# All tests can be developed in parallel:
Task: "Add unit tests for D1 database resource in infra/__tests__/database.test.ts"
Task: "Add unit tests for KV namespace resource in infra/__tests__/kv.test.ts"
Task: "Add unit tests for R2 bucket resource in infra/__tests__/storage.test.ts"
Task: "Add unit tests for DNS records resource in infra/__tests__/dns.test.ts"
```

### Phase 6 Parallel Opportunities

```bash
# Documentation updates can run in parallel:
Task: "Update docs/guides/self-hosting.md"
Task: "Add troubleshooting section to quickstart.md"
```

---

## Implementation Strategy

### MVP First (Phase 1-3)

1. Complete Phase 1: Setup Pulumi project
2. Complete Phase 2: Foundational resources + tests
3. Complete Phase 3: Deploy workflow (US1 + US2)
4. **STOP and VALIDATE**: Test deployment end-to-end
5. This is a complete MVP - users can deploy SAM

### Incremental Delivery

1. Phase 1-3 → MVP: Users can deploy
2. Add Phase 4 (US3) → Users can teardown
3. Add Phase 5 (US4) → Full GitHub integration
4. Phase 6 → Production-ready with cleanup

### Estimated Task Counts

| Phase | Tasks | Parallel | Description |
|-------|-------|----------|-------------|
| 1: Setup | 7 | 2 | Project initialization |
| 2: Foundational | 11 | 8 | Resources + tests |
| 3: US1+US2 | 16 | 0* | Deploy workflow |
| 4: US3 | 5 | 0 | Teardown workflow |
| 5: US4 | 4 | 0 | GitHub App support |
| 6: Polish | 13 | 2 | Cleanup + docs |
| **Total** | **56** | **12** | |

*Phase 3 has no parallel tasks since most updates are to a single workflow file.

---

## Research Validation

Tasks validated against best practices:

1. **Pulumi project structure** ([Pulumi Docs](https://www.pulumi.com/docs/iac/languages-sdks/javascript/)):
   - package.json with @pulumi/pulumi, TypeScript
   - tsconfig.json with CommonJS for compatibility
   - Pulumi.yaml with runtime: nodejs

2. **Pulumi testing** ([Pulumi Testing Docs](https://www.pulumi.com/docs/iac/guides/testing/unit/)):
   - `pulumi.runtime.setMocks()` for unit testing
   - Test files in `__tests__/` directory
   - Mock resource creation without cloud calls

3. **GitHub Actions security** ([GitHub Security Hardening](https://docs.github.com/en/actions/security-for-github-actions)):
   - Secrets via GitHub Secrets, never hardcoded
   - Minimal permissions for GITHUB_TOKEN
   - Masking sensitive output

4. **Pulumi + GitHub Actions** ([Pulumi GitHub Actions](https://github.com/pulumi/actions)):
   - Use `pulumi/actions@v5` official action
   - `cloud-url` parameter for self-managed backend
   - Environment variables for R2 credentials

---

## Notes

- [P] = different files, no dependencies, can parallelize
- [USx] = maps task to user story for traceability
- Tests use Pulumi mocks - no real cloud calls during testing
- Workflow file updates are sequential (same file)
- Old scripts/deploy/ code removed only after new approach validated
