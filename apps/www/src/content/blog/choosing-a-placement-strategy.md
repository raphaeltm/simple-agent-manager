---
title: 'Four ways to answer one question: where should this workload run?'
date: 2026-09-09
author: SAM
category: engineering
tags: ['architecture', 'scheduling', 'capacity', 'infrastructure']
excerpt: 'An interactive tour of SAM’s four placement strategies — pack, spread, balanced and smallest-fit — over real provider catalogs, plus what happens when the region you asked for is out of stock.'
interactive: placement
---

## The question is smaller than it looks

A pool of machines. A pile of work. Something has to decide which machine each piece of work goes
on, and whether to buy another machine when none of them will do.

SAM calls that decision **placement**, and it lets you choose how it behaves with a **strategy**:
`pack`, `spread`, `balanced`, or `smallest-fit`. Try them above. Submit the same batch of work,
switch strategy, and watch the placements move.

This article is about what those four words actually do.

## First: a strategy cannot make something fit

The single most important thing about placement is that it happens in two steps, and only the
second one is the strategy's business.

**Admission** decides whether a host *may* take a workload. That is
`evaluateWorkspaceReservationCapacity` (`apps/api/src/services/workspace-resource-capacity.ts`),
which is the only gate for CPU, memory and disk budgets, exclusivity, and the two density caps.

**Ranking** then orders the hosts admission already accepted. That is `placement-strategy.ts`,
whose header says it plainly: it "does not re-implement any hard constraint", so "a ranking change
can never widen admission".

Keeping those separate matters because the intuitive mental model — "pack squeezes more onto each
box" — is wrong in an important way. `pack` does not squeeze anything. It expresses a
*preference* among boxes that were already willing.

### The 512 MB that surprises everyone

Admission subtracts a host reserve before it does any arithmetic:
`DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB`, 512 MB by default. The host needs memory to
be a host.

Which produces a result that reads like a bug the first time you hit it:

| | |
| --- | --- |
| Platform default workload (`PLATFORM_RESOURCE_DEFAULTS`) | 2 vCPU, **4 GB** |
| Hetzner `cx23` | 2 vCPU, **4 GB** |
| `cx23` memory available to workloads | 4 GB − 512 MB = **3.5 GB** |
| Fits? | **No** |

A 4 GB workload does not fit a 4 GB machine. Every default-sized SAM workspace therefore needs a
`cx33` or larger. In the explorer, submit a **Standard** workload and watch which hosts refuse it.

## The four strategies

Each strategy is defined by one ordering key, compared first and on its own. These are copied
verbatim from `PLACEMENT_STRATEGY_HOST_ORDERING`:

| Strategy | Picks the host with… |
| --- | --- |
| `pack` | highest projected utilization first |
| `balanced` | lowest projected utilization first |
| `spread` | fewest co-tenant workspaces first |
| `smallest-fit` | smallest sufficient host capacity first |

"Projected utilization" is dominant-resource: a host is as full as its fullest dimension, measured
*after* the workload would land. A host at 20% CPU and 90% memory is a 90% host.

These *host* keys are compared lexicographically rather than blended into a weighted score (unlike
the offering ordering below, which is weighted), and there is a reason for that in the source:
`balanced` and `spread` once shared one weighted score and were byte-identical. A strategy you selected has to stay observable no matter how the tuning weights
are set.

### When the four agree

They converge more often than you would expect, and it is worth knowing when.

On a **homogeneous fleet** — every host the same size, all equally loaded — all four keys return
the same order, because there is nothing to distinguish the hosts by. The strategy is only
load-bearing when the choice is real.

More subtly: **`pack` and `smallest-fit` are identical on an idle fleet.** For a fixed
reservation, the smallest host always has the highest projected utilization, so "fullest" and
"smallest" name the same machine. They come apart only once something large is already busy. The
explorer starts you with a deliberately mixed fleet — a loaded large host, a lightly used medium,
an idle small — so you can see all four disagree from step one. Reset with an idle fleet and two
of them will shake hands.

## Buying new hardware is a different ranking

When no existing host is admissible, placement picks an *offering* instead of a host, and the
ordering changes (`compareCapacityCandidates`, `placement-capacity-ranking.ts`):

| Strategy | Buys |
| --- | --- |
| `pack` | the largest offering first |
| `balanced`, `spread` | the tightest fit first, then the cheapest |
| `smallest-fit` | the tightest fit first, then the cheapest |

