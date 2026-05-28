# Profile Setup Wizard for Project Chat

## Problem

Project chat currently falls back to raw agent, VM, workspace, devcontainer, and task-mode dropdowns when no agent profile is selected. This exposes low-level configuration before users understand profiles and keeps first-message behavior inconsistent with the desired profile-first onboarding model.

## Research Findings

- `apps/web/src/pages/project-chat/ChatInput.tsx` renders the current fallback controls and owns the edit profile dialog trigger.
- `apps/web/src/pages/project-chat/useProjectChatState.ts` loads agents, credentials, provider catalogs, profiles, and submits tasks. It already decides between `agentProfileId` and raw task configuration at submit time.
- `apps/web/src/pages/project-chat/index.tsx` wires chat state into `ChatInput`.
- `apps/web/src/lib/api/agents.ts` already exports `createAgentProfile`, `listAgentProfiles`, and `updateAgentProfile` for the existing `/api/projects/:projectId/agent-profiles` endpoint.
- `apps/web/src/components/vm/format-vm-size.ts` provides `selectProviderCatalog()` and `lookupSizeInfo()`; VM pricing/specs must flow through these helpers and `GET /api/providers/catalog`.
- `apps/web/src/components/agent-profiles/ProfileFormDialog.tsx` is the existing full profile edit surface and can be reused for editing existing profiles.
- `packages/shared/src/types/provider.ts` defines `ProviderCatalog` and `SizeInfo`; `packages/shared/src/constants/vm-sizes.ts` defines `VM_SIZE_LABELS` fallback text.
- Prototype reference exists on `origin/prototype/profile-wizard` at `apps/web/src/pages/profile-wizard-prototype/index.tsx`. It should inform layout only; production must use real API calls and no prototype route/artifacts.
- Relevant postmortems:
  - `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`: preserve correct identity boundaries when wiring chat UI state to backend task/session creation.
  - `docs/notes/2026-05-01-vm-size-minimum-selection-postmortem.md`: VM size is a compatibility/resource constraint, not just cosmetic labeling.
  - `docs/notes/2026-03-30-duplicate-settings-controls-postmortem.md`: replace/consolidate old controls instead of adding duplicate controls for the same task submission fields.

## Implementation Checklist

- [x] Add profile wizard state and actions in `useProjectChatState.ts`, including creating profiles with `createAgentProfile`.
- [x] Auto-create a default profile on first message for the single-agent/no-profile case using sole agent, `bypassPermissions`, medium VM, lightweight workspace, and conversation mode.
- [x] Gate multi-agent/no-profile submissions until a profile exists, with inline wizard validation and profile creation errors.
- [x] Replace raw fallback dropdowns in `ChatInput.tsx` with:
  - [x] subtle single-agent default banner plus Customize action,
  - [x] multi-agent inline 4-step wizard,
  - [x] pill-style profile selector bar with gear edit and `+ New`.
- [x] Use real provider catalog data through `selectProviderCatalog()` and `lookupSizeInfo()` for VM specs/pricing, hiding pricing when user lacks BYOC credentials.
- [x] Handle no agents, empty provider catalogs, profile name collisions, single-agent `+ New` wizard skipping agent selection, and existing profiles.
- [x] Pass any needed provider catalog, credential, and wizard state through `index.tsx`.
- [x] Add or update unit tests for single-agent auto profile creation, multi-agent gating/wizard profile creation, profile selector behavior, pricing visibility, and no-agent handling.
- [x] Add or update Playwright visual audit coverage at 375px and desktop for the new onboarding states.
- [x] Remove any production prototype artifacts if present.

## Acceptance Criteria

- Single configured agent with no profiles has an active input immediately; first submit creates a default profile and submits with `agentProfileId`.
- Multiple configured agents with no profiles cannot submit until the wizard creates a profile.
- Existing profiles show a pill selector, gear edit action, and `+ New` creation path.
- VM cards use real provider catalog specs/pricing when BYOC catalog data exists.
- Platform/admin-managed credentials or no BYOC key hide pricing entirely.
- Missing catalog data falls back to generic `VM_SIZE_LABELS` tier labels without specs/pricing.
- Mobile layout works at 375px with vertically stacked work-type cards and touch targets of at least 44px.
- Existing profile-backed sessions continue submitting with `agentProfileId` and no raw dropdown fallback remains.

## References

- SAM idea ID: `01KSQE75WVZQM7R3VC6N87HX4Z`
- SAM task ID: `01KSQKZDMHFAVNC60NPBW9W7Q7`
- Prototype branch: `origin/prototype/profile-wizard`
