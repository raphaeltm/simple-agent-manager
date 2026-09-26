# Preserve transcript messages across pagination and reporter payload limits

Ideas: `01M2YZJDPNTBT7W48EZ7XZY8EE` (pagination ties), `01KSTVJ0KCS4HGK939S57F5G6J` (reporter payloads).
Started by Sol task `01M3CW7G3XNQTFTY3ST0RTG8MB` (stopped at its usage limit before a PR); finished in session `1df85b1b` on 2026-09-26.

## Problem

1. **Pagination ties.** Root (`messages.ts getMessages`) and archived (`compact-archive.ts matchesRawPage`) reads bounded `before`/`after` on `created_at` alone while sorting by `created_at, sequence`. A page ending inside a group of rows sharing one timestamp dropped the rest of the group from every later page. A whole VM-agent batch can share a timestamp, so this is reachable in long sessions.
2. **Reporter payloads.** The VM agent truncated content at enqueue by slicing bytes (splitting multi-byte runes), and when a single message's request exceeded the Worker body limit its size fallback silently dropped all tool metadata (tool cards lost title/kind/status), then replaced content with an "omitted" marker. A batch mixing an earlier session's leftover rows with the current session's was rejected as a whole and discarded. `204` (the Worker declining writes for an inactive workspace or session) was treated as a successful delivery.

## Research

- `ARCHIVE_TABLE_SPECS.chat_messages` (archive copy) already pages by `(created_at, sequence, id)`; `compactExportCandidates` hand-rolled the same comparison.
- Every `chat_messages` insert assigns `sequence`; migration 007 backfilled old rows from `rowid`. All server-originated messages (REST, `message.new`, `messages.batch`) carry it; only optimistic web rows lack it (and carry a client-clock `createdAt`).
- Main's web delta anchored on the last cached row, including optimistic ones, with a numeric timestamp, and read newest-first, so a backlog larger than one delta page (5000) left a gap.
- Sol's multipart upload path could not ship: it committed up to 8 MiB into one Durable Object SQLite row (platform max 2 MB, so large messages failed and retried forever, blocking the session), bypassed the `#1875` storage firebreak's 128 KiB tool-metadata cap in a root object near 10 GB, retried `204` and permanent `4xx` forever, and stranded other-session rows. It was replaced, not repaired.
- The Worker enforces `MESSAGE_SIZE_THRESHOLD` on UTF-16 length and `MAX_MESSAGES_PAYLOAD_BYTES` on the body; the agent's byte limits are always at least as strict, so no API change is needed for the reporter.
- Reporters are per workspace and outlive a chat session (`getOrCreateReporter`, `SetSessionID`); a terminal flag disables one for its lifetime, so `204` must not be terminal.

## Checklist

- [x] Shared cursor contract: `packages/shared/src/message-cursor.ts` (`MessagePosition`, `formatMessageCursor`, Valibot-validated `parseMessageCursor`, `compareMessagePositions`).
- [x] DO bounds in one module (`project-data/message-cursor.ts`): `chat_messages` SQL, archive-chunk selection (inclusive for exact positions), in-memory rows; `getMessages` orders by `(created_at, sequence, id)`; `compactExportCandidates` reuses it.
- [x] Routes accept exact or legacy cursors, reject malformed ones (previously `NaN` passed), and read `after`-only pages forward; query parsing split into `routes/chat-message-query.ts`.
- [x] Web `lib/message-paging.ts`: cursors only from server-persisted rows; `refreshCachedTranscript` drains forward and fails visibly instead of returning a partial range (`DEFAULT_CHAT_DELTA_MAX_PAGES`, `VITE_CHAT_DELTA_MAX_PAGES`); load-more, load-until, timeline and workspace chat use exact cursors.
- [x] Reporter `transport_fit.go`: every message shaped at enqueue to fit one request — rune-safe truncation with marker, tool-metadata identity summary with `contentTruncated`/`transportTruncated`/`originalSizeBytes`, content shortened only as needed.
- [x] Reporter batches are one session per request; `204` is an explicit declined discard that keeps the reporter running; the mismatch fallback's omitted form keeps a truncation record instead of dropping metadata.
- [x] Removed the upload path, its migration, admin quarantine routes, env vars and docs; reverted `.codex/config.toml` auto-save artifacts.
- [x] Tests enter through real triggers (HTTP routes via `SELF`, archive sweep, `Enqueue` + flush against a fake control plane enforcing the Worker's rules); each guard was reverted once and the intended tests went red.
- [x] Docs: API and env references.
- [x] Backlog: `2026-09-25-reporter-session-switch-unsent-rows.md` (pre-existing relink cleanup, with reproduction), `2026-09-26-chat-recent-window-merge-can-leave-gap.md` (pre-existing poll/catch-up window gap).
- [ ] Full checks, specialist review, staging VM validation, PR, CodeRabbit, merge, production monitoring.

## Acceptance

- No persisted message is skipped or duplicated because a page boundary falls inside a group of tied timestamps, forward or backward, root or archived.
- The web refresh never anchors on an optimistic row and never merges a partial forward range.
- No message is rejected for size after it is queued; any reduction is explicit in the persisted message (marker or flags with original size), and tool cards keep their identity.
- A leftover earlier-session row never causes the current session's messages to be discarded.
- `204` is not counted as delivery and does not stop the reporter.
