# Complete the Global Command Palette

**Task ID:** 01KTRY7T83CVCM2BG8CKS7RH5P
**Idea ID:** 01KTRY6M259MRZEJB7B9EGMWXB
**Output branch:** sam/complete-global-command-palette-01ktry

## Problem Statement

The Global Command Palette (Cmd+K) only exposes ~40% of the app's navigable
surfaces. Users cannot reach Map, Tools, most project sub-pages, Settings
sub-tabs, or Admin sub-tabs from the palette, and there are no global quick
actions (Sign Out, Toggle Theme, Create Node) or project-scoped create actions
(Create Trigger/Profile/Skill). This task makes the palette a complete
navigation surface — purely additive, no refactoring.

## Scope (exactly 2 files, additive only)

1. `apps/web/src/components/GlobalCommandPalette.tsx`
   - 2 top-level nav items, 6 Settings deep-links, 11 Admin deep-links, 3 global quick actions
2. `apps/web/src/hooks/useCommandPaletteContext.tsx`
   - 6 project context "Go to" actions, 3 project create quick actions

## Research Findings

- **Routes (all verified in `App.tsx`):** `/account-map`, `/tools`,
  `/settings/{cloud-provider,github,agents,notifications,usage,api-tokens}`,
  `/admin/{users,credentials,ai-proxy,costs,usage,quotas,errors,overview,logs,stream,analytics}`,
  and project sub-routes `/projects/:id/{library,agent-context,notifications,triggers,profiles,skills}`.
- **Icons (matched to `NavSidebar.tsx`):** Map=`Map`, Tools=`Wrench`,
  Library=`FolderOpen`, Agent Context=`Brain`, Notifications=`Bell`,
  Triggers=`Clock`, Profiles=`UserCog`, Skills=`Zap`, Admin=`Shield`.
- **Settings/Admin tabs are text-only** (`Settings.tsx`, `Admin.tsx` — no icons),
  so palette deep-links pick consistent lucide icons.
- **Sign out:** `signOut` from `../lib/auth` (`auth.ts:32`).
- **Theme toggle:** `useTheme()` from `../contexts/ThemeContext` returns
  `{ theme, resolvedTheme, isDark, setTheme }`. Toggle = `setTheme(isDark ? 'light' : 'dark')`.
- **Create entry points are URL-driven via `?edit=new`:** ProjectTriggers
  (`ProjectTriggers.tsx:45`), ProfileList (`ProfileList.tsx:63`), SkillList
  (`SkillList.tsx:36`). So Create Trigger/Profile/Skill →
  `/projects/:id/{triggers,profiles,skills}?edit=new`.
- **Create Node:** `Nodes.tsx` uses local `showCreateForm` state (not URL-driven),
  so the action just navigates to `/nodes`.
- **Context slice cap:** `useCommandPaletteContext.tsx:175` slices results to
  `MAX_CONTEXT_RESULTS` (default 10). Adding 6 nav + 3 create actions to the
  existing 4 nav + up-to-4 session/task actions exceeds 10 — bump
  `DEFAULT_MAX_CONTEXT_RESULTS` so no items are dropped (keep env-overridable).
- **Admin gating:** existing `nav-admin` item is gated behind `isSuperadmin`
  from `useAuth()` — gate the 11 admin deep-links the same way.
- **Searchability is automatic:** results are built from a `label` field run
  through `fuzzyMatch`, so every new item is searchable by label with no extra
  wiring.

## Implementation Checklist

### GlobalCommandPalette.tsx
- [x] Add icon imports: `Map`, `Wrench`, plus quick-action/deep-link icons
- [x] Import `signOut` from `../lib/auth` and `useTheme` from `../contexts/ThemeContext`
- [x] Call `useTheme()` in component body
- [x] Add `Map` and `Tools` to the base `navigationItems` array
- [x] Add 6 `Settings: X` deep-links to `navigationItems` (always available)
- [x] Add 11 `Admin: X` deep-links to `navigationItems` inside the `isSuperadmin` block
- [x] Add `Create Node`, `Sign Out`, `Toggle Theme` to `actionItems` with correct deps
- [x] Update `actionItems` useMemo dependency array (navigate, isDark, setTheme)

### useCommandPaletteContext.tsx
- [x] Add icon imports: `FolderOpen`, `Brain`, `Bell`, `Clock`, `UserCog`, `Zap`, `Plus`
- [x] Add 6 project context actions (Library, Agent Context, Notifications, Triggers, Profiles, Skills)
- [x] Add 3 create quick actions (Create Trigger/Profile/Skill) → `?edit=new`
- [x] Bump `DEFAULT_MAX_CONTEXT_RESULTS` so new items aren't sliced out

### Verification
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green
- [x] Local Playwright visual audit (mobile 375x667 + desktop 1280x800)
- [x] task-completion-validator passes

## Acceptance Criteria

- Palette exposes Map and Tools at top level.
- Inside a project, the palette's Context group lists Go to Library / Agent
  Context / Notifications / Triggers / Profiles / Skills (plus existing Chat /
  Ideas / Activity / Settings), prefixed with the project name.
- Settings deep-links (`Settings: X`) appear for all users; Admin deep-links
  (`Admin: X`) appear only for superadmins.
- Global quick actions Sign Out, Toggle Theme, Create Node work.
- Project create actions (Create Trigger/Profile/Skill) open the create modal
  via `?edit=new`.
- All new items are fuzzy-searchable by label; no regression to existing palette
  behavior.

## References

- `.claude/rules/17-ui-visual-testing.md` (mandatory visual audit)
- `.claude/rules/13-staging-verification.md` (staging gate)
- `apps/web/src/components/NavSidebar.tsx` (icon source of truth)
