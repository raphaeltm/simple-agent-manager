# PLATFORM_TRIAL_ENABLED env var to disable trial on self-hosted

> **Reconciliation 2026-09-30:** still open, but needs rescoping. Platform-trial availability
> means a platform cloud credential exists and `AI_PROXY_ENABLED` is not false
> (`apps/api/src/services/platform-trial.ts:27-56`). The anonymous `/try` flow has its own KV
> switch, off by default (`apps/api/src/services/trial/kill-switch.ts:44-72`).
> `platform-trial.ts:87` still advertises `agentType: 'opencode'`, although PR #1431 removed
> platform OpenCode. A real flag would also need server-side enforcement, because provisioning
> falls back to the platform credential regardless of this status.

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
