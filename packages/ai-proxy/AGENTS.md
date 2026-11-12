# AI Proxy Package (packages/ai-proxy)

## Purpose

The platform AI proxy's non-HTTP logic: upstream billing auth (Unified Billing vs platform key),
AI Gateway log reads and aggregation, the monthly cost cache cron, per-user token budgets and
allowances, model-tier gating, token-usage accounting on proxied responses, Anthropic/OpenAI
translation, and the `AiTokenBudgetCounter` Durable Object class. Part of the worker
modularization (`tasks/active/2026-11-12-worker-modularization.md`, workstream W5).

It reads only `AiProxyEnv` (`src/env.ts`), which the worker `Env` extends, uses worker-core for
logging, validation, timeouts and errors, and never imports `apps/*`.

## Ports

What it needs from the rest of the worker arrives through `AiProxyPorts` (`src/ports.ts`): the
decrypted Claude Code platform credential (platform-key billing) and the
`performance.externalReadTimeoutMs` admin setting (AI Gateway log reads). Functions that need a
port take it explicitly.

The worker implements the ports in `apps/api/src/services/ai-proxy-ports.ts`
(`aiProxyPorts(env, db?)`). The old `apps/api/src/services/ai-*.ts` files keep their import paths:
named re-exports, plus wrappers with the original signatures for `resolveUpstreamAuth`,
`iterateGatewayLogs` and `runMonthlyCostAggregation` that bind the ports.

## What stays in the worker

- `routes/ai-proxy*`: the Hono handlers (auth, rate limits, credential-limit events, composable
  credentials, runtime assets).
- `services/ai-proxy-auth.ts`: request authentication. The worker's `services/ai-proxy-shared.ts`
  re-exports it next to the package's shared helpers, as before.
- `durable-objects/ai-token-budget-counter.ts` re-exports the class so the worker entry exports
  `AiTokenBudgetCounter` under the same name; `wrangler.toml` is unchanged.

## Entry points

| Import                                      | Contents                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `@simple-agent-manager/ai-proxy`            | Public entry: the names the worker uses, `AiProxyEnv`, `AiProxyPorts`     |
| `@simple-agent-manager/ai-proxy/internal/*` | apps/api tests only, to mock a module the package calls internally (lint) |

## Tests

`tests/unit` covers the package modules directly. Worker tests that reach package code through a
route mock `@simple-agent-manager/ai-proxy/internal/<module>`, because a `vi.mock` of the worker
re-export does not reach calls made inside the package.
