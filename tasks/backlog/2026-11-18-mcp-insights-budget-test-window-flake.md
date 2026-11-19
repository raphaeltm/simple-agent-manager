# Flaky test: project_insights budget test fails across a rate-limit window boundary

## Problem

`apps/api/tests/workers/mcp-project-insights.test.ts` > "two tokens for one chat share one budget"
failed on PR #2889's CI (job 134947823444, Durable Object Workers shard 3/7) with
`expected undefined to be -32000`. Its requests ran from 16:29:59.978Z to 16:30:00.1Z, so the
per-window budget reset mid-test and the expected refusal never came. The PR does not touch MCP or
insights code.

## Acceptance Criteria

- [ ] The test controls the clock (fake timers or an injected window start) so it cannot straddle a
      window boundary
- [ ] A variant that starts 10 ms before a boundary passes deterministically
