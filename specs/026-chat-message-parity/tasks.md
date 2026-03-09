# Tasks: Chat Message Display Parity

**Input**: Design documents from `/specs/026-chat-message-parity/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: No setup needed — this feature modifies existing packages only. No new projects, dependencies, or infrastructure.

(No tasks in this phase)

---

## Phase 2: Foundational (Shared Components)

**Purpose**: Create shared components in acp-client that both workspace and project views will use

- [ ] T001 [P] Create shared PlanView component in `packages/acp-client/src/components/PlanView.tsx` — extract plan rendering from AgentPanel.tsx lines 480-497 into a standalone exported component
- [ ] T002 [P] Create shared RawFallbackView component in `packages/acp-client/src/components/RawFallbackView.tsx` — extract raw fallback rendering from AgentPanel.tsx lines 498-506 into a standalone exported component
- [ ] T003 Export PlanView and RawFallbackView from `packages/acp-client/src/components/index.ts` (or the package's main export barrel)

**Checkpoint**: New shared components exist and are exported from acp-client

---

## Phase 3: User Story 1 - Consistent Tool Call Display (Priority: P1)

**Goal**: Fix tool call content data field population so project chat displays equivalent information to workspace chat

**Independent Test**: Render a tool call with diff, terminal, and text content types in project chat and verify all content is visible (not silently hidden)

### Tests for User Story 1

- [ ] T004 [P] [US1] Add test for `chatMessagesToConversationItems()` verifying `data` field is populated for ALL content types (diff, terminal, content) in `apps/web/src/components/chat/ProjectMessageView.test.tsx`
- [ ] T005 [P] [US1] Add test for `chatMessagesToConversationItems()` verifying tool call content items match the structure produced by `mapToolCallContent()` in workspace chat, in `apps/web/src/components/chat/ProjectMessageView.test.tsx`

### Implementation for User Story 1

- [ ] T006 [US1] Fix `chatMessagesToConversationItems()` in `apps/web/src/components/chat/ProjectMessageView.tsx` — populate `data` field for terminal and content types (not just diff), passing through the structured content object from toolMetadata
- [ ] T007 [US1] Verify text field population in `chatMessagesToConversationItems()` is consistent — ensure `text` uses the Go extraction's `ToolContentItem.Text` properly for all content types in `apps/web/src/components/chat/ProjectMessageView.tsx`

**Checkpoint**: Tool call content renders equivalently in project and workspace views

---

## Phase 4: User Story 2 - Consistent Plan Rendering (Priority: P2)

**Goal**: Replace duplicated plan rendering code with the shared PlanView component

**Independent Test**: View a plan in both workspace and project chat and verify identical visual output

### Tests for User Story 2

- [ ] T008 [P] [US2] Add unit test for PlanView component verifying it renders entries with correct status indicators (pending/in-progress/completed) and strikethrough for completed entries in `packages/acp-client/src/components/PlanView.test.tsx`

### Implementation for User Story 2

- [ ] T009 [US2] Replace inline plan rendering in AgentPanel's ConversationItemView with PlanView component in `packages/acp-client/src/components/AgentPanel.tsx`
- [ ] T010 [US2] Replace inline plan rendering in AcpConversationItemView with PlanView component in `apps/web/src/components/chat/ProjectMessageView.tsx`

**Checkpoint**: Both views render plans via the same shared component

---

## Phase 5: User Story 3 - Unknown Message Type Visibility (Priority: P3)

**Goal**: Render raw fallback messages in project chat instead of silently dropping them

**Independent Test**: Create a ConversationItem with `kind: 'raw_fallback'` and verify it renders in project chat

### Tests for User Story 3

- [ ] T011 [P] [US3] Add unit test verifying AcpConversationItemView renders raw_fallback items using RawFallbackView in `apps/web/src/components/chat/ProjectMessageView.test.tsx`

### Implementation for User Story 3

- [ ] T012 [US3] Replace `case 'raw_fallback': return null` with RawFallbackView rendering in AcpConversationItemView in `apps/web/src/components/chat/ProjectMessageView.tsx`

**Checkpoint**: Unknown message types render visibly in project chat

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T013 Run `pnpm typecheck` and fix any type errors across changed packages
- [ ] T014 Run `pnpm lint` and fix any lint issues
- [ ] T015 Run `pnpm test` and verify all existing tests still pass
- [ ] T016 [P] Run `pnpm build` to verify build succeeds for acp-client and web packages

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 2)**: No dependencies — can start immediately
- **US1 (Phase 3)**: No dependencies on Phase 2 (different files)
- **US2 (Phase 4)**: Depends on T001, T003 (PlanView must exist and be exported)
- **US3 (Phase 5)**: Depends on T002, T003 (RawFallbackView must exist and be exported)
- **Polish (Phase 6)**: Depends on all implementation phases

### Parallel Opportunities

- T001 and T002 can run in parallel (different new files)
- T004 and T005 can run in parallel (same test file but independent test cases)
- T006 can run in parallel with T001/T002 (different files)
- T008 and T011 can run in parallel (different test files)
- T009 and T010 can run in parallel (different files, both depend on T001)

---

## Parallel Example: Foundational + US1

```bash
# These can all run in parallel (different files):
Task T001: "Create PlanView in packages/acp-client/src/components/PlanView.tsx"
Task T002: "Create RawFallbackView in packages/acp-client/src/components/RawFallbackView.tsx"
Task T006: "Fix data field in apps/web/src/components/chat/ProjectMessageView.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete T006-T007 (fix tool call content data field)
2. **STOP and VALIDATE**: Run tests, verify tool calls display identically
3. This alone fixes the most impactful parity gap

### Full Delivery

1. T001-T003: Create shared components (foundational)
2. T004-T007: Fix tool call content (US1 - most impactful)
3. T008-T010: Unify plan rendering (US2)
4. T011-T012: Enable raw fallback rendering (US3)
5. T013-T016: Quality checks

---

## Notes

- Total tasks: 16
- Tasks per story: US1=4, US2=3, US3=2, Foundational=3, Polish=4
- All changes are frontend-only — no API or database changes
- acp-client package must be built before web app for import resolution
- Commit after each phase checkpoint
