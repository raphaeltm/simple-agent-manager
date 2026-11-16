# Insights slice A: Accounts tab

SAM task `01M7JKFEAKZMXMGTGFJV8YNTCZ`; coordinator `01M7JK6W6PRQN64GD2MVMFZKBX`; build spec idea
`01M7HTS38KX2G78JD0ESAGMKKH`; channel `feature.insights`. Branch
`sam/build-insights-slice-accounts-8yntcz`.

## Problem

The project Insights page (`/projects/:id/insights`, slice F, PR #2789) has an Accounts tab that
shows a "coming soon" placeholder (`apps/web/src/pages/insights/ComingSoonTab.tsx`). Replace it
with the real tab: per account (credential) the runs it carried, how often and how long it stalled
on a usage limit, its current limit windows, and spend for API keys, plus runs per day/week by
account. Prototype: Library `/product/analytics/analytics-prototypes.html?s=accounts`.

## Research findings

- **Run population**: reuse Flow's exact run definition (`runsCte()` in
  `packages/operations/src/insights-flow-sql.ts`: task-mode, non-idea tasks that ended in the
  range or are running and started in it; merged = `pr_rank = 3`). Accounts and Flow must count
  the same runs.
- **Run → account**: `tasks.workspace_id` → `workspaces` (same project) → newest `agent_sessions`
  row with a credential reference (`agent_credential_reference`, `_source`, `agent_type`). Prod
  (2026-11-16, read-only): 2527 agent sessions over 2527 workspaces (one per workspace), 1357/1366
  task workspaces have exactly one credential, 9 have none ("not recorded").
- **Limit keys**: `credential_limit_windows.credential_reference` and the task wait's
  `credentialKey` hold `credentialLimitReferenceKey(reference)` (the reference itself, or a
  `sha256:` digest for long legacy references). That function lives in
  `apps/api/src/services/credential-limit-events/values.ts`; move it to `packages/shared` so the
  operation and the API share one implementation (rule 24).
- **Stall evidence (derived, never stored)**:
  - `tasks.provider_limit_wait_json` (`ProviderLimitWaitSchema`, scheduler-core): only the latest
    wait per task survives; fields `observedAt`, `resetsAt`, `nextRetryAt`, `phase`
    (waiting/blocked/released), `origin` (callback = paused mid-run, admission = held before
    start, i.e. the `provider_limit_waiting` admission state), `credentialKey`,
    `ownerOverride.grantedAt`. Prod: 46 tasks with waits in 30 days.
  - `credential_limit_windows` rows with `status = 'rejected'` (one row per project × credential ×
    window; only the latest sample, so an old rejection disappears once a later sample is allowed).
    They give the window label (5-hour, weekly) and cover chats that stalled without a task wait.
  - Episode = per account, overlapping/touching stall intervals merged. Wait interval: observedAt →
    ownerOverride.grantedAt / nextRetryAt (waiting/released) or the task's end / now (blocked),
    capped at now. Window interval: observed_at → resets_at (or now), capped at now.
- **Privacy**: account names are private to their owner (`routes/chat-agent-credential.ts`); kind
  and owner type are visible to members. Name only when `cc_credentials.owner_id` = viewer; other
  members' accounts are grouped by owner kind + agent + credential kind, never named or keyed by
  credential id. Never select `encrypted_token`/`iv`.
- **Limit meters**: reuse `ctx.ports.account.listOwnCredentialLimitsByReferences` (own windows) and
  the web `CredentialLimitChip` (`components/credential-limits/*`), which takes a
  `CredentialLimitCredentialSummary`.
- **Spend**: `agent_run_usage` (slice U, task `01M7JKEWE3P8G5Z6KCWWVDBNJ0`) is not merged. API-key
  accounts show spend "not reported"; the response carries a `spend` slot U fills.
- **Budget (rule 60, spec ≤ 6)**: authorization 1 + settings ≤ 1 (per-isolate cache) + one D1
  `batch()` 1 + own limit windows ≤ 1 = ≤ 4.
- Settings pattern: `insights-flow-settings.ts` + `admin-settings-features-definitions.ts`.
- Web pattern: `FlowTab.tsx` (TanStack Query, `placeholderData`, `LoadError`/`Loading`/`Notice`),
  `lib/api/insights.ts`, `lib/query-options/insights.ts`, route in `App.tsx`.

## Implementation checklist

- [ ] Move `credentialLimitReferenceKey` (+ `sha256Hex` it needs) to `packages/shared`; API imports it
- [ ] Shared types `packages/shared/src/types/insights-accounts.ts` (response, account, episode)
- [ ] Export a parameterised `runsCte` from `insights-flow-sql.ts` (account columns opt-in)
- [ ] `packages/operations/src/insights-accounts-sql.ts`: runs-by-account, waits, rejected windows
- [ ] `packages/operations/src/insights-accounts.ts`: `projectAccounts(ctx, { projectId, range })`
      (authorize, settings, one batch with per-statement fallback, row isolation, episode merge,
      own meters, privacy grouping)
- [ ] Settings `insights.accountsStallScanCap`, `insights.accountsEpisodesListed` (Operations group)
- [ ] REST `GET /api/projects/:projectId/insights/accounts?range=` in `routes/project-insights.ts`
- [ ] Tests on a real SQL engine: foreign-project attack + owner control per statement, malformed
      rows (good/bad/good), privacy (teammate name never returned), episode merge, round-trip
      budget, route-level test
- [ ] Web: `getProjectAccounts`, query options, `AccountsTab.tsx` + parts, route; delete
      `ComingSoonTab` accounts entry (no dead code)
- [ ] Playwright visual audit 375/1280: normal, empty, stress (many accounts/long names), error
- [ ] Docs: Insights section of the project guide (`apps/www/.../guides/`)
- [ ] Staging: real project with runs, limit-hit account if staging has one
- [ ] Post read shape on `feature.insights` for slice U

## Acceptance criteria

- [ ] Accounts tab shows, per account: runs, merged, limit stalls (count × total duration), current
      limit windows for the viewer's own accounts, and "not reported" spend for API keys
- [ ] Runs per day (7d) / week (30d, 90d) by account, stacked, matching Flow's run total
- [ ] Stall episodes list, newest first, with account, window, runs paused, duration, outcome
- [ ] Another member's account name or credential id never appears in the response
- [ ] Foreign-project rows never counted (real SQL engine attack test + owner control)
- [ ] One malformed row costs only that row
- [ ] ≤ 6 round trips, measured in a test
- [ ] Range control switches 7/30/90 without blanking the page; refresh keeps data visible
- [ ] No horizontal overflow at 375 and 1280; placeholder code for Accounts removed
