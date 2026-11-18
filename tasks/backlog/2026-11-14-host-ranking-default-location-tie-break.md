# Host ranking still prefers the platform default location when nothing asked for one

## Problem

When work has no explicit location and no wake preference, `resolveVmLocation()`
(`packages/scheduler-core/src/placement-field-resolution.ts`) falls back to the provider
default, or to `DEFAULT_VM_LOCATION` (`nbg1`) when no provider is resolved.
`compareReusableHosts()` (`apps/api/src/durable-objects/task-runner/task-placement-strategy.ts`)
then uses that value as a tie-break after startup backlog and before the pool strategy. So among
reusable hosts with equal backlog, those in `nbg1` win, even though nobody asked for a location.

This predates the 2026-11-14 removal of project/profile provider and location: projects without
a default already resolved to `nbg1`. After that change it applies to every project, and it sits
awkwardly with "the compute pool decides placement".

## Context

Found by the architecture review of the change that removed project/profile provider and
location settings (branch `sam/agent-forget-one-recently-7d6th2`). The tie-break never excludes
a host or offering; it only orders hosts that already fit, after backlog.

## Acceptance Criteria

- [ ] Placement records whether `vmLocation` came from an explicit request, a wake preference, or
      a fallback default.
- [ ] `compareReusableHosts()` applies the location tie-break only for explicit or preferred
      locations, and falls through to the pool strategy otherwise.
- [ ] Tests: equal-backlog hosts in `nbg1` and elsewhere are ordered by pool strategy when no
      location was requested; a wake preference still ranks the previous region first; an
      explicit location still ranks before backlog.
