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

| Writer | Old table(s) | Decision |
| --- | --- | --- |
| `comments.ts` `createCommentThread` | `comment_threads` | switched to the shared core |
| `comments.ts` `createCommentReply` | `comment_replies`, `comment_threads` (version bump) | switched |
| `comments.ts` `updateCommentThreadStatus` | `comment_threads`, `comment_status_mutations` | switched |
| `library-file-comments.ts` `createFileCommentThread` | `library_file_comment_threads` | switched |
| `library-file-comments.ts` `createFileCommentReply` | `library_file_comment_replies`, threads | switched |
| `library-file-comments.ts` `updateFileCommentThreadStatus` | threads, `library_file_comment_status_mutations` | switched |
| FK `ON DELETE CASCADE` from `chat_sessions` / `chat_messages` | message tables | unchanged; the new tables carry the same cascade, and archive refuses sessions with comments |
| migration 064 | `ALTER TABLE ... ADD COLUMN mentions_json` | historical, schema only |

Readers moved: `archive-sharding.ts` fence + digest, `project-comment-inbox.ts`, both modules' reads.

## Implementation checklist

- [ ] DO migration `072-anchored-comment-threads`: new `anchored_comment_threads` /
      `anchored_comment_replies` / `anchored_comment_status_mutations`, per-kind CHECKs, indexes
- [ ] Idempotent copy (ids, sequences, versions, fingerprints, mentions preserved), parity check
      (counts + EXCEPT content diff, per kind and table), logged per DO
- [ ] Shared core: scope type + predicate, store (reads), mutations (create/reply/status)
- [ ] Message adapter (`comments.ts`) and file adapter (`library-file-comments.ts`) on the core,
      public API and output shapes unchanged
- [ ] Inbox reads one table
- [ ] Archive fence + digest read the new tables
- [ ] Add the migration module to `check-do-migration-safety.ts`
- [ ] Machine-checked writer inventory: nothing in `src/` writes the old tables
- [ ] `lib/agent-wake-policy.ts` (pure decision, mode `trusted_project`) +
      `services/agent-wake-authorization.ts`; used by comment send, `authorizeSendChat`, and the DO
      delivery fence
- [ ] Wake record in delivery metadata (`wake`: triggeredBy, onBehalfOf, actorRole, mode, trigger)
- [ ] Teammate attribution in the directive prompt (sender and comment author)
- [ ] Tests: migration copy/parity/idempotent re-run/replay, cross-session + cross-file +
      cross-kind attacks with owner controls (proven discriminating), policy decisions, wake
      metadata, prompt attribution, existing suites updated
- [ ] Backlog task: drop the frozen old tables later (separately approved)
- [ ] Docs: architecture/collaboration docs that describe comment storage
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

## Rollback

The old tables are frozen, not dropped. Rolling the Worker back to the previous version reads and
writes the old tables again (comments created after the migration are invisible until roll-forward).
Roll-forward needs one new migration that re-runs the same idempotent copy
(`copyLegacyCommentRows`) to bring over rows created during the rollback window; status changes made
during the rollback window to rows that already exist in the new tables are not merged.
