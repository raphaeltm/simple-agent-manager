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
- Settings pattern: `insights-flow-settings.ts` (renamed `insights-page-settings.ts` here) + `admin-settings-features-definitions.ts`.
- Web pattern: `FlowTab.tsx` (TanStack Query, `placeholderData`, `LoadError`/`Loading`/`Notice`),
  `lib/api/insights.ts`, `lib/query-options/insights.ts`, route in `App.tsx`.

## Implementation checklist

- [x] Move `credentialLimitReferenceKey` (+ `sha256Hex` it needs) to `packages/shared`; API imports it
- [x] Shared types `packages/shared/src/types/insights-accounts.ts` (response, account, episode)
- [x] Export a parameterised `runsCte` from `insights-flow-sql.ts` (account columns opt-in)
- [x] `packages/operations/src/insights-accounts-sql.ts`: runs-by-account, waits, rejected windows
- [x] `packages/operations/src/insights-accounts.ts`: `projectAccounts(ctx, { projectId, range })`
      (authorize, settings, one batch with per-statement fallback, row isolation, episode merge,
      own meters, privacy grouping)
- [x] Settings `insights.accountsStallScanCap`, `insights.accountsEpisodesListed` (Operations group)
- [x] REST `GET /api/projects/:projectId/insights/accounts?range=` in `routes/project-insights.ts`
- [x] Tests on a real SQL engine: foreign-project attack + owner control per statement, malformed
      rows (good/bad/good), privacy (teammate name never returned), episode merge, round-trip
      budget, route-level test
- [x] Web: `getProjectAccounts`, query options, `AccountsTab.tsx` + parts, route; delete
      `ComingSoonTab` accounts entry (no dead code)
- [x] Playwright visual audit 375/1280: normal, empty, stress (many accounts/long names), error
- [x] Docs: Insights section of the project guide (`apps/www/.../guides/`)
- [ ] Staging: real project with runs, limit-hit account if staging has one
- [x] Post read shape on `feature.insights` for slice U

## Acceptance criteria

- [x] Accounts tab shows, per account: runs, merged, limit stalls (count × total duration), current
      limit windows for the viewer's own accounts, and "not reported" spend for API keys
- [x] Runs per day (7d) / week (30d, 90d) by account, stacked, matching Flow's run total
- [x] Stall episodes list, newest first, with account, window, runs paused, duration, outcome
- [x] Another member's account name or credential id never appears in the response
- [x] Foreign-project rows never counted (real SQL engine attack test + owner control)
- [x] One malformed row costs only that row
- [x] ≤ 6 round trips, measured in a test
- [x] Range control switches 7/30/90 without blanking the page; refresh keeps data visible
- [x] No horizontal overflow at 375 and 1280; placeholder code for Accounts removed

## Implementation notes

- Main is branch-protected (required check), so the task file was committed on the feature branch.
- Flow's batch runner and row parser were near-copies of what Accounts needed: extracted to
  `insights-batch.ts` and used by both. Flow's settings file became `insights-page-settings.ts`
  (one resolver for both tabs).
- Discrimination checks run (each predicate deleted once, then restored): workspace project join in
  `runsCte({account:true})` → "attributes runs…" red; waits `t.project_id = ?` → "merges overlapping…"
  red; windows `l.project_id = ?` → "merges overlapping…" red; SQL own-name gate → "keeps another
  member's credential name in the database" red; display-layer name gate → compute "names only the
  viewer's own credential" + "keeps project and platform accounts apart" red.
- The admin settings store is unreadable in the better-sqlite3 harness (it falls back to defaults),
  so the scan-cap test overrides the settings port directly.
- Playwright: Chromium's system libraries were installed per-user (apt-get download + dpkg-deb -x
  into `.tmp/pwlibs`, `LD_LIBRARY_PATH`), no sudo.
- Not reused: `operations/account-usage.ts` and `team-usage.ts` hold profile→pool bindings and SAM
  AI daily usage, not per-credential run history. What they reuse is reused here too: the
  `listOwnCredentialLimitsByReferences` port and the `CredentialLimitChip`.
- Review round (all five local reviewers, no CRITICAL/HIGH code defects): fixes in 7bf3239e0. New
  guards proven red: wait→session `EXISTS`, prefer-credential session order, windows privacy
  predicate, `status = 'rejected'`, waits `observedAt >= since`, production indexes (plan test).
- Accepted with evidence: the waits statement walks a project's tasks (same as Flow's runs CTE;
  6–11 ms at 10k tasks per the cloudflare-specialist's EXPLAIN on all migrations); a digest-keyed
  own credential with a stall but no run in range shows unnamed (errs toward hiding).
- Staging (both installations busy until ~18:05Z; staging has no limit-wait or rejected-window
  rows, so the live check covers runs/accounts; stalls are covered by tests).
