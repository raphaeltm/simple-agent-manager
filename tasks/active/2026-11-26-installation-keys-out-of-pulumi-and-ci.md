# Installation keys out of Pulumi state and out of CI (self-hosted Cloudflare installs)

SAM task 01M8C74NYMDP2YYPAG17VXJB78. Coordinator task 01M7XCE59V5X0WTNF1X3NFZP5J.
Supersedes `tasks/backlog/2026-11-17-remove-pulumi-secret-readback.md` (idea 01M7M5PJCY4T3CR715AFKRM74R).
Hard-coupled with PR #3011 (installer takeover, branch `sam/mechanisms-install-sam-moment-5wt4w0`,
owner task 01M89RBQZVFSWJZNP13XPM08ES).

## Mandate

Raphaël, 2026-11-26: "Every instance, including this one should be installable and upgradable using
the installer with ZERO possibility of keys being exposed. If there are keys in Pulumi state, I want
them out of there. Even if they are encrypted. Unless there's a _security_ benefit to that."
Policies 795e72a6 (no secret handling in CI) and 4d205820 (install paths).

Terminology: "self-hosted Cloudflare" installs (his own SAM-domain instance, staging, staging2, forks,
installer installs) and "self-hosted VM" installs (celld box). No "hosted SAM".

## Status

Phase 1 design approved by the coordinator (2026-11-26). Phase 2 in progress on
`sam/self-hosted-cloudflare-installs-vxjb78`, stacked on PR #3011 (merged in at 52e839dc6) and
on merged PR #3016 (no Pulumi state export in CI, guard rule `state-export`).

### Decisions (Raphaël, relayed by the coordinator)

- **D1 custody:** Cloudflare only. "I'd rather risk losing all keys than exposing them." No custody
  hook: nothing may export, display or return a key. (Design section E's hook is dropped.)
- **D2 purge:** not automated. After every installation is migrated and verified, give him a
  step-by-step runbook to purge Pulumi history/backups himself (runbook below, filled in at the end).
- **D3:** approved as a FOLLOW-UP PR: retire origin-ca-key/CSR/cert from state and revoke the cert,
  after confirming nothing uses it.
- **D4:** he deletes the `DEPLOY_SIGNING_*` GitHub Environment secrets; tell the coordinator when
  safe (after production and staging are migrated).
- Key rotation for self-hosted Cloudflare: next task, not this one.

### Design changes after review with #3011's owner

- Retirement runs LAST before `pulumi up`, after both takeover gates, not before them: a refused
  takeover must leave the deploy state untouched (a fork's old workflow would otherwise mint new
  keys over the Worker's).
- Gates preview with `--exclude <key URNs + marker>` rather than an allowance for deletes: a
  preview that plans a RandomId deletion (and a `--refresh` preview of one) carries its raw id.
- A protected, non-secret marker resource `installation-keys-retired` makes an old release's
  `pulumi up` fail before its configure-secrets.sh could rewrite keys (verified locally; old
  releases use `--skip-preview`, so they create throwaway RandomIds first, never the live keys).
- Key creation also requires the D1 `users` table to be empty (condition, not proxy: rule 74).

### Findings

- Historical public log scan (2026-08-20 onward, 2608 runs, ~13.7M lines): zero key values found
  (counts only; details in the coordinator report).
- `pulumi preview --diff`, `destroy --diff` and `preview --json`/`--refresh --json` carry a
  RandomId's raw id when it is deleted/refreshed; plain `up`/`destroy`/`refresh` do not.

## Research findings

1. `infra/resources/secrets.ts` generates, all `protect: true`: `encryption-key` (RandomId),
   `jwt-signing-key` (tls RSA), `vapid-key` (tls P-256), `deploy-signing-private-key` (RandomId),
   `preview-signing-key` (RandomId), plus the retired `trial-claim-token-secret` (RandomId) and the
   non-secret `installation-id` (RandomId, stays). Exports six secret outputs from `infra/index.ts`.
2. **A RandomId's resource `id` is the raw key in base64url, stored in plain text in state** (Pulumi
   cannot mark `id` secret). So ENCRYPTION_KEY, the deploy and preview signing keys and the retired
   trial secret are in plaintext in every current checkpoint, and in every history/backup checkpoint
   the DIY R2 backend keeps (`.pulumi/history/`, `.pulumi/backups/`).
3. `pulumi stack export` already runs in CI in `teardown.yml` (lines ~662-722) and
   `pulumi-state-repair.yml` (~163-358); with RandomId keys in state that puts raw keys in runner
   memory/temp files. Removing the resources removes that exposure too.
4. `scripts/deploy/configure-secrets.sh` reads the six outputs with `--show-secrets` on every deploy
   (`read_pulumi_secret`, marker `sam:secret-readback-allowed`), masks them, derives the VAPID raw
   key and deploy-signing public key, and writes all key secrets with `wrangler secret bulk`. GitHub
   secrets (`SECRET_ENCRYPTION_KEY`, `SECRET_JWT_*`, `DEPLOY_SIGNING_*`, `VAPID_*`,
   `BETTER_AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`) override Pulumi when set.
5. It runs from three places: the legacy steps of `deploy-reusable.yml` ("Configure Worker Secrets",
   production/staging/staging2), and the installer engine (`installer-engine.ts` phase
   `publish-application`) for both the installer profile and the opt-in `legacy-ci` shared-engine CI
   path.
6. GitHub Environments (names only, 2026-11-26): `production` and `staging` hold
   `DEPLOY_SIGNING_PRIVATE_KEY`/`DEPLOY_SIGNING_PUBLIC_KEY` overrides; no `ENCRYPTION_KEY`, JWT,
   VAPID, BETTER_AUTH or CREDENTIAL overrides. So for production/staging the deployed deploy-signing
   pair is the GitHub value and Pulumi's seed is unused; staging2 (secondary) gets no overrides and
   runs Pulumi's values. In every case **the Worker secret holds the live value**.
7. PR #3011 adds `PRESERVED_KEY_SECRETS`, `KEY_PAIRS`, `existingPreservedKeySecrets()` (names-only
   Worker secret listing) in `installer-engine-adoption.ts`, and `PRESERVE_EXISTING_WORKER_SECRETS`
   in `configure-secrets.sh`. On adoption the readback still happens; only the write is skipped.
   Its takeover gate `refusedTakeoverSteps()` refuses any Pulumi create/replace/delete.
