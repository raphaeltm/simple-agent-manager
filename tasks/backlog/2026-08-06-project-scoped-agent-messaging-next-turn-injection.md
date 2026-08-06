# Project-scoped agent-to-agent messaging with next-turn context injection

**SAM task:** `01KZB1H1VBBM5N9HNQHWTABCAA`
**Output branch:** `sam/build-agent-communication-upgrade-tabcaa`
**Approved by Raphaël:** 2026-08-06 (the trust-domain relaxation is the approved design, not an
agent-invented security change).

## Problem

SAM agents working in the same project cannot talk to each other. Three concrete gaps:

1. **Sending is parent→child only.** `send_durable_message` rejects anything but the direct parent
   (`mailbox-tools.ts:273-275`), and `send_message_to_subtask` does the same
   (`orchestration-comms.ts:88-101`). Siblings and child→parent messaging do not exist.
   This is inconsistent with reads, which are *already* project-scoped:
   `get_peer_agent_output` only checks `eq(tasks.projectId, tokenData.projectId)`
   (`workspace-tools-direct.ts:106-111`) and `list_project_agents` lists every active peer in the
   project (`workspace-tools-direct.ts:59-66`). The SAM-native orchestrator tools
   (`sam-session/tools/send-message-to-subtask.ts:65-69`) are also project-scoped, not parent-scoped.
   Since every agent in a project shares repo write access, **project is already the trust domain**;
   the parent-only send rule buys no security while blocking the feature.

2. **Delivery is pull-only and lossy in practice.** `get_pending_messages` must be called by the
   receiving agent at a turn boundary. The one enqueue-time push attempt
   (`mailbox-tools.ts:332-378`) 409s whenever the target is mid-prompt and is **never retried** —
   the message then sits until the agent happens to poll. The DO alarm sweep
   (`mailbox.ts:412-433`) only expires/requeues; it makes no outbound call.
   Worse, that single push pre-persists the raw content as a **visible user message**
   (`attemptImmediateDelivery` → `persistOrchestrationPrompt`, origin defaults to `user`), so peer
   traffic pollutes the human's chat, search index, dedup, and topic capture.

3. **Message classes are advisory strings.** `MESSAGE_CLASSES` (`packages/shared/src/types/mailbox.ts:10-16`)
   documents `interrupt` as "preempts current work" and `shutdown_with_final_prompt` as terminating,
   but **no class-specific behavior is implemented anywhere**. The only effect of class is priority
   ordering and `ack_required`. The tool description actively lies to the model.

Meanwhile, the mechanism to fix (2) already exists but only on one path: trusted `origin=system`
block injection (`injectedInstructions` → `buildInitialPromptParams`, `workspaces.go:1223-1237`)
works at **session start only**. The running-session `/prompt` path builds a single untrusted block
(`workspaces.go:1361-1377`, `trustedSource=false`).

## Research findings

### Trust boundary (Go) — only three `HandlePrompt` call sites

| Site | trustedSource | Params origin |
|---|---|---|
| `workspaces.go:1301` (`startAgentWithPrompt`) | `true` | vm-agent builds JSON from typed string fields |
| `workspaces.go:1377` (`handleSendPrompt`) | `false` | vm-agent builds JSON from `body.Prompt` **string** |
| `acp/gateway.go:442` (browser viewer WS) | `false` | **raw browser params forwarded verbatim** |

The real invariant is *"params constructed by the vm-agent server from typed fields are trusted;
params forwarded verbatim from a remote peer are not."* Only the gateway is genuinely untrusted —
`handleSendPrompt` cannot smuggle `_meta` because the user's text is marshaled as a JSON **string
value**, never as a block object. So `/prompt` can safely carry a server-built injected block.
→ Extract ONE shared `buildPromptParams(visible, injected, messageID)` used by both server paths;
the marker is added only by that helper; prove it with a Go test that feeds prompt text containing
literal `_meta` JSON and asserts it stays a plain block.

### Origin pipeline — reuse wholesale, do not rebuild

`_meta["sam.origin"]="system"` → `contentBlockOrigin` (`message_extract.go:103`) →
`ExtractedMessage.Origin` → outbox `origin` column (`messagereport/schema.go:34-46`) →
`POST /:id/messages` (`schemas/workspaces.ts:80`, picklist `user|system`) → DO
`persistMessageBatch` (`messages.ts:254-265`) → `chat_messages.origin` (migration `024`) →
web `AcpConversationItemView.tsx:127-131` collapses it behind "Show system context".
Exclusions already keyed on origin: FTS materialization (`materialization.ts:37`), LIKE search
(`messages.ts:537`), user-content dedup (`messages.ts:226`), topic auto-capture (`messages.ts:291-293`),
attention resolution (`message-persistence.ts:157`).

