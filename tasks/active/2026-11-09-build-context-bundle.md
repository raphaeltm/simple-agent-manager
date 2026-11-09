# Phase 2: Portable deployment build context

Source: idea 01KZ6V37D1QGDR3WN12PSDB0QD, Implementation plan 2026-11-06; phase-0 GO report 01M6SMMAP4EHXKAGJ4G25ZXXK1. Phase 1 shipped #2582.

Scope: app deployment context collection/transport only. Existing node builds and Instant early gate remain unchanged; remote execution and job tokens belong to phase 3.

- [x] Compose-go discovery/overrides/interpolation; patternmatcher conservative union; relative tar.zst.
- [x] Empty env_file placeholders, no secret interpolation; context/additional-context/Dockerfile validation; reject escaping links/paths, tar-slip, remote contexts.
- [x] Byte/deadline limits, streaming collection/compression/upload; dual-runtime authenticated collect route; old-agent 404 handling.
- [x] Additive publish-job metadata migration (latest main 0229); preserve source node_id and cascade.
- [x] Authenticated context upload init/complete, derived keys, short presigned PUT, size/head and recorded hash fences.
- [x] Reuse artifact cleanup cron for bounded retention.
- [x] Tests: override/env placeholders, documented/real Docker ignore matrix, escapes, secrets, multi-buffer route; SQLite conditional-state attacks + owner controls.
- [x] Docs/config reference and full quality suite (root 22/23 tasks, remaining API suite separately green).
- [x] Local specialist review and completion validation (collector/security, API/Cloudflare/constitution, completion/docs/tests; shadow re-review PASS).
- [ ] Coordinator staging slot; one small claude-code VM and Instant collect proof; cleanup verified in D1, release slot.
- [ ] CI and CodeRabbit request/wait; exact SHA review request to coordinator.

Mandatory release hold: early DRAFT PR + needs-human-review. Do not mark ready or merge until coordinator task 01M6SHDRB60F28XPA14C7J9XKZ approves PR number at exact full SHA. Every commit voids approval. Never commit main. After approval/merge monitor production and verify deployed tip contains merge.

Research: compose discovery currently passes no -f; workspace-side source resolution uses Docker volume mountpoint. Instant must bypass Docker entirely. Source node cascade remains an accepted v1 limitation. Large builder R2 direct egress remains phase-3 validation, not proven by spike.

Local validation: 74 targeted API tests pass, including real SQLite scope/attempt guards and owner controls, live-resource callback controls, real SDK presigning, multi-page retention, additive migrations/source-node cascade, hidden shadow surfaces, release fencing and old-agent 404. Full lint/typecheck/build pass; root tests finished 22/23 tasks before the bounded timeout and the remaining API suite passed separately (1,067 files, 15,668 tests). Full Go suite under race detection passes after the runtime-role correction, including actual registered VM/Instant/shadow/cancel routes with incompressible multi-buffer payloads. Docker is absent locally: ignore parity uses the documented fixture matrix; real Docker parity remains an explicit verification gap. Independent review findings have regression coverage for aliases/merges/multidocument configs, nested include/extends, dangling links, SDK checksums and heartbeat ownership. CI found reachable GO-2026-6865 in the initial compression version; upgraded to fixed compress1.20.2, re-reviewed and module verification passed.

Coordinator-approved staging-path addition (messages 42ffa6b6-5109-4b22-afce-262aa3fe78d7 and e9ce3667-4073-424a-a7d4-bddf5cd21444): default-off off|shadow setting, separate hidden context_shadow row (0231), source-owned asynchronous collection, bounded acceptance. No forged signing credentials or side harness. Marker prevents release insertion/linking and visibility through status/cancel/project events/failure counts. Normal source admission ignores context-only jobs. Tests prove default-off public response/node payload equality, no blocking on failed/pending probe acceptance, Instant unchanged gate, hidden surfaces, release fences/owner controls, source request ownership, shadow terminal success, cancellation, and spool cleanup. All three specialist re-reviews PASS; final full checks and staging still pending.

Scale proof: optional local TestCollectMonorepoScale collected 100,000 files / 1,600,000,000 payload bytes in 7.43 seconds in one pass (1,099,798 compressed bytes). Fixture is repetitive; this does not measure network throughput. Complete probe including fixture creation/cleanup took18.90seconds. No file-count cutoff.

Staging investigation: the first deployment and smoke checks passed, and normal browser deployment UI access passed. A source session started during container rollout reported the previous agent release, exercising the legacy capability failure. After resume, live source tests exposed a runtime discriminator error: ContainerMode means VM devcontainer execution; Instant is RoleStandalone. Corrected collection to IsStandaloneMode() and corrected tests to actual role/flag launch combinations. Independent re-review and full Go race suite passed; source fix88f136566c66cb3c0816283dbe96a556d96b06ea is being verified live. The first VM/task/workspace/snapshot were removed through normal strict deletion; D1 confirmed zero VMs. Replacement is sequential, preserving peak one VM. Shadow remains off while deploying.

Security review correction: coordinator identified a valid check-then-use race in source-root acquisition and plain-path config/ignore reads. Previous false-positive classification is withdrawn. Required fix: trusted base Root handle, Root.OpenRoot for working directory, rooted discovery/config/ignore/metadata reads and traversal, opened-file secret identity check, deterministic swap/owner controls and guard mutation proof. Staging resources have been removed; verification must be repeated on the anchored-root fix after fresh coordinator slot grant.

Anchored-root fix validation: trusted-base `Root.OpenRoot` acquisition, retained capability throughout discovery/config/ignore/metadata/traversal and payload reads; compose-go sees private staged copies. Payload descriptors open and pass inode checks before tar headers, remaining open through copy. Nonblocking opens reject FIFO substitutions. Deterministic tests cover VM/Instant acquisition swaps, retained-root ownership after rename, outside Compose/include/extends/Dockerfile/ignore/env links, and symlink/hardlink secret swaps. Both independent Go/security and completion reviewers PASS. Guard-deletion mutation evidence in `tasks/evidence/build-context-root-guard-mutation.json` records owner controls passing and attacks failing for both acquisition and retained-capability guards; source restored. Fresh staging verification remains mandatory.

Final anchored-root validation: full `go test -race ./...` PASS (server174.510s), targeted `go vet` PASS, file-size/runtime-tunable/source-contract/migration-ordering checks PASS. Main migration maximum rechecked0229.
