# Admin Analytics Dashboard UX/UI Redesign

## Problem Statement

The admin analytics page (`/admin/analytics`) has comprehensive data but poor UX/UI:
- All charts are basic HTML/CSS bars with no interactivity (no tooltips, no hover states)
- Single-column layout wastes desktop space
- No KPI summary row for quick daily health checks
- No proper charting library (no line/area charts, no axes, no grid lines)
- Geo data shown as horizontal bars instead of a map
- DAU chart has no Y-axis labels or value indicators
- Funnel chart doesn't look like a funnel
- All charts use the same single accent color
- No data exploration capabilities (no sorting, no date range picker)

## Research Findings

### Current State
- 8 chart components in `apps/web/src/pages/admin-analytics/`
- No charting library — all custom HTML/CSS/SVG
- Data fetched via `useAdminAnalytics` hook (8 parallel API calls)
- Period selector only offers 24h/7d/30d
- Single-column `flex-col gap-4` layout
- RetentionCohorts uses hardcoded Tailwind green classes
- ForwardingStatus (config status) mixed in with analytics data

### Key Files
- `apps/web/src/pages/AdminAnalytics.tsx` (149 lines) — main page
- `apps/web/src/pages/admin-analytics/` — all chart components
- `apps/web/src/hooks/useAdminAnalytics.ts` — data fetching
- `apps/web/tests/playwright/admin-analytics-audit.spec.ts` — existing Playwright tests
- `apps/api/src/routes/admin-analytics.ts` — API endpoints (no changes needed)

### Recommended Libraries
- **Recharts** — React-native SVG charting, tree-shakeable, built-in Tooltip/Legend/ResponsiveContainer
- **react-simple-maps** — lightweight SVG world map for geo visualization

## Implementation Checklist

- [ ] Install `recharts` and `react-simple-maps` + types in `apps/web`
- [ ] Add KPI summary row at top (DAU today, MAU, signups 7d, tasks 7d, top funnel conversion rate)
- [ ] Replace DauChart with Recharts AreaChart (XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer)
- [ ] Replace FunnelChart with proper narrowing funnel visualization using Recharts
- [ ] Replace GeoDistribution with world map choropleth (react-simple-maps) + data table below
- [ ] Replace FeatureAdoptionChart with Recharts horizontal BarChart with proper tooltips
- [ ] Improve RetentionCohorts: use CSS variables for colors, add sticky first column
- [ ] Add sortable columns to EventsTable
- [ ] Implement 2-column grid layout on desktop (>= 1024px) for secondary charts
- [ ] Move ForwardingStatus out of main analytics flow (to bottom as a collapsible section)
- [ ] Improve PeriodSelector: add 90d option, show "Data range" label
- [ ] Add "Last updated" timestamp display
- [ ] Improve empty states with actionable guidance text
- [ ] Use design system color tokens instead of hardcoded colors
- [ ] Update Playwright tests to match new component structure
- [ ] Verify no horizontal overflow on mobile (375px) and desktop (1280px)

## Acceptance Criteria

- [ ] KPI summary cards visible above the fold with key metrics
- [ ] DAU chart renders as an area/line chart with axes, gridlines, and tooltips
- [ ] Funnel chart visually narrows to communicate drop-off
- [ ] Geo distribution includes a world map choropleth
- [ ] Desktop layout uses multi-column grid for optimal space usage
- [ ] All charts have hover tooltips showing exact values
- [ ] Events table columns are sortable
- [ ] No horizontal overflow on mobile (375px) or desktop (1280px)
- [ ] Playwright tests pass for all scenarios (normal, empty, many items, long text, error)
- [ ] Design system color tokens used throughout (no hardcoded color classes)
- [ ] Lint, typecheck, and build pass
