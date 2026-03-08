# Remove Dual Navbar on Mobile

## Problem

On mobile, most screens show two navbar/headers stacked at the top:
1. **AppShell header**: SAM title + hamburger menu (always renders on mobile)
2. **PageLayout header**: Page title + UserMenu + back button

The only screen that looks correct is ProjectChat, which doesn't use PageLayout at all. The Project non-chat routes already pass `hideHeader={isMobile}` but all other pages don't.

## Root Cause

`PageLayout` (packages/ui/src/primitives/PageLayout.tsx) renders its own `<header>` by default. On mobile, `AppShell` already provides a top header with the hamburger menu. Pages using PageLayout without `hideHeader={true}` get both headers stacked.

## Solution

Add `hidden md:block` to PageLayout's header element so it's automatically hidden on mobile via CSS. This is a single-line change that fixes all pages at once, including future pages.

## Affected Pages

- Dashboard.tsx
- Projects.tsx
- Settings.tsx
- Workspaces.tsx
- ProjectCreate.tsx
- Admin.tsx
- UiStandards.tsx
- Node.tsx
- Nodes.tsx
- CreateWorkspace.tsx
- Project.tsx (error case at line 61)

## Already Correct

- ProjectChat.tsx (no PageLayout)
- Project.tsx non-chat routes (already `hideHeader={isMobile}`)

## Checklist

- [ ] Add responsive hiding class to PageLayout header in packages/ui
- [ ] Remove now-redundant `hideHeader={isMobile}` from Project.tsx non-chat routes
- [ ] Remove redundant `compact={isMobile}` if it was only for the mobile header case
- [ ] Run typecheck, lint, test, build
- [ ] Verify no regressions on desktop

## Acceptance Criteria

- On mobile, only the AppShell header (SAM + hamburger) shows at the top
- On desktop, PageLayout header renders as before
- ProjectChat page behavior unchanged
