# F1: close review V1 findings on #2706 (hang fix) and #2705 (platform-key rotation)

## Problem

Independent review V1 (comments on PR #2705 and #2706; idea 01M77AG90EQB4F9VAKDVH94ZK4 notes
"REVIEW V1: #2705 and #2706") found no CRITICAL or HIGH issue but listed fixes required before
either change can be proposed for main. Every MEDIUM and LOW finding is in scope.

Overrides from the dispatcher: no staging, draft pull requests only, never merge, skip CodeRabbit
and the Playwright audit, run security-auditor once on deliverable B. Cloudflare installs must
behave exactly as before. Never run a rotation outside tests. Do not touch the test box.

## Deliverable A: follow-up to #2706 (draft PR, base sam/selfhost-pass-2)

### Research findings

- `platform-config-core.ts` joined `platformConfigInFlight.promise` with a bare await (V1 M1).
- `project-data-ensure-memo.ts`: every abandoning waiter ran its own unregistered ensure (V1 L1).
- `hosted-git/tokens.ts`: module-scope `Promise<CryptoKey>` (V1 asked to audit; H2 called it safe
  only because celld's WebCrypto settles in the same turn).
- `credentialRows` / `legacyKv` abandonment branches had no unit test (V1 L2).
- SonarCloud 12.4% duplication: all 78 duplicated lines were in
  `scripts/selfhost/live/shared-flight-cancel.live.test.ts`, copied from `key-agent-celld` and
  `plaintext-purge` live tests (object store start, bucket, bundle sealing, celld start/deploy).

### Checklist

- [x] A1 platform-config join under settleSharedFlight; first abandoner drops the dead flight and
      starts one replacement; recursion bounded by MAX_PLATFORM_CONFIG_JOIN_ATTEMPTS
- [x] A2 audit with `pnpm quality:shared-flight-joins --inventory` (results in the PR body)
- [x] A3 ensure memo: abandoning waiter registers its own ensure; doc states the Cloudflare change
- [x] A4 unit tests (credentialRows, legacyKv, platform config, ensure fan-out), each proven
      discriminating; live test extended with a platform-config case
- [x] A5 `quality:shared-flight-joins` guard in CI + planted-violation tests
- [x] A6 shared live harness `scripts/selfhost/live/celld-lab.ts`; four live tests use it
- [ ] CI green (manual dispatch) and SonarCloud result recorded

## Deliverable B: fixes on #2705 (branch sam/task-k2-build-platform-7g90vj)

- [ ] B1 R2 onlyIf proven on real celld or the library pass fails closed; verify detects a body
      that does not match its data key
- [ ] B2 encryption-key rotation cannot finish while the old key signs sessions as
      BETTER_AUTH_SECRET
- [ ] B3 JWKS comments in jwt-keys.ts and env.ts match the code
- [ ] B4 mirror and node-fingerprint race tests on a real SQL engine
- [ ] B5 SonarCloud reliability/security findings fixed
- [ ] B6 remaining MEDIUM/LOW findings fixed or recorded in the PR body table
- [ ] security-auditor once on B; CI green; SonarCloud recorded

## Acceptance criteria

- No Worker code awaits another request's in-flight promise without the joiner's own timer, and
  CI fails if new code does.
- Every abandonment branch has a test that goes red when the branch is removed.
- Live celld test covers the platform-config path.
- Cloudflare behaviour unchanged with the new variables unset (stated per shared file in the PRs).
