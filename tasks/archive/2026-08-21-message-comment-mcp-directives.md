# Message comment MCP/directives constituent PR

## Problem

SAM's message-anchored commenting MVP needs an agent-facing layer and an explicit
human "send to agent" directive path. This constituent PR owns the MCP tools and
directive delivery contract only. The backend sibling will provide ProjectData
comment storage/RPC, and the UI sibling will provide the human interface.

Constraints:

- Leave this as an open constituent PR to `main`.
- Do not merge.
- Do not deploy or mutate staging.
- Scope to message-anchored comments only.
- Exclude file comments/re-anchoring, @mentions, reactions, and unrelated tool changes.

## Research findings

- The MCP endpoint is centralized in `apps/api/src/routes/mcp/index.ts`, with
  tool metadata in `apps/api/src/routes/mcp/tool-definitions*.ts` and shared
  auth/rate-limit/sanitization helpers in `apps/api/src/routes/mcp/_helpers.ts`.
- MCP identity comes from the verified opaque token in
  `apps/api/src/services/mcp-token.ts`; tools should derive project, user, task,
  workspace, and current session from that token instead of accepting caller
  supplied project identifiers.
- Existing durable follow-up delivery uses `projectDataService.acceptPromptDelivery`
  with a `PromptDeliverySource`, persists a transcript message, enqueues one
  mailbox item, and handles idempotency through `deliveryId`.
- Existing read/ack state lives in the durable mailbox and attention/message
  lifecycle. Comment directives should reuse those fields instead of adding a
  separate inbox.
- ProjectData RPC/storage types for comments are not present on `main`, so this
  PR needs an explicit narrow adapter contract that the backend sibling can
  implement without rewriting the MCP/directive layer.
- Existing broad MCP route tests assert exact tool discoverability; adding tools
  requires updating that contract and focused handler/service tests.

## Implementation checklist

- [x] Add shared message-comment types and the comment directive delivery source.
- [x] Add a narrow message-comment service adapter contract with bounded input,
      sanitized output, deterministic safe errors, session verification, and
      directive delivery helper.
- [x] Add MCP tool definitions for listing, inspecting, creating, replying,
      resolving, and reopening message comment threads.
- [x] Add MCP handlers wired to verified token identity and same-session checks.
- [x] Add a REST route for the explicit UI send-to-agent action that enqueues one
      durable directive with minimal comment context and idempotent delivery ID.
- [x] Add focused tests for tool discoverability/contracts, empty/pagination,
      project isolation, wrong-session rejection, spoof prevention, idempotency,
      FIFO, provenance, and minimal-context directive payloads.
- [x] Document backend adapter assumptions.

## Validation

- `pnpm --filter @simple-agent-manager/shared build` — passed.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `pnpm --filter @simple-agent-manager/api build` — passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/mcp-message-comments.test.ts tests/unit/services/message-comments.test.ts tests/unit/routes/chat-comment-directives.test.ts tests/unit/routes/mcp.test.ts`
  — passed, 4 files / 249 tests.
- `pnpm check:fast` — passed. Existing warning-only lint debt was reported in
  unrelated UI/client files; no errors and no blocking type-boundary findings.
- `pnpm format:check` — passed after updating the API reference skill doc.
- `git diff --check` — passed.

## Acceptance criteria

- Agents can discover bounded open message-comment summaries for their current
  session and inspect a full thread without passive full-thread context injection.
- Agents can create/reply/resolve/reopen only through verified-token
  project/session-scoped handlers; author provenance is server-derived.
- Human send-to-agent delivery enqueues exactly one durable follow-up per stable
  comment directive ID and preserves FIFO ordering under concurrent sends.
- The directive payload contains only comment ID, quoted message context, author,
  and minimal thread metadata.
- Tests cover contracts, happy paths, empty/pagination behavior, isolation,
  spoof/wrong-session rejection, idempotent send, FIFO, provenance, and bounded
  payloads.
- Backend storage dependencies are isolated behind an explicit adapter contract
  and documented for the primary integrator.
