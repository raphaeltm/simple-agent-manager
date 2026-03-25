# GCP Deploy Service Account: Switch to roles/owner

## Problem

The GCP deployment setup in `gcp-deploy-setup.ts` grants 5 granular IAM roles to the deployment service account. Defang (the cloud manager used for project deployment) requires broad GCP access and its official docs specify `roles/owner`. Using granular roles will inevitably cause failures as Defang's required permissions grow.

## Research Findings

- **Source file**: `apps/api/src/services/gcp-deploy-setup.ts` — `DEPLOY_SA_PROJECT_ROLES` array at line 33
- **Test file**: `apps/api/tests/unit/gcp-deploy-setup.test.ts` — tests don't assert on the specific role values, only on the overall orchestration flow
- **Docs**: `docs/guides/gcp-setup.md` — documents VM provisioning roles (compute), NOT deploy roles. The "GCP Deployment Variables" section (line 161) lists config vars but no roles. No doc update needed.
- **No other references**: grep found no other files referencing `DEPLOY_SA_PROJECT_ROLES` or the individual deploy roles

## Implementation Checklist

- [ ] Replace `DEPLOY_SA_PROJECT_ROLES` array with `['roles/owner']` in `gcp-deploy-setup.ts`
- [ ] Update comment to explain why Owner is used (Defang acts as cloud manager; per Defang docs)
- [ ] Verify tests still pass (they don't assert on specific roles)
- [ ] Run lint, typecheck, build

## Acceptance Criteria

- [ ] `DEPLOY_SA_PROJECT_ROLES` contains only `roles/owner`
- [ ] Comment explains rationale (Defang cloud manager, broad access needed)
- [ ] All tests pass
- [ ] Lint and typecheck clean
