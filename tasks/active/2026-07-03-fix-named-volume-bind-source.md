# Fix Named Volume Bind Source

## Problem

SAM deployment named volumes currently bind the raw provider block-device mount root into containers. Fresh ext4 filesystems contain a root-owned `lost+found` directory, so Postgres `initdb` refuses the data directory and the deployment loops forever.

## Constraints

- Keep one provider block-storage volume per Docker named volume.
- Keep signed `volumeMounts[].mountRoot` descriptors unchanged.
- Bind `{mountRoot}/data` into containers.
- vm-agent must create `{mountRoot}/data` after mount with mode `0777`.
- Draft PR only with `needs-human-review`; do not merge.
- Staging verification must use `Deployment Test 1` (`01KVRJCC7Y3NSDQYCPWDRPVJVH`) with Postgres on a fresh volume, not busybox.

## Implementation Checklist

- [x] Add a bind-source resolver in `apps/api/src/services/deployment-volumes.ts`.
- [x] Update `compose-renderer.ts` named-volume rendering.
- [x] Update `compose-publish-apply.ts` named-volume rewriting.
- [x] Update `packages/vm-agent/internal/deploy/volume_mounter.go` to create `data`.
- [x] Update `mount_guard.go` extraction and verification.
- [x] Add/update API and Go tests for `/data` bind sources and raw-root rejection.

## Acceptance Criteria

- [x] Named-volume bind sources point at `{mountRoot}/data` in renderer and compose-publish paths.
- [x] vm-agent creates `data` subdir post-mount and is idempotent.
- [x] Mount guard accepts new bind sources, rejects raw-root binds, and verifies the mount root remains mounted.
- [x] Required quality gates pass.
- [x] Staging Postgres initdb and persistence verification completed.
- [x] Draft PR opened with `needs-human-review` (PR #1482).

## Validation

- `pnpm vitest run apps/api/tests/unit/services/deployment-volumes.test.ts apps/api/tests/unit/services/compose-renderer.test.ts apps/api/tests/unit/services/compose-publish-apply.test.ts`
- `cd packages/vm-agent && go test ./internal/deploy`
- `pnpm lint`
- `pnpm typecheck`
- `cd packages/vm-agent && go test ./...`
- `pnpm quality:migration-safety`
- `pnpm build`
- `pnpm test` (first run hit a flaky acp-client assertion; focused rerun passed, then full rerun passed)

## Staging Verification Attempt

- Staging deploy for branch `sam/fix-deployment-named-volume-01kwkf` succeeded: GitHub Actions run `28647983655`.
- Created fresh environment `pgdata-fix-0703a` (`01KWKHZGRMZZYSXCQMKNS3ACD4`) in project `Deployment Test 1` (`01KVRJCC7Y3NSDQYCPWDRPVJVH`).
- Submitted a real Postgres + Hono API compose release with `pgdata:/var/lib/postgresql/data`.
- Release creation created fresh deployment volume `pgdata`, but deployment node placement failed before containers started: `hetzner API error (403): server limit reached`.
- Cleanup completed through authenticated API: deleted environment `01KWKHZGRMZZYSXCQMKNS3ACD4`, deleted one created volume, and deleted failed deployment node row `01KWKJ3KD9NR6JGG4K5WQHHYRN` (no provider instance id was created).
- Result: required live Postgres initdb/persistence verification is blocked by staging server quota, not by the implementation or compose rendering path.

## Staging Verification (Completed 2026-07-03)

Server quota was raised by the human; the live verification was rerun and passed.

- Branch rebased onto main (head `0c1c60c21`) and deployed to staging via GitHub Actions run `28653420250` (green).
- Fresh environment `01KWKQHSGHP4YESTAN6SBZ11KF` created in project `Deployment Test 1` (`01KVRJCC7Y3NSDQYCPWDRPVJVH`).
- Docker Hub image resolution returned 429 (Worker shared-egress rate limit) for `docker.io/library/postgres:16-alpine`; worked around by using ECR Public mirrors (`public.ecr.aws/docker/library/postgres:16-alpine`, `.../nginx:alpine`). Not related to this fix.
- Release v1 (`01KWKQQ8AJHF3BR0WRVWHXMNFG`) reached `applied`. Fresh deployment volume `pgdata` (`01KWKQQ9KQKK6EJ83HPY8NNWFC`, Hetzner volume `106219748`, 10GB, fsn1) was created, attached, and bound at `{mountRoot}/data`.
- **initdb success on fresh volume**: db container logs show `fixing permissions on existing directory /var/lib/postgresql/data ... ok`, `Success. You can now start the database server`, `PostgreSQL init process complete`, `database system is ready to accept connections`. No `initdb: error: directory ... exists but is not empty` (lost+found) failure — the exact bug this task fixes.
- **Persistence across container recreation**: identical release v2 (`01KWKR3JFAPN003ZX3AVRNFR2Z`) reached `applied`; db logs show `PostgreSQL Database directory appears to contain a database; Skipping initialization` and clean startup — data survived on the volume.
- Cleanup: environment deleted via API (`nodeDeleted: true`, `volumesDetached: 1`, `volumesDeleted: 1`, `dnsRecordsDeleted: 1`, no warnings). Verified zero remaining environments and nodes.
