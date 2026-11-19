# Misleading error when a direct node request names an offering whose pool size differs from the default

## Problem

`POST /api/nodes` with `{ provider: 'hetzner', providerInstanceType: 'cx23' }` and no `vmSize` returns
`400 Requested native compute offering 'cx23' is not active in the current default compute pool.` even
though `cx23` IS an active workspace candidate in that pool.

The route defaults `vmSize` to `DEFAULT_VM_SIZE` (`'medium'`, `apps/api/src/routes/nodes.ts`), the
capacity-pool selection then filters candidates to `machine_size = 'medium'`, and `cx23` is filed as
`'small'`, so `selectCapacityCandidate` (`apps/api/src/services/canonical-vm-allocation.ts`) finds no
match and `requestedNativeOfferingUnavailableMessage` reports the offering as inactive. Passing
`vmSize: 'small'` makes the same request succeed.

## Context

Found 2026-11-16 while running the L5a outbound-fetch staging harness on staging2 (`sammy2.party`),
task `01M7FCZD2APNNX1T08Z6ZJGMC7`, PR #2751. Read-only D1 check: the installation pool's `cx23`
rows are `status='active'`, `machine_size='small'`, in fsn1/hel1/nbg1.

## Acceptance Criteria

- [ ] An explicit `providerInstanceType` either implies its own machine size, or the error names the
      real cause (the requested offering is size `small`, the request asked for `medium`).
- [ ] A route test at `POST /api/nodes` covers an explicit offering whose size differs from the default
      `vmSize`, with a control where the sizes match.
