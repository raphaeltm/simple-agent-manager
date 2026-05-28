# Agent Context Management UI

## Problem

The project Agent Context page exposes Memory and Policies as read-only lists. The approved Agent Context prototype established the desired management interactions, and the production page now needs real-data edit and delete support without adding create flows.

## Research Findings

- `apps/web/src/pages/AgentContextPage/MemoryTab.tsx` renders compact knowledge entity cards with no expansion or mutation controls.
- `apps/web/src/pages/AgentContextPage/PoliciesTab.tsx` renders compact policy cards with no mutation controls.
- `apps/web/src/pages/AgentContextPage/index.tsx` owns data loading and already lists entities and policies with real API clients.
- `apps/web/src/lib/api/knowledge.ts` already provides `getKnowledgeEntity`, `updateKnowledgeEntity`, `deleteKnowledgeEntity`, `updateObservation`, and `deleteObservation`.
- `apps/web/src/lib/api/policies.ts` lists and gets policies, but needs `updatePolicy` and `deletePolicy`.
- `apps/api/src/routes/policies.ts` supports PATCH and DELETE for policies. PATCH accepts `title`, `content`, `category`, `active`, and `confidence`; DELETE soft-removes a policy.
- The referenced prototype directory was not present in this checkout, so implementation should follow the explicit interaction requirements and existing glass styling.
- Relevant rule: `.claude/rules/17-ui-visual-testing.md` requires Playwright visual audit for web UI changes.
- Relevant postmortem: `docs/notes/2026-04-03-react-185-infinite-loop-postmortem.md` cautions against effect dependency feedback loops in React components.

## Checklist

- [ ] Add `updatePolicy` and `deletePolicy` functions to `apps/web/src/lib/api/policies.ts`.
- [ ] Pass a refresh callback from `AgentContextPage` into Memory and Policies tabs.
- [ ] Update Memory tab to support click-to-expand entity cards and fetch observations via `getKnowledgeEntity`.
- [ ] Add hover/focus-revealed edit and delete controls for memory entities.
- [ ] Add inline edit forms for memory entity fields without adding create controls.
- [ ] Add inline edit and delete controls for observations without adding create controls.
- [ ] Add confirmation dialogs with backdrop blur for memory entity and observation deletes.
- [ ] Add hover/focus-revealed edit and delete controls for policies.
- [ ] Add inline edit forms for policy fields without adding create controls.
- [ ] Add confirmation dialogs with backdrop blur for policy deletes.
- [ ] Preserve existing Agent Context glass styling and mobile-safe layout.
- [ ] Remove prototype route/files if present in the checkout.
- [ ] Add or update tests for API client and UI behavior where practical.
- [ ] Run lint, typecheck, tests, build, and Playwright visual audit.

## Acceptance Criteria

- Memory entities expand on click and show observations loaded from the knowledge API.
- Users can edit and delete memory entities and observations; users cannot create them from this UI.
- Users can edit and delete policies; users cannot create them from this UI.
- Delete actions require confirmation in a backdrop-blurred dialog.
- Controls are discoverable on hover and keyboard focus and remain usable on mobile.
- The UI uses real API data and existing API clients.
- Prototype-only routes and files are not shipped.
- Validation and visual audit evidence are recorded before PR/merge.
