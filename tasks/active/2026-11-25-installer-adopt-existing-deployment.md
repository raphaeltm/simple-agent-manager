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

## Review fixes, round 2 (2026-11-25, Codex review of 7e6d18fea)

- P2 "Disambiguate prefixes from stack names": `sam-api-blue-api-prod` reads as prefix `sam` +
  stack `blue-api-prod` or prefix `sam-api-blue` + stack `prod`, and the old pattern always took
  the last `-api-`. `findDeployment` (`apps/installer/src/adoption-plan.ts`) now tries every
  reading and keeps the one whose assets bucket `<prefix>-<stack>-assets` exists
  (`infra/resources/storage.ts`). No reading or more than one is a conflict.
- P2 "Accept configured deploy-state bucket names": a fork that set `PULUMI_STATE_BUCKET` keeps
  its state under any valid bucket name. The takeover form has an optional "Its deploy-state
  bucket" field; a named bucket is validated before it reaches a request path, never falls back to
  the conventional names, and is checked again when install re-reviews the plan (`planAgain`).
  Builder, maintenance and engine already accepted any valid bucket name.
- Consequence recorded in the docs: a named bucket shared with another deployment gives the
  service that deployment's state too. That was already true for two environments of one prefix,
  which share `<prefix>-pulumi-state` by convention. The security notes no longer claim a service
  can never hold another installation's state.
- Guards verified discriminating by deletion: assets discriminator, ambiguity conflict, no
  fallback for a named bucket, name validation (plan and session), named bucket forwarded and
  re-checked at install, browser sends the bucket (audit run against a rebuilt static site).
- Browser audit: new `full-adopt-form` scenario (takeover block open, 63-character bucket name, an
  in-card clipping check); 150 screenshots, no overflow.
- SonarQube, redone after the first attempt was lost with its workspace: S3776 in
  `installer-engine.ts` (`startingCheckpoint`) and `browser-audit.ts` (`fillTakeover`,
  `auditFullAdopt`), S3358/S6653 in `carryDeployedVars`, S7737 in `browser-audit-routes.ts`.
- `deploy` check (staging installer deploy) fails only at its health poll from GitHub's runners,
  which Cloudflare blocks; the installer answers 200 with the pushed commit from elsewhere.

## Security review, round 2 (2026-11-25, of 7e6d18fea..6adc28fd5)

No CRITICAL or HIGH. Fixed:
- LOW: a Worker literally named `<prefix>-api-production` read as the `prod` stack's deployment;
  a reading must now name the Worker the engine would deploy (`deploymentReadings`).
- LOW: bucket names with dots passed review and failed late at credential minting; `BUCKET_NAME`
  now matches `installationCredentialBuckets`.
- LOW: install re-review pinned the bucket found at review, so a second conventional bucket
  appearing in between went unnoticed. The session remembers only a bucket the owner named
  (`adoptionStateBucket`), and two conventional buckets are now a conflict that naming one resolves.
- MEDIUM-to-LOW: the review screen now says the service gets access to the whole state bucket.
- Guards verified discriminating by deletion; tests added for each, including a named bucket
  that disappears between review and install.

## Review fixes, round 3 (2026-11-25, Codex reviews of 6adc28fd5 and 6cbd3d882)

Evidence first: production deploy run 45661601817 (a routine deploy) reports `pulumi up` as
"~ 1 updated, 23 unchanged", and its refresh names `cloudflare:index/pagesProject:PagesProject`
as the resource updated in place. The provider rewrites the Pages project on every deploy.

- P1 "Reject in-place updates during takeover": refusing every `update` would therefore refuse
  every takeover. The gate now allows `update` only for the Pages project type and refuses an
  in-place update of anything else (`TAKEOVER_UPDATABLE_TYPES`, `refusedTakeoverSteps`).
