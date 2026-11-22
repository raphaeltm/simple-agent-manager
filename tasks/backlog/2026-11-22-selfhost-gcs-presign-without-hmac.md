# Self-host: presigned bucket uploads on a GCS box without HMAC keys

Self-hosting only. Idea `01M828EKSVADDDZF7VXA5HPKK5`.

## Problem

A box presigns bucket URLs only with `R2_S3_ENDPOINT` plus a prefix-scoped S3 HMAC credential
(`apps/api/src/services/r2-presign-config.ts:resolveR2PresignConfig`). Without it,
build-backed app deploys fail at `compose-image-artifacts/init`
(`compose-image-artifacts.ts` → `r2-s3-client.ts:getR2PresignTarget` throws, so a 500), task
attachments answer 403, and direct session-snapshot uploads are off. On GCP, creating the HMAC
key for a service account is refused by `constraints/iam.disableServiceAccountKeyCreation`, which
new Google Cloud orgs enforce by default, so the documented setup (README "Object store and
presigned uploads") cannot be done there.

## Context

Found 2026-11-22 on the shared box during multi-box step 3
(`tasks/active/2026-11-22-selfhost-registry-evidence.md`, task 01M8265E185QAYMQJH7VESFK19).

## Acceptance Criteria

- [ ] A GCS box with no HMAC key can move compose artifacts, attachments and snapshots (for example
      V4 URLs signed by the box identity through IAM `signBlob`, the bucket access conditioned to
      the `celld/r2/<bucket>/` prefix; or Worker-streamed transfers)
- [ ] `compose-image-artifacts/init` answers a clear 4xx/503 naming the missing setting, not a 500
- [ ] One build-backed publish proven end to end on a box (publish → artifact upload → release
      applied → app 200)
- [ ] `gcp-bootstrap.sh` and the box README updated
