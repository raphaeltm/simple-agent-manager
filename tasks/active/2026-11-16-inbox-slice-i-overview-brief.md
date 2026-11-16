# Inbox slice I: generated brief on the Project Overview

Task 01M7K188NE5MF5Z7B6ZBFBGMR3 · spec idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9 §4.3 (page §4.2) · channel feature.inbox
Branch `sam/implement-slice-inbox-build-fbgmr3`. Authorized through production (Raphaël 2026-11-16).

## Problem
The Overview (F1/F2) has a slot for a short generated brief: how the project is advancing and what is
in the way, built from structured facts, linked to real items, no numbers, stored per project and
refreshed in the background. Nothing on the page may depend on it.

## Research findings
- Slot: comment at top of `main` in `apps/web/src/pages/project-overview/index.tsx` (F2). Phone order:
  Needs you first, brief one line under it (spec 4.2) → brief needs its own PHONE_ORDER slot after needsYou.
- Aggregated read: `projectOverviewGet` (`packages/operations/src/project-overview.ts`), sections fail on
  their own into `unavailable`. ~10 round trips today.
- Platform model path: `fetchWorkersAIChatCompletion` (`packages/ai-proxy/src/ai-proxy-shared.ts`) →
  `buildWorkersAIGatewayUrl` (the one SAM AI Gateway, `AI_GATEWAY_ID`), used by task titles with
  `@cf/google/gemma-4-26b-a4b-it` ($0.10/M in, $0.30/M out, `PLATFORM_AI_MODELS`). Reuse, no new credential.
- Settings: typed admin registry (`apps/api/src/services/admin-settings-registry.ts`); operations-side
  definitions pattern = `INBOX_SETTINGS` + `ctx.ports.settings.resolveDetailsMany`.
- Asks visibility: assignee user = me, or team (`inbox-list-core.ts`). "Facts every member may see" →
  team asks, or user asks when the assignee is the only active member.
- Failing automations are a client model (`failureStreak` ≥ `DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES`);
  server mirror reads newest finished `trigger_executions` per trigger.
- Budgets: `credential_limit_windows` per project; only `credential_source IN ('project','platform')`
  are visible to every member.
- Ideas are `tasks` rows (`ideaTaskPredicateSql`).

## Design
- Storage: D1 `project_briefs`, one row per project (read per project beside the D1 Overview read; one
  home, no copies). Migration additive.
- Read: one statement returns the row plus which referenced asks/running chats/automations are still
  open; claims about closed items are dropped; empty → null. Adds 1 round trip.
- Refresh: route schedules `refreshProjectBriefIfDue` with `waitUntil`; page never waits. Check
  throttled by `overviewBrief.checkIntervalSeconds` (CAS on `checked_at`), facts in one D1 batch,
  SHA-256 fingerprint of material facts (open asks, running chats+state, failed chats, failing
  automations, budget levels). Regenerate only when fingerprint changed, `minIntervalMinutes` passed,
  daily cap not hit (CAS claim increments per-UTC-day count). Quiet project → stored empty, no call.
- Model output: JSON sentences of text parts + handle refs (r1..rN), validated with Valibot; unknown
  refs, digits/number words, URLs/markup, refless sentences dropped; max 3 sentences. Rendered by SAM
  with links built from ids.

## Checklist
- [ ] Migration + drizzle schema `project_briefs`
- [ ] Shared types for the brief in `ProjectOverviewResponse`
- [ ] Settings (enabled, minIntervalMinutes, dailyCap, checkIntervalSeconds) in operations + admin registry
- [ ] Operations: brief read in `projectOverviewGet` (1 statement, closed-claim filter, section isolation)
- [ ] Operations: facts + fingerprint (one D1 batch), member-visible only, lengths capped
- [ ] API: prompt, output parser/validator, generator with CAS check/claim, daily cap, min interval
- [ ] API route: waitUntil refresh after the read
- [ ] Web: BriefSection (phone one line expand in place; desktop above Needs you; dimmed with age when
      stale/refreshing; hidden when null), refetch while refreshing
- [ ] Model constant registered (rule 52 test)
- [ ] Tests: real-trigger (answer via route → claim dropped), min interval, daily cap, invalid output,
      unknown id, number, prompt injection, quiet, disabled, fetch mocked at network edge
- [ ] Playwright audit 375/1280: fresh, stale/refreshing, quiet-hidden, unavailable, long, phone expanded;
      three Needs you rows on first phone screen
- [ ] Docs (apps/www overview/admin settings)
- [ ] Staging: real inbox items + running agent; answer → claim drops; switch off → page without brief

## Acceptance criteria
- Brief names real items as SAM-built links, no numbers, ≤2 sentences phone / ≤3 desktop.
- Page view never calls the model synchronously; second view inside min interval makes no model call.
- Daily cap stops generation; page renders.
- Invalid/unknown-id/number/injection outputs never render raw.
- Switch off → no brief, nothing else changes.
