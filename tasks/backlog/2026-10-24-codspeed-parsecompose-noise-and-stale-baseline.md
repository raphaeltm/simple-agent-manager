# CodSpeed fails PRs on `parseCompose` noise, against a stale baseline

> **Reconciliation 2026-10-26:** The stale base comes from the `on.push.paths` filter in
> `.github/workflows/codspeed.yml:4-10`, not from failing runs. A main commit that touches nothing
> under `packages/shared/`, `package.json` or the pnpm lock/workspace files gets no run, which is why
> `ae5500a1d`, `0895115a7`, `45c7490fd` and `39f1ff62c` have none; every main run that started
> succeeded, through `a3a802caa`. Still open: the `parseCompose` noise floor, a decision on the
> filter, and the docs note.

## Problem

`CodSpeed Performance Analysis` reports `parseCompose - minimal single service` as a ~14%
regression on PRs that cannot have caused it, and it does so **intermittently** — the same code
passes and fails across successive pushes.

Measured on PR #2436 across seven heads, every one containing an identical `packages/shared`
change:

| head        | CodSpeed check |
| ----------- | -------------- |
| `821161df7` | success        |
| `96ae4f38a` | success        |
| `f9dbc6dce` | **failure**    |
| `3cc0fe8d0` | success        |
| `9177c3827` | (no check)     |
| `d53f46b06` | success        |
| `72b04c764` | **failure**    |

The cleanest pair is the last two. `git diff --stat d53f46b06..72b04c764` is **one line in
`apps/web/tests/unit/pages/ideas-view-model.test.ts`** — an import reordered to satisfy
`simple-import-sort`. `packages/shared/bench/shared.bench.ts` imports nothing from `apps/web`
and cannot observe that change. Success, then failure, on benchmarked code that is byte-identical.

A real 14% regression does not alternate. This is measurement noise on a sub-5ms benchmark.

## Second, independent problem: the baseline is stale

Every report carries CodSpeed's own footnote:

> No successful run was found on `main` (39f1ff6) during the generation of this report, so
> `2a8f6d5` was used instead as the comparison base. There might be some changes unrelated to
> this pull request in this report.

`codspeed.yml`'s last successful run on `main` is **`2a8f6d58b` at 09:30:53Z (2026-10-24)**. Main
has since advanced through `ae5500a1d`, `0895115a7`, `45c7490fd` and `39f1ff62c` with no
successful CodSpeed run on any of them, so every PR is compared against a base that drifts
further behind all day. (In this instance `packages/shared` happened not to change in that gap,
so the stale base did not itself cause the diff — but it will the moment shared code moves.)

## Why it matters

It is a red check on PRs whose authors cannot act on it. The suggested remedies are "fix the
performance issue" or "acknowledge it on CodSpeed" — the first is impossible when the code is
unchanged, and the second normalises acknowledging regressions, which defeats the gate.

## Acceptance criteria

- [ ] `parseCompose - minimal single service` either stops reporting regressions on unrelated
      diffs, or is excluded from the gate with a written reason. Do NOT simply widen the
      threshold without establishing the noise floor first — measure repeated runs of identical
      code and state the spread.
- [ ] Identify why `codspeed.yml` stops producing successful `main` runs, so the comparison base
      tracks `main` rather than drifting. A gate whose baseline is hours stale is not a gate.
- [ ] A short note in the contributing or CI docs telling agents how to distinguish a real
      CodSpeed regression from this one: check the check's conclusion across heads that contain
      the same benchmarked code, and read the `unexpected-base` footnote.

## Evidence

PR #2436, 2026-10-24. Verdicts per head above; the single-line delta measured with
`git diff --stat`; the base footnote quoted from the check-run summary via
`gh api repos/.../commits/<sha>/check-runs`.
