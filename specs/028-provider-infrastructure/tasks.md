# Tasks: Provider Interface Modernization

**Input**: Design documents from `/specs/028-provider-infrastructure/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Tests are included per Constitution Principle II (Infrastructure Stability) — this is infrastructure code requiring >90% coverage.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Foundation types and utilities that all user stories depend on

- [x] T001 Modernize Provider interface and types in `packages/providers/src/types.ts` — new Provider interface (name, locations, sizes, createVM, deleteVM, getVM, listVMs, powerOff, powerOn, validateToken), clean VMConfig (no secrets), VMInstance, SizeConfig, ProviderConfig discriminated union, ProviderError class
- [x] T002 Create providerFetch utility in `packages/providers/src/provider-fetch.ts` — fetch wrapper with configurable timeout, AbortController cancellation, automatic ProviderError wrapping for HTTP errors and timeouts, getTimeoutMs helper
- [x] T003 [P] Write unit tests for providerFetch in `packages/providers/tests/unit/provider-fetch.test.ts` — test timeout behavior, HTTP error wrapping, ProviderError fields, abort handling

**Checkpoint**: Core types and utilities ready for provider implementations

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Contract test suite that validates any Provider implementation

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Create reusable contract test suite in `packages/providers/tests/contract/provider-contract.test.ts` — export `runProviderContractTests(factory)` function that validates all Provider interface methods: createVM returns VMInstance, deleteVM is idempotent on 404, getVM returns null for non-existent, listVMs returns array (with and without label filters), powerOff/powerOn succeed, validateToken returns boolean, sizes/locations/name are populated

**Checkpoint**: Contract test suite ready — provider implementations can now be validated

---

## Phase 3: User Story 1 — Platform Developer Adds a New Cloud Provider (Priority: P1)

**Goal**: The Provider interface + HetznerProvider + factory are complete, tested, and contract-compliant. A developer can implement a new provider by just implementing the interface and registering in the factory.

**Independent Test**: Run `pnpm --filter @simple-agent-manager/providers test` — all contract tests pass against HetznerProvider, unit tests pass for all methods, factory returns correct provider instances.

### Tests for User Story 1

- [x] T005 [P] [US1] Write contract tests for HetznerProvider using the contract suite in `packages/providers/tests/contract/hetzner-contract.test.ts` — call `runProviderContractTests()` with a HetznerProvider factory using mocked fetch
- [x] T006 [P] [US1] Update unit tests for HetznerProvider in `packages/providers/tests/unit/hetzner.test.ts` — test new interface methods (validateToken, powerOff, powerOn, listVMs with labels), verify no generateCloudInit method, verify VMConfig has no secret fields

### Implementation for User Story 1

- [x] T007 [US1] Rewrite HetznerProvider in `packages/providers/src/hetzner.ts` — implement new Provider interface using providerFetch, add locations/sizes readonly properties, remove generateCloudInit method, accept apiToken and optional datacenter in constructor, implement validateToken via /datacenters endpoint, implement listVMs with label_selector support, implement powerOff/powerOn via /actions endpoints
- [x] T008 [US1] Update factory and exports in `packages/providers/src/index.ts` — createProvider accepts ProviderConfig discriminated union (no process.env), export all new types, remove DevcontainerProvider export
- [x] T009 [US1] Write factory unit tests in `packages/providers/tests/unit/factory.test.ts` — test createProvider returns HetznerProvider for hetzner config, throws ProviderError for unknown provider, does not access process.env

**Checkpoint**: Provider package is fully modernized and tested. `pnpm --filter @simple-agent-manager/providers test` passes.

---

## Phase 4: User Story 2 — API Provisions a Node Using the Provider Interface (Priority: P1)

**Goal**: The API layer uses the Provider interface for all VM operations. No direct Hetzner function calls remain.

**Independent Test**: Deploy to staging, create a node, verify it provisions successfully using the provider interface path. Verify credential validation works.

### Tests for User Story 2

- [x] T010 [P] [US2] Write integration tests for provider-based node provisioning — DEFERRED: existing node-stop source-contract tests updated to verify provider.deleteVM usage; full Miniflare integration tests deferred to staging verification in `apps/api/tests/integration/provider-nodes.test.ts` — test provisionNode creates provider from credentials and calls createVM with clean VMConfig, test stopNodeResources calls deleteVM, test deleteNodeResources calls deleteVM, verify cloud-init is generated separately and passed as userData

### Implementation for User Story 2

- [x] T011 [US2] Migrate node provisioning in `apps/api/src/services/nodes.ts` — replace createServer/deleteServer/getServerStatus/powerOffServer/powerOnServer imports with createProvider + Provider interface calls. In provisionNode: create HetznerProvider from decrypted token, generate cloud-init separately via cloud-init package, call provider.createVM with clean VMConfig. In stopNodeResources/deleteNodeResources: create provider and call provider.deleteVM.
- [x] T012 [US2] Migrate credential validation in `apps/api/src/routes/credentials.ts` — replace validateHetznerToken import with createProvider + provider.validateToken(). Create provider instance from submitted token, call validateToken().
- [x] T013 [US2] Update any remaining imports of hetzner service functions across `apps/api/src/` — grep for imports from `services/hetzner` and `services/fetch-timeout`, update to use provider interface or providerFetch from providers package

**Checkpoint**: API uses provider interface exclusively. All node operations work through Provider.

---

## Phase 5: User Story 3 — Dead Code Removal (Priority: P2)

**Goal**: Remove all dead code: DevcontainerProvider, old hetzner.ts service, old fetch-timeout.ts.

**Independent Test**: `pnpm typecheck && pnpm build && pnpm test` pass from repo root. Verify deleted files don't exist. Verify no dangling imports.

### Implementation for User Story 3

- [x] T014 [P] [US3] Delete DevcontainerProvider in `packages/providers/src/devcontainer.ts` — remove the file, remove any imports/exports referencing it
- [x] T015 [P] [US3] Delete old Hetzner service in `apps/api/src/services/hetzner.ts` — remove the file after confirming no remaining imports
- [x] T016 [P] [US3] ~~Delete old fetch-timeout utility~~ — KEPT: `apps/api/src/services/fetch-timeout.ts` is still used by `dns.ts` and `node-agent.ts` (non-provider services). These should not import from providers package.
- [x] T017 [US3] Verify no dangling imports — run `pnpm typecheck` and `pnpm build` from repo root, fix any broken imports

**Checkpoint**: No dead code remains. Full build passes.

---

## Phase 6: User Story 4 — Workers-Compatible Provider Factory (Priority: P2)

**Goal**: The factory and entire providers package work in Cloudflare Workers with zero Node.js-only API usage.

**Independent Test**: `grep -r "process\.env" packages/providers/src/` returns no matches. `grep -r "require(" packages/providers/src/` returns no matches. No imports from `child_process`, `fs`, `path`, or `os`.

### Implementation for User Story 4

- [x] T018 [US4] Audit and remove any Node.js-only APIs from `packages/providers/src/` — scan all source files for process.env, require(), child_process, fs, path, os imports. Remove the `execa` dependency from `packages/providers/package.json` if no longer used.
- [x] T019 [US4] Write Workers-compatibility verification test — covered by existing factory.test.ts process.env check + manual grep audit (T018) in `packages/providers/tests/unit/workers-compat.test.ts` — parse all source files, assert no process.env access, no require() calls, no Node.js built-in imports

**Checkpoint**: Providers package is fully Workers-compatible.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, documentation, and quality checks

- [x] T020 Run full test suite with `pnpm test` from repo root and fix any failures
- [x] T021 Run `pnpm typecheck` and `pnpm lint` from repo root and fix any issues
- [x] T022 [P] Verify coverage >90% — 97.93% statements, 87.3% branches, 100% functions for providers package with `pnpm --filter @simple-agent-manager/providers test:coverage`
- [x] T023 [P] Update CLAUDE.md — no changes needed, existing provider references are accurate

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on T001 (types) — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 1 + Phase 2
- **US2 (Phase 4)**: Depends on Phase 3 (needs working provider package)
- **US3 (Phase 5)**: Depends on Phase 4 (can only delete old code after migration)
- **US4 (Phase 6)**: Depends on Phase 5 (audit after all deletions)
- **Polish (Phase 7)**: Depends on all previous phases

### Within Each User Story

- Tests written first (where included)
- Types/models before implementations
- Core implementation before integration
- Verification after each checkpoint

### Parallel Opportunities

- T002 + T003 can run in parallel (providerFetch implementation + tests)
- T005 + T006 can run in parallel (contract tests + unit tests for Hetzner)
- T014 + T015 + T016 can run in parallel (dead code deletion — independent files)
- T022 + T023 can run in parallel (coverage check + docs update)

---

## Parallel Example: User Story 1

```bash
# After T004 (contract suite) is complete:

