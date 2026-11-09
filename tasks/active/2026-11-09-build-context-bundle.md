# Phase 2: Portable deployment build context

Source: idea 01KZ6V37D1QGDR3WN12PSDB0QD, Implementation plan 2026-11-06; phase-0 GO report 01M6SMMAP4EHXKAGJ4G25ZXXK1. Phase 1 shipped #2582.

Scope: app deployment context collection/transport only. Existing node builds and Instant early gate remain unchanged; remote execution and job tokens belong to phase 3.

- [x] Compose-go discovery/overrides/interpolation; patternmatcher conservative union; relative tar.zst.
- [x] Empty env_file placeholders, no secret interpolation; context/additional-context/Dockerfile validation; reject escaping links/paths, tar-slip, remote contexts.
- [x] Byte/deadline limits, streaming collection/compression/upload; dual-runtime authenticated collect route; old-agent 404 handling.
- [x] Additive publish-job metadata migration (latest main 0229); preserve source node_id and cascade.
- [x] Authenticated context upload init/complete, derived keys, short presigned PUT, size/head and recorded hash fences.
- [x] Reuse artifact cleanup cron for bounded retention.
- [ ] Tests: override/env placeholders, documented/real Docker ignore matrix, escapes, secrets, multi-buffer route; SQLite conditional-state attacks + owner controls.
- [ ] Docs/config reference and quality suite.
- [x] Local specialist review and completion validation (collector/security, API/Cloudflare/constitution, completion/docs/tests; shadow re-review PASS).
- [ ] Coordinator staging slot; one small claude-code VM and Instant collect proof; cleanup verified in D1, release slot.
- [ ] CI and CodeRabbit request/wait; exact SHA review request to coordinator.

Mandatory release hold: early DRAFT PR + needs-human-review. Do not mark ready or merge until coordinator task 01M6SHDRB60F28XPA14C7J9XKZ approves PR number at exact full SHA. Every commit voids approval. Never commit main. After approval/merge monitor production and verify deployed tip contains merge.

Research: compose discovery currently passes no -f; workspace-side source resolution uses Docker volume mountpoint. Instant must bypass Docker entirely. Source node cascade remains an accepted v1 limitation. Large builder R2 direct egress remains phase-3 validation, not proven by spike.

Local validation: all 34 targeted API tests pass, including real SQLite scope/attempt guards, live-resource callback controls, real SDK presigning, multi-page retention, additive migration/source-node cascade, and old-agent 404. Go targeted race tests pass, including a >3 MiB payload through the registered route for both runtimes. Docker is absent locally: ignore parity uses the documented fixture matrix; real Docker parity remains an honest verification gap. Local specialist findings were fixed with alias, merge, multidocument, nested include/extends, dangling-link, SDK-checksum and heartbeat regressions. Full suite/re-review/staging pending.

Coordinator-approved staging-path addition (messages 42ffa6b6-5109-4b22-afce-262aa3fe78d7 and e9ce3667-4073-424a-a7d4-bddf5cd21444): default-off off|shadow setting, separate hidden context_shadow row (0231), source-owned asynchronous collection, bounded acceptance. No forged signing credentials or side harness. Marker prevents release insertion/linking and visibility through status/cancel/project events/failure counts. Normal source admission ignores context-only jobs. Tests prove default-off public response/node payload equality, no blocking on failed/pending probe acceptance, Instant unchanged gate, hidden surfaces, release fences/owner controls, source request ownership, shadow terminal success, cancellation, and spool cleanup. All three specialist re-reviews PASS; final full checks and staging still pending.

Scale proof: optional local TestCollectMonorepoScale collected 100,000 files / 1,600,000,000 payload bytes in 7.43 seconds in one pass (1,099,798 compressed bytes). Fixture is repetitive; this does not measure network throughput. Complete probe including fixture creation/cleanup took18.90seconds. No file-count cutoff.
