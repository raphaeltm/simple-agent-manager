# Repair stale session ledgers

## Context

Production audit on 2026-08-30 found stale session-ledger rows after terminal
work:

- ProjectData DO `chat_sessions`: historical `status='active'` rows whose D1
  tasks are terminal, inflating `projects.active_session_count`.
- D1 `agent_sessions`: historical `status='running'` rows on deleted
  workspaces.
- D1 `session_summaries`: active rows expected to converge through existing
  ProjectData summary sync after the DO ledger is repaired.

Source idea: `01M18P09B2ER9DB4F1RSN4TZP4`.
SAM task: `01M18TMX6WD777CNBDBZHH4EFQ`.

## Scope

- Repair session ledgers only.
- Do not write terminal task statuses.
- Do not modify supersession, guard, or wake code in:
  - `session-recovery.ts`
  - `session-snapshot-recovery-lifecycle.ts`
  - `task-runtime-liveness.ts`

## Implementation plan

1. Add a one-time D1 migration that terminalizes historical `agent_sessions`
   rows still marked `running` when their workspace row is already `deleted`.
   This is a migration rather than a recurring sweep because the workspace
   lifecycle finalizer now closes new rows; this backlog is finite historical
   drift. The statement is a single WHERE-scoped `UPDATE`.
2. Add additive ProjectData DO columns for a bounded repair skip marker:
   `terminal_reconcile_deferred_until` and `terminal_reconcile_defer_reason`.
3. Add a bounded ProjectData DO RPC that processes active session candidates and
   either:
   - terminalizes them to `stopped` or `failed` matching the resolved terminal
     task outcome,
   - defers them because a live D1 task head still binds the chat session,
   - defers them because a restorable sleeping snapshot exists, or
   - defers them on lookup/eligibility failures so the same row does not churn
     every sweep.
4. Wire the RPC into the existing isolated scheduled operational sweep.
5. Verify via workers-pool tests that the production DO RPC path performs the
   repair and that existing summary sync converges `session_summaries` and
   `projects.active_session_count`.

## Validation evidence

- `pnpm quality:migration-safety` — passed.
- `pnpm quality:do-migration-safety` — passed.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `pnpm --dir apps/api exec vitest run tests/unit/scheduled/sweep-isolation.test.ts tests/unit/scheduled/handler-kill-switch.test.ts` — passed.
- `pnpm --dir apps/api exec vitest run --config vitest.workers.config.ts tests/workers/terminal-session-ledger-reconciliation.test.ts` — passed.
- `pnpm quality:source-contract-tests` — passed.
- `pnpm check:fast` — passed.
- `pnpm quality:ast-checks` — passed after replacing templated DO SQL
  predicates with static SQL literals.
- `GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH=<(gh pr view 1969 --json body,url --jq '{pull_request:{body:.body, html_url:.url}}') pnpm quality:preflight`
  — passed.
- `GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH=<(gh pr view 1969 --json body,url,labels --jq '{pull_request:{body:.body, html_url:.url, labels:(.labels // [] | map({name:.name}))}}') pnpm quality:specialist-review`
  — passed.
- `pnpm --dir apps/api exec vitest run tests/unit/durable-objects/migrations.test.ts`
  — passed after updating the expected DO index count for migration 041.
- `pnpm --dir apps/api exec vitest run tests/unit/routes/project-capacity-pools.test.ts`
  — passed; CI's first generic Test failure in this file was a timeout on rerun.
- Snapshot guard mutation check — disabling the snapshot guard made the
  snapshot-protected control fail with `expected 'stopped' to be 'active'`.
- Live-head guard mutation check — disabling the live-head guard made the
  live-head-protected control fail with `expected 'stopped' to be 'active'`.
- Staging deploy run
  [`33302875182`](https://github.com/raphaeltm/simple-agent-manager/actions/runs/33302875182)
  — deploy and smoke tests passed.
- Final staging deploy run
  [`33304340445`](https://github.com/raphaeltm/simple-agent-manager/actions/runs/33304340445)
  — deploy and smoke tests passed for the post-AST-fix code SHA; counts remained
  stable after the natural 09:50 UTC cron tick.
- Staging D1 before deploy:
  - `agent_sessions` running on deleted workspaces: `75`
  - all running `agent_sessions`: `75`
  - active `session_summaries`: `79`
  - active terminal-tied `session_summaries`: `25`
  - sum of `projects.active_session_count`: `79`
- Staging after deploy plus natural 09:15, 09:20, and 09:25 UTC cron ticks:
  - `agent_sessions` running on deleted workspaces: `0`
  - all running `agent_sessions`: `0`
  - active `session_summaries`: `54`
  - active terminal-tied `session_summaries`: `0`
  - sum of `projects.active_session_count`: `54`
- Staging after final deploy plus the natural 09:50 UTC cron tick remained
  stable:
  - `agent_sessions` running on deleted workspaces: `0`
  - all running `agent_sessions`: `0`
  - active `session_summaries`: `54`
  - active terminal-tied `session_summaries`: `0`
  - sum of `projects.active_session_count`: `54`
- Staging ProjectData DO-backed sample through `/api/account-map`:
  - `hono` (`01KTKXZ4ZZAT6MJFXRW1ZTQ7RB`): D1 active count `15 → 0`; DO-backed
    active slice `2 → 0`.
  - `Deployment Test 1` (`01KVRJCC7Y3NSDQYCPWDRPVJVH`): D1 active count
    `2 → 0`; DO-backed active slice `2 → 0`.

## Specialist review evidence

| Reviewer                  | Status | Outcome                                                                                                                                                                                                 |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task-completion-validator | PASS   | Planned ledger repairs, scheduled isolation, bounded drift reconcile, guard behavior, and summary convergence are represented in the diff and tests; only staging count verification remains pending.   |
| cloudflare-specialist     | PASS   | D1 change is a WHERE-scoped UPDATE; DO migration is additive; scheduled work is bounded and individually isolated; workers-pool test exercises D1 plus ProjectData DO.                                  |
| constitution-validator    | PASS   | New operational limits and retry delay use env vars, DEFAULT constants, and documented caps; no deployment/project identifiers or broad hardcoded limits introduced.                                    |
| env-validator             | PASS   | New `TERMINAL_SESSION_RECONCILE_*` variables are consistently named and documented in Env types, `.env.example`, operator docs, and env-reference.                                                      |
| test-engineer             | PASS   | Coverage includes real scheduled-to-DO path, two-sweep zombie escape, failed-vs-stopped dispositions, summary sync convergence, isolated sweep failure, and discriminating live-head/snapshot controls. |

## Acceptance checklist

- [x] One-time `agent_sessions` backfill is WHERE-scoped and passes migration
      safety.
- [x] Scheduled repair step is independently isolated.
- [x] DO repair batch size and deferral are env-configurable with defaults.
- [x] Every selected DO candidate escapes by repair or defer marker.
- [x] Live task head bound by `tasks.chat_session_id` keeps the session active.
- [x] Restorable sleeping snapshot keeps the session active.
- [x] Snapshot and live-head tests are discriminating controls.
- [x] Two-sweep zombie regression test covers deferred candidates.
- [x] Workers-pool tests exercise the real DO RPC path.
- [x] Staging before/after counts reported after deploy and cron ticks.
