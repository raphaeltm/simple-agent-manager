# Incident triage trigger ship-or-track contract

## Problem

The private incident triage trigger must be investigation-only. Its first production morning on 2026-08-26 produced six resolved incidents that cited code that had not shipped: three on a never-PR'd branch and three on a PR parked behind a failed preflight check. Incident triage agents should classify incidents and dispatch separate `/do` implementation tasks for fixes; terminal incident resolutions should be backed by a shipped or tracked reference.

## Research findings

- SAM idea `01M0YGMAZTZ01Y0ESREF2AMVNC` defines the required contract: triage agents investigate and classify only, never implement code in-session, check merged or in-flight fixes before deeper investigation, and for each signature either resolve with a fix/tracking reference, reject with justification, link existing tracked work, or dispatch a `/do` implementation task and cite the task ID. This maps to checklist items for the default trigger prompt and resolution validation.
- `packages/shared/src/constants/ai-services.ts` exports `DEFAULT_PLATFORM_FEEDBACK_INCIDENT_TRIGGER_TEMPLATE`, currently a broad “Investigate and resolve” prompt. `apps/api/src/services/platform-feedback-incident-config.ts:getIncidentConfig` uses this value unless `PLATFORM_FEEDBACK_INCIDENT_TRIGGER_TEMPLATE` overrides it. This maps to the default-template checklist item.
- `apps/api/src/scheduled/incident-triggers.ts:ensureDefaultIncidentTrigger` inserts `config.triggerTemplate`, so auto-created incident triggers inherit the shared default as soon as that constant changes. A scheduled test should assert the rendered auto-created trigger prompt contains the triage-only behavioral requirements.
- `apps/api/src/routes/mcp/tool-definitions-incident-tools.ts` defines the `resolve_incident` MCP schema, currently accepting only `incidentId`, `claimToken`, `outcome`, and `note`. This maps to the structured-reference schema checklist item.
- `apps/api/src/routes/mcp/incident-tools.ts:handleResolveIncident` forwards only the note to `resolveIncident`; the route must parse explicit optional reference fields and surface validation failures as clear JSON-RPC invalid-params errors.
- `apps/api/src/services/platform-feedback-incidents.ts:resolveIncident` is the service boundary for terminal state changes. Enforcement must live here too so direct service callers and MCP callers share the same ship-or-track contract.
- `resolution_note` is sanitized with `sanitizeText`, which redacts URLs and ULIDs. Therefore structured fix references should be separate from prose note parsing and should be persisted in an explicit resolution-reference column if durable auditability is required.
- Migration rule 31 permits additive nullable columns. If a persistence column is added, use `ALTER TABLE ADD COLUMN` only; do not recreate `platform_feedback_triages`.
- Existing unit tests in `apps/api/tests/unit/services/platform-feedback-incidents.test.ts`, `apps/api/tests/unit/routes/mcp/incident-tools.test.ts`, and `apps/api/tests/unit/scheduled/incident-triggers.test.ts` already exercise the service, MCP route, and auto-trigger sweep. Extend those tests instead of adding isolated source-contract tests.
- Relevant process rules: `.claude/rules/09-task-tracking.md` for `/do` dispatch wording, `.claude/rules/02-quality-gates.md` for regression tests and post-mortem/process fix, `.claude/rules/31-migration-safety.md` for additive D1 changes, `.claude/rules/35-vertical-slice-testing.md` for route-to-service-to-D1 behavior, and `.claude/rules/62-tests-must-observe-the-real-trigger.md` for testing the real trigger/render path.

## Implementation checklist

- [x] Update `DEFAULT_PLATFORM_FEEDBACK_INCIDENT_TRIGGER_TEMPLATE` to the triage-only contract.
- [x] Verify `ensureDefaultIncidentTrigger` inherits the new prompt via `getIncidentConfig` without a parallel default.
- [x] Add explicit optional structured reference fields to `resolve_incident` (`fixPrUrl`, `dispatchedTaskId`, `linkedRecordId`).
- [x] Add service-level validation so `outcome: "resolved"` requires at least one structured reference and `outcome: "rejected"` requires a non-empty justification note but no fix reference.
- [x] Persist allowed structured resolution references without relying on `resolution_note` prose parsing.
- [x] Return clear MCP errors explaining which reference fields an agent must supply for a resolved fix/tracking claim.
- [x] Add behavioral tests for rejected no-reference resolutions, accepted task-reference resolutions, rejection justification behavior, and auto-trigger prompt contract.
- [x] Update project agent rules/docs affected by the new incident resolution contract.
- [ ] Run focused tests, then full validation, specialist review, staging, PR, CI, merge, production deploy monitoring.
- [ ] Update idea `01M0YGMAZTZ01Y0ESREF2AMVNC` with the final PR link after merge.

## Acceptance criteria

- [x] Fresh installs and auto-created private incident triggers instruct agents to investigate/classify/dispatch only and never implement in the triage session.
- [x] The default trigger prompt tells agents to check merged and in-flight fixes before investigating and to verify dispatched implementation tasks per rule 09.
- [x] `resolve_incident` exposes structured reference fields rather than requiring references in prose notes.
- [x] A resolved incident without a structured PR/task/idea reference is rejected before terminal mutation.
- [x] A resolved incident with a structured dispatched-task reference terminally resolves and persists the reference.
- [x] A rejected incident requires a justification note but does not require a fix reference.
- [x] Tests cover service, MCP route, and auto-trigger behavior through the real production paths.

## Post-mortem

### What broke

The production incident triage trigger allowed agents to treat investigation sessions as implementation sessions and allowed terminal “resolved” rows to cite unshipped work.

### Root cause

The code default prompt described a broad “investigate and resolve” responsibility, and `resolveIncident` accepted any resolved note without requiring a shipped or tracked reference.

### Timeline

The incident backlog tooling shipped before 2026-08-26 with a permissive resolution contract. On 2026-08-26, the first morning of trigger runs exposed the failure mode when six resolved incidents cited unshipped code.

### Why it was not caught

Tests proved claim/resolve CAS behavior and trigger dispatch mechanics, but did not encode the operational contract that triage agents must not implement fixes in-session and must resolve only with shipped/tracked references.

### Class of bug

Agent workflow contract drift: prose instructions and terminal-state APIs allowed an agent to mark work done without evidence that the fix had shipped or been durably tracked.

### Process fix

This PR will update project agent rules so private incident triage has an explicit ship-or-track terminal-resolution rule in addition to code-level MCP/service enforcement.

## References

- SAM idea `01M0YGMAZTZ01Y0ESREF2AMVNC`
- Production trigger `01M0Y4KTQAVKTG7VVWNWXD89Y8`
- `packages/shared/src/constants/ai-services.ts`
- `apps/api/src/scheduled/incident-triggers.ts`
- `apps/api/src/routes/mcp/tool-definitions-incident-tools.ts`
- `apps/api/src/routes/mcp/incident-tools.ts`
- `apps/api/src/services/platform-feedback-incidents.ts`
- `.claude/rules/09-task-tracking.md`