That is not a typo, and it surprised us too. `balanced` and `spread` reach that ordering through a
weighted score rather than an explicit key, and the default weights are
`fit: 1_000_000` against `price: 1` (`DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS` in
`capacity-pool-placement-settings.ts`). Six orders of magnitude means fit decides and price is only
ever a tie-break. Where price and fit disagree — a roomy machine that happens to be cheaper than a
tight one — every strategy except `pack` takes the tight one.

Offerings that could never pass admission are dropped before ranking begins — the same host-reserve
arithmetic, applied to hardware that does not exist yet. That is why the explorer never offers you
a `cx23` for a Standard workload.

## Region is not a ranking input

Here is the part that cost us an outage.

Region participates in ranking only for `pack` and `spread`, and only to cluster or scatter
relative to hosts you already have (`comparePlacementLocationsByStrategy`). For `balanced` and
`smallest-fit` it returns zero. It is not a preference. It is not a cost dimension.

So when a pool offers the same machine at the same price in three regions, those three are a
genuine tie, and nothing in the system prefers one over another.

That is exactly true in practice. A production pool carried `cx33` in `fsn1`, `nbg1` and `hel1` at
an identical price. On 2026-09-09 a sleeping session tried to wake, placement asked for `cx33` in
`fsn1`, and Hetzner answered:

```
hetzner API error (412): error during placement
```

No stock. The wake failed three times in six minutes and the session became unwakeable. Two other
regions had the same machine at the same price the whole time.

Toggle the flame on a region in the explorer to reproduce it.

## What to do when the answer is "no stock"

A pool has an **exhaustion policy** for exactly this
(`apps/api/src/durable-objects/task-runner/node-provisioning-exhaustion.ts`):

| Policy | Behaviour |
| --- | --- |
| `fail` | one attempt; exhaustion is terminal |
| `queue` | park on the admission queue until capacity returns or the wait deadline expires |
| `fallback-chain` | try the pool's other permissible offerings, in ranked order, before giving up |

Switch policies in the explorer with a region stocked out and watch the three outcomes diverge.

Two things are worth noticing about `fallback-chain`. It walks the *same ranked list* the strategy
produced, so its direction is a side effect of the strategy rather than an explicit rule — under
`pack` it descends toward smaller and cheaper machines, under the others it climbs. And its
alternatives are drawn only from the same pool and the same capacity source, so it can never
borrow another tenant's credentials or cross into a different billing account.

## Machines are given back, not just taken

Placement is only half a lifecycle. When a host's last workload finishes it does not disappear —
it goes **warm** and stays reusable for `NODE_WARM_TIMEOUT_MS` (30 minutes by default). When that
expires, the NodeLifecycle Durable Object's alarm moves it to `destroying` — it does not delete
anything itself. The actual provider-side teardown is the cron sweep's job
(`destroyNodeForCleanup` in `scheduled/node-cleanup/shared.ts`), which is what finally calls the
provider and marks the row `deleted`. A warm host is fully admissible, so the next workload
usually lands on a machine that already exists instead of waiting on a boot.

Let the explorer run to the end of a batch. The fleet drains to warm, then empties. Submit
something during the warm window and watch a host get reused rather than replaced.

The teardown check is the mirror image of the admission check: a node may only be destroyed when it
genuinely holds nothing, re-verified at the moment of deletion rather than trusted from a timer
that fired earlier.

## About the explorer

It is a teaching model, not production scheduling code.

Real: the 512 MB host reserve, both density caps — the node-wide `MAX_WORKSPACES_PER_NODE` (3) and
the per-request `maxCoTenants` (4), of which the stricter one binds — the four ordering keys, the
offering ordering, the exhaustion policies, and the machine names, sizes and prices. Those are
snapshotted from the provider catalogs in `packages/providers`, and the reserve and both caps are
pinned to their real sources, by tests that fail if any of it drifts.

**Illustrative values, not SAM defaults:** boot, run, warm and wait durations are compressed into
countable steps so you can see the consequences; real ones are wall-clock and configurable. One
price per SKU across regions, where real catalogs sometimes charge more in some locations. And the
provisioning lease is modelled as "one boot at a time", which is the shape of SAM's VM admission
control rather than its full behaviour.

If you want to actually configure this rather than just watch it, the reference guide is
[Compute pools](/docs/guides/compute-pools/).

The thing to take away is not which strategy is best. It is that the strategy only decides between
options that admission already approved — and that if your pool spans regions with identical
machines at identical prices, no strategy is going to prefer the one that happens to have stock.
