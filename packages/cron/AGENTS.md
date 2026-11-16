# Cron Package (packages/cron)

## Purpose

Five-field cron expressions for SAM triggers: validation (including the minimum interval), the
next fire time in an IANA timezone, and a plain-language description. A dependency-free parser
with no I/O, no environment and no Cloudflare runtime. Moved out of
`apps/api/src/services/cron-utils.ts` as the first slice of the `apps/api/src/services` split
(seam map: SAM idea `01M7HXHPQ46H3YK0GC9Q2QHAFF`).

## Entry point

`@simple-agent-manager/cron` (`src/index.ts`): `validateCronExpression`, `cronToNextFire`,
`cronToHumanReadable`. The worker imports these directly; there is no re-export at the old path.

## Key Files

| File                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `src/cron-utils.ts`             | Parser, matcher, next-fire search and human descriptions |
| `tests/unit/cron-utils.test.ts` | Validation, next-fire and description coverage           |

## Commands

```bash
pnpm --filter @simple-agent-manager/cron build
pnpm --filter @simple-agent-manager/cron test
pnpm --filter @simple-agent-manager/cron typecheck
pnpm --filter @simple-agent-manager/cron lint
```

The worker resolves this package from `dist/`, so build it before typechecking or testing
`apps/api`. Worker tests that mock the schedule (`vi.mock('@simple-agent-manager/cron', ...)`) stay
in `apps/api/tests`.

## Conventions

- Depends only on `@simple-agent-manager/shared` (the `CronValidationResult` type and
  `DEFAULT_CRON_MIN_INTERVAL_MINUTES`). Keep it that way: no `Env`, D1, fetch or worker import.
  The lint boundary in `eslint.config.mjs` (`boundaryRules`) rejects imports from `apps/*` and deep
  package paths; the dependency list in `package.json` is the rest of the boundary.
- Trigger storage, the cron sweep and the trigger routes stay in the worker.

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

## Rules for this directory

Read the rules whose scope covers the files you will change before editing. Claude Code
loads them by itself on file access; other harnesses must open them.

No path-scoped rules apply to this directory.

<!-- END GENERATED RULE INDEX -->
