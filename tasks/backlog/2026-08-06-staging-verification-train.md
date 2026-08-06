# Staging Verification Train — batched verification of multiple PRs in one staging deploy

## Problem

Staging is a **single shared environment**, and per-PR staging verification serializes every merge
behind an exclusive test window.

Three independent costs compound:

1. **Exclusive occupancy.** Verification is manual live testing, often up to ~1h per agent — the SAM
   policy "Treat staging contention as manual development-environment contention" says explicitly not
   to reduce this to CI queue time. `deploy-staging.yml` has
   `concurrency: { group: deploy-staging, cancel-in-progress: false }`
   (`.github/workflows/deploy-staging.yml:13-15`), which serializes *deploys* but does nothing about
   the much longer *verification* window that follows.
2. **Fixed deploy cost per PR.** A staging deploy measured **~14 minutes** across the last 10 runs on
   2026-08-06 (13, 14, 15, 14, 28, 20, 11, 14, 14 min; `gh run list --workflow=deploy-staging.yml`),
   plus ~2 min of automatic smoke tests (`deploy-staging.yml:36-70`). N PRs pay that N times.
   (`CLAUDE.md:65` and `.claude/rules/32-cf-api-debugging.md:7,146` still claim "~7 minutes" — stale
   by 2x, and it understates the case for batching.)
3. **Shared Hetzner capacity.** The Hetzner account has a **10-server limit shared with production**
   (staging provisioning 403'd `server limit reached` on 2026-08-05 while production held 9 running
   nodes). Every concurrent verification that provisions a VM competes with production.

On top of that, **one branch's unmerged Durable Object migration can pin the shared Worker and block
every other branch's staging deploy** — see `tasks/backlog/2026-08-04-shared-staging-do-migration-pinning.md`.

