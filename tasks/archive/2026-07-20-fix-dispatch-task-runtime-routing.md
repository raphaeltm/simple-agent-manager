# Fix dispatch_task Runtime Routing

## Problem

MCP `dispatch_task` resolves agent profile configuration but ignores `profile.runtime`, then always starts the VM TaskRunner. A profile configured for Instant (`cf-container`) is silently downgraded to a full VM, consuming VM quota and delaying startup.

Approved scope is Phases 1+2 of SAM idea `01KXZNPR69JGK7S99KMPFCRZWJ`. Phase 3 centralization across other task-start entry points is out of scope. Staging deployment and staging verification are explicitly forbidden by human instruction; local tests, CI, and local specialist review are the merge gates.

## Research Findings

- `apps/api/src/routes/mcp/tool-definitions-task-tools.ts` does not expose `runtime`; `additionalProperties: false` prevents callers from overriding it.
- `apps/api/src/routes/mcp/dispatch-tool.ts` resolves skill/profile fields and always runs the VM credential/quota gate, creates a chat session/message, then calls `startTaskRunnerDO`.
- `resolveSkillProfile` already returns the resolved profile runtime.
- `apps/api/src/services/workspace-runtime.ts` provides the shared decision model. This task routes Instant only for `explicit-cf-container`; `zero-config` remains deferred.
- Disabled containers produce `sandbox-disabled` and must retain VM fallback behavior.
- `launchInstantSession` already creates the task-linked chat session and initial user message, so the dispatch path must not create either before calling it.
- `launchInstantSession` currently hardcodes conversation prompt/token semantics despite accepting a task-backed row.
- `apps/api/src/routes/mcp/index.ts` already demonstrates Miniflare-safe extraction of `executionCtx.waitUntil`.
- The existing atomic conditional task INSERT and status event close the dispatch-limit TOCTOU race and must remain common to both runtimes.
- Existing Instant tests mock container/node boundaries with realistic task/project/workspace state and are the model for taskMode passthrough coverage.
- Relevant retained incident lesson: `tasks/archive/2026-03-16-dispatch-task-security-findings.md` documents the original dispatch-limit TOCTOU defect and the atomic insert process fix.

## Root Cause and Process Fix

### What broke

The MCP schema and handler added profile parity field-by-field but omitted runtime as a routing concern. The handler treated workspace configuration as VM configuration and unconditionally entered the TaskRunner path.

### Root cause

Runtime selection existed at the web chat entry point but not at the server-side dispatch boundary. Tests verified individual profile fields and VM startup, but none used a `cf-container` profile and asserted that the VM boundary was not called.

### Why tests missed it

The dispatch suite lacked a discriminating vertical-slice regression test carrying a realistic cf-container profile through handler resolution to the execution boundary.

### Class of bug

Cross-entry-point routing drift: a shared configuration field is resolved but not consumed at a server-side execution boundary, producing a silent fallback.

### Process fix

Add a vertical-slice regression test for every runtime-selecting task entry point changed in this phase. It must assert both the chosen launch boundary and the forbidden boundary, plus the final task-context payload. Phase 3 remains tracked in the idea for the other task-start entry points.

## Implementation Checklist

- [x] Add optional `runtime: 'vm' | 'cf-container'` to the MCP tool schema and update its description.
- [x] Parse runtime with the shared runtime type guard.
- [x] Resolve runtime from explicit parameter then resolved profile via `resolveWorkspaceRuntime`.
- [x] Reject cf-container plus explicit VM-only fields with actionable `INVALID_PARAMS` errors.
- [x] Preserve `sandbox-disabled` VM fallback and do not route on `zero-config`.
- [x] Keep atomic conditional INSERT and queued status event common to both runtimes.
- [x] Extract Instant validation/launch helpers into a sibling module.
- [x] Skip VM credentials/quota and pre-created chat session/message on Instant dispatch.
- [x] Launch Instant work using `executionCtx.waitUntil`, awaiting inline when unavailable.
- [x] Return runtime and decision reason for both Instant and VM responses.
- [ ] Add `taskMode` passthrough to `launchInstantSession`, defaulting to conversation.
- [ ] Add the rule-42 watchdog comment referencing the approved idea and both Instant backlog tasks.
- [ ] Add the complete approved runtime, contradiction, credential, disabled-container, single-session/message, and taskMode test matrix.
- [ ] Update public parameter documentation and `CLAUDE.md` Recent Changes.

## Acceptance Criteria

- A cf-container profile dispatch never calls `startTaskRunnerDO` and initiates `launchInstantSession` with task mode and the correct task/profile/branch/override context.
- Explicit runtime overrides profile runtime in both directions.
- Explicit VM-only fields cannot be combined with an explicit or profile-resolved cf-container runtime.
- Disabled containers fall back to VM and surface `runtime: 'vm'` with `runtimeReason: 'sandbox-disabled'`.
- Zero-credential Instant dispatch succeeds; zero-credential VM dispatch retains its actionable failure.
- Instant dispatch creates exactly one chat session and one initial user message.
- Instant task mode mints task prompt/token context; omitted taskMode retains conversation semantics for chat-start.
- Dispatch limits and the atomic conditional insert apply equally to both runtimes.
- Local focused tests, full lint/typecheck/test/build, task completion validation, and all required specialist reviews pass.
- The PR explicitly states staging was skipped by direct human instruction and does not trigger or mutate staging.

## References

- SAM idea `01KXZNPR69JGK7S99KMPFCRZWJ`
- `apps/api/src/routes/mcp/dispatch-tool.ts`
- `apps/api/src/routes/mcp/tool-definitions-task-tools.ts`
- `apps/api/src/routes/mcp/index.ts`
- `apps/api/src/services/workspace-runtime.ts`
- `apps/api/src/services/instant-session.ts`
- `tasks/backlog/2026-07-19-instant-launch-stuck-queued-on-disconnect.md`
- `tasks/backlog/2026-07-19-instant-session-capacity-controls.md`
- `.claude/rules/18-file-size-limits.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/42-no-untracked-degrading-placeholders.md`
- `.claude/rules/43-long-running-mcp-tools.md`
