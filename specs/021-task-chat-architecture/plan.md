# Implementation Plan: Task-Driven Chat Architecture & Autonomous Workspace Execution

**Branch**: `021-task-chat-architecture` | **Date**: 2026-02-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/021-task-chat-architecture/spec.md`

## Summary

Re-architect message persistence from browser-side to VM agent-side using a SQLite-backed transactional outbox with batched HTTP delivery. Build autonomous task execution where users submit tasks that auto-provision workspaces, execute via Claude Code, and persist full chat history to the ProjectData Durable Object. Add warm node pooling via DO Alarms for cost-efficient node reuse. Deliver a project-level chat-first UI with task kanban board and split-button task submission.

## Technical Context

**Language/Version**: TypeScript 5.x (API Worker, Web UI), Go 1.24+ (VM Agent)
**Primary Dependencies**: Hono (API), React 18 + Vite (Web), Drizzle ORM (D1), Cloudflare Workers SDK (DOs), ACP Go SDK, cenkalti/backoff/v5 (new, Go retry)
**Storage**: Cloudflare D1 (relational metadata), Durable Objects with SQLite (per-project chat data), VM-local SQLite (message outbox)
**Testing**: Vitest + Miniflare (API/Web), Go testing (VM Agent), Playwright (E2E)
**Target Platform**: Cloudflare Workers (API), Cloudflare Pages (Web), Hetzner Cloud VMs (VM Agent)
**Project Type**: Monorepo (apps/ + packages/)
**Performance Goals**: Message persistence latency <3s (batch flush), DO WebSocket broadcast <500ms, task submission to agent-running <5min (including cold node provision)
**Constraints**: Cloudflare Worker 30s CPU time limit per request, 128MB Worker memory, D1 row size limits, cloud-init 32KB size limit
**Scale/Scope**: Single-user to small-team usage; tens of concurrent tasks per user; thousands of messages per session

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| **II. Infrastructure Stability (NON-NEGOTIABLE)** | PASS | TDD for critical paths (message persistence, node lifecycle, task execution). >90% coverage for critical, >80% overall. Integration tests via Miniflare. |
| **III. Documentation Excellence** | PASS | ADR for NodeLifecycle DO. API contracts documented. Self-hosting guide updated. |
| **IV. Approachable Code & UX** | PASS | Split submit button with clear primary action. Chat-first view is intuitive. |
| **VI. Automated Quality Gates** | PASS | CI runs tests, typecheck, lint. No new manual steps. |
| **VIII. AI-Friendly Repository** | PASS | CLAUDE.md updated with new Active Technologies. |
| **IX. Clean Code Architecture** | PASS | New Go code follows existing vm-agent patterns. New TS follows existing service/route patterns. |
| **X. Simplicity & Clarity** | PASS | Only 1 new Go dependency. Reuses existing infrastructure (DO, D1, JWT, cloud-init). No new external services. |
| **XI. No Hardcoded Values (NON-NEGOTIABLE)** | PASS | All timeouts, limits, and URLs configurable via env vars with defaults. See data-model.md Configuration Values section. |
| **XII. Zero-to-Production Deployability (NON-NEGOTIABLE)** | PASS | NodeLifecycle DO in Pulumi stack. D1 migrations replayable from zero. Self-hosting docs updated in same PR. New env vars documented. |

**Post-Phase 1 Re-Check**: All principles still satisfied. No violations introduced during design.

## Project Structure

### Documentation (this feature)

```text
specs/021-task-chat-architecture/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: Technical decisions and rationale
├── data-model.md        # Phase 1: Entity relationships, schemas, migrations
├── quickstart.md        # Phase 1: Getting started guide for implementers
├── contracts/           # Phase 1: API contracts
│   └── api-contracts.md # Endpoint specifications
├── checklists/          # Quality validation
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2: Implementation tasks (via /speckit.tasks)
```

### Source Code (repository root)

```text
# Phase 1: VM Agent Message Persistence
packages/vm-agent/
├── internal/
│   └── messagereport/          # NEW — Message outbox + batch reporter
│       ├── reporter.go         # Core reporter (outbox, flush loop, retry)
│       ├── reporter_test.go    # Unit tests
│       ├── schema.go           # SQLite outbox table DDL
│       └── config.go           # Configuration with env var parsing
├── internal/acp/
│   └── session_host.go         # MODIFIED — Hook SessionUpdate for persistence
└── go.mod                      # MODIFIED — Add cenkalti/backoff/v5

packages/cloud-init/
└── src/generate.ts             # MODIFIED — Add projectId, chatSessionId variables

apps/api/
├── src/routes/
│   └── workspaces.ts           # MODIFIED — New POST /:id/messages endpoint
├── src/services/
│   ├── task-runner.ts          # MODIFIED — Create chat session during task run
│   └── chat-persistence.ts     # DEPRECATED — Browser-side persistence removed
├── src/durable-objects/
│   └── project-data.ts         # MODIFIED — createSession accepts taskId
└── migrations/
    └── XXXX_add_task_chat_fields.sql  # D1 + DO migrations

# Phase 2: Enhanced Task Runner + Node Pooling
apps/api/
├── src/durable-objects/
│   └── node-lifecycle.ts       # NEW — NodeLifecycle DO
├── src/services/
│   ├── task-runner.ts          # MODIFIED — Completion cleanup, warm pooling
│   └── node-selector.ts        # MODIFIED — Warm node preference + tryClaim
├── src/scheduled/
│   └── node-cleanup.ts         # NEW — Cron reconciliation sweep
└── wrangler.toml               # MODIFIED — NodeLifecycle binding, cron trigger

infra/
└── index.ts                    # MODIFIED — Pulumi: NodeLifecycle DO namespace

# Phase 3: Project-Level Chat + Task UI
apps/web/
├── src/pages/
│   ├── ProjectChat.tsx         # NEW — Chat-first project view
│   ├── ProjectKanban.tsx       # NEW — Task kanban board
│   └── Project.tsx             # MODIFIED — Default to chat, view switcher
├── src/components/
│   ├── chat/
│   │   ├── SessionSidebar.tsx  # NEW — Session selector sidebar
│   │   └── ProjectMessageView.tsx  # NEW — Message viewer with DO WebSocket
│   ├── task/
│   │   ├── TaskKanbanBoard.tsx # NEW — Kanban columns with cards
│   │   ├── TaskKanbanCard.tsx  # NEW — Task card for kanban
│   │   └── TaskSubmitForm.tsx  # NEW — Split-button task submission
│   └── ui/
│       └── SplitButton.tsx     # NEW — GitHub PR-style split button
├── src/lib/
│   └── api.ts                  # MODIFIED — New API client functions
└── src/App.tsx                 # MODIFIED — Route changes
```

**Structure Decision**: Follows existing monorepo structure. New Go package (`messagereport`) follows the established pattern from `errorreport` and `bootlog`. New DO class (`NodeLifecycle`) follows existing `ProjectData` DO pattern. New React components follow existing project page structure with tabs and context.

## Complexity Tracking

No constitution violations. No complexity justifications needed.

| Aspect | Assessment |
|---|---|
| New DO class (NodeLifecycle) | Justified: encapsulates alarm + claim atomically; no simpler alternative provides race-free lifecycle management |
| New Go dependency (cenkalti/backoff/v5) | Justified: MIT license, 3.9k stars, used by OTel; alternative is reimplementing jitter+context-aware retry from scratch |
| SQLite outbox in VM agent | Justified: provides crash safety; alternative (in-memory only) loses messages on SIGKILL |
