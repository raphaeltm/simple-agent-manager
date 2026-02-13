# Encrypt BetterAuth OAuth Tokens at Rest

**Status**: active
**Created**: 2026-02-13
**Branch**: `encrypt-oauth-tokens`

## Summary

Enable BetterAuth's built-in `encryptOAuthTokens` option so that GitHub OAuth tokens (`access_token`, `refresh_token`, `id_token`) are encrypted at rest in the D1 `accounts` table using the existing `ENCRYPTION_KEY`.

## Checklist

- [x] Add `encryptOAuthTokens: true` to BetterAuth account config in `apps/api/src/auth.ts`
- [x] Update `docs/architecture/credential-security.md` with OAuth token encryption section
- [x] Add unit test verifying config enables token encryption
- [x] Run `pnpm typecheck` — passes
- [x] Run `pnpm test` (auth tests) — passes
- [x] Move task file to `tasks/active/`
- [ ] Commit and push branch

## Implementation Notes

- BetterAuth uses the `secret` config value (our `ENCRYPTION_KEY`) for token encryption
- Existing plaintext tokens are re-encrypted on next login because `overrideUserInfoOnSignIn` is already enabled
- Pre-production project, so no migration of existing data needed beyond user re-login
- The credentials test suite has a pre-existing failure (shared package resolution) unrelated to this change
