# AgentKeyCard accessibility + delete-scope improvements

## Problem

The shared `AgentKeyCard` component (used by both `AgentsSection` user-scope and `ProjectAgentsSection` project-scope) has pre-existing accessibility and UX issues surfaced during review of the unified agents PR. They predate the unification work and apply to both scopes.

## Findings (from `/do` Phase 5 review of unify-agent-settings-credentials)

### UI/UX specialist
- **H1**: Hidden-field toggle lacks `aria-pressed` and `aria-controls` tying it to the input it reveals.
- **H2**: The "Add override" / "Add key" expand button is not a disclosure widget — no `aria-expanded` or `aria-controls`, and the revealed form has no `role=region` / `aria-labelledby` back-reference.
- **H3**: Active credential description relies on color + emoji only; no visually hidden text announcing the state to screen readers.
- **M8**: Credential type select rebuilds on every render with inline `onChange`, which may re-announce to AT. Stabilize via `useCallback` / memoize options.

### Test engineer
- **C1** (correctness, likely pre-existing): The single-argument `deleteAgentCredential(agentType)` API deletes ALL credentials for the agent. There is also a kind-specific endpoint `deleteAgentCredentialByKind(agentType, credentialKind)`. Current UI always uses the broad delete even when only one kind is shown active. Decide whether to:
  - (a) Switch Remove button to the kind-specific delete (least surprise), or
  - (b) Document that Remove intentionally clears the entire agent (current behavior), and update the confirm dialog copy to say so.

## Research notes

- `AgentKeyCard` is shared between user scope (`AgentsSection`) and project scope (`ProjectAgentsSection` → `ProjectAgentCard`). Fixes here improve both scopes at once.
- The unified card PR (`tasks/archive/2026-04-18-unify-agent-settings-credentials.md`) verified these issues are pre-existing via `git show main:apps/web/src/components/AgentKeyCard.tsx`.
- Tests currently exercise the behavior via `button.text-danger` selector — a11y improvements should not break these selectors without updating the tests in the same change.

## Implementation checklist

- [ ] Add `aria-pressed` + `aria-controls` to the show/hide toggle and ensure labels update ("Show value" / "Hide value")
- [ ] Convert Add-credential affordance to a proper disclosure: `aria-expanded`, `aria-controls`, and `role="region"` + `aria-labelledby` on the revealed form
- [ ] Add visually-hidden text to active credential status (`sr-only` span with "Active credential")
- [ ] Memoize credential kind options / stabilize handlers to avoid unnecessary re-renders on the select
- [ ] Decide delete semantics (C1) and wire either kind-specific delete or updated confirm copy
- [ ] Update unit tests to assert the new ARIA attributes and the chosen delete behavior
- [ ] Playwright visual audit (mobile 375px + desktop 1280px) to confirm no regressions

## Acceptance criteria

- Keyboard + screen-reader users can understand the show/hide, expand/collapse, and active states of the card without sighted cues.
- Remove button's effect matches its label and confirm dialog.
- Tests cover both ARIA behavior and delete-scope.
