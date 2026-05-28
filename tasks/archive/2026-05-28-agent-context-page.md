# Agent Context Page — Production Implementation

## Problem Statement

The project currently has separate Knowledge, Activity, and (unlinked) Policies surfaces. The approved prototype at `apps/web/src/pages/agent-context-prototype/index.tsx` consolidates these into a single "Agent Context" page with four tabs: Overview, Memory, Policies, and Agent Actions. This task implements the production version using real API data.

## Research Findings

### Existing APIs & Clients
- **Knowledge**: `apps/web/src/lib/api/knowledge.ts` — `listKnowledgeEntities`, `getKnowledgeEntity`, etc. Types from `@simple-agent-manager/shared` (`ListKnowledgeEntitiesResponse`, `KnowledgeEntityDetail`, etc.)
- **Policies**: `apps/api/src/routes/policies.ts` exists, but NO web API client. Types in `@simple-agent-manager/shared` (`ProjectPolicy`, `ListPoliciesResponse`, `PolicyCategory`, etc.)
- **Activity**: `apps/web/src/lib/api/sessions.ts` — `listActivityEvents`, `ActivityEventResponse`, `ActivityEventsListResponse`
- **Prototype**: `apps/web/src/pages/agent-context-prototype/index.tsx` — approved visual reference with glass aesthetic

### Navigation
- `NavSidebar.tsx` — `PROJECT_NAV_ITEMS` array controls project sub-nav. Currently has `{ label: 'Knowledge', path: 'knowledge', icon: <Brain size={18} /> }`
- `App.tsx` — Route at `/projects/:id/knowledge` renders `KnowledgePage`

### Glass Styling Constants (from prototype)
```
GLASS_CARD = 'rounded-lg border border-[rgba(34,197,94,0.10)] bg-[rgba(8,15,12,0.5)]'
GLASS_BADGE = 'inline-flex min-h-[22px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight'
```

### Key Decisions
- Hide Missions tab (user request)
- Keep `KnowledgePage.tsx` — add redirect from `/knowledge` to `/agent-context`
- Remove prototype route and files before merge
- Local subagent reviews only (no dispatched tasks)

## Implementation Checklist

### Phase A: API Client & Data Layer
- [ ] A1. Create `apps/web/src/lib/api/policies.ts` with `listPolicies()` function
- [ ] A2. Export policies API client from `apps/web/src/lib/api/index.ts`

### Phase B: Agent Context Page Components
- [ ] B1. Create `apps/web/src/pages/AgentContextPage/index.tsx` — main tabbed page component with Overview, Memory, Policies, Agent Actions tabs
- [ ] B2. Create `apps/web/src/pages/AgentContextPage/OverviewTab.tsx` — summary metrics from real data
- [ ] B3. Create `apps/web/src/pages/AgentContextPage/MemoryTab.tsx` — knowledge entities with search/filter (uses listKnowledgeEntities)
- [ ] B4. Create `apps/web/src/pages/AgentContextPage/PoliciesTab.tsx` — policies list with category badges (uses listPolicies)
- [ ] B5. Create `apps/web/src/pages/AgentContextPage/ActionsTab.tsx` — activity events list (uses listActivityEvents)

### Phase C: Navigation & Routing
- [ ] C1. Update `NavSidebar.tsx` — change Knowledge to Agent Context (label + path)
- [ ] C2. Update `App.tsx` — add `/projects/:id/agent-context` route, add redirect from `/projects/:id/knowledge` to `agent-context`
- [ ] C3. Import and register `AgentContextPage` in App.tsx

### Phase D: Cleanup
- [ ] D1. Remove prototype route from `App.tsx` (`/prototype/agent-context`)
- [ ] D2. Delete prototype files: `apps/web/src/pages/agent-context-prototype/`

### Phase E: Visual Testing
- [ ] E1. Run Playwright visual audit at mobile (375x667) and desktop (1280x800)
- [ ] E2. Fix any overflow or layout issues

## Acceptance Criteria
- [ ] "Agent Context" appears in project sidebar nav instead of "Knowledge"
- [ ] `/projects/:id/agent-context` loads the Agent Context page with 4 tabs
- [ ] `/projects/:id/knowledge` redirects to `/projects/:id/agent-context`
- [ ] Memory tab displays real knowledge entities from API
- [ ] Policies tab displays real policies from API
- [ ] Agent Actions tab displays real activity events from API
- [ ] Overview tab shows summary metrics from real data
- [ ] No Missions tab visible
- [ ] Page works on mobile (375px) and desktop (1280px)
- [ ] Prototype route and files removed
- [ ] Existing KnowledgePage.tsx preserved (just unused by direct nav)
