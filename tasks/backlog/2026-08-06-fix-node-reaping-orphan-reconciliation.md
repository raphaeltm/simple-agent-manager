# Fix node reaping and add provider-side orphan reconciliation

## Problem Statement

Production nodes can run indefinitely. Two nodes survived 1932h and 2135h (80–89 days)
and were only cleared by a manual bulk delete. Production currently holds 9 of the 10
servers in the Hetzner account, which is **shared with staging**, so stale production
nodes directly block staging verification (PR #1697's staging deploy 403'd with
`server limit reached`).

Investigation found the reported symptom is real but the attributed cause was wrong,
and the true cause is a **larger, live, user-facing production outage**: the 5-minute
cron sweep has no error isolation, so a throw in the node-cleanup sweep silently kills
every sweep after it — including user-facing cron triggers.

## Research Findings

All findings verified against live production (CF account `e2eb9a8d…`, D1 `sam-prod`,
observability D1 `sam-observability-prod`) on 2026-08-06.

### F1 — SAFETY-CRITICAL: the three "zombie" nodes are NOT orphans

`01KX84MCG1YN1TQVWR60B3G70A`, `01KXAR1T3XCQKKPBEJEERQ2PSZ`, `01KXVVJBSG95TYMWA0WY6K3MG9`
are all `node_role='deployment'`, `node_mode='exclusive'`, healthy and heartbeating.
Each backs an **active** `deployment_environments` row (projects `01KWEZ8YWD…`,
`01KX96ZPGC…`, `01KXJ72MJK…`). Deployment nodes never host workspaces — zero workspaces
is their normal steady state.

