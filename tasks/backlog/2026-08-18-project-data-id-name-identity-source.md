# Evaluate `DurableObjectId.name` as the ProjectData identity source

**Created**: 2026-08-18
**Source**: review finding on PR for `tasks/active/2026-08-18-do-roundtrip-ensure-project-id-and-chat-agent-state.md`

## Problem

`ProjectData` learns its own `projectId` from a `do_meta` row written by
`ensureProjectId`, because the DO is addressed via `idFromName(projectId)` and
`DurableObjectId.toString()` is a one-way hex digest.

During review it was established that this is **not the only option**:
`@cloudflare/workers-types` declares `DurableObjectId.name?: string`, and an
empirical probe in the vitest workers pool (workerd) showed the addressing name
is populated inside the DO **both** on an RPC-driven call **and** inside an
`alarm()`-triggered instantiation:

```
viaRpc:   { name: "probe-91bb...", hasNameProp: true, idString: "34b82045…" }
viaAlarm: { name: "probe-91bb...", hasNameProp: true }
```

If that holds in production Cloudflare, `ensureProjectId` and the `do_meta` row
could be removed entirely — which is what idea `01M09SKVNJGJNJY2WGCZ6D89XZ`
item #5 originally proposed.

## Why it was not done in that PR

- `name` is typed optional and documented as present only for
  `idFromName`-derived ids; the probe proves workerd behavior, not production.
- This identity drives **D1 writes** (project summary write-back, workspace
  deletion during idle cleanup), so a wrong or absent value has real blast radius.
- That PR was explicitly barred from deploying to staging (verification is
  consolidated at the UI-performance program's integration PR), so production
  behavior could not be confirmed.

## Acceptance Criteria

- [ ] Confirm on a deployed environment whether `ctx.id.name` is populated for a
      ProjectData DO woken by an alarm with no prior stub call in that isolate
- [ ] Cite Cloudflare's documented guarantee (or absence of one) for `name`
      propagation into alarm-triggered instantiations
- [ ] If reliable: remove `ensureProjectId` + the `do_meta.projectId` row + the
      per-isolate ensure memo (`apps/api/src/services/project-data-ensure-memo.ts`),
      saving the one remaining ensure RPC per isolate/DO
- [ ] If not reliable: record the negative result in
      `apps/api/src/durable-objects/project-data/index.ts` so this is not
      re-investigated
- [ ] Either way, keep a fail-closed guard: an unidentifiable DO must never write
      to D1 (see `apps/api/tests/workers/project-data-project-id-guarantee.test.ts`)

## References

- `apps/api/src/durable-objects/project-data/index.ts` (`ensureProjectId`, `getProjectId`)
- `apps/api/src/services/project-data-ensure-memo.ts`
- `.claude/rules/05-preflight.md` — assumption verification before building on a claim
