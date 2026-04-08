# OpenCode: Use Scaleway Cloud Credential for Inference

## Problem

OpenCode agent requires a Scaleway Secret Key (`SCW_SECRET_KEY`) for Scaleway Generative APIs inference. Currently, the agent-key resolution only looks for a dedicated `agent-api-key` credential with `agentType: 'opencode'`. Users who have already configured a Scaleway cloud provider credential (for VM provisioning) must redundantly paste the same key into the OpenCode agent key slot.

The same `SCW_SECRET_KEY` works for both VM provisioning and inference. The credential should be reused.

## Research Findings

### Credential Storage Model
- **Cloud provider credentials**: `credentialType: 'cloud-provider'`, `provider: 'scaleway'`. Serialized as `JSON.stringify({ secretKey, projectId })`.
- **Agent credentials**: `credentialType: 'agent-api-key'`, `agentType: 'opencode'`. Stores raw secret key string.

### Key Code Paths
- `getDecryptedAgentKey()` (credentials.ts:544): Queries `credentialType: 'agent-api-key'` + `agentType`.
- `getDecryptedCredential()` (credentials.ts:578): Queries `credentialType: 'cloud-provider'` + `provider`.
- Agent-key endpoint (runtime.ts:29-62): Calls `getDecryptedAgentKey()` only.
- Agents catalog (agents-catalog.ts:19-50): `configured` checks `credentialType: 'agent-api-key'` only.
- AgentKeyCard UI (AgentKeyCard.tsx): Shows separate credential form per agent.

### Scaleway Credential Format
- Cloud provider credential serialized as: `{"secretKey":"...","projectId":"..."}`
- OpenCode needs just the `secretKey` field as `SCW_SECRET_KEY`

## Implementation Checklist

### Backend Changes
- [ ] 1. Modify agent-key endpoint (runtime.ts) to fall back to Scaleway cloud credential when agentType is 'opencode' and no dedicated agent key exists
  - Extract `secretKey` from the JSON-serialized Scaleway cloud credential
  - Return `credentialKind: 'api-key'` for the fallback case
- [ ] 2. Modify agents catalog endpoint (agents-catalog.ts) to mark OpenCode as `configured` when a Scaleway cloud credential exists (even without a dedicated agent key)

### Frontend Changes
- [ ] 3. Update AgentKeyCard to show "Using Scaleway cloud credential" status when OpenCode has no dedicated agent key but a Scaleway cloud credential exists
  - Add a new API response field or use the existing `configured` + credential absence to infer this
- [ ] 4. Add a new field to the agents catalog API response (e.g., `fallbackCredentialSource: 'scaleway-cloud'`) so the UI can distinguish "configured via dedicated key" from "configured via cloud credential fallback"

### Testing
- [ ] 5. Add unit test for agent-key fallback logic (opencode with no agent key, with scaleway cloud credential)
- [ ] 6. Add unit test for agents catalog fallback (opencode marked configured via scaleway cloud credential)
- [ ] 7. Update existing agent test if needed

### Quality
- [ ] 8. Lint, typecheck, build pass
- [ ] 9. Staging deployment and end-to-end verification with real Scaleway inference

## Acceptance Criteria

1. Users with a Scaleway cloud credential can use OpenCode without configuring a separate agent key
2. The agent-key endpoint returns the Scaleway secret key when no dedicated OpenCode key exists
3. The Settings UI shows OpenCode as connected when a Scaleway cloud credential is present
4. Users can still save a dedicated OpenCode agent key that takes priority over the cloud credential
5. OpenCode actually works end-to-end on staging with Scaleway Generative APIs inference

## References
- PR #630: Initial OpenCode implementation
- Branch: sam/implement-opencode-agent-scaleway-01knp1
- apps/api/src/routes/workspaces/runtime.ts
- apps/api/src/routes/credentials.ts
- apps/api/src/routes/agents-catalog.ts
- apps/web/src/components/AgentKeyCard.tsx
- packages/shared/src/agents.ts
