# F3: self-host defects from box round R13 (first from-scratch install)

Base branch `sam/selfhost-pass-2` (never main). Draft PR only; the coordinator (task
01M7AF82KG9C78WAABTG3V1MN1) reviews and merges. No Cloudflare staging deploy (self-host code;
a box round verifies after merge). CodeRabbit skipped by instruction.

## Problem

Box round R13 (November 14, 2026) emptied the GCP test project and rebuilt the box with the
documented bootstrap and install. It worked, with defects (idea 01M7DHBFERXG63MBNBMXB5068H, note
"Second cycle, box round R13"; evidence on idea 01M77HYN8N41MQ17TQZ622PPPV, "BOX ROUND R13"
parts 1-3, D1-D8).

## Research findings

1. **Silent KMS -> file fallback (R13 D3).** `chooseKeyProvider()` (scripts/selfhost/key-choice.ts)
   falls back to the file key for every candidate failure except `unavailable`. A key whose only
   version is DESTROY_SCHEDULED answers 400 FAILED_PRECONDITION (kind `invalid`), so `--init`
   recorded `file`. The GCP provider's error said only "HTTP 400" (`jsonCall` drops the body).
   `gcp-bootstrap.sh` checks only that the key exists and carries the label; it never reads the
   primary version's state. Automatic choices: `resolveKeyProviderBox` (`deploy --init`, also
   reached by `secrets migrate`) and `secrets switch --to auto`; both call `chooseKeyProvider`.
   A plain deploy only reads the recorded choice; bundles bind provider and key
   (`openBundle`), so an explicit weaker `SAM_KEY_PROVIDER` on a sealed box already fails.
   AWS maps a pending-deletion or disabled key to `denied`, so "only `invalid` is
   exists-but-broken" would leave the AWS twin of R13 open.
2. **build-essential (D1).** better-sqlite3 13.0.3 builds from source on Ubuntu 24.04. No box
   preparation script exists; `pnpm install` fails before any SAM script runs, so README only.
3. **`--kms-only` issuer check (D2).** The issuer check guards the OIDC provider, which
   `--kms-only` never creates.
4. **No box creation docs (D4).** Write from R13's commands.
5. **Soft-deleted pool (D5).** Bootstrap uses bare `describe` exit status; a DELETED pool
   describes fine.
6. **KMS grant not listed (D6).** `bootstrapItems()` lists only recorded/discovered entries; the
   box account's grant on an adopted or reused key is neither removed nor listed. Teardown does
   not remove grants for principals the bootstrap did not create (the node SA's roles go only
   with the SA), so list, do not remove.
7. **nbg1 default (D8).** `POST /api/nodes` passes `body.vmLocation ?? DEFAULT_VM_LOCATION`
   (apps/api/src/routes/nodes.ts) into allocation as an explicit location.
8. **"HEAD" branch (D11).** The vendored dgit server's `lsRefs` ignores `ref-prefix`; the
   ArtifactsRepoBrowser asks for `refs/heads/` and gets HEAD back. The vendored files must not
   be edited (UPSTREAM.md), so filter in the HostedGitRepo Durable Object.

## Implementation checklist

- [x] 1a bootstrap: read the key's primary version state; stop by default with exact commands;
      `--new-key-version` creates a new primary version; `--restore-key-version` restores and
      enables the scheduled/disabled version and makes it primary. Fake gcloud models versions.
- [x] 1b one rule (`sealingFloor` + refusal) in key-choice.ts: automatic choice never seals with
      the file key when a cloud key is configured in .env, exists but is unusable, or the box is
      sealed with a stronger provider now (switch --to auto). Error status from the key service
      named in the reason (no body text).
- [x] 1c `secrets status`: names what seals the box and warns when a cloud key on this platform
      works or exists while the box seals with the file key.
- [x] 1 tests: R13 sequence (key present, version DESTROY_SCHEDULED) against the fake KMS, red
      before; deliberate file box (no cloud, explicit SAM_KEY_PROVIDER=file, recorded file)
      unchanged.
- [x] 2 README prerequisites: build-essential.
- [x] 3 `--kms-only` skips the issuer check; failure message says what to do; README command.
- [x] 4 README "Create the box" section from R13's commands.
- [x] 5 bootstrap reads pool/provider state; DELETED stops with the undelete command or new
      `--pool-id`; README 30-day rule next to teardown.
- [x] 6 teardown lists the box account's KMS grant with the command.
- [x] 7 node API default location on self-host (shared code; Cloudflare unchanged).
- [x] 8 hosted git ls-refs honours ref-prefix (DO), "HEAD" not listed as a branch.
- [ ] Gates: build order, typecheck, check:fast, unit tests, selfhost:test, live suite (if
      possible), manual CI run.
- [ ] security-auditor on 1/5 changes; task-completion-validator.

## Acceptance criteria

- The exact R13 sequence makes `deploy --init` stop with an error naming the key, the cause and
  the bootstrap command; nothing is recorded or sealed.
- The bootstrap stops on a key with no enabled primary version unless told to restore or add one.
- `secrets status` says the box is sealed with a key file and warns when a cloud key exists.
- An off-cloud box and `SAM_KEY_PROVIDER=file` keep working unchanged.
- Each item has a test that fails without its fix (docs items excepted).

## Notes

- Security review (security-auditor) found 0 CRITICAL/HIGH, 4 MEDIUM (M1 configured key ignored
  when no platform is detected; M2 `config` kind conflated "no key" with "no VM identity"; M3
  "denied" worded as "exists"; M4 re-added entries after a teardown), all fixed in e72f2da4c with
  tests that fail without the fix. L1/L3/L5 fixed; L2 (errorStatus token bound) and L4
  (`--kms-only` skips the issuer check by design) left.
- Item 7 gate: `isReverseTunnelInstallation(env)` is the existing self-host marker, used as a proxy
  for "self-hosted box". Divergence: a Cloudflare install configured with reverse-tunnel would also
  get pool-decided locations; none exists (the transport needs frps on the box).
- Pre-existing, not fixed: hosted git conformance "imports the source..." fails with a harness
  HTTP 500 (tasks/backlog/2026-11-14-hosted-git-conformance-import-test-500.md); the conformance
  entry also lacked the repo-hosting wiring (fixed here). CI does not run `test:hosted-git`.
- Live suite (`pnpm selfhost:live-test`) cannot run in this workspace: no Docker (spawnSync docker
  ENOENT in every Docker-backed file).

- Item 7 is shared code: state exactly what changes on Cloudflare (target: nothing).
