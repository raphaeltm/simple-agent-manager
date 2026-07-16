# Wire the `test:workers` (workerd/Miniflare) suite into CI

## Problem

`apps/api/tests/workers/**` — the only test tier that exercises Durable Object
code against a **real** `SqlStorage`/DO SQLite boundary (via
`@cloudflare/vitest-pool-workers`, config `apps/api/vitest.workers.config.ts`) —
is **not run in CI**. `test:workers` is a standalone `package.json` script
(`apps/api/package.json`), is not a turbo task (`turbo.json` defines only
`test`/`test:coverage`), and no workflow under `.github/workflows/` invokes it.

Consequence: there is currently **no automated tier (CI or local sandbox)** that
proves DO read/write paths work against real SQLite type/NULL coercion. Node-pool
unit tests mock `SqlStorage.exec` directly, so they cannot catch bugs that depend
on real SQLite behavior (rule 35 vertical-slice intent, rule 10 capability tests).

## Context / where discovered

Found by the `test-engineer` review of the sessions-list `INTERNAL_ERROR` fix
(branch `claude/fix-requested-9f2ry7`). The task file for that fix framed the
missing real-DO test as a *sandbox-only* limitation (the workerd pool crashes in
the remote sandbox with "Worker exited unexpectedly"); the reviewer correctly
noted the gap is broader — the suite is not wired into CI at all, so it would not
have run even outside the sandbox.

## Acceptance criteria

- [ ] `test:workers` (or `vitest.workers.config.ts`) runs in CI (a dedicated job
      in `.github/workflows/ci.yml`, or folded into the existing Test job).
- [ ] The job is required/visible enough to block merge on failure, consistent
      with how the node-pool `test` job is treated.
- [ ] Confirm the workerd pool runs green in the GitHub Actions runner (it may
      need specific runner resources; the crash observed in the remote agent
      sandbox is environment-specific).
- [ ] Once wired, add the real-DO vertical-slice test for `listSessions` that was
      deferred in the sessions-list fix (seed ~1,500 real `chat_sessions` rows +
      large message history; assert the read returns bounded results and never
      throws).

## Notes

- This is a pre-existing, systemic CI gap — not introduced by the sessions-list
  fix. It is filed separately from the observability-MCP gap
  (`tasks/backlog/2026-07-16-observability-mcp-outcome-parsing-gap.md`).
