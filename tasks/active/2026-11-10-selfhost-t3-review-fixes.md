# Self-host pass 2, T3 follow-up: review fixes for "run the API without Cloudflare-only services"

Task 01M73M203MT370AVK5MD6RTEDM. Coordinator: 01M72KTXWD8FJ0Z7TXKN5GF20J. Base: `sam/selfhost-pass-2`
(merge 809245135 of PR #2622). Scope boundary: T5 (01M73HRQ579XPSW3WWPZ1FWPE8) owns outbound-fetch SSRF,
redirects, network-hosts.ts and presign credential scope.

## Hard constraint
A Cloudflare deployment with every binding and setting present behaves exactly as today (tests in both).

## Research findings
1. Monthly cap. Readers of the cached monthly cost (`ai-monthly-cost:{user}:{YYYY-MM}` via
   `getCachedMonthlyCost`): only `checkMonthlyCostCap` <- `checkAiUsageGate`, called by
   routes/ai-proxy-admission.ts (`enforceUsageGate`, /ai/v1 chat + responses), routes/ai-proxy-passthrough.ts,
   routes/ai-proxy-anthropic.ts (2 sites), durable-objects/sam-session/agent-loop.ts,
   durable-objects/sam-session/operator/agent.ts. Writer: `runMonthlyCostAggregation` (hourly) from gateway logs
   only. GET /api/usage/ai/budget computes `monthCostUsd` from gateway logs directly. Without a gateway the cache
   is never written -> fail-open forever. SAM's own records (`incrementProviderUsage`) carry cost 0 on the proxy
   and custom endpoint paths (no price for an operator's model), so a cap from SAM records would be fiction.
   Decision: make the cap explicitly unavailable without an addressable gateway (API flag, PUT refuses a non-null
   cap, UI hides the input and tells the user/admin, admin AI proxy config says so).
2. Undercount: `incrementExtractedUsage` defaults output to 0; proxy never sets `stream_options.include_usage`.
   Operator estimator `estimateTokens` (bytes/3) in operator/model.ts. Custom-endpoint call sites that account
   usage: /ai/v1 forwardToWorkersAI (openai-compatible target) and agent-loop callOpenAIChatLLM with endpoint.
3. `usePlatformCapabilities` inside `AcpConversationItemView` (per row). Row owners: SessionMessageView
   (via CommentableConversationItem), ReaderConversation, WorkspaceChatView.
4. `readConfiguredBaseUrl` runs in `resolveWorkersAiChatTarget` before `AbortSignal.timeout` (task titles,
   fetchWorkersAIChatCompletion) and before the timer in debug-agent-tools `complete`.
5. diagnosis-runner-do.test.ts race tests hold only the custom endpoint.
6. agent-loop.ts `sam.llm_error` logs 500 chars of body for every target incl. the custom endpoint.
7. client-ip.ts: malformed CF-Connecting-IP falls back to XFF; setup.ts falls back to User-Agent;
   node-lifecycle.ts heartbeat IP and workspaces/local-forward.ts read the raw header. T3 canonicalised IPv6
   (byte change vs pre-T3 verbatim values).
8. Partial Cloudflare (AI_GATEWAY_ID unset, CF token + account present) behaviour changes and 400/500->404/403
   changes need tests + public docs note.

## Checklist
- [x] 1 monthly cap unavailable without gateway: capability, gate, budget GET/PUT, admin AI proxy config, UI (eba74739a, d3e1e6759, 91832a531)
- [x] 2 include_usage for custom endpoint streams + shared estimator for missing output (proxy + agent loop) (b5724a341)
- [x] 3 capability read once per list owner, passed as primitive prop; observer/re-render test (399574a7b)
- [x] 4 settings read inside the time budget (task title, diagnosis); deferred-read tests (bbcc57584)
- [x] 5 diagnosis race tests over both routes (2766d6242, ordering fix d3e1e6759)
- [x] 6 sanitized error reason, no third-party bodies (agent loop + proxy) (c9222bbcd, parse window d3e1e6759)
- [x] 7 one client-IP rule; all call sites; byte-identical IPv4/IPv6 test (3d1b4cef7; BetterAuth d3e1e6759)
- [x] 8 partial-Cloudflare tests + docs note in reference/configuration.md (9a2407803)
- [x] Each fix proven discriminating (revert -> named test red): recorded in the PR body table
- [ ] Local gates, reviewers, draft PR, CI dispatch, channel publish

## Decisions
- Item 1: explicitly unavailable (not enforced from SAM's records): SAM's own usage carries no
  price for an operator's model, so a dollar figure would be invented. Available only when the
  cost cron can read gateway logs (gateway id + account id + CF_API_TOKEN). A cap saved earlier is
  reported `enforced: false`, not enforced (fail-closed would block AI for a convenience control).
- Item 7: only CF-Connecting-IP is trusted (also for BetterAuth); missing/malformed -> one shared
  bucket; well-formed values verbatim (no canonicalisation) so keys stay byte-identical.
- Rule 18 splits done as separate pure-extraction commits: agent-loop-streams.ts,
  components/ai-usage/*, ai-budget-settings.ts + ai-monthly-cost-cap.ts.
  routes/node-lifecycle.ts (848 lines) carries a pre-existing FILE SIZE EXCEPTION; +1 line.

