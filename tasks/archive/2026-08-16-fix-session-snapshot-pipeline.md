# Fix session snapshot pipeline

## Problem

Production VM sleep/wake lost resumable agent state after PR #1822 moved snapshot artifacts to presigned direct R2 PUTs. The vm-agent uploads succeeded, but `/session-snapshot/complete` rejected artifacts because R2 did not expose a stored SHA-256 checksum when the direct PUT omitted `x-amz-checksum-sha256`.

The failed completion then caused the sleep watchdog to fabricate transcript-only degraded manifests with a SAM control-plane ACP session ULID as `acpSessionId`. Wake tried a doomed strict `LoadSession` before falling back to transcript replay, surfacing "Agent startup failed" to users.

## Research findings

- `packages/vm-agent/internal/server/session_snapshot_upload.go` sets `X-SAM-Content-SHA256` only on legacy callback uploads and sets no S3 checksum header on direct R2 PUTs.
- `apps/api/src/services/session-snapshot-direct-upload.ts` signs the upload request with `ChecksumSHA256`; current unit coverage shows the AWS SDK v3 presigner hoists `x-amz-checksum-sha256` into the signed query string, but production evidence shows R2 does not persist a checksum from the query-only request.
- `apps/api/src/routes/workspaces/session-snapshots.ts` validates completed artifacts only against `R2.head(...).checksums.sha256`, conflating checksum absence with mismatch and rejecting all direct uploads missing stored checksums.
- Rollout safety requires old vm-agent binaries to keep working while Worker code deploys, so `/complete` must also validate against a persisted upload-url authorization size/SHA record rather than relying solely on the new vm-agent header.
- `apps/api/src/services/session-snapshot-persistence.ts:completeActiveSessionSnapshotAsDegraded` writes `acpSessionId` and `agentType` into transcript-only fabricated manifests, but those manifests have no home artifact, so strict `LoadSession` can never succeed.
- `packages/vm-agent/internal/server/session_snapshot.go:snapshotHarnessResumeIdentity` currently treats any `acpSessionId` + `agentType` as resumable and does not inspect whether the manifest contains a home artifact.
- `packages/vm-agent/internal/server/session_snapshot_archive.go` excludes many cache and credential paths but not observed large refetchable caches like `go/pkg` and `.local/share/pnpm`.
- `packages/vm-agent/internal/server/session_snapshot_container_support.go:buildContainerSnapshotArchiveList` selects entries in find order; a large cache can consume the budget before `~/.claude`/`~/.codex` harness state.
- Background capture errors in `session_snapshot_coordinator.go` are node-local only; progress reporting failures in `session_snapshot_progress.go` are Debug-level only.
- Staging run `31953138714` against fresh node `01M05H3JZ8HJJ475A4XPJT9KSY` proved that adding `x-amz-checksum-sha256` to the existing query-hoisted presigned URL shape causes R2 `403 SignatureDoesNotMatch`; new VM agents must opt into header-signed checksum URLs while old VM agents keep the query-hoisted rollout-compatible URL.
- Staging redeploy `31954795829` for commit `94c8ed95e53440f2395cae57f59d9e115e2b0142` passed deploy + smoke tests. A fresh VM session on project `01KWHD8XS7MQ7R6KWXJYRHDVH4` produced snapshot generation `01M05K20GH3PSBHW690X6EWAH2` with `status=available`, `degradation=none`, and R2 objects `home.tar` plus `manifest.json`.
- Waking the same sleeping staging session via durable follow-up delivery created recovery task `01M05K83KE6RJZ17PNGE86KBWX`, recovered workspace `01M05K88DFJJN73ZFZETKWCEV8`, and reached `restore_status=restored`, `recovery_status=restored`, `sleep_status=NULL`, with the recovered workspace and agent session running.

## Checklist

- [x] Add additive D1 columns for in-flight authorized direct-upload size/SHA values.
- [x] Persist authorized direct-upload artifact size/SHA in `/artifacts/:artifact/upload-url`.
- [x] Validate `/complete` artifacts with distinct errors for missing object, missing checksum without authorization, checksum mismatch, authorized size mismatch, and authorized SHA mismatch.
- [x] Send `x-amz-checksum-sha256` from vm-agent direct-upload and relay PUTs without leaking callback/node authorization.
- [x] Remove resumable identity from control-plane-fabricated transcript-only degraded manifests.
- [x] Make vm-agent skip strict `LoadSession` when the manifest has no home artifact while preserving vm-agent-written home-skipped manifests with a home artifact and native ID.
- [x] Add HOME excludes for `go/pkg`, `.local/share/pnpm`, and other safe refetchable caches.
- [x] Change container HOME selection so harness state roots are budgeted before ordinary HOME files.
- [x] Add container WIP/HOME progress reporting and raise progress-report failure logging to Warn.
- [x] Report background capture failures to the control plane and preserve the real failure reason in degraded completion.
- [x] Add bounded retry escape for post-sleep capture retries against stopped workspaces.
- [x] Add regression tests for checksum authorization fallback, no-checksum diagnostics, degraded wake LoadSession skipping, home-skipped control restore, harness-first budget ordering, and new excludes.
- [x] Run local validation for impacted API and vm-agent tests.
- [x] Run specialist reviews required by `/do`.
- [x] Validate presigned PUT checksum behavior against real R2 on staging and record the accepted/rejected header matrix.
- [x] Deploy to staging with fresh VM-agent nodes and run VM sleep→wake E2E.
- [x] Create PR #1836 with validation and post-mortem evidence.
- [ ] Monitor CI, merge, and monitor production deploy.

## Acceptance criteria

- Direct-upload session snapshots can complete and become restorable even during Worker-before-vm-agent rollout.
- `/complete` produces distinguishable checksum-absent vs checksum-mismatched errors.
- Transcript-only fabricated degraded wake does not attempt strict `LoadSession` or emit "Agent startup failed".
- VM-agent-written degraded manifests with a home artifact and native harness ID still restore via `LoadSession`.
- Harness state is not starved by cache files under HOME budget exhaustion.
- Snapshot capture failures become visible to the control plane with real error text.
- Staging and production verification prove a VM runtime sleep→wake retains prior agent context.

## References

- Ideas `01M04SB5QS0ASYKDSZR8FFSY38`, `01M04QSWNZV2VEMHVQV55HA6EP`
- PR #1822, PR #1828
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/27-vm-agent-staging-refresh.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`
