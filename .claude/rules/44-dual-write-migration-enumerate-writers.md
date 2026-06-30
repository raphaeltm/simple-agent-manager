# Storage Migrations Must Enumerate Every Writer of the Migrated Data

## When This Applies

This rule applies whenever a migration introduces a **second storage
representation** of data that already exists elsewhere and the two must stay in
sync (a "dual-write" period). Examples in this codebase:

- The composable-credentials migration (#1315, #1332) added `cc_credentials` /
  `cc_configurations` / `cc_attachments` as a new representation of the legacy
  `credentials` table. Resolution reads `cc_*` first; the legacy table remains
  the validation/encryption boundary.
- Any "add a denormalized copy", "introduce a cache table", "shadow-write to the
  new schema while we backfill" change.

## Why This Rule Exists

The composable-credentials migration backfilled `cc_credentials` once at
migration time and updated the **resolution** path and the **Connections** write
path to dual-write. But it did not enumerate **every** writer of the legacy
`credentials` table. The `CodexRefreshLock` Durable Object rotates the Codex
OAuth `refresh_token` and persisted it ONLY to legacy `credentials` — it never
mirrored the rotated token into `cc_credentials`.

Result: fresh workspaces seed `~/.codex/auth.json` from the frozen
`cc_credentials` snapshot, present a stale `refresh_token`, fail the DO's
match check, fall to the stale path (expired access_token, no rotation), get
401 from OpenAI, re-refresh in a loop, and exceed the rate limit → **429 in
production**. The bug was invisible until the 5-minute grace window expired on a
freshly provisioned workspace, weeks after the migration merged.

Production evidence: legacy credential `01KR9EAKXA1BPQQT8B3VCZQZDW`
`updated_at = 2026-06-20` (rotating), matching `cc_credentials` copy
`updated_at = 2026-06-14` (frozen at backfill).

## Class of Bug

**Dual-write desync after a storage migration** — a new write path (or, here, a
pre-existing write path the migration author did not know about) is not updated
to sync the second representation. One side keeps changing; the other goes
stale. The two diverge silently because both reads and writes individually
"work".

## Hard Requirements

When a migration creates a second representation that must stay in sync:

1. **Enumerate every writer of the source table before merging the migration.**
   Grep for every `UPDATE`, `INSERT`, and `DELETE` against the migrated table
   across `apps/`, `packages/`, AND Durable Objects (`*-lock.ts`,
   `*-data.ts`) — DOs are easy to miss because they hold their own DB handle.
   List each writer in the migration's task file or PR description.

2. **For each writer, decide and document one of:** (a) it dual-writes the new
   representation in the same operation, (b) it is read-only for this data, or
   (c) it is explicitly out of scope with a tracked follow-up task ID
   (see `.claude/rules/42`).

3. **Background/rotation writers count.** Token rotation, cron sweeps, reconcile
   loops, and heartbeat handlers that mutate the migrated table are writers.
   They are the most dangerous because they fire long after the migration
   merges, when no one is watching.

4. **Add a behavioral test per writer** asserting BOTH representations are
   updated in the same operation, for every scope the writer supports
   (user-scoped AND project-scoped, etc.). A test that asserts only the legacy
   write does not prove the dual-write.

5. **Add a vertical-slice regression test** proving the downstream consumer
   (here: a freshly seeded workspace `auth.json`) reflects the latest write, not
   the stale backfill (see `.claude/rules/35`).

## Quick Compliance Check

Before merging any migration that introduces a synced second representation:
- [ ] Every writer of the source table is enumerated (grep UPDATE/INSERT/DELETE,
      including Durable Objects)
- [ ] Each writer either dual-writes, is read-only, or has a tracked follow-up
- [ ] A behavioral test per writer asserts both representations update, in every scope
- [ ] A vertical-slice test proves the downstream consumer sees the latest write
- [ ] No decrypted/secret material is logged by the new sync path

## References

- Post-mortem: `tasks/archive/2026-06-30-fix-production-codex-oauth-refresh-429.md`
- `.claude/rules/28` — credential resolution/rotation safety tests
- `.claude/rules/35` — vertical slice testing
- `.claude/rules/42` — no untracked degrading placeholders (tracked follow-ups)
- PRs #1315, #1332 (composable-credentials migration)
