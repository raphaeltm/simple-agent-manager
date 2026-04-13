# OpenCode Provider Settings UI

## Problem
The OpenCode agent currently hardcodes Scaleway as its inference provider in the VM agent (`session_host.go`). Users need to choose between multiple providers: SAM Platform (Workers AI), Scaleway, Google Vertex, OpenAI Compatible, Anthropic, or Custom. This requires DB schema changes, API updates, shared types, UI changes, and VM agent plumbing.

## Research Findings

### Current Architecture
1. **DB schema** (`apps/api/src/db/schema.ts:658-685`): `agent_settings` table has `model`, `permissionMode`, `allowedTools`, `deniedTools`, `additionalEnv`. No provider fields.
2. **API routes** (`apps/api/src/routes/agent-settings.ts`): GET/PUT/DELETE for `:agentType`. PUT uses `SaveAgentSettingsSchema` from `apps/api/src/schemas/agent-settings.ts`.
3. **Shared types** (`packages/shared/src/types/agent-settings.ts`): `AgentSettingsResponse` and `SaveAgentSettingsRequest` — no provider fields.
4. **UI** (`apps/web/src/components/AgentSettingsSection.tsx`): `AgentSettingsCard` renders model input and permission mode radio. No provider dropdown.
5. **AgentKeyCard** (`apps/web/src/components/AgentKeyCard.tsx`): Credential form with hardcoded "Scaleway Secret Key" label for opencode.
6. **VM agent** (`packages/vm-agent/internal/acp/session_host.go:954-978`): Hardcodes Scaleway provider config in `OPENCODE_CONFIG_CONTENT` JSON.
7. **Data flow**: `AgentSessionOverrides` (`apps/api/src/services/node-agent.ts:276-279`) passes only `model` and `permissionMode` to VM agent. `agentSettingsPayload` in Go has only `Model` and `PermissionMode`.
8. **Latest migration**: `0040_devcontainer_config_name.sql`
9. **API client** (`apps/web/src/lib/api/agents.ts:91-103`): `getAgentSettings()` and `saveAgentSettings()` pass through to shared types.

### Key Decisions
- New columns are nullable (null = use default)
- Provider metadata (labels, placeholders, required fields) defined in shared package for reuse
- `AgentSessionOverrides` extended with `opencodeProvider`, `opencodeBaseUrl` to pass through to VM agent
- VM agent's `agentSettingsPayload` extended with `OpencodeProvider` and `OpencodeBaseUrl` fields
- VM agent builds provider-appropriate `OPENCODE_CONFIG_CONTENT` based on provider value

## Implementation Checklist

### 1. D1 Migration
- [ ] Create `apps/api/src/db/migrations/0041_opencode_provider_settings.sql` adding 3 nullable columns to `agent_settings`

### 2. Schema Update
- [ ] Add `opencodeProvider`, `opencodeBaseUrl`, `opencodeProviderName` columns to `agentSettings` table in `schema.ts`

### 3. Shared Types
- [ ] Add `OpenCodeProvider` type union to `packages/shared/src/types/agent-settings.ts`
- [ ] Add provider metadata constants (labels, placeholder models, required fields)
- [ ] Extend `AgentSettingsResponse` with opencode provider fields
- [ ] Extend `SaveAgentSettingsRequest` with opencode provider fields
- [ ] Export new types from index

### 4. API Validation
- [ ] Extend `SaveAgentSettingsSchema` in `apps/api/src/schemas/agent-settings.ts` with opencode fields
- [ ] Add validation: `opencodeBaseUrl` required when provider is `custom` or `openai-compatible`
- [ ] Add validation: `opencodeBaseUrl` must be a valid HTTPS URL

### 5. API Route Updates
- [ ] Extend `toResponse()` in `agent-settings.ts` to include new fields
- [ ] Extend GET default response to include new fields
- [ ] Extend PUT values to handle new fields

### 6. AgentSessionOverrides & Data Flow
- [ ] Extend `AgentSessionOverrides` in `node-agent.ts` with `opencodeProvider`, `opencodeBaseUrl`
- [ ] Pass new fields in `startAgentSessionOnNode()` body
- [ ] Extend `agentSettingsPayload` in VM agent `gateway.go` with `OpencodeProvider`, `OpencodeBaseUrl`
- [ ] Update `session_host.go` opencode config generation to use provider-aware logic

### 7. Task Runner Integration
- [ ] Ensure task runner in `agent-session-step.ts` passes opencode provider fields from settings through overrides

### 8. UI - AgentSettingsCard
- [ ] Add provider dropdown for opencode agent type
- [ ] Add conditional base URL field (shown for custom/openai-compatible)
- [ ] Dynamic model placeholder per provider
- [ ] Info text per provider
- [ ] Include new fields in save handler and hasChanges check

### 9. UI - AgentKeyCard
- [ ] Dynamic key label per provider (Scaleway Secret Key, Google Cloud API Key, etc.)
- [ ] Platform provider: show "Using SAM's platform AI — daily limit applies" instead of key form

### 10. Build & Test
- [ ] Build shared package
- [ ] Typecheck all packages
- [ ] Add unit tests for validation schema
- [ ] Add unit tests for provider dropdown rendering
- [ ] Add unit tests for conditional field visibility
- [ ] Lint and format

## Acceptance Criteria
- [ ] User can select an OpenCode provider from a dropdown in agent settings
- [ ] Base URL field appears only for Custom and OpenAI Compatible providers
- [ ] Model placeholder changes per provider
- [ ] Agent key card label changes per provider
- [ ] Platform provider shows "no key needed" message
- [ ] Settings persist via API round-trip (save → reload → values preserved)
- [ ] Provider config flows through to VM agent session start
- [ ] Validation rejects missing base URL for custom/openai-compatible
- [ ] Validation rejects non-HTTPS base URLs

## References
- `apps/api/src/routes/agent-settings.ts`
- `apps/api/src/db/schema.ts:658-685`
- `apps/api/src/schemas/agent-settings.ts`
- `packages/shared/src/types/agent-settings.ts`
- `apps/web/src/components/AgentSettingsSection.tsx`
- `apps/web/src/components/AgentKeyCard.tsx`
- `apps/api/src/services/node-agent.ts:276-318`
- `apps/api/src/durable-objects/task-runner/agent-session-step.ts`
- `packages/vm-agent/internal/acp/session_host.go:954-978`
- `packages/vm-agent/internal/acp/gateway.go:422-426`
