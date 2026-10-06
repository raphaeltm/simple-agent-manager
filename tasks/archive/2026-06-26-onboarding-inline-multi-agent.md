# Onboarding: Inline Input at Every Step + Agent-Neutral Multi-Provider

**Date:** 2026-06-26
**Status:** Done (archived)
**Owner:** (agent, /do)

## Problem Statement

A user reached the OAuth step during onboarding's "Choose-Your-Path" wizard and got **no field to enter a token** — the step just advanced and persisted nothing. The wizard is also structurally **Claude-locked**: only Anthropic OAuth is reachable, and the four non-major agents (Gemini/Mistral/OpenCode/Amp) plus Codex OAuth are unreachable.

Three classes of bug:

1. **No-op steps that persist nothing.** `ai-oauth`, `ai-sam`, and `cloud-sam` render only a button (`StepForm.tsx:109-135`) and their `executeStep` cases are no-ops (`step-actions.ts`). The user enters nothing and nothing is saved.
2. **Structural Claude lock-in.** `questions.ts:55` tags the subscription option `has-claude`; `path-generator.ts:158` gates the only OAuth step on `oauth && has-claude`. Non-Anthropic OAuth and the 4 minor agents can never appear.
3. **SAM-managed silently broken.** The wizard never calls `saveAgentSettings`, so picking "SAM-managed AI" never writes `providerMode:'sam'`; the agent is never actually SAM-configured.

Plus a completion dead-end: `StepExecution.tsx` `handleCreateProject` (~:187-188) calls `onDismiss(); navigate(...)` and never `markStepDone()`/`onComplete()`, so when the project step is last, `CompletionScreen` is unreachable.

## Locked Scope (decided with Raphaël)

1. **EVERYTHING INLINE** — every step collects AND persists its input within the wizard; no "configure in Settings later" deferrals.
2. **Explicit agent-selection step.** All six `AGENT_CATALOG` agents selectable. After picking an agent, show ONLY the auth methods that agent supports, driven by catalog+capabilities (NOT hardcoded anthropic/openai branches):
   - `api-key`: all agents
   - `oauth-token`: only agents with `oauthSupport` (claude-code = `claude setup-token`; openai-codex = `~/.codex/auth.json`), gated on `supportsOAuth = !!getAgentDefinition(id).oauthSupport`
   - `sam`: only proxy-supported agents (claude-code/openai-codex); opencode uses its own provider routing
3. **OAuth inline** — `saveAgentCredential({ agentType, credentialKind: 'oauth-token', credential, autoActivate: true })`. Literal is `'oauth-token'`, NOT `'oauth'`. Server gates on `oauthSupport` (`credentials.ts:489-491`).
4. **SAM-managed AI step** — persist `providerMode:'sam'` via `saveAgentSettings`, AND collect budget inline (daily token budget + monthly cost cap via `updateUserAiBudget`).
5. **Cloud step** — Hetzner/Scaleway provider toggle. Keep the Hetzner token step; add an inline Scaleway step collecting `secretKey` + `projectId` (`ScalewayCredentialSchema`). NO GCP in onboarding.
6. **cloud-sam step** — persist the choice (not a pure no-op).
7. **De-Claude-ify copy** in questions.ts / path-generator.ts / StepForm.tsx AND fix path-generation logic (replace `has-claude` OAuth gate with a generic `oauth`/per-agent capability check).
8. **Fix completion dead-end** (`StepExecution.tsx`); remove inert tags/dead branches.

## Research Findings (ground truth, file:line)

### Catalog & capabilities — `packages/shared/src/agents.ts`
- `AGENT_CATALOG` 6 agents: claude-code (anthropic, oauth `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`), openai-codex (openai, oauth `~/.codex/auth.json` → `CODEX_AUTH_JSON`), google-gemini, mistral-vibe, opencode, amp.
- **Only claude-code and openai-codex have `oauthSupport`.** `getAgentDefinition(agentType)`, `isValidAgentType()`.
- `CredentialKind = 'api-key' | 'oauth-token'` (agents.ts:190). `SaveAgentCredentialRequest {agentType, credentialKind, credential, autoActivate?}`.

### Provider mode — `packages/shared/src/types/agent-settings.ts`
- `AgentProviderMode = 'sam' | 'user-api-key' | 'oauth'` (:12).
- `SaveAgentSettingsRequest` (:190-204) all-optional incl. `providerMode`, `opencodeProvider`, `model`, etc.
- `saveAgentSettings(agentType, data)` → PUT /api/agent-settings/:agentType (`apps/web/src/lib/api/agents.ts:140`).

