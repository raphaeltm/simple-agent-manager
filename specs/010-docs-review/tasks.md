# Tasks: Documentation Review and Update

**Input**: Design documents from `/specs/010-docs-review/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md

**Tests**: Not applicable - this is a documentation-only review with no automated test suite.

**Organization**: Tasks are grouped by user story to enable independent execution and verification.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Verify inventory completeness and establish review baseline

- [x] T001 Verify document inventory in specs/010-docs-review/research.md covers all in-scope markdown files
- [x] T002 Confirm all 11 grade-A documents listed in research.md truly need no changes by spot-checking 3 of them

**Checkpoint**: Inventory verified, review scope confirmed

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Fix broken references that block other document updates

**Warning**: These fixes must be completed first because other tasks reference or link to these files.

- [x] T003 Remove broken reference to non-existent `docs/architecture/access-control.md` in docs/architecture/credential-security.md (line 170)
- [x] T004 [P] Remove broken reference to non-existent `docs/architecture/access-control.md` in docs/guides/self-hosting.md (N/A - reference not found in this file)

**Checkpoint**: All broken internal links resolved - document updates can now proceed

---

## Phase 3: User Story 1 - Document Inventory and Assessment (Priority: P1) MVP

**Goal**: Catalog all markdown documents with categories, audiences, and grades

**Independent Test**: Verify research.md contains a complete inventory with all in-scope documents categorized, graded, and audience-tagged

### Implementation for User Story 1

> Note: The inventory was completed during Phase 0 (research). These tasks formalize and verify the results.

- [x] T005 [US1] Review and finalize document-level assessment tables in specs/010-docs-review/research.md ensuring all ~35 in-scope documents are listed
- [x] T006 [US1] Verify data-model.md document categories match actual file locations in specs/010-docs-review/data-model.md

**Checkpoint**: Complete inventory exists with categories, audiences, grades for all in-scope documents

---

## Phase 4: User Story 2 - Content Accuracy Verification (Priority: P1)

**Goal**: Fix all inaccurate content so documentation reflects the current codebase

**Independent Test**: After all fixes, every document's code references, API endpoints, file paths, and feature descriptions match the actual codebase

### Critical Inaccuracies (Grade D documents)

- [x] T007 [US2] Rewrite docs/guides/getting-started.md: replace CloudCLI references with VM Agent terminal, update all API endpoints from `/vms` to `/api/workspaces`, update authentication flow to BetterAuth, remove references to removed features
- [x] T008 [P] [US2] Mark docs/adr/002-stateless-architecture.md as SUPERSEDED: add status banner at top explaining the project now uses Cloudflare D1, link to current database schema, preserve original content as historical record

### Research Document Disclaimers (Grade D/D+ documents)

- [x] T009 [P] [US2] Add historical disclaimer banner to research/README.md indicating this is early research and linking to current docs/architecture/ for actual architecture
- [x] T010 [P] [US2] Add historical disclaimer banner to research/architecture-notes.md noting ttyd/CloudCLI/Happy Coder references are obsolete, current terminal is Go VM Agent with embedded xterm.js
- [x] T011 [P] [US2] Add historical disclaimer banner to research/ai-agent-optimizations.md noting CloudCLI implementation sections are obsolete
- [x] T012 [P] [US2] Add historical disclaimer banner to research/dns-security-persistence-plan.md noting R2 persistence features are not yet implemented (Planned: Phase 3 per ROADMAP)
- [x] T013 [P] [US2] Add historical disclaimer banner to research/browser-terminal-options.md noting terminal solution has been decided and implemented as VM Agent
- [x] T014 [P] [US2] Add implementation status annotations to research/multi-tenancy-interfaces.md indicating which design proposals have been implemented vs. remain planned

### Outdated Content (Grade B/B- documents)

- [x] T015 [P] [US2] Update docs/adr/001-monorepo-structure.md: add missing packages (cloud-init, terminal, ui, vm-agent, acp-client) to directory structure and dependency diagram
- [x] T016 [P] [US2] Update ROADMAP.md: mark completed Phase 2 items as done, add references to specs 006-009 (Multi-Agent ACP, Git Credential Refresh, UI System Standards), verify Phase 3 target dates
- [x] T017 [P] [US2] Update CONTRIBUTING.md: add complete project structure showing all 7 packages, add Go development section for VM Agent, mention agent preflight requirements for AI-assisted PRs
- [x] T018 [P] [US2] Update README.md: replace `YOUR_ORG` placeholder in clone URL with actual GitHub org or standardized `your-org`, verify all referenced commands exist in package.json
- [x] T019 [P] [US2] Fix docs/architecture/credential-security.md: after T003 removes broken link, verify remaining content accuracy against actual encryption implementation

**Checkpoint**: All critical and major accuracy issues resolved. Every document's technical content matches the codebase.

---

## Phase 5: User Story 3 - Audience Appropriateness Review (Priority: P2)

**Goal**: Ensure each document's language, tone, and technical depth match its target audience

**Independent Test**: Review each document category and verify tone is appropriate: end-user docs avoid jargon, developer docs include technical detail, contributor docs are welcoming

### Implementation for User Story 3

- [x] T020 [US3] Review docs/guides/getting-started.md (after T007 rewrite) for new-user appropriateness: ensure no unexplained jargon, clear step-by-step flow, prerequisites explained
- [x] T021 [P] [US3] Review docs/guides/self-hosting.md for end-user appropriateness: verify instructions are complete and self-contained, add context for technical terms
- [x] T022 [P] [US3] Review docs/guides/deployment-troubleshooting.md for DevOps audience: verify diagnostic commands are accurate, error scenarios are realistic
- [x] T023 [P] [US3] Review AGENTS.md for AI agent audience: verify instructions are precise and unambiguous, file paths are correct, build/test commands match package.json
- [x] T024 [US3] Review packages/ui/README.md for developer audience: assess if enough detail is provided for a developer to use the package without external help

**Checkpoint**: All documents use tone and depth appropriate for their target audience

---

## Phase 6: User Story 4 - Documentation Gap Identification (Priority: P2)

**Goal**: Identify and document missing documentation for features that lack it

**Independent Test**: Compare list of project features/packages against documentation coverage; all critical gaps are identified and either filled or tracked

### Implementation for User Story 4

- [x] T025 [US4] Assess documentation coverage for packages missing READMEs: check packages/acp-client/, packages/cloud-init/, packages/providers/, packages/shared/, packages/terminal/, packages/vm-agent/ for README.md files and note which need creation
- [x] T026 [P] [US4] Assess documentation coverage for VM Agent architecture: determine if docs/architecture/ needs a vm-agent.md describing the Go binary, PTY management, WebSocket protocol, and embedded UI
- [x] T027 [P] [US4] Assess whether AGENTS.md accurately documents all current packages, build commands, and test commands by cross-referencing with actual package.json scripts and directory structure
- [x] T028 [US4] Create a documentation gaps summary in specs/010-docs-review/research.md appendix listing all identified gaps with priority and suggested action (create new doc vs. expand existing doc)

**Checkpoint**: All documentation gaps identified and cataloged with priorities

---

## Phase 7: User Story 5 - Style and Formatting Consistency (Priority: P3)

**Goal**: Ensure consistent formatting, placeholder patterns, and structural conventions across all documents

**Independent Test**: All documents use standardized placeholders, consistent heading styles, and working internal links

### Implementation for User Story 5

- [x] T029 [P] [US5] Standardize placeholder patterns in README.md: use `example.com` for domains, `your-org` for GitHub org references
- [x] T030 [P] [US5] Standardize placeholder patterns in docs/guides/self-hosting.md: replace all `YOUR_DOMAIN`, `YOUR_ORG` variants with consistent lowercase `example.com` and `your-org`
- [x] T031 [P] [US5] Standardize placeholder patterns in docs/guides/deployment-troubleshooting.md: replace all `YOUR_DOMAIN` variants with consistent `example.com`
- [x] T032 [P] [US5] Standardize placeholder patterns in docs/guides/getting-started.md (after T007/T020): ensure all placeholders follow the standard pattern
- [x] T033 [P] [US5] Validate all internal markdown links across docs/ directory: check that every `[text](path)` link resolves to an existing file
- [x] T034 [US5] Review heading hierarchy consistency across all docs/guides/ files: ensure H1 for title, H2 for sections, H3 for subsections pattern is followed

**Checkpoint**: All documents follow consistent formatting and placeholder conventions

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Generate final review report and verify all changes

- [x] T035 Update specs/010-docs-review/research.md with final document grades after all fixes are applied
- [x] T036 Create a summary of all changes made during this review as a new section in specs/010-docs-review/research.md listing: files changed, issues fixed, issues deferred, remaining gaps
- [x] T037 Verify no document edits inadvertently broke file paths referenced by CLAUDE.md, AGENTS.md, or .claude/ agent configurations
- [x] T038 Update specs/010-docs-review/checklists/requirements.md to reflect final completion status of all review criteria

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 - fixes broken links that block other tasks
- **US1 (Phase 3)**: Depends on Phase 1 - verifies inventory
- **US2 (Phase 4)**: Depends on Phase 2 (broken link fixes) - bulk of the work
- **US3 (Phase 5)**: Depends on Phase 4 (T007 getting-started rewrite must be done first)
- **US4 (Phase 6)**: Can start after Phase 2 - independent of US2/US3
- **US5 (Phase 7)**: Depends on Phase 4 and Phase 5 (placeholder fixes should come after content rewrites)
- **Polish (Phase 8)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: Independent - already largely complete from research phase
- **US2 (P1)**: Depends on Foundational (broken link fixes). Most tasks are parallelizable (different files)
- **US3 (P2)**: Depends on US2's T007 (getting-started rewrite) for T020. Other tasks are independent.
- **US4 (P2)**: Independent of US2/US3 - can run in parallel with them
- **US5 (P3)**: Depends on US2 content rewrites completing first (placeholder fixes after content changes)

### Within Each User Story

- Research document disclaimers (T009-T014) are fully parallelizable
- Outdated content fixes (T015-T019) are fully parallelizable
- Audience review tasks (T020-T024) are mostly parallelizable except T020 depends on T007
- Gap assessment tasks (T025-T028) are mostly parallelizable except T028 depends on T025-T027
- Formatting tasks (T029-T034) are fully parallelizable except T032 depends on T007/T020

### Parallel Opportunities

Within US2, launch all research disclaimers together:
```
T009, T010, T011, T012, T013, T014 (6 parallel tasks - all different files)
```

Within US2, launch all outdated content fixes together:
```
T015, T016, T017, T018 (4 parallel tasks - all different files)
```

Within US5, launch all placeholder standardizations together:
```
T029, T030, T031 (3 parallel tasks - all different files)
```

US4 can run entirely in parallel with US2 and US3.

---

## Implementation Strategy

### MVP First (US1 + US2 Critical Only)

1. Complete Phase 1: Setup verification
2. Complete Phase 2: Fix broken links (T003, T004)
3. Complete Phase 4 critical tasks: T007 (getting-started rewrite), T008 (ADR 002 superseded)
4. **STOP and VALIDATE**: Most impactful accuracy issues fixed
5. This alone fixes the 3 highest-impact problems

### Incremental Delivery

1. Setup + Foundational → Broken links fixed
2. Add US1 → Inventory verified
3. Add US2 → All accuracy issues fixed (highest value)
4. Add US3 → Audience appropriateness verified
5. Add US4 → Documentation gaps identified
6. Add US5 → Formatting standardized
7. Polish → Final report generated

### Parallel Strategy

With multiple agents/developers:
1. Complete Setup + Foundational together
2. Once foundational is done:
   - Agent A: US2 critical tasks (T007, T008)
   - Agent B: US2 research disclaimers (T009-T014)
   - Agent C: US4 gap assessment (T025-T028)
3. After US2 critical tasks complete:
   - Agent A: US3 audience review (T020-T024)
   - Agent B: US2 outdated content (T015-T019)
   - Agent C: US5 formatting (T029-T034)
4. Final: Polish phase (T035-T038)

---

## Notes

- [P] tasks = different files, no dependencies between them
- [Story] label maps task to specific user story for traceability
- Research documents get disclaimers rather than rewrites (preserving historical value)
- Grade-A documents (11 files) are excluded from tasks - no changes needed
- Spec files (specs/001-009/) are out of scope - historical records not modified
- Commit after each task or logical group of parallel tasks
- Stop at any checkpoint to validate story independently
