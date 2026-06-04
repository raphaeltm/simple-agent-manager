# Onboarding: make AI-token and cloud-infra routing explicit user choices

## Problem Statement

The "trial" concept in SAM was originally coined to mean "platform-hosted, zero-config OpenCode" — gated on (a) a platform Hetzner cloud credential existing and (b) the AI proxy being enabled. Two problems flow from this:

1. **Conceptual.** SAM now provides metered tokens for Codex and Claude Code too, not just OpenCode. The right frame is a cross-harness *choice*: route LLM traffic through SAM (free credits/month, any harness) or through your own keys. Same for infrastructure: SAM-managed Hetzner vs. your own. These are onboarding choices, not platform preconditions.

2. **Behavioral.** `trialAvailable` (platform availability) was used to decide whether onboarding was "complete" and to pre-mark AI/cloud steps as done. A brand-new user's onboarding was auto-suppressed/auto-completed if the platform happened to have a Hetzner credential + AI proxy on — even though they never made the choice. Backwards: platform availability should *enable* the SAM-managed option inside onboarding, not *skip* onboarding.

3. **Bug.** The `?onboarding` force-open query param opened the overlay but never reset the `dismissed` flag, so `showOverlay = overlayOpen && !dismissed && !loading` stayed false for users who already dismissed.

## Research Findings

- `OnboardingContext.tsx`: completeness was `(hasAgent || trialAvailable) && (hasCloud || trialAvailable) && hasGitHub`; `forceOpen` set `overlayOpen` but not `dismissed`. Both fed by a now-removed `getTrialStatus()` call.
- `ChoosePathWizard.tsx`: pre-population used `|| trialAvailable` on agent/cloud tags.
- `questions.ts` / `path-generator.ts`: SAM-managed copy needed to read as harness-agnostic, choice-oriented.
- Local staleness gotcha: `packages/shared/dist` must be rebuilt to expose `DEFAULT_GITHUB_CLI_POLICY` or unrelated `agent-profiles` tests fail (`policy.mode` TypeError). Not a code defect; build-order issue.

## Implementation Checklist

- [x] OnboardingContext: `isComplete = hasAgent && hasCloud && hasGitHub` (decouple from platform availability)
- [x] OnboardingContext: `forceOpen` branch calls `setDismissed(false)` so `?onboarding` re-opens for dismissed users
- [x] OnboardingContext: remove unused `getTrialStatus()` plumbing
- [x] ChoosePathWizard: pre-mark `existing-agent`/`existing-cloud`/`existing-github` from the user's own credentials only
- [x] questions.ts / path-generator.ts: harness-agnostic SAM-managed copy (no "OpenCode"/"trial")
- [x] Unit tests: `OnboardingContext.test.tsx` covering ?onboarding re-open, no auto-complete without own creds, auto-complete with own creds
- [x] Unit tests adjusted: path-generator, questions, step-actions
- [x] Playwright recordings spec for the choose-path overlay

## Acceptance Criteria

- [x] Onboarding always displays for users who haven't completed their *own* setup (agent + cloud + GitHub) — covered by `OnboardingContext.test.tsx`
- [x] Platform availability never suppresses or auto-completes onboarding — covered by "does NOT auto-complete onboarding when the user lacks their own agent/cloud creds"
- [x] `?onboarding` reliably re-opens for anyone, including previously-dismissed users — covered by "re-opens via ?onboarding even when the user previously dismissed"
- [x] AI-token and cloud-infra routing presented as explicit SAM-managed vs own choices — questions/path-generator copy + Playwright recordings
- [x] Playwright visual audit at 375px and 1280px, no overflow — `onboarding-wizard-audit.spec.ts`
- [x] Live staging verification (primary + secondary user) — overlay appears, ?onboarding re-opens, choices render

## Out of Scope (flagged follow-up)

The SAM-managed AI and SAM-managed cloud choices currently persist nothing durable — `step-actions.ts:executeStep()` only persists `ai-apikey` and `cloud-hetzner`; SAM options are no-ops and dismissal is the only completion signal. Making the SAM-managed choice durable (e.g. `providerMode='sam'`, per-user "use SAM infrastructure" flag) is a larger backend change and is NOT part of this task.

## References

- Plan: `/home/node/.claude/plans/woolly-tinkering-steele.md`
- PR #1189 (draft)
- Agent auth provider modes: CLAUDE.md "Agent Authentication"
