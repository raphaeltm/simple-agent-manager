# Message pagination silently drops rows that share a `created_at` at a page boundary

Found by adversarial test review during PR #2109 (archive sweep ceiling 5000 -> 10000).
Pre-existing; NOT introduced by that PR. Filed because the PR raises the session sizes that
make it reachable.

## Problem

Both message read paths filter the `after` cursor on `created_at` alone, with a strict
comparison that also excludes rows EQUAL to the cursor:

- compact/archived: `apps/api/src/durable-objects/project-data/compact-archive.ts`
  `matchesRawPage` — `(options.after !== null && timestamp <= options.after)`
- root/non-archived: `apps/api/src/durable-objects/project-data/messages.ts`
  `getMessages` — `AND created_at > ?`

If a page boundary falls inside a group of rows sharing one `created_at`, every tied row on
the far side of the cut is excluded from that page AND from every subsequent page, because the
next cursor is that same timestamp. The rows are not reordered or duplicated — they silently
vanish from the paginated read, permanently, with no error and no `hasMore` signal that would
reveal it.

The same module already knows the correct shape: `ARCHIVE_TABLE_SPECS.chat_messages` in
`apps/api/src/durable-objects/project-data/archive-sharding.ts` pages with a full
`(created_at, sequence, id)` keyset predicate. The archive COPY path is correct; the READ path
is not. That asymmetry inside one subsystem is the tell.

## Why ties are reachable

`persistMessageBatch` (`messages.ts`) computes `const now = Date.now()` ONCE per batch and
then assigns `const createdAt = new Date(msg.timestamp).getTime() || now` per message. Every
message in a single VM-agent flush whose `timestamp` is missing or unparseable therefore gets
the IDENTICAL `created_at`. Coarser-than-millisecond agent-reported timestamps across several
tool-result rows produced in one turn are a second source.

## Why it matters more now

Exposure scales with pages read, i.e. with session size. PR #2109 raises
`PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` to 10000 and the rollout plan reaches 20000, so
archived sessions get larger and multi-page reads become the norm rather than the exception.

## Acceptance criteria

- [ ] Both read paths page by the same total order the archive copy path uses:
      `(created_at, sequence, id)`, not `created_at` alone.
- [ ] A regression test seeds a tie group that STRADDLES a page boundary (N rows sharing one
      `created_at`, boundary inside the group) and asserts the full transcript is returned.
      Verify it fails against the current single-column predicate before relying on it
      (`.claude/rules/62`).
- [ ] Cover both the compact/archived path and the root/non-archived path
      (`.claude/rules/61` — one guard, every runtime).
- [ ] Decide separately whether `persistMessageBatch` should stop collapsing a whole batch
      onto one `now`. Fixing the cursor is the correctness fix; de-duplicating the timestamps
      only narrows the window.

## References

- `.claude/rules/50-list-read-row-fault-isolation.md` — cursor pagination must be able to
  resume the trimmed tail; this is the same family of silent-truncation defect.
- PR #2109 test review; `apps/api/tests/workers/project-data-archive-sweep-throughput.test.ts`
  documents that its transcript-fidelity assertion holds only for distinct timestamps.
