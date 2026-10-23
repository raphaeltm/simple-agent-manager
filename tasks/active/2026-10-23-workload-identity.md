# Provider-neutral execution workload identity

## Request
Implement and release short-lived OIDC tokens through exec_with_secrets. Include authoritative project, user, active profile, chat/runtime session, task and automation provenance with IDs and descriptive labels. Document trust setup and expose copyable identities in the UI. External trust setup remains user-owned.

## Research
- jwt.ts already signs GCP federation tokens and exposes discovery/JWKS; generic issuance must not change GCP contracts.
- Internal JWTs share signing keys: external audiences must exclude all internal audiences; tests must reject workload tokens at internal verifiers.
- Existing kid uses calendar month. Publish a key-thumbprint kid for new workload tokens while retaining the legacy key alias for existing runtimes.
- secret-exec-tools privately delivers managedEnv to VM with exact-value redaction and stable request fingerprints. Reuse this path; no raw token in MCP result or persistence.
- Runtime assets resolve the actual agent_sessions profile, not task hints.
- Task submission checkpoints carry authoritative source kind/id/execution for triggers, schedules, watches and workflows; task rows carry trigger provenance and parent IDs. Never infer origin from prompts.
- Existing chat Details already has copyable session/task/runtime IDs. Add a focused workload identity disclosure there rather than several new settings screens.
- Relevant incidents: callback auth routing rule34; runtime validation rule51; phase5 review-before-merge rule14. New metadata route uses session auth, not callback auth.

## Implementation checklist
- [ ] Generic bounded workload JWT signer, stable kid, internal audience separation
- [ ] Authoritative session/profile/task/provenance resolver, safe labels, no sensitive content
- [ ] Optional oidc request, reserved injected env, retry-safe fingerprint, no token persistence
- [ ] Read-only metadata API and copyable UI identities on mobile/desktop
- [ ] User guide, claims contract, provider examples, operational limitations, config/API references
- [ ] Unit/integration tests for issuance, auth, provenance, redaction, retries, UI behavior
- [ ] Local lint/typecheck/test/build and visual audit
- [ ] Independent local security/domain/completion reviews
- [ ] Staging end-to-end token exchange and UI verification
- [ ] PR green, CodeRabbit requested/waited/addressed, merge and production smoke

## Acceptance
No GCP setup required. Claims derive only from trusted stored context. IDs are intended for authorization; labels are mutable and descriptive. No generic JWT authenticates to SAM internal endpoints. Claims omit unavailable provenance rather than inventing it. Empty secretNames works. Raw token never returned to the model. UI allows copying identities without minting tokens. Existing secret execution and GCP federation remain compatible.

## UI variants
1. Add IDs across separate settings/profile/automation pages: useful but scatters trust setup.
2. Add a dedicated settings page: unnecessary navigation for a small feature.
3. Selected: workload identity disclosure in existing chat Details, showing exact available session claims plus issuer/subject and copy buttons. Keeps IDs together without crowding normal chat.
