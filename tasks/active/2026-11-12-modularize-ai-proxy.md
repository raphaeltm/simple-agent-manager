# W5: extract ai-proxy into @simple-agent-manager/ai-proxy

Workstream W5 of `tasks/active/2026-11-12-worker-modularization.md` (core branch
`sam/help-identify-parts-worker-embcza`). Branch `sam/w5-ai-proxy` from core `79e5e1b71`.
Draft PR into core. No staging, no CodeRabbit, no merge (coordinator task 01M77BJHHNW5714E98DEEMBCZA).

Taken by the W4 agent in the same workspace. Provider weekly usage was 84% at start
(2026-11-12 17:14 UTC), so push after every step: another agent may continue from the last push.

## Scope inventory (core 79e5e1b71)

| Area | Files | Lines |
| ---- | ----- | ----- |
| `services/ai-*` | 9 | 2,794 |
| `routes/ai-proxy*` | 11 | 2,874 |
| `durable-objects/ai-token-budget-counter.ts` | 1 | 199 |

Outside importers: the worker entry (`index.ts`: the DO class and 3 route modules),
`sam-session` (agent-loop, operator model/agent), `diagnosis-runner`, `debug-agent-*`,
`task-title`, `platform-trial`, `operations/team-usage` (now in `packages/operations`),
admin routes (`admin-ai-proxy`, `admin-ai-usage`, `admin-ai-allowance`, `admin-costs`),
`usage`, `trigger-webhooks-signed`, `scheduled/platform-feedback-hourly`.

### Package candidates (services + DO)

| Module | Worker dependencies to cut |
| ------ | -------------------------- |
| `ai-anthropic-translate` | none (worker-core runtime-validation) |
| `ai-model-tier-gate` | none |
| `ai-proxy-shared` | `Env` only (AI_GATEWAY_ID, CF_ACCOUNT_ID, CF_API_TOKEN) |
| `ai-token-budget` | `Env` only (limits, AI_TOKEN_BUDGET_COUNTER) |
| `ai-token-usage-accounting` | `Env` only (KV) |
| `ai-monthly-cost-cron` | `Env` only (KV, AI_GATEWAY_ID, page and TTL tunables) |
| `ai-gateway-logs` | `resolveAdminSetting` (admin settings): port |
| `ai-billing` | `getPlatformAgentCredential` + `getCredentialEncryptionKey`: credentials port |
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

## Tests

Baseline (to record before moving): every test file importing a module above.

## Progress

- [x] Scope inventory and port plan
- [ ] Draft PR into core
- [ ] Step 1: decouple in place (narrow `AiProxyEnv`, ports, public surface)
- [ ] Step 2: lift into `packages/ai-proxy`, old paths re-export, tests move
- [ ] Registrations: CI filters, runtime-boundary, AST scope, dependency evidence, docs paths
- [ ] Local gates, specialist reviews
- [ ] CI via `gh workflow run ci.yml --ref sam/w5-ai-proxy`; send PR URL, SHA and run ID to coordinator