8. The self-hosted VM path already generates the same key shapes in-process:
   `scripts/selfhost/platform-keys.ts` (`GENERATORS`, grouped so pairs are made together, identity
   groups never regenerated) using `scripts/deploy/generate-keys.ts` and `deploy-signing-keys.ts`.
9. Public halves (`JWT_PUBLIC_KEY`, `VAPID_PUBLIC_KEY`, `DEPLOY_SIGNING_PUBLIC_KEY`) are consumed only
   by the API Worker (no web build, cloud-init or VM-agent consumer).
10. `infra/resources/origin-ca.ts` keeps a protected `origin-ca-key` (tls RSA) plus CSR and a live
    15-year Origin CA cert, exported as `originCaKeyPem`/`originCaCertPem`. No script reads those
    outputs; rule 07 says new VM nodes generate their Origin CA keys locally. Another key in state.

## Design

### A. Where keys are created (only ever once per installation)

One TypeScript module, `scripts/deploy/installation-keys.ts`, shared by every path:

- **Key groups** reuse the generators from `scripts/selfhost/platform-keys.ts` (extracted into a
  shared module so both install kinds mint identical shapes): `ENCRYPTION_KEY` (identity);
  `JWT_PRIVATE_KEY`+`JWT_PUBLIC_KEY`; `DEPLOY_SIGNING_PRIVATE_KEY`+`DEPLOY_SIGNING_PUBLIC_KEY`;
  `VAPID_PRIVATE_KEY`+`VAPID_PUBLIC_KEY`; `PREVIEW_SIGNING_KEY`. `VAPID_SUBJECT` is not a key and is
  still derived from `BASE_DOMAIN` by the deploy.
- `inspect(worker)`: names-only `GET .../workers/scripts/<worker>/secrets` → `present | absent |
  partial` per group (a pair with one half is `partial`).
