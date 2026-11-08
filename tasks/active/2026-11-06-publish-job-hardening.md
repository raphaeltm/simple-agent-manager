# Harden deployment publish jobs

## Problem and research
Phase 1 of idea 01KZ6V37D1QGDR3WN12PSDB0QD. Node-owned builds currently have no cancel/watchdog, permit terminal status resurrection and duplicate release submission. Existing attempt column defaults to 1; no executor/schema expansion needed. Release FK means release insertion and conditional job linking must share an atomic D1 batch. Existing cron sweep isolator and typed admin settings provide the required extension points.

## Implementation and acceptance
- [ ] Real SQLite tests for scoped atomic cancel, bounded stall/deadline sweep, terminal event rejection, and owner/duplicate/late/attempt release fencing.
- [ ] Add runtime settings with DEFAULT constants; isolated bounded scheduled sweep emits lifecycle events.
- [ ] cancel_publish tool with durable cancellation before best-effort authenticated VM cancellation; old-agent 404 tolerated.
- [ ] Fence release callback using publishJobId/attempt; legacy omissions retain behavior; propagate Go payload.
- [ ] Lifecycle events for API starting and failed_to_start; early Instant gate references phase-3 idea.
- [ ] Go handler/callback payload tests; delete-guard red/restore checks.
- [ ] Docs and channel contracts.
- [ ] Full checks, specialist reviews, staging VM binary refresh and success/cancel/sweep/Instant verification with cleanup.
- [ ] PR, CI, CodeRabbit, merge, production smoke; idea update with PR.

## Scope
No context bundles, executor columns, queueing, or job tokens. Current SAM output branch is already isolated; use it. Preserve local .codex/config.toml change.

## Saved verification / review evidence — 2026-11-07
- Implementation saved in e8dfdf8c0; current main merged in 42c24dbf5 without rewriting published history.
- Full repository lint passed: 13/13 packages, existing accessibility/hook warnings only.
- Real SQL suites: 27 tests passed after indexed sweep fix; service suite including generated-query EXPLAIN passed 17 tests.
- Cloudflare/constitution reviewer approved after fixing terminal-history scans. Sweep uses indexed disjoint non-terminal status ranges; reads/sort scale with active jobs, not retained terminal history. Default 25 selected jobs per tick: one candidate query, at most 25 conditional updates and 25 asynchronous lifecycle deliveries; no VM network calls on sweep path.
- Go/security reviewer approved: focused real-handler cancel and publish happy-path tests passed. Optional early eligibility read before volume allocation noted; authoritative transactional release fence retained.
- Test/docs/completion reviewer: no implementation blocker; final validation, mutation proof and staging evidence required before archive.
- Unrelated .codex/config.toml stays uncommitted.

### Foreground recovery verification — 2026-11-08
- Affected API suites passed **73 tests / 7 files** (11.90 seconds). Includes real SQLite service, callback route, scheduled sweep, MCP start/cancel and existing publish regressions.
- Previous long full commands were interrupted by session sleep and their temporary logs disappeared. Their outcome is unverified; rerun gates remain required.
