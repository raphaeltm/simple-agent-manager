# Interactive placement-strategy explorer + blog post

## Problem

SAM has four capacity placement strategies — `pack`, `spread`, `balanced`, `smallest-fit`
(`CAPACITY_POOL_STRATEGIES` in `packages/shared/src/types/capacity-pool.ts`). Nothing explains
them. There is no public page a user can read to decide which one their pool should use, and no
way to see what a strategy actually does to a batch of workloads.

The gap has a concrete cost. On 2026-09-09 a session wake failed three times with
`hetzner API error (412): error during placement` because the pool asked for `cx33` in `fsn1` and
Hetzner had none. The same pool carries `cx33` in `hel1` and `nbg1` **at exactly the same price**
(€8.49/mo, verified in production `capacity_pool_candidates` — note the in-repo catalog snapshot says €7.49, because `HETZNER_SIZE_CONFIGS` carries display defaults rather than live billing prices; both numbers are real, from different sources), and no strategy would have
preferred `fsn1` — region is not a ranking input at all except for `pack`/`spread` clustering.
Nobody could see that, because there is nothing that shows how placement decides.

Build the thing that shows it.

## Scope

A blog post in `apps/www` with an interactive explorer:

- pick a provider and a set of regions from the real in-repo machine catalogs
- submit workloads by hand or generate a batch
- watch nodes get provisioned, workloads distributed onto them, then drained and cleaned up
- switch strategy and compare the *same* workload set across strategies

## Research findings

### R1 — `apps/www` has no React
Astro + Starlight only (`package.json` deps: astro, @astrojs/starlight, @astrojs/sitemap,
mermaid). Browser interactivity is a custom element plus an Astro `<script> import './x'</script>`
block, which Astro bundles. The `esbuild` scripts (`build:blog-mermaid`, `build:docs-mermaid`)
exist only for scripts loaded outside Astro's pipeline; this component does not need one.
-> Checklist C3.

### R2 — the `interactive:` frontmatter hook already exists
`src/content.config.ts:16` declares `interactive: z.enum(['scheduler']).optional()`, and
`src/pages/blog/[slug].astro:26` renders `{post.data.interactive === 'scheduler' && <SchedulerExplorer />}`.
Reuse this mechanism rather than inventing a second one (rules 24, 59). The enum and the slug
page both need one new branch. -> Checklist C1, C2.

### R3 — the existing explorer teaches a model we have since replaced
`src/components/scheduler/model.ts` uses `LAB.slotsPerNode = 2` — count-based packing. Rule 69
exists precisely because counting workspaces instead of summing declared CPU/memory overpacked a
2-vCPU/4-GB node. The new explorer must be aggregate-resource based, so it cannot share
`model.ts`. Do NOT silently rewrite the older post — file a follow-up. -> Checklist C4, C13.

### R4 — real machine catalogs are in-repo and static
`{HETZNER,SCALEWAY,DIGITALOCEAN,VULTR,UPCLOUD,INFOMANIAK}_SIZE_CONFIGS` (`Record<VMSize, SizeConfig>`
with real SKU, price, vcpu, ramGb, storageGb) and `*_LOCATIONS` per provider. `apps/www` does not
depend on `@simple-agent-manager/providers` and should not at runtime — a marketing build must not
pull a Workers-oriented package. Snapshot the catalog into the component and add a **drift test**
that imports the providers package as a `devDependency` so the snapshot cannot silently go stale
(the cross-reference discipline in rule 51-vm-agent). -> Checklist C5, C10.

### R5 — the strategy ordering keys are already named in code
`PLACEMENT_STRATEGY_HOST_ORDERING` (`apps/api/src/services/placement-strategy.ts:52`) is the
teaching table, verbatim:

| strategy | host ordering |
| --- | --- |
| `pack` | highest projected utilization first |
| `balanced` | lowest projected utilization first |
| `spread` | fewest co-tenant workspaces first |
| `smallest-fit` | smallest sufficient host capacity first |

New-hardware ordering is separate (`compareCapacityCandidates` in `placement-capacity-ranking.ts`):
`pack` negates the capacity diff (biggest first); `smallest-fit` uses fit surplus then price;
others use the weighted price/fit/capacity score. Region only participates via
`comparePlacementLocationsByStrategy`, which returns 0 for every strategy except `pack`/`spread`.
-> Checklist C6, C7.

### R6 — ranking never widens admission
`placement-strategy.ts` header: `evaluateWorkspaceReservationCapacity` is the single admission
gate; strategies only ORDER hosts that gate already admitted. The explorer must model admission
as a separate step from ranking or it will teach the wrong thing. The admission gate subtracts
`DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB = 512` from host memory — the exact rule that
disqualified `cx23` in the incident. -> Checklist C6, C8.

### R7 — exhaustion policy is a real, visible behaviour
`fail` / `queue` / `fallback-chain` (`node-provisioning-exhaustion.ts`). Fallback alternatives are
drawn only from the same pool AND the same capacity source, and walk the ranked list in order — so
the fallback *direction* is a side effect of the strategy's sort, not an explicit cost rule.
Worth showing, because it is the mechanism the incident never reached. -> Checklist C9.

