# Project credentials UI follow-ups

**Created**: 2026-04-18
**Priority**: MEDIUM
**Source**: Post-merge UI/UX review on PR #753 (`sam/project-credential-overrides`)

## Problem

Two genuinely new findings from UI/UX review that were not addressed in PR #753. Other findings either reflect pre-Phase-5 code, are incorrect analysis, or overlap with existing backlog tasks:

- A11y concerns (44px touch targets, `window.confirm`, `aria-pressed`, focus-visible ring) → covered by `tasks/backlog/2026-04-18-agent-key-card-accessibility.md`
- Visual audit coverage → covered by `tasks/backlog/2026-04-18-project-credentials-playwright-audit.md`
- Failed-delete state clearing and save-toast-before-await → false positives: current code awaits API calls before state mutation, so rejections short-circuit correctly
- Delete confirmation copy → already fixed via `scope="project"` prop in `AgentKeyCard.tsx:81-85` (commit `2bfe276e`)

## Scope

### Finding 1: `opencodeProvider` not forwarded to `AgentKeyCard` in project scope

`apps/web/src/components/ProjectAgentCredentialsSection.tsx:119-125` renders `AgentKeyCard` without passing the `opencodeProvider` prop. In user scope (`AgentKeysSection.tsx`), the prop drives:
- Provider-specific key labels (e.g., "Anthropic API Key" vs "Scaleway Secret Key")
- Provider-specific help text
- Scaleway cloud fallback indicator

For project-scope overrides, the Scaleway fallback block is correctly suppressed (`AgentKeyCard.tsx:44-48` guards on `scope === 'user'`), but the OpenCode input *label* and *help text* are still wrong — the form shows a generic placeholder instead of the provider-matched label.

**Fix**: Pass `opencodeProvider` from project settings (resolved from `projectAgentDefaults?.opencodeProvider` with fallback to user setting) down to each `AgentKeyCard` in the project credentials section.

### Finding 2: `apps/web/src/pages/ProjectSettings.tsx` exceeds file size soft limit

`ProjectSettings.tsx` is 712 lines — past the 500-line candidate-for-split threshold in `.claude/rules/18-file-size-limits.md` (mandatory split at 800).

**Fix**: Extract top-level sections (general info, deployment, scaling, agent defaults, agent credentials, danger zone) into sibling components under `apps/web/src/components/project-settings/`. Keep `ProjectSettings.tsx` as a thin composition + data-loading orchestrator.

## Acceptance Criteria

- [ ] `opencodeProvider` forwarded to `AgentKeyCard` in `ProjectAgentCredentialsSection`
- [ ] OpenCode project override shows correct provider-matched key label and help text
- [ ] `ProjectSettings.tsx` under 500 lines after extraction
- [ ] Extracted child components import cleanly; no orphaned state/props
- [ ] Existing tests pass; new Playwright audit (once filed) covers both user and project scopes

## References

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/753
- Rule 18: `.claude/rules/18-file-size-limits.md`
- Rule 24: `.claude/rules/24-no-duplicate-ui-controls.md` (check no duplicate controls after extraction)
- Related backlog: `tasks/backlog/2026-04-18-agent-key-card-accessibility.md`
- Related backlog: `tasks/backlog/2026-04-18-project-credentials-playwright-audit.md`
