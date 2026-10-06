# Add Runtime Type Checks Throughout Codebase

## Problem

The codebase still has several runtime trust boundaries where TypeScript type assertions are used after JSON parsing, HTTP response parsing, storage reads, WebSocket messages, or tool input handling. These assertions do not prove the runtime shape and can silently accept malformed data.

## Research Findings

- Existing API request validation uses Valibot through `apps/api/src/schemas/_validator.ts`.
- Shared cross-package schemas already use Valibot, for example `packages/shared/src/trial.ts`.
- Provider integrations already use explicit runtime response validation in `packages/providers/src/validation.ts` and `packages/providers/src/validation-core.ts`.
- Relevant postmortems show the same failure mode: silent acceptance at trust boundaries and source-contract tests are not enough. See:
  - `docs/notes/2026-04-18-project-credentials-security-hardening-postmortem.md`
  - `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md`
  - `docs/notes/2026-05-12-task-callback-middleware-leak-postmortem.md`

## Audit Inventory

Automated scan over `apps/api/src`, `apps/web/src`, `packages/*/src`, `scripts`, `infra`, and `experiments` found 175 assertion patterns:

- `response_json_cast`: 40
- `request_json_cast`: 8
- `generic_fetch_cast`: 12
- `json_parse_cast`: 28
- `record_cast_from_unknown`: 80
- `any_cast`: 7

Implementation will treat these as checklist items grouped by trust boundary. Internal display-only casts may be replaced with small type guards when a full schema would add noise, but all parsed JSON, request JSON, response JSON, storage JSON, WebSocket JSON, and tool input JSON must be runtime-checked before use.

## Implementation Checklist

- [x] Add reusable runtime JSON/object validation helpers for API-side code.
- [x] Add reusable runtime JSON/object validation helpers for web/client package code.
- [x] Replace API route request-body assertions with Valibot schemas or object validators.
- [x] Replace API upstream `response.json() as ...` assertions with runtime response validators.
- [x] Replace API storage `JSON.parse(...) as ...` assertions with runtime validators.
- [x] Replace Durable Object request and stream event assertions with runtime validators.
- [x] Replace MCP/tool parameter object casts with runtime validators.
- [x] Replace web API client response assertions with runtime validators.
- [x] Replace web WebSocket/localStorage/XHR JSON assertions with runtime validators.
- [x] Replace package-level JSON assertions in `packages/acp-client`, `packages/terminal`, and provider helpers with runtime validators.
- [x] Replace script/infra JSON assertions that consume external command output or event payloads with runtime validators.
- [x] Remove or justify remaining `as any` at runtime boundaries.
- [x] Add tests proving invalid runtime data is rejected or safely ignored.
- [x] Run lint, typecheck, tests, and build.

## Acceptance Criteria

- No unchecked JSON parse, request body, response body, storage JSON, WebSocket JSON, or tool input boundary remains in touched source code.
- Remaining type assertions are limited to framework interop or internal TypeScript narrowing that does not cross a runtime trust boundary.
- Invalid runtime payload tests cover representative API, Durable Object, web, and package paths.
- PR is pushed to `sam/look-through-codebase-find-01krne` with this checklist checked off item by item.
