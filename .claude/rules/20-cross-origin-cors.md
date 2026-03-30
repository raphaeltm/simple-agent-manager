# Cross-Origin Browser Requests Require Automated CORS

## When This Applies

This rule applies when a feature involves the **browser making direct HTTP requests to a third-party origin** — not proxied through the API Worker. Examples: presigned URL uploads to R2/S3, direct calls to external APIs, embedded iframes from other domains.

## Why This Rule Exists

The R2 file upload feature (PR #554) shipped with working presigned URL generation, passing unit tests, and a functional API — but the feature was completely broken because the R2 bucket had no CORS configuration. The browser silently blocked every upload. See `docs/notes/2026-03-30-r2-cors-upload-failure-postmortem.md`.

## Required Steps

When implementing a browser-to-external-service direct request:

1. **Identify the CORS requirement** — if the browser will make requests to a different origin (different domain, subdomain, or port), CORS must be configured on the target service.

2. **Automate CORS configuration in the deployment pipeline** — CORS rules must be set as part of automated deployment, not documented as a manual step. Manual steps are forgotten; automated steps run every time.

3. **Make CORS configuration idempotent** — the deployment step must be safe to run on every deploy without side effects.

4. **Scope CORS rules tightly** — allow only the specific origin, methods, and headers needed. Never use wildcard `*` for origins when the request carries credentials or sensitive data.

5. **Test the cross-origin request on staging** — unit tests cannot exercise CORS. The staging verification for any cross-origin feature MUST include a real browser making the actual cross-origin request (via Playwright or manual testing).

## Quick Compliance Check

Before committing a feature that involves browser-to-external-service requests:
- [ ] CORS requirement identified and documented
- [ ] CORS configuration automated in deployment pipeline (not manual)
- [ ] CORS rules scoped to specific origin (not wildcard `*`)
- [ ] Staging verification includes actual browser cross-origin request
