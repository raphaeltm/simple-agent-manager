# Model ID Dropdowns for Agent Types

## Problem

The model field across SAM's UI is a free-text input. Users must know exact model ID strings to configure agents. We need model dropdowns that filter by agent type — selecting `claude-code` shows Claude models, `openai-codex` shows Codex models, `mistral-vibe` shows Mistral models. The dropdown should also allow custom/free-text entry for models not in the list.

## Research Findings

### Locations Needing Changes

1. **`apps/web/src/components/AgentSettingsSection.tsx`** (line 242) — free-text `<input>` for model per agent card. Already knows agent type from the card's `agent.id`.
2. **`apps/web/src/components/agent-profiles/ProfileFormDialog.tsx`** (line 196-204) — free-text `<Input>` for model. Agent type dropdown exists at line 181. Placeholder is hardcoded "e.g. claude-opus-4-6" instead of varying by agent type.
3. **`apps/web/src/components/triggers/TriggerForm.tsx`** — has `agentProfileId` in the shared type (`trigger.ts` line 50) but NO agent profile selector or model field in the UI. Need to add agent profile dropdown (which implicitly carries model).
4. **`apps/web/src/pages/ProjectSettings.tsx`** — has agent type button grid but NO model field. Could add a default model dropdown next to it.

### Shared Model Catalog

Create `packages/shared/src/model-catalog.ts` with model definitions grouped by agent type. Each model entry needs: `id`, `name`, `group` (for optgroup rendering), and optional `legacy` flag.

### Model IDs (Researched)

**Claude Code:**
- claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6, claude-sonnet-4-5-20250514, claude-sonnet-4-20250514, claude-haiku-4-5-20251001
- Legacy: claude-3-5-sonnet-20241022, claude-3-5-haiku-20241022, claude-3-opus-20240229

**OpenAI Codex:**
- gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2-codex, gpt-5.2, gpt-5.1-codex-max, gpt-5.1-codex-mini
- Legacy: o4-mini, o3, gpt-4.1, gpt-4.1-mini

**Mistral Vibe:**
- devstral-2512, devstral-small-2505, codestral-2508, codestral-latest
- General: mistral-large-2512, mistral-large-latest, mistral-medium-2508, mistral-small-2603, mistral-small-latest

### UI Pattern

Use a `<select>` with optgroups for categories + a custom "Other" option that reveals a text input. This gives discoverability while preserving flexibility. Alternatively, use a datalist pattern (`<input list="...">`) for combo-box behavior.

## Implementation Checklist

### Phase 1: Shared Model Catalog
- [ ] Create `packages/shared/src/model-catalog.ts` with `ModelDefinition` interface, `MODEL_CATALOG` registry keyed by `AgentType`, and `getModelsForAgent()` helper
- [ ] Export from `packages/shared/src/index.ts`
- [ ] Build shared package

### Phase 2: Reusable ModelSelect Component
- [ ] Create `apps/web/src/components/shared/ModelSelect.tsx` — a combo-box component that accepts `agentType` prop, renders grouped model options from catalog, and allows custom text entry
- [ ] Support "No override" / empty option for optional contexts

### Phase 3: Wire Up — Agent Settings (User Settings)
- [ ] Replace free-text `<input>` in `AgentSettingsSection.tsx` (line 242) with `ModelSelect` component, passing `agent.id` as agentType

### Phase 4: Wire Up — Profile Form Dialog
- [ ] Replace free-text `<Input>` in `ProfileFormDialog.tsx` (line 198) with `ModelSelect`, passing `agentType` state
- [ ] Ensure model resets or updates when agent type changes

### Phase 5: Wire Up — Trigger Form
- [ ] Add agent profile selector dropdown to TriggerForm advanced options (the type already supports `agentProfileId`)
- [ ] Wire up to `CreateTriggerRequest.agentProfileId` / `UpdateTriggerRequest.agentProfileId`
- [ ] Load profiles via `listAgentProfiles(projectId)`

### Phase 6: Wire Up — Project Settings
- [ ] Add a default model dropdown next to the existing agent type button grid in ProjectSettings
- [ ] Wire to project update API (`defaultModel` field — check if it exists, may need to add to schema)

### Phase 7: Tests
- [ ] Unit test for `getModelsForAgent()` — returns correct models per agent type
- [ ] Behavioral test for ModelSelect component — renders options, allows selection, allows custom input
- [ ] Behavioral test for ProfileFormDialog — model options change when agent type changes

## Acceptance Criteria

- [ ] Selecting an agent type in any model-bearing form shows a dropdown of known models for that agent
- [ ] Users can still enter custom model IDs not in the catalog
- [ ] Model catalog lives in `packages/shared` and is reusable
- [ ] Trigger form has agent profile selection
- [ ] No duplicate UI controls for the same field
- [ ] All existing model save/load paths continue to work
