# Make the real Durable Object/Miniflare tier reliable and merge-blocking

## Scope

Reconcile closed PR #1619 and SAM task `01KXQZXGB2VPVPET0JN1Y2F036`, diagnose the final-head workerd crashes, run every repository-discovered worker test in a genuine Cloudflare runtime, and expose one stable required GitHub Actions result. Do not merge this PR.

## Reconciliation evidence

- PR #1619 closed unmerged at `7219669d`; the prior SAM task reported completion without a useful output summary.
- Run `29721018453`, job `88283931687`, used Node 22.23.1 and selected 36 files because final-head `vitest.workers.config.ts` replaced the earlier seven-file constant with `tests/workers/**/*.test.ts`.
- The earlier green commit `a6938dc3c` selected exactly seven files and used `tests/workers/worker-entrypoint.ts`. Final head switched `main` to `src/index.ts`, which statically initialized unrelated Container/Sandbox exports, and upgraded the pool from 0.14.0 to 0.16.18/workerd 1.20260617.1.
- Reproductions at one worker crashed both the repository pin (pool 0.14.0/workerd 1.20260329.1) and current upstream pool 0.18.6/workerd 1.20260714.1 when the full production graph was the test `main`. The focused binding/route entrypoints run cleanly, ruling out file count, concurrency, runner pressure, Node 22 alone, and a single workerd build as primary causes.

## Acceptance checklist

- [x] Discover every `apps/api/tests/workers/**/*.test.ts` file from the filesystem.
- [x] Assign every discovered file to exactly one CI shard and fail inventory validation otherwise.
- [x] Run real DO SqlStorage/D1/alarms/WebSocket/callback behavior without mocks or skipped files.
- [x] Preserve task-scoped ACP reconciliation, ProjectData large-list/history, attention/origin, node lifecycle, and session snapshot/recovery coverage.
- [x] Make crashes and unexpected unhandled errors fatal.
- [x] Add visible shard jobs plus one stable `Durable Object Workers` aggregate check that passes as a no-op for unrelated changes.
- [x] Local green evidence: DO 27 files/449 tests/158.58s; HTTP 9 files/102 tests/64.32s; 36 files/551 tests total, zero skipped.
- [x] Controlled GitHub red proof, followed by removal: run 29831509892 failed the HTTP shard and aggregate on temporary commit c2b6ffbe6; revert a5e0391ab removed it.
- [x] Three consecutive successful final-head Actions attempts recorded in PR #1648 before handoff.
- [x] Repository gates and Cloudflare/test/security/constitution/completion reviews.
- [x] Opened fresh PR #1648 with root cause, compatibility evidence, counts, durations, and run links; do not merge.

## Deployment decision

This is CI/test infrastructure. The focused entrypoints compose production route and Durable Object modules but do not change production runtime code, so shared staging is not required.
