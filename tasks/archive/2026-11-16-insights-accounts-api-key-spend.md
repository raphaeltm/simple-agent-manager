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

- [x] Shared types: `InsightsAccountSpend` gains `private` and partial/unpriced; `InsightsAccount.tokens`
- [x] `accountUsageStatement` + `parseAccountUsageRows` in `insights-run-usage.ts` (rules above)
- [x] Setting `insights.accountsUsageRowCap` (rule XI), disclosed when hit
- [x] Wire into `projectAccounts` batch (5 statements, still 3 round trips), attach per display account
- [x] Remove the "not reported yet" footer copy; keep `not_reported` for API keys with no rows
- [x] UI: Spend row (estimate, partial, private), Tokens row with per merged PR
- [x] Real-SQL tests: foreign-project attack + owner control, proxied double count, teammate key
      redacted (and private), non-API-key no spend, unpriced model partial; each guard deleted once
- [x] Round-trip budget test still 3
- [x] Playwright audit at 375/1280: spend present, partial, absent/private
- [x] Docs: insights guide, admin settings table, API reference
- [x] Post signature on feature.insights for slice S

## Acceptance criteria

- API-key account with usage shows an estimated cost and cost per merged PR, labelled estimate
- Unpriced model → partial, UI says which models are unpriced; never guessed
- Subscription/platform accounts show tokens, no money
- Teammate's personal key: tokens only, spend private; their credential key never leaves SQL
- Proxied run counted once; another project's rows never counted
- Accounts stays ≤ 6 round trips (measured)

## Implementation notes

- Statement name is `accountUsageStatement` (not `readAccountUsage`): it must be a statement to ride
  in A's existing batch (3 round trips kept). Shared dedup predicate `COUNTED_RUN_USAGE_SQL` exported
  for slice S; signature posted on feature.insights (seq 58).
- Review fixes: a long legacy key is stored as a sha256 digest that names no credential row. Its
  kind now comes from the run session's recorded credential (`sc` join) or, for the viewer's own
  credential, from `ownByDigest`. Ownership for a session-less AI proxy row falls back to the run's
  workspace owner (bound to the project). A failed usage read shows "Not loaded" on the cards.
- Guards deleted once each (11 total, including the new ones); each turned its intended test red.
- Known limits (documented, not fixed): the proxied-run probe is not range-limited, and usage is
  range-by-`updated_at` while merged counts runs ended in range. A teammate's session-less proxy
  row on a long legacy key has no kind or owner to file it under and is not shown.
- Staging: neither staging installation is known to have a user API-key credential (staging2 uses the
  SAM AI proxy with a platform key); the live check verifies tokens on a real run, and spend is
  covered by tests.
