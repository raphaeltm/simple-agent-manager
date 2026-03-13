# Quickstart: 029-conversation-forking

## Overview

This feature adds conversation forking — the ability to continue work from a completed session by creating a new task with AI-summarized context from the previous conversation.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Web UI        │     │   API Worker      │     │  ProjectData DO │
│                 │     │                   │     │                 │
│  "Continue" btn │────>│ POST /summarize   │────>│ getMessages()   │
│                 │     │   ↓               │     │ (role filter)   │
│  Fork Dialog    │<────│ session-summarize │<────│                 │
│  (editable)     │     │   service         │     │                 │
│                 │     │                   │     │                 │
│  Submit         │────>│ POST /tasks/submit│     │                 │
│                 │     │  (parentTaskId)   │     │                 │
│                 │     │   ↓               │     │                 │
│  New Session    │<────│ TaskRunner DO     │     │                 │
│                 │     │  (checkout branch)│     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Key Files to Modify

### Backend (API Worker)
1. `packages/shared/src/constants.ts` — Add summarization defaults
2. `packages/shared/src/types.ts` — Extend `SubmitTaskRequest` type
3. `apps/api/src/services/session-summarize.ts` — **NEW**: Summarization service
4. `apps/api/src/routes/projects/sessions.ts` or similar — **NEW**: Summarize endpoint
5. `apps/api/src/routes/tasks/submit.ts` — Handle `parentTaskId` + `contextSummary`
6. `apps/api/src/durable-objects/project-data.ts` — Add role filter to `getMessages()`
7. `apps/api/src/durable-objects/task-runner.ts` — Use parent's `outputBranch` for workspace

### Frontend (Web UI)
1. `apps/web/src/pages/ProjectChat.tsx` — Add "Continue" button to `SessionItem`
2. `apps/web/src/components/chat/ForkDialog.tsx` — **NEW**: Fork dialog component
3. `apps/web/src/lib/api.ts` — Add `summarizeSession()` and extend `submitTask()`

## Build & Test

```bash
# Build in dependency order
pnpm --filter @simple-agent-manager/shared build
pnpm --filter @simple-agent-manager/api build
pnpm --filter @simple-agent-manager/web build

# Run tests
pnpm test

# Type check
pnpm typecheck
```

## Configuration

All values configurable via Cloudflare Worker env vars:

| Env Var | Default | Description |
|---------|---------|-------------|
| `CONTEXT_SUMMARY_MODEL` | `@cf/meta/llama-3.1-8b-instruct` | Workers AI model |
| `CONTEXT_SUMMARY_MAX_LENGTH` | `4000` | Max summary output chars |
| `CONTEXT_SUMMARY_TIMEOUT_MS` | `10000` | AI call timeout |
| `CONTEXT_SUMMARY_MAX_MESSAGES` | `50` | Max messages to process |
| `CONTEXT_SUMMARY_RECENT_MESSAGES` | `20` | Recent messages to always include |
| `CONTEXT_SUMMARY_SHORT_THRESHOLD` | `5` | Below this count, skip AI |
