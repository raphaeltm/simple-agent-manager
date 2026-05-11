# Agent Settings API Hardening

## Problem

A 2026-05-11 spot check of the agent settings API slice found that it does not meet the repository quality bar. The surface is bounded to `apps/api/src/routes/agent-settings.ts`, `apps/api/src/schemas/agent-settings.ts`, shared agent-settings constants/types, and the related unit tests.

The route already uses Valibot for request bodies, but it still relies on unchecked persisted JSON parsing, unsafe type assertions, duplicated OpenCode provider rules, unbounded user-controlled strings/arrays/maps, and weak `any`-heavy test mocks. This is exactly the kind of quiet quality drift that turns a simple settings endpoint into a future incident.

## Research Findings

- Recent spot checks covered provider adapters, terminal token routing, MCP retry/stop-active-agent behavior, and data-model/security-isolation tracks. This agent-settings API slice was selected specifically to avoid those areas.
- `apps/api/src/routes/agent-settings.ts` parses JSON columns with raw `JSON.parse()` and casts `permissionMode` / `opencodeProvider` to shared types. If persisted data is corrupt or out of contract, GET can become a 500 and TypeScript will not help.
- `apps/api/src/schemas/agent-settings.ts` duplicates the OpenCode provider list and base URL rule even though `packages/shared/src/types/agent-settings.ts` already contains `OPENCODE_PROVIDERS`.
- `SaveAgentSettingsSchema` accepts unbounded strings, arrays, and maps for model, tool allow/deny lists, environment keys/values, provider names, and URLs.
- The tests in `apps/api/tests/unit/routes/agent-settings.test.ts` use `any` for route auth mocks, DB mocks, and environment context, and they do not cover corrupt persisted JSON or normalization boundaries.
- The workspace callback postmortem (`docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md`) reinforces that API route tests should verify behavior through real route wiring where possible and not rely only on source-shape confidence.

## Implementation Checklist

- [x] Replace duplicated provider validation literals with a schema derived from shared OpenCode provider metadata.
- [x] Add explicit bounded validation for model, tool names, environment keys/values, provider names, and base URLs.
- [x] Add safe response mapping for persisted JSON columns and persisted enum-like columns.
- [x] Remove avoidable route-level type assertions and non-null assertions.
- [x] Tighten the agent settings route tests around typed mocks and add coverage for invalid persisted data and input bounds.
- [x] Make agent-settings validation limits configurable through a Worker env override with documented defaults.
- [x] Run focused agent settings tests.
- [x] Run API typecheck/lint or the closest available repo checks.
- [x] Run full repository lint, typecheck, build, and test suite.

## Acceptance Criteria

- [x] Invalid request payloads return 400 with descriptive Valibot messages instead of persisting oversized or malformed values.
- [x] Corrupt stored JSON or invalid persisted enum-like values do not crash GET/PUT responses.
- [x] Provider validation uses the shared provider registry as the source of truth.
- [x] Route tests cover happy path, validation failures, stale/corrupt persisted values, and provider base URL rules.
- [x] The changed API files pass typecheck, lint, and focused tests.
- [x] New Worker env override is documented in the env example, self-hosting guide, and env-reference source.

## References

- `apps/api/src/routes/agent-settings.ts`
- `apps/api/src/schemas/agent-settings.ts`
- `apps/api/tests/unit/routes/agent-settings.test.ts`
- `packages/shared/src/types/agent-settings.ts`
- `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md`
- `tasks/archive/2026-03-31-adopt-valibot-api-validation.md`
