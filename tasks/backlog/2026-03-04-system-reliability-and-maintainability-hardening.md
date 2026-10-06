# System Reliability and Maintainability Hardening

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - `packages/providers` no longer reads `process.env` (`packages/providers/src/index.ts:209`).
>   - Cron handler extracted to `apps/api/src/scheduled/handler.ts`; agent port configurable via
>     `VM_AGENT_PORT` (`apps/api/src/index.ts:583`).
>   - Provisioning waits run in Durable Object state machines (TaskRunner steps; direct creation
>     continues from `apps/api/src/durable-objects/node-lifecycle-provisioning.ts`).
>   - API structured logging enforced by `no-console` (PR #581; `eslint.config.mjs:387-392`);
>     wrangler binding check in CI (`.github/workflows/ci.yml:576`).
> - **Still open:**
>   - Split `Env` into focused config objects behind one config service (`apps/api/src/env.ts`
>     is 1,500 lines; the file split alone is tracked in `2026-07-19-split-env-interface.md`).
>   - Extract the subdomain proxy from `apps/api/src/index.ts:189-620` (939 lines; also listed in
>     `2026-04-03-split-oversized-files.md`).
>   - VM agent `/health` states (still static `healthy` in
>     `packages/vm-agent/internal/server/routes.go:13-18`); consistent API/VM agent error codes.

**Status:** backlog
**Priority:** high
**Estimated Effort:** 2 weeks
**Created:** 2026-03-04

## Problem Statement

A deep dive into the system architecture and implementation has revealed several structural weaknesses and "code smells" that threaten the long-term reliability and maintainability of the Simple Agent Manager platform.

Key issues identified:
- **Configuration Overload**: The `Env` interface in `apps/api/src/index.ts` is a "God Interface" with 100+ properties, making the system brittle and hard to test.
- **Monolithic Entry Point**: `apps/api/src/index.ts` is overloaded with routing, global middleware, complex proxy logic for subdomains, and cron orchestration.
- **Cross-Environment Impurity**: `packages/providers` uses `process.env`, which is incompatible with the Cloudflare Workers runtime, leading to potential runtime binding errors.
- **Synchronous Provisioning Risks**: Blocking logic like `waitForNodeAgentReady` within HTTP request cycles risks timeouts due to Cloudflare Worker execution limits.
- **Hardcoded Infrastructure Assumptions**: Critical values (ports, internal naming conventions) are hardcoded in proxy and routing logic.
- **Fragmented Observability**: Inconsistent logging patterns and error handling across TypeScript and Go components.

## Acceptance Criteria

### Phase 1: Configuration & Environment Refactoring
- [ ] Refactor the `Env` interface into focused, injectable configuration objects (e.g., `LimitsConfig`, `TaskConfig`, `InfrastructureConfig`).
- [ ] Implement a unified configuration service in `apps/api/src/services/config.ts` to handle default values and validation (per Constitution Principle XI).
- [ ] Clean up `packages/providers` to use explicit configuration injection instead of `process.env`.

### Phase 2: Orchestration & Proxy Decoupling
- [ ] Extract subdomain proxy logic from `index.ts` into a dedicated Hono middleware or `services/proxy.ts`.
- [ ] Move the `scheduled` (cron) handler logic from `index.ts` into a dedicated orchestration service.
- [ ] Externalize hardcoded infrastructure values (e.g., agent port `8080`) into the new configuration service.

### Phase 3: Reliability & Async Patterns
- [ ] Transition blocking provisioning steps (like `waitForNodeAgentReady`) to an asynchronous, Durable Object-driven state machine.
- [ ] Implement a "Status" field in the Go VM Agent's `/health` endpoint to distinguish between `initializing`, `ready`, and `error` states.
- [ ] Standardize structured logging across all packages using a shared utility.

### Phase 4: Error Handling & Validation
- [ ] Harmonize error handling between the API and VM Agent to ensure consistent error codes and payloads.
- [ ] Add preflight checks for all critical Cloudflare bindings in the deployment pipeline.

## Key Files

- `apps/api/src/index.ts` (Monolithic entry point & Env interface)
- `apps/api/src/routes/workspaces.ts` (Blocking provisioning logic)
- `packages/providers/src/index.ts` (process.env usage)
- `packages/vm-agent/main.go` (Agent lifecycle and health reporting)
- `apps/api/src/services/node-agent.ts` (Agent interaction patterns)

## Approach

1. **Research & Mapping**: Finalize the mapping of all `Env` properties to their functional groups.
2. **Configuration Extraction**: Start by creating the `config.ts` service and migrating the `Env` interface.
3. **Proxy Refactoring**: Move proxy logic to a middleware and verify with integration tests.
4. **Async Migration**: Refactor one provisioning flow (e.g., Workspace Creation) to be fully async via Durable Objects before applying the pattern globally.
5. **Validation**: Ensure all existing E2E and unit tests pass; add new tests for the configuration service and async state machine.
