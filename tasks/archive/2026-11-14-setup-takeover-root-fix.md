# Setup takeover: root-cause fixes (PR 1)

## Problem

On 2026-11-12 04:07Z a third party took over the production superadmin account:

1. Production and staging were installed before the first-run setup wizard (#1528, 2026-07-07).
   `isSetupCompleted` only reads the `setup.completed` row, which nothing ever wrote for them, so
   `/api/setup/*` stayed open for about four months on instances that already had an owner.
2. `SETUP_TOKEN` is a `plain_text` Worker var. The deploy job echoes `wrangler deploy` output, and
   Wrangler prints every plain-text binding's value, so the current token was readable in the
   public Deploy Production logs.
3. The attacker completed setup with a self-managed GitLab host they controlled. GitLab was pushed
   into better-auth `trustedProviders` and the GitLab provider passes the host's own
   `email_verified` claim through, so signing in with the owner's email linked a fake GitLab
   identity to the superadmin and issued a session.

Containment was done by hand on 2026-11-14 (rogue integration, link and session deleted; prod and
staging `setup.completed` written). This task fixes the causes.

## Research findings

- `apps/api/src/services/platform-config-core.ts:451` `isSetupCompleted`: `SETUP_FORCE` → open;
  else `setup.completed === 'true'`. Callers: `routes/setup.ts` (status/verify/complete) and
  `platform-config-status.ts` (admin status). Low call volume.
- `scripts/deploy/sync-wrangler-config.ts:1105` generates `SETUP_TOKEN` (`generateSetupToken`,
  line 248) on every sync; all sync and `wrangler deploy` steps run in the single `deploy` job of
  `.github/workflows/deploy-reusable.yml` (lines 514, 1309, 1345, 1879, 1958), so a
  `::add-mask::` registered by the sync script masks every later echo in that job.
  The token must stay dashboard-readable (docs and lockout recovery rely on it), so it stays a
  plain var; only the log exposure changes.
- better-auth 1.7.14 `oauth2/link-account.mjs:141`: implicit linking is allowed when the provider
  is trusted **or** `userInfo.emailVerified` is true. `@better-auth/core` `social-providers/gitlab`
  sets `emailVerified: profile.email_verified` from the configured host, then spreads
  `mapProfileToUser`. So removing GitLab from `trustedProviders` alone would not have stopped the
  attack; the host's verified claim must also be dropped. Explicit link (`linkOAuthAccount`) uses
  the same test; main has no explicit link-social UI, GitLab accounts only come from sign-in.
- GitHub and Google have fixed identity hosts (github.com, Google). Whoever configures their
  client cannot make them vouch for an email they don't control, so their trust is unchanged.
  The condition is "the identity host can be chosen by whoever writes integration settings",
  not "configured at runtime" (rule 74): runtime GitHub/gitlab.com are safe; a runtime
  self-managed GitLab host is not.
- `routes/setup.ts` `clientIdentifier` falls back to `X-Forwarded-For` and `User-Agent`, both
  client-controlled; on Workers `CF-Connecting-IP` is set by the edge.
- Docs referencing the token and setup closure: `guides/self-hosting.mdx` (84, 114, 458),
  `guides/admin-settings.md` (lockout recovery), `reference/configuration.md` (SETUP_TOKEN row),
  `reference/api.md` (setup routes), `architecture/security.md`, `.claude/skills/env-reference`.

## Implementation checklist

- [x] `scripts/deploy/setup-token.ts`: generate the token and register `::add-mask::` when
      running in GitHub Actions; import from `sync-wrangler-config.ts` (shrinks the 1408-line file)
- [x] Unit test: masked inside Actions, nothing printed outside Actions
- [x] `isSetupCompleted`: an active, non-system superadmin closes setup and persists
      `setup.completed` (write failure logged, still closed); `SETUP_FORCE` still reopens
- [x] Route tests: superadmin + no row → `GET /api/setup/status` and `POST /api/setup/complete`
      answer 410 and the row is written; no superadmin → open; `SETUP_FORCE` → open
- [x] `selectGitLabOAuthConfig` returns `identityTrusted` (host is gitlab.com, or host came from
      the Worker environment)
- [x] `auth.ts`: untrusted GitLab is not in `trustedProviders`, gets
      `overrideUserInfoOnSignIn: false` and `mapProfileToUser → { emailVerified: false }`
- [x] Vertical-slice test through the real `/api/auth` routes and better-auth with a fake GitLab:
      runtime self-managed host claiming an existing user's verified email does NOT link or sign
      in; control: same flow on gitlab.com / env-pinned host links; guard deletion turns the
      attack test red
- [x] `clientIdentifier`: `CF-Connecting-IP` only; test that rotating User-Agent / XFF does not
      escape the limit
- [x] Docs sync (list above)

## Acceptance criteria

- [ ] An instance with an active superadmin and no `setup.completed` row answers 410 on every
      setup route
- [ ] A runtime-configured self-managed GitLab host cannot link to, sign in as, or rewrite the
      profile of an existing user
- [ ] gitlab.com and env-pinned GitLab, GitHub and Google sign-in behave as before
- [ ] Staging deploy log shows `env.SETUP_TOKEN ("***")`
- [ ] Staging: setup status 410, sign-in works, login providers unchanged

## References

- Incident session task 01M7DJT04N8DYW1T5VF30ETCQZ; channel `feature.setup-takeover-fix`
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`, `62`, `28`

## Implementation notes

- Discrimination proofs (all reverted after):
  - Mask removed from `generateSetupToken` → `setup-token-masking` "registers the exact token" and
    `sync-wrangler-config` "masks the setup token" went red.
  - Owner check removed from `isSetupCompleted` → "closes every setup route", "stays closed after
    the owner is no longer a superadmin", "stays closed when recording setup.completed fails" went
    red; open-install, sentinel and SETUP_FORCE controls stayed green.
  - Old header fallback restored in `clientIdentifier` → only "cannot be escaped by rotating
    client-controlled headers" went red.
  - GitLab always trusted → attack, unverified-new-user and profile-unchanged tests went red;
    gitlab.com and env-pinned controls green.
  - GitLab out of `trustedProviders` but host `email_verified` kept → the 2026-11-12 attack test
    still went red: removing GitLab from trustedProviders alone would not have stopped the attack.
- No D1 migration: the runtime owner check closes setup on every install at deploy and records the
  row on first read; a migration would only duplicate it.
- `sync-wrangler-config.ts` is 1408 lines (pre-existing); the token logic moved out to
  `scripts/deploy/setup-token.ts`, so the file shrank.
