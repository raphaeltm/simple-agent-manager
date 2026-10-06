# Rebuild the grouped FTS index after wall recovery left stale entries

## Problem

`POST /api/admin/project-data/storage/:projectId/grouped-fts-wall-recovery`
(`apps/api/src/durable-objects/project-data/grouped-fts-wall-recovery.ts`) runs while a
ProjectData object is at Cloudflare's hard storage cap. When the FTS5 `'delete'` markers
for a page do not fit (content made mostly of unique tokens), it still deletes the
`chat_messages_grouped` rows to free space, and leaves those rows' FTS entries stale. The
call reports them as `ftsStaleRows`.

Stale postings point at rowids with no content row, so search joins drop them, but they
waste index space and fail `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts,
rank) VALUES('integrity-check', 1)`. This is a deliberate degradation for the 2026-10-02
outage, tracked here per `.claude/rules/42-no-untracked-degrading-placeholders.md`.

## Context

Discovered while building the wall-recovery route on branch `claude/friendly-planck-qziggg`
(production incident: SAM root object at 10,737,418,240 bytes).

## Acceptance Criteria

- [ ] Once the affected object is comfortably below its storage target, decide between a
      bounded, resumable FTS rebuild of the remaining grouped rows and leaving the stale
      postings (with a measured cost of each).
- [ ] If rebuilding, it must be bounded per call (rows, bytes) and must not run at the cap.
- [ ] After the chosen action, the rank = 1 integrity-check passes on the affected object, or
      the remaining stale-row count is recorded with a reason.
- [ ] If no wall-recovery call ever reported `ftsStaleRows > 0`, close this task as not needed.
