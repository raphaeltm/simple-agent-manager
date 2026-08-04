# Flaky test: `vultr.ip_poll_error` assertion races a 20 ms wall-clock timeout

## Problem

`packages/providers/tests/unit/vultr-lifecycle.test.ts` →
`VultrProvider createVM > warns and returns empty IP when a poll GET fails (non-404) before timeout`
fails intermittently:

```
AssertionError: expected "vi.fn()" to be called with arguments: [ 'vultr.ip_poll_error', …(1) ]
 ❯ tests/unit/vultr-lifecycle.test.ts:282:18
```

The test drives the IP-poll error path with **real wall-clock timers**:

```ts
const provider = newProvider(fetchMock, { ipPollTimeoutMs: 20, ipPollIntervalMs: 5, logger: { warn, ... } });
```

It needs at least one poll iteration — an async `fetch` returning 500, plus the
`catch` that emits `vultr.ip_poll_error` — to complete inside a 20 ms budget. On a
loaded runner the timeout can win the race, so `createVM` returns an empty IP via
the timeout path and the `ip_poll_error` warning is never emitted. The assertion
then fails even though the behavior under test is correct.

The test name ("before timeout") states the ordering it needs; nothing enforces it.

## Evidence

- CI run 30877645403, job 91892263600 (`Test`): 1 failed / 29 passed test files,
  `Failed: @simple-agent-manager/providers#test:coverage`.
- Reproduced locally on 2026-08-04 during PR #1727 (a docs-only branch that touches
  no provider code): failed on one `pnpm test`, passed on an immediate re-run of
  `npx vitest run` in `packages/providers` with 509/509 green.

## Fix options

1. **Fake timers** (preferred). Drive the poll loop with `vi.useFakeTimers()` and
   advance deliberately, so the assertion no longer depends on machine speed.
2. **Widen the asymmetry.** Raise `ipPollTimeoutMs` well above the interval (e.g.
   500 ms / 5 ms) so a single iteration comfortably precedes the deadline. Cheaper,
   but still timing-based and slower.
3. **Assert the outcome, not the race.** Split into two tests: one asserting the
   error path emits `ip_poll_error` (with a timeout that cannot expire first), and
   one asserting the timeout path.

Audit the sibling poll/timeout tests in the same file while fixing — any other test
whose assertion depends on winning a real-time race has the same defect.

## Acceptance Criteria

- [ ] The test no longer depends on real wall-clock timing
- [ ] It still fails if `vultr.ip_poll_error` stops being emitted on a non-404 poll
      failure (verify by removing the warn call — the test must go red)
- [ ] The timeout path retains its own coverage
- [ ] `packages/providers` test suite passes 20 consecutive runs locally
- [ ] Other timing-raced tests in the file are fixed or documented
