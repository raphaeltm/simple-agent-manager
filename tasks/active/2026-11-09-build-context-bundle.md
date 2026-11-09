# Phase 2: Portable deployment build context

Source: idea 01KZ6V37D1QGDR3WN12PSDB0QD, Implementation plan 2026-11-06; phase-0 GO report 01M6SMMAP4EHXKAGJ4G25ZXXK1. Phase 1 shipped #2582.

Scope: app deployment context collection/transport only. Existing node builds and Instant early gate remain unchanged; remote execution and job tokens belong to phase 3.

- [ ] Compose-go discovery/overrides/interpolation; patternmatcher conservative union; relative tar.zst.
- [ ] Empty env_file placeholders, no secret interpolation; context/additional-context/Dockerfile validation; reject escaping links/paths, tar-slip, remote contexts.
- [ ] Byte/deadline limits, streaming collection/compression/upload; dual-runtime authenticated collect route; old-agent 404 handling.
- [ ] Additive publish-job metadata migration (latest main 0229); preserve source node_id and cascade.
- [ ] Authenticated context upload init/complete, derived keys, short presigned PUT, size/head and recorded hash fences.
- [ ] Reuse artifact cleanup cron for bounded retention.
- [ ] Tests: override/env placeholders, documented/real Docker ignore matrix, escapes, secrets, multi-buffer route; SQLite conditional-state attacks + owner controls.
- [ ] Docs/config reference and quality suite.
- [ ] Local specialist review and completion validation.
- [ ] Coordinator staging slot; one small claude-code VM and Instant collect proof; cleanup verified in D1, release slot.
- [ ] CI and CodeRabbit request/wait; exact SHA review request to coordinator.

Mandatory release hold: early DRAFT PR + needs-human-review. Do not mark ready or merge until coordinator task 01M6SHDRB60F28XPA14C7J9XKZ approves PR number at exact full SHA. Every commit voids approval. Never commit main. After approval/merge monitor production and verify deployed tip contains merge.

Research: compose discovery currently passes no -f; workspace-side source resolution uses Docker volume mountpoint. Instant must bypass Docker entirely. Source node cascade remains an accepted v1 limitation. Large builder R2 direct egress remains phase-3 validation, not proven by spike.
