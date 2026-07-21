# Remove Cross-Purpose SANDBOX_* Env Fallbacks From Instant Container Runtime Settings

## Problem

`resolveRuntimeSettings` in `apps/api/src/durable-objects/vm-agent-container-runtime.ts` resolves the Instant container port-ready timeout as `env.CF_CONTAINER_PORT_READY_TIMEOUT_MS || env.SANDBOX_EXEC_TIMEOUT_MS`. `SANDBOX_EXEC_TIMEOUT_MS` is the MCP/tool-sandbox command execution timeout (consumed independently by `apps/api/src/services/sandbox.ts`) and is semantically unrelated to container port readiness. A deployment that sets `SANDBOX_EXEC_TIMEOUT_MS` for its intended purpose silently changes container port-readiness behavior instead of falling through to `DEFAULT_CF_CONTAINER_PORT_READY_TIMEOUT_MS`.

Sibling fallbacks with the same cross-purpose shape exist for `SANDBOX_VM_AGENT_PORT` and `SANDBOX_SLEEP_AFTER` (see `vm-agent-container.ts` sleepAfter resolution: `env.CF_CONTAINER_SLEEP_AFTER || env.SANDBOX_SLEEP_AFTER`).

## Context

Found by the constitution-validator during the 2026-07-21 Instant runtime recovery review (branch `sam/diagnose-fix-remaining-production-0dvhf5`). The pattern predates that PR — the diff only relocated the expression into `resolveRuntimeSettings` — so it was filed as follow-up cleanup rather than fixed in the recovery PR.

The `SANDBOX_*` names look like leftovers from the Cloudflare Sandbox SDK era of the Instant runtime. If any deployment still sets them intentionally as container knobs, migration needs a deprecation note in the config reference.

## Acceptance Criteria

- [ ] Audit every `SANDBOX_*` fallback read inside the cf-container runtime path (`vm-agent-container*.ts`) and decide keep/deprecate/remove for each, with a one-line rationale in this file.
- [ ] Remove (or explicitly deprecate with a documented migration window) the `SANDBOX_EXEC_TIMEOUT_MS` fallback for `portReadyTimeoutMs`.
- [ ] `pnpm quality:*` gates and unit tests updated (see `apps/api/tests/unit/durable-objects/vm-agent-container-runtime-settings.test.ts`).
- [ ] `apps/www/src/content/docs/docs/reference/configuration.md` and `apps/api/.env.example` updated to match the final behavior.
