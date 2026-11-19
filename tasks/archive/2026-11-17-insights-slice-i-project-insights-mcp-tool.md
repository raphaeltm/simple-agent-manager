# Insights slice I: `project_insights` sam-mcp tool

Task 01M7M2BXVYP904M1BNNBQCYCFR. Build spec: idea 01M7HTS38KX2G78JD0ESAGMKKH (slice I). Channel
`feature.insights`. Coordinator task 01M7JK6W6PRQN64GD2MVMFZKBX.

## Problem

Agents cannot read the shipped Insights numbers (run receipt, Flow/CI health, Agent setups, phase
timings, Accounts) from sam-mcp. Slice I serves the same shared reads behind one tool, project
scoped, numbers only, with a per-session rate limit.

## Research findings

- Shared reads already exist in `packages/operations`: `runReceipt` (insights-receipt.ts),
  `projectFlow` (insights-flow.ts), `projectSetups` (insights-setups.ts), `projectAccounts`
  (insights-accounts.ts), and the core `phaseDurationStats` (insights-phase-timings.ts, no
  authorization, requires a phase list).
- Slice R exposed `sam_run_receipt` as a catalog operation (`insights-operations.ts`); the
  Connector (`routes/connector-mcp.ts`) lists every op in `registry.ts` automatically.
- sam-mcp tools are hand-written JSON schemas (`tool-definitions-*.ts`) plus handlers in
  `tool-handler-table.ts`. Handlers that reuse catalog ops go through `runWorkspaceOperation`
  (`workspace-operation-adapter.ts`), which forces the token's project and rejects a differing
  `projectId`. `authorizeProjectOperation` re-checks `actor.workspace.projectId`.
- Text fields that must not reach agents: receipt `title`, `outcome.pullRequest.title/url`,
  `account.accountName`, `slowedDown[].question` (ask/attention text); Flow `waitingIdeas[].title`
  and `note`; Setups teammate profile labels; Accounts `usage.credentialReference/credentialId/
credentialName` and credential-id account keys (`cred:<id>`).
- Atomic per-key counter already exists: `McpRateCounter` DO (`durable-objects/mcp-rate-counter.ts`,
  binding `MCP_RATE_COUNTER`) with `consume(windowStart, resetAt, limit)`; no migration needed.
- Typed admin settings: definitions in operations (`INSIGHTS_*_SETTINGS`), registered in
  `services/admin-settings-features-definitions.ts`, resolved per request via the per-isolate cache.
- Round-trip budgets (rule 60): receipt ≤ 8 (already at most 8, incl. the account-name read),
  flow ≤ 12 (at most 10), setups ≤ 6 (at most 5), accounts ≤ 6 (at most 4); phases new.

## Implementation checklist

- [x] `phaseDurationStats`: `phases` optional (omitted = every phase for the skill/profile)
- [x] `runReceipt` option to skip the account-name read (agent view never shows it) so receipt +
      rate-limit RPC stays ≤ 8
- [x] `packages/operations/src/insights-agent.ts`: `projectInsights(ctx, input)` dispatch + numbers-only
      projections per method; `projectPhaseStats` authorizes then calls the core
- [x] Catalog op `sam_project_insights` in `insights-operations.ts` (Connector lists it)
- [x] Settings `insights.agentToolCallsPerWindow`, `insights.agentToolWindowSeconds` (typed admin
      runtime settings, Operations group)
- [x] sam-mcp: tool definition `project_insights` (method arg), handler: validate with the op
      schema → per-session rate limit (McpRateCounter, key `project_insights:<chatSession|agentSession|workspace>`)
      → `runWorkspaceOperation`
- [x] Tests: project-scope attack + owner control (real SQL), rate limit at-limit + window rollover,
      contract test through the real MCP route per method, projection strips text fields
- [x] Docs: MCP/API reference, server instructions only if needed, tool description short
- [x] Staging: every method against real data, cross-project rejection, rate limit

## Acceptance criteria

- `project_insights` with methods receipt, flow, setups, phases, accounts works through `/mcp`
  with a task token; numbers only.
- A token for project A asking for project B is rejected; owner control succeeds.
- The N+1th call in a window is rejected with a retry time; the next window admits again.
- Limit and window are admin runtime settings.
- Each method stays within its surface's round-trip budget (+1 rate-limit RPC), stated in the PR.
- `sam_project_insights` is listed by the Connector from the same definition.

## Notes

- Review (2026-11-17): security M2 found the shared receipt showed spend when the run's account
  was unrecorded; fixed with `receiptSpendVisible` (fail closed). Docs edit had dropped two
  headings; restored. Projections now copy fields one by one (no spreads).
- Deferred by design: the per-chat budget can be multiplied by new chats (security M1); new chats
  come only from dispatch/triggers and every call also spends the task-keyed /mcp HTTP limit.
- The Connector path spends the per-user `connector.readRateLimitPerMinute` budget, not the chat one.
- Staging (2026-11-17, head f82f114d1, deploy run 44082452764): a real Claude Code agent on staging
  (task 01M7MRYVPXAB9XERY3ZKM09Q04, Test Project 1, Instant runtime) called every method; values match
  the REST pages; cross-project, missing-task and stray-argument refusals; 30 admitted then the
  per-chat refusal. The VM-runtime attempt failed at node provisioning (GCP STS exchange 400),
  unrelated to this change; reported on feature.insights.
- Codex review P2: per-phase sampling cap (rule 65) fixed; `phaseNames` filter added.