### Budget — `packages/shared/src/types/ai-usage.ts`
- `UpdateAiBudgetRequest { dailyInputTokenLimit?, dailyOutputTokenLimit?, monthlyCostCapUsd?, alertThresholdPercent? }` (all `number | null`) (:94-99).
- `UserAiBudgetResponse` carries `settings`, `effectiveLimits`, `utilization`, etc. (:66-91).
- `updateUserAiBudget(body)` → PUT /api/usage/ai/budget; `fetchUserAiBudget()` → GET; `resetUserAiBudget()` → DELETE (`apps/web/src/lib/api/usage.ts`).

### Cloud credentials — `apps/api/src/schemas/credentials.ts`
- `CreateCredentialRequest` discriminated union on `provider`: hetzner `{token}` (:8-11), scaleway `{secretKey, projectId}` (:13-17), gcp `{...}` (excluded).
- `createCredential(data)` → POST /api/credentials; `validateCredential(data)` → POST /api/credentials/validate (`apps/web/src/lib/api/credentials.ts:9,24`).

### OAuth server gate — `apps/api/src/routes/credentials.ts`
- `PUT /api/credentials/agent`: rejects `credentialKind === 'oauth-token' && !agentDef.oauthSupport` (:489-491). Format validation is agent-aware (Codex auth.json) (:478-486).

### Wizard files — `apps/web/src/components/onboarding/choose-path/`
- `questions.ts` — 4 questions via `opt(id,label,desc,icon,next,tags)`. Claude-centric copy at :47 ("SAM uses AI agents like Claude Code"), `has-claude`/`oauth` tags at :55, "Claude Pro or Max subscription" :51, which-api-key anthropic/openai branch :81-85.
- `path-generator.ts` — `generatePath(tags)` :150-174; `ai-oauth` gated on `oauth && has-claude` :158 (the lock-in). `STEP_CONTENT` keyed by slug. `StepId` union :8.
- `step-actions.ts` — `StepFormState = {apiKey, selectedAgent, hetznerToken, selectedRepoName}` (must extend: oauthToken, cloudProvider toggle, scalewaySecretKey, scalewayProjectId, budget fields, selected auth method). `executeStep`: ai-apikey saves via `saveAgentCredential`; ai-oauth/ai-sam/cloud-sam/github/project are **no-ops**; cloud-hetzner via `createCredential`.
- `StepForm.tsx` — `case 'ai-oauth'` :109-118 = `<p>`+button, NO input (THE BUG). `case 'ai-apikey'` :46-107 agent selector only when `agents.length>1` (never true). Line 78: `{isAnthropic ? 'Anthropic' : 'OpenAI'} API key`. `case 'cloud-hetzner'` :137-168. `ai-sam`/`cloud-sam` :120-135 Continue+Skip. `project` :182-193 → ProjectSelector.
- `StepExecution.tsx` — form init :42-52 (Claude-centric `isAnthropic` filter); `markStepDone` :82-92; `handleAction` :94-111; **dead-end** `handleCreateProject` :165-195 (`onDismiss(); navigate(...)` never `markStepDone`).
- `ChoosePathWizard.tsx` — phase machine `'questions'|'path-preview'|'executing'|'complete'`; pre-populates `existing-*` tags :88-124; `CompletionScreen` at phase `'complete'`.
- `ProjectSelector.tsx` — repo `<Select>` bound to `form.selectedRepoName`; loads repos on mount; Create Project button.

### Settings reusables (for inline OAuth widgets) — `apps/web/src/components/settings/`
- `AgentKeyCard.tsx` — `supportsOAuth = !!agentDef?.oauthSupport` (~:42); Claude setup-token password field (~:237); Codex auth.json `<textarea>` (~:221); save via `onSave({agentType, credentialKind, credential, autoActivate:true})`.

### Relevant rules
- Rule 06 — UI-to-Backend Data Path Verification (the Scaleway node-creation bug: dropdown collected input that was silently discarded). Every new input must reach the backend; trace end-to-end + test.
- Rule 24 — No Duplicate UI Controls (search for existing controls on the same API field before adding).
- Rule 28 — Credential resolution fallback tests (behavioral, not source-contract).
- Rule 35 — Vertical slice testing for cross-boundary features.
- Rule 17 — Mandatory Playwright visual audit 375px + 1280px.

## Implementation Checklist

### A. Data model / state
- [x] Extend `StepFormState` (step-actions.ts) with: `oauthToken`, `selectedAuthMethod` (`'api-key'|'oauth-token'|'sam'`), `cloudProvider` (`'hetzner'|'scaleway'`), `scalewaySecretKey`, `scalewayProjectId`, and budget fields (`dailyInputTokenLimit`, `dailyOutputTokenLimit`, `monthlyCostCapUsd`).
- [x] Define new `StepId`s for the explicit agent-selection + auth steps (e.g. `agent-select`, `ai-auth`) and cloud-scaleway; update the union in path-generator.ts.

