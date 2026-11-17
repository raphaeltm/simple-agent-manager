# No secret readback or decryption in GitHub Actions

SAM task: 01M7M4PMFV7ATSA5GJNXGKCXDT (coordinator 01M7JK6W6PRQN64GD2MVMFZKBX).
Binding project policy: 795e72a6-95a8-4135-9e2a-a7f92cc537a3.

## Problem

Raphaël, 2026-11-17: "Make sure we never do anything ever again that even has the slightest
risk of printing secrets in github actions. Better to just have me do some manual work configure
a new environment if necessary, or ask me to give you a secret in here that you can add to github
action secrets."

Two paths put secret values that GitHub does not know about into runner memory:

1. **staging2 bootstrap** (`.github/workflows/deploy-reusable.yml`, "Bootstrap Secondary
   Installation" and "Derive Secondary Agent Sign-In Trust";
   `scripts/deploy/bootstrap-staging-installation.ts`,
   `scripts/deploy/bootstrap-installation-credentials.ts`,
   `scripts/deploy/bootstrap-installation-pool.ts`). It reads the primary and target
   `encryptionKey` with `pulumi stack output --show-secrets`, decrypts staging's
   `platform_credentials` (cloud credential, Claude Code platform key, test accounts' GCP keys),
   re-encrypts and writes them to staging2, HMACs the smoke token with the target key, and derives
   staging2's `AGENT_SIGN_IN_TRUST` from staging's secret.
2. **`scripts/deploy/configure-secrets.sh`** reads six Pulumi-generated keys with
   `--show-secrets` on every deploy, production included, and never masks them.

A scan of 2 production and 3 staging2 deploy logs found no leaked value. The design is rejected
regardless.

## Research findings

- staging2 today (D1 `sam2-staging2`, read 2026-11-17 by ID/type only): platform credentials
  `staging2-bootstrap-cloud` (hetzner) and `staging2-bootstrap-agent-claude-code`; users
  `staging2-agent-admin` (superadmin), `staging2-agent-user`; smoke token row
  `staging2-bootstrap-smoke-token`; agent_settings `sam` for claude-code for both users; Worker
  `sam2-api-staging2` has `AGENT_SIGN_IN_TRUST` and an `AGENT_EMAIL` send binding. These rows stay
  (do not delete without asking Raphaël).
- The smoke-tests job in `deploy-staging.yml` runs against whichever installation was deployed,
  with `SMOKE_TEST_TOKEN`. On a rebuilt staging2 the token would no longer be registered, so the
  job must skip (with a warning) rather than fail when token-login is refused on a secondary
  installation.
- Pool seeding signs in with the smoke token and activates machines for the bootstrap-owned
  credential ID. Without the credential copy and token registration it cannot run on a fresh
  installation; staging2's pool is already seeded. Removed: an admin picks machines in
  Admin → Infrastructure.
- `configure-secrets.sh` deletes the Worker `AGENT_SIGN_IN_TRUST` when the env var is empty. For
  a secondary installation that would switch staging2's agent sign-in off as soon as derive-trust
  is removed, so a secondary installation takes its trust from its own GitHub secret
  (`AGENT_SIGN_IN_TRUST_<INSTALLATION>`, handed straight to the script) and leaves the Worker
  secret untouched when that GitHub secret is unset.
- GitHub masks each line of a multi-line secret it knows; values read from Pulumi are unknown to
  it. A JSON-escaped PEM is one line GitHub cannot match, so masking must cover every line and
  the JSON-escaped form. `::add-mask::` printed outside Actions would print the value, so the
  helper only runs when `GITHUB_ACTIONS=true`.
- Audit of every other workflow and the scripts they call: see "Audit" below.

## Implementation checklist

- [ ] staging2 bootstrap: remove credential decryption/copying, smoke token registration, pool
      seeding, derive-trust, every `--show-secrets` read; keep user seeding (+ claude-code `sam`
      opt-in) with the D1 ID looked up by database name; delete the dead modules and their tests
- [ ] secondary `AGENT_SIGN_IN_TRUST` from `AGENT_SIGN_IN_TRUST_<INSTALLATION>`; untouched when unset
- [ ] smoke tests skip with a warning on a secondary installation whose smoke token is not registered
- [ ] configure-secrets.sh: `::add-mask::` every Pulumi value (each line + JSON form) right after
      the read, plus the derived VAPID private key; comment beside the read naming the tracking task
- [ ] backlog task + idea for removing the Pulumi readback entirely (rule 42)
- [ ] audit findings fixed or tracked
- [ ] `pnpm quality:no-secret-readback` (check + tests, incident reintroduction, controls,
      guard-deletion proof, noise on tree + sampled history), blocking in CI, README entry
- [ ] path-scoped rule for `.github/workflows/**`, `scripts/deploy/**`, `infra/**`; indexes regenerated
- [ ] docs: staging reference "Two Staging Installations", any doc saying staging2 copies credentials
- [ ] ONE inbox item for Raphaël (inbox_write assign) with the manual staging2 steps
- [ ] deploy staging2 and staging from the branch; logs show no `--show-secrets`/decryption except
      the masked, tracked configure-secrets reads; staging2 users exist

## Acceptance criteria

- No workflow step or deploy script reads Pulumi secrets except the masked, tracked legacy reads
  in `configure-secrets.sh`; none decrypts stored credentials.
- `pnpm quality:no-secret-readback` fails on the old staging2 bootstrap pattern and passes on the tree.
- staging2 deploys from the branch and its two users exist.
- Production deploy succeeds after merge.

## Audit

(filled in during implementation)
