# Document GCP Prerequisites for Self-Hosting

## Problem

The GCP OIDC integration requires the **Cloud Resource Manager API** to be enabled on the GCP project where the OAuth client is created (the SAM operator's project). This is a one-time setup step, similar to creating the GitHub App or configuring Cloudflare API tokens. Without it, the "list projects" call fails with a 403.

## Context

Discovered during staging testing of PR #452 (GCP OIDC integration). The OAuth client's project needs this API enabled before it can list a user's GCP projects. This is distinct from the APIs enabled on the user's target project during setup.

## Acceptance Criteria

- [ ] Add GCP OAuth client setup instructions to `docs/guides/self-hosting.md`
- [ ] Document that the Cloud Resource Manager API must be enabled on the OAuth client's GCP project
- [ ] List all required APIs on the OAuth client project (Cloud Resource Manager)
- [ ] Include direct link format: `https://console.developers.google.com/apis/api/cloudresourcemanager.googleapis.com/overview?project=<PROJECT_NUMBER>`
- [ ] Mention this is a one-time setup step alongside GitHub App and Cloudflare configuration