Implementing the request literally ("reap running nodes with zero live workspaces past
an idle threshold") **would have destroyed three users' live production applications.**
Every reaper must gate on `node_role='workspace'`.

### F2 — the six "wave" nodes are actively in use

The 6 nodes from the 2026-08-05 21:56–22:22 wave host **19 running workspaces**,
including this task's own workspace. `node_mode='shared'` — they are being correctly
reused. Exactly **one** genuine orphan exists: `01KZA0A8MCJFTNMDWE77PWGQWK`, whose only
workspace stopped at 2026-08-06T00:47:27Z.

### F3 — PRIMARY ROOT CAUSE: the 5-minute cron has zero error isolation

`apps/api/src/index.ts:936-974` runs 13 sweeps as a flat sequence of bare `await`s.
Line 949 is `await runNodeCleanupSweep(env)`. When it throws, everything after it is
skipped and `cron.completed` never logs.

Evidence (independent signals, all agreeing):

| Signal | Position | Last seen |
|---|---|---|
| `stuck_task_heartbeat_skip` | line 939 (**before**) | 2026-08-06T08:10:44Z ✅ alive |
| `max_lifetime_node_cleanup` | line 949 | 2026-08-05T20:25:08Z ❌ 11.8h silent |
| `stopped_node_handoff_cleanup` | line 949 | 2026-08-05T18:41:17Z ❌ |
| `orphaned_workspace` | line 949 | 2026-08-05T19:40:20Z ❌ |
| `trigger_executions` rows | line 955 | 2026-08-05T18:45:24Z ❌ |

Production has **21 active user cron triggers** whose earliest `next_fire_at` is
2026-08-06T03:00:00Z — 5 hours overdue — with `last_triggered_at` stuck at
2026-08-05T18:45:24Z. User-scheduled work has not fired for ~13 hours.

Also skipped every run: observability purge, trigger-execution cleanup, session-task
repair, setup-session sweep, compose-artifact cleanup, compute-usage cleanup, trial
expiry.

The tell is already in the code: `index.ts:937` says *"Recover stuck tasks first so
unrelated cleanup failures cannot suppress lifecycle repair."* A previous change hit
this exact fragility and worked around it by **reordering one sweep** instead of adding
isolation.

### F4 — likely throw source is a rule-47 violation

`node-cleanup.ts` phases 1–5 have **no `LIMIT`** (unbounded candidate sets), and phase 4
awaits `stopWorkspaceOnNode` → VM-agent fetch on the **interactive** 30s
`DEFAULT_NODE_AGENT_REQUEST_TIMEOUT_MS`. Unbounded candidates × 30s dead-node timeouts
exceeds the Worker wall-clock/subrequest budget. `.claude/rules/47` explicitly forbids
background control loops inheriting interactive timeouts.

### F5 — the orphan detector can never fire, and only flags anyway

Phase 5 (`node-cleanup.ts:552-596`) is the only orphan-node detector. Two defects:

1. It **only flags** (`orphanedNodesFlagged++`) — it never destroys.
2. Its predicate `n.updated_at < now - grace` is **structurally unsatisfiable for a live
   node**: `updated_at` is byte-identical to `last_heartbeat_at` on all 9 running nodes,
   because every heartbeat bumps it. It uses a **liveness** timestamp as an **idleness**
   proxy — the opposite of what is needed.

Confirmed: recoveryType `orphaned_node` has **zero events all-time**.

### F6 — max lifetime is not a real backstop

Phase 2 skips any node with an active workspace (`node-cleanup.ts:359-372`); the comment
at `:332-334` states the absolute ceiling was deliberately removed. A node with a stuck
`running` workspace never ages out — which is how the 1932h/2135h nodes survived. Both
were finally cleared manually (identical `updated_at` 2026-07-20T08:15:29.257Z).

`stale_warm_node_cleanup` also has **zero events all-time**, and no node currently holds
`warm_since`. (Not over-claimed as "never fired ever" — all destroy paths null
`warm_since` — but the warm path has demonstrably never destroyed anything.)

### F7 — rule 51 (class-guard) gaps

| Query | Guard |
|---|---|
| `node-cleanup.ts` phases 0,1,2,3,5 | ✅ has `node_class != 'user-owned'` |
| `deployment-environment-lifecycle.ts:83` | ✅ has it |
| **`deployment-environments.ts:650-658`** | ❌ **missing** — leads straight to `deleteNodeResources` |
| **`node-cleanup.ts:456-471`** (orphan workspace stop) | ❌ no join to `nodes` at all |
| **`node-cleanup.ts:603-608`** (stale stopped workspace delete) | ❌ no join to `nodes` at all |

### F8 — provider labels carry no environment marker

`apps/api/src/services/nodes.ts:266-270` sets `{ node, managed, role }`; the server name
is `node-<id lowercase>`. `RESOURCE_PREFIX` is **Cloudflare-only** and never reaches VMs.
Staging and production servers in the shared Hetzner project are therefore
**indistinguishable at the provider**. A naive "destroy anything not in D1" reconciler
run from staging would delete production servers.

`Provider.listVMs(labels?)` already exists on all 7 providers
(`packages/providers/src/types.ts:248`; Hetzner `hetzner.ts:426`, server-side
`label_selector`).

Genuine orphan-producing paths: `nodes.ts:290/320` sets `provider_instance_id` only
*after* `createVM` returns (race window), and `nodes.ts:380` **deletes the node row** on
transient capacity failure — leaving a real server with no D1 row.

### F9 — capacity pressure predates the cron death

`403 server limit reached` appears 5× in production observability between
2026-08-05T08:35Z and 10:05Z — before the cron died at ~20:25Z. These are two
compounding problems, not one.

## Design Decisions

- **One idleness signal, two thresholds.** Define
  `lastWorkspaceActivity = COALESCE(MAX(workspaces.updated_at), nodes.created_at)`.
  This is immune to heartbeat bumping. The idle reaper uses it with a short threshold;
  the absolute backstop uses it with a long one. Using the same signal for both avoids a
  second class of "unsatisfiable predicate" bug.
- **The absolute backstop ignores nominal workspace status.** A workspace row that says
  `running` but has not been touched in hours is stuck, not active. Gating the backstop
  on activity rather than status is what kills zombie-workspace nodes without killing
  genuinely active work.
- **Provider reconciliation fails closed on unlabeled servers.** The `env` label only
  exists on servers created after this ships, so pre-existing servers are permanently
  out of scope. That is intentional: absence of a label must never authorize a destroy.
  Coverage grows as nodes cycle.
- **Rule 18**: `node-cleanup.ts` is already 646 lines. Split it into a directory in a
  separate commit *before* the feature commits so the diff is reviewable.

## Implementation Checklist

### P0 — stop the live outage
- [ ] Wrap every sweep in the `index.ts` 5-minute cron in per-sweep error isolation so
      one failure cannot suppress the others; log each failure with structured context
      and surface a per-sweep failure count in `cron.completed`.
- [ ] Regression test: a throwing sweep must not prevent later sweeps from running.

### P0.5 — mandatory file split (rule 18)
- [ ] Split `apps/api/src/scheduled/node-cleanup.ts` (646 lines) into a directory with a
      thin `index.ts` barrel, one module per phase. Separate commit, no behavior change.

### P1 — make reaping actually work (rule 47)
- [ ] Add `DEFAULT_NODE_ORPHAN_IDLE_TIMEOUT_MS` + `NODE_ORPHAN_IDLE_TIMEOUT_MS` override.
- [ ] Add `DEFAULT_NODE_ABSOLUTE_MAX_LIFETIME_MS` + `NODE_ABSOLUTE_MAX_LIFETIME_MS`.
- [ ] Add `DEFAULT_NODE_CLEANUP_SWEEP_LIMIT` + `NODE_CLEANUP_SWEEP_LIMIT`; apply a
      `LIMIT` to every previously unbounded candidate query (phases 1–5).
- [ ] Add a background/control-loop request timeout for VM-agent calls made from sweeps,
      separate from the interactive `DEFAULT_NODE_AGENT_REQUEST_TIMEOUT_MS`
      (`DEFAULT_NODE_AGENT_BACKGROUND_REQUEST_TIMEOUT_MS` + env override).
- [ ] Convert phase 5 from flag-only to an actual reaper, keyed on
      `lastWorkspaceActivity`, gated on `node_role='workspace'` AND
      `node_class != 'user-owned'`, with `created_at` age guard so freshly provisioned
      nodes awaiting their first workspace are never reaped.
- [ ] Make max lifetime a true backstop using `lastWorkspaceActivity` rather than
      nominal workspace status.
- [ ] Give every selected candidate an escape path (success / terminal failure /
      expiring marker) so a permanently failing candidate is not retried every sweep.

### P2 — rule 51 class-guard gaps
- [ ] Add `node_class != 'user-owned'` to `deployment-environments.ts:650-658`.
- [ ] Add a `nodes` join + class guard to node-cleanup phases 4 and 6.

### P3 — provider-side orphan reconciliation
- [ ] Add an environment label to created servers in `nodes.ts` so provider-side
      resources are attributable to one deployment.
- [ ] New bounded sweep: list SAM-labeled servers for the **current environment only**,
      compare against D1, and destroy servers no live D1 row claims — with a minimum
      server age to avoid the `provider_instance_id` creation race.
- [ ] Fail closed: unlabeled/foreign-env servers are skipped; any D1 or provider error
      aborts without destroying anything.
- [ ] Wire into the cron behind the new per-sweep isolation.

### Tests
- [ ] Two-sweep zombie regression test (rule 47): a permanently failing candidate is not
      re-selected on the second sweep.
- [ ] Discriminating safety test: a `node_role='deployment'` node with zero workspaces
      and an active deployment environment is **never** selected by any destroy query.
      Must fail against a reaper that omits the role gate.
- [ ] Discriminating safety test: `node_class='user-owned'` is never selected by any
      destroy/flag query, across repeated sweeps.
- [ ] Test proving the idle reaper matches a heartbeating idle node (i.e. proving it is
      not defeated by `updated_at` bumping). Must fail against the old predicate.
- [ ] Provider reconciliation: server in current env with no D1 row → destroyed; server
      with a live D1 row → untouched; unlabeled server → skipped; foreign-env server →
      skipped; too-young server → skipped; D1 error → nothing destroyed.
- [ ] Cron isolation regression test (see P0).

## Acceptance Criteria

- A throwing sweep in the 5-minute cron cannot prevent any other sweep from running,
  and each failure is individually logged.
- Node `01KZA0A8MCJFTNMDWE77PWGQWK` (running, zero active workspaces, idle since
  2026-08-06T00:47Z) is reaped after deploy.
- Nodes with `node_role='deployment'` are never reaped by any idle/lifetime/orphan path,
  proven by a test that fails without the role gate.
- Nodes with `node_class='user-owned'` are never selected by any destroy or flag query.
- Every candidate query in the sweep is bounded by a configurable limit, and background
  VM-agent calls use a background timeout, not the interactive one.
- Max lifetime is enforced against workspace *activity*, so a node with a stuck
  `running` workspace cannot live indefinitely.
- Provider-side reconciliation destroys only servers labeled for the current environment
  that no live D1 row claims and that are older than the configured minimum age; it
  destroys nothing when labels are absent or when any lookup fails.
- No hardcoded values: every threshold has a `DEFAULT_*` constant and an env override
  (constitution Principle XI).
- Documentation updated for all new env vars.

## References

- `.claude/rules/47-control-loop-io-budget.md` — tiered timeouts, candidate escape paths,
  two-sweep zombie regression tests
- `.claude/rules/51-server-side-node-class-gates.md` — class guard on every destroy query
- `.claude/rules/18-file-size-limits.md` — node-cleanup.ts split
- `.claude/rules/39-debug-before-redesign.md` — preserved the reported symptom while
  correcting the attributed cause
- `.claude/rules/42-no-untracked-degrading-placeholders.md`
- Project policy: "Hetzner capacity is shared (10 servers): staging runs zero VMs at rest"
- SAM task `01KZB1EC4ZR612SJJKNWTGDAS3`
