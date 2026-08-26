# Batch and merge the stale Dependabot PRs

**Status:** active
**Started:** 2026-08-24
**Branch:** `sam/bring-four-non-trivial-d0kabv` (PR #1842)
**SAM task:** `01M0SDR3H7TSJGQMSGM9DXD7RM`
**Supersedes/extends:** `tasks/active/2026-08-17-integrate-four-nontrivial-dependabot-prs.md`

## Problem

Nine Dependabot PRs are open and 5–13 days stale. Integration PR #1842 already bundled the
four non-trivial ones but had gone 43 commits behind `main` and was `DIRTY` (conflicting),
so nothing was landing. The remaining five were untouched.

Landing them one at a time would mean five more staging deploys. Project policy
(`f9ae7f88`, progressive quality-tool rollout) requires staging sweeps to be consolidated onto
a small number of runs against a single pinned candidate, coordinated with other agents on
shared staging. So the goal is **one batch, one CI run, one staging sweep**.

## The nine PRs and their disposition

| PR | Bump | Disposition |
|----|------|-------------|
| #1790 | `library/node` 22 → 26-bookworm-slim | In #1842. Head SHA still reachable → auto-closes |
| #1801 | `@agentclientprotocol/sdk` 0.25.0 → 1.3.0 | **Resolved by removal** — zero importers. Close manually |
| #1796 | `@astrojs/starlight` 0.40.0 → 0.41.7 | In #1842 (+ `astro` 6→7, the required peer). Close manually |
| #1792 | `cloudflare/sandbox` 0.12.1 → 0.12.5 | Already closed upstream; superseded by #1855 |
| #1791 | `modernc.org/sqlite` 1.55.0 → 1.56.0 | Merged `--no-ff` → auto-closes |
| #1853 | `claude-code-action` 1.0.189 → 1.0.193 | Merged `--no-ff` → auto-closes |
| #1855 | `cloudflare/sandbox` 0.12.1 → 0.12.7 | Applied by hand (supersedes 0.12.5). Close manually |
| #1856 | `react` + `@types/react` | Applied by hand **+ `react-dom`**. Close manually |
| #1854 | `@commitlint/config-conventional` | Applied by hand **+ `@commitlint/cli`**. Close manually |
| #1857 | `wrangler` 4.118.0 → 4.123.0 | Applied by hand. Close manually |

Dependabot force-pushed new heads for #1796, #1801 and #1855 after #1842 was built, so only
#1790's original head is still reachable from the branch. The others must be closed by hand
with a comment pointing at this PR — GitHub cannot auto-close them.

## Research findings

### F1 — Dependabot systematically ships only half of a paired bump

Three of the nine had a second half Dependabot structurally cannot see, because it bumps one
manifest at a time and has no cross-ecosystem grouping:

- **`cloudflare/sandbox`**: it rewrites the `FROM` digest only. The npm client
  (`@cloudflare/sandbox`) and the human "reviewed source tag" comment stay behind. The image's
  container-server and the npm client speak the same versioned HTTP API, so drift is a runtime
  protocol mismatch no type check or unit test observes.
- **`react`**: grouped with `@types/react` but **not** `react-dom`, which ships from the same
  repo and must match `react` exactly. Merging #1856 as-authored would have shipped
  `react@19.2.8` against `react-dom@19.2.7`.
- **`@commitlint/config-conventional`**: `@commitlint/cli` is released in lockstep and 21.2.2
  exists.

→ **Checklist C1, C2, C3.** The repo already had this convention recorded for
`typescript-eslint` in `pnpm-workspace.yaml` ("Dependabot only proposes the parser"); the
react entry now carries the same note.

### F2 — Node 26 is *Current*, not LTS; the previous agent escalated the choice

From `nodejs/Release/schedule.json` (fetched 2026-08-24):

| Line | Status today | LTS date | End of life |
|------|--------------|----------|-------------|
| 22 | **Maintenance LTS** | 2024-10-29 | 2027-04-30 |
| 24 | **Active LTS** | 2025-10-28 | 2028-04-30 |
| 26 | **Current** | 2026-10-28 | 2029-04-30 |

#1842 left this as an open question for the merge approver, citing one residual risk metadata
could not close: Node 26 ships **undici 8** (major), which changes global `fetch` for the seven
HTTP-heavy agent CLIs baked into the Instant container image.

→ **"Decision: take Node 26" section below, gated by checklist C8.** (C5 is the
unrelated `--no-ff` merge item; F2's gate is the staging agent turn, not C5.)

### F3 — the reason that risk was unverifiable no longer holds

#1842's stated blocker was that Instant/cf-container sessions are disabled on staging
(`CF_CONTAINER_ENABLED='false'`, set 2026-08-11), so `resolveWorkspaceRuntime`
(`apps/api/src/services/workspace-runtime.ts:61`) makes `chat-start` return 409 and the Node 26
image can never actually run an agent turn there.

**Re-checked 2026-08-24: it is now `true`**, on both the staging GitHub Environment and the
deployed `sam-api-staging` worker bindings. The container path is therefore end-to-end
verifiable now. Stored project knowledge (entity `StagingEnvironment`) still says `false` and
is stale.

→ **Checklist C8** (this is what makes C8 possible at all) **and C12.**

### F4 — `apps/www` cannot be staging-verified, and merging deploys it to production

`apps/www` is not in `deploy-staging.yml`; it has its own `deploy-www.yml`, triggered by push
to `main` touching `apps/www/**`, running with `environment: production`. This batch moves
`apps/www` to Astro 7, so **merging fires a production marketing-site deploy**. Verification
must be done against a real local Astro 7 build, and `deploy-www.yml` must never be
workflow_dispatch'd from this branch (it would publish unreviewed changes publicly).

→ **Checklist C7.**

### F5 — a green CI badge does not mean the Playwright visual audit passed

`Playwright Visual Tests` sets `continue-on-error` and its "Fail if Playwright timed out" step
only echoes a warning, so the job always concludes success. It has been running ~205 failures
on every branch for days. Do not cite CI green as visual-audit evidence; compare against the
pre-existing red set. This batch touches no `apps/web/` source, so rule 17 does not apply, but
the pre-existing failures must not be misread as a regression from the react bump.

→ **Checklist C6a.**

### F6 — lockfile text-merges produce resolutions no resolver would generate

This branch already hit this once (a bad `@types/node` combo from text-merging two npm PRs).
`pnpm-lock.yaml` conflicts must be resolved by taking one side wholesale and re-running
`pnpm install`, never by hand-merging hunks. Several of the stale Dependabot lockfiles also
contained `zod@4.4.3 → 4.3.6` **downgrades**, artifacts of being generated against an older
`main`; regeneration is what discards them.

→ **Checklist C4.**

## Decision: take Node 26, gated on end-to-end verification

Project policy `1b930820` grants agents autonomy over dependency/upgrade strategy and says
"prefer LTS". Policy also lists this exact class as something to decide and document rather
than escalate. Taking Node 26 rather than the Active-LTS 24:

1. **The objection was unverifiability, and that premise is now false (F3).** The escalation
   was not "26 is wrong", it was "undici 8 cannot be exercised through the deployed container".
   It can now, so the risk gets closed empirically instead of by preference.
2. **"Prefer LTS" points weakly here.** Node 24 goes to Maintenance on **2026-10-20**, eight
   weeks out; Node 26 becomes LTS on **2026-10-28**, nine weeks out, and is supported to
   2029-04-30 vs 24's 2028-04-30. Choosing 24 means landing on a line that goes to maintenance
   almost immediately and re-bumping to 26 shortly after.
3. Node 22 is already **Maintenance LTS**, so staying is not neutral either.
4. The image work is already done and locally validated (builds, every agent CLI executes,
   undici 8 `fetch` exercised in the pinned image).

**Fallback, and it is a real one:** if the staging Instant agent turn fails on Node 26, switch
`apps/api/Dockerfile.vm-agent-container` to `24-bookworm-slim`
(`sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03`, verified present)
and re-verify. That is a one-line change. **Node 26 does not merge unverified.**

## Implementation checklist

- [x] **C0** Merge `origin/main` into the branch; resolve `CLAUDE.md` + `pnpm-lock.yaml`
- [x] **C1** `cloudflare/sandbox` → 0.12.7 across *all three* sites (digest, npm pin, comment),
      digest re-verified against the Docker Hub manifest API
- [x] **C2** `react`/`react-dom`/`@types/react` bumped together; lockstep rationale recorded
      in `pnpm-workspace.yaml`
- [x] **C3** `@commitlint/config-conventional` **and** `@commitlint/cli` → 21.2.2
- [x] **C4** `wrangler` → 4.123.0; lockfile regenerated (not text-merged); confirmed no
      `zod` downgrade and no unrelated drift survived
- [x] **C5** `#1791` and `#1853` merged `--no-ff`, heads confirmed reachable; action SHA
      verified by dereferencing the annotated tag `v1.0.193`
- [x] **C6** Full local suite green; test totals reconciled against a `main` baseline
      (rule 02 — a dropped file count is invisible in a failure count). Branch
      post-merge `apps/api` = 600 files / 8137 tests, **identical to the baseline**;
      an apparent -1/-20 delta was a timing artifact (the branch run predated the
      main merge by 43s) and was re-run to prove it, not explained away.
- [ ] **C6a** Do not cite CI-green as Playwright visual-audit evidence (F5); this batch
      touches no `apps/web/` source so rule 17 does not apply, but the ~205 pre-existing
      Playwright failures must not be misread as a regression from the react bump
- [x] **C13** Extend `dependency-governance.test.ts` to enforce the lockstep groups
      (react/react-dom, typescript-eslint trio, vitest/coverage-v8, commitlint pair),
      each mutation-proven to go red. Also aligned `vitest` 4.1.5 -> 4.1.7, which was
      violating `@vitest/coverage-v8`'s EXACT peer pin
- [ ] **C7** `apps/www` Astro 7 build verified locally at 375 and 1280 against an `origin/main`
      build, to separate regressions from pre-existing layout
- [ ] **C8** Staging: real Instant (cf-container) agent turn on the deployed Node 26 image —
      the gate for the F2 decision
- [ ] **C9** Staging: VM provisioning + heartbeat (rule 22; `packages/vm-agent` changed, so
      rule 27's delete-nodes-first applies), then delete node + workspace
- [ ] **C10** Full rule-13 regression sweep at both viewports
- [ ] **C11** Close the six non-auto-closing Dependabot PRs with a comment naming this PR
- [ ] **C12** Correct the stale `StagingEnvironment` knowledge observation (F3)

## Acceptance criteria

- [ ] All nine Dependabot PRs are closed or merged, none silently dropped
- [ ] `pnpm lint`, `typecheck`, `test`, `build`, and `check:fast` pass; test totals ≥ baseline
- [ ] `quality:dependency-governance` passes, asserting sandbox 0.12.7 on both sides
- [ ] A real agent turn completes on the deployed Node 26 container image on staging, **or**
      the batch falls back to Node 24 LTS and re-verifies
- [ ] Staging regression sweep clean; staging left at zero live nodes/workspaces
      (Hetzner's 10-server cap is shared with production)
- [ ] Production `deploy.yml` run matching the merge `headSha` reaches `conclusion=success`,
      and `deploy-www.yml` (fired by the `apps/www` change) also succeeds

## References

- `.claude/rules/13-staging-verification.md`, `30-never-ship-broken-features.md` — the gate
- `.claude/rules/22-infrastructure-merge-gate.md`, `27-vm-agent-staging-refresh.md` — VM verify
- `.claude/rules/02-quality-gates.md` — "a green test count is not a green suite"
- `.claude/rules/61-guards-must-cover-every-runtime.md` — VM *and* cf-container both count
- Policy `1b930820` (autonomy over upgrade strategy), `f9ae7f88` (consolidated staging sweeps),
  `a63e6a68` (shared 10-server Hetzner cap)