- `create(worker)`: allowed only when **every** group is absent (a brand-new installation).
  Generates in-process with `node:crypto`, then writes all groups in **one** script-settings update
  (the same `inherit`-other-bindings call Wrangler's bulk uses), so a failure leaves none written and
  a retry sees "all absent" again. Any present or partial group → refuse; it never fills in or
  replaces a key on an existing installation.
- **Installer (installer profile, not adoption)**: a new engine phase `installation-keys` after the
  first API Worker deploy and before `configure-secrets.sh`, calling `create` in the engine process
  in the operator's own account. The values never leave that process: not argv, not a subprocess
  env, not a file, not an engine event/tail, not the checkpoint, not `saveResult`, not the browser.
- **Installer updates and takeovers**: `inspect` only; all groups present or the phase fails.
- **GitHub Actions path** (production until it moves to the installer, staging, staging2, forks):
  never creates or writes a key. A names-only check fails the deploy when any group is not
  `present`, naming the missing secret names and how to create them. Fresh fork installs on Actions
  are not promoted (policy 4d205820); the only creation paths are the installer and
  `pnpm installation-keys create` run on a machine the operator owns (refuses when
  `GITHUB_ACTIONS=true`/`CI=true`). That CLI is also how a torn-down staging2 is re-keyed.

### B. Upgrades never read or write keys

`configure-secrets.sh` loses all key handling: `read_pulumi_secret`, `load_pulumi_secret`, the
`PULUMI_*`/`SECRET_*` key variables, VAPID/deploy-signing derivation, and the key
`set_worker_secret` calls (including the optional `BETTER_AUTH_SECRET`/`CREDENTIAL_ENCRYPTION_KEY`
overrides, which today are written only when a GitHub secret is set and never deleted). It runs the
names-only check instead. `deploy-reusable.yml` stops passing every key secret (both the legacy step
and `SAM_CI_SECRETS_JSON`), and `installer-engine-ci.ts`/`installer-engine-ci-env.json` drop them.
`PRESERVE_EXISTING_WORKER_SECRETS` becomes unnecessary for keys (nothing writes them); #3011's
`PRESERVED_KEY_SECRETS`/`KEY_PAIRS` become the group/name source for `inspect` so there is one list.
Rotation is not a deploy concern (section E).

### C. Migration of existing installs (production, staging, staging2, forks, adopted installs)

Values are preserved because **nothing is regenerated or rewritten**: the Worker secrets keep exactly
what they hold now (Pulumi's value or the GitHub override). Steps, in one controlled engine/workflow
step `retire-key-resources` that runs **before any Pulumi preview or `up`** of the new program:

1. Names-only precondition: every group `present` on the API Worker. If not, stop before touching
   state (state is then still the only copy; recovery is a human running a local-only read, never CI).
2. For each URN on an explicit allowlist — type **and** name:
   `random:index/randomId:RandomId::encryption-key`, `…::deploy-signing-private-key`,
   `…::preview-signing-key`, `…::trial-claim-token-secret`, `tls:index/privateKey:PrivateKey::jwt-signing-key`,
   `…::vapid-key` — run `pulumi state unprotect <urn> --yes` then `pulumi state delete <urn> --yes`
   with output discarded. "Not in state" counts as already retired (idempotent, forks upgrading
   across many releases). `installation-id` is never touched.
3. The following `pulumi up` drops the six key outputs (the program no longer exports them).

No cloud resource is destroyed (random/tls resources exist only in state).

**Takeover gate interaction**: the gate is not loosened. Because the retire step runs before
`refuseResourceChanges()`, the preview never contains a delete for a key resource. Order on a
takeover: `adoption-preflight` (rollback check) → `retire-key-resources` → preview gate → refresh →
gate again → `up`. A stack that still had key resources is migrated by name, and anything else the
new program would delete is still refused. The takeover's dry run (`pulumi preview --diff`) must not
mutate state, so the dry run only reports the allowlisted URNs it would retire (from
`pulumi stack --show-urns`, never `stack export`, which would print RandomId ids) and previews with
those URNs excluded (`pulumi preview --exclude <urn>`, to verify against the pinned Pulumi version):
detail to settle with #3011's owner.

**Pulumi history**: state delete removes keys from the current checkpoint only. The R2 backend's
history and backup checkpoints still hold them, RandomId keys in plaintext. Purging them is
**decision D2** below; designed as a separate, explicit step (`purge-key-history`), run once per
stack after the migration is verified, that deletes `.pulumi/history/**` and `.pulumi/backups/**`
objects for that stack created before the migration. Until then those copies are the de facto
recovery path, which makes the state-delete step reversible by hand.

### D. Proof that no path prints or exports a key value (including public halves)

- Pulumi: no key resource, no key output. Guard test over `infra/`: the only `random.RandomId` is
  `installation-id`, no `tls.PrivateKey` outside the Origin CA item (decision D3), no export whose
  name matches a key pattern.
- Repository: `--show-secrets` appears nowhere (`check-no-secret-readback`'s
  `ALLOWED_LEGACY_READS` becomes empty and its marker support is deleted with it).
- CI: no workflow passes any key secret name; a workflow test asserts it.
- Generation: in-process only; a canary test injects a fixed generator and asserts the canary
  appears in none of: runner command args/env, emitted events and tails, saved checkpoints,
  `saveResult`, stdout/stderr, files under the work dir; and appears only in the one Cloudflare
  write request body. Public halves are generated, held and written exactly like private ones.
- Error paths report HTTP status/Cloudflare error codes only, never request or response bodies.
- `pulumi state delete/unprotect` output is discarded; the URNs it is given are names, not values.

### E. Rotation and recovery (custody is a separate, pluggable piece)

Custody question for Raphaël is open (only in Cloudflare / operator copy shown once / sealed bucket
backup). The design keeps it to one seam: `create()` (and a later `rotate()`) take an optional
`custody` hook called with the generated groups **before** the Worker write; a failing hook aborts
the write. Default, until he decides: no hook, i.e. the only copy is the Worker secret. Rotation of
`ENCRYPTION_KEY` already has app support via `<NAME>_PREVIOUS` (`apps/api/src/selfhost/key-rotation/`);
a Cloudflare `rotate` command (local/installer only) is out of scope here and builds on the same seam.

### F. Docs and rules

Update `CLAUDE.md` "Generated platform secrets" and Architecture Principle 3, `.claude/rules/07-env-and-urls.md`
"Generated Platform Secrets", `.claude/rules/83-no-secret-readback-in-ci.md` (no legacy reads left),
`apps/www/.../guides/self-hosting.mdx`, `architecture/security.md`, `reference/configuration.md`,
`guides/installer.mdx`, `infra/resources/secrets.ts` header, `scripts/quality/README.md`.

## Decisions needed (from Raphaël, via coordinator)

- **D1 custody** (already open): not blocking the build; default is "Cloudflare only".
  Consequence to accept: if an API Worker is deleted (teardown), its keys are gone and stored
  credentials cannot be decrypted. Today the Pulumi copy covers that.
- **D2 purge Pulumi history/backups** after migration (irreversible; loses Pulumi checkpoint history
  for those stacks; removes the plaintext RandomId copies). Recommended: yes, per installation, only
  after D1 is decided and that installation's migration is verified.
- **D3 Origin CA key** (`origin-ca-key`, CSR, live 15-year cert): unused by current nodes per rule 07.
  Recommended: retire key+CSR from state and revoke the cert, in this work or a follow-up PR, after
  confirming no live node still uses the shared cert.
- **D4** (manual, not blocking): after production/staging migrate, delete the now-unused
  `DEPLOY_SIGNING_PRIVATE_KEY`/`DEPLOY_SIGNING_PUBLIC_KEY` GitHub Environment secrets (they are copies).

## Implementation checklist (Phase 2)

- [x] First, separate PR: no `pulumi stack export` in CI + `state-export` guard (#3016, merged 6159fdf7b)
- [x] Base on PR #3011's branch (merged in; rebase onto main after it merges)
- [x] `installation-keys.ts`: inspect (names only), create (no keys + no users, one secrets-bulk
      write, returns nothing), require, CLI (`check`, `check-listing`, `create` refusing CI);
      reuses the generators the self-hosted VM install uses (`generate-keys.ts`, `deploy-signing-keys.ts`)
- [x] Engine phase `installation-keys` (create only for a fresh non-adoption installer install)
- [x] `retire-key-resources.ts` + engine `applyInfrastructure`: gates `--exclude`, retire last before up
- [x] Workflow: retire step between Pulumi Refresh and Pulumi Up; dry-run preview excludes
- [x] Remove key resources and outputs from `infra`; add the retirement marker
- [x] `configure-secrets.sh`: no key handling; names-only check via `wrangler secret list`
- [x] `deploy-reusable.yml`, `installer-engine-ci.ts`, `installer-engine-ci-env.json`: no key inputs
- [x] `ALLOWED_LEGACY_READS` empty
- [x] Tests (engine migration/takeover/refusal/missing key/fresh create canary; configure-secrets via
      real check; workflow guards; infra guards; unit tests)
- [x] Docs/rules (section F)
- [ ] Supersede `tasks/backlog/2026-11-17-remove-pulumi-secret-readback.md`
- [ ] Specialist reviews: security-auditor, cloudflare-specialist, env-validator, task-completion-validator
- [ ] Staging: migrate staging, verify sign-in, credential decrypt, VM callback verification; then staging2
- [ ] Production plan reported to coordinator before merge
- [ ] D2 purge runbook (below) written once everything is migrated
- [ ] Tell the coordinator when D4 is safe
- [ ] D3 follow-up PR (Origin CA)

## D2: manual Pulumi history purge runbook (for Raphaël; fill in after migration)

_To be written once production, staging and staging2 are migrated and verified._

## Acceptance criteria

- No Pulumi program resource or output holds an installation key; current state of staging,
  staging2 and production contains none after migration.
- No CI job reads, derives, generates or writes an installation key; `--show-secrets` appears nowhere.
- Existing installs keep their exact key values (sign-in sessions survive, stored credentials decrypt,
  VM callbacks verify, deploy-release signatures verify).
- A deploy against a Worker missing a key fails and names the missing secret, without generating one.
- A fresh installer install creates keys once, in the operator's account, never visible anywhere else.
- Takeover of a stack that still has key resources succeeds through the explicit retire step; the
  takeover gate itself is unchanged.
