# Group streaming deltas server-side and collapse tool-call runs into a count card

- **SAM task**: `01M2CNTNXC7VWZTKRR17WCPBZS`
- **SAM idea**: `01M27M6BDJCRVE1FFQA5BXAQ5D`
- **Branch**: `sam/group-streaming-assistant-deltas-wcpbzs`

## Problem

SAM persists **every streaming token as its own `chat_messages` row** in the ProjectData
Durable Object. Measured on a real 255-message session (idea `01M27M6BDJCRVE1FFQA5BXAQ5D`):

| role      | rows | bytes  | % of payload | avg bytes/row |
| --------- | ---- | ------ | ------------ | ------------- |
| assistant | 239  | 53,051 | **82.1 %**   | 221           |
| tool      | 12   | 10,138 | 15.7 %       | 844           |
| user      | 2    | 944    | 1.5 %        | 472           |
| thinking  | 2    | 456    | 0.7 %        | 228           |

Assistant content length in that session: min 1 / p50 **4** / max 14 characters. 118 of 239
rows carried three characters or fewer. **1,017 characters of text were delivered as 53,051
bytes — a 52x envelope overhead.**

The client already throws the fragmentation away: `groupMessages()` /
`chatMessagesToConversationItems()` merge consecutive `assistant|tool|thinking` rows on
receipt, so the server ships 239 rows and the browser renders 8 bubbles.

This is simultaneously the biggest lever on:
- (a) chat-open latency,
- (b) ProjectData storage growth (~75 MB/day against an object at ~97 % of its 10 GB ceiling),
- (c) Durable Object active time (ProjectData bills ~68 wall-hours/day, 56 % of the account's
  DO duration).

Second problem, same root cause: Raphaël's readability decision (2026-09-11, knowledge
`UIUX`) — tool calls should collapse by default into an inline card stating the count
("3 tool calls"); tapping expands the list; tapping one call fetches its output. He expects
~99 % of users never to expand either level; *seeing that tools are being called* is the
reassurance that matters.

## Research findings

### R1. Where deltas are written

Only three statements INSERT into `chat_messages` in the whole repo:

| Path | Location | Notes |
| ---- | -------- | ----- |
| single message | `messages-persist-helpers.ts:122` `insertNewMessage()` | browser `message.send`, durable prompt delivery. **Not** a streaming path. |
| **batch** | `messages.ts:244` `persistMessageBatch()` | **the streaming-delta path.** VM agent outbox → `POST /api/workspaces/:id/messages` → `routes/workspaces/runtime.ts:1679` → `services/project-data.ts:781` → DO `index.ts:445` → `message-persistence.ts:101`. |
| system notice | `messages.ts:670` `persistSystemMessage()` | idle-cleanup terminalization notice only. |

UPDATE: only `tool-payload-archive.ts:342 updateToolMetadata()` (tool rows, `SET tool_metadata`).
DELETE: only `archive-sharding.ts:2166` and `:2270` (archive teardown / verified source delete).

**→ Checklist: C1** (coalesce inside `persistMessageBatch`, before the INSERT).

### R2. HARD CONSTRAINT — a pinned structural invariant forbids rewriting or deleting rows

`apps/api/tests/unit/durable-objects/project-data-message-text-invariant.test.ts` scans every
module in `durable-objects/project-data/` and **fails** on any `UPDATE chat_messages ... SET
... content =` or any `DELETE FROM chat_messages` outside `archive-sharding.ts`. The product
invariant is: message TEXT is never deleted or rewritten by any path.

This rules out the "append the new delta onto the previous row" implementation. Coalescing
MUST happen **before** the INSERT, on the in-memory batch.

**→ Checklist: C1** (pre-insert coalescing only; the invariant test must stay green untouched).

### R3. HARD CONSTRAINT — comment threads cascade-delete off message ids

`migrations.ts:1287`: `comment_threads.message_id TEXT NOT NULL REFERENCES chat_messages(id)
ON DELETE CASCADE`. Merging *existing* rows would silently destroy every thread anchored on
the 2nd..Nth delta.

- Pre-insert coalescing is safe: absorbed ids never existed, so no thread can reference them.
- Read-path grouping does not delete anything, but if a commented row were absorbed into a
  group carrying a different id, the thread's anchor would not be in the returned set and the
  comment chip would vanish from the conversation.

