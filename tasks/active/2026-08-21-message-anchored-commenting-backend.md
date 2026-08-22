# Message-anchored commenting backend

## Problem statement

Build the backend/multiplayer foundation for SAM's message-anchored commenting MVP from idea `01M0JQB842XSJ3W172DYPB37HN`.

This is a constituent PR for a coordinated multi-PR integration. It must provide the clean server-side contract and persistence layer for sibling UI/MCP tracks, without merging or deploying to staging from this branch.

## Scope

In scope:

- Message-anchored comment threads on `ProjectData.chat_messages`.
- Replies, `open` / `sent` / `resolved` status, resolve/reopen/send status transitions.
- Bounded write validation, idempotency, and deterministic ordering for optimistic clients.
- ProjectData Durable Object migration, RPC/service methods, HTTP API routes, and WebSocket broadcast events.
- Project membership authorization at HTTP boundaries and ProjectData-side session/message/thread consistency checks.
- Tests for migration, CRUD, replies, status transitions, validation, authorization, idempotency, ordering, and events.

Out of scope:

- File comments, fuzzy file re-anchoring, mentions, reactions, notification inboxes, and unrelated refactors.
- Actual "send to agent" prompt enqueueing. This backend records and broadcasts `sent` status; sibling work can attach prompt delivery to the explicit API contract.
- Permissions beyond project membership.

## Research findings

- Idea `01M0JQB842XSJ3W172DYPB37HN` defines the MVP as message comments first. `chat_messages.id` is stable and immutable; file anchors are deferred because production-safe re-anchoring is a separate hard problem.
- The prototype branch `sam/really-get-feature-talked-5ckt0s` validates behavior only: one anchor-discriminated thread model, replies, status pill, resolve/reopen, and message-row comment markers. Prototype code is UI-only mock data and must not be promoted blindly.
- ProjectData DO migrations live in `apps/api/src/durable-objects/migrations.ts` and must be append-only. Current latest migration is `031-task-wait-replay-hardening`; new work must append after it and avoid table recreation/drop patterns per `.claude/rules/31-migration-safety.md`.
- ProjectData public RPC methods live on `apps/api/src/durable-objects/project-data/index.ts`, with domain logic split into sibling modules. New comment logic should follow the module pattern instead of growing unrelated files.
- `apps/api/src/services/project-data.ts` is the typed Worker-to-DO service boundary. Write calls that can duplicate user intent should use explicit idempotency rather than relying on retry behavior.
- `ProjectData.broadcastEvent()` already fans out to session-tagged and project-wide WebSocket listeners. New comment mutations should use this existing channel with server-authoritative full-thread payloads so clients converge without CRDT/OT.
- `routes/chat.ts` already mounts project-scoped session endpoints under `/api/projects/:projectId/sessions`, protects them with `requireAuth()` and `requireApproved()`, and uses `requireProjectAccess` / `requireProjectCapability` for tenant authorization.
- Existing chat routes sometimes enforce session creator for follow-up prompts, but the commenting MVP explicitly scopes permissions to project membership only. Comment writes should require project `task:write`, reads should require `task:read`, and should not require session creator.
- Storage-safety work warns that ProjectData is low-level, write-hot state with a 10 GB ceiling. Comment writes must bound body, quote, idempotency key, thread count, and reply count at the write boundary via env-backed defaults.
- Rule 50 requires list reads that parse rows to tolerate malformed rows. Comment list mapping must isolate per-row parsing and warn/skip bad rows instead of throwing a whole list response.
- Vertical-slice coverage is required because this crosses HTTP route → D1 membership → ProjectData DO → SQLite → WebSocket event contracts.

## Implementation checklist

- [x] Add shared comment API/event types and env-backed default limits.
- [x] Append a ProjectData DO SQLite migration for `comment_threads`, `comment_replies`, and status-idempotency rows.
- [x] Add a `project-data/comments.ts` module with bounded validation, message-anchor verification, idempotent create/reply/status transitions, deterministic sequence ordering, and row parsing isolation.
- [x] Add public ProjectData RPC delegates in `project-data/index.ts` that broadcast server-authoritative comment events on the existing WebSocket channel.
- [x] Add typed service wrappers in `apps/api/src/services/project-data.ts`.
- [x] Add Valibot schemas and HTTP routes under `/api/projects/:projectId/sessions/:sessionId/comments`.
- [x] Enforce project membership/capability authorization at every HTTP route and DO-side rejection for missing sessions, missing/cross-session messages, missing threads, and idempotency conflicts.
- [x] Add/refresh API documentation for the HTTP/RPC/event contract.
- [x] Add focused tests for migrations, CRUD/replies/status transitions, validation/limits, authorization, idempotency, ordering, and WebSocket events.
- [x] Run local quality checks and required specialist reviews.
- [ ] Create an open PR to `main`; do not deploy to staging and do not merge.

## Acceptance criteria

