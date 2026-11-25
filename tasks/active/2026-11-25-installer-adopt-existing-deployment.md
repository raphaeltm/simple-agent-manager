# Installer: take over an existing SAM deployment (adopt)

## Problem

Raphaël (2026-11-25, chat task 01M88RM92NS63P179HDK5WT4W0) wants to retire fork + public GitHub
Actions as a way to install or update SAM, and to move his own deployments the same way. The
installer (`apps/installer`) can only create a new installation. Existing deployments (outside
forks, SAM's own staging and production) need a way to hand themselves to an installation service
in their own Cloudflare account without losing data, keys or settings. Approved: "Ok. Let's do
it." Context and audit: idea 01M88S2Z10WS855DM0937QVCY2; standing rule: policy "SAM install
paths: deliberate, secure by default, and never via public GitHub Actions".

## Research findings

Code read on origin/main f49ee4017 (nothing run yet).

1. **One engine already deploys both ways.** `scripts/deploy/installer-engine.ts` runs the whole
   deploy (Pulumi, wrangler, migrations, secrets, health). The installer's builder runs it with
   the `installation` profile; `deploy-reusable.yml` can run it with `legacy-ci`
   (`installer-engine-ci.ts`), an opt-in used only by staging. `legacy-ci` already accepts an
   explicit `prefix` and `stateBucket` (`installer-engine-contract.ts` `validateRunnerProfile`).
2. **Installer naming is fixed.** `apps/installer/src/credentials.ts:173-177` and
   `maintenance-jobs.ts` (`prefix='s'+hash(baseDomain)`, `environment:'production'`) always derive
   `s<sha256(domain)[0:6]>` and `<prefix>-pulumi-state-<env>`. The builder rejects any other
   prefix (`/^s[a-f0-9]{6}$/`) and any environment other than production or staging
   (`builder.ts` `/start`). Forks use `<prefix>-pulumi-state` (`workflow-resource-names.mjs:188`).
   SAM's own installs use an explicit prefix (`sam-api-staging`).
3. **The engine creates state when absent.** `state-backend` creates the bucket on 404 and
   `pulumi stack init`s a missing stack. Adoption must never do either: a missing bucket or stack
   means the target is not what the owner described.
4. **No dry run today for installations.** `dryRun` is `legacy-ci` only and runs `pulumi preview
   --diff` without classifying operations.
5. **Key overrides would be lost.** `configure-secrets.sh:287-333` prefers GitHub-secret overrides
   (`SECRET_ENCRYPTION_KEY`, `SECRET_JWT_*` …) over Pulumi outputs. An adopt deploy has no GitHub
   secrets, so it would replace an overridden `ENCRYPTION_KEY` with Pulumi's generated one: every
   stored credential unreadable, every session invalid, and GitHub secrets cannot be read back to
   recover. Adoption must leave existing key-material Worker secrets in place.
6. **Other Worker secrets survive by themselves.** `set_worker_secret` skips empty optional values
   (`configure-secrets.sh:182-189`), and `wrangler deploy` does not remove secrets, so GitHub-App,
   OAuth and similar secrets set by the fork's workflow stay as they are.
7. **Vars do not survive.** `wrangler deploy` replaces the Worker's plain-text vars with the
   generated set (`sync-wrangler-config.ts:607-613`). A fork's GitHub Environment overrides
   (`getOptionalProcessEnvVars`, list at `sync-wrangler-config.ts:668`) would silently revert to
   checked-in defaults (rule 70). The deployed Worker's own `plain_text` bindings are the truth and
   are readable with the deployment token.
8. **Owner email trap.** `BOOTSTRAP_OWNER_EMAIL` on an instance with existing users refuses every
   session unless an active superadmin with that verified email exists
   (`bootstrap-owner.ts:13-21, 70-97`). The engine always passes `BOOTSTRAP_OWNER_EMAIL: c.ownerEmail`
   (`installer-engine.ts`, publish-application). Adoption must not set it.
9. **Setup handoff does not apply.** The installation profile's `owner-handoff` phase hands over a
   setup token for a new instance. An adopted instance already has an owner, and setup is closed.
10. **staging2 is not an isolated proof target.** It is a secondary installation that shares the
    primary staging Pulumi state bucket and passphrase (`workflow-resource-names.mjs`
    `resolveResourceNames`, "shares the primary's Pulumi backend"), and the shared engine refuses
    secondary installations. Handing staging2 to an installation service would give that service
    the key to staging's state as well, which rule 83 ("no copying between installations")
    forbids. The proof target needs Raphaël's decision (see Open decision).
11. **Release flow.** The update service offers only the latest GitHub release, after owner
    approval (`maintenance-jobs.ts` `/update-preview`). Moving SAM's own production off
    merge-to-deploy is out of scope here; production moves last, after a separate agreement.
12. **PR #2993** (own-account installer, unmerged) changes `apps/installer/scripts/*`, pages and
    docs; this work changes `apps/installer/src/*` and the engine. Rebase after it merges.

## Design

Adoption is a mode of the existing installation flow, not a parallel implementation.

- **Plan.** On the installer's review step, a domain that already runs SAM is detected from its
  API Worker route (`api.<domain>/*` → script `<prefix>-api-<stack>`). The owner chooses "Take over
  this installation" and enters the deploy-state passphrase they saved. The plan records the
  prefix, environment and state bucket. (Superseded: fork deploys record no deployed commit, so the
  plan cannot name one; the takeover deploys the installer's approved source, protected by the
  rollback guard and the preview gate. See Implementation notes.)
- **Credentials.** Minted as for an install, with R2 access scoped to the existing state and assets
  buckets. The passphrase is stored only as a secret of the owner's maintenance Worker.
- **Job.** The maintenance service stores `adoption` in its config. "Take over" starts a builder
  job with the engine's `adoption` behaviour:
  1. never create the state bucket or init a stack;
  2. run `pulumi preview --json` and refuse if any resource would be created, replaced or deleted
     (named in the failure tail), immediately before `pulumi up` in the same job;
  3. carry the deployed Worker's override vars into sync;
  4. leave existing key-material Worker secrets in place (only set ones that are absent), for this
     job and every later update of an adopted installation;
  5. do not set `BOOTSTRAP_OWNER_EMAIL`, and skip the setup-token handoff;
  6. (Superseded) deploy the installer's approved source; the rollback guard refuses when the
     deployment is newer, and the preview gate refuses any resource change. The owner updates
     through the normal update flow afterwards.

## Implementation checklist

- [x] Engine: `adoption` settings on the installation profile (explicit prefix, environment,
      state bucket); validation; fingerprint
- [x] Engine: state-backend refuses a missing bucket/stack in adoption
- [x] Engine: preview gate (`pulumi preview --json`, classify `changeSummary`/steps; refuse
      create/replace/delete), with tests on real preview JSON shapes
- [x] Engine: carry deployed override vars (exported optional-var list from sync-wrangler-config)
- [x] configure-secrets: preserve existing key-material secrets when asked; tests
- [x] Engine: no `BOOTSTRAP_OWNER_EMAIL`, no owner-handoff in adoption
- [x] Builder: accept and validate adoption job fields; pass passphrase as before
- [x] Maintenance: adoption manifest, "Take over" action and panel text; updates keep adoption
- [x] Installer: detect an existing SAM in preview; adoption plan + passphrase input; credentials
      scoped to existing buckets
- [x] Tests: vertical slice through installer preview → provision → maintenance → builder config
      → engine (fake runner) for adoption, plus refusal cases
- [x] Docs: installer guide section "Move an existing SAM to the installer"; self-hosting guide
      pointer; security architecture notes (passphrase custody, preserved keys)
- [ ] Proof on the agreed target (see Open decision); record evidence

## Acceptance criteria

- [x] An adoption whose preview shows any create, replace or delete stops before `pulumi up`, and
      the owner sees which resources
- [x] A missing state bucket or stack stops the adoption without creating either
- [x] Existing `ENCRYPTION_KEY`/JWT/signing/VAPID Worker secrets are unchanged after adoption and
      after a later update
- [x] Deployed override vars are unchanged after adoption
- [x] Existing users can still sign in after adoption (no owner-email lockout) — unit-covered; live proof pending
- [ ] A real existing deployment is adopted, then updated, through the installation service

## Open decision (Raphaël)

Proof target, because staging2 shares staging's state and passphrase (finding 10):
- a disposable test deployment on a spare apex domain, created once the old way then adopted
  (cleanest; needs a spare zone and a deploy token), or
- staging (primary) directly, accepting that its service holds a passphrase that also opens
  staging2's stack, or
- separate staging2 into its own state first (a Pulumi state move that handles the passphrase).

## References

- Idea 01M88S2Z10WS855DM0937QVCY2; idea 01M84SB68PWK40K6HNB0KX5HRX; PR #2993
- Rules 31, 42, 62, 70, 73, 83; `.claude/rules/19-external-service-integration.md`

## Implementation notes (2026-11-25)

- Rollback guard added (not in the original design): the takeover refuses when the deployed D1
  database has migrations the approved source lacks (`migrationsNewerThanSource`). SAM's own
  staging/production run `main`, which is usually ahead of the latest release.
- Fork deployments record no deployed commit, so a takeover deploys the installer's approved source
  rather than "the same version"; the rollback guard plus the preview gate keep that safe.
- New protocol capability `adoption`: builder and maintenance refuse an adoption job whose source
  does not declare it (an older engine would drop the settings and install a second SAM).
- Takeover confirmation is never pre-checked (friction at the decision point, per policy).
- Vertical slice split by boundary: installer session → upload (`tests/adoption-session.test.ts`),
  maintenance → builder job (`maintenance-jobs.test.ts`), builder → engine config
  (`builder.test.ts`), engine phases (`installer-engine.test.ts`), configure-secrets harness.
  Every engine guard verified discriminating by deletion.

## Review fixes (2026-11-25)

- Validator HIGH: adoption would delete `AGENT_SIGN_IN_TRUST` (configure-secrets deletes it when
  unset) → engine sets `AGENT_SIGN_IN_TRUST_KEEP_WHEN_UNSET=true` for adoption; tested + proven red.
- Security: `pulumi refresh --yes` ran before the gate → gate now uses `pulumi preview --refresh
  --json` before the refresh; refused takeover asserts no refresh ran.
- Security: key pairs preserved together (JWT, VAPID, deploy signing).
- Security: deployed vars equal to the source's `[vars]`/code default are not carried (would pin
  old defaults).
- Security: installer session drops the passphrase at handoff; page copy and docs say it passes
  through the installer.
- Security: refusal lines capped at 300 chars.
- Not changed (security finding 5): adoption replaces the Worker's `R2_*`/`CF_API_TOKEN` with the
  installation's own scoped credentials, exactly as a fresh install does; the fork's deploy R2 key
  already had state-bucket access, so this is not wider than before.
- Validator MEDIUM: optional takeover inputs were wrongly marked `required` (a second occurrence
  of the field list) → fixed; browser audit `full-adopt` scenario asserts they are optional and
  that the browser sends `adopt` + passphrase.
- SonarQube: fixed S7744 (empty object spread) and S3776 (engine complexity; takeover steps now
  `refuseRollback`, `refuseResourceChanges`, `keepAdoptedDeployment` in the adoption module) in
  f3f23adb0. S9382 (sequential `pulumi config set` in a loop) is in moved code and intentional.
