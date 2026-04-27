# SAM Phase B: Management Tools — Complete /do Workflow

## Problem

Phase B SAM management tools (6 tools: stop_subtask, retry_subtask, send_message_to_subtask, cancel_mission, pause_mission, resume_mission) were implemented on branch `sam/sam-agent-tool-roadmap-01kq89` but never went through the full /do workflow — no PR, no reviews, no staging verification, no merge.

## Research Findings

- **Branch state**: Branch has 5 commits ahead of main's merge base (Phase B feat + Phase C/D task files + Phase D feat). Main added 2 task file commits independently.
- **Phase B tools** (6 tools in `apps/api/src/durable-objects/sam-session/tools/`):
  - `stop-subtask.ts` — stops running task via VM agent session stop + D1 status update
  - `retry-subtask.ts` — creates new task from failed/cancelled task, reuses config, starts TaskRunner DO
  - `send-message-to-subtask.ts` — sends message to running agent with mailbox fallback on busy
  - `cancel-mission.ts` — cancels mission via ProjectOrchestrator DO
  - `pause-mission.ts` — pauses mission scheduling
  - `resume-mission.ts` — resumes paused mission
- **All tools** verify ownership via projects join with `ctx.userId`
- **System prompt** updated in `agent-loop.ts` with Management tool category
- **Tests** in `sam-tools-phase-b.test.ts` cover parameter validation, ownership rejection, and registration
- **Phase D tools** are also on this branch (create_idea, list_ideas, find_related_ideas, get_ci_status, get_orchestrator_status)
- **Rebase needed**: Branch needs rebase on origin/main to reconcile duplicate task file commits

## Implementation Checklist

- [x] 6 Phase B tools implemented (stop, retry, message, cancel, pause, resume)
- [x] Phase D tools implemented (create_idea, list_ideas, find_related_ideas, get_ci_status, get_orchestrator_status)
- [x] All tools registered in tools/index.ts
- [x] System prompt updated with Management and Planning/Monitoring sections
- [x] Unit tests for Phase B and Phase D
- [ ] Rebase on origin/main
- [ ] Verify typecheck passes
- [ ] Verify lint passes
- [ ] Verify tests pass
- [ ] Verify build passes
- [ ] Run task-completion-validator
- [ ] Dispatch specialist reviewers
- [ ] Deploy to staging and verify
- [ ] Create PR and merge

## Acceptance Criteria

- [ ] All 6 Phase B tools are callable via `executeTool`
- [ ] All Phase D tools are callable via `executeTool`
- [ ] All tools reject unowned resources
- [ ] Parameter validation works (missing required params)
- [ ] System prompt describes all new tools
- [ ] Tests pass
- [ ] Staging deployment succeeds
- [ ] No regressions in existing SAM tools
