# Fix GCP OIDC Remaining HIGH-Priority Issues

## Problem

Three remaining HIGH-priority issues from the Google OIDC security review were never dispatched due to a 5-task limit. These address: hardcoded scopes violating Constitution Principle XI, GCP settings discoverability from the project SettingsDrawer, and zero GCP setup documentation.

## Research Findings

### Issue 1: Hardcoded GCP Scopes

- `apps/api/src/services/gcp-sts.ts:77` — STS exchange hardcodes `scope: 'https://www.googleapis.com/auth/cloud-platform'`
- `apps/api/src/services/gcp-sts.ts:105` — SA impersonation hardcodes `scope: ['https://www.googleapis.com/auth/compute']`
- Constitution Principle XI requires all such values be configurable via env vars with sensible defaults
- Pattern already established: `GCP_TOKEN_CACHE_TTL_SECONDS`, `GCP_API_TIMEOUT_MS` etc. use `env.X || DEFAULT_X` pattern
- Need two new constants in `packages/shared/src/constants.ts` and two new Env entries in `apps/api/src/index.ts`

### Issue 2: SettingsDrawer Cloud Provider Access

- `apps/web/src/components/project/SettingsDrawer.tsx` — has VM size, workspace profile, default provider selection, runtime config, deployment settings, and project view links
- GCP credential configuration is ONLY on global Settings page (`SettingsCloudProvider.tsx`)
- The drawer already has a "Project Views" section with navigation links (line 620-653)
- Best approach: Add a "Cloud Providers" link in the Project Views section navigating to `/settings/cloud-providers`
- The drawer already imports `useNavigate` and has the pattern for navigation links

### Issue 3: Zero GCP Documentation

- `docs/guides/self-hosting.md` has a brief section (lines 101-119) mentioning `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and GCP deploy vars
- `docs/architecture/secrets-taxonomy.md` lists GCP deploy vars in "Optional Runtime Configuration" (lines 75-80) but no user-facing setup guide
- `GcpCredentialForm.tsx` line 322-323 has excellent inline UX copy about OIDC federation
- Need comprehensive `docs/guides/gcp-setup.md` covering: Google Console OAuth setup, WIF pool explanation, SA permissions, redirect URI, troubleshooting

### Existing Patterns

- Constants: `packages/shared/src/constants.ts` has `DEFAULT_GCP_*` pattern (lines 307-370)
- Env: `apps/api/src/index.ts` has GCP env vars (lines 308-328)
- SettingsDrawer nav links: lines 631-651 show the existing link pattern
- Self-hosting GCP section: `docs/guides/self-hosting.md` lines 101-119

## Implementation Checklist

- [ ] 1. Add `DEFAULT_GCP_STS_SCOPE` and `DEFAULT_GCP_SA_IMPERSONATION_SCOPES` constants to `packages/shared/src/constants.ts`
- [ ] 2. Add `GCP_STS_SCOPE` and `GCP_SA_IMPERSONATION_SCOPES` to Env interface in `apps/api/src/index.ts`
- [ ] 3. Update `apps/api/src/services/gcp-sts.ts` to read scopes from env with defaults
- [ ] 4. Add "Cloud Providers" navigation link to SettingsDrawer's "Project Views" section
- [ ] 5. Create comprehensive `docs/guides/gcp-setup.md` — Google OIDC setup guide
- [ ] 6. Update `docs/architecture/secrets-taxonomy.md` — add GCP scope env vars and link to setup guide
- [ ] 7. Update `docs/guides/self-hosting.md` — add link to GCP setup guide, add new scope env vars
- [ ] 8. Add unit test for configurable scopes in gcp-sts
- [ ] 9. Run lint, typecheck, test, build

## Acceptance Criteria

- [ ] GCP STS scope is configurable via `GCP_STS_SCOPE` env var, defaults to `https://www.googleapis.com/auth/cloud-platform`
- [ ] GCP SA impersonation scopes configurable via `GCP_SA_IMPERSONATION_SCOPES` (comma-separated), defaults to `https://www.googleapis.com/auth/compute`
- [ ] SettingsDrawer has a link to cloud provider settings accessible from within project context
- [ ] Comprehensive GCP setup guide exists at `docs/guides/gcp-setup.md`
- [ ] `secrets-taxonomy.md` and `self-hosting.md` updated with new env vars and link to GCP guide
- [ ] Unit tests verify scope configurability
