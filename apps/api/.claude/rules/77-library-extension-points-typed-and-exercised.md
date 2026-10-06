# Implement a Library Extension Point Against the Library's Types, and Test It Through the Library

## When This Applies

Any SAM code that plugs into a third-party library's extension point and is called by that
library rather than by SAM: better-auth provider options (`getUserInfo`, `mapProfileToUser`,
`refreshAccessToken`), better-auth database hooks, ORM adapters, framework middleware
contracts, agent-framework tool definitions.

It applies with full force when the flow is one users cannot work around: sign-in, session
creation, payment, credential refresh.

## Why This Rule Exists

better-auth 1.7 moved an OAuth account's identity from `getUserInfo().user.id` to
`getUserInfo().data.id` (the provider's `accountSubject`). SAM's custom GitHub `getUserInfo`
returned `data: { githubId, avatarUrl }`. It lived in a provider map typed
`Record<string, unknown>`, so `pnpm typecheck` never saw the library's new contract
(`OAuth2UserInfo.id?: never`, `data: GithubProfile`). The only auth test replaced
`better-auth` with `vi.mock`, so no test ran a real callback.

The Dependabot bump (PR #2130) merged with every check green. From the production deploy on
2026-09-23 until 2026-10-01, every GitHub sign-in failed with `unable_to_get_user_info`.
Existing sessions kept working, so nobody noticed until someone signed in from a new browser.

## Class of Bug

**A library-invoked hook whose contract nothing checks.** The library calls the hook, so a
contract change shows up only at runtime and only on the path that calls it. Widening the
hook's type to silence the compiler removes the one signal an upgrade would raise. Mocking the
library in tests removes the other.

## Hard Requirements

1. **Type the hook against the library's exported option type** (`SocialProviders`,
   `GithubOptions`, the adapter or middleware interface). Never widen it to
   `Record<string, unknown>` or `any` to make an error go away. On an upgrade, that type
   error is the warning.
2. **Keep any cast at that boundary single-step and commented** with exactly what the library
   reads from the value. A cast must not hide a field the library needs.
3. **Give every critical flow built on the library a vertical-slice test that runs the real
   library** and fakes only the external service at the network boundary. A test that mocks
   the library cannot fail when the library changes.
4. **Seed one case in the shape production already stores** (an existing user, account or
   row created by the previous library version). An upgrade that silently re-keys stored
   identities breaks returning users, not only new ones.

## Required Tests

- The vertical slice for each such flow, entering through the production route.
- A returning-user case seeded in the production row shape, with assertions on row counts so
  a duplicate identity cannot pass.
- A failing control (a request the external service rejects), so the harness is shown to
  detect failure.
- Proven discriminating: run the slice against the broken hook and record which tests went red.

## References

- Implementation: `apps/api/src/auth.ts` (`socialProviders`, GitHub `getUserInfo`)
- Test: `apps/api/tests/integration/github-oauth-sign-in.test.ts`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`: reach the feature the way
  production does
- `.claude/rules/35-vertical-slice-testing.md`, `.claude/rules/23-cross-boundary-contract-tests.md`
