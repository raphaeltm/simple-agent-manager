# Retire the frozen legacy comment tables (needs separate approval)

## Problem

DO migration `073-anchored-comment-threads` copied every message and library-file comment row into
`anchored_comment_threads` / `_replies` / `_status_mutations` and switched every writer and reader
to them. The legacy tables were left in place, frozen and unwritten, as a recovery path:

- `comment_threads`, `comment_replies`, `comment_status_mutations` (migration 032, mentions 064)
- `library_file_comment_threads`, `library_file_comment_replies`,
  `library_file_comment_status_mutations` (migration 033)
- their indexes from 032, 033 and 035

They still cost storage in every project object, and the message tables still cascade-delete with
`chat_sessions` / `chat_messages`.

## Context

- Unification PR: branch `sam/unify-sams-two-comment-m65vzm` (task `01M6N9QFRMGW6CNXA7BTM65VZM`).
- `pnpm quality:do-migration-safety` refuses `DROP TABLE` in DO migrations. DO SQLite has no
  point-in-time recovery (`apps/api/.claude/rules/31-migration-safety.md`). Dropping these tables is
  irreversible and needs Raphaël's explicit approval, plus a scanner allowlist decision.
- `anchored-comment-writer-inventory.test.ts` guarantees nothing writes them.

## Acceptance Criteria

- [ ] Raphaël approves removal (or an alternative, such as leaving them indefinitely)
- [ ] Production `comments.migration_parity` logs show `ok: true` for every project object, and no
      `comments.migration_parity_mismatch` was ever logged
- [ ] At least one release cycle has passed with no rollback to pre-073 code
- [ ] If approved: a reviewed approach that does not drop a CASCADE parent's children unexpectedly,
      and the writer-inventory test and docs updated