The 2026-08-05 blitz worked around all of this by hand: its orchestrator serialized the three
staging-needing PRs into slots A→B→C (#1740 → #1697, "chained behind #1740 so they don't fight over
staging" → #1745) and told every other agent to skip staging entirely. That worked, but it was
verbal orchestration with no artifact. The same pattern shows up repeatedly in older task files as
ad-hoc "staging turns" (`tasks/active/2026-07-11-cf-container-cold-start-latency.md:33`,
`tasks/active/2026-07-11-taskrunner-d1-lifecycle-reconciliation.md:37`,
`tasks/archive/2026-07-17-stop-expired-trial-missing-vm-retries.md:43`).

**This task productizes that pattern**: batched verification of multiple PRs in ONE staging
deployment, as the default path.

## Research Findings

### R1. Skill/command surfaces are dual, and `/do` is the template

- `.claude/commands/do.md` holds the full workflow (frontmatter: `description` + `argument-hint`,
  then `## User Input` with `$ARGUMENTS`).
- `.agents/skills/do/SKILL.md` is a thin Codex-facing pointer ("Read the full workflow from
  `.claude/commands/do.md` and execute it") plus a quick summary.
- `.claude/skills/` holds *reference* skills (api-reference, changelog, …), **not** `/do`-style
  workflow commands. The conductor belongs in `commands/` + `.agents/skills/`.
- `scripts/quality/check-skill-references.ts` requires **every `.md` path cited in any
  `.agents/skills/*/SKILL.md` to resolve to a real file** (`:36-38`). Verified passing today.

### R2. The DO migration pinning failure is now fail-closed, but its message misleads on shared staging

PR #1649 (`3f47e1b26`, "fix: preserve Durable Object migration compatibility") extracted the logic to
`scripts/deploy/durable-object-migrations.ts`. `resolveDurableObjectMigrations` now **throws at
`:222-230`** when the deployed tag is absent from the branch's checked-in history:

> `Deployed Durable Object migration tag "<tag>" is not present in the checked-in history; refusing to
> replay migrations. The checked-in wrangler.toml is missing migration entries that were already
> applied to this Worker (often an upgrade merge that dropped fork-local migrations). Restore the
> missing entries so the deployed tag appears in the history, then redeploy.`

This runs in the **Sync Wrangler Config** step (`.github/workflows/deploy-reusable.yml:347`), long
before `wrangler deploy` (`:641`). So the original symptom in the pinning backlog task — a raw,
misattributing `Cannot apply new-sqlite-class migration to class 'ProjectData' [code: 10074]` — no
longer occurs.

**But the new message's remediation advice is wrong for the shared-staging case.** It assumes a fork
that dropped migration entries, and tells you to "restore the missing entries". On shared staging the
correct reading is "another unmerged branch advanced staging's tag", and copying that branch's
migration entry into yours would duplicate a tag — which `resolveDurableObjectMigrations:210-216`
rejects, and which violates the append-only sequence invariant in `.claude/rules/07-env-and-urls.md:74-82`.
**This interpretation is not documented anywhere.**

### R3. Migration collisions surface as a git merge conflict at train assembly (free detection)

`scripts/quality/do-migration-compatibility.test.ts:91` asserts `expect(latestTag).toBe('v20')`
against the real `apps/api/wrangler.toml`. Any branch appending `v21` **must** edit that literal.
Two branches both adding a migration therefore both edit the same line → the train's integration
merge conflicts deterministically. Assembly-time conflict detection is free; no new tooling needed.

Current state: `apps/api/wrangler.toml` has 20 entries, `v1`..`v20`, latest `v20` (`:320-322`).

### R4. Directionality of the migration constraint (why a train can't "un-deploy" a migration)

- Branch has **extra** tags beyond staging's deployed tag → pending; emitted and applied; staging
  advances. Fine.
- Branch **lacks** a tag staging already applied → `appliedIndex === -1` → hard throw at preflight.
  There is no auto-heal and no way to move staging's tag backwards.

Consequence: **once a train deploys a migration tag, it cannot reduce below that migration.** A
migration-bearing PR that fails verification leaves staging pinned regardless of whether it rode a
train or verified solo. The train shrinks the pinning *window* from "however long the branch sits
unmerged" (days) to "the conductor's own session" (minutes) — it does not make failure impossible.
The rule must say this precisely rather than overclaiming.

### R5. Existing machinery the conductor can lean on

- `deploy-staging.yml` is `workflow_dispatch`-only with a single `dry_run` input; the branch comes
  from `--ref` (`.github/workflows/deploy-staging.yml:3-10`).
- Smoke tests run automatically post-deploy (`tests/smoke/*.spec.ts`, `deploy-staging.yml:36-70`) —
  a free shared-regression signal, gated on `SMOKE_TEST_TOKEN`.
- Node deletion: `DELETE /api/nodes/:id` (`apps/api/src/routes/nodes.ts:359-432`), session-cookie
  auth, so it is driven from the Playwright-authenticated context. **No cleanup script exists.**
- `needs-human-review` label exists and **fails CI** when present
  (`scripts/quality/check-specialist-review-evidence.ts:20,160,177-182`) — the conductor must not
  apply it casually to trained PRs.
- PR-body parsers constrain template edits: `check-preflight-evidence.ts` anchors on
  `<!-- AGENT_PREFLIGHT_START/END -->`; `check-specialist-review-evidence.ts` anchors on
  `## Specialist Review Evidence` and stops at the next `## ` heading. New sections must not split
  either block.

### R6. Gaps found in existing docs (fix while here)

- `.claude/rules/33-staging-feature-validation.md:151` cites *"See Rule 13: 'delete test
  workspaces/nodes after verification'"* — but **rule 13 contains no cleanup text at all** (0 hits
  for delete/cleanup across its 249 lines). That sentence actually lives at `CLAUDE.md:196`. Dangling
  cross-reference.
- The Hetzner 10-server shared limit and staging zero-VMs-at-rest exist **only as a SAM project
  policy**, nowhere in the repo. The new rule is the first in-repo statement.
- `CLAUDE.md:65`, `.claude/rules/32-cf-api-debugging.md:7,146` — stale "~7 minutes" deploy claim.

### R7. Rule numbering

Highest existing rule is `52`. Note a **pre-existing duplicate `51`**
(`51-server-side-node-class-gates.md` and `51-vm-agent-no-host-mime-dependency.md`) — do not add a
third collision. New rule = **`53`**.

## Design

**Canonical policy lives in rule 53.** The conductor command is the *executable procedure* and
references rule 53 for policy rather than restating it. Rule 13 / rule 30 / the PR template / `/do`
Phase 6 get short pointers. This keeps the change DRY.

Train parameters (defined once, in rule 53):

| Parameter | Value | Rationale |
|---|---|---|
| Minimum size to depart | 2 queued PRs | Below 2 a train saves nothing over solo |
| Maximum wait | 2 h | Beyond this, waiting costs more than the ~1h exclusive slot it saves |
| Maximum size | 6 PRs | Keeps one train ≈ one old solo slot; caps integration blast radius |
| Max VM-requiring plans | 2 | Hetzner 10-server limit shared with production |
| Max DO-migration PRs | 1 | Tag sequence is linear; two claims collide by construction |
| Max reduced redeploys | 1 | Bounds a bad train to ~2 deploy cycles, then fall back to solo |

Queue signal: the **`staging-queue` label** + a machine-executable `## Staging Verification Plan`
block in the PR body. Mutex: the pushed `staging-train/<date>-<n>` branch itself — its existence is
the lock, and the conductor deletes it at the end.

## Implementation Checklist

- [ ] Create `.claude/rules/53-staging-verification-train.md` — canonical policy: queue signal, plan
      contract, departure conditions + parameters table, head-SHA evidence rule, DO-migration
      handling (incl. the R2 misleading-message interpretation and the R4 no-reduce constraint),
      eject/drop/redeploy rules, zero-at-rest teardown, conductor mutex
- [ ] Create `.claude/commands/staging-train.md` — the conductor procedure with real commands
      (assemble → deploy once → regression → per-PR plans → report → merge → prod deploy → teardown)
- [ ] Create `.agents/skills/staging-train/SKILL.md` — thin Codex pointer (must satisfy
      `quality:skill-references`)
- [ ] Amend `.claude/rules/13-staging-verification.md`: train satisfies the per-PR gate when the
      deployed integration branch **contained the PR's head SHA**; solo path preserved; add the
      missing **cleanup/zero-at-rest** section that `33-staging-feature-validation.md:151` already
      cites
- [ ] Amend `.claude/rules/30-never-ship-broken-features.md`: anti-rationalization rows for
      train-specific failure modes ("train was green overall", "my step failed but it basically
      works", "I'll re-add the label after merging")
- [ ] Amend `.github/pull_request_template.md`: add the `## Staging Verification Plan` block and make
      the staging section accept train evidence — without disturbing the AGENT_PREFLIGHT markers or
      the Specialist Review Evidence section boundaries
- [ ] Amend `.claude/commands/do.md` Phase 6 with the solo-vs-train branch point, and
      `.agents/skills/do/SKILL.md`'s step-7 summary
- [ ] Amend `CLAUDE.md`: staging merge-gate section mentions the train; add Recent Changes entry
- [ ] Fix the stale "~7 minutes" deploy claim in `CLAUDE.md:65` and
      `.claude/rules/32-cf-api-debugging.md:7,146` (measured ~14 min)
- [ ] Resolve `tasks/backlog/2026-08-04-shared-staging-do-migration-pinning.md`: fold AC1–AC3, record
      that AC2 is largely satisfied by PR #1649, explicitly defer the residual AC4
- [ ] File the deferred residual as a new backlog task (deploy-preflight message should distinguish
      the shared-staging-pinning case from the fork/upgrade case)
- [ ] Verify `pnpm quality:skill-references`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check`,
      `pnpm quality:scripts:test` all pass

## Acceptance Criteria

- [ ] A conductor agent can execute a train end-to-end from `.claude/commands/staging-train.md`
      without inventing policy — every decision point (eject, drop, redeploy, abort, merge order,
      teardown) has a written rule
- [ ] The queue signal is unambiguous and machine-queryable
      (`gh pr list --label staging-queue --state open`)
- [ ] The `## Staging Verification Plan` block is machine-executable: every step pairs an imperative
      action with an observable outcome, and declares whether it needs a VM
- [ ] Rule 13 states that train evidence satisfies the per-PR gate **only when the train's deployed
      integration branch contained that PR's head SHA**, and that a later push voids the evidence
- [ ] DO-migration handling is written such that staging's tag only advances together with what is
      about to merge; tag-collision handling (train assembly conflict → eject + serialize) is
      documented; the residual "migration PR fails verification" case has a named recovery
- [ ] The pinning backlog task's AC1–AC3 are folded in, and AC4's residual is either implemented or
      explicitly deferred with rationale and a linked follow-up task
- [ ] PR template accepts train evidence without breaking `quality:preflight` or
      `quality:specialist-review`
- [ ] Zero-at-rest teardown is a mandatory, verified (queried, not assumed) conductor step
- [ ] No platform code required — this ships as process, rules, template, and skill authoring

## References

- `tasks/backlog/2026-08-04-shared-staging-do-migration-pinning.md` — the pinning failure being folded in
- `.claude/rules/13-staging-verification.md` — the gate being amended
- `.claude/rules/30-never-ship-broken-features.md` — anti-rationalization home
- `.claude/rules/07-env-and-urls.md:74-82` — DO migration invariants (append-only, sequential tags)
- `.claude/rules/25-review-merge-gate.md:38-41` — precedent for documenting `gh label create`
- `.claude/rules/33-staging-feature-validation.md` — deeper user-journey validation (complements, not replaced)
- `scripts/deploy/durable-object-migrations.ts:195-247` — tag resolution / fail-closed behavior
- SAM policies: "Treat staging contention as manual development-environment contention";
  "Hetzner capacity is shared (10 servers): staging runs zero VMs at rest"
