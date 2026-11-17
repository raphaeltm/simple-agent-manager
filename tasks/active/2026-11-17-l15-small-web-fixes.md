# L15: one-click first profile, pool fit warning reads installation settings, truthful copy

SAM task 01M7M9EWWHSFH09VE6ZN1S27WJ. Self-host landing slice L15 (idea 01M72M9AEB933ZY8269D376DKC,
"LANDING PLAN part 6/7"), ported by hand from `origin/sam/selfhost-pass-2` (commits 0d677860f,
16b247384) onto main. Output branch `sam/self-host-landing-slice-1s27wj`.

## Problem

1. A project with no agent profiles stops the first message at "Create a profile to start" and a
   five-step wizard, even when only one agent is configured and there is nothing to choose.
2. A compute pool whose largest allowed machine cannot hold a default workspace (placement keeps a
   host memory reserve) fails every default chat and task with no explanation in the pool view.
   The integration branch's warning used hard-coded platform defaults; it must read the
   installation's resolved default requirements and host reserve, for the effective pool.
3. Copy: email-trigger copy must state only what the code checks (F30); onboarding says the
   SAM-hosted repo is "in your Cloudflare account", which is wrong for anyone but the operator.

## Research findings

- Gate: `apps/web/src/pages/project-chat/ChatInput.tsx` (`needsProfileBeforeSubmit`,
  `NoProfilesGate` in `ProfileWizardPanel.tsx`). Profiles come from `useProfileChoice`, called by
  `useNewChatComposer` (shared by project chat and `OverviewTaskBox`).
- Instant availability: `instantRuntimeEnabledQueryOptions` (`lib/query-options/projects.ts`).
  A Cloudflare install with `CF_CONTAINER_ENABLED=false` has no Instant, so the one-click profile
  must use VM there. Not self-host-only.
- Fit warning: integration branch `apps/web/src/lib/compute-pool-default-fit.ts`, used in
  `ComputePoolOverview`. Pool responses already carry `placementSettings.resourceDefaults.platformDefaults`
  (installation override via `capacityPools.platformDefaults.v1` / `CAPACITY_POOL_PLATFORM_DEFAULTS_JSON`,
  `resolveCapacityPoolPlacementSettings()`). Host reserve resolves from env via
  `resolveEffectiveNodeHostMemoryReserveMb()` (scheduler-core) and is not exposed yet.
  The panel shows `ownedDefault ?? effective` (effective = project -> user -> installation).
- F30: `packages/agent-email/src/inbound.ts` header: Workers cannot see SPF/DKIM/DMARC verdicts;
  the only sender check is the From allowlist (`parseAllowedSenders(...).includes(email.from)`).
  Copy at `EmailTriggerFields.tsx:40` and `steps-start-when.tsx:218`.
- Self-host-only parts of 0d677860f left out: `agentModelCalls` capability (Workers AI catalog
  404 on self-host) and the sam-mx wording.

## Checklist

- [x] `useProfileChoice`: `createDefaultChatProfile()` creates exactly one profile (Instant read at click time via `fetchQuery`)
- [x] `useProfileChoice`: Instant availability via the shared TanStack query (`instantRuntimeEnabledQueryOptions`) for the wizard
- [x] `NoProfilesGate` quick start (one agent only) + Customize; wired in project chat and overview
- [x] Wizard: Instant card disabled when unavailable; no-runtime fallback to VM
- [x] API: `hostMemoryReserveMb` on `SafeCapacityPoolPlacementSettingsSummary`
- [x] Web: `defaultWorkspaceFitWarning(groups, placementSettings)` in Overview
- [x] Copy: email trigger (two places), onboarding hosted repo
- [x] Unit tests (gate click creates one profile; no auto-create; fit warning with overrides)
- [x] Playwright audit 375/1280
- [ ] Staging verification

## Acceptance criteria

- One agent, no profiles: one click creates exactly one profile (VM when Instant is off) and
  the composer unlocks; nothing is created without the click. Two agents: no quick start.
- Fit warning appears when no allowed machine fits the installation's resolved defaults plus host
  reserve, and disappears when an override makes a machine fit.
- Email copy names only the From-allowlist check.

## Notes

- PR #2857. Fit warning lives in the read-only overview only (as on the integration branch).
- Desktop gate squeeze with long agent names found in screenshots and fixed (text on its own row).
- Personal pool page fallback notice said "This project uses..." with no project; now "Your work uses...".