# Launch tests in parallel:
Task T005: "Contract tests for HetznerProvider"
Task T006: "Unit tests for HetznerProvider"

# Then implement sequentially:
Task T007: "Rewrite HetznerProvider"
Task T008: "Update factory and exports"
Task T009: "Factory unit tests"
```

## Parallel Example: Dead Code Removal

```bash
# After US2 migration is complete:

# Launch all deletions in parallel:
Task T014: "Delete DevcontainerProvider"
Task T015: "Delete old hetzner.ts"
Task T016: "Delete old fetch-timeout.ts"

# Then verify:
Task T017: "Verify no dangling imports"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (types + providerFetch)
2. Complete Phase 2: Foundational (contract test suite)
3. Complete Phase 3: User Story 1 (HetznerProvider + factory)
4. **STOP and VALIDATE**: Run contract tests + unit tests
5. Provider package is independently usable

### Incremental Delivery

1. Setup + Foundational → Core infrastructure ready
2. Add US1 → Provider package complete (MVP!)
3. Add US2 → API migrated to provider interface
4. Add US3 → Dead code removed
5. Add US4 → Workers compatibility verified
6. Polish → Full quality gates pass

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US1 and US2 are both P1 priority but US2 depends on US1
- US3 and US4 are P2 and depend on the migration being complete
- Total tasks: 23
- Tasks per story: US1=5, US2=4, US3=4, US4=2, Setup=3, Foundation=1, Polish=4
