# Fix Agent Credential Delete By Kind

## Problem

The user-scope Agents UI passes a specific `credentialKind` when removing an agent credential, but `AgentsSection.handleDeleteCredential` calls the broad `deleteAgentCredential(agentType)` helper. That sends `DELETE /api/credentials/agent/:agentType`, which deletes every user-scoped credential for that agent.

This contradicts the UI confirmation copy and the backend API shape. If a user has both an API key and OAuth/subscription credential saved, removing the active credential kind can delete the other saved kind too.

## Research Findings

- Idea `01KRPWTEGEHVW3Q69YY15X6AP8` documents the mismatch and suggested fix.
- `apps/web/src/components/AgentKeyCard.tsx` calls `onDelete(agent.id, kind)` and only shows one active credential at a time.
- `apps/web/src/components/AgentsSection.tsx` receives `(agentType, credentialKind)` but calls `deleteAgentCredential(agentType)`.
- `apps/web/src/lib/api/agents.ts` already exports `deleteAgentCredentialByKind(agentType, credentialKind)`, mapped to `DELETE /api/credentials/agent/:agentType/:credentialKind`.
- `apps/api/src/routes/credentials.ts` already implements the by-kind delete route and auto-activates a remaining credential if the deleted one was active.
- `apps/web/tests/unit/components/agents-section.test.tsx` already covers delete behavior and should be updated to assert the by-kind helper with both `api-key` and `oauth-token` present.
- Relevant postmortems:
  - `docs/notes/2026-04-18-project-credentials-security-hardening-postmortem.md`: credential flows need behavioral coverage across real resolution branches, not source-contract tests.
  - `docs/notes/2026-04-25-migration-cascade-data-loss-postmortem.md`: accidental broad deletion/data loss should fail loudly and be covered by specific safety checks.

## Implementation Checklist

- [ ] Replace the user-scope Agents UI delete call with `deleteAgentCredentialByKind(agentType, credentialKind)`.
- [ ] Update local credential state after deletion so only the removed kind disappears.
- [ ] Preserve configured status when another credential kind remains.
- [ ] Update the focused unit test to cover an agent with both `api-key` and `oauth-token`, deleting one kind.
- [ ] Run focused tests for `AgentsSection`.
- [ ] Run required quality checks for the affected workspace.

## Acceptance Criteria

- Removing an API key from an agent with both credential kinds calls `deleteAgentCredentialByKind(agentType, 'api-key')`.
- Removing one credential kind does not call the broad all-credentials delete helper.
- The remaining saved credential kind stays in component state and the agent remains configured.
- Existing save/settings behavior in `AgentsSection` continues to pass.
