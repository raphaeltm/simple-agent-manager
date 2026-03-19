---
paths:
  - "apps/web/src/components/NavSidebar.tsx"
  - "apps/web/src/components/MobileNavDrawer.tsx"
  - "apps/web/src/components/AppShell.tsx"
---

# Desktop–Mobile Navigation Parity

## Rule

When modifying the desktop navigation (`NavSidebar.tsx`) or the mobile navigation (`MobileNavDrawer.tsx`), you MUST review whether the same change should apply to the other surface.

## Why This Rule Exists

The desktop sidebar was updated to project-centric navigation with Lucide icons, but the mobile drawer was left with text-only labels and no project context header. This created a degraded mobile experience that went unnoticed until a user reported it.

## Required Steps

When changing ANY of these files:
- `apps/web/src/components/NavSidebar.tsx` (desktop sidebar)
- `apps/web/src/components/MobileNavDrawer.tsx` (mobile drawer)
- `apps/web/src/components/AppShell.tsx` (layout orchestrator — builds nav items for both)

You MUST:

1. **Check parity**: Does the other navigation surface (desktop or mobile) need the same change?
2. **If yes**: Apply the equivalent change to both surfaces in the same PR.
3. **If no**: Document why the change is intentionally desktop-only or mobile-only (e.g., "Infrastructure collapsible section is desktop-only because mobile uses a simpler layout").

## What to Keep in Sync

| Feature | Desktop (`NavSidebar`) | Mobile (`MobileNavDrawer`) |
|---------|----------------------|---------------------------|
| Nav items (global) | Home, Projects, Settings + Admin (superadmin) | Same items with same icons |
| Nav items (project) | Chat, Tasks, Overview, Activity, Sessions, Settings | Same items with same icons |
| Icons | Lucide icons on every item | Same Lucide icons |
| Back to Projects | ArrowLeft icon + label | Same |
| Project name header | Shown when in project context (falls back to "Project" if name not passed) | Same (currently always "Project" — real name requires AppShell to fetch and pass it) |
| Infrastructure section | Collapsible, superadmin-only (Nodes, Workspaces) | Same |
| Active state styling | Highlighted with accent color | Highlighted with accent color + left border |

## Quick Check

Before committing nav changes:
- [ ] Both NavSidebar and MobileNavDrawer have the same nav items
- [ ] Both surfaces show the same icons for each item
- [ ] Both surfaces show/hide the same items based on context (project vs global, superadmin vs regular)
- [ ] Tests cover both desktop and mobile for the changed behavior
