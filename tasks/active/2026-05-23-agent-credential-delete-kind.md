# Fix Agent Credential Delete Kind State Coverage

## Problem

Deleting a user-scoped agent credential must remove only the requested credential kind. The backend has both a broad route, `DELETE /api/credentials/agent/:agentType`, and a precise route, `DELETE /api/credentials/agent/:agentType/:credentialKind`. The UI must use the precise route and keep local state aligned with backend behavior, including backend auto-activation when the deleted credential was active.

The current branch already contains the prior by-kind call from an archived task, but this task must verify the behavior more completely and add focused coverage for the active-credential state transition.

## Research Findings

- `apps/web/src/components/AgentsSection.tsx` currently imports and calls `deleteAgentCredentialByKind(agentType, credentialKind)`.
- `apps/web/src/lib/api/agents.ts` still exports the broad `deleteAgentCredential(agentType)` helper for the all-credentials delete route, so tests should guard against accidental use from `AgentsSection`.
- `apps/api/src/routes/credentials.ts` implements `DELETE /api/credentials/agent/:agentType/:credentialKind` and auto-activates another remaining user-scoped credential for the same agent when the deleted row was active.
- `apps/web/tests/unit/components/agents-section.test.tsx` has one behavioral test for deleting an active API key while an OAuth credential remains, but it does not cover deleting OAuth while an API key remains and the local state update is embedded in the component.
- Prior related task: `tasks/archive/2026-05-16-agent-credential-delete-by-kind.md`.
- Relevant postmortems:
  - `docs/notes/2026-04-18-project-credentials-security-hardening-postmortem.md`: credential logic needs behavioral tests for actual state branches rather than source-contract assertions.
  - `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md`: credential lifecycle cleanup must be tested across the dependent session/state lifecycle.

## Implementation Checklist

- [x] Keep `AgentsSection.handleDeleteCredential` on `deleteAgentCredentialByKind(agentType, credentialKind)`.
- [x] Extract or otherwise unit-test the local credential state transition for deleting one kind and auto-activating a fallback credential.
- [x] Add focused unit coverage for an agent with both `api-key` and `oauth-token`, deleting one kind and verifying the other remains.
- [x] Add behavioral component coverage for the rendered delete interaction and assert only the targeted credential is removed.
- [x] Run focused tests for `AgentsSection` and the new state helper.
- [ ] Run the required validation suite for affected web changes.

## Acceptance Criteria

- Removing only an OAuth token leaves the API key in local UI state.
- Removing only an API key leaves the OAuth token in local UI state.
- If the deleted credential was active, the remaining credential is marked active in local state when no other active credential remains.
- `AgentsSection` calls `deleteAgentCredentialByKind(agentType, credentialKind)` and does not call `deleteAgentCredential(agentType)`.
- A ready-to-merge PR is opened for human review, but not merged.
