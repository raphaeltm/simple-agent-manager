# Email-code sign-in deletes the GitHub link of a GitHub-created account

## Problem

On an install with email sign-in, signing in by email code to an account that was created by
"Sign in with GitHub" deletes that account's GitHub OAuth link and all its sessions. Afterwards
SAM has no GitHub user token for the account, so task submit returns 401 ("GitHub authorization
has expired") and workspace git-token returns 403. The user is not told why.

Cause: better-auth 1.7.14 `revokeUnprovenAccountAccess`
(`dist/db/revoke-unproven-account-access.mjs`, called by the email-otp plugin) deletes every
account link and session of a user whose `emailVerified` is false when an email-code sign-in
proves the mailbox, then sets `emailVerified=true`. This is deliberate anti-takeover behaviour.
SAM creates GitHub users with `emailVerified=false` whenever GitHub's `/user/emails` call fails
(`apps/api/src/auth.ts`, `getUserInfo`, the `github_emails_unavailable` branch falls back to the
`<id>+<login>@users.noreply.github.com` address with `emailVerified=false`).

## Context

Found 2026-11-11 on the self-hosted test box (task 01M74SZ6217NT5SCA7CWC95AZG). A GitHub-created
test account had a working token at 08:18:54Z; an email-code sign-in at 08:24:20Z was followed
1 s later by `github.user_access_token_lock.account_missing`, and its `accounts` row was gone.
`/user/emails` returned 403 at both GitHub sign-ins on that box. A second GitHub-created account
on the box (`email_verified=0`) is exposed to the same loss.

## Acceptance Criteria

- [ ] Decide the intended behaviour (needs a human decision): for example, never offer an email
      code for a `users.noreply.github.com` address (nobody can receive mail there), or record
      GitHub's verified-primary state when the emails call succeeds, or warn before the strip.
- [ ] Find why `/user/emails` returns 403 for a GitHub App user token on this install and fix the
      App permission guidance if needed.
- [ ] A test through the real better-auth email-otp route proves a GitHub-linked account keeps
      (or deliberately loses, with a visible message) its link.
