# Implementation Plan: Conversation Forking & Context Summarization

**Branch**: `029-conversation-forking` | **Date**: 2026-03-13 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/029-conversation-forking/spec.md`

## Summary

Enable users to continue work from a completed/stopped session by forking the conversation with an AI-generated context summary. The system filters messages (keeping user + assistant, excluding tool calls), applies chunking for long conversations, generates a structured summary via Workers AI (with heuristic fallback), and creates a new task that checks out the parent's output branch. All configuration is env-var driven.

## Technical Context

**Language/Version**: TypeScript 5.x (API Worker + Web UI), Go 1.24+ (VM Agent — no changes needed)
**Primary Dependencies**: Hono (API), Mastra + workers-ai-provider (AI summarization), React 18 + Vite (Web), Drizzle ORM (D1)
**Storage**: Cloudflare D1 (tasks), Durable Objects with SQLite (sessions, messages, ACP sessions) — no schema changes needed
**Testing**: Vitest with Miniflare for Worker tests, Vitest for React component tests
**Target Platform**: Cloudflare Workers (API), Cloudflare Pages (Web)
**Project Type**: Monorepo (apps/ + packages/)
**Performance Goals**: Summary generation < 10s for sessions with up to 200 messages
**Constraints**: Workers AI 8K token context window for Llama 3.1 8B; 64KB max contextSummary; Worker 30s wall-clock budget
**Scale/Scope**: Summarization is on-demand (user-initiated fork), not high-throughput

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source | PASS | Feature is core platform functionality, no enterprise separation needed |
| II. Infrastructure Stability | PASS | Feature is user-facing, not critical infrastructure. Tests required. |
| III. Documentation Excellence | PASS | Quickstart and API contracts documented |
| IV. Approachable Code & UX | PASS | "Continue" button with editable dialog provides immediate feedback |
| IX. Clean Code Architecture | PASS | Follows existing monorepo structure — service in api, types in shared |
| X. Simplicity & Clarity | PASS | Reuses existing schema fields, minimal new code surface |
| XI. No Hardcoded Values | PASS | All config via env vars with defaults in shared constants |
| XII. Zero-to-Production | PASS | No new infrastructure resources — uses existing Workers AI binding |
| XIII. Fail-Fast | PASS | Validate session exists, parent task exists, project ownership at every boundary |

## Project Structure

### Documentation (this feature)

```text
specs/029-conversation-forking/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Technical research findings
├── data-model.md        # Data model (reuses existing entities)
├── quickstart.md        # Build and configuration guide
├── contracts/
│   └── api.md           # API endpoint contracts
└── checklists/
    └── requirements.md  # Specification quality checklist
```

### Source Code (repository root)

```text
packages/shared/src/
├── constants.ts          # + context summary defaults
└── types.ts              # + SubmitTaskRequest extension

apps/api/src/
├── services/
│   └── session-summarize.ts  # NEW: AI summarization service
├── routes/
│   ├── projects/
│   │   └── sessions.ts       # + summarize endpoint (or new file)
│   └── tasks/
│       └── submit.ts         # + parentTaskId handling
└── durable-objects/
    ├── project-data.ts       # + role filter on getMessages()
    └── task-runner.ts        # + outputBranch from parent task

apps/web/src/
├── pages/
│   └── ProjectChat.tsx       # + "Continue" button on SessionItem
├── components/chat/
│   └── ForkDialog.tsx        # NEW: fork dialog component
└── lib/
    └── api.ts                # + summarizeSession(), submitTask extension
```

**Structure Decision**: All changes fit within the existing monorepo structure. No new packages or build targets. The summarization service follows the proven `task-title.ts` pattern.

## Complexity Tracking

No constitution violations to justify. All changes are additive and follow existing patterns.
