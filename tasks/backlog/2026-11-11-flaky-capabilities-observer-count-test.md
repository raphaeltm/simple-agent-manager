# Flaky web test: capabilities observer count independent of conversation length

## Problem

`apps/web/tests/unit/components/project-message-view.test.tsx` →
"ProjectMessageView — platform capabilities read › keeps the capabilities observer count
independent of conversation length" fails intermittently in CI, in both directions:

- CI run 42960812381 attempt 1 (2026-11-11 04:53Z): `expected 2 to be 1`
- the same run, attempt 2 (05:17Z): `expected 1 to be 2`

It passed 3/3 locally on the same commit and passed on integration-branch CI run 42955986497
(548012733). The failing PR (#2647) changes only `scripts/selfhost/` and `deploy/selfhost/`, so the
flake belongs to the integration branch `sam/selfhost-pass-2`. The test came in with d3e1e6759
(T3 follow-up review fixes).

## Context

The test renders the view with a 2-message and a 40-message conversation and compares how many
TanStack Query observers the capabilities query has (`observersFor`). It samples the count at one
moment. Under CI coverage instrumentation, mount and unmount timing differ between the two renders,
so the sampled count varies (rule 62: ordering-dependent tests must control the midpoint).

## Acceptance Criteria

- [ ] `observersFor` waits for a settled state, or counts observers deterministically (e.g. after
      `await waitFor` on a rendered marker and with the previous render fully unmounted), so both
      renders are measured at the same point
- [ ] The test still fails if every message row subscribes to the capabilities query (prove it
      discriminating once)
- [ ] 20 consecutive runs pass under `pnpm --filter @simple-agent-manager/web test:coverage`
