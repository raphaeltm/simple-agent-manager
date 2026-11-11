# Flaky API test: node tunnel cleanup fails closed on a different Cloudflare account

## Problem

`apps/api/tests/unit/services/node-tunnel-lifecycle.test.ts` → "node deletion and stale-incarnation
cleanup › fails closed when the configured Cloudflare account …" failed in CI run 42964923220
(2026-11-11 05:35Z, head 3113325cc):

```
- "lastError": StringContaining "different Cloudflare account",
+ "lastError": null,
  "status": "cleanup_pending",
```

The journal row had `status: 'cleanup_pending'`, but `lastError` was still null when the assertion
at line 483 ran, right after `await runNodeTunnelCleanupSweep(env)`. The test passed 26/26 three
times locally on the same commit and passed on integration-branch CI (548012733). The PR under test
(#2647) changes only `scripts/selfhost/`, `deploy/selfhost/` and a task file.

## Context

Found while dispatching CI for T8 (task 01M74C1P42QSEZM3DGJW64S4K8). This was one of two unrelated
flakes in three runs; the other is
`tasks/backlog/2026-11-11-flaky-capabilities-observer-count-test.md`. Possibly the sweep records the
refusal through a path that is not awaited (`waitUntil`, a fire-and-forget journal write), so the
assertion can run first.

## Acceptance Criteria

- [ ] Find whether `runNodeTunnelCleanupSweep` writes `lastError` on a path the caller does not
      await, and make the test (or the sweep) wait for that write deterministically
- [ ] The test still fails if the account-mismatch guard is removed (prove it discriminating once)
- [ ] 20 consecutive runs pass under `pnpm --filter @simple-agent-manager/api test:coverage`