The UI always anchors on the group's first id (`CommentableConversationItem.tsx:96`
`messageId={item.id}`, and `item.id` is the first row of the group), so UI-created comments
are safe by construction. An **agent**-created comment (MCP `create_message_comment_thread`)
can anchor on an arbitrary id, including a middle delta of a legacy session.

**→ Checklist: C5** (never absorb a row that has a comment thread anchored on it).

### R4. HARD CONSTRAINT — archive-sharding assumes strict 1:1 row mapping

`ARCHIVE_TABLE_SPECS.chat_messages` (`archive-sharding.ts:88`) copies
`id, session_id, role, content, tool_metadata, created_at, sequence, origin`, keyed by `id`,
ordered `created_at ASC, sequence ASC, id ASC`. Five places assume 1:1:
export (`:1765`), insert-with-conflict-probe (`:1438`), verification re-hash (`:1464`),
count reconciliation (`:1499`, `:1534`, `:1617`, `:1704`), and the terminal-version hash
(`:856`). The compact-R2 variant additionally stores a literal `row_ids_json`
(`compact-archive.ts:84`) and derives `messageCount` from `role_counts_json` (`:88`).

**Both changes are safe** as long as no *existing* row is reshaped:
- Pre-insert coalescing only affects rows that have not been written yet.
- Read-path grouping lives in `formatMessageRows`, which the archive **export** path does not
  use (export has its own SQL at `archive-sharding.ts:1765`).

**→ Checklist: C2** (grouping lives in `formatMessageRows`; archive export untouched) and
**V4** (a test that pins archive export/row-count behaviour is unchanged).

### R5. The read path — one choke point

```
GET /api/projects/:id/sessions/:sid          routes/chat.ts:217
GET /api/projects/:id/sessions/:sid/messages routes/chat.ts:359
  -> services/project-data.ts:858 getMessages
     -> root  : index.ts:740 archiveSourceGetMessages -> archive-sharding.ts:2419 -> messages.getMessages
     -> shard : index.ts:861 archiveTargetGetMessages -> archive-sharding.ts:2540
                  -> compactArchive.compactRawPage -> messages.formatMessageRows
                  -> or messages.getMessages
  -> messages.ts:339 getMessages -> messages.ts:395 formatMessageRows   <-- ALL FOUR MEET HERE
```

`formatMessageRows` is the single place every client read funnels through.

**→ Checklist: C2.**

### R6. Live streaming is the `messages.batch` broadcast, not a separate socket

`useChatWebSocket.ts:206` consumes `messages.batch`; the DO emits it from
`message-persistence.ts:137` with the rows it just persisted. The VM agent flushes every
`BatchMaxWait = 2s` with at most `BatchMaxSize = 50` rows
(`packages/vm-agent/internal/messagereport/config.go`).

So "token-by-token streaming" is already a 2-second, ≤50-row cadence. Coalescing **within one
flush** emits one merged row per flush instead of 50 — the browser applies them in the same
tick and merges them anyway, so the visual cadence is byte-for-byte identical.

**→ Checklist: C1, V2** (a test that the broadcast still fires per flush with the merged row).

### R7. Retry dedup survives coalescing, because the surviving id is the run's FIRST id

The VM agent deletes an outbox batch only after a 2xx (`reporter.go:512`), and `readBatch()`
re-reads the same `ORDER BY id ASC LIMIT ?` prefix, so a retry replays an identical batch.
Coalescing keeps the first entry's `messageId`, and the existing dedup probe
(`messages.ts:189` `SELECT id FROM chat_messages WHERE id = ?`) sees it. No new state needed.

**→ Checklist: C1, V3** (replay the exact same batch twice; assert no duplicated text).

### R8. Client merge semantics already tolerate a grouped superset

`mergeReplace` (`apps/web/src/lib/merge-messages.ts`) keeps `prev` rows only when they predate
the oldest incoming row; everything inside the incoming window is replaced. So when the 3 s
poll or a reconnect catch-up returns `AD(id=A, content=t1+t2)` while the live state holds
`A(t1)` and `D(t2)`, `A` is superseded and `D` is dropped. No duplicated text.

`mergeAppend` (live WS, and the `after=` delta query) only ever sees rows newer than the
cached tail, so it cannot overlap a group. `mergePrepend` gives `prev` priority, so a
load-earlier page cannot re-add absorbed text.

**→ Checklist: V5** (explicit merge-strategy regression tests for the grouped-superset case).

### R9. `sequence` is dense, and is the correct contiguity discriminator

