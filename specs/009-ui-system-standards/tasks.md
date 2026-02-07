# Tasks: Unified UI System Standards

**Input**: Design documents from `/specs/009-ui-system-standards/`  
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: The feature spec does not explicitly request TDD-first implementation, so this task list prioritizes implementation and validation gates rather than test-first tasks.

**Organization**: Tasks are grouped by user story so each story can be implemented and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Parallelizable task (different files, no blocking dependency)
- **[Story]**: User story label (`[US1]`, `[US2]`, `[US3]`)
- Every task includes an exact file path

## Phase 1: Setup (Research-Backed Foundation)

**Purpose**: Finalize framework fit and scaffold the shared UI package.

- [X] T001 Create framework fit matrix from current web research in `specs/009-ui-system-standards/framework-fit.md`
- [X] T002 Record final stack decision and alternatives in `docs/adr/003-ui-system-stack.md`
- [X] T003 Create shared UI package manifest in `packages/ui/package.json`
- [X] T004 [P] Create TypeScript config for shared UI package in `packages/ui/tsconfig.json`
- [X] T005 [P] Create shared UI package entrypoint in `packages/ui/src/index.ts`
- [X] T006 [P] Create shared UI stylesheet entrypoint in `packages/ui/src/styles.css`
- [X] T007 Create shared UI package usage guide in `packages/ui/README.md`
- [X] T008 Add root scripts for shared UI build/typecheck in `package.json`
- [X] T009 Create canonical UI standards guide scaffold in `docs/guides/ui-standards.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Build infrastructure required by all user stories.

**⚠️ CRITICAL**: No user story implementation starts until this phase is complete.

- [X] T010 Add UI governance tables migration in `apps/api/src/db/migrations/0004_ui_governance.sql`
- [X] T011 Extend governance entities in `apps/api/src/db/schema.ts`
- [X] T012 Create governance service scaffold in `apps/api/src/services/ui-governance.ts`
- [X] T013 [P] Add governance request validation schemas in `apps/api/src/routes/ui-governance.schemas.ts`
- [X] T014 [P] Create governance route scaffold in `apps/api/src/routes/ui-governance.ts`
- [X] T015 Register UI governance routes in `apps/api/src/index.ts`
- [X] T016 Create governance API client for web UI in `apps/web/src/lib/ui-governance.ts`
- [X] T017 Create semantic token source module in `packages/ui/src/tokens/semantic-tokens.ts`
- [X] T018 Create theme CSS variable export in `packages/ui/src/tokens/theme.css`
- [X] T019 Integrate shared theme tokens into control plane CSS in `apps/web/src/index.css`
- [X] T020 Integrate shared theme tokens into agent UI bootstrap in `packages/vm-agent/ui/src/main.tsx`
- [X] T021 Export token modules from shared package barrel in `packages/ui/src/index.ts`

**Checkpoint**: Foundation complete; US1, US2, and US3 can proceed.

---

## Phase 3: User Story 1 - Define a Unified Visual Standard (Priority: P1) 🎯 MVP

**Goal**: Publish and expose one authoritative visual standard with mobile-first and accessibility rules.

**Independent Test**: Open the standard in control plane and verify the published guidance defines theme direction, responsive behavior, accessibility requirements, and approval criteria with no ambiguity.

- [X] T022 [US1] Implement active-standard read handler (`GET /standards/active`) in `apps/api/src/routes/ui-governance.ts`
- [X] T023 [US1] Implement standard upsert handler (`PUT /standards/:version`) in `apps/api/src/routes/ui-governance.ts`
- [X] T024 [US1] Implement `UIStandard` and `ThemeTokenSet` data methods in `apps/api/src/services/ui-governance.ts`
- [X] T025 [P] [US1] Create typography primitives for standard-compliant text usage in `packages/ui/src/primitives/Typography.tsx`
- [X] T026 [P] [US1] Create responsive container primitives with mobile-first defaults in `packages/ui/src/primitives/Container.tsx`
- [X] T027 [US1] Document green-forward visual system rules in `docs/guides/ui-standards.md`
- [X] T028 [US1] Document accessibility and responsive acceptance rules in `docs/guides/ui-standards.md`
- [X] T029 [US1] Create standards management page in `apps/web/src/pages/UiStandards.tsx`
- [X] T030 [US1] Register standards route and nav link in `apps/web/src/App.tsx`
- [X] T031 [US1] Add 56px touch-target and 320px reflow enforcement examples in `docs/guides/mobile-ux-guidelines.md`

**Checkpoint**: US1 is complete and independently demonstrable.

---

## Phase 4: User Story 2 - Reuse One Shared Component Library (Priority: P2)

**Goal**: Deliver reusable shared components consumed by both control plane and agent UI.

**Independent Test**: Build one representative workflow in each UI surface using shared components and confirm consistent appearance and behavior.

- [X] T032 [US2] Implement component list/create handlers (`GET/POST /components`) in `apps/api/src/routes/ui-governance.ts`
- [X] T033 [US2] Implement component read/update handlers (`GET/PUT /components/:componentId`) in `apps/api/src/routes/ui-governance.ts`
- [X] T034 [US2] Implement migration item handlers (`POST/PATCH /migration-items`) in `apps/api/src/routes/ui-governance.ts`
- [X] T035 [US2] Implement `ComponentDefinition` and `MigrationWorkItem` methods in `apps/api/src/services/ui-governance.ts`
- [X] T036 [P] [US2] Create shared button component with required states in `packages/ui/src/components/Button.tsx`
- [X] T037 [P] [US2] Create shared input component with required states in `packages/ui/src/components/Input.tsx`
- [X] T038 [P] [US2] Create shared card component in `packages/ui/src/components/Card.tsx`
- [X] T039 [P] [US2] Create shared status badge component in `packages/ui/src/components/StatusBadge.tsx`
- [X] T040 [US2] Export shared component index in `packages/ui/src/components/index.ts`
- [X] T041 [US2] Migrate control plane status badge usage to shared component in `apps/web/src/components/StatusBadge.tsx`
- [X] T042 [US2] Migrate create-workspace form actions to shared components in `apps/web/src/pages/CreateWorkspace.tsx`
- [X] T043 [US2] Migrate landing page CTAs to shared components in `apps/web/src/pages/Landing.tsx`
- [X] T044 [US2] Migrate agent status bar to shared component set in `packages/vm-agent/ui/src/components/StatusBar.tsx`
- [X] T045 [US2] Add migration work item management UI in `apps/web/src/pages/Settings.tsx`

**Checkpoint**: US2 is complete and independently demonstrable.

---

## Phase 5: User Story 3 - Enforce Agent-Friendly UI Rules (Priority: P3)

**Goal**: Enforce strict UI rules for both human and agent-authored changes using shared governance.

**Independent Test**: Apply agent guidance to a UI change and verify review outcomes are reproducible with the compliance checklist.

- [X] T046 [US3] Implement active agent-instructions handler (`GET /agent-instructions/active`) in `apps/api/src/routes/ui-governance.ts`
- [X] T047 [US3] Implement compliance run handlers (`POST/GET /compliance-runs`) in `apps/api/src/routes/ui-governance.ts`
- [X] T048 [US3] Implement exception request handler (`POST /exceptions`) in `apps/api/src/routes/ui-governance.ts`
- [X] T049 [US3] Implement `AgentInstructionSet`, `ComplianceRun`, and `ExceptionRequest` methods in `apps/api/src/services/ui-governance.ts`
- [X] T050 [P] [US3] Create agent-consumable UI implementation rulebook in `docs/guides/ui-agent-guidelines.md`
- [X] T051 [P] [US3] Add agent UI rule references and constraints in `AGENTS.md`
- [X] T052 [US3] Create pull-request checklist template for UI compliance in `.github/pull_request_template.md`
- [X] T053 [US3] Create CI script to validate UI compliance evidence in `scripts/ci/check-ui-compliance.mjs`
- [X] T054 [US3] Integrate UI compliance validation into CI in `.github/workflows/ci.yml`
- [X] T055 [US3] Add compliance run and exception controls in `apps/web/src/pages/Settings.tsx`
- [X] T056 [US3] Display compliance status context in agent interface in `packages/vm-agent/ui/src/App.tsx`

**Checkpoint**: US3 is complete and independently demonstrable.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Finalize documentation, component discoverability, and rollout tracking.

- [X] T057 [P] Create Storybook config for shared UI package in `packages/ui/.storybook/main.ts`
- [X] T058 [P] Add shared button component stories in `packages/ui/src/components/Button.stories.tsx`
- [X] T059 [P] Add shared status badge stories for mobile/desktop states in `packages/ui/src/components/StatusBadge.stories.tsx`
- [X] T060 Update implementation quickstart with final execution sequence in `specs/009-ui-system-standards/quickstart.md`
- [X] T061 Document end-to-end validation outcomes in `specs/009-ui-system-standards/validation-report.md`
- [X] T062 Record rollout metrics collection plan in `specs/009-ui-system-standards/metrics-plan.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 (Setup): no dependencies
- Phase 2 (Foundational): depends on Phase 1 and blocks all user stories
- Phase 3 (US1): depends on Phase 2; recommended MVP cut
- Phase 4 (US2): depends on Phase 2 and US1 standard/tokens
- Phase 5 (US3): depends on Phase 2 and US1 governance baseline
- Phase 6 (Polish): depends on completion of selected user stories

