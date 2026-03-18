# Document GCP Prerequisites for Self-Hosting

## Problem

The GCP OIDC integration requires several APIs to be enabled on the GCP project where the OAuth client is created (the SAM operator's project). All API calls made via the user's OAuth token are billed/rate-limited against the OAuth client's project, so that project needs every API enabled that the setup flow calls. Without them, the setup fails with 403 "API has not been used in project" errors.

## Context

Discovered during staging testing of PR #452 (GCP OIDC integration). This is distinct from the APIs enabled on the user's target project during automated setup.

## Required APIs on the OAuth Client Project

These must be enabled as a one-time self-hosting prerequisite:

1. `cloudresourcemanager.googleapis.com` — list/get projects, IAM policy operations
2. `iam.googleapis.com` — WIF pools, OIDC providers, service accounts
3. `serviceusage.googleapis.com` — enable APIs on user's target project
4. `sts.googleapis.com` — STS token exchange during OIDC verification
5. `iamcredentials.googleapis.com` — credential generation during verification

Link format: `https://console.developers.google.com/apis/api/<API>/overview?project=<PROJECT_NUMBER>`

## Acceptance Criteria

- [ ] Add GCP OAuth client setup instructions to `docs/guides/self-hosting.md`
- [ ] Document all 5 required APIs on the OAuth client project (listed above)
- [ ] Include direct link format for each API
- [ ] Mention this is a one-time setup step alongside GitHub App and Cloudflare configuration
- [ ] Add to any setup checklist or quick-start guide