Every insert path allocates from `nextSequence()` = `MAX(sequence)+1`
(`messages-persist-helpers.ts:33`), and migration 007 backfilled `sequence = rowid`
(`migrations.ts:470`). So two rows that were adjacent in the transcript have adjacent
sequences.

Grouping on "consecutive in the returned array" alone is wrong under a `roles` filter or
across a page boundary: filtering out the interleaved `tool` rows would make two *different*
assistant turns adjacent and merge them. Requiring `prev.sequence + 1 === next.sequence`
makes a group exactly a contiguous same-role run of the real transcript, under any filter.

**→ Checklist: C2, V6** (a role-filtered read must not merge across an elided tool row).

### R10. The `origin != 'system'` trap

`materializeSession` (`materialization.ts:36`) filters `COALESCE(origin,'user') != 'system'`
because it only builds the FTS index. The read path must **not** copy that filter — the
"Show system context" disclosure (`AcpConversationItemView.tsx` `CollapsedInjectedMessage`)
renders exactly those rows.

**→ Checklist: C2, V1** (system-origin rows stay visible in the vertical-slice test).

### R11. Four copies of the same grouping rule exist

1. `materialization.ts:18` `GROUPABLE_ROLES = {assistant, tool, thinking}` (FTS index)
2. `routes/mcp/session-tools.ts:73` `groupTokensIntoMessages()` (MCP)
3. `durable-objects/sam-session/tools/get-session-messages.ts:101` (re-uses #2)
4. `apps/web/.../types.ts:180` `groupMessages()` + `chatMessagesToConversationItems()`

Adding a fifth would violate `.claude/rules/24` and Raphaël's DRY preference. Extract ONE
primitive parameterised by its role set — **not** one shared predicate (`.claude/rules/67`:
the read path must NOT include `tool`, materialization must keep it).

**→ Checklist: C3.**

### R12. Latent bug in the blast radius: "final assistant message" is one token

`services/task-final-assistant-message.ts:17` calls `getMessages(limit=1, roles=['assistant'],
order='desc')`. With one row per streamed token, the "final assistant message" surfaced on a
task is literally the **last delta** — frequently a single character. The 2000-char cap makes
the intent obvious. Grouping alone does not fix it: only one row is fetched.

**→ Checklist: C6** (fetch a bounded window and return the last group).

### R13. The initial-load ceiling

`useSessionLifecycle.ts:96` and `lib/query-options/chats.ts:106` request
`DEFAULT_CHAT_SESSION_MESSAGE_MAX` (50,000) so the whole conversation arrives at once.
`hasMore` + "Load earlier messages" (`MessageListScaffold.tsx:29`) and `loadUntil()`
(`useSessionLifecycle.ts:656`, used by timeline jump so a jump never dead-clicks) already
exist. The timeline itself does **not** depend on the chat window: it has its own
server-backed user-turn query (`timelineUserMessagesQueryOptions`).

**→ Checklist: C7.**

### R14. Typed tool cards must not be swallowed by the count card

`matchToolCard()` (`tool-cards/index.ts`) renders `DocumentCard` for
`upload_to_library` / `replace_library_file` / `display_from_library`. Policy `bb0b7af1`
requires library display cards to render across agents — collapsing a deliberately displayed
document into "3 tool calls" would hide it.

**→ Checklist: C8** (a typed-card tool call breaks the run and renders standalone).

## Design

### A. Persist-time coalescing at the flush boundary (storage + write amplification)
Consecutive `assistant` / `thinking` entries **within one flush batch** are merged before the
INSERT into a single row that keeps the first entry's `messageId`, `timestamp`, `sequence` and
`origin`. Merge requires: same role, role is groupable, same `origin`, both `toolMetadata`
empty, and combined content within a configurable cap.

### B. Read-path grouping (payload win for new AND legacy sessions)
`formatMessageRows` groups contiguous same-role `assistant` / `thinking` raw rows into one
output row keeping the first row's identity. Requires `sequence` adjacency, equal `origin`,
no `tool_metadata` on either row, no comment-thread anchor on the absorbed row, and a
configurable max group size. `tool` is deliberately NOT groupable. Grouping runs on raw rows
before valibot parsing, so it also cuts DO CPU.

### C. Tool-run count card (readability)
A new `tool_call_group` conversation item collapses a run of consecutive generic tool calls
into one inline card ("3 tool calls"). Tap expands the list; tapping a row uses the existing
`…/messages/:messageId/tool-content` lazy load. Typed-card tools break the run.

### D. Bounded initial load
The initial session load requests `DEFAULT_CHAT_SESSION_MESSAGE_LIMIT` (500) instead of
`DEFAULT_CHAT_SESSION_MESSAGE_MAX` (50,000).

## Implementation checklist

### Shared primitive
- [ ] **C3** Add `apps/api/src/durable-objects/project-data/message-grouping.ts`: one
      `groupConsecutiveRows()` primitive parameterised by role set + adjacency + guards.
      Re-use it from `materialization.ts` (roles incl. `tool`) and the read path
      (roles excl. `tool`). Re-use it from `routes/mcp/session-tools.ts` so the fourth
      hand-rolled copy disappears.

### Persistence
- [ ] **C1** Coalesce consecutive assistant/thinking entries within a batch in
      `persistMessageBatch` before the INSERT. Keep first id/timestamp/sequence/origin.
      No `UPDATE`, no `DELETE` (R2).
- [ ] **C1b** Add `PROJECT_DATA_MESSAGE_COALESCE_MAX_CHARS` (env, documented default) to bound
      a merged row, and `PROJECT_DATA_MESSAGE_COALESCE_ENABLED` as an operator kill switch.

### Read path
- [ ] **C2** Group contiguous assistant/thinking rows in `formatMessageRows`, before parsing.
      Must NOT filter `origin='system'` (R10). Must keep `hasMore` and the `before` cursor
      contract unchanged (group identity = first row's `id`/`createdAt`/`sequence`).
- [ ] **C2b** Add `PROJECT_DATA_MESSAGE_GROUPING_ENABLED` kill switch +
      `PROJECT_DATA_MESSAGE_GROUP_MAX_CHARS` bound.
- [ ] **C5** Never absorb a row that has a comment thread anchored on it (one DO-local
      `SELECT DISTINCT message_id FROM comment_threads WHERE session_id = ?`, tolerant of a
      missing table).
- [ ] **C6** `getLatestAssistantMessageForTask` fetches a bounded window and returns the last
      grouped turn instead of the last token.

### Web
- [ ] **C8** Add the `tool_call_group` item kind + `ToolCallGroupCard` to `packages/acp-client`
      and a `collapseToolRuns()` pass in the project-chat conversion. Typed-card tools break a
      run. Expand-all preference persisted.
- [ ] **C7** Initial session load requests `DEFAULT_CHAT_SESSION_MESSAGE_LIMIT`.

### Docs / config
- [ ] **C9** Document the new env vars in `apps/api/.env.example` + `apps/api/src/env.ts`, and
      update any public docs that describe chat message loading.

## Verification / acceptance criteria

- [ ] **V1** Vertical slice through the real ProjectData DO (Workers test config):
      `persistMessageBatch` → `getMessages` → grouped output, including
      **`origin='system'` rows staying visible and ungrouped**.
- [ ] **V2** The `messages.batch` broadcast still fires once per flush and carries the merged
      row (live streaming preserved), driven through the real DO method, not a hand-fed payload.
- [ ] **V3** Replaying the identical batch twice persists nothing the second time and does not
      duplicate text.
- [ ] **V4** Archive export row columns / counts are unchanged by grouping (grouping is a read
      concern only).
- [ ] **V5** `mergeMessages` regression tests for the grouped-superset case across
      replace / append / prepend.
- [ ] **V6** A role-filtered read does NOT merge two assistant turns separated by an elided
      tool row (sequence-adjacency discriminator).
- [ ] **V7** Comment-anchored rows are never absorbed; the thread still resolves.
- [ ] **V8** Playwright audit of the count card at 375 px and 1280 px with a stress session
      (40-call run, 1-call run, failed call, running call, long thinking, interleaved text),
      `assertNoOverflow`, screenshots reviewed and posted to the PR.
- [ ] **V9** Before/after payload bytes measured for the same session, reported in the PR.
- [ ] **V10** Staging deploy + live end-to-end verification of a real chat session.

## References

- SAM idea `01M27M6BDJCRVE1FFQA5BXAQ5D` (measurements, approved design, traps)
- knowledge `UIUX` (2026-09-11 tool-call collapse decision), `ProjectChatPerformance`,
  `DurableObjectStorage`
- `.claude/rules/44` (enumerate every writer), `/67` (never widen a shared predicate),
  `/62` (tests must observe the real trigger), `/50` (row fault isolation),
  `/24` (no duplicate implementations), `/17` (UI visual testing), `/13` (staging)
