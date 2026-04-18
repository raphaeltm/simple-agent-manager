# Unify Agent Settings & Credentials (User + Project)

Raphaël wants agent credentials and agent configuration to live inside the
same per-agent card — not in separate tabs or separate sections. The split
between "Agent Keys" and "Agent Config" (at user level) and "Project Agent
Defaults" vs. "Agent Credentials" (at project level) forces the user to
mentally join two views to reason about a single agent. From the user's
perspective: "here's an agent I want to use — how do I connect it, and how
will it behave?" should be answered in one place.

## Problem

- User settings has two tabs that both iterate over every agent:
  - `/settings/agent-keys` — shows credential cards per agent
  - `/settings/agent-config` — shows model / permission mode / OpenCode
    provider cards per agent
- Project settings has two sibling sections on the same page:
  - "Project Agent Defaults" — model + permission mode overrides
  - "Agent Credentials" — credential overrides
- To configure one agent (e.g. OpenAI Codex) the user has to jump between
  two tabs at user level and scroll between two sections at project level.
  Authorization and behavior are mentally the same question: "how do I use
  this agent?"

## Goal

For every agent, present a **single card** that groups:
1. **Connection** — credential (API key / OAuth) status + form
2. **Configuration** — model, permission mode, OpenCode provider (when
   applicable) — at user level these are the user's global defaults, at
   project level they are optional overrides with inheritance hints

At user level, collapse the two tabs (Agent Keys + Agent Config) into a
single tab called **Agents**. At project level, collapse the two sections
into one **Agents** section.

## Research Findings

Codebase structure (verified):
- `apps/web/src/pages/Settings.tsx` — tabs defined in `BASE_TABS`; routes
  wired in `apps/web/src/App.tsx` under `/settings/*`.
- User-scoped pages:
  - `apps/web/src/pages/SettingsAgentKeys.tsx` → `AgentKeysSection`
  - `apps/web/src/pages/SettingsAgentConfig.tsx` → `AgentSettingsSection`
- User-scoped components:
  - `apps/web/src/components/AgentKeysSection.tsx` — fetches agents,
    credentials, OpenCode provider; renders one `AgentKeyCard` per agent.
  - `apps/web/src/components/AgentSettingsSection.tsx` — fetches agents
    and their settings; renders one `AgentSettingsCard` per agent. The
    `AgentSettingsCard` handles model, permission mode, OpenCode provider,
    base URL, and provider name.
- Project-scoped sections on `apps/web/src/pages/ProjectSettings.tsx`:
  - `ProjectAgentDefaultsSection` (around line 404) — per-agent model +
    permission mode overrides.
  - `ProjectAgentCredentialsSection` (around line 673) — per-agent
    credential overrides with fallthrough messaging.
- Reusable credential UI: `AgentKeyCard` accepts `scope: 'user' | 'project'`
  and is already shared by both user and project credential sections.

API contracts (unchanged by this task):
- User credentials: `GET/PUT/DELETE /api/credentials/agent/*`
- User settings: `GET/PUT/DELETE /api/agent-settings/:agentType`
- Project credentials: `GET/PUT/DELETE /api/projects/:id/credentials/*`
- Project agent defaults: `PATCH /api/projects/:id { agentDefaults }`

Types of interest (`packages/shared/src`):
- `AgentInfo`, `AgentCredentialInfo`, `SaveAgentCredentialRequest`,
  `AgentSettingsResponse`, `SaveAgentSettingsRequest`,
  `ProjectAgentDefaults`, `OpenCodeProvider`, `AgentPermissionMode`,
  `VALID_PERMISSION_MODES`, `AGENT_PERMISSION_MODE_LABELS`,
  `OPENCODE_PROVIDERS`.

Existing tests:
- `apps/web/tests/unit/components/agent-settings-section.test.tsx`
- `apps/web/tests/playwright/agent-settings-audit.spec.ts`

Relevant rules:
- `.claude/rules/17-ui-visual-testing.md` — Playwright audit required for
  any change in `apps/web/`.
- `.claude/rules/24-no-duplicate-ui-controls.md` — no two controls for the
  same API field on the same page. This unification eliminates the current
  cross-page duplication (same data surfaced in two tabs) and replaces
  each field with a single control per scope.
- `.claude/rules/06-technical-patterns.md` — verify UI inputs reach backend
  for every new field (we're not adding new fields, just reorganizing
  existing ones, but must preserve the existing end-to-end paths).
- `.claude/rules/08-architecture.md` — "No legacy / dead code" — the old
  `*Section` and `SettingsAgent*` pages + routes become dead after the
  switch; delete them.
- `.claude/rules/26-project-chat-first.md` — not applicable; this is a
  settings surface, not a chat-flow feature.

## Design (UX)

Pattern borrowed from standard "Integrations" settings pages (Vercel,
Linear, Supabase, Stripe dashboards): each integration is **one card**
holding connection + configuration. Details progressively disclosed.

### `AgentCard` (user scope)

Single outer card per agent, always expanded:

```
┌───────────────────────────────────────────────┐
│ Claude Code            [● Connected]          │
│ Agentic coding from Anthropic.                │
│                                               │
│ ── Connection ───────────────────────────── │
│ [AgentKeyCard's body, embedded]               │
│                                               │
│ ── Configuration ────────────────────────── │
│ Model       [claude-opus-4-6  ▼]             │
│ Permission  ◯ default  ◯ plan  …             │
│ [Save Settings]  [Reset to Defaults]          │
└───────────────────────────────────────────────┘
```

Credentials form and config form keep their own Save buttons (they target
different APIs) but share the visual frame. No new API calls, no new
fields — pure reorganization.

### `ProjectAgentCard` (project scope)

