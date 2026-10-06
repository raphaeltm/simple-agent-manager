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
- The Worker answers `400` for a whole batch when one row is invalid (`validateMessageEntry`), and `400 Session mismatch` when the workspace is linked to another session (`rejectMessageSessionMismatch`); main discarded the whole batch on any `400`, and retried forever when even a row's omitted form was too large.
- Sol's DO migration `059-message-upload-parts` ran on staging. DO migrations may never drop tables (`check-do-migration-safety`), so staging objects keep an unused table; the name is retired in a comment at the end of the migration list.

## Checklist

- [x] Shared cursor contract: `packages/shared/src/message-cursor.ts` (`MessagePosition`, `formatMessageCursor`, Valibot-validated `parseMessageCursor`, `compareMessagePositions`).
- [x] DO bounds in one module (`project-data/message-cursor.ts`): `chat_messages` SQL, archive-chunk selection (inclusive for exact positions), in-memory rows; `getMessages` orders by `(created_at, sequence, id)`; `compactExportCandidates` reuses it.
- [x] Routes accept exact or legacy cursors, reject malformed ones (previously `NaN` passed), and read `after`-only pages forward; query parsing split into `routes/chat-message-query.ts`.
- [x] Web `lib/message-paging.ts`: cursors only from server-persisted rows; `refreshCachedTranscript` drains forward and throws instead of returning a partial range (`DEFAULT_CHAT_DELTA_MAX_PAGES`, `VITE_CHAT_DELTA_MAX_PAGES`); `fetchHistoryUntil` holds the load-until loop; load-more, timeline and workspace chat use exact cursors; `merge-messages.ts` sorts persisted rows with the shared `compareMessagePositions`.
- [x] Storage-safety minimal tool metadata keeps `toolName` (typed tool cards key on it), matching the transport summary.
- [x] Reporter `transport_fit.go`: every message shaped at enqueue to fit one request — rune-safe truncation with marker, tool-metadata identity summary with `contentTruncated`/`transportTruncated`/`originalSizeBytes`, content shortened only as needed.
- [x] Reporter batches are one session per request. A rejected multi-row batch is retried row by row, so only a refused row is lost; `204` and a session mismatch settle every queued row of that session in one step and keep the reporter running; a row refused even in its omitted form (which keeps a truncation record, not bare metadata loss) is dropped instead of blocking the outbox.
- [x] Archive chunk selection skips a chunk whose edge row is the page cursor, so aligned pages and chunks (500 and 500 by default) and a refresh of an archived session read no chunk they would discard.
- [x] The web append merge indexes user messages, so reconciling a drained refresh of tens of thousands of rows is linear rather than quadratic.
- [x] Removed the upload path, its migration, admin quarantine routes, env vars and docs; reverted `.codex/config.toml` auto-save artifacts.
- [x] Tests enter through real triggers (HTTP routes via `SELF`, archive sweep, `Enqueue` + flush against a fake control plane enforcing the Worker's checks in the Worker's order, with its default limits); each guard was reverted once and the intended tests went red. Legacy numeric cursors are covered for archived sessions too, and archived reads count their R2 chunk fetches.
- [x] Docs: API and env references.
- [x] Backlog: `2026-09-25-reporter-session-switch-unsent-rows.md` (pre-existing relink cleanup, with reproduction), `2026-09-26-chat-recent-window-merge-can-leave-gap.md` (pre-existing poll/catch-up window gap), `2026-09-26-split-use-session-lifecycle.md` (hook still over the file-size ceiling), `2026-09-26-chat-reopen-within-stale-time-misses-messages.md` (pre-existing, found on staging: a chat reopened inside the cache's 15 s stale time never refreshes).
- [x] Full checks at 59caab665: `pnpm check:fast`, `typecheck`, `test` (21/21), `build`, `go test -race ./...` (25 packages), API worker suite (92 files at 5c88a0353; archive and pagination files after the final fixes).
- [x] Specialist review: task-completion PASS; architecture, constitution, Go, Cloudflare, test and performance reviewers ADDRESSED (details in the PR).
- [x] Staging VM validation (deploy run 36227162250). Evidence is below.
- [ ] PR, CodeRabbit, merge, production deploy monitoring.

## Staging evidence (2026-09-26)

- **Node:** fresh node `01M3EB40…` created 07:50:48Z, first heartbeat 07:53:22Z. It reports `agent_version` `2c586a621`, this branch's last `packages/vm-agent` commit. The workspace subdomain serves valid TLS, and the agent answers 401 without credentials.
- **ASCII tool output:** 3,000 lines of Bash output were persisted as a 102,400-byte tool message ending with the truncation marker.
- **Paging:** forward and backward paging at page sizes 2, 3 and 7 returned the exact transcript.
- **Composer send:** a follow-up sent through the composer (the Send button) was delivered, and its reply rendered.
- **Multi-byte tool output:** a one-byte prefix plus four-byte characters puts main's byte cut inside a character. It was persisted as 102,397 bytes: valid UTF-8 with no U+FFFD, ending on a whole character, then the marker.
- **Reopen after the stale time:** a chat reopened 20 s after a reply landed while it was closed made one request, `after=[createdAt,sequence,id]` taken from the persisted cache, and rendered the reply. There were no console errors on desktop or mobile.
- **Cleanup:** the workspace and node were deleted, the test env var removed, and staging is back to zero live nodes.

## Acceptance

- No persisted message is skipped or duplicated because a page boundary falls inside a group of tied timestamps, forward or backward, root or archived.
- The web refresh never anchors on an optimistic row and never merges a partial forward range.
- No message is rejected for size after it is queued; any reduction is explicit in the persisted message (marker or flags with original size), and tool cards keep their identity.
- A leftover earlier-session row never causes the current session's messages to be discarded.
- A row the control plane refuses never takes its batch-mates with it, and never blocks the outbox.
- `204` is not counted as delivery and does not stop the reporter.
