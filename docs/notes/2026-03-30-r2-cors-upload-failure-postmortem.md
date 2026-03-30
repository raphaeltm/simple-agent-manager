# Post-Mortem: R2 File Upload Failure — Missing CORS Configuration

**Date:** 2026-03-30
**Severity:** Feature completely broken
**Duration:** From PR #554 merge (2026-03-29) until fix deployed
**Affected:** All file attachment uploads on task submissions

## What Broke

File attachments on task submissions fail silently with a red error indicator. Users can select a file, but the upload to R2 via presigned URL fails because the browser blocks the cross-origin PUT request.

The user experience: click paperclip → select file → file chip appears → turns red with exclamation mark. The presigned URL is generated successfully, but the browser's same-origin policy blocks the XHR PUT to `{accountId}.r2.cloudflarestorage.com`.

## Root Cause

The R2 bucket has no CORS configuration. Cloudflare R2 requires explicit CORS rules to allow cross-origin requests from the browser. Without CORS rules, the browser sends a preflight OPTIONS request, R2 responds without `Access-Control-Allow-Origin`, and the browser blocks the subsequent PUT.

The upload flow crosses an origin boundary:
1. Browser at `https://app.sammy.party` requests presigned URL from `https://api.sammy.party` → succeeds (same-origin via subdomain, handled by Worker CORS middleware)
2. Browser PUTs file to `https://{accountId}.r2.cloudflarestorage.com/{bucket}/...` → **blocked by CORS** (different origin, no CORS rules on R2)

## Timeline

1. **2026-03-29 ~17:00**: PR #554 merged — file attachment feature with R2 presigned uploads
2. **2026-03-29 ~20:53**: PR #554's branch deployed to staging and "verified"
3. **2026-03-30 ~06:10**: PR #555 merged & deployed — fixed R2 credential forwarding in deployment
4. **2026-03-30**: User tests file upload on staging → fails with red error indicator
5. **2026-03-30**: Investigation reveals CORS was never configured on R2 bucket

## Why It Wasn't Caught

### 1. Task checklist items were never completed

The task file (`tasks/archive/2026-03-29-task-submission-file-attachments.md`) had explicit items for infrastructure setup:

```
- [ ] F5. Document R2 CORS configuration requirements
```

This item was never checked off, yet the task was archived. The research section even noted: "R2 CORS: Needs bucket-level CORS for direct browser uploads" — the exact issue.

### 2. Staging verification tested the wrong thing

The PR #554 staging verification confirmed that pages load and the UI renders correctly, but did not test the actual file upload flow end-to-end. The verification treated "page loads without errors" as feature verification. Per rule `.claude/rules/13-staging-verification.md`, this is explicitly listed as not acceptable:

> "Confirming pages load (this is a regression check, not feature verification)"

The correct verification would have been: attach a file → confirm it uploads → submit the task → verify the file appears in the workspace.

### 3. No automated test for the browser-to-R2 upload path

The unit tests mock R2 operations using Miniflare's R2 binding, which doesn't exercise the S3-compatible presigned URL path. The presigned URL tests verify that a URL is generated with the right parameters, but don't test that the URL actually works (i.e., that R2 accepts the PUT with proper CORS headers).

This is a fundamental limitation: the browser-to-R2 upload cannot be tested in CI without a real R2 bucket with CORS configured. It's a manual/staging-only verification path.

### 4. R2 CORS was documented but not automated

The self-hosting guide (`docs/guides/self-hosting.md`, lines 330-353) correctly documents that R2 CORS must be configured for file attachments. But this was treated as a self-hoster manual step, not something the platform deployment should do automatically. The deployment pipeline creates the R2 bucket, sets R2 credentials, configures the R2 binding — but skips CORS.

### 5. PR #555 repeated the pattern

PR #555 fixed R2 credential forwarding (a real issue) but again only verified page loads on staging. The staging verification for a credential-forwarding fix should have tested the feature that uses those credentials — file upload.

## Class of Bug

**Infrastructure configuration gap in automated deployment.** The code correctly implements a cross-origin browser-to-service upload, but the deployment pipeline doesn't configure the service (R2) to accept cross-origin requests. This is the same class of bug as deploying a Worker without setting required secrets, or deploying DNS records without TLS certificates.

More specifically: **documentation-as-automation confusion** — a manual setup step was documented in self-hosting.md but never automated in the deployment pipeline. The team assumed that documenting a configuration step is equivalent to implementing it.

## Process Fix

### Rule: Cross-Origin Browser Requests Require Automated CORS (Added)

When a feature involves the browser making direct requests to a third-party origin (R2, S3, external APIs), the CORS configuration for that origin MUST be automated in the deployment pipeline — not documented as a manual step.

**Rationale:** Browser CORS is an invisible deployment dependency. The code works perfectly, unit tests pass, the API is functional — but the feature is completely broken because a bucket/service configuration was missed. Unlike a missing secret (which produces a clear error), missing CORS produces a silent browser-side failure that only manifests in a real browser making a real cross-origin request.

### Rule: Feature Verification Must Match the Feature (Existing, Reinforced)

Per `.claude/rules/13-staging-verification.md`, staging verification must exercise the actual functionality the PR changed. This postmortem reinforces that rule: page-load checks are regression checks, not feature verification.

For file upload features specifically, verification means: attach a file in the UI and confirm it uploads successfully (progress bar completes, no error indicator).

### Rule: Task Checklist Completeness (Existing, Reinforced)

Per `.claude/rules/09-task-tracking.md`, the `task-completion-validator` must be run before archiving any task. The validator should have caught that Phase F items were never checked off. Either the validator wasn't run, or it was run and its findings were ignored.
