# Worker Core Package (packages/worker-core)

## Purpose

The small kernel every API worker module needs, so modules extracted from `apps/api` do not each
invent their own logger, errors, ids, validation helpers or timeouts. It also owns the D1 schema.
Part of the worker modularization (`tasks/active/2026-11-12-worker-modularization.md`).

The package reads no environment and imports nothing from `apps/*`. When it needs something the
worker owns, it declares a port (see `LoggedErrorSink`) and the worker passes the implementation in.

## Entry points

| Import                                     | Contents                                                      |
| ------------------------------------------ | ------------------------------------------------------------- |
| `@simple-agent-manager/worker-core`        | Everything below except the schema (`src/index.ts`)           |
| `@simple-agent-manager/worker-core/schema` | Drizzle D1 schema (`src/schema.ts`), for `import * as schema` |

## Key Files

| File                                | Purpose                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `src/logger.ts`                     | Structured JSON logger, `serializeError`, `createErrorSinkLogger` (port-based) |
| `src/credential-token-redaction.ts` | The one definition of credential token shapes (`redactCredentialTokens`)       |
| `src/d1-error-code.ts`              | D1 failure classification (`d1CauseCode`, `d1ErrorCategory`)                   |
| `src/errors.ts`                     | `AppError` and the `errors` factory used by route handlers                     |
| `src/runtime-validation.ts`         | Valibot helpers for runtime JSON boundaries                                    |
| `src/bounded-request-body.ts`       | Size-bounded request body reader                                               |
| `src/fetch-timeout.ts`              | `fetchWithTimeout`, `withDeadline`, `getTimeoutMs`                             |
| `src/d1-limits.ts`                  | `D1_MAX_BOUND_PARAMETERS`, `chunk`                                             |
| `src/ulid.ts`                       | ULID generation                                                                |
| `src/route-helpers.ts`              | `parsePositiveInt` (env/number parsing), `requireRouteParam`                   |
| `src/durable-object-retry.ts`       | Durable Object RPC error classification and retry config                       |
| `src/search-query-limits.ts`        | Search input normalization and limits (`SearchQueryLimitEnv`)                  |
| `src/fts5.ts`                       | `buildSafeFtsQuery` for SQLite FTS5                                            |
| `src/schema.ts`                     | D1 schema. Migrations stay in `apps/api/src/db/migrations/`                    |

The worker keeps a re-export file at each old path (`apps/api/src/lib/logger.ts`,
`apps/api/src/db/schema.ts`, ...), so existing importers are unchanged. New code imports the
package entry point. The worker-owned `createInstrumentedLogger` (observability D1 writer plugged
into `createErrorSinkLogger`) stays in `apps/api/src/lib/logger.ts`.

## Commands

```bash
pnpm --filter @simple-agent-manager/worker-core build       # Compile TypeScript
pnpm --filter @simple-agent-manager/worker-core test        # Run Vitest
pnpm --filter @simple-agent-manager/worker-core typecheck   # Type check only
pnpm --filter @simple-agent-manager/worker-core lint        # ESLint
```

## Conventions

- Admission rule (coordinator, 2026-11-12): a helper joins worker-core only if it has no domain
  knowledge and at least two packages need it. Otherwise it belongs to a domain package.

- Depends only on `@simple-agent-manager/shared` and third-party libraries.
- No function accepts the worker `Env`. Take explicit values or a narrow interface.
- Changing `src/schema.ts` still needs a D1 migration in `apps/api/src/db/migrations/`; see
  `apps/api/.claude/rules/31-migration-safety.md`.
