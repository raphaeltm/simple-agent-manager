# Agent Email Package (packages/agent-email)

## Purpose

Agent email: the per-trigger `agent+<key>@agents.<BASE_DOMAIN>` addresses. It covers inbound
delivery (store, then start the email's trigger), retries from storage, replies from a task, the
loopback test, and the admin setup of Cloudflare Email Routing and Email Sending. Part of the
worker modularization (`tasks/active/2026-11-12-worker-modularization.md`, workstream W6).

The package does its own D1 work through `@simple-agent-manager/worker-core/schema`, and uses
worker-core for logging, ids, validation, timeouts and errors. It reads only `AgentEmailEnv`
(`src/env.ts`), which the worker `Env` extends, and it never imports `apps/*`.

## Ports

Everything it needs from the rest of the worker arrives through `AgentEmailPorts`
(`src/ports.ts`): admin settings, the platform-settings read, the hourly KV rate limit, the
failed-sweep alert, trigger admission and task submission, the trigger template renderer, and the
Cloudflare API base URL, default timeout and error reader. Functions that need any of them take
`ports` explicitly.

The worker implements the ports in `apps/api/src/services/agent-email/ports.ts`
(`agentEmailPorts(env, overrides)`). The files beside it keep the old import paths for the names
the worker still imports: named re-exports, plus wrappers with the original signatures that bind
the ports. Routes, the worker's `email()` handler and the cron sweep import those adapters, so they
did not change.

## Entry points

| Import                                          | Contents                                                                                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@simple-agent-manager/agent-email`             | Everything (`src/index.ts`)                                                                                                                                                       |
| `@simple-agent-manager/agent-email/definitions` | Pure modules only: settings definitions, addresses, provider, setup errors and changes, template context (`src/definitions.ts`). For worker code that must not load D1 or drizzle |

## Key Files

| File                                        | Purpose                                                 |
| ------------------------------------------- | ------------------------------------------------------- |
| `src/inbound.ts`                            | The logic behind the Worker's `email()` handler         |
| `src/inbound-delivery.ts`                   | Stored inbound emails, leases, retry schedule (D1)      |
| `src/inbound-process.ts`                    | One delivery attempt through trigger admission          |
| `src/recovery.ts`                           | The cron sweep that retries stored emails               |
| `src/reply.ts`                              | Replies from a task to the email that started it        |
| `src/setup*.ts`                             | Admin setup of Email Routing, Email Sending and SPF     |
| `src/cloudflare-email-api.ts`               | Cloudflare Email Routing and Email Sending API calls    |
| `src/settings.ts`, `setting-definitions.ts` | Admin-editable agent email limits                       |
| `src/setup-state.ts`                        | Whether agent email is on, and the setup attempt record |
| `src/trigger-config.ts`                     | Email trigger address and allowed senders               |

## Commands

```bash
pnpm --filter @simple-agent-manager/agent-email build
pnpm --filter @simple-agent-manager/agent-email test
pnpm --filter @simple-agent-manager/agent-email typecheck
pnpm --filter @simple-agent-manager/agent-email lint
```

The worker resolves this package from `dist/`: build it before typechecking or testing `apps/api`.
Tests that need a database, routes or the trigger pipeline stay in `apps/api/tests` and reach the
package through the worker adapters.

## Conventions

- Depends on `shared`, `worker-core`, `drizzle-orm` and `valibot` (catalog) and `postal-mime`.
- No function accepts the worker `Env`. Add a field to `AgentEmailEnv` only if the package reads it.
- A new dependency on worker code is a new port, not an import.
