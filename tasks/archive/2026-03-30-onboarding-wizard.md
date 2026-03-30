# Onboarding Wizard

## Problem

The current onboarding is a 3-step checklist on the dashboard (cloud provider → GitHub → workspace) with no explanation of what SAM does or how it works. It sends users to separate settings pages for each step, breaking flow. The ordering leads with infrastructure rather than the thing users care about (their AI tool). There's no education about workflows (task mode vs conversation mode, full vs lightweight workspaces).

## Research Findings

### Current State
- `OnboardingChecklist.tsx`: 3 steps, checks completion via `listCredentials()`, `listGitHubInstallations()`, `listWorkspaces()`. Dismissible via localStorage.
- `Dashboard.tsx`: Shows welcome message, active tasks, and projects. The onboarding checklist is currently NOT rendered (it was removed from the dashboard at some point).
- Settings pages are separate routes: `/settings/cloud-provider`, `/settings/github`, `/settings/agent-keys`
- API functions available: `listCredentials()`, `listGitHubInstallations()`, `listAgents()`, `listAgentCredentials()`, `saveAgentCredential()`, `createCredential()`, `getGitHubInstallUrl()`
- Agent catalog in `packages/shared/src/agents.ts` has `AGENT_CATALOG` with all agent definitions including `credentialHelpUrl`

### Key Files
- `apps/web/src/pages/Dashboard.tsx` — main dashboard
- `apps/web/src/components/OnboardingChecklist.tsx` — existing checklist (to be replaced)
- `apps/web/src/pages/SettingsAgentKeys.tsx` — agent key management
- `apps/web/src/pages/SettingsCloudProvider.tsx` — cloud provider management
- `apps/web/src/pages/SettingsGitHub.tsx` — GitHub app management
- `apps/web/src/components/AgentKeyCard.tsx` — individual agent key form
- `apps/web/src/lib/api.ts` — API client functions
- `packages/shared/src/agents.ts` — `AGENT_CATALOG`, `AgentDefinition`
- `packages/ui/src/components/` — Card, Button, Input, Alert, StatusBadge, EmptyState

### Design Decisions
1. **Inline wizard on dashboard** — replaces the old checklist. Multi-step, no page navigation required.
2. **Reordered steps**: AI agent → Cloud provider → GitHub → First project
3. **"How it works" education** — final step explains task vs conversation mode, full vs lightweight workspaces
4. **Reuse existing API calls** — same `saveAgentCredential()`, `createCredential()`, `getGitHubInstallUrl()` patterns
5. **Skip support** — each credential step can be skipped with "I'll do this later"
6. **Completion stored in localStorage** — same pattern as existing checklist
7. **Shows for new users only** — users with all credentials configured or who have dismissed don't see it

## Implementation Checklist

### Phase 1: Onboarding Wizard Component
- [ ] Create `apps/web/src/components/onboarding/OnboardingWizard.tsx` — main wizard with step navigation
- [ ] Create `apps/web/src/components/onboarding/StepAgentKey.tsx` — agent selection + API key input
- [ ] Create `apps/web/src/components/onboarding/StepCloudProvider.tsx` — provider selection + token input
- [ ] Create `apps/web/src/components/onboarding/StepGitHub.tsx` — GitHub App install step
- [ ] Create `apps/web/src/components/onboarding/StepHowItWorks.tsx` — educational "how SAM works" with task vs conversation, full vs lightweight
- [ ] Create `apps/web/src/components/onboarding/index.ts` — barrel export

### Phase 2: Dashboard Integration
- [ ] Replace `OnboardingChecklist` import in Dashboard with new `OnboardingWizard`
- [ ] Show wizard when user has not completed or dismissed onboarding
- [ ] Wizard checks: has agent credential + has cloud provider + has GitHub app
- [ ] After wizard completion or skip, show normal dashboard content
- [ ] Store completion/dismissal in localStorage (same pattern as before)

### Phase 3: Tests
- [ ] Unit tests for `OnboardingWizard` — step navigation, skip behavior, completion detection
- [ ] Unit tests for each step component — form submission, validation, API calls
- [ ] Behavioral test: simulate full wizard flow from agent key → cloud → GitHub → how it works

### Phase 4: Cleanup
- [ ] Remove old `OnboardingChecklist.tsx` if fully replaced
- [ ] Update old `OnboardingChecklist.test.tsx` or replace with new tests

## Acceptance Criteria

- [ ] New users see a multi-step inline wizard on the dashboard
- [ ] Step 1: Select AI agent and enter API key (with links to get key)
- [ ] Step 2: Select cloud provider and enter token (with links to get token)
- [ ] Step 3: Install GitHub App (with install button)
- [ ] Step 4: "How it works" education (task vs conversation, full vs lightweight)
- [ ] Each credential step can be skipped
- [ ] Already-configured steps show as complete with green checkmarks
- [ ] Wizard disappears after completion or dismissal
- [ ] Existing dashboard functionality (tasks, projects) still works
- [ ] All interactive elements have behavioral tests
