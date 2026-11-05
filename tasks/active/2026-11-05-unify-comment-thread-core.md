# Unify the comment systems onto one shared thread core, migrate data, add an agent-wake policy seam

Task `01M6N9QFRMGW6CNXA7BTM65VZM`. Groundwork for Human tasks (idea `01M6MFVAJF20DZK8NJ97VAXC7A`,
section "Relationship to the existing comment system"). Human tasks themselves are out of scope.

**Hold (set by Raphaël in the task brief): DRAFT PR ONLY. Do not merge, do not mark ready. Stop after
staging verification and report.**

## Problem

ProjectData holds two parallel comment implementations: message comments (`comments.ts`, 785
lines, tables `comment_threads` / `comment_replies` / `comment_status_mutations`) and library-file
comments (`library-file-comments.ts`, 646 lines, `library_file_comment_*`). Thread, reply,
status-mutation, version and client-mutation idempotency logic is written twice, and a third anchor
kind (`human_task`) would make it three times. The split is deliberate because widening
`comment_threads` once deleted the session-scoping check (`apps/api/.claude/rules/63`).

Agent wakes from humans (Send to agent, a teammate's typed message) are authorized ad hoc with
`requireSessionWriter` at each call site, plus a separate delivery-time fence in the DO. Human
tasks will add a third wake path where a teammate's comment prompts someone else's agent.

## Research findings

- Message comments: anchored to `session_id` + `message_id` (NOT NULL, FK CASCADE to
  `chat_sessions` / `chat_messages`), optional quote, status `open|sent|resolved`, mentions
  (`mentions_json`, migration 064). Every read/mutate predicate carries `session_id = ?`.
- File comments: anchored to `file_id` (no FK; file lives in D1, checked by
  `assertLibraryFileInProject`), status `open|resolved` (sent rejected), no mentions.
- Fingerprints differ per kind (`thread`/`reply` vs `file_thread`/`file_reply`) and are stored in
  `client_mutation_fingerprint`; replays across the migration must keep matching, so copied rows
  keep the stored fingerprint and new code must build byte-identical fingerprints.
- Project inbox (`project-comment-inbox.ts`) merges both kinds under one budget.
- Archive sharding (`archive-sharding.ts`) refuses to archive a session that has message comments
  (cascade-deletion fence) and hashes comment counts into the session version digest. Both read
  the old tables, so both must move.
- DO migrations run inside `transactionSync` in the constructor. A throw breaks the whole project
  object, so parity failure must log, not throw.
- There is no comment "edit" feature today (verified: no route, no UI). Nothing to preserve.
- `requireSessionWriter` callers that cause a prompt: `chat-comments.ts` send, `send-chat.ts`
  (`authorizeSendChat`). The DO fence `senderLacksSessionAccess` re-checks both sources
  (`SESSION_WRITER_PROMPT_SOURCES`) at delivery.
- Directive metadata already records `userId`, `senderName`, and `onBehalfOfUserId`/`grantId`
  for grantees only. The web attribution and grant-revocation cancel paths key on those, so they
  stay unchanged; the wake record is added beside them.

## Writer enumeration of the old tables (rule 44)

| Writer                                                        | Old table(s)                                        | Decision                                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `comments.ts` `createCommentThread`                           | `comment_threads`                                   | switched to the shared core                                                                  |
| `comments.ts` `createCommentReply`                            | `comment_replies`, `comment_threads` (version bump) | switched                                                                                     |
| `comments.ts` `updateCommentThreadStatus`                     | `comment_threads`, `comment_status_mutations`       | switched                                                                                     |
| `library-file-comments.ts` `createFileCommentThread`          | `library_file_comment_threads`                      | switched                                                                                     |
| `library-file-comments.ts` `createFileCommentReply`           | `library_file_comment_replies`, threads             | switched                                                                                     |
| `library-file-comments.ts` `updateFileCommentThreadStatus`    | threads, `library_file_comment_status_mutations`    | switched                                                                                     |
| FK `ON DELETE CASCADE` from `chat_sessions` / `chat_messages` | message tables                                      | unchanged; the new tables carry the same cascade, and archive refuses sessions with comments |
| migration 064                                                 | `ALTER TABLE ... ADD COLUMN mentions_json`          | historical, schema only                                                                      |

Readers moved: `archive-sharding.ts` fence + digest, `project-comment-inbox.ts`, both modules' reads.

## Implementation checklist

- [x] DO migration `072-anchored-comment-threads`: new `anchored_comment_threads` /
      `anchored_comment_replies` / `anchored_comment_status_mutations`, per-kind CHECKs, indexes
- [x] Idempotent copy (ids, sequences, versions, fingerprints, mentions preserved), parity check
      (counts + EXCEPT content diff, per kind and table), logged per DO
- [x] Shared core: scope type + predicate, store (reads), mutations (create/reply/status)
- [x] Message adapter (`comments.ts`) and file adapter (`library-file-comments.ts`) on the core,
      public API and output shapes unchanged
- [x] Inbox reads one table
- [x] Archive fence + digest read the new tables
- [x] Add the migration module to `check-do-migration-safety.ts`
- [x] Machine-checked writer inventory: nothing in `src/` writes the old tables
- [x] `lib/agent-wake-policy.ts` (pure decision, mode `trusted_project`) +
      `services/agent-wake-authorization.ts`; used by comment send, `authorizeSendChat`, and the DO
      delivery fence
- [x] Wake record in delivery metadata (`wake`: triggeredBy, onBehalfOf, actorRole, mode, trigger)
- [x] Teammate attribution in the directive prompt (sender and comment author)
- [x] Tests: migration copy/parity/idempotent re-run/replay, cross-session + cross-file +
      cross-kind attacks with owner controls (proven discriminating), policy decisions, wake
      metadata, prompt attribution, existing suites updated
- [x] Backlog task: drop the frozen old tables later (separately approved)
- [x] Docs: architecture/collaboration docs that describe comment storage
- [ ] Staging: pre-existing comment data inventory before deploy, verify after deploy

## Acceptance criteria

- Every pre-existing thread/reply/status reads identically through the new structure (API, UI, MCP)
- Create, reply, resolve, reopen on message threads (desktop + mobile, quote anchors); Send to
  agent reaches the agent; file threads create/reply/resolve/reopen; Comments page counts; deep
  links + comment reader; mentions notify; MCP tools for both kinds; shared-access commenters
- No predicate on the new tables lacks `anchor_kind` + `scope_key` (except the documented
  project-wide inbox and by-id hydration of ids it ranked)
- Send-to-agent permissions are exactly as before
- All files under 500 lines

## Staging baseline (captured before deploying the branch, current staging build)

Inventory via `GET /api/projects/:id/comments` as the primary smoke user (`.tmp/staging/baseline/`):

| Project                                     | Message threads  | File threads                                    | Replies | Notes                                                                                           |
| ------------------------------------------- | ---------------- | ----------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `01KJNR9R3TEN3KX1ETE33852R8` Test Project 1 | 35 (15 sessions) | 0                                               | 10      | 14 sent (mostly by teammate dfv31 via shared access), 13 with mentions, quotes, resolved + open |
| `01KTKXZ4ZZAT6MJFXRW1ZTQ7RB` hono           | 20 (3 sessions)  | 4 (file `01KWMJ2QMRVV57SRK6P9C0343M`, 2 quoted) | 10      | open/sent/resolved                                                                              |
| `01KWHD8XS7MQ7R6KWXJYRHDVH4` Potato         | 3                | 0                                               | 2       | resolved, quoted                                                                                |
| `01KJVGMWX26SGQ5DX94GMTJRQN` Test Project 2 | 0                | 1                                               | 1       | resolved file thread                                                                            |

## Implementation notes

- Scope proof: replacing `ANCHOR_SCOPE_PREDICATE` with a version without `scope_key` reddened 10
  cross-session/cross-file tests; without `anchor_kind` reddened exactly the 2 cross-kind tests.
- `quality:ast-checks` learns `ANCHOR_SCOPE_PREDICATE` (2 binds) and `THREAD_SELECT_COLUMNS` (0) as
  frozen fragments, like the existing wake/link fragments.
- The Send-to-agent directive moved to `services/message-comment-directive.ts` (message-comments.ts
  was already over 500 lines).

## Staging evidence — window 1 (run 42003862079, 09:56–~10:08 UTC, then replaced by another branch)

| Check | Result |
| --- | --- |
| Pre-existing data read back through new tables (4 projects, 63 threads: every per-session list, per-file list, inbox) | Byte-identical JSON to the pre-deploy dump |
| Parity logs (`project_data.anchored_comments_migration.comments.migration_parity`, Workers Observability) | 15 project objects, all `ok: true`, 0 mismatched; e.g. `01KJNR9R3TEN3KX1ETE33852R8` threads 35/35, replies 10/10, status mutations 33/33; `01KTKXZ4ZZAT6MJFXRW1ZTQ7RB` 20+4 threads, 8+2 replies, 10 mutations |
| Old message thread `2c4c6087…` via comment reader (desktop): reply, resolve, reopen | All persisted; resolvedBy/reopenedBy recorded; 0 console errors |
| Old message thread `99e2048a…` via comment reader (mobile 375px): reply | Posted |
| New thread with quote + @mention of dfv31 | 201, quote kept, mention notification delivered to dfv31 (type `mention`) |
| File comments (file `01KWMJ2QMRVV57SRK6P9C0343M`): new thread with quote, reply, resolve, reopen; old thread `ce9ef7d0…` reopen, reply, resolve | All 200/201 |
| Cross-file route (`/library/not-this-file/comments/ce9ef7d0…/resolve`) and cross-session route (old thread via another session) | 404 / 404 |
| Comments page desktop + mobile, both projects | Counts 37 (35+2 new) and 25 (24+1 new); 0 console errors |
| Send to agent on `521480b8…` (owner) | 202; transcript row carries `metadata.wake` (`comment_directive`, `trusted_project`, owner, `teammateInput:false`). Agent not reached: that chat's Instant container runtime was gone (`container_runtime_unavailable`), unrelated to this change |

Other branches deployed over this build while it was being verified, so those builds (pre-072 code) read
and write the legacy tables. Writes made under them are not in the anchored tables (the documented
rollback behaviour, observed for real).

## Migration numbering

Branch `sam/build-draft-pr-implementing-pm2ayp` (task `01M6MHNBM96JSAMJ0GNTPM2AYP`) also adds a
`072-…` DO migration (`072-prompt-delivery-intent`). `runMigrations` keys on the full name, so both
apply. Whichever merges second renumbers to `073-…`. Renaming makes this migration run again on
objects that already ran it, which is safe: tables are `CREATE … IF NOT EXISTS` and the copy is
`INSERT … WHERE NOT EXISTS`. A re-run also copies legacy-only rows written by older builds in between.

## Migration cost (rule 81)

Copy + parity run once per project object in its constructor. Measured on better-sqlite3 with
100,000 threads + 100,000 replies (~200 bytes each): copy 1.9 s, parity 1.4 s, against the 30 s
`blockConcurrencyWhile` budget. Largest staging project: 35 threads.

## Rollback

The old tables are frozen, not dropped. Rolling the Worker back to the previous version reads and
writes the old tables again (comments created after the migration are invisible until roll-forward).
Roll-forward needs one new migration that re-runs the same idempotent copy
(`copyLegacyCommentRows`) to bring over rows created during the rollback window; status changes made
during the rollback window to rows that already exist in the new tables are not merged.
