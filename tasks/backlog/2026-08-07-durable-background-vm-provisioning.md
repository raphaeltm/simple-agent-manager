# Make Background VM Provisioning Durable Beyond `waitUntil()`

## Problem

Several HTTP routes return a response and continue VM provisioning through
`executionCtx.waitUntil()`. Hetzner's bounded capacity retry can legitimately
sleep for 15 seconds and then 30 seconds before a third attempt, exceeding
Cloudflare's 30-second post-response `waitUntil()` limit. Cloudflare cancels
unsettled promises at that limit, which can interrupt provisioning before its
terminal cleanup and leave records in an in-progress state.

This behavior predates the 2026-08-07 Hetzner classifier correction, but that
correction makes a frequently observed production capacity response enter the
existing retry loop and therefore makes the durability gap more visible.

## Evidence

- `apps/api/src/routes/nodes.ts` passes `provisionNode()` directly to
  `executionCtx.waitUntil()` after creating the node record.
- `apps/api/src/routes/workspaces/crud.ts` runs node provisioning and workspace
  continuation inside `executionCtx.waitUntil()`.
- `apps/api/src/routes/deployment-environment-lifecycle.ts` puts a provisioned
  environment's continuation in `waitUntil()`.
- `packages/providers/src/hetzner.ts` defaults capacity backoff to 15s, 30s,
  60s, then 120s, within a five-minute total budget.
- Cloudflare's official Context API documentation states that HTTP-triggered
  `waitUntil()` work is canceled 30 seconds after the response if it has not
  settled: https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil
- TaskRunner provisioning already runs from a Durable Object lifecycle instead
  of an HTTP-route `waitUntil()` and is not subject to this specific limit.

## Implementation Checklist

- [ ] Inventory every VM/deployment provisioning continuation started from an
      HTTP route via `waitUntil()`.
- [ ] Move long-running provisioning to a durable execution primitive such as a
      Durable Object alarm, Workflow, or Queue; keep the HTTP response contract
      asynchronous.
- [ ] Persist enough operation identity/state to resume idempotently after
      retries, duplicate delivery, or isolate eviction.
- [ ] Ensure terminal failures always update or clean up node, workspace, and
      deployment-environment records.
- [ ] Add vertical-slice tests that return the HTTP response first, advance past
      30 seconds, and prove provisioning either succeeds or terminalizes state.
- [ ] Add duplicate-delivery and retry tests proving external resources are not
      allocated twice.
- [ ] Verify the changed flow on staging with a real VM before merge.

## Acceptance Criteria

- [ ] No VM provisioning lifecycle relies on HTTP `waitUntil()` for work that
      can exceed 30 seconds.
- [ ] Capacity retry may use its configured five-minute budget without the
      request lifecycle canceling it.
- [ ] Interrupted/retried execution resumes safely and cannot strand a record in
      `creating` or allocate duplicate VMs.
- [ ] Automated tests cover success, terminal capacity exhaustion, cancellation,
      and duplicate delivery across the durable boundary.

