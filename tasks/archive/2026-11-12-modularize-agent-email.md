# W6: extract agent-email into a package

Brief: `tasks/archive/2026-11-12-worker-modularization.md` ("W6: agent-email", "Package template").
Taken by the W2 agent (SAM task `01M77GDKCKBZP0432E0K38PBBF`) at the coordinator's request
(coordinator task `01M77BJHHNW5714E98DEEMBCZA`). Branch `sam/w6-agent-email`, draft PR into the
core branch `sam/help-identify-parts-worker-embcza`.

## Design

- `packages/agent-email` (`@simple-agent-manager/agent-email`) holds every file of
  `apps/api/src/services/agent-email`. It does its own D1 work through
  `@simple-agent-manager/worker-core/schema` and uses worker-core for logging, ids, validation,
  timeouts and errors.
- Narrow env `AgentEmailEnv` (DATABASE, KV, BASE_DOMAIN, CF_API_TOKEN, CF_ZONE_ID,
  CF_API_TIMEOUT_MS, DOH_RESOLVER_URL, DOH_TIMEOUT_MS, AGENT_EMAIL, AGENT_EMAIL_WORKER_NAME). The
  worker `Env` extends it; AGENT_EMAIL and AGENT_EMAIL_WORKER_NAME moved there.
- `AgentEmailPorts` covers what it needs from the rest of the worker: admin settings, the
  platform-settings read, the hourly KV rate limit, the failed-sweep alert, trigger admission and
  submission, the trigger template renderer, and the Cloudflare API base/timeout/error reader
  (`dns-core`; only this package needs them, so they do not meet the worker-core rule).
  Package functions that need them take `ports` explicitly.
- The worker builds ports per call with `agentEmailPorts(env, overrides)`
  (`apps/api/src/services/agent-email/ports.ts`); heavy modules load lazily.
- The old `services/agent-email/<file>.ts` paths that are still imported stay as thin adapters:
  named re-exports, plus wrappers with the original signatures that bind the ports. Importers,
  routes, the worker `email()` entry and `vi.mock` paths do not change. The test-only `submitter`
  override moved from the attempt options into the ports.

## Progress log

- 2026-11-12: package created, ports threaded, adapters generated. `tsc` clean for both.
  Agent-email tests: 14 files / 250 tests before; after: 12 / 230 in the worker + 2 / 20 in the
  package (parsing, SPF).
- 2026-11-12: wiring done (`31a7e695f`): ci.yml and e2e-smoke filters, ast-checks,
  runtime-boundary semantic scan, build order, comments repointed, package AGENTS.md.
- 2026-11-12: reviews (architecture, task-completion): no CRITICAL/HIGH. Fixed: adapters now
  export only the names the worker imports (none re-exports a function whose signature changed);
  a light `./definitions` entry for the pure modules, so the admin settings registry and other
  definition-only importers do not load D1 code; a unit test for `agentEmailPorts`; stale comment
  paths; duplicate imports. The full suite found one test (`vm-agent-errors`) whose hand-written
  `drizzle-orm` mock lacked `sql`: the package loads the schema from worker-core, which that test's
  `src/db/schema` mock does not cover. Its `drizzle-orm` mock now keeps the real module underneath.

## Test counts

| Suite                                | Core `2052fb4b4`                         | After W6                                                                   |
| ------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------- |
| Agent-email tests                    | 14 files / 250 tests (all in `apps/api`) | 12 / 230 in `apps/api` + 2 / 20 in the package, + 1 new port test file (5) |
| Static `it`/`test` count, whole repo | 24,580                                   | 24,580 + 5 new                                                             |

None deleted.

## Open items

- The Cloudflare API helpers (`CLOUDFLARE_API_BASE`, `DEFAULT_CF_API_TIMEOUT_MS`,
  `readCloudflareErrorDetail`, in `services/dns-core.ts`) reach the package through
  `ports.cloudflareApi`. When the DNS code is extracted, move them into worker-core (they would
  then have two package consumers) and drop that port.