### User Story Dependency Graph

- US1 (P1) -> US2 (P2)
- US1 (P1) -> US3 (P3)
- US2 and US3 can proceed in parallel after US1 is complete

### Within-Story Ordering Rules

- Route handlers depend on service methods and validation schemas
- Shared tokens/primitives precede component migrations
- Documentation and governance updates complete before rollout sign-off

---

## Parallel Execution Examples

### US1 Parallel Example

```bash
Task: "Create typography primitives in packages/ui/src/primitives/Typography.tsx"
Task: "Create container primitives in packages/ui/src/primitives/Container.tsx"
```

### US2 Parallel Example

```bash
Task: "Create Button in packages/ui/src/components/Button.tsx"
Task: "Create Input in packages/ui/src/components/Input.tsx"
Task: "Create Card in packages/ui/src/components/Card.tsx"
Task: "Create StatusBadge in packages/ui/src/components/StatusBadge.tsx"
```

### US3 Parallel Example

```bash
Task: "Create UI agent rulebook in docs/guides/ui-agent-guidelines.md"
Task: "Add agent UI constraints in AGENTS.md"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 and Phase 2
2. Complete Phase 3 (US1)
3. Validate US1 independently via standards page + documentation review
4. Demo/approve before moving to US2 and US3

### Incremental Delivery

1. Deliver US1 as the governance and design baseline
2. Deliver US2 to drive component reuse across both UIs
3. Deliver US3 to enforce agent/human compliance uniformly
4. Finish with cross-cutting polish and rollout metrics tracking

### Parallel Team Strategy

1. Team completes Setup + Foundational together
2. After US1 completion:
   - Stream A: US2 component library and migrations
   - Stream B: US3 agent governance and CI enforcement
3. Merge both streams for final polish phase

---

## Notes

- Tasks include framework-evaluation and ADR updates to reflect deep web research outcomes before implementation.
- All tasks follow strict checklist format with IDs, optional `[P]`, required `[USx]` in story phases, and explicit file paths.