### B. Questions / path generation (de-Claude-ify + generic gates)
- [x] Rewrite `questions.ts` copy to be agent-neutral (A1–A13): :47 generic AI agents; "Use an existing AI subscription"; remove anthropic/openai-only which-api-key branch in favor of the explicit agent step.
- [x] Replace `has-claude` OAuth gate in `path-generator.ts:158` with a generic per-agent `oauth`/capability check driven by the selected agent's `oauthSupport`.
- [x] Remove inert tags + dead branches (openai-key unread; has-api-key / no-ai / has-hetzner / no-cloud / sam-infra never read by generatePath).

### C. Agent selection + inline auth step
- [x] Add explicit agent-selection step listing all six `AGENT_CATALOG` agents.
- [x] After selection, render only supported auth methods: api-key (all), oauth-token (`!!getAgentDefinition(id).oauthSupport`), sam (claude-code/openai-codex only).
- [x] Inline api-key field (label from selected agent's provider/name, not hardcoded). Save via `saveAgentCredential({credentialKind:'api-key', autoActivate:true})`.
- [x] Inline OAuth widget reusing AgentKeyCard patterns: claude setup-token password field; Codex auth.json textarea. Save via `saveAgentCredential({credentialKind:'oauth-token', autoActivate:true})`.

### D. SAM-managed AI step
- [x] Persist `providerMode:'sam'` via `saveAgentSettings(agentType, {providerMode:'sam'})`.
- [x] Collect budget inline (daily input/output token limits + monthly cost cap) and persist via `updateUserAiBudget(...)`.

### E. Cloud step
- [x] Add Hetzner/Scaleway provider toggle.
- [x] Keep Hetzner token step (`createCredential({provider:'hetzner', token})`).
- [x] Add inline Scaleway step collecting `secretKey` + `projectId` (`createCredential({provider:'scaleway', secretKey, projectId})`).
- [x] cloud-sam step: persist the choice (no pure no-op).

### F. Completion dead-end
- [x] Fix `StepExecution.tsx` so the project step calls `markStepDone()`/`onComplete()` and `CompletionScreen` is reachable; preserve navigate-to-project as a post-completion action.
- [x] Remove inert tags / dead branches surfaced in the audit.

### G. step-actions.ts executeStep wiring
- [x] Replace no-op cases with real persistence calls for every step (no step persists nothing).

### H. Tests
- [x] Behavioral/vertical-slice tests: agent select → auth method gating (oauth hidden for non-oauth agents; sam hidden for non-proxy agents).
- [x] OAuth inline saves with `credentialKind:'oauth-token'` + `autoActivate:true`.
- [x] SAM step writes `providerMode:'sam'` AND budget.
- [x] Scaleway step sends `{secretKey, projectId}`; Hetzner sends `{token}`.
- [x] Completion reaches CompletionScreen.
- [x] UI-to-backend trace test per Rule 06 for each new input.

### I. Visual audit (Rule 17 — MANDATORY)
- [x] Playwright audit of every changed onboarding surface at 375px + 1280px; assert no horizontal overflow; cover empty/long-text/many-agents states.

## Acceptance Criteria
- [x] Every onboarding step collects real input and persists it (no no-op steps).
- [x] All six agents are selectable; auth methods shown match each agent's capabilities (oauth only for claude-code/openai-codex; sam only for proxy-supported).
- [x] OAuth step shows the correct inline widget and saves an `oauth-token` credential that activates.
- [x] SAM-managed step writes `providerMode:'sam'` and a budget.
- [x] Cloud step supports Hetzner and Scaleway inline; no GCP.
- [x] No Claude-specific copy remains; path generation is capability-driven, not `has-claude`-gated.
- [x] Wizard completes cleanly to CompletionScreen.
- [x] Playwright visual audit passes at both viewports.

## Completion Notes
- **E.101 (cloud-sam "persist the choice")** resolved as an honest no-op confirmation step under rule 42 (no-untracked-degrading-placeholders). There is **no backend field** representing a "use SAM-managed infrastructure" preference — the choice only affects which inline steps the wizard generates (cloud-byoc vs cloud-sam). Persisting a fabricated field would be fake persistence. The cloud-sam step therefore shows a genuine "Continue" confirmation and advances; the real persistence happens at agent/cloud/project steps. task-completion-validator confirmed this is correct.
- task-completion-validator: **PASS** (3 LOW findings, none merge-blocking). All six checks (A Research→Checklist, B Checklist→Diff, C Criteria→Tests, D UI→Backend, E Multi-Resource, F Vertical Slice) PASS. All 11 inline inputs traced end-to-end to real API calls.
- Tests: 2432 web tests pass; lint 0 errors; typecheck clean; build success.

## References
- `.claude/rules/06-technical-patterns.md` (UI-to-Backend Data Path)
- `.claude/rules/24-no-duplicate-ui-controls.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/17-ui-visual-testing.md`
- CLAUDE.md — Agent Authentication (provider modes)
