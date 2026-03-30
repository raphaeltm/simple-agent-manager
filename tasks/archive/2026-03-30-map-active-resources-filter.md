# Filter Account Map to Active Resources

## Problem

The account map shows ALL resources (nodes, workspaces, sessions, tasks) regardless of status. Users with hundreds of old/stopped/completed resources see an overwhelming, useless map. Additionally, when using filter chips to hide resource types, they are only dimmed (opacity 0.15) rather than fully removed, and the layout doesn't reorganize to fill gaps.

## Research Findings

### Backend (`apps/api/src/routes/account-map.ts`)
- Fetches ALL entities per type with only a max limit (200 default)
- No status filtering — stopped workspaces, completed tasks, stopped sessions all included
- KV cache with 30s TTL keyed by userId

### Frontend Filter (`apps/web/src/components/account-map/hooks/useMapFilters.ts`)
- Type filter chips toggle entity types but only dim non-matching nodes to opacity 0.15
- Search also uses opacity-based dimming
- Edges between visible nodes are kept; edges to dimmed nodes are dimmed
- No automatic reorganize when filters change

### Frontend Data (`apps/web/src/components/account-map/hooks/useAccountMapData.ts`)
- `reorganize()` increments `layoutKey` to trigger Dagre re-layout
- Layout is computed in `useMemo` dependent on `[rawData, isMobile, layoutKey]`
- No dependency on filter state

### Status Values
- **Node**: pending, creating, running, stopping, stopped, deleted, error
- **Workspace**: pending, creating, running, recovery, stopping, stopped, deleted, error
- **Session (chat)**: active, stopped, error
- **Task**: draft, ready, queued, delegated, in_progress, completed, failed, cancelled

### Active Resource Definitions
- **Nodes**: running, creating, pending (not stopped/deleted/error)
- **Workspaces**: running, creating, pending, recovery, stopping (not stopped/deleted/error)
- **Sessions**: active (not stopped/error)
- **Tasks**: queued, delegated, in_progress (not completed/failed/cancelled/draft/ready)
- **Projects**: always shown (they're parent containers)

## Implementation Checklist

### Backend (API)
- [ ] Add `activeOnly` query parameter to `GET /api/account-map` (default: `true`)
- [ ] When `activeOnly=true`, apply WHERE clause filters for active statuses on nodes, workspaces, tasks
- [ ] Filter sessions to active-only in the DO fan-out response processing
- [ ] Invalidate/use separate cache keys for active vs all (`account-map:{userId}:active` vs `account-map:{userId}:all`)
- [ ] Add `ACCOUNT_MAP_ACTIVE_ONLY_DEFAULT` env var (default: `true`)
- [ ] Update tests for new filtering behavior

### Frontend — API Client
- [ ] Update `getAccountMap()` to accept `{ activeOnly?: boolean }` param
- [ ] Pass query string `?activeOnly=false` when showing all

### Frontend — Filter Hook (`useMapFilters.ts`)
- [ ] Change type filter behavior: fully remove (not dim) nodes when type is toggled off
- [ ] Change search behavior: keep dimming for search (contextual visibility is useful)
- [ ] Remove filtered-out nodes from edges (already done for type filters, verify)
- [ ] Return `filtersChanged` signal or comparable mechanism

### Frontend — Data Hook (`useAccountMapData.ts`)
- [ ] Accept `activeOnly` state and pass to API call
- [ ] No changes to layout logic needed (layout runs on whatever nodes exist)

### Frontend — Auto-Reorganize
- [ ] In `AccountMap.tsx`, detect when `filteredNodes` length changes due to filter toggle
- [ ] Call `reorganize()` automatically when filter state changes remove/add nodes
- [ ] Debounce or batch to avoid layout thrashing on rapid filter toggles

### Frontend — Toolbar
- [ ] Add "Show All" toggle/button to toolbar (allows seeing inactive resources)
- [ ] When toggled, re-fetches with `activeOnly=false`
- [ ] Update toolbar props interface

### Tests
- [ ] Update API unit tests for `activeOnly` parameter
- [ ] Update frontend hook tests for remove-vs-dim behavior
- [ ] Update AccountMap page tests for show-all toggle

## Acceptance Criteria

- [ ] By default, the map only shows active/running resources (not hundreds of old chats and workspaces)
- [ ] A "Show All" toggle exists to see everything when needed
- [ ] Toggling filter chips fully removes those resources from the map (not just dims them)
- [ ] When resources are removed by filters, the layout automatically reorganizes to fill gaps
- [ ] Search still dims non-matching nodes (doesn't remove them) for context
- [ ] Edge filtering works correctly with the new remove behavior
- [ ] No regressions to existing map functionality (tooltips, animations, mobile)
