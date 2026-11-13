# W5: extract ai-proxy into @simple-agent-manager/ai-proxy

Workstream W5 of `tasks/archive/2026-11-12-worker-modularization.md` (core branch
`sam/help-identify-parts-worker-embcza`). Branch `sam/w5-ai-proxy` from core `79e5e1b71`.
Draft PR into core. No staging, no CodeRabbit, no merge (coordinator task 01M77BJHHNW5714E98DEEMBCZA).

Taken by the W4 agent in the same workspace. Provider weekly usage was 84% at start
(2026-11-12 17:14 UTC), so push after every step: another agent may continue from the last push.

## Scope inventory (core 79e5e1b71)

| Area                                         | Files | Lines |
| -------------------------------------------- | ----- | ----- |
| `services/ai-*`                              | 9     | 2,794 |
| `routes/ai-proxy*`                           | 11    | 2,874 |
| `durable-objects/ai-token-budget-counter.ts` | 1     | 199   |

Outside importers: the worker entry (`index.ts`: the DO class and 3 route modules),
`sam-session` (agent-loop, operator model/agent), `diagnosis-runner`, `debug-agent-*`,
`task-title`, `platform-trial`, `operations/team-usage` (now in `packages/operations`),
admin routes (`admin-ai-proxy`, `admin-ai-usage`, `admin-ai-allowance`, `admin-costs`),
`usage`, `trigger-webhooks-signed`, `scheduled/platform-feedback-hourly`.

### Package candidates (services + DO)

| Module                         | Worker dependencies to cut                                                      |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `ai-anthropic-translate`       | none (worker-core runtime-validation)                                           |
| `ai-model-tier-gate`           | none                                                                            |
| `ai-proxy-shared`              | `Env` only (AI_GATEWAY_ID, CF_ACCOUNT_ID, CF_API_TOKEN)                         |
| `ai-token-budget`              | `Env` only (limits, AI_TOKEN_BUDGET_COUNTER)                                    |
| `ai-token-usage-accounting`    | `Env` only (KV)                                                                 |
| `ai-monthly-cost-cron`         | `Env` only (KV, AI_GATEWAY_ID, page and TTL tunables)                           |
| `ai-gateway-logs`              | `resolveAdminSetting` (admin settings): port                                    |
| `ai-billing`                   | `getPlatformAgentCredential` + `getCredentialEncryptionKey`: credentials port   |
| `ai-token-budget-counter` (DO) | `Env` generic only; class moves, worker entry re-exports it under the same name |

### Stays in the worker

- `services/ai-proxy-auth.ts`: request authentication (JWT, node callback auth, workspace
  callback identity, deletion signal, runtime-asset preload). It is auth middleware, so it stays.
- `routes/ai-proxy*`: Hono handlers using auth, rate-limit middleware, credential-limit events,
  composable credentials and runtime assets. They stay as worker adapters over the package.

### Ports

- `credentials`: `getPlatformAgentCredential(db, agentType, encryptionKey)` as used by `ai-billing`
  (the route-side callers stay in the worker and keep their direct imports).
- `adminSettings`: `resolveAdminSetting` for `ai-gateway-logs`.

## What moved (step 1 and 2 done together: W0 is on core)

- `packages/ai-proxy/src`: the 8 services and the `AiTokenBudgetCounter` class, `env.ts`
  (`AiProxyEnv`, the worker `Env` extends it and lost the 15 fields it now declares), `ports.ts`
  (`getPlatformAnthropicKey`, `externalReadTimeoutMs`), `index.ts` (named re-exports), and a
  test-only `./internal/*` entry.
- Worker: `services/ai-proxy-ports.ts` (`aiProxyPorts(env, db?)`). Old paths are named re-exports;
  `ai-billing`, `ai-gateway-logs` and `ai-monthly-cost-cron` keep wrappers with their original
  signatures that bind the ports. `durable-objects/ai-token-budget-counter.ts` re-exports the class,
  so `index.ts` and `wrangler.toml` are unchanged.
- `ai-proxy-shared` in the package no longer re-exports the auth helpers; the worker adapter does.
- Lint: took W3's generic `packageInternalPath` rule unchanged (identical hunk, so it merges cleanly).

## Tests

Baseline on core `79e5e1b71`: every test file importing an in-scope module, 25 files / 428 cases
(all unit pool; no Workers-pool file).

After: package 9 files / 140 cases; apps/api 17 files / 288 cases. 140 + 288 = 428, none deleted.
Plus the new worker port test (`tests/unit/services/ai-proxy-ports.test.ts`, 3 cases): 431 in total.
`routes/ai-proxy-anthropic.test.ts` was split: shared-helper cases moved to the package, the 6
request-auth cases stay in the worker. Two route tests (`ai-proxy-accounting`,
`ai-proxy-passthrough`) now mock `@simple-agent-manager/ai-proxy/internal/ai-token-budget`, because
the token accounting calls `incrementTokenUsage` inside the package (13 cases failed before that).

## Progress

- [x] Scope inventory and port plan
- [x] Draft PR into core (#2699)
- [x] Step 1 + 2: package with narrow `AiProxyEnv`, ports, public entry; old paths re-export; tests moved
- [x] Worker port adapter test (`aiProxyPorts`, 3 cases, proven red with the wrong encryption key), package AGENTS.md, public entry trimmed to used names
- [x] Registrations: ci.yml + e2e-smoke filters, runtime-boundary, AST scope, build order, api-reference skill path (dependency evidence and runtime-tunables pass unchanged)
- [x] Local gates; reviews: architecture PASS (MEDIUM dead re-exports and LOW banners fixed), task-completion WARN -> fixed (lint export order in `ai-proxy-shared.ts`)
- [x] CI via `gh workflow run ci.yml --ref sam/w5-ai-proxy`; send PR URL, SHA and run ID to coordinator (run 43273952003 green on b74670ba5; PR #2699 merged into the core branch)
