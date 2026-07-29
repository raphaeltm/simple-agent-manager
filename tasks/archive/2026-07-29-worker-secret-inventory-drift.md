# Reconcile Worker secret inventory docs

## Problem

The public deployment/self-hosting docs and checked-in Worker secret inventory comments have drifted from the deploy script that actually writes Worker secrets. In particular, `apps/api/wrangler.toml` still listed legacy Origin CA Worker secrets while omitting newer deployment signing and optional fallback secrets.

## Research findings

- Public operator docs live under `apps/www/src/content/docs/docs/`; non-public Markdown should not be used as user-facing documentation.
- `scripts/deploy/configure-secrets.sh` is the operational source for Worker secrets written during deployment.
- `scripts/deploy/types.ts` declares required and optional deploy secret categories but is not itself a complete list of every optional Worker secret written by the shell script.
- `apps/api/wrangler.toml` contains the visible checked-in Worker secret inventory comment.
- `scripts/quality/check-wrangler-bindings.ts` already runs in CI via `pnpm quality:wrangler-bindings`, making it the lowest-risk place to add an inventory drift check.
- New VM nodes use per-node CSR/Origin CA issuance and do not require static `ORIGIN_CA_CERT` or `ORIGIN_CA_KEY` Worker secrets.

## Checklist

- [x] Update the `wrangler.toml` Worker secret inventory comment to match configured secrets.
- [x] Update public self-hosting/security docs to clarify generated Worker secrets, optional fallback secrets, and legacy Origin CA cleanup.
- [x] Add a quality check that compares `configure-secrets.sh` `set_worker_secret` calls with the `wrangler.toml` inventory comment.
- [x] Run targeted checks.
- [x] Run doc-sync and env-validator reviews.
- [ ] Open PR and wait for CI without merging.

## Acceptance criteria

- Public docs no longer imply legacy Origin CA Worker secrets are required.
- Checked-in Worker secret inventory cannot drift silently from `configure-secrets.sh`.
- No runtime behavior changes.
- PR is open, CI is green, and remains unmerged.
