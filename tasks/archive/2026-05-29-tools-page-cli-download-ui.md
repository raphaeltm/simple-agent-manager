# Tools Page + CLI Download UI

## Problem

The CLI build + R2 upload pipeline is complete and API endpoints exist (`GET /api/cli/version`, `GET /api/cli/download?os=...&arch=...`), but there's no UI surface for users to discover or download the CLI. We need a `/tools` page in the main nav and a `/tools/cli` sub-page with download buttons.

## Research Findings

- **Nav structure**: `GLOBAL_NAV_ITEMS` in `apps/web/src/components/NavSidebar.tsx` defines the main nav. Items: Home, Chats, Projects, Map, Settings. Tools goes between Map and Settings.
- **API routes**: `apps/api/src/routes/cli.ts` uses `registerBinaryArtifactRoutes` mounted at `/api/cli`. Provides `/api/cli/version` (JSON metadata) and `/api/cli/download?os=<linux|darwin>&arch=<amd64|arm64>` (binary stream).
- **API client pattern**: `apps/web/src/lib/api/client.ts` exports `API_URL` and `request<T>()`. Download links should use `API_URL + '/api/cli/download?...'` as direct `<a href>` (browser download, not fetch).
- **Page pattern**: Pages use `PageLayout` + `Breadcrumb` from `@simple-agent-manager/ui`. Settings uses `Tabs` for sub-navigation with `Outlet`.
- **Routing**: `App.tsx` defines routes. Tools needs `/tools` shell with sub-routes, similar to Settings pattern.
- **Prototype**: Built at `apps/web/src/pages/tools-prototype/` — two pages (index + cli) with mock data. Convert to production pages.
- **Idea**: `01KSTB5G866BHQMVF9GG496DV9`

## Implementation Checklist

- [ ] Create `apps/web/src/lib/api/cli.ts` — API client functions for `getCliVersion()` returning `{ available, version, buildDate }`
- [ ] Create `apps/web/src/pages/Tools.tsx` — shell page with breadcrumb + card grid linking to sub-tools
- [ ] Create `apps/web/src/pages/ToolsCli.tsx` — CLI download page with OS detection, download buttons, curl one-liner, quick start
- [ ] Add routes in `App.tsx`: `/tools` index and `/tools/cli`
- [ ] Add `Tools` nav item in `NavSidebar.tsx` between Map and Settings using `Wrench` icon from lucide
- [ ] Remove prototype files (`apps/web/src/pages/tools-prototype/`) and prototype routes from `App.tsx`
- [ ] Add unit tests for the API client function
- [ ] Run Playwright visual audit at mobile (375px) and desktop (1280px) viewports
- [ ] Update `docs/cli.md` to mention the Tools page as a download surface

## Acceptance Criteria

- [ ] `/tools` page is accessible from the main nav (between Map and Settings)
- [ ] `/tools` page shows a card grid with SAM CLI (available) and future tools (coming soon)
- [ ] Clicking the SAM CLI card navigates to `/tools/cli`
- [ ] `/tools/cli` auto-detects the user's OS and shows the correct primary download button
- [ ] Download buttons link to the real `/api/cli/download` endpoint
- [ ] Version info is fetched from `/api/cli/version` and displayed
- [ ] curl one-liner uses the real API URL (not hardcoded)
- [ ] Quick start section shows auth + dispatch + chat + status commands
- [ ] No horizontal overflow on mobile (375px)
- [ ] Prototype files are removed before merge
