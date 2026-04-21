# PLATFORM_TRIAL_ENABLED env var to disable trial on self-hosted

## Problem
Self-hosted admins may not want to offer a trial/onboarding flow. Currently there's no way to fully disable it without removing platform credentials.

## Proposal
Add a `PLATFORM_TRIAL_ENABLED` environment variable (default: `"true"`) that allows self-hosted admins to completely disable the trial/onboarding flow.

When disabled:
- `getTrialStatus()` returns `{ eligible: false }`
- No trial UI surfaces (TryDiscovery, ChatGate, etc.)
- Platform behaves as pre-trial — users must bring their own credentials

## Implementation Notes
- Add to `apps/api/src/env.ts` as optional string
- Check in `getTrialStatus()` in `apps/api/src/services/platform-trial.ts`
- Add to wrangler.toml `[vars]` with default `"true"`
- Document in env-reference and self-hosting guide

## Acceptance Criteria
- [ ] `PLATFORM_TRIAL_ENABLED=false` makes trial unavailable for all users
- [ ] Default behavior (unset or `"true"`) is unchanged
- [ ] Self-hosting guide documents the variable