### R8 — cleanup is a real lifecycle, not just "delete"
Managed auto-provisioned nodes go active -> warm (`NODE_WARM_TIMEOUT_MS`, 30 min default) ->
destroying, per the NodeLifecycle DO. Rule 69's teardown clause: the reciprocal admission
predicate must hold at the final atomic mutation — no active reservations, no live placement
claims. The explorer's drain phase should show warm reuse, not instant deletion. -> Checklist C8.

### R9 — test precedent exists and the viewport matrix is already right
`tests/scheduler-model.test.ts` (vitest, pure model) and
`tests/playwright/scheduler-explorer.spec.ts` (browser) are the templates.
`tests/playwright/public-surface-a11y.spec.ts` runs axe over public surfaces.
`playwright.config.ts` already defines Desktop Chrome 1280x800 and Mobile Chrome 375x667, so both
required viewports come for free. -> Checklist C10, C11, C12.

### R10 — blog voice labels illustrative values explicitly
`how-sam-scheduler-works.md` states "These are **illustrative values, not SAM defaults**" and
cites real components by name. Match that: every simplification in the explorer must be declared,
and every behavioural claim must cite a code path (rule 01). -> Checklist C13.

## Implementation checklist

- [x] C1. Extend `interactive` enum in `src/content.config.ts` to `['scheduler', 'placement']`
- [x] C2. Add the `placement` branch to `src/pages/blog/[slug].astro`
- [x] C3. `src/components/placement/PlacementExplorer.astro` — custom element, scoped styles,
      `<noscript>` fallback, `prefers-reduced-motion` handling, 650px mobile breakpoint
- [x] C4. `src/components/placement/model.ts` — aggregate CPU/MEM/DISK model (NOT slot counts):
      admission gate separate from ranking; host reserve applied; warm/drain lifecycle
- [x] C5. `src/components/placement/catalog.ts` — snapshot of real provider SIZE_CONFIGS +
      LOCATIONS, with a dated provenance comment naming the source symbols
- [x] C6. Implement the four host-ordering keys exactly as `PLACEMENT_STRATEGY_HOST_ORDERING`
- [x] C7. Implement offering ordering + the region no-op, so "same price, three regions" is
      visibly a tie the strategy does not break
- [x] C8. Model provisioning -> distribution -> drain (warm window) -> destroy
- [x] C9. Model `fail` / `queue` / `fallback-chain` on a stockout, with a region-stockout toggle
      that reproduces the 2026-09-09 incident
- [x] C10. `tests/placement-model.test.ts` — one test per strategy proving the ordering key is
      the discriminator, plus a catalog drift test against `@simple-agent-manager/providers`
- [x] C11. `tests/playwright/placement-explorer.spec.ts` — real interaction (submit, step, switch
      strategy), overflow assertion at both viewports, absence assertions paired with a positive
      render assertion (rule 62)
- [x] C12. Confirm the new page is covered by `public-surface-a11y.spec.ts` or add it
- [x] C13. `src/content/blog/<slug>.md` — the post. Declare every simplification; cite real code
      paths; do not present illustrative constants as SAM defaults
- [x] C14. Follow-up filed: `tasks/backlog/2026-09-09-scheduler-explorer-slot-count-model.md`

## Outcome

Delivered. `pnpm lint` clean, `pnpm typecheck` 0 new errors (4 pre-existing baseline),
`pnpm test` 5 files / 40 tests (baseline 3 / 9), `pnpm test:browser` 132 passed including 14 new
across Desktop 1280x800 and Mobile Chrome 375x667.

### Review findings addressed after the first pass

Five local reviewers ran against the branch. Their substantive findings, all fixed:

- **doc-sync + task-completion-validator (HIGH, same finding independently):** the post and the
  model both claimed `balanced`/`spread` buy "the cheapest offering first". False. The real default
  weights are `fit: 1_000_000` against `price: 1`, so fit dominates and price is only a tie-break.
  Both reviewers verified by calling the real `compareCapacityCandidates`. Corrected in the post,
  in `OFFERING_ORDERING`, and in `rankOfferings`; the old test could not catch it because Hetzner's
  cheapest offering is also its tightest, so a synthetic inverted-price catalog was added.
- **task-completion-validator (HIGH):** the fail-policy stockout browser test was flaky at a
  boundary — seeded load shared `LAB.runSteps`, so the seeded host freed itself at exactly the step
  the test asserted on. Fixed at root cause: seeded work is steady-state occupancy
  (`LAB.seededWorkRunSteps`), not something that evaporates mid-demo.
- **test-engineer (HIGH):** the catalog drift guard used `indexOf`, so a prefix-preserving rename
  passed silently. Now word-anchored, with a guard-the-guard test.
- **doc-sync (HIGH):** the post said the NodeLifecycle DO destroys warm nodes. It marks them
  `destroying`; the cron sweep destroys. Corrected, matching CLAUDE.md.
