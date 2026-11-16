# Inbox backend (slice A)

SAM task `01M7GZVGD2BF6J7YP4GZH0GVS0`. Spec: idea `01M7G03ZCQ6TM6CMEYDRKQ8ST9` (sections 1, 2, 3, 7;
slice A in section 6). Coordination channel `feature.inbox`. Authorized through production on
2026-11-16.

## Problem

People find what agents need from them by walking chats. The inbox gives every ask from an agent
to a person one item with one answer, read across projects. Slice A ships the backend the web UI
(slice C) and agent tools (slice D) build on: the `asks` table, shared list / count / get / answer /
archive operations over every store that holds an ask today, REST routes, archive for every kind,
and the "since" side of the context read. No UI, no agent-facing MCP tools.

## Research findings

- Operations live in `packages/operations` (`defineOperation`, `registry.ts`); every registry entry
  is exposed by the Connector MCP (`apps/api/src/routes/connector-mcp.ts`) and REST adapters call
  them with `webOperationContext` (`apps/api/src/operation-ports.ts`). Cross-area effects go
  through ports (`packages/operations/src/ports.ts`) implemented in `operation-ports.ts`.
- Existing Connector `sam_inbox_get` (`connector-read-core.ts:inboxGet`) lists chats with
  `attention_json` and calls a ProjectData DO per chat (`pendingInteractions`) to find permissions.
- `session_summaries.attention_json` (`packages/project-data/src/do/session-summary-sync.ts`,
  `getAttentionSummary` in `do/attention.ts`) holds ONE marker per chat: the newest `needs_input`
  (questions and mirrored ACP interactions, `apps/api/src/durable-objects/interaction-store-attention.ts`,
  reason `acp_interaction_pending`), else the newest marker of any kind. It does not carry
  `source`, category or the interaction id.
- Answer paths that exist today: `answerAttention` (`routes/chat-attention.ts`, claim →
  live-agent prompt → complete), `answerAgentInteraction` (ports.chat), secret
  `fulfillRuntimeSecretRequest` / `declineRuntimeSecretRequest` (`services/runtime-secret-requests.ts`,
  `secret:write`), approvals `decideOperationsAction` (`services/operations-actions/service.ts`,
  superadmin only).
- Notice with retry: `runtime_secret_requests.notified_at` + `runRuntimeSecretRequestSweep`
  (cron, isolated), delivery via ProjectData `acceptPromptDelivery` with source kind
  `secret_request`, guarded by the requesting task (`prompt-delivery-source-guards.ts`).
- Context read: `GET /api/projects/:projectId/sessions/:sessionId/attention/:markerId?context=true`
  reads only messages before the ask (`getLogicalTranscriptPage`, `before` cursor only).
- Admin settings: typed registry `admin-settings-features-definitions.ts`; definition lists live
  beside their resolver (example `CONNECTOR_READ_SETTINGS`).

## Design

- Item reference (`InboxItemRef`): `ask:<id>`, `attention:<sessionId>:<markerId>`,
  `secret:<id>`, `approval:<id>`. The store is the prefix; project is a separate field and every
  single-item route is project-scoped.
- List = one D1 statement: `UNION ALL` of open `asks`, `session_summaries` with a `needs_input`
  attention summary, pending `runtime_secret_requests`, pending `operations_action_approvals`,
  each filtered to the viewer and to active membership, ordered by tier (0 live deadline:
  permissions and asks with `due_at`; 1 blocking; 2 rest), then stack anchor (oldest item of the
  chat in that tier), chat, created, ref. Keyset cursor. Per-row parse is isolated (rule 50).
- Viewer: `asks` assignee (user) or unclaimed/claimed-by-me team item; attention: chat creator;
  secret: requester; approval: superadmin member of the requesting project.
- Answer/archive: per store, through a new `inbox` port implemented in
  `apps/api/src/services/inbox/` calling the existing answer paths. Archive: asks → CAS
  `archived` + notice (`notified_at`, sweep retry, new prompt source kind `inbox_ask`); question
  marker → claim, live-agent prompt, resolve reason `archived`; permission → decline through the
  interaction answer; secret → decline; approval → deny.
- Limits: admin settings `inbox.*` (page size, max page size, title chars, body chars, open
  items per chat, notice retry minutes, sweep batch).

## Implementation checklist

- [ ] Migration `0242_asks.sql` (additive) + drizzle `asks` in `packages/worker-core/src/schema.ts`
- [ ] Shared types `packages/shared/src/types/inbox.ts` (kinds, filters, refs, item, responses)
- [ ] `getAttentionSummary` carries `source`, `category`, `interactionId`, `interactionKind`
- [ ] Inbox settings definitions + resolver + admin registry entries
- [ ] Operations: list (cross-project + project), count, get, answer, archive, internal create
- [ ] `inboxGet` (Connector `sam_inbox_get`) reads pending items from the shared list
- [ ] Inbox port + worker implementation (asks CAS writes, attention archive, secret/approval/permission delegation)
- [ ] ProjectData: archive claim/complete for attention markers (reason `archived`)
- [ ] Prompt source kind `inbox_ask` added to every source-kind list and guard
- [ ] Asks notice sweep (expiry + notified_at retry) in the cron, isolated
- [ ] Context read: "since" side in `chat-attention.ts`, bounded like "before"
- [ ] REST routes `/api/inbox`, `/api/inbox/count`, `/api/projects/:projectId/inbox/...`
- [ ] Tests: real-SQL tenancy attack + owner control pairs (discriminating), CAS concurrency
      (two answers, answer vs archive), fault isolation, capability tests (question, secret, ask)
- [ ] Docs: API reference / public docs for the inbox routes; idea note + channel publication

## Acceptance criteria

- [ ] An agent's `request_human_input` shows in the creator's cross-project list and count, not
      in another member's list; archiving through the inbox resolves the marker with reason
      `archived` and the agent receives the "will not act" prompt
- [ ] A secret request archived through the inbox is declined and the agent notified; fulfil works
- [ ] An `asks` row created through the internal operation lists, answers, archives with a notice
      that retries via the sweep when the first delivery fails
- [ ] Foreign-project and missing items return the same not-found; transcript context only for
      readers with access to the source chat
- [ ] Two concurrent answers: one wins; answer vs archive: one wins
- [ ] One malformed row does not hide the others
- [ ] List and count stay within rule 60 budgets with no per-chat DO call