**Key consequence:** the vm-agent mirrors the injected block itself through the **batch** persist
path, which already carries `origin`. So peer injections must **not** be pre-persisted by the
control plane — that would duplicate the message *and* hit a real gap (the single-message
`persistMessage` chain drops `origin` entirely: `project-data.ts:139-156`, `messages.ts:97-107`,
`message-persistence.ts:87` hardcodes `origin: null`, and single-path topic capture at
`messages.ts:116-129` lacks the origin guard the batch path has). Dropping the pre-persist both
fixes the visible-noise bug and side-steps that gap. → File the `persistMessage`-origin gap as a
separate backlog item (it still affects other orchestration prompts).

Multi-block message IDs are already correct: `injectUserMessageNotifications`
(`session_host_prompt.go:378-382`) hands the control-plane `messageId` to the **first** user block
only, then clears it, so a second injected block gets its own generated ID. No collision.

### Delivery hook — an existing, rule-34-compliant callback already carries "turn ended"

`POST /api/projects/:id/acp-sessions/:sessionId/activity`
(`routes/projects/agent-activity-callback.ts:64-277`) receives `activity ∈ prompting|idle|recovering|error`.
It is already its own Hono instance with `extractBearerToken`+`verifyCallbackToken`, scope gate,
and token-identity binding (`:94-96`), mounted at `index.ts:751` **before** `projectsRoutes` (`:757`).
Go fires `idle` from `markPromptDone()` (`session_host_prompt.go:449`) — the primary "agent returned
to ready" signal. → **Extend this route; add no new callback.** Rule 34 satisfied by construction.

### Concurrency (rule 45)

DO SQLite ops are synchronous within one RPC. A claim implemented as a **single synchronous DO
method** that selects queued rows *and* transitions them to `delivered` has no `await` between check
and act, so it is atomic by construction — no mutex needed. This is the only safe way to prevent the
piggyback path and the idle-push path from double-delivering the same message.

### Rate limiting (rule 28 spirit: atomic primitive, not KV read-modify-write)

The existing MCP limiter (`_helpers.ts:233-268`) is a **non-atomic KV fixed window** applied once at
the HTTP layer per token. For per-sender send limits, count inside the same synchronous DO enqueue
call over `session_inbox` itself (`source_task_id` + `created_at > now-window`) — atomic, no new
table, and expired rows persist so the count stays honest.

### Escape path (rule 47)

`markDelivered` increments `delivery_attempts`; `requeueForRedelivery` returns `delivered→queued`.
So claim→push-fail→requeue increments attempts each cycle and `expireStaleMessages` terminates the
row at `MAILBOX_REDELIVERY_MAX_ATTEMPTS`. Every claimed candidate has a terminal path. The idle push
must use a **background** timeout, not the interactive 30s `DEFAULT_NODE_AGENT_REQUEST_TIMEOUT_MS`.

### File-size (rule 18)

`workspaces.go` = 1568 lines and `node-agent.ts` = 806 lines are **pre-existing** violations.
Decision: do not grow them. New logic lands in new focused modules
(`internal/server/agent_prompt.go`, `services/mailbox-delivery.ts`), and the shared prompt-params
builder is *extracted out of* `workspaces.go` (net reduction there).

### Test harness

- MCP tool handlers: plain-node `apps/api/vitest.config.ts`; pattern in
  `tests/unit/routes/mcp-orchestration-comms.test.ts` (`createMockD1`, `mockD1ResultSequence`,
  `vi.mock` of node-agent/project-data, handlers imported lazily in `beforeEach`).
- DO behavior: Miniflare `apps/api/vitest.workers.config.ts`, `tests/workers/mailbox-do.test.ts`.
  **Caveat:** local workerd SIGSEGVs before collection on worker-pool tests (recorded in
  `tasks/active/2026-07-07-origin-tag-injected-messages-persist-hide.md`) — verify before assuming a
  local failure is mine; these are CI-gated.
- Coverage gap found: **no test imports `src/routes/mcp/mailbox-tools.ts` at all.** All four of its
  handlers are currently untested.

## Design

### 1. Authorization: project-scoped sending

`send_durable_message` only. Keep `send_message_to_subtask` / `stop_subtask` parent-only — they
inject a **user-role** prompt / hard-stop a session, i.e. they steal a turn. Peer communication uses
the durable mailbox, which is non-interrupting and arrives as clearly-marked system provenance.

