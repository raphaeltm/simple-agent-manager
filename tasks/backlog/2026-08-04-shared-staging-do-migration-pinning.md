# One branch's unmerged DO migration blocks staging deploys for every other branch

## Problem

`sam-api-staging` is a **single shared Cloudflare Worker**, but Durable Object migrations are
versioned by a monotonic `tag` in `apps/api/wrangler.toml`. When any branch deploys a migration tag
that does not exist on `main`, the shared Worker advances to that tag — and every other branch,
including `main` itself, becomes **undeployable to staging** until that tag lands on `main`.

Observed 2026-08-04:

- `sam/implement-ready-sam-idea-yb534p` (unmerged, no PR open at the time) added
  `[[migrations]] tag = "v20"` / `new_sqlite_classes = ["DiagnosisRunner"]` and deployed to staging.
- `main` ends at `v19`.
- Every subsequent staging deploy of `sam/auto-run-html-artifact-preview` — a branch touching
  **zero** `apps/api` and zero wrangler files — failed with:

  ```
  Cannot apply new-sqlite-class migration to class 'ProjectData'
  that is already depended on by existing Durable Objects [code: 10074]
  ```

- Reproduced twice, the second time on a **completely idle deploy queue**, ruling out a race.

Note the error names `ProjectData` — a class from an old migration that has nothing to do with the
change. When Wrangler cannot match the remote tag against the local migration list, it appears to
replay from the beginning and fails on the first already-applied SQLite class. **The error therefore
points at an innocent class and an innocent branch**, which makes this expensive to diagnose: the
natural first read is "my branch broke Durable Objects."

## Why this matters

- Staging is a **hard merge gate** (`.claude/rules/13-staging-verification.md`). One agent's
  in-progress branch can therefore block every other agent's merges, indefinitely, with no signal
  that it has done so.
- The failure is silent about its true cause and misattributes blame to the blocked branch.
- `.claude/rules/13`'s existing mitigation — check for active runs, wait 5 minutes — **does not help
  here**. The conflicting run had already *completed*; the damage is the persistent migration state
  it left behind, not concurrency.

## Acceptance Criteria

- [ ] Decide the intended model for DO migrations against shared staging. Options to evaluate:
      (a) block staging deploys from branches whose migration tail is not an ancestor of `main`'s;
      (b) detect the mismatch in `Validate Configuration` and fail fast with an explanatory message
          naming the branch that pinned the tag;
      (c) give migration-bearing branches an isolated Worker/environment;
      (d) require migration-bearing branches to merge before others deploy (process-only, weakest).
- [ ] Implement the chosen mechanism so the failure is either prevented or **self-explanatory**.
      At minimum, when `wrangler deploy` fails with `[code: 10074]`, the deploy workflow should
      surface: "staging is at migration tag X; this branch's list ends at Y; tag X comes from a
      branch not yet merged to main" — instead of the raw `ProjectData` error.
- [ ] Document the constraint in the deploy/staging guidance so agents recognise it immediately.
- [ ] Add a check or test that would have caught this before a human had to diagnose it.

## Context

Discovered while running Phase 6 of `tasks/active/2026-08-04-auto-run-html-artifact-preview.md`.
That branch's first staging deploy (`30958087671`) succeeded and was fully verified; the two later
deploys (`30959346237`, `30961280231`) failed purely due to this pinning, after the other branch
deployed at 23:14:33.

## References

- `.claude/rules/13-staging-verification.md` — staging as a merge gate; the 5-minute active-run wait
  that does not cover this case
- `.claude/rules/31-migration-safety.md` — D1 migration safety (this is the **Durable Object**
  analogue, currently uncovered)
- `apps/api/wrangler.toml` — the `[[migrations]]` tag sequence
