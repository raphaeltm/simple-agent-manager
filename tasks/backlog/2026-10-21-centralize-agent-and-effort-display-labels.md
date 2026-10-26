# Centralize agent and effort display labels

> **Reconciliation 2026-10-26:** still open. #2414 (`0620c1595`) moved the profile form's
> `EFFORT_LABELS` out of `ProfileFormDialog.tsx` into
> `apps/web/src/components/agent-profiles/profile-form-options.ts:25`, now also read by
> `profile-form-summaries.ts`. The other cited maps are unchanged: `ProfileSelector.tsx:17`,
> `ProfileList.tsx:50`, `trigger-form-support.ts:10`, `profile-picker/model.ts:15,21`,
> `SessionHeaderFormatters.ts:45` and `AdminPlatformCredentials.tsx:32`.

## Problem

The web app maps agent types and effort levels to display text in several independent places, and they already disagree:

- Agent type labels:
  - `apps/web/src/components/project-message-view/SessionHeaderFormatters.ts` (`formatAgentType`): "Claude Code", no OpenCode entry.
  - `apps/web/src/pages/AdminPlatformCredentials.tsx` (`AGENT_TYPE_LABELS`).
  - `apps/web/src/components/project-chat/profile-picker/model.ts` (`AGENT_LABELS`): short "Claude", "Codex", "OpenCode" for the new-chat picker.
- Effort labels:
  - `apps/web/src/components/agent-profiles/ProfileSelector.tsx`, `ProfileFormDialog.tsx`, `ProfileList.tsx`
  - `apps/web/src/components/triggers/trigger-form-support.ts`
  - the picker's `EFFORT_LABELS` ("max effort")

  These use different casing and wording ("auto" / "Auto", "xhigh" / "Extra high" / "extra-high effort").

## Context

Raised by the architecture review of the new-chat profile picker (branch `sam/new-chat-profile-picker`, 2026-10-21) as a medium finding. The picker needed prose forms ("Claude · Opus 5.5 · max effort") that no single existing map provided, so it added a third copy rather than reconcile the others.

## Acceptance criteria

- [ ] One source in `packages/shared` for agent display names (full and short) and effort labels (title and prose forms), covering every agent type in the catalog.
- [ ] Every web call site uses it; the local maps are removed.
- [ ] A test fails when a catalog agent type or effort level has no label.