- Drop the `parentTaskId !== tokenData.taskId` check; keep the `projectId` equality predicate
  (cross-project stays blocked, fail closed).
- **Block self-send** (`targetTaskId === tokenData.taskId`) — prevents a trivial self-loop.
- Sender attribution comes exclusively from the **verified** token (`tokenData.taskId`,
  `tokenData.workspaceId`); no body field may name the sender (rule 51). Resolve the sender's task
  **title** server-side for the provenance line.
- Rate limits + size caps, all env-configurable with `DEFAULT_*` (constitution XI).

### 2. Next-turn delivery

New `services/mailbox-delivery.ts`:
- `claimPeerMessagesForInjection(env, projectId, chatSessionId)` → new DO RPC
  `claimPendingMailboxMessagesForDelivery` (one synchronous select+transition).
- `buildPeerMessageBlock(messages)` → fenced, provenance-marked text. Content is
  `sanitizeUserInput`-ed and any closing-delimiter sequence is neutralized so a sender cannot break
  out of the fence. Framed explicitly as **data to consider, not instructions**.
- `requeuePeerMessages(env, projectId, ids)` → on push failure.

Three integration points:
- **Piggyback (user)** — `chat.ts:505 POST /:sessionId/prompt`
- **Piggyback (orchestrator)** — `orchestration-comms.ts:245`
- **Idle push (standalone turn)** — `agent-activity-callback.ts` on `activity === 'idle'`, via
  `executionCtx.waitUntil` after the durable write, with a background timeout.

`sendPromptToAgentOnNode` gains `injectedInstructions` in its existing `options` bag.
vm-agent `handleSendPrompt` accepts `injectedInstructions` and allows an **empty `prompt`** when it
is present (so a pure peer-message turn is not forced to fabricate a fake user message); at least
one of the two must be non-empty.

### 3. Honest interrupt tier

| Class | Behavior after this change |
|---|---|
| `notify` | enqueue only; delivered with the next turn |
| `deliver` | enqueue; delivered with the next turn; ack requested |
| `interrupt` | enqueue **+ soft ACP cancel** (`cancelAgentSessionOnNode`) → target's turn ends → idle callback injects it |
| `preempt_and_replan` | same as `interrupt`, ack required |
| `shutdown_with_final_prompt` | enqueue + soft cancel; **does NOT terminate the session** — described honestly, backlog task filed (rule 42) |
| hard stop | remains reserved for `stop_subtask` only |

Tool descriptions rewritten to state exactly this.

## Implementation checklist

### Shared types + limits
- [ ] `packages/shared/src/types/mailbox.ts`: add `MAILBOX_DEFAULTS` entries — `SEND_RATE_LIMIT`,
      `SEND_RATE_LIMIT_WINDOW_MS`, `INTERRUPT_RATE_LIMIT`, `MAX_PENDING_PER_SESSION`,
      `INJECTION_MAX_MESSAGES`, `INJECTION_MAX_CHARS`, `PUSH_REQUEST_TIMEOUT_MS`.
- [ ] `_helpers.ts getMcpLimits`: read each via `parsePositiveInt(env.X, DEFAULT)`.
- [ ] Document every new env var in `apps/api/.env.example` (+ env-reference if it enumerates).

### DO (mailbox)
- [ ] `mailbox.ts`: `claimPendingForDelivery(sql, targetSessionId, limit)` — single synchronous
      select + `markDelivered` per row; returns the claimed messages.
- [ ] `mailbox.ts enqueueMessage`: per-sender rate-limit counts (all classes + interrupt-class
      subset) and per-target-session pending cap; throw typed errors.
- [ ] `project-data/index.ts`: RPC wrappers `claimPendingMailboxMessagesForDelivery`,
      `requeueMailboxMessages`; `services/project-data.ts` passthroughs.
- [ ] Confirm no new DO migration is needed (reusing `session_inbox` columns + existing indexes).

### MCP tools
- [ ] `mailbox-tools.ts`: rename `resolveChildForMailbox` → `resolveMailboxTarget`; drop parent
      check; add self-send block; resolve sender task title from the verified token's taskId.
- [ ] `mailbox-tools.ts`: replace `attemptImmediateDelivery`'s pre-persist + raw-content push with
      the class-driven path (no pre-persist; soft cancel for interrupt-tier).
- [ ] `tool-definitions-orchestration-tools.ts`: rewrite `send_durable_message` description (project
      scope + per-class behavior); correct `send_message_to_subtask` / `stop_subtask` wording.
- [ ] Keep `get_pending_messages` / `ack_message` working (pull path stays as a fallback).

