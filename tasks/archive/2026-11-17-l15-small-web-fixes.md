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
- [x] Staging verification (coordinator-approved hybrid substitutions documented below)

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

## Takeover completion evidence (2026-11-17)

- Main merged normally, including #2841 secret-readback removal and #2840. Conflict-free; binary feature diff before/after #2840 merge identical. Secret guard: zero findings, one tracked masked legacy read.
- Gated staging run [44186398487](https://github.com/raphaeltm/simple-agent-manager/actions/runs/44186398487), attempt 2, SUCCESS on `2b4f3b30dd274bdcae1c4f29d71a58e8eb626e0f`. One plain failed-job retry resolved transient Pulumi R2 metadata HTTP500 after rollout gate passed; every deploy gate retained.
- Playwright375/1280 screenshots opened: unmocked multi-agent gate; wizard Instant card matches real config; real wizard profile and project/chat creation; chat responded `L15 VERIFIED`; From-allowlist-only email copy; real pool resolved defaults (2vCPU/4GB/15GB) and1024MB host reserve match fit positive control.
- Coordinator-approved hybrid: only agent-list response filtered to one real configured agent. No creation before click; click makes exactly one real `Claude Code Chat` profile, verified API readback and focused composer, then deleted; both widths. No single-agent staging principal exists.
- Coordinator-approved onboarding hybrid: only read-only project-list response returns empty to expose repository question; correct SAM-hosted copy at both widths, no writes.
- No sanctioned installation-default settings writer exists. Coordinator explicitly approved live resolved-default positive control plus real-SQL override cases: `reports the selected validated settings sources and diagnoses invalid persisted values` and `changes placement snapshot generations when effective settings or credential source changes` (2 PASS). No persisted staging override was mutated.
- Cleanup: profiles deleted; session stopped200/workspaceDeleted true; project deleted200; project/workspace/node GET404. Sign-out200. No settings changed or VMs created. Release44193421578 SUCCESS; authoritative22:51UTC lease holder null, next task turn, peer notified.
- Coordinator approved carrying staging evidence over a conflict-free main merge with identical feature patch, task archive as the only extra change, and full CI passing on final head. PR body contains screenshot links and current gate status.
- Independent focused UI review PASS (4/4/4/4/5); completion checks A-F PASS after final evidence review; cleared for archive. Original specialists PASS/ADDRESSED and all automated findings resolved; incremental reviews cover takeover fixes.
- Unrelated CI repairs: bounded virtual-row reveal readiness in visual helper, and relative future TTL in SecretRequestCard success fixture; assertions and dedicated expiry cases preserved.
