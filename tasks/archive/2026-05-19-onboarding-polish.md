# Onboarding polish for user readiness

## Problem

The onboarding wizard and first project flow exist, but users still hit avoidable trust gaps before they can succeed: credentials can fail only after provisioning begins, the wizard does not end with a concrete next action, provisioning still feels opaque while a task starts, and the first project chat screen does not suggest useful starter prompts.

Idea: `01KRX9CB48Z3AQ0T4NJ851E5H1` ("Onboarding polish: credential validation, guided flow, provisioning progress").

Critical override for this `/do` run: do not merge under any circumstances. Complete implementation, validation, specialist review, PR, CI/check monitoring, and staging verification where applicable, then stop before merge.

## Research Findings

- Onboarding lives in `apps/web/src/components/onboarding/OnboardingWizard.tsx` with steps in `StepAgentKey.tsx`, `StepCloudProvider.tsx`, `StepGitHub.tsx`, and `StepHowItWorks.tsx`.
- The wizard already treats platform trial availability as satisfying agent and cloud setup, and skips to GitHub when trial is available but GitHub is missing.
- Cloud credential saving is handled by `POST /api/credentials` in `apps/api/src/routes/credentials.ts`; it already validates non-GCP cloud credentials by building a provider and calling `provider.validateToken()` before encryption and persistence.
- Settings cloud forms include `HetznerTokenForm.tsx` and `ScalewayCredentialForm.tsx`. Hetzner currently relies on submit-time API validation but does not show a distinct test/validation state before save.
- Agent credential saving is handled by `PUT /api/credentials/agent`; it performs local format validation via `CredentialValidator.validateCredential()` but does not perform upstream provider validation.
- Project chat is in `apps/web/src/pages/project-chat/index.tsx` and `useProjectChatState.ts`. Provisioning state is derived from task status and `executionStep`, and rendered by `ProvisioningIndicator.tsx`.
- Shared execution steps and labels live in `packages/shared/src/types/task.ts`. Current labels are granular internally but do not present the four-step user model from the idea.
- Boot logs are already streamed during `workspace_ready` via `useBootLogStream`, and `ProvisioningIndicator` already provides a log panel affordance when logs exist.
- First chat empty state is rendered inline in `ProjectChat` with a generic "What do you want to build?" prompt and composer placeholder.
- Relevant postmortems:
  - `docs/notes/2026-03-01-tdf-message-relay-postmortem.md`: provisioning progress disappeared after navigation because frontend state was local only. This task must preserve restore-from-session/task behavior.
  - `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`: frontend progress can mask backend failures. This task must include tests that verify the actual submission/provisioning contract, not only UI rendering.

## Implementation Checklist

- [x] Add or expose a credential validation API path for right-entry validation without duplicating persistence logic.
- [x] Update onboarding cloud credential step to validate before completing, with inline success and error states.
- [x] Update onboarding agent credential step to validate before completing where the existing backend can validate, with clear inline feedback.
- [x] Update Settings Hetzner credential form to make validation visible at the entry point.
- [x] Update the final onboarding step to offer "Create your first project" and navigate to `/projects/new`, while preserving dismissal.
- [x] Keep trial-aware wizard behavior scoped to existing trial availability, and add a CTA to continue setup with own credentials when trial coverage is active.
- [x] Replace opaque provisioning text with a four-stage progress presentation and "Usually takes 2-4 minutes" estimate while keeping boot-log access.
- [x] Restore provisioning progress correctly when navigating back to an active session.
- [x] Add 3-4 first-chat example prompts that populate the composer and respect project context where available.
- [x] Add focused API/unit tests for credential validation and frontend tests for onboarding/provisioning/chat prompt behavior.
- [x] Run local Playwright visual audit for changed web surfaces on mobile and desktop.
- [x] Run full quality suite before PR.
- [x] Complete specialist review.
- [ ] Complete staging verification.
- [ ] Create/update PR and monitor CI checks.
- [ ] Stop before merge and report PR URL/status.

## Acceptance Criteria

- Users cannot complete cloud onboarding with an invalid Hetzner/Scaleway credential; they see inline validation feedback before the wizard advances.
- Agent credential onboarding shows validation feedback at the same entry point, using existing backend validation for supported credential kinds.
- Settings Hetzner credential entry makes validation outcome visible and does not silently accept obviously invalid tokens.
- The onboarding wizard final step has a clear path to create the first project at `/projects/new`.
- Trial-covered users are not forced through redundant agent/cloud steps, and they have a visible path toward bringing their own setup.
- Project chat provisioning displays staged progress, a realistic time estimate, elapsed time, and boot-log access when available.
- Returning to a provisioning session restores progress from persisted task status.
- First project chat empty state offers clickable starter prompts that populate the composer.
- Tests cover the new validation and UI behavior.
- UI changes pass local Playwright visual audit on 375x667 and 1280x800.
- Staging verification is attempted per `/do`; missing credentials or staging blockers are reported and do not result in merge.