### Control plane delivery
- [ ] New `services/mailbox-delivery.ts` (claim / build block / requeue).
- [ ] `node-agent.ts sendPromptToAgentOnNode`: `options.injectedInstructions`.
- [ ] `chat.ts POST /:sessionId/prompt`: claim → inject → requeue on failure.
- [ ] `orchestration-comms.ts handleSendMessageToSubtask`: same.
- [ ] `agent-activity-callback.ts`: on `idle`, `waitUntil` claim → standalone push → requeue on
      failure; bounded background timeout.

### vm-agent
- [ ] New `internal/server/agent_prompt.go`: shared `buildPromptParams(visible, injected, messageID)`
      (extracted from `buildInitialPromptParams`, which becomes a thin caller).
- [ ] `handleSendPrompt`: accept `injectedInstructions`; allow empty `prompt` when injected is
      present; reject when both empty; use the shared builder; `trustedSource=true` (server-built).
- [ ] Keep `gateway.go:442` at `trustedSource=false` (unchanged, still stripped).

### Tests
- [ ] **Rule 51 discriminating**: sender in project A targets a task in project B (real victim id in
      body) → rejected, no enqueue. Verify it fails on pre-fix code.
- [ ] Self-send rejected; sender attribution ignores body-supplied sender fields.
- [ ] Rate limit: at-limit rejection + window rollover; interrupt sub-limit independent.
- [ ] **Rule 45**: two concurrent claims → each message claimed exactly once (dynamic state-mutating
      mock; verified to fail when the claim is split into read-then-write).
- [ ] Fence escape: content containing the closing delimiter cannot break out of the block.
- [ ] Class behavior: `interrupt` calls `cancelAgentSessionOnNode`; `deliver`/`notify` do not;
      `stop_subtask` still uses `stopAgentSessionOnNode`.
- [ ] Push failure → messages requeued (not lost); repeated failure terminates via max attempts.
- [ ] **Rule 35 vertical slice** send→inject→render, parameterized over `claude-code` **and**
      `openai-codex` (injection is ACP-level and must be agent-agnostic).
- [ ] **Rule 23 contract**: `/prompt` body now carries `injectedInstructions` — assert TS sender and
      Go receiver agree (extend `vm-agent-cross-boundary-contract.test.ts`).
- [ ] Go: injected block carries the marker; user text containing literal `_meta` JSON does not;
      empty prompt + injected allowed; both empty → 400.
- [ ] Web: `AcpConversationItemView` collapses an injected peer-message block (behavioral render
      test, not source-contract).

### Docs + process
- [ ] Update public docs if agent-communication behavior is documented there.
- [ ] Backlog: `persistMessage` single-path drops `origin` (+ broadcast hardcodes null, + topic
      capture lacks the guard).
- [ ] Backlog: real `shutdown_with_final_prompt` session-termination semantics (rule 42 tracking).
- [ ] Post-mortem + process fix in the PR (rule 02).

## Acceptance criteria

1. An agent can `send_durable_message` to **any active peer task in the same project** (sibling,
   parent, unrelated) — and still **cannot** reach another project's task.
2. An agent cannot message itself.
3. Sender identity on every stored message comes from the verified MCP token; a body field claiming
   a different sender has no effect.
4. Send rate limits and size caps are enforced, atomic, and env-configurable with `DEFAULT_*`.
5. A message sent while the target is mid-prompt is delivered **on the target's next turn** without
   the target having to call `get_pending_messages`.
6. Delivered peer messages appear as fenced, provenance-marked `origin=system` content: collapsed in
   the UI, excluded from search/FTS, dedup, topic capture, and attention resolution.
7. Injection works identically for `claude-code` and `openai-codex` sessions.
8. `interrupt`-class sends soft-cancel the target's in-flight prompt; hard stop remains exclusive to
   `stop_subtask`.
9. Tool descriptions accurately state what each message class does.
10. A failed push requeues rather than losing the message, and cannot retry forever.

## References

- Rules: 02 (quality gates), 18 (file size), 23 (cross-boundary contracts), 27 (vm-agent staging
  refresh), 31 (migration safety), 34 (VM-agent callback auth), 35 (vertical slice), 42 (no
  untracked degrading placeholders), 45 (DO check-then-act), 47 (control-loop I/O budget),
  51 (server-side gates / never trust a client identifier).
- Prior art: `tasks/active/2026-07-07-origin-tag-injected-messages-persist-hide.md` (the origin
  pipeline being extended), `tasks/active/2026-05-19-pre-persist-orchestration-prompts.md`.
</content>
</invoke>
