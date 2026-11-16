# Extract cron parsing into packages/cron (services split, slice 1)

SAM task `01M7HX1VGDCD7Z45K59Q5PMCPB` (stream C of idea `01M7H32EK6S4E31EHWVSJSENR5`).
Seam map: idea `01M7HXHPQ46H3YK0GC9Q2QHAFF`. Channel: `feature.agent-context`.
Branch: `sam/stream-c-agent-context-5pmcpb`.

## Problem

`apps/api/src/services` holds about 130K non-test lines in one directory. Every file under
`apps/api` loads 258.8 KB from 35 path-scoped rules on first access, whatever it is about. Smaller
packages with a clear subject let each rule load only where it applies. This is the first slice of
the services split, following the PR #2681 package template
(`tasks/archive/2026-11-12-worker-modularization.md`, "Package template").

## Research findings

- `services/cron-utils.ts` (574 lines): a self-contained five-field cron parser. It validates
  expressions, computes the next fire time in a timezone, and describes a schedule in words. It
  imports only `@simple-agent-manager/shared`, with no `Env`, bindings, D1 or I/O.
- Importers (10 source files): `operation-ports.ts`, `routes/tasks/crud.ts`, `routes/triggers/crud.ts`,
  `routes/mcp/trigger-create-tool.ts`, `routes/mcp/trigger-tool-shared.ts`, `routes/mcp/trigger-tools.ts`,
  `scheduled/cron-triggers.ts`, `services/trigger-create.ts`, `services/trigger-read.ts`,
  `services/trigger-status.ts`.
- Tests: `tests/unit/services/cron-utils.test.ts` (40 cases, pure) moves with the code. Five
  other worker tests import or `vi.mock` the old path and are repointed:
  `tests/unit/routes/triggers.test.ts`, `tests/unit/services/cron-sweep.test.ts` (mocks),
  `tests/unit/services/trigger-status.test.ts`, `tests/unit/routes/mcp-list-triggers.test.ts`,
  `tests/unit/scheduled/capacity-pool-continuation-cron-config.test.ts`, and
  `tests/workers/cron-trigger-sweep.test.ts`.
- Open PRs: only #2784 and #2786 edit an importer (`operation-ports.ts`), on lines away from the
  cron import, so Git merges cleanly. No open PR edits `cron-utils.ts`.
- Rules: none names `cron-utils.ts`. Every one of the 36 path-scoped rules that loaded for it under
  `apps/api` (after #2790) was decided individually; PR #2788's body has the table. None applies to
  a pure parser. Rule 51 (runtime boundary validation) loads for every other worker package because
  they parse `unknown` JSON, rows or fetch responses. This package receives typed strings, and the
  untrusted request body is parsed by `apps/api/src/schemas/triggers.ts`, which keeps rule 51.
  Rule 73 loads anyway (scoped to every `.ts` file since #2790). The launch rules (constitution,
  81 work bounds) still apply everywhere.
- First choice was text-to-speech (`services/tts*.ts`). It was dropped because the package needs
  `@mastra/core` and `workers-ai-provider`, and pnpm resolved their peer dependencies (`zod`, `ai`)
  differently for a new importer (zod 4.6.7 vs the worker's 4.5.4). That creates a second instance
  of each library in the worker bundle. Recorded on the seam map.
- No re-export shim at the old path: every importer is repointed instead, because an unused shim
  is dead code (PR #2681 kept shims only to avoid touching hundreds of importers).

## Checklist

- [x] `packages/cron` from the worker-core template: package.json, tsconfig, vitest config, `src/index.ts`, AGENTS.md
- [x] `git mv` `cron-utils.ts` to `packages/cron/src/`; `git mv` its unit test to `packages/cron/tests/unit/`
- [x] Repoint the 10 source importers and 6 tests to `@simple-agent-manager/cron`
- [x] Wire `apps/api/package.json`, lockfile, CI path filters (`ci.yml` api/packages/cli, `e2e-smoke.yml`), `quality:runtime-boundary-semantics` scope, `scripts/quality/ast-checks.ts` scope
- [x] `pnpm quality:agent-context-budget --write`, then `--check` (new package directory gets an AGENTS.md index)
- [x] CLAUDE.md structure and build order, `08-architecture.md` package list, local-development guide build order
- [x] Prove a pure move: moved file identical to main; diff limited to import specifiers; bundle size before and after; test counts
- [x] Measure rule load before and after for the moved code

## Acceptance criteria

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` green; the package builds and tests on its own
- [x] `cron-utils.ts` is byte-identical to main after the move
- [x] Test case count unchanged (40 moved, the rest unchanged)
- [x] Boundary lint covers the new package (no `apps/*` import, entry points only)
- [ ] Staging: creating a cron trigger stores the right next fire time and description, and the trigger list shows them
- [x] Rule bytes on first access of the moved code reported before and after

## Evidence

- `git diff -M` reports `{apps/api/src/services => packages/cron/src}/cron-utils.ts` as a 100% rename (0 lines changed).
- Worker bundle (`wrangler deploy --dry-run`): 32,560,747 bytes before, 32,560,844 after. The cron module's code is identical with whitespace removed; the rest of the difference is path comments and wrangler's per-module polyfill init calls.
- Tests: 40/40 in `packages/cron`; the 5 repointed worker unit test files (41 cases) and `tests/workers/cron-trigger-sweep.test.ts` (19) pass.
- Rule load on first access: 271.5 KB / 36 rules (`apps/api/src/services/cron-utils.ts`, main `30ae952ae`) → 12.7 KB / 1 rule (`packages/cron/src/cron-utils.ts`).
- Reviews: architecture-reviewer (no HIGH; web editor's duplicate parser is a follow-up on the seam map), task-completion-validator (no HIGH; ast-checks scope added), cloudflare-specialist (PASS).
