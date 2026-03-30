# Fix R2 S3 Credentials in Deployment Workflow

## Problem

PR #554 added R2 presigned upload support for task file attachments. The feature requires `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` as Cloudflare Worker secrets. However, the `Configure Worker Secrets` step in `deploy-reusable.yml` doesn't include these in its `env:` block, so `configure-secrets.sh` can never set them.

## Research Findings

- `configure-secrets.sh` lines 125-133 correctly handle R2 credentials — reads from env vars, sets as Worker secrets if present, warns if empty
- `deploy-reusable.yml` `Configure Worker Secrets` step (line 397) has an `env:` block missing both R2 vars
- The same secrets ARE used in other workflow steps (Pulumi backend login, VM agent binary upload) — confirming they exist as GitHub secrets
- Related post-mortem: `docs/notes/2026-03-25-env-var-single-quote-stripping-postmortem.md` — similar class of bug where deployment secrets didn't reach the Worker

## Implementation Checklist

- [x] Add `R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}` to Configure Worker Secrets env block
- [x] Add `R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}` to Configure Worker Secrets env block
- [x] Commit and push

## Acceptance Criteria

- [ ] The `Configure Worker Secrets` step no longer prints "Skipping R2 S3 credentials" warning during deployment
- [ ] Task file attachment presigned URL generation works on staging

## References

- `.github/workflows/deploy-reusable.yml`
- `scripts/deploy/configure-secrets.sh`
- `apps/api/src/services/attachment-upload.ts`