- P2 "Bind the takeover update to the approved preview": the gate runs a second time against the
  refreshed state, immediately before `pulumi up`. Not atomic: `pulumi up --expect-no-changes`
  checks only after applying (Pulumi CLI docs), and `--plan` is marked experimental. The docs say
  the gap is narrowed, not closed.
- P1 "Verify source ancestry before declaring rollback safety": the takeover deploys the source
  the owner reviewed and approved by commit, so replacing newer code is the approved outcome, not
  damage; damage is older code on a newer schema, which `refuseRollback` (D1) and the Durable
  Object migration-tag check in `sync-wrangler-config.ts` refuse. The fault was the promise ("if
  the approved source is older than your SAM"). Panel, installer and docs now say the check is on
  the database and that the approved source is deployed over the existing code. The builder has
  no git history (publisher archive), so commit ordering cannot be computed locally. Not done:
  showing the deployed commit next to the approved one at review (fork deploys do record it, as
  the Worker version message `commit:<sha>`).
- P2 "Defer adopted stack writes until takeover gates pass": nothing remote is written before
  the gates. `pulumi config set` writes the job's local `infra/Pulumi.<stack>.yaml`, and for the
  installation profile `configureWorkersDev` only reads (its creating request is reachable for
  `legacy-ci` alone). A test now asserts a refused takeover sent no write to Cloudflare.
- P2 "Normalize the dev stack": a `development` environment uses the `development` stack
  (`stackNameForEnvironment`); a stack literally named `dev` gets a Wrangler environment named
  `development` while deploys pass `--env dev`, so it cannot be published. The review now refuses
  it instead of failing after the infrastructure phase.
- Browser audit gained a takeover-panel scenario (real service code, longest names, in-card
  clipping check), replacing the one-off render script lost with the first workspace.

## Review fixes, round 4 (2026-11-25, Codex review of f97f0fe1a)

- P1 "Include observability D1 in rollback checks": `refuseRollback` now reads both migration
  ledgers (`MIGRATION_LEDGERS`: `d1DatabaseId` with `src/db/migrations`, and
  `observabilityD1DatabaseId` with `src/db/migrations/observability`). A stack with no
  observability output (older than that database) is checked on the primary ledger only; the
  preview gate refuses creating the missing database.
- P2 "Honor known D1 migration aliases": the alias table moved from `d1-migration-safety.ts` to
  `d1-migration-aliases.ts` and both use it; a ledger entry under a legacy name counts as the
  current file when the source carries that file.
- Guards verified discriminating by deletion (primary-only, aliases ignored, legacy name always
  accepted, missing optional output an error).

## Review fixes, round 5 (2026-11-25, Codex review of 1e867fdeb)

- P2 "Accept existing short Pulumi passphrases": fixed. The takeover accepted only passphrases
  of 8 or more characters, but the fork workflow requires only a non-empty one and a takeover
  cannot strengthen an encrypted stack. Any non-empty passphrase up to 1024 characters is accepted.
- P2 "Accept dotted deploy-state bucket names": not changed. R2 bucket names allow only lowercase
  letters, digits and hyphens (Cloudflare R2 "Create buckets" documentation), so a dotted state
  bucket cannot exist; the fork workflow's looser pattern is an S3-style check that R2 itself
  narrows. The credential check, which predates this work, already refuses dots.

## Review fixes, round 6 (2026-11-25, Codex review of 3b71ef6ee)

- P2 "Preserve the adopted D1 replication mode": an adopted installation no longer runs
  `configure-d1-read-replication.sh`, on the takeover or on later updates, so both databases keep
  the mode they have. Its default (`auto`) would have changed a deployment whose owner set
  `D1_READ_REPLICATION_MODE=disabled` in a GitHub Environment the job cannot see.
- Audit of the same phase for other settings applied from defaults outside the Pulumi gate:
  `configure-r2-cors.sh` (derived from the domain and bucket, no owner choice);
  `configure-ai-gateway.sh` (ensures the gateway named after the prefix exists, which is the id
  `sync-wrangler-config.ts` gives the Worker on every path); agent email (the fork workflow also
  deploys with `AGENT_EMAIL_ENABLED: 'true'`, and the takeover review shows the email row). None
  changed.

## 2026-11-26

- All twelve Codex review threads resolved after verifying each fix in f7d87a446.
- Wording: Raphaël's direction of 2026-11-26 is that there is no "hosted SAM"; installs are
  self-hosted Cloudflare or self-hosted VM, and his own instance is self-hosted Cloudflare. The PR
  description and the inbox question were reworded. The branch had not used "hosted".
- Docs: the takeover guide now tells the owner to disable the fork's deploy workflows once the
  takeover has finished, because a later run would deploy the fork's code and settings over the SAM.
- Out of scope here: moving installation keys out of Pulumi state and CI (task
  01M8C74NYMDP2YYPAG17VXJB78, designed on sam/self-hosted-cloudflare-installs-vxjb78). Agreed with
  that task: it stacks on this branch; its key-resource retirement must run only after both takeover
  gates pass, because retiring them before a refused takeover would let the fork's old workflow
  generate new keys over the Worker's.
- Found through the keys task's local Pulumi tests: `pulumi preview --json` prints resource state,
  where a RandomId's `id` is a raw key, and it exits non-zero when it cannot delete a protected
  resource. The engine reports the last output lines of a failed command to the owner, scrubbing
  only environment-held secrets, so a failed takeover preview could have shown a key. Both takeover
  previews now run with `privateOutput`, and `refuseResourceChanges` replaces any failure of the
  preview with a fixed message. Two tests, each proven by removing one layer.
- Codex round 8 (on 1aa4843b9), P2 "Track adopted Worker overrides instead of inferring them":
  valid, NOT fixed here. A default changed by a later release makes the previously written value
  look like an override, and it stays pinned. A fix needs a durable record of override names whose
  home is a design choice (Worker var, service manifest, or state bucket). Tracked as idea
  01M8C88CXH9YTBZ4X3TDN1GP7J, cited in the code; the guide's claim was corrected.
- Also from the keys task's local Pulumi run: on a SUCCESSFUL `preview --refresh --json` the refresh
  step of a key resource carries the raw key (old and new state `id`, and its outputs). So while
  keys are still in Pulumi state, every takeover check brings them into the engine process's
  memory, in the owner's own builder container. They are never reported, saved or passed on: the
  takeover test's preview fixture now has that real shape with a canary key, and asserts the canary
  reaches no event, result, command argument or command environment (proven by leaking it into the
  environment once). The keys task removes the exposure by excluding the key resources from the
  previews.

## Review fixes, round 9 (2026-11-26, Codex review of 52e839dc6)

The two findings are members of one class: a setting the fork's owner made in the GitHub
Environment, which a takeover cannot see. Mapped it: the fork workflow passes about 555 variables;
512 are Worker var overrides (carried from the deployed Worker). Of the rest, most only tune the
deploy itself. The ones that change a deployment:

- P2 "Restrict the Pages update exception to provider-only drift": fixed. The exception was by
  resource type. It now requires the step's detailed diff to name only `canonicalDeployment` and
  `latestDeployment`, the two properties production deploy run 45661601817 shows differing; any
  other property (such as `productionBranch`) or a missing diff is refused, and refusals name the
  changed properties (names only).
- P2 "Preserve container deployment overrides during takeover": partly fixed.
  `DEPLOY_BUILDER_MAX_INSTANCES` is read back from the Worker var sync derives from it
  (`DEPLOY_BUILDER_CLASS_MAX_INSTANCES`), and `PREVIEW_BASE_DOMAIN` / `PREVIEW_URL_TTL_SECONDS`
  are now carried too (`READABLE_SYNC_SETTINGS`). NOT recoverable: the sandbox and VM-agent
  container limits and the builder instance type reach only the container configuration. The
  Cloudflare API reference lists `max_instances` and `configuration.instance_type` for scheduled
  container applications and says they do not apply to Durable Object applications, which is what
  SAM's are, so I did not build recovery on it. The web app's `VITE_*` build variables and an
  explicit `ARTIFACTS_BINDING_ENABLED` are in the same position.
- Because those are reset silently, the takeover panel and the guide now say so at the decision
  point. The real fix is for the owner to hand the service the fork's GitHub Environment variables
  (non-secret by definition): idea 01M8C88CXH9YTBZ4X3TDN1GP7J, to be decided by Raphaël.

## Review fixes, round 10 (2026-11-26, Codex review of 8327c79ea)

- SonarCloud failed its gate on b27ab319f for a sort without a compare function in the code added
  in round 9; fixed in 8327c79ea together with two complexity findings (no behaviour change).
- P2 "Preserve SETUP_FORCE during adoption": not carried, by decision. `SETUP_FORCE=true` reopens
  the setup page for lockout recovery, the surface used in the 2026-11-12 setup takeover. Carrying
  it would keep an emergency switch on for good; dropping it silently could close setup under
  someone mid-recovery. The takeover now refuses in `adoption-preflight` while it is on
  (`refuseForcedSetup`), before reading the database ledgers or running any Pulumi command.

## Review fixes, round 11 (2026-11-26, Codex review of d2f1c0412)

- P2 "Preserve setup access for incomplete deployments": a deployment whose first-run setup was
  never finished has no administrator, and its setup page is open behind a token the takeover
  regenerates and does not hand over, while the service says there is nothing to set up. The
  takeover now refuses it in `adoption-preflight` (`refuseWithoutOwner`: no active superadmin
  other than the system row, the same test `isSetupCompleted` uses), which also keeps the install
  policy that an instance is bound to an owner.

## Attacker review (2026-11-26, after "make sure there's no way this could be used by a malicious actor for a takeover")

Third security-auditor pass, adversarial, questions A–I over `apps/installer/src` and the service; the deploy-engine side of "who gains access" and "posture weakened" was checked separately. Result: 0 CRITICAL, 0 HIGH, 2 MEDIUM, 4 LOW, 4 INFO. No route was found for anyone without Cloudflare authority over the account and zone to plan, approve or run a takeover, claim a service, or gain access to the SAM application.

Engine-side findings (read from code, then pinned):

- `BOOTSTRAP_OWNER_EMAIL=''` on an adopted deploy is skipped by `set_worker_secret`, never deleted; the same holds for every sign-in secret the engine does not have. Pinned by `worker secret configuration leaves ownership and sign-in secrets alone on an adopted installation` (`scripts/quality/deployment-workflow-hardening.test.ts`). Mutation: making an empty optional secret queue a deletion turns it red.
- Setup stays closed: the preflight requires an active superadmin (`refuseWithoutOwner`, same predicate as `isSetupCompleted`) and refuses `SETUP_FORCE=true`; the regenerated `SETUP_TOKEN` is handed to nobody.
- `REQUIRE_APPROVAL` is on the override list, so an explicit value is carried and an absent one means approval stays on.

Wrong passphrase (auditor LOW-1), measured offline on Pulumi 3.278 with a file backend and no local `encryptionsalt` (the engine's situation):

- `pulumi stack output --json`, `stack ls`, `stack select`, `config set`, `stack export`, `stack history` all succeed with a wrong passphrase.
- `pulumi stack`, `preview`, `preview --refresh`, `refresh`, `up` all fail with `incorrect passphrase`, and the state files are byte-identical afterwards.
- So a wrong passphrase could never change a deployment, but it surfaced only at gate 1 as "the infrastructure preview failed", and the docs' "stops at its first step" was not true.
- Fix: `refuseUnopenableState` runs bare `pulumi stack` (output private and discarded) as the first step of `adoption-preflight`. Tests: `refuses a takeover whose passphrase does not open the deploy state, before anything else` and `opens the deploy state once on a takeover, privately, before reading the deployment`. Mutations: call removed (both red), failure passed through (first red), output not private (second red).

Addressed in docs and page copy: enter the passphrase only at an installer you trust (MEDIUM-1), retire the fork's Cloudflare token, R2 key and GitHub Environment secrets after a takeover (MEDIUM-2), the administrator email is not used to change administrators (INFO-3).

Deferred, with reasons, to idea 01M8CDVGG5CT46TERWD3HJP9PP: taking the passphrase at the service instead of the installer (design change to the handoff), scoping the deployment token to one deployment (applies to every installation, not only takeovers), route-steering consistency check (the no-change gate and the owner's review already stop it), global recovery rate limit and short-secret redaction (existing service behaviour, not introduced here).

## Codex round 12 (on 2353f1725): email provisioning outside the takeover gates

Finding: `configure-services` ran `prepareInstallationEmail()` for adopted deploys, which can onboard `agents.<domain>` for sending and create its DNS records after both no-change gates passed. Valid.

Fix: an adopted deploy (takeover and every later update) prepares email only when the deployed API Worker already has the `AGENT_EMAIL` binding (`deployedAgentEmail`), and then with `AGENT_EMAIL_EXISTING_ONLY=true`, a new mode of `configure-agent-email.ts` that uses the sending subdomain only if it exists and writes nothing. Without the binding the step is skipped and a stale marker is removed, so sync does not add the binding. Known limit, noted next to the guard and on idea 01M8C88CXH9YTBZ4X3TDN1GP7J: an adopted installation without email cannot get it from the service yet.

Mutations: adoption prepares email like a new install (red: `sets up no email on a takeover of a deployment that has none`, `keeps the email an adopted deployment has, from what exists only`); flag dropped (second red); stale marker kept (first red); binding never seen (second red); script ignores `existingOnly` (red: both `with existingOnly` tests in `scripts/quality/deploy-agent-email.test.ts`).

Other writes of the same phase were read and left as they are, and are now documented under "What the deploy itself applies": the assets bucket's upload CORS rule, the AI Gateway when the account lacks it, the tail Worker. Each is configuration the approved source needs and a fork's deploy applies the same.

## Codex round 13 (on 477691c21): the review promised email on a takeover

Finding: the installer's review listed an Email row for every plan ("Sign-in codes come from agents.<domain>. Its sending records are added…"), which a takeover no longer does. Valid.

Fix: for an adoption plan the row reads "Stays as it is. If your SAM sends sign-in codes from agents.<domain>, it keeps doing so. If it does not, the takeover does not set that up." (`renderCreatedDetails`, `apps/installer/public/installer/plan.js`). The installer does not read the deployed Worker's bindings at review time, so it states both outcomes instead of guessing one. The browser audit asserts the takeover wording in `full-adopt` and the original wording in `full-review`. Mutation: old wording served for adoption plans, `full-adopt` red on the expected substring; a first attempt on a second port was invalid because the installer answers only on its configured address.

## Codex round 14 (on d9165880c): the approval promised "changes nothing else"

Finding: the consent line and the service's takeover panel said the takeover checks that nothing else changes, while the deploy applies the assets bucket's upload CORS rule and creates the AI Gateway when the account has none, outside the Pulumi gates. Valid: the guide already listed them, the approval text did not.

Fix (wording only; behaviour unchanged, both are configuration the approved source needs and a fork deploy applies the same): the consent line says the takeover is approved "after it checks that deploying SAM creates, replaces or deletes none of its resources"; the panel says what is checked and names the two settings the deploy also applies; the guide's lead sentence matches. Browser audit: clean run 156 screenshots, no overflow; panel sentence removed, `auditTakeoverPanel` red; consent line reverted, `full-adopt` red.

## Merge of main with the installation-keys change (#3019), 2026-11-27

#3019 landed on main first, so this branch took the conflicts (`installer-engine.ts`, `installer-engine.test.ts`). Resolution, using the keys owner's own reconciliation from the stacked draft #3018 for the overlapping files:

- `applyInfrastructure` (`installer-engine-keys.ts`) runs the two takeover gates around the refresh, both with `previewExcludeArgs`: key resources an older release left in the state, and the retirement marker this release adds, exist only in the state and are left out of the check. Key retirement runs after the second gate, last before `pulumi up`.
- An adopted installation is never treated as new: `freshInstallation: !c.adoption`, so `ensureInstallationKeys` fails on a missing key instead of generating one. The inherited test for this failed at `state-backend` and never reached the key step; it is replaced by `never creates installation keys for an adopted installation, even with none and an empty database`, which goes red when the flag is forced to `true` and has a new-installation control.
- `PRESERVED_KEY_SECRETS` shrinks to `VAPID_SUBJECT`: no deploy writes installation keys any more, so the key-pair logic is gone.
- Mutations on the merged code: gates without excludes (red: `migrates a stack that still has the key resources…`), takeover gates skipped (11 tests red).

Staging: the ordinary deploy of this branch was tried on staging2 at 11:28Z before this merge and failed at `Pulumi Up` on the protected `installation-keys-retired` marker, as any branch without the keys change now does. It re-created six key resources in the staging2 state and deployed nothing; the keys owner's retire step removes them.

## Codex round 15 (on 3dbc3f6da): derived state-bucket names R2 cannot hold

Finding: with a long prefix and environment the installer-style candidate `<prefix>-pulumi-state-<environment>` can exceed R2's 63 characters; R2 answers such a lookup with an error, not a 404, so the preview failed instead of finding the fork-style bucket. Valid.

Fix: `existingBuckets` (`apps/installer/src/adoption-plan.ts`) skips a name `BUCKET_NAME` rejects, since it cannot exist; this also covers the assets-bucket probes of `findDeployment`. The test fake now refuses impossible names with a 400 as R2 does, and the name-length test uses the longest names R2 actually allows (the old one modelled a 111-character assets bucket). Mutation: filter removed, `takes over a deployment with the longest names R2 allows, never probing a name it would refuse` red.

## Codex round 16 (on 2db3531ca): legacy setting secrets deleted on a takeover

Finding: every deploy deletes the `STALE_SECRETS` (`configure-secrets.sh`), among them `AI_PROXY_ENABLED` and `AI_PROXY_DEFAULT_MODEL`, which older releases kept as Worker secrets before they became vars. A deployment that still holds one runs on a value the takeover cannot read; deleting it would swap that value for the source's default, outside the gates. Valid.

Fix: `refuseShadowedSettings` (`installer-engine-adoption.ts`) refuses the takeover in `adoption-preflight` while the Worker holds either name, and tells the owner to update once the old way first (a fork deploy sets the var from its own settings). The two retired trial secrets shadow nothing and do not stop a takeover. Test: `refuses a takeover of a deployment that keeps a setting only as a legacy secret` (refusal text, no later step, parity with the script's `STALE_SECRETS`, retired-secret control). Mutation: call removed, test red.

## Codex round 17 (on 181532b57): the completion panel claimed every setting survived

Finding: "Takeover complete … Its data, keys, settings and users are as they were" is false when the old deployment set container limits or web app build settings in GitHub, which a takeover resets. Valid; the review row said the same.

Fix (wording): the completion panel confirms data, keys and users, says settings were kept and names the two kinds that are now SAM defaults; the review's "Takes over" row says the same. `maintenance-jobs.test.ts` pins the panel text, and the browser audit gained a `maintenance-takeover-complete` state with long names (162 screenshots, no overflow).

## Raphaël's decisions, 2026-11-27

- 11:25Z, on the settings-handover question: "Merge this. We only have one other real user, I think. We can manually help him move if necessary." The handover is built after the merge.
- 12:38Z, on "merge without ever running a real takeover, or test one first?": "1", merge without a live takeover run. The first real takeover is done later with someone watching. The ordinary staging deploy of this branch is still required before merge.
