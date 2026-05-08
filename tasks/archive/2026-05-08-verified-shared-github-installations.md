# Verified Shared GitHub Installations

## Problem

Multiple SAM users need to connect and use the same GitHub App organization installation as a first step toward company/team use. The database already permits per-user rows for the same external GitHub installation, but the callback and sync paths must verify that the logged-in GitHub user can actually access the installation before creating a row.

## Research Findings

- `github_installations` is scoped by `user_id` and uniquely indexed by `(user_id, installation_id)` in `apps/api/src/db/schema.ts`.
- Migration `0022_org_installation_sharing.sql` explicitly changed the model to allow multiple users to reference the same GitHub App installation.
- `GET /api/github/callback` currently fetches installation details as the app and inserts a row for the logged-in user without proving the user can access the requested `installation_id`.
- `syncUserInstallations()` currently lists all app installations then checks org membership with an installation token, but this is weaker and may require undocumented org permissions.
- BetterAuth exposes `auth.api.getAccessToken`, which can return the logged-in user's decrypted/refreshed GitHub user token.
- GitHub `GET /user/installations` is the correct user-context API for listing installations the authenticated GitHub user can access.

## Implementation Checklist

- [x] Add GitHub user-token installation listing helper.
- [x] Use the helper in installation sync instead of app-wide installation + org member scraping.
- [x] Verify callback `installation_id` against the authenticated user's accessible installations before inserting.
- [x] Keep per-user duplicate behavior idempotent.
- [x] Add regression tests for accepted and rejected callback/sync paths.
- [x] Update self-hosting docs to describe verified multi-user org installation sharing.
- [x] Run focused tests and quality checks.

## Acceptance Criteria

- A logged-in user can attach a GitHub App installation only if GitHub says their user token can access it.
- A second org member can get their own SAM `github_installations` row for the same external GitHub installation.
- A non-member or spoofed `installation_id` is rejected and not inserted.
- Installation sync no longer depends on app-wide installation enumeration plus org members API.
- Docs explain that this enables multi-user installation sharing, not full organization tenancy.