- **doc-sync (MEDIUM):** `MAX_WORKSPACES_PER_NODE` (3) binds before the co-tenant cap (4) at the
  defaults and was not modelled at all. Now modelled, enforced first, and disclosed.
- **constitution-validator (MEDIUM):** the two mirrored real defaults had no drift guard while the
  catalog did. All three are now pinned to their real sources.
- **constitution-validator (MEDIUM):** `aria-pressed={index === 2}` hardcoded a list position;
  now derived from `DEFAULT_STRATEGY`. Magic numbers named.
- **test-engineer (MEDIUM/LOW):** added coverage for the queue policy's success path, the
  unreachable disk-refusal branch, the node ceiling and its escape path, play/pause/reset,
  provider-switch stockout reset, and warm reuse in the browser.

### Post-mortem — six defects found during implementation

1. **Astro scoped styles never reach JS-created DOM.** Astro compiles `.fleet li` to
   `.fleet:where(.astro-xxx) li:where(.astro-xxx)`; every node built by `document.createElement`
   lacks that class, so the fleet cards, workload rows, event log and comparison table were
   ENTIRELY unstyled while all 12 behavioural tests passed. Class of bug: a test that asserts text
   and attributes cannot see a styling failure (`.claude/rules/62`, and `.claude/rules/17`'s
   "screenshot evidence must be checked, not just produced" — opening the screenshot is what found
   it). Fixed by rooting styles at the `placement-explorer` custom element via `is:global`.
2. **Host prose styles bleeding into an embedded dark panel.** `strong` at 1.15:1, `code` at
   1.9:1, and the site's table rule painting the last comparison row `#f8fbf8` under light text.
3. **axe reports unresolvable contrast as `incomplete`, not `violations`.** The unreadable row in
   (2) passed the a11y assertion. The test now also fails on unresolved contrast, with a written
   selector allowlist for the genuinely-unresolvable gradient-backed header nodes.
4. **The `<table>` was the scroll container rather than its wrapper**, making it an unfocusable
   scrollable region.
5. **Two strategies collapsed into one another** on a homogeneous fleet — the exact defect
   `placement-strategy.ts` documents for `balanced`/`spread`. Also found that `pack` and
   `smallest-fit` genuinely coincide on an idle fleet; that is a real property and is now pinned
   by a test rather than papered over.
6. **The host-reserve subtraction was duplicated** in the admission gate and the offering filter,
   so a mutation of one left the other intact. Single-sourced as `usableMemoryForOffering`.

Mutation-verified discrimination: removing the host reserve reddens exactly the admission and
offering-exclusion tests; inverting `pack`'s ordering key reddens exactly the two strategy-identity
tests. Restored after each.

CORRECTION to an earlier version of this note: I wrote that "drifting the catalog snapshot reddens
exactly the two drift tests". That was over-stated, and the test-engineer review disproved it. It
holds only for an identity-level drift (a symbol renamed to a non-colliding name). A value-level
drift reddens one test, and a prefix-preserving rename (`FOO` -> `FOO_V2`) reddened **zero** —
`extractLiteral` used `indexOf`, which matched the old name as a prefix of the new one and reported
no drift. The guard is now word-anchored with its own guard-the-guard test.

### Process note

No `.claude/rules/` change is proposed. Defects 1-4 are Astro/axe platform behaviours rather than a
recurring SAM class, and the two that ARE general — "green behavioural tests cannot see a styling
failure" and "prove the guard discriminating" — are already rules 17 and 62, and both did their job
here once the screenshots were actually opened.

## Acceptance criteria

- [x] A user can pick a provider and 2+ regions from real catalog data and see real SKUs/prices
- [x] A user can submit workloads individually and generate a batch
- [x] Nodes visibly provision, receive workloads, drain to warm, and are destroyed
- [x] All four strategies are selectable and produce *observably different* placements for the
      same workload set — asserted in tests, not just claimed
- [x] A same-price multi-region tie is visible as a tie (the incident's teaching moment)
- [x] The stockout toggle reproduces "no capacity in this region" and shows what each exhaustion
      policy does about it
- [x] `pnpm --filter @simple-agent-manager/www test` and `test:browser` pass
- [x] No horizontal overflow at 375px or 1280px
- [x] Post states plainly that the explorer's constants are illustrative

## References

- Origin: chat session `b176e912-19b8-47e9-88bc-f2c04d6167e9`, recovery tasks
  `01M22SBB87TJCGXP101MQRJ9PM` / `01M22SK27QEAFYAKY6X0JQ0VQJ` / `01M22SNNCQJ7RD2MYKNP95VAK8`
- `.claude/rules/69-aggregate-capacity-at-final-reservation.md` (why not slot counts)
- `.claude/rules/24`, `.claude/rules/59` (reuse the `interactive:` hook)
- `.claude/rules/62` (tests must reach the feature the way production does)
- `.claude/rules/01` (cite code paths in behavioural docs)
- `apps/api/src/services/placement-strategy.ts`, `placement-capacity-ranking.ts`,
  `apps/api/src/durable-objects/task-runner/node-provisioning-exhaustion.ts`
