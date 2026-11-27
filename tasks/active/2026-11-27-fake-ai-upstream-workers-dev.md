# Fake AI upstream on staging via a workers.dev Worker

Task 01M8EC89ZN067Z40863FPAFKWR (coordinator 01M7XCE59V5X0WTNF1X3NFZP5J). Follows #3009 (self-hosted VM
half), #3015 (Cloudflare spending limits) and the unmerged spike branch `sam/fake-ai-upstream-staging-spike`.
Supersedes `tasks/backlog/2026-11-25-fake-ai-upstream-staging-gateway.md`.

## Problem

Self-hosted Cloudflare installs price monthly AI spend from AI Gateway logs, so the in-process fake from
#3009 cannot prove the dollar cap there. Calls must travel through the real gateway to a fake upstream.
The spike's upstream (`api.sammy.party/ai/_test-upstream`) sits in the protected zone and was challenged.
Decision (Raphaël, 2026-11-27): host the fake as a tiny staging-only Worker on its own workers.dev address,
gated by a fixed non-secret header, created only by the staging pipeline.

## Research findings

- Staging account workers.dev subdomain: `simple-agent-manager-staging`. Gateways `sam` and `sam2`, both
  authenticated. Custom provider `sam-test-upstream` exists, `enable: false`, base_url in the zone.
- CF custom provider API: create (POST), get, list, delete. No documented update, so ensure = keep when
  equal, else delete and recreate. `headers` field: extra headers the gateway sends to the provider, so the
  gating header lives on the provider config, not in the proxy.
- The agent CF_TOKEN can authenticate gateway calls (`cf-aig-authorization`) and read the account, but
  cannot write custom providers. The pipeline token can (spike, 2026-11-25).
- `resolveAiTestUpstream` returns null where a gateway exists (`hasLocalAiCostMetering`). Its `fetch`
  seam is the single place to reroute faked calls to `custom-<slug>`.
- Faked Anthropic calls carry no auth headers (`testUpstreamAnthropicAuth`), so gateway mode must add
  `cf-aig-authorization` (the same token real calls use) and nothing else secret.
- Admission (#3015): gateway total (hourly cron, KV) + local estimate since asOf, against
  min(user cap, admin ceiling). If the gateway logs $0 for the custom provider, the cron resets spend.

## Checklist

- [ ] Move canned responses into `packages/ai-proxy` (shared by API in-process fake and the Worker)
- [ ] Fake Worker handler: POST only, gate header else 404, JSON+SSE Anthropic/OpenAI, cost from header/query, never fetches
- [ ] Deploy script: staging-only guard (refuses production), wrangler deploy on workers.dev with no route, ensure custom provider (base_url + gate header + enable)
- [ ] One workflow step calling the script, CF_API_TOKEN straight to wrangler/CF API, no new secrets
- [ ] Guard tests: production refused by script, production-shaped Env never routes to fake
- [ ] Spike: one gateway call, read logs: tokens, cost, metadata.userId
- [ ] If cost returned: gateway routing in `resolveAiTestUpstream` behind existing gates + allowlist; Worker vars on staging stacks only
- [ ] Tests: non-allowlisted user reaches real upstream; production Env never routes
- [ ] Staging proof: $1 ceiling, $0.40 calls, refusal on 3rd/4th call via cron/estimate path, admin usage page, switch off
- [ ] Docs: configuration reference + self-host README mention

## Acceptance criteria

- [ ] Fake Worker exists only on staging workers.dev, created by the pipeline
- [ ] Spike result reported to coordinator
- [ ] Live proof or recorded decision to drop
