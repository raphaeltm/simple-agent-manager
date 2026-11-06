# Agent Profiles: usage budgets, resource requests, reset-aware limits

## Problem

The Agent Profiles list (project → Profiles) is a stack of tall cards with raw
metadata (`openai-codex  gpt-6-astra  Effort: high  Mode: conversation`). It
does not help pick which agent to use next: it shows nothing about how much plan
budget the profile's account has left, or what resources the profile asks for.

Separately, credential usage windows keep their last sampled percentage after
the window's `resetsAt` has passed (e.g. "81% used · reset due", or a red
"Limit reached" for a window that already reset). A sample taken before a reset
says nothing about usage after it; it should read 0% until a new sample.

Raphaël reviewed prototypes (library `/prototypes/profile-budgets/round-2/`) and
approved: A2 table on desktop, A1 strip on phones. Staging deployment waived by
Raphaël for this task (2026-11-06).

## Research findings

- `apps/web/src/components/agent-profiles/ProfileList.tsx` renders the list;
  only consumer is `pages/ProjectProfiles.tsx`. Tests:
  `apps/web/tests/unit/components/agent-profiles.test.tsx`.
- Which account a profile runs on is already computed client-side by
  `explainProfileAccount` (`components/accounts/profile-account-resolution.ts`)
  from `useAccountsData()` (`hooks/useAccounts.ts`); `AccountView.usage` is the
  matching `CredentialLimitCredentialSummary` from `/api/credential-limits`.
- Usage details dialog already exists (`CredentialLimitDetails` inside
  `credential-limits/CredentialLimitChip.tsx`, unexported).
- Resource requests: `AgentProfile.resourceRequirementsJson` (parse with
  `deserializeResourceRequirements`), legacy `vmSizeOverride`, `runtime`
  (`cf-container` = Instant).
- Limit read model: `apps/api/src/services/credential-limit-events/read.ts`
  `summarize()`; consumers: `/api/credential-limits`, project credential-limits
  route, MCP `get_credential_limits` (`routes/mcp/workspace-tools-credential-limits.ts`),
  `operations/team-core.ts`. No admission/gating path reads it.
- Client formatting: `credential-limit-format.ts` `formatResetCountdown` returns
  "reset due" but keeps percent and level.

## Implementation checklist

- [ ] shared: `credentialLimitWindowAsOf` / `credentialLimitSummaryAsOf` (reset-elapsed → 0%, ok, `resetElapsed: true`), type field
- [ ] api: apply in `summarize()` at read time; MCP text says the window reset
- [ ] web: chip + details apply the same helper with client `now`; countdown says "reset Xm ago"
- [ ] web: `useProfileBudgets` hook (profile → resolved account + usage)
- [ ] web: compact usage strip (opens existing details dialog)
- [ ] web: resource request line
- [ ] web: ProfileList → table on md+, strip rows on phones; ⋯ menu for edit/delete; sort Name / Most room
- [ ] tests: shared helper, api summarize, chip, ProfileList vertical slice (real hooks, API mocked)
- [ ] Playwright audit 375/1280, light/dark, long names
- [ ] docs: usage-limits behaviour where documented
- [ ] remove prototype route + directory

## Acceptance criteria

- [ ] Desktop (≥768px) shows one row per profile with Runs / Requests / Usage columns
- [ ] Phones show three-line rows: name, model + settings, resources + usage strip
- [ ] Usage strip shows the account the profile actually resolves to (profile pin → project → default → platform)
- [ ] A window whose reset passed reads 0% with "reset X ago", everywhere limits show (chip, dialog, MCP)
- [ ] Tapping the strip opens the usage details dialog
- [ ] Edit / delete still work
- [ ] No horizontal overflow at 375px with long names/models
- [ ] Prototype removed
