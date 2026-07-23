# Pre-existing credential-route hardening (surfaced during Vultr review)

**Filed by:** the Vultr provider PR (`sam/implement-vultr-fourth-cloud-qf96ez`). These are **pre-existing, cross-provider** findings from the Vultr specialist review — NOT regressions introduced by Vultr. Vultr just extended the same (unchanged) code paths, so the reviewers flagged them at the natural moment. Deferred per rule 25 (MEDIUM, pre-existing) to keep the Vultr PR scoped; captured here so they aren't lost.

## Findings to address

### 1. [security MEDIUM] No rate-limiting on cloud-provider credential save/validate routes
`POST /api/credentials` and `POST /api/credentials/validate` (`apps/api/src/routes/credentials.ts`) accept a caller-supplied `token` and forward it as `Authorization: Bearer` to the provider's live API (Hetzner, Scaleway, **and now Vultr** `https://api.vultr.com/v2/account`). Unlike the sibling agent-credential routes (`PUT /agent` at ~`credentials.ts:588`, project `PUT /:id/cloud-credentials`), these two are NOT wrapped in `rateLimitCredentialUpdate`. An authenticated+approved user can call `/validate` unboundedly with guessed tokens, using SAM's Worker as an SSRF-adjacent credential-probe relay against a third-party API (and risking Vultr/Hetzner-side abuse throttling of SAM's egress → shared-fate for other users).
- **Fix:** add `rateLimitCredentialUpdate` middleware to both routes (mirror the `PUT /agent` pattern). Benefits all four providers.

### 2. [ui-ux MEDIUM] The 5 "has-cloud-provider" gates exclude GCP
`OnboardingChecklist.tsx:43`, `onboarding/OnboardingContext.tsx:82`, `onboarding/choose-path/ChoosePathWizard.tsx:103`, `pages/CreateWorkspace.tsx:133`, `pages/project-chat/useProjectChatState.ts:272` all check `provider === 'hetzner' || 'scaleway' || 'vultr'` — GCP is (and was, pre-Vultr) omitted, so a GCP-only user is told they have no cloud provider and is blocked from running tasks (`TaskSubmitForm.tsx:274`).
- **Fix:** replace the hardcoded chains with the already-exported `isValidProvider(c.provider)` (`packages/shared/src/constants/providers.ts`) in all 5 sites — fixes the GCP gap AND future-proofs against the next provider. Verify the `credentials` arrays only contain cloud-provider rows at these sites (or filter appropriately) before switching.

### 3. [security LOW / ui-ux LOW] Minor pre-existing parity items
- Raw-token credential schemas (`HetznerCredentialSchema`, `VultrCredentialSchema`, `apps/api/src/schemas/credentials.ts`) have no `maxLength` — add `v.maxLength(4096)` for defense-in-depth.
- `AdminPlatformCredentials.tsx` uses a local `PROVIDER_LABELS` duplicate (drifts from the canonical shared `PROVIDER_LABELS`, e.g. `gcp: 'GCP'` vs `'Google Cloud'`) and its `AddCredentialForm` fields lack `htmlFor`/`id` label association. Consolidate + fix a11y.
- The credential forms' submit button flips to "Testing..." during the SAVE POST (it reads `loading`, which is the save state, not the validate state) — mildly confusing copy, cloned from HetznerTokenForm. Fix once for all provider forms.

## Acceptance criteria
- [ ] Rate-limit middleware on `POST /api/credentials` + `/validate`, with an at-limit-rejection test (rule 28 §4: atomic primitive, per-principal).
- [ ] 5 gates use `isValidProvider` (or equivalent) and include GCP; test a GCP-only user is treated as having a cloud provider.
- [ ] Optional LOWs addressed or explicitly deferred.

## References
- Parent PR: `sam/implement-vultr-fourth-cloud-qf96ez` (Vultr provider). Rule 25 (MEDIUM deferral), rule 28 §4 (rate-limit atomicity), rule 42 (tracked follow-up).
