# Offer "Re-run Google setup" on a healthy GCP connection

## Problem

PR #2905 narrows Workload Identity trust (user-scoped provider condition, `attribute.sam_user/<userId>`
binding, removal of the legacy `pool/*` member) only when a user re-runs Google setup. The docs and
the journal post tell self-hosters to re-run setup on every connection made before that fix.

The only **Re-run Google setup** control is inside `GcpApiIssuesNotice`
(`apps/web/src/components/GcpApiIssuesNotice.tsx`), which returns `null` when the connection has no
API issues. A healthy connected card (`GcpCredentialForm.tsx`, `GcpConnectionDetails.tsx`) offers only
**Disconnect**. So the security remediation on a healthy connection requires disconnecting and
reconnecting, which creates a new credential id, drops the connection from compute pools until it is
reconnected, and blocks new Google Cloud work in between.

The in-place path already exists in code: the OAuth flow (`apps/api/src/routes/google-auth.ts`)
followed by `/api/gcp/setup` replaces the credential in place and keeps its id
(`replaceUserGcpCredential`), and `GcpCredentialForm` pre-selects the connected project and zone
when re-running.

## Context

Found while fact-checking the 2026-11-19 journal post
(`apps/www/src/content/blog/sams-journal-trusting-the-issuer-was-not-enough.md`).

## Acceptance Criteria

- [ ] A Workload Identity GCP connection card shows **Re-run Google setup** whether or not it has API issues, with one control (no duplicate when the API-issues notice is also shown; rule 24)
- [ ] Re-running keeps the credential id and compute pool attachment (behavioral test through the real setup route)
- [ ] Playwright audit of the card at 375px and 1280px
- [ ] `guides/google-cloud.md`, `guides/self-hosting.mdx` and `architecture/security.md` drop the "disconnect and reconnect" workaround
