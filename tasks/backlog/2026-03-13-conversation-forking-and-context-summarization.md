# Conversation Forking & Context Summarization

**Created**: 2026-03-13
**Research**: `docs/notes/2026-03-13-conversation-forking-research.md`
**Related**: `docs/notes/2026-03-07-chat-continuity-after-workspace-cleanup.md`

## Problem

When a workspace is destroyed (task completion, idle timeout, manual deletion), users lose conversational context. The code lives on in git, but the *why* — what files were discussed, what decisions were made, what the agent was working on — is gone. Starting a new task forces users to re-explain everything from scratch.

## What Exists Today

- **Messages persist** in ProjectData DO SQLite after workspace destruction
- **ACP session fork API** (`POST /api/projects/:id/acp-sessions/:sessionId/fork`) accepts `contextSummary`, creates child session with `parentSessionId` link and `forkDepth`
- **Fork lineage query** (`GET /.../lineage`) returns full ancestry tree
- **Message retrieval** (`GET /api/projects/:projectId/sessions/:sessionId`) returns paginated messages with role filtering possible
- **Workers AI** (`@cf/meta/llama-3.1-8b-instruct`) via Mastra + workers-ai-provider, proven pattern in `task-title.ts`
- **Task metadata** survives: `output_branch`, `output_pr_url`, `output_summary`

## What's Missing

1. **Message summarization service** — No server-side logic to filter messages, chunk them, and produce a structured context summary via Workers AI
2. **Summarize API endpoint** — No endpoint for the client to request a summary of a session's messages
3. **"Continue" UI** — No button on completed/stopped sessions to fork with context
4. **Fork dialog** — No UI for reviewing/editing the AI-generated summary before submitting
5. **Task creation from fork** — No flow connecting fork → new task → workspace provisioning with context

## Key Architecture Decisions (from research)

- **Hybrid summarization**: Server generates AI summary, UI shows for review/editing, falls back to heuristic extraction on AI failure
- **Filter pipeline**: Keep only `user` + `assistant` messages; exclude `tool`, `system`, `thinking`, `plan`
- **Chunking strategy**: ≤20 msgs verbatim, 21-50 truncated, 51-100 first 5 + last 30, 100+ first 5 + last 20
- **Structured output**: Summary includes task description, branch, files modified, decisions, current state
- **All config via env vars**: model, timeout, max length, max messages (Constitution Principle XI)

## Key Files

| File | Role |
|------|------|
| `apps/api/src/services/task-title.ts` | Pattern to follow for AI service (Mastra + Workers AI) |
| `apps/api/src/durable-objects/project-data.ts` | Message persistence, session management, fork logic |
| `apps/api/src/routes/projects/acp-sessions.ts` | Fork endpoint, lineage endpoint |
| `apps/api/src/services/project-data.ts` | Service layer for DO calls |
| `packages/shared/src/constants.ts` | Shared defaults for configurable values |
| `packages/shared/src/types.ts` | ChatMessage, AcpSession types |
| `apps/web/src/components/chat/` | Chat UI components |
| `apps/web/src/pages/ProjectChat.tsx` | Main chat page |

## Implementation Checklist

### Backend: Message Summarization Service
- [ ] Add configurable defaults to `packages/shared/src/constants.ts` (CONTEXT_SUMMARY_MODEL, CONTEXT_SUMMARY_MAX_LENGTH, CONTEXT_SUMMARY_TIMEOUT_MS, CONTEXT_SUMMARY_MAX_MESSAGES, CONTEXT_SUMMARY_RECENT_WEIGHT)
- [ ] Create `apps/api/src/services/session-summarize.ts` following `task-title.ts` pattern
- [ ] Implement message filtering (keep user+assistant, exclude tool/system/thinking/plan)
- [ ] Implement chunking strategy based on filtered message count
- [ ] Build summary prompt template for structured output
- [ ] Implement heuristic fallback (last N messages concatenated with role labels + task metadata)
- [ ] Add unit tests for filtering, chunking, and fallback logic

### Backend: Summarize + Continue Endpoints
- [ ] Add `POST /api/projects/:id/sessions/:sessionId/summarize` endpoint returning `{ summary, messageCount, filteredCount }`
- [ ] Add `POST /api/projects/:id/sessions/:sessionId/continue` endpoint that: generates summary, creates new task, creates new session linked to parent, returns new task/session IDs
- [ ] Add message filtering method to ProjectData DO (getFilteredMessages or param on existing getMessages)
- [ ] Add integration tests for summarize and continue endpoints

### Frontend: Continue Button + Fork Dialog
- [ ] Add "Continue" button on stopped/completed sessions in chat UI
- [ ] Create fork dialog component showing AI-generated summary in editable textarea
- [ ] Wire dialog to summarize endpoint on open, continue endpoint on submit
- [ ] Show loading state during summarization
- [ ] Show the new session after fork is created (navigate to it)
- [ ] Add visual indicator for forked sessions ("Continued from [parent session]")

### Tests
- [ ] Unit tests for message filtering and chunking logic
- [ ] Unit tests for summary prompt construction
- [ ] Unit tests for heuristic fallback
- [ ] Integration tests for summarize endpoint
- [ ] Integration tests for continue endpoint
- [ ] UI component tests for continue button and fork dialog

## Acceptance Criteria

- [ ] User can click "Continue" on a completed/stopped session
- [ ] System generates an AI-powered context summary from the session's messages
- [ ] User can review and edit the summary before submitting
- [ ] Submitting creates a new task with the summary as initial context
- [ ] The new task's workspace checks out the parent task's output branch
- [ ] If AI summarization fails, heuristic fallback provides basic context
- [ ] All configuration values are env-var configurable with sensible defaults
- [ ] Fork lineage is preserved (new session links to parent)
