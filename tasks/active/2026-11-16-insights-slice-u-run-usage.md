# Insights slice U: run usage (tokens per run)

Task `01M7JKEWE3P8G5Z6KCWWVDBNJ0`. Build spec: idea `01M7HTS38KX2G78JD0ESAGMKKH` (binding:
plain D1 SQL, project scope in every predicate, "measured, or marked missing", additive
migrations). Coordinator: `01M7JK6W6PRQN64GD2MVMFZKBX`, channel `feature.insights`.

## Problem

The run receipt (slice R) shows tokens as "not reported" because SAM stores no per-run token
usage. Slice U records measured token totals per run (chat session) × model × credential, from
the harness (via the VM agent usage callback) and from the AI proxy, and shows them on the
receipt. Spend is shown only for API-key accounts, as a labelled estimate from catalog prices.

## Research: where each harness reports tokens (pinned versions)

Source inspected: the exact packages in `packages/shared/src/agent-install-manifest.json`.

| Harness     | Pinned                                                           | Where tokens are                                                                                                                                                                                                                                                                                                                   | Shape                                                                                                                                 | Per model?                                                                                            |
| ----------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Claude Code | `@agentclientprotocol/claude-agent-acp@0.102.0`                  | ACP `PromptResponse.usage` and `PromptResponse._meta.quota.model_usage[]` (`turnOutcome()` / `quotaMeta()` in `dist/acp-agent.js`)                                                                                                                                                                                                 | Per-turn tally: `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens` (quota: `cachedInputTokens`)                   | Yes, `_meta.quota.model_usage[{model, token_count}]`, increments of Claude Code's `result.modelUsage` |
| Codex       | `@agentclientprotocol/codex-acp@2.1.1` + `@openai/codex@0.160.0` | ACP `PromptResponse.usage` is `tokenUsage.last` = the LAST model request of the turn, not the turn (`buildPromptUsage(sessionState.lastTokenUsage)`). The thread's cumulative total is `total_token_usage` in the rollout JSONL `token_count` events, which the VM agent already tails for limits (`session_host_usage_probe.go`). | Rollout `info.total_token_usage`: `input_tokens` (includes cached), `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens` | No: one model per thread; model from the rollout `turn_context`                                       |
| OpenCode    | `opencode 2.2.5-sam-s1` (SAM build)                              | ACP `PromptResponse.usage` from `e.usage.turn` (`ug()` in the bundled ACP agent)                                                                                                                                                                                                                                                   | Per turn: `inputTokens`, `outputTokens`, `thoughtTokens`, `cachedReadTokens`, `cachedWriteTokens`                                     | No: attributed to the session's configured model                                                      |

- ACP `usage_update` carries context `used`/`size` (and Claude's cumulative cost) only, as known.
- Claude autonomous (background) cycles are excluded from the turn tally by the adapter, so they
  are not counted. That is an under-count, never an estimate.
- Other harnesses (Gemini, Antigravity, Vibe, Amp): report nothing to SAM → "not reported".

## Design

- **Table `agent_run_usage`** (migration = next free after 0252). One row per
  (project, chat session, source, usage epoch, model, credential key). Cumulative counters:
  - `source = 'harness'`: the VM agent keeps an in-memory per-model accumulator per SessionHost
    (epoch = random id per accumulator; Codex epoch = the Codex thread id, whose rollout total is
    itself cumulative). Each report carries the cumulative totals; the server upserts with
    per-column `MAX`, so repeats and reordering never double-count, and a lost report is healed
    by the next one. A new VM agent process starts a new epoch row, which sums.
  - `source = 'ai_proxy'`: one additive upsert per proxied upstream response with measured usage
    (never the `fallbackInputTokens` estimate). Epoch `ai_proxy`.
  - Reads prefer `ai_proxy` rows for a chat session when they exist (the proxy saw every model
    call), else `harness` rows, so `sam`/passthrough runs are not double-counted.
- **Credential key**: `credentialLimitReferenceKey()` (same key as `credential_limit_windows`,
  ≤ 71 bytes, never the legacy ciphertext). No secrets stored.
- **Report**: optional `tokenUsage` on the existing usage callback payload
  (`usageReportPayload` → `AcpSessionUsageReportSchema`). `rateLimits` may be `[]`.
  - New agent → old control plane: Valibot `v.object` strips the unknown key; `rateLimits: []`
    returns 204 (`handleAcpUsageCallback`). Verified in code.
  - Old agent → new control plane: no `tokenUsage` → no write.
  - Auth: the existing callback JWT path (`verifyCallbackToken`, node/workspace binding,
    server-side credential attribution) — no new route.
- **Shared read** `packages/operations/src/insights-run-usage.ts`: `readRunUsage(db, {projectId,
chatSessionId})` → per-model totals + source; `readCredentialRunUsage(...)` for slice A.
- **Receipt**: `tokens` becomes `{ state: 'not_reported' } | { state: 'reported', source,
models[], total, spend }`. Spend only when the run's credential is an API key
  (`cc_credentials.kind = 'api-key'`), from `PLATFORM_AI_MODELS` prices, labelled estimate.

## Implementation checklist

- [ ] Migration `0253_agent_run_usage.sql` + drizzle table in `packages/worker-core/src/schema.ts`
- [ ] Shared types: `RunReceiptTokens` in `packages/shared/src/types/insights-receipt.ts`; token
      report contract types
- [ ] API: `tokenUsage` in `AcpSessionUsageReportSchema`; `recordHarnessRunUsage()` writer
      called from `handleAcpUsageCallback` (after binding + attribution checks)
- [ ] API: AI proxy writer `recordProxyRunUsage()`; extract cache tokens from Anthropic/OpenAI
      usage (JSON + SSE); wire passthrough + platform-anthropic routes (not the SAM agent loop)
- [ ] Operations: `insights-run-usage.ts` read (project scope in every predicate) + spend estimate
- [ ] Receipt: parallel read, `tokens` wired, round trips stay ≤ 8
- [ ] Web: receipt panel renders tokens per model / "not reported"; Playwright 375/1280
- [ ] VM agent: accumulator + `tokenUsage` in `buildUsageReportRequest()`; Claude/OpenCode from
      `PromptResponse` (incl. cancelled turns); Codex from rollout `total_token_usage`; token
      reports never coalesced away
- [ ] Docs: receipt/insights docs mention tokens sources and "not reported"
- [ ] Post migration number + read interface on `feature.insights`

## Tests

- [ ] Real SQL engine: project-scope attack (foreign project chat session id) + owner control
- [ ] Same report twice → counted once; reordered reports → max; proxy additive
- [ ] Contract test VM agent → API: Go payload JSON fixture parsed by the API schema/handler
- [ ] Go: report builder with and without token data; Claude/OpenCode prompt-response parsing;
      Codex rollout total parsing
- [ ] Receipt: reported, not reported, proxy-preferred, spend only for API-key

## Acceptance criteria

- A staging task run with Claude Code records `agent_run_usage` rows and the receipt shows them.
- A harness reporting nothing shows "not reported".
- Duplicate/reordered reports never double count.
- Old/new agent ↔ control plane combinations keep working (limits still recorded).

## Staging

Lease check for `staging` and `staging2`, reserve, delete nodes (rule 27), deploy, one small
Claude Code task, verify rows + receipt, delete workspace, release, announce.
