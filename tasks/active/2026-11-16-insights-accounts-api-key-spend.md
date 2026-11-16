# Insights A2: API-key spend and tokens per merged PR on the Accounts tab

Task 01M7KCBXCSGYQKNH36SGXG63W0 · idea 01M7HTS38KX2G78JD0ESAGMKKH · coordinator 01M7JK6W6PRQN64GD2MVMFZKBX

## Problem

Slice A (#2810) shipped the Accounts tab with `InsightsAccount.spend = {state:'not_reported'}` for
API keys because per-run usage did not exist. Slice U (#2811, migration 0253) now records
`agent_run_usage`. Fill the account's spend (estimate from catalog prices) and show tokens for every
account, both also per merged pull request.

## Research findings

- `projectAccounts` (`packages/operations/src/insights-accounts.ts`) runs 4 statements in one
  `runInsightsBatch`; measured 3 round trips (budget 6).
- Runs are keyed by `credentialLimitReferenceKey(ref)`; `agent_run_usage.credential_key` is the same
  key space, so usage attaches via `displayKeyOf` (handles long digest keys too).
- `readRunUsage` prefers ai_proxy rows per chat session; account read must do the same in SQL
  (NOT EXISTS on the unique-key prefix `(project_id, chat_session_id, source)`).
- Index `idx_agent_run_usage_project_updated (project_id, updated_at)` seeks the window.
- Binding rules (channel seq 31/33): project_id in every predicate; redact other members'
  credential keys; spend only for `cc_credentials.kind='api-key'` and only to the owner for
  user-source keys (`private` otherwise); sum with TOTAL().
- `accountKind` maps both `api-key` and `openai-compatible` to `api_key`; the custom endpoint has no
  catalog price, so its tokens make the spend partial.
- Receipt's private rule: `spendVisible = isOwnSession || credentialSource !== 'user'`.
- UI: `accounts-parts.tsx` `spendText`, footer note in `AccountsTab.tsx` says spend not reported.
- Docs: `guides/insights.md` (Spend bullet), `guides/admin-settings.md` (settings table),
  `reference/api.md` (accounts route).

## Checklist

- [ ] Shared types: `InsightsAccountSpend` gains `private` and partial/unpriced; `InsightsAccount.tokens`
- [ ] `accountUsageStatement` + `parseAccountUsageRows` in `insights-run-usage.ts` (rules above)
- [ ] Setting `insights.accountsUsageRowCap` (rule XI), disclosed when hit
- [ ] Wire into `projectAccounts` batch (5 statements, still 3 round trips), attach per display account
- [ ] Remove the "not reported yet" footer copy; keep `not_reported` for API keys with no rows
- [ ] UI: Spend row (estimate, partial, private), Tokens row with per merged PR
- [ ] Real-SQL tests: foreign-project attack + owner control, proxied double count, teammate key
      redacted (and private), non-API-key no spend, unpriced model partial; each guard deleted once
- [ ] Round-trip budget test still 3
- [ ] Playwright audit at 375/1280: spend present, partial, absent/private
- [ ] Docs: insights guide, admin settings table, API reference
- [ ] Post signature on feature.insights for slice S

## Acceptance criteria

- API-key account with usage shows an estimated cost and cost per merged PR, labelled estimate
- Unpriced model → partial, UI says which models are unpriced; never guessed
- Subscription/platform accounts show tokens, no money
- Teammate's personal key: tokens only, spend private; their credential key never leaves SQL
- Proxied run counted once; another project's rows never counted
- Accounts stays ≤ 6 round trips (measured)
