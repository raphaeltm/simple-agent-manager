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
