# Composable Credentials UX Integration

## Problem
The current Settings UI has two separate credential surfaces:
1. **Agents tab** (`AgentsSection`) — per-agent card with API key/OAuth forms (legacy `credentials` table)
2. **Credentials tab** (`SettingsCredentials`) — raw three-primitive CRUD (cc_* tables)

Users cannot see how credentials resolve across tiers (project → user → platform). The prototype on branch `prototype/composable-credentials-ux` demonstrates a better UX: a **Connections overview** (status-first view with resolution badges), a **guided Connect flow** (dropdown-driven, no free-text), and a **demoted Advanced view** for raw CRUD.

## Research Findings

### Existing Systems
- **Legacy path**: `saveAgentCredential()` / `saveProjectAgentCredential()` in `apps/api/src/routes/credentials.ts` and `apps/api/src/routes/projects/credentials.ts`. Has key validation. Source of truth for writes; cc_* is backfilled lazily.
- **CC resolver**: `resolveForConsumer()` in `apps/api/src/services/composable-credentials/resolve.ts` → builds snapshot → runs pure `resolveEnvironment()` from shared package. Returns `ResolvedEnvironment` with `source: ResolutionSource` (`project-attachment | user-attachment | platform | platform-proxy`).
- **Rule 28**: Inactive project-scoped attachment halts cascade (returns null, does NOT fall through).
- **Rule 41**: Snapshot builder tolerates bad rows per-row.

### Consumer Catalogs
- **Agents**: `AGENT_CATALOG` in `packages/shared/src/agents.ts` — claude-code, openai-codex, google-gemini, mistral-vibe, opencode, amp
- **Cloud providers**: `CREDENTIAL_PROVIDERS` in `packages/shared/src/types/user.ts` — hetzner, scaleway, gcp

### Settings UI Structure
- **User settings** (`Settings.tsx`): Tabs — cloud-provider, github, agents, credentials, notifications, usage, api-tokens
- **Project settings** (`ProjectSettings.tsx`): Sections — ProjectAgentsSection, ScalingSettings, DeploymentSettings, RepositoryAccessSettings, VmSizeCard

### Key Decision
The Connect flow writes through the **validated legacy path** (saveAgentCredential, saveProjectAgentCredential), NOT raw cc_* CRUD. This preserves key validation and avoids Rule 24 duplicate controls.

## Implementation Checklist

### Backend: Resolution Status Endpoint
- [ ] Add `GET /api/credentials/resolution-status?projectId=<optional>` route in `apps/api/src/routes/credentials.ts`
- [ ] For each agent in AGENT_CATALOG + each cloud provider in CREDENTIAL_PROVIDERS, call `resolveForConsumer()` and return: consumerId, consumerKind, source, masked credential label, halted flag
- [ ] Ensure lazy backfill runs before resolution (already in resolver path)
- [ ] Per Rule 41: tolerate bad rows, don't 500 on one malformed credential
- [ ] Add shared response type `ResolutionStatusResponse` to `packages/shared`

### Shared Components (apps/web)
- [ ] Create `ConnectionsOverview` component — fetches resolution-status, renders status rows with badges
- [ ] Create `ConnectFlow` component — guided dropdown flow (auth method → secret/oauth → target → scope), writes via legacy save callbacks
- [ ] Create `ResolutionBadge` component — maps source tier to badge with tone (self/platform/default/halted/none)
- [ ] Use `@simple-agent-manager/ui` components (Card, Alert) instead of prototype inline styles

### User Settings (`/settings`)
- [ ] Rename "Agents" tab to "Connections" in `Settings.tsx`
- [ ] Replace `AgentsSection` content with `ConnectionsOverview` (user scope) + "Connect" button opening `ConnectFlow`
- [ ] Relabel "Credentials" tab to "Advanced" with explanatory banner
- [ ] Cloud providers: read-only status rows in Connections + deep-link to Cloud Provider tab

### Project Settings (`/projects/:id/settings`)
- [ ] Replace `ProjectAgentsSection` with `ConnectionsOverview` (project scope, passes projectId)
- [ ] Add `ConnectFlow` with project-scoped defaults (writes via saveProjectAgentCredential)
- [ ] Show cascade resolution: "This project" vs "Your default" vs "SAM…"

### API Client
- [ ] Add `getResolutionStatus(projectId?: string)` function to `apps/web/src/lib/api/`

### Testing
- [ ] Vertical-slice test for `GET /api/credentials/resolution-status` — seed cc rows across all tiers, assert each source
- [ ] Behavioral test for ConnectFlow — render, pick method/target/scope, assert correct legacy save fn called
- [ ] Playwright visual audit (mobile 375 + desktop 1280) for both surfaces

### Cleanup
- [ ] Delete `apps/web/src/pages/credentials-prototype/` directory
- [ ] Remove `/prototype/credentials` route from `App.tsx`

## Acceptance Criteria
- [ ] User settings → Connections tab shows resolution status for all agents + cloud providers with correct badges
- [ ] User settings → Connect flow saves via legacy path with key validation
- [ ] User settings → Advanced tab shows raw cc_* CRUD with demotion banner
- [ ] Project settings → Connections overview shows project-scoped resolution with cascade badges
- [ ] Project settings → Connect flow defaults to "This project only"
- [ ] Rule 28 inactive project override shows "Turned off here" / halted badge
- [ ] Cloud providers show as read-only (BYOC, no SAM fallback) with deep-link
- [ ] No horizontal overflow on mobile (375px)
- [ ] Prototype files removed before merge

## References
- Prototype: branch `prototype/composable-credentials-ux`, files `apps/web/src/pages/credentials-prototype/`
- Resolver: `packages/shared/src/composable-credentials/resolver.ts`
- API resolver: `apps/api/src/services/composable-credentials/resolve.ts`
- Snapshot: `apps/api/src/services/composable-credentials/snapshot.ts`
- Rules: 24 (no duplicate controls), 28 (inactive halt), 41 (tolerate bad rows)
