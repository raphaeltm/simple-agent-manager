# Hosted git: GC without inflation, delta depth at ingest, GC scheduling

## Problem

The adversarial review of the push admission path in PR #2907 (H2, SAM-hosted git, self-host only) left these findings open. Each needs a design change rather than a guard, so they were deferred with justification in the PR. The HIGH finding and the other MEDIUM and LOW items in that review were fixed in #2907.

1. **GC needs to inflate every migrated pack object** (review M3). `runHostedGitGc` (`apps/api/src/selfhost/hosted-git/hosted-git-gc.ts`) moves each reachable pack object to loose storage through `store.get`, which inflates it under the GC alarm's single `repositories.maxInflatedBytes` budget (128 MiB). Two cases exceed that budget:
   - highly compressible blobs (14 blobs of 15 MiB stored in about 0.4 MiB);
   - more than 128 MiB of inflated pack content accumulated between collections.

   Since #2907, GC drops whole packs with nothing reachable and no delta base before inflating anything, so a rejected push's pack is always reclaimed. Migrating the reachable packed objects can still exceed the budget. GC then fails on every attempt, garbage mixed into reachable packs (after a force push) is never reclaimed, and the repository drifts towards `maxRepoBytes`, where every push is refused. The reviewer reproduced this at 268 MB of a 268.4 MB cap. Raising the budget only moves the bound, since a compression bomb can exceed any inflation or deadline cap.
2. **Delta depth is enforced on read but not at ingest** (review M4). `packstore.ts` resolves deltas eagerly at ingest without checking `maxDeltaDepth`, so a pack built with `--depth=250` is accepted. Cold reads then throw `delta chain exceeds depth`, and a shallow clone aborts with `early EOF` until GC rewrites the objects loose. The exception is thrown inside the upload response stream and is not caught.
3. **GC holds the input gate for the whole sweep** (review M5, the part not fixed in #2907). `gc()` runs under `blockConcurrencyWhile` for up to `workTimeoutMs` (120 s), blocking every other request to that repository, reads included.
4. **Pushes over heavy history without a reachable cache** (re-verification F1, the part not fixed in #2907).
   - A push whose parent is not a ref tip proves that parent's closure by walking old commits and trees under the 128 MiB budget. Admission deliberately does not trust the reachable cache: a version of #2907 that did was shown to admit a parent GC had deleted, after a clone raced a deleting push (stamp race now fixed in `saveReachable`).
   - A repository whose old trees inflate past the budget then cannot accept a fork-from-old-commit push. A full clone faces the same envelope.
   - An ancestry check that runs out of budget is already treated as a forced update rather than failing the push.
   - Fix: keep a persistent set of validated objects that only GC prunes. GC already computes the reachable set, and every accepted push adds its proven closure. Or record commit parents at ingest.
   - Also: `store.setPeeled` is never called, so `getPeeled` and the `peeled` table are dead upstream code. Remove them or populate them.
5. **Alarm error handling** (re-verification F4): `armHostedGitGcAlarm` in the failed-ingest path propagates a `getAlarm`/`setAlarm` error as a 500, which is deliberate so the earlier tests keep the cleanup-before-alarm ordering. `queueHostedGitGc` swallows alarm errors, so `gc-pending=1` can wait for the next push.
6. **Lower-severity items** (review L7 to L10):
   - **No rate limit.** There is no per-token or per-repository request rate limit, and a queued push is authorized before it waits on `receiveChain`.
   - **Command lines dropped silently.** Unmatched command pkt-lines are skipped with no `ng`, and invalid UTF-8 ref bytes alias to U+FFFD.
   - **Gzip buffering.** The gzip push path buffers about 3× `maxPushBytes`.
   - **Quadratic copying.** `need()` concatenates repeatedly while reading the command section.

## Context

Found by the security-auditor adversarial pass on 2026-11-19 (task 01M7TY7Z3HBTSDSSV85FPRHE1B). The reproductions ran against the Durable Object in Miniflare/workerd.

Who can trigger them:
- Every item needs a token with write access to the repository: a project member, or that project's agent workspace.
- The blast radius is that one repository.
- Item 1 is also reachable without malice, when several large pushes land between collections.
- An operator can recover by deleting and recreating the project's repository.

## Acceptance Criteria

- [ ] GC completes migration for a repository whose reachable packed content inflates past `maxInflatedBytes` (copy raw pack entries, or make migration resumable across alarms). A real-git test proves it. Whole unreferenced packs are already dropped without inflating.
- [ ] GC work is deadline-bounded and resumable, with throughput stated at the 30,000-object / 256 MiB envelope (`.claude/rules/81-work-bounds-must-state-throughput.md`).
- [ ] Ingest records delta depth and refuses a pack whose chains exceed `maxDeltaDepth`. A real-git test pushes `--depth=250` and is refused, and a normal pack is accepted.
- [ ] Errors raised while streaming an upload-pack response end the stream cleanly.
- [ ] GC no longer blocks reads for the whole sweep; a test shows a clone proceeding while GC runs.
- [ ] Decide on and implement per-token push rate limiting, or record why not.
- [ ] Every malformed command line is answered with `ng` or a refusal, never dropped.
- [ ] A push forking from an old, heavy commit succeeds within the budget. A real-git test proves it, and a stale or poisoned cache cannot vouch for a missing object.
- [ ] Decide whether to bound tree depth or total path length; 1,500 nested directories break checkout of the default branch.
- [ ] Optionally accept uppercase-hex oids in commit and tag headers, as git does (`isOid` is lowercase-only).
- [ ] Optionally reject the remaining fsck error-level shapes that default clients tolerate but `transfer.fsckObjects=true` clients refuse: unsorted trees, malformed idents, CR in headers.
