# Validate Credentials on Save

## Problem

Cloud provider credentials and agent API keys can be accepted without a user-visible live provider check during the save flow. Users may only discover an invalid token minutes later when provisioning or agent startup fails. The save path should validate credentials against the upstream provider and return clear validation feedback, while still allowing save when upstream validation fails or is temporarily unavailable.

## Research Findings

- `apps/api/src/routes/credentials.ts` owns cloud-provider credential save (`POST /api/credentials`), cloud validation (`POST /api/credentials/validate`), agent validation (`POST /api/credentials/agent/validate`), and agent credential save (`PUT /api/credentials/agent`).
- Cloud credential saves currently call `validateCloudCredential()` before encryption and reject the save on validation failure. This conflicts with the requested warning-mode save behavior.
- `apps/api/src/services/agent-credential-validation.ts` already validates API keys against Anthropic, OpenAI, Google, and Mistral model-list endpoints, but throws route errors on invalid responses and is not used in the agent save path.
- `apps/api/src/services/validation.ts` currently contains format validation for agent credentials and OpenAI Codex auth JSON. It is the requested place to add provider-specific validation results.
- `apps/web/src/components/onboarding/StepCloudProvider.tsx` and `StepAgentKey.tsx` currently require explicit validation before Connect. The requested behavior is validation on save, not every keystroke, and failed validation should allow saving with a warning.
- `apps/web/src/components/HetznerTokenForm.tsx`, `ScalewayCredentialForm.tsx`, and `AgentKeyCard.tsx` are settings surfaces that also save credentials and should show inline validation success or warning feedback from the save response.
- Postmortem `docs/notes/2026-03-14-scaleway-node-creation-failure-postmortem.md` reinforces tracing UI choices through the API boundary; tests need to prove save responses carry validation status back to the caller.
- Postmortem `docs/notes/2026-04-18-project-credentials-security-hardening-postmortem.md` reinforces behavioral tests at credential trust boundaries and avoiding source-contract tests.

## Implementation Checklist

- [x] Add typed credential validation result helpers in `apps/api/src/services/validation.ts` for Hetzner, Scaleway, Anthropic, and OpenAI provider checks.
- [x] Preserve existing explicit validation endpoints with clear failure responses.
- [x] Update cloud-provider save to call live validation before encryption but continue saving with `validation.valid === false` warnings.
- [x] Update agent credential save to validate API keys live before encryption but continue saving with warnings; keep OAuth credentials format-only.
- [x] Return validation metadata from save responses without exposing credential material.
- [x] Update web API types and credential settings/onboarding UI to show saving/test progress, green success, and red warning/error messages.
- [x] Make onboarding Connect validate-on-save and not require a separate Test action before saving.
- [x] Add unit tests for provider validation helpers with mocked `fetch`.
- [x] Add route tests proving validation success and warning-mode failure save responses.
- [x] Add/adjust web unit or Playwright coverage for validation feedback surfaces.
- [ ] Run required quality gates, specialist review, staging verification, and create a do-not-merge PR.

## Acceptance Criteria

- Saving a Hetzner token calls `GET https://api.hetzner.cloud/v1/servers` and returns validation success for HTTP 200.
- Saving Scaleway credentials calls a Scaleway API endpoint that validates the secret key and project ID.
- Saving Anthropic and OpenAI API keys calls their `/v1/models` endpoints with the correct auth headers.
- HTTP 401/403 validation failures produce clear provider-specific warnings, do not leak secrets, and do not prevent saving.
- UI shows an in-progress connection test indicator while save validation is running, a green success message when validation passes, and a red warning/error message when validation fails.
- Validation happens on save or explicit test, not on every keystroke.
- Tests cover validation functions, save-with-validation failure warning mode, save-with-validation success, and UI-to-API propagation.

## Constraints

- Do not merge. Leave a PR ready for human review.
- Coordinate before staging deploy and do not deploy concurrently with another active staging run.
- Do not touch unrelated dirty `.codex/` workspace files.