Same shape, but configuration fields fall back to user settings when
empty, and the credential form explicitly says "project override" with
"inheriting user credential" copy when no override exists.

### Mobile-first

Raphaël primarily uses the mobile PWA. Cards stack vertically at 375px.
No horizontal overflow. Labels stack above inputs; inputs are 44px tall
minimum. Permission mode uses stacked radio buttons (already the pattern).

## Implementation Checklist

### 1. User-scope unified card
- [ ] Create `apps/web/src/components/AgentCard.tsx` that renders one
      agent's credential form + configuration form in a single card.
      Embed the existing `AgentKeyCard` body (scope='user') and the
      model / permission / OpenCode controls from `AgentSettingsCard`.
- [ ] Create `apps/web/src/components/AgentsSection.tsx` that fetches
      the agent list, credentials, and settings once and passes them to
      `AgentCard`s. Handle save/delete for both credentials and settings.

### 2. User-scope page + routing
- [ ] Create `apps/web/src/pages/SettingsAgents.tsx` that renders
      `<AgentsSection />`.
- [ ] Update `apps/web/src/pages/Settings.tsx` `BASE_TABS` to replace
      `agent-keys` + `agent-config` with a single `agents` tab (label:
      "Agents", path: "agents").
- [ ] Update `apps/web/src/App.tsx` to route `/settings/agents` to
      `SettingsAgents`. Keep temporary redirect routes from `agent-keys`
      and `agent-config` to `agents` so any stale bookmarks still land
      somewhere useful.
- [ ] Delete `SettingsAgentKeys.tsx` and `SettingsAgentConfig.tsx` (their
      only job is trivial passthrough to the old sections).
- [ ] Delete `AgentKeysSection.tsx` and `AgentSettingsSection.tsx` since
      the new `AgentsSection` fully replaces them.

### 3. Project-scope unified card
- [ ] Create `apps/web/src/components/ProjectAgentCard.tsx` that renders
      one agent's project-scoped credential override form + project
      model/permission override with inheritance hints.
- [ ] Create `apps/web/src/components/ProjectAgentsSection.tsx` that
      fetches agents, project creds, user creds, and `project.agentDefaults`,
      and passes them to `ProjectAgentCard`s. Preserve existing save/delete
      semantics for both credentials and agent defaults.

### 4. Project settings page update
- [ ] Update `apps/web/src/pages/ProjectSettings.tsx` to replace both the
      "Project Agent Defaults" section and the "Agent Credentials" section
      with a single "Agents" section rendering `ProjectAgentsSection`.
- [ ] Delete `ProjectAgentDefaultsSection.tsx` and
      `ProjectAgentCredentialsSection.tsx` after replacement.

### 5. Tests
- [ ] Replace `agent-settings-section.test.tsx` with an equivalent test
      for `AgentsSection` covering: list renders, save credential, save
      settings, delete credential, reset settings.
- [ ] Add `apps/web/tests/unit/components/agent-card.test.tsx` covering:
      renders agent name and status; credential form save path wired
      correctly; configuration form save path wired correctly;
      OpenCode-specific provider field shown for opencode only.
- [ ] Add `apps/web/tests/unit/components/project-agents-section.test.tsx`
      covering: renders per-agent cards; inherits user credential
      messaging; save/clear project override preserves inheritance state.
- [ ] Replace / update Playwright audit in
      `apps/web/tests/playwright/agent-settings-audit.spec.ts` (or
      create `agents-audit.spec.ts`) to test the unified user + project
      settings pages at **375px** and **1280px**, with mock data covering:
      - All agents empty (no credentials, no settings)
      - All agents fully configured
      - Long text (long model ids, long provider names)
      - OpenCode with custom provider (base URL + provider name visible)
      - Assert no horizontal overflow at 375px

### 6. Documentation sync
- [ ] Grep for references to "Agent Keys", "Agent Config",
      "/settings/agent-keys", "/settings/agent-config", and
      "ProjectAgentDefaults"/"ProjectAgentCredentials" in `docs/`,
      `specs/`, `CLAUDE.md`, and update anything that describes the old
      two-section layout.

### 7. Quality gates
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all green
- [ ] Run Playwright visual audit (`pnpm --filter @simple-agent-manager/web
      test:playwright` or similar) and verify screenshots
- [ ] Staging deploy + Playwright login + screenshot verification

## Acceptance Criteria

- [ ] A user visiting user Settings sees one tab labeled **Agents** (no
      separate "Agent Keys" or "Agent Config" tab) with a single card per
      agent that contains both credential status/form and configuration
      fields.
- [ ] A user visiting a project's Settings sees a single "Agents" section
      where each agent card contains credential override + model/permission
      override with inheritance hints — no separate "Project Agent Defaults"
      and "Agent Credentials" sections.
- [ ] Saving credentials, saving settings, saving project overrides, and
      clearing project overrides all continue to work end-to-end against
      unchanged APIs (verified on staging with Playwright).
- [ ] Mobile (375px) layout has no horizontal overflow and all interactive
      elements remain ≥44px tall.
- [ ] OpenCode-specific fields (provider, base URL, provider name) still
      appear on the OpenCode card only.
- [ ] Old pages/components (`SettingsAgentKeys`, `SettingsAgentConfig`,
      `AgentKeysSection`, `AgentSettingsSection`,
      `ProjectAgentDefaultsSection`, `ProjectAgentCredentialsSection`)
      are deleted from the codebase.
- [ ] All unit, integration, and Playwright tests pass.

## Out of Scope

- Agent profile creation/editing UI (tracked separately elsewhere).
- Any backend / API changes. This is a frontend reorganization only.
- Collapsible/accordion behavior inside cards — v1 keeps cards always
  expanded for simplicity; revisit if the page feels too long.
