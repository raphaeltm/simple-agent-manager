# Tasks: DO Message Parity with Agent Stream

**Input**: Design documents from `/specs/025-do-message-parity/`
**Prerequisites**: plan.md (required), spec.md (required for user stories)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)

---

## Phase 1: VM Agent — Enhanced Message Extraction (Go)

**Purpose**: Enhance `ExtractMessages()` to capture all message types with full content

### US1: Tool Call Fidelity

- [ ] T001 [US1] Enhance `ToolContentItem` struct in `packages/vm-agent/internal/acp/message_extract.go` — add `OldText`, `NewText`, `Path` fields for diff content
- [ ] T002 [US1] Add `ToolCallId` field to `ToolMeta` struct in `packages/vm-agent/internal/acp/message_extract.go`
- [ ] T003 [US1] Update `extractStructuredContent()` to include actual diff content (`OldText`, `NewText`) from `ToolCallContentDiff`, with size cap from `MAX_TOOL_CONTENT_SIZE` env var (default 100KB)
- [ ] T004 [US1] Update `ExtractMessages()` to populate `ToolMeta.ToolCallId` from `u.ToolCall.ToolCallId` and `u.ToolCallUpdate.ToolCallId`
- [ ] T005 [P] [US1] Update tests in `packages/vm-agent/internal/acp/message_extract_test.go` for enhanced tool call extraction (diff content, toolCallId)

### US2: Thinking Block Extraction

- [ ] T006 [US2] Add `agent_thought_chunk` extraction to `ExtractMessages()` — emit `role:"thinking"` messages with thought text content
- [ ] T007 [P] [US2] Add tests for thinking block extraction in `message_extract_test.go`

### US3: Plan Extraction

- [ ] T008 [US3] Add `plan` extraction to `ExtractMessages()` — emit `role:"plan"` messages with JSON-serialized plan entries as content
- [ ] T009 [P] [US3] Add tests for plan extraction in `message_extract_test.go`

**Checkpoint**: VM agent now extracts all message types with full content. Run `go test ./internal/acp/...`

---

## Phase 2: Shared Types (TypeScript)

**Purpose**: Update shared types to support new message roles

- [ ] T010 [P] Update `ChatMessage` type in `packages/shared/src/types.ts` if role is typed as a union — add `"thinking"` and `"plan"` to the role union type

**Checkpoint**: Shared types updated. Run `pnpm --filter @simple-agent-manager/shared build`

---

## Phase 3: Frontend — Enhanced Message Conversion

**Purpose**: Update `chatMessagesToConversationItems()` to handle new roles and deduplicate tool calls

### US1: Tool Call Deduplication

- [ ] T011 [US1] Update `chatMessagesToConversationItems()` in `apps/web/src/components/chat/ProjectMessageView.tsx` to deduplicate tool messages by `toolMetadata.toolCallId` — merge updates into a single `ToolCallItem` with latest status/content
- [ ] T012 [US1] Update diff rendering in tool call cards to display `oldText`/`newText` from enriched `ToolContentItem` metadata (verify `ToolCallCard` component handles the new fields)
- [ ] T013 [P] [US1] Add tests for tool call deduplication in ProjectMessageView conversion

### US2: Thinking Block Rendering

- [ ] T014 [US2] Add `role === "thinking"` handling in `chatMessagesToConversationItems()` — convert to `ThinkingItem` with `streaming: false`, text from `msg.content`
- [ ] T015 [P] [US2] Add tests for thinking block conversion

### US3: Plan Rendering

- [ ] T016 [US3] Add `role === "plan"` handling in `chatMessagesToConversationItems()` — parse `msg.content` as JSON plan entries, convert to `PlanItem`
- [ ] T017 [P] [US3] Add tests for plan conversion

**Checkpoint**: Frontend renders all message types. Run `pnpm --filter @simple-agent-manager/web test`

---

## Phase 4: Integration & Polish

**Purpose**: End-to-end verification and cleanup

- [ ] T018 Run full quality suite: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- [ ] T019 Verify no regressions in workspace chat (direct ACP path unchanged)
- [ ] T020 Update task file with implementation notes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1** (VM Agent Go): No dependencies — start immediately
- **Phase 2** (Shared Types): Can run in parallel with Phase 1
- **Phase 3** (Frontend): Depends on Phase 2 for type definitions, but implementation can start concurrently since the new role values are just strings
- **Phase 4** (Integration): Depends on all prior phases

### Within Each Phase

- T001–T004 are sequential (modifying same struct/functions)
- T005, T007, T009 are parallel (separate test cases)
- T010 is independent
- T011–T012 are sequential, T013 parallel (tests)
- T014–T017 are parallel (different role handlers)

### Parallel Opportunities

```
Phase 1 (Go)          Phase 2 (TS types)
T001→T002→T003→T004   T010 (parallel)
   T005 (parallel)
   T006→T007 (parallel)
   T008→T009 (parallel)
         ↓
      Phase 3 (Frontend)
T011→T012  T014  T016
  T013     T015  T017
         ↓
      Phase 4 (Integration)
T018→T019→T020
```
