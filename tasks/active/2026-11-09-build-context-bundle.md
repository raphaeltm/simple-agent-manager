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
- [ ] Local specialist review and completion validation.
- [ ] Coordinator staging slot; one small claude-code VM and Instant collect proof; cleanup verified in D1, release slot.
- [ ] CI and CodeRabbit request/wait; exact SHA review request to coordinator.

Mandatory release hold: early DRAFT PR + needs-human-review. Do not mark ready or merge until coordinator task 01M6SHDRB60F28XPA14C7J9XKZ approves PR number at exact full SHA. Every commit voids approval. Never commit main. After approval/merge monitor production and verify deployed tip contains merge.

Research: compose discovery currently passes no -f; workspace-side source resolution uses Docker volume mountpoint. Instant must bypass Docker entirely. Source node cascade remains an accepted v1 limitation. Large builder R2 direct egress remains phase-3 validation, not proven by spike.

Local validation: all 34 targeted API tests pass, including real SQLite scope/attempt guards, live-resource callback controls, real SDK presigning, multi-page retention, additive migration/source-node cascade, and old-agent 404. Go targeted race tests pass, including a >3 MiB payload through the registered route for both runtimes. Docker is absent locally: ignore parity uses the documented fixture matrix; real Docker parity remains an honest verification gap. Local specialist findings were fixed with alias, merge, multidocument, nested include/extends, dangling-link, SDK-checksum and heartbeat regressions. Full suite/re-review/staging pending.