- A project member with read access can list message comment threads for a session; non-members cannot.
- A project member with write access can create a message-anchored thread only when the target message exists in that same ProjectData project/session.
- Cross-project or cross-session message/thread IDs are rejected as missing/not found instead of silently creating orphan anchors.
- Thread body, reply body, quote, idempotency key, list limits, per-session thread count, and per-thread reply count are bounded via env-backed defaults.
- Duplicate create/reply/status requests with the same idempotency key return the same authoritative result; reuse of a key with a different intent conflicts.
- Threads and replies have deterministic sequence ordering even when timestamps collide.
- Status transitions support `sent`, `resolved`, and reopening to `open` with server-side actor/timestamp metadata.
- Every mutation emits a ProjectData WebSocket event with enough authoritative state for multiple clients to converge.
- Tests cover the route/service/DO storage path and event payloads; staging is intentionally skipped by explicit instruction.

## Contract assumptions

- MVP anchors accepted by this backend are message anchors only: `{ kind: 'message', messageId, quote? }`.
- `sent` means "marked as sent for agent handling" in storage and events. This PR does not enqueue a prompt or wait for agent completion.
- Comment authors for HTTP writes are server-authoritative human actors derived from the authenticated session. Agent-authored comments can be added later through MCP/tool routes using the same ProjectData RPC shape.
- Comment authorization is project membership/capability based, not session-creator based.

## Validation evidence

- `pnpm --filter @simple-agent-manager/shared build`
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/comments.test.ts tests/unit/durable-objects/project-data-comment-broadcast.test.ts tests/unit/routes/chat-comments.test.ts tests/unit/services/project-data-comments.test.ts`
- `pnpm --filter @simple-agent-manager/api exec eslint src/durable-objects/project-data/comments.ts src/durable-objects/project-data/index.ts src/durable-objects/project-data/types.ts src/env.ts src/routes/chat.ts src/routes/chat-comments.ts src/schemas/comments.ts src/schemas/index.ts src/services/project-data.ts tests/unit/durable-objects/comments.test.ts tests/unit/durable-objects/project-data-comment-broadcast.test.ts tests/unit/routes/chat-comments.test.ts tests/unit/services/project-data-comments.test.ts`
- `pnpm exec prettier --check .agents/skills/api-reference/SKILL.md .claude/skills/api-reference/SKILL.md apps/api/src/durable-objects/project-data/comments.ts apps/api/src/durable-objects/project-data/index.ts apps/api/src/durable-objects/project-data/types.ts apps/api/src/env.ts apps/api/src/routes/chat.ts apps/api/src/routes/chat-comments.ts apps/api/src/schemas/comments.ts apps/api/src/schemas/index.ts apps/api/src/services/project-data.ts apps/api/tests/unit/durable-objects/comments.test.ts apps/api/tests/unit/durable-objects/project-data-comment-broadcast.test.ts apps/api/tests/unit/routes/chat-comments.test.ts apps/api/tests/unit/services/project-data-comments.test.ts apps/www/src/content/docs/docs/reference/configuration.md packages/shared/src/constants/defaults.ts packages/shared/src/constants/index.ts packages/shared/src/types/comments.ts packages/shared/src/types/index.ts tasks/active/2026-08-21-message-anchored-commenting-backend.md`
- `pnpm quality:do-migration-safety`
- `pnpm quality:source-contract-tests`
- `pnpm quality:wrangler-bindings`
- `pnpm quality:type-boundaries`
- `git diff --check`

## Specialist review evidence

| Reviewer                  | Status | Outcome                                                                                                                                                                      |
| ------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| constitution-validator    | PASS   | New limits are env-backed shared defaults with Worker/DO Env, Wrangler, `.env.example`, and docs entries; no hardcoded URLs/timeouts/identifiers added.                      |
| cloudflare-specialist     | PASS   | ProjectData migration is append-only/non-destructive and passes `quality:do-migration-safety`; write RPCs use synchronous DO transactions and existing WebSocket fan-out.    |
| security-auditor          | PASS   | HTTP routes require project `task:read`/`task:write`; server derives human actor from auth; ProjectData rejects missing/cross-session message anchors and missing threads.   |
| test-engineer             | PASS   | Added storage, route/auth/error, service-wrapper, and DO WebSocket event tests covering migration, CRUD, replies, status, limits, idempotency, ordering, and event payloads. |
| doc-sync-validator        | PASS   | API reference, shared types, env examples, Wrangler defaults, and configuration docs reflect the new HTTP/RPC/event contract and env knobs.                                  |
| env-validator             | PASS   | `COMMENT_*` env vars are consistently named and present in Worker Env, ProjectData Env, Wrangler, `.env.example`, docs, and shared defaults.                                 |
| task-completion-validator | PASS   | Acceptance criteria checked against the diff and passing tests; staging and merge intentionally skipped by explicit task constraint.                                         |
