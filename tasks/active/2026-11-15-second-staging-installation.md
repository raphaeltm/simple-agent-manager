# Second staging installation on sammy2.party

SAM task `01M7G6BRCTJKDPNDX8PTFFF8XD`, coordinator `01M7FXB4800VH9YT1ZZDC2QZ2N`, channel
`feature.ship-faster`. Plan and evidence: idea `01M7FYGMEESYH3AJZJ0CT3NKCZ` (note "Follow-up
findings"). Branch `sam/stand-second-staging-installation-fff8xd`.

## Problem

One shared staging (`sammy.party`) is about a third of agent task time: agents queue for the
single slot. Raphaël bought `sammy2.party` (zone active in the staging Cloudflare account,
verified 2026-11-15 18:13Z) for a second installation so two agents can test live at once.

## Design decision record

**Installation vs credential environment.** A GitHub Environment supplies credentials; an
installation is what gets deployed (domain, zone, Pulumi stack, resource prefix). Today they are
the same name. The second installation `staging2` reuses every secret of the `staging` GitHub
Environment (same Cloudflare account, same trust level) and differs only in target. Job
`environment:` stays `staging`; the installation identity comes from a checked-in allowlist,
`scripts/deploy/staging-installations.mjs`. No new GitHub Environment, no copied secrets.

Rejected: a `staging2` GitHub Environment. Environment secrets are not inherited, so Raphaël
would have to copy seven secrets by hand, which the brief forbids.

**Allowlist, fail closed.** `resolveInstallation()` accepts the installation equal to the
credential environment (primary, identity from Environment variables) or a registry entry whose
`credentialEnvironment` equals the job's environment. It refuses: the `production` environment
for any secondary installation, names/stacks containing `prod`, a secondary whose domain, prefix
or stack equals the primary's, and anything not in the registry. Production is additionally out
of reach because `staging` holds only the staging Cloudflare account's token (production is a
different account) and the `production` Environment only deploys from `main`.

**Identity of `staging2`.** Domain `sammy2.party`, prefix `sam2`, stack `staging2`. Zone ID is
looked up from the domain with the deploy token (no new secret). Pulumi state lives in the
primary's state bucket (`sam-pulumi-state`) under its own stack: the R2 credentials are
scoped to that bucket, and a distinct stack name keeps state separate.

**Account-level collisions** (idea note list):

| Item                                                         | Primary                                    | staging2                      | Outcome                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers, D1, KV, R2, Pages                                   | `sam-*-staging`                            | `sam2-*-staging2`             | distinct                                                                                                                                                                                                                           |
| AI Gateway                                                   | `sam`                                      | `sam2`                        | distinct (prefix)                                                                                                                                                                                                                  |
| Analytics dataset                                            | `sam_analytics`                            | `sam2_analytics`              | distinct (prefix)                                                                                                                                                                                                                  |
| Pulumi state                                                 | bucket `sam-pulumi-state`, stack `staging` | same bucket, stack `staging2` | distinct stack                                                                                                                                                                                                                     |
| workers.dev subdomain                                        | account-wide (`sam`)                       | must reuse it                 | the deploy's "Ensure workers.dev Subdomain" PUTs the prefix; for a secondary it must only read the account subdomain, or it could rename the subdomain staging depends on. Pulumi `workersDevSubdomain` is set from the read value |
| Devcontainer cache prefix `sam-`                             | shared                                     | shared                        | accepted: keyed by GitHub owner/repo, identical content; staging2 test projects are Artifacts-backed and never use it                                                                                                              |
| GitHub App / OAuth / Google login                            | bound to `sammy.party` callbacks           | not passed                    | staging2 has no GitHub App; Artifacts projects need none                                                                                                                                                                           |
| Deploy signing, JWT, VAPID, BetterAuth, encryption overrides | Environment secrets if set                 | not passed                    | Pulumi generates per-stack keys                                                                                                                                                                                                    |

**Bootstrap** (`scripts/deploy/bootstrap-staging-installation.ts`, runs for secondary
installations only, idempotent):

1. Upsert two users with fixed IDs `<installation>-agent-admin` (superadmin) and
   `<installation>-agent-user` (user), both active. An active superadmin also closes `/setup`.
2. Copy one cloud credential from the primary installation as the platform cloud credential:
   preference platform GCP, then a user GCP service-account-key credential, then platform
   Hetzner. Decrypt with the primary's key, re-encrypt with the target's key, write one
   bootstrap-owned row (fixed ID). Values never printed.
3. Register the staging smoke token (`SMOKE_TEST_TOKEN`, already a staging secret) for the
   admin user, so the deploy's smoke tests run against staging2 too.
4. Agent sign-in trust: derived from the primary's `AGENT_SIGN_IN_TRUST` (same issuer and
   allowed sources), with `allowedTargets` replaced by the two bootstrap users.

**Lease.** Task C's lease keys on the installation name; `deploy-staging.yml` input
`environment` becomes the installation (`staging` | `staging2`), and jobs use the resolved
credential environment.

## Checklist

- [x] Registry + resolver (`staging-installations.mjs`) with fail-closed validation and tests
- [x] `workflow-resource-names.mjs` resolves installations; tests
- [x] Bootstrap script + trust derivation; tests on a real SQL engine
- [x] `teardown.yml`: `staging2` option destroys only that installation
- [x] `deploy-reusable.yml`: `installation` input, overrides, workers.dev read-only, bootstrap step (after task A merges or by agreement)
- [x] `deploy-staging.yml`: installation choice, credential environment for jobs (after task C merges)
- [ ] Docs: staging verification rule + full reference, /do steps, self-hosting/deploy docs
- [ ] Live: deploy main to staging2, agent sign-in, VM session, Instant session on Artifacts project
- [ ] Live: isolation both directions (version + data unchanged on the other installation)
- [ ] Live: teardown staging2, redeploy from nothing, bootstrap re-runs; VMs cleaned up
- [ ] Idea note with deploy/sign-in/teardown instructions and remaining owner actions

## Acceptance criteria

- Deploying a branch to staging2 leaves staging's deployed Worker version and data untouched, and the reverse.
- Agents sign in to staging2 by workload identity with no stored token.
- Production cannot be targeted: resolver tests refuse production in every form.
- `teardown.yml` with `staging2` touches no `sam-*-staging` resource.
