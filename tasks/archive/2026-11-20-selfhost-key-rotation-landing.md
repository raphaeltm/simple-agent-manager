# Self-host landing slice: platform-key rotation for sealed boxes

SAM task `01M7WVYCGPGC8M76Q853QZWV8H`, coordinator `01M7JMXS2JRW6QQMB1356ENPM3`, idea
`01M7VTNAG1HMCE18GCNPS052X3`. Ports `pnpm selfhost:secrets rotate` from `sam/selfhost-pass-2`
(design and inventory: that branch's `tasks/active/2026-11-13-selfhost-platform-key-rotation.md`).
Closes finding F10(c) left by #2933; F10(d) (plaintext copies of platform keys stay valid) is
retired by running `rotate --all` on a box.

## Research findings

- New-only files taken whole: `scripts/selfhost/rotate-*.ts`, `apps/api/src/selfhost/key-rotation/`,
  `services/encryption-key-fallback.ts`, `lib/better-auth-secrets.ts`, `services/jwt-keys.ts`,
  `services/jwt-verify.ts` (jwt.ts split), Caddy `sam.d/key-rotation.caddy`, tests.
- Shared files unchanged on main since the merge base (114e1d98b): encryption.ts, file-encryption.ts,
  jwt.ts, lib/secrets.ts, env.ts, auth.ts, the bearer-token HMAC call sites. Branch diffs on them are
  rotation-only (except an I1 comment in auth.ts, not ported, and non-rotation env fields, not ported).
- Main's newer self-host APIs: async `BundleStore` (key-service `settings.bundles`), `generateAgentSigningKey`
  moved to key-seal.ts, `completeSealedPlatformKeys`, async `ensureKeyServiceFiles`, runtime-secrets
  split into `runtime-secrets-worker.ts` / `-durable-object.ts`. Adapted.
- Main added `gcp_wif_pool_index.iv` (index marker, not ciphertext): added to `NOT_ROTATED_IV_COLUMNS`;
  re-indexes itself after re-encryption. No other new ENCRYPTION_KEY/encrypt call sites on main.
- Main removed `plaintext --purge` (F10): rotate report and README no longer mention it.
- Branch read JWT/BetterAuth `*_PREVIOUS` straight from env in shared code, so a Cloudflare env with
  them set WOULD enable fallback. Fixed: every rotation variable is honoured only inside the self-host
  rotation scope, turned on solely by `registerRotationKeys` in the celld wrapper.
- Branch task `2026-11-14-selfhost-f2-rotation-teardown-defects.md`: its rotation items (K1-K6: dry run
  creates nothing, status names the staged reseal, etc.) came with the ported code and tests; its teardown
  items (T1-T3) are not rotation and are out of scope for this slice.
- `TOKEN_HASH_KEY` is also read only inside the rotation scope (validator MEDIUM), so a Cloudflare Worker
  ignores it like every other rotation variable.
- Hot-path I/O: none added. Cloudflare: one boolean check per decrypt failure / JWT verify / auth
  options build. celld: `previousKeyPairs` (3 string compares) per request.

## Checklist

- [x] Port new files; adapt to main's async bundle store / key-seal / platform-keys
- [x] Port rotation hunks onto shared files (encryption, file-encryption, jwt split, secrets, auth, env, token HMAC sites)
- [x] runtime-secrets: register rotation keys (Worker + DO), route KEY_ROTATION_PATH to the control handler
- [x] Self-host-only rotation scope; Cloudflare-proof tests, each gate proven discriminating
- [x] `rotate` command in secrets.ts; plaintext-scan `rotationAdvice` and README point at `rotate`
- [x] runtime-tunables baseline, Caddy fragment + live test, backlog follow-ups from the branch
- [x] Full local quality suite (lint, typecheck, API unit 18.4k, selfhost 1.2k; reruns after fixes)
- [ ] Security-auditor (control endpoint auth/replay/callers, fallback scoping) + other reviewers
- [ ] Staging: sign-in + authed call, stored credential decrypt + use, JWT callbacks verify
- [ ] Box: `rotate --all` from main; data decrypts, sign-in, hosted-git clone, old copies dead; kill+resume; failed-run rollback
- [ ] PR, CI, merge, Deploy Production job

## Acceptance criteria

- Cloudflare: previous-key map empty and no fallback with any `*_PREVIOUS` set (tests).
- No new required Worker vars/secrets; no extra hot-path I/O.
- On the box: every platform key rotated, data intact, old plaintext copies no longer work,
  interrupted run resumes, failed verification rolls back.
