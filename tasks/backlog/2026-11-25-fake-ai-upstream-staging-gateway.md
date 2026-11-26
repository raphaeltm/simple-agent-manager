# Fake AI upstream on staging (AI Gateway custom provider)

Follow-up to PR #3009 (box half). Task 01M89E0MVWWBBXQH5XQ58R1RWG, coordinator 01M7XCE59V5X0WTNF1X3NFZP5J.

## Problem

Installations with an AI Gateway (staging, hosted) price monthly spend only from AI Gateway logs, so the
in-process fake from #3009 is deliberately disabled there. Proving metering and the cap on staging needs
the fake to go THROUGH the real gateway so the gateway logs real usage and cost.

## Plan (spike first; stop and report before building out)

1. Spike: a staging-only deploy step creates an AI Gateway custom provider (`custom-sam-test-upstream`,
   base_url = a gated public fake route on the API Worker) idempotently with the pipeline's existing
   GitHub-secret CF token (rule 83: secret -> env -> curl, never echoed). If that token lacks
   custom-provider permission: STOP and tell the coordinator (Raphaël's call; no other tokens, no manual
   creation). The agent CF_TOKEN cannot create custom providers (10000 "Authentication error", 2026-11-25).
2. One allowlisted call through the gateway with `cf-aig-metadata` (userId) and `cf-aig-custom-cost`;
   read the logs API: do entries carry tokens, cost and metadata for a custom provider (Anthropic and
   OpenAI shapes)? Docs do not say.
3. If yes: build gateway routing behind the same locks, plus tests; prove on staging (user cap $1,
   $0.40 calls, wait for the hourly cron, then refusal). If no: drop and report that hosted dollar caps
   cannot be proven with a fake.

## Acceptance criteria

- [ ] Spike result reported to the coordinator before building
- [ ] Production stacks can never create the custom provider or route to it (test)
- [ ] Staging live proof, or a recorded decision to drop
