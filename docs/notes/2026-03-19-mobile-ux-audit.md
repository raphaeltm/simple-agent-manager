# Mobile UX Audit Report

**Date:** 2026-03-19
**Device:** iPhone 14 Pro (375x812 @3x)
**Method:** Playwright with mocked API data across 12 task states and 3 project states
**Screenshots:** `.codex/tmp/playwright-screenshots/`

---

## Executive Summary

The mobile experience has functional bones but suffers from **information overload, poor visual hierarchy, and a navigation model that buries the primary action (chat)**. The guiding principle is that "as much as possible the focus should be on chat and voice" — the current UI does the opposite: it foregrounds task management scaffolding (Ideas, Kanban, Overview, Activity, Sessions) and tucks chat behind a hamburger menu.

### Top-Level Verdict

| Area | Grade | Summary |
|------|-------|---------|
| **Chat page** | B | Clean layout, good input area, but empty state wastes space |
| **Dashboard** | C+ | Functional but dense; task cards are too tall |
| **Ideas page** | C | Cards are bloated; action buttons crowd the footer |
| **Task Detail** | D+ | Breadcrumbs overflow badly; sidebar metadata wastes space on mobile |
| **Kanban** | D | Horizontally scrolling columns are unusable on mobile |
| **Navigation** | C | Too many items; chat should be the default, not buried in a list |
| **Empty states** | B- | Good copy, but visually sparse — missed opportunity |
| **New Idea dialog** | B+ | Clean modal, but could use the full mobile screen |

---

## 1. Chat Page (09-chat-viewport.png)

**The best page in the app.** Clean, focused, full-bleed layout. The input area at the bottom with microphone button and send is well-positioned.

### What works
- Full-bleed layout — no wasted padding
- "What do you want to build?" empty state is clear and inviting
- Input bar is anchored to bottom — correct mobile pattern
- Microphone button is present and accessible
- Two dropdowns (agent type + task mode) are compact

### Issues
- **Massive empty space** — the "What do you want to build?" prompt is vertically centered in a ~500px void. On mobile, this should be closer to the input area so the user's eye naturally moves from prompt to action
- **"Press Ctrl+Enter to send"** — this is a desktop keyboard shortcut shown on a touch device. Should say "Tap Send" or be hidden on mobile
- **Dropdown labels** — "Full" and "Task" are cryptic without context. First-time users won't understand what these control
- **No voice-first hint** — if voice is a primary interaction, the microphone button should be more prominent (larger, maybe animated on empty state)

### Recommendations
- Move empty state text to lower third of screen, near the input area
- Hide "Ctrl+Enter" hint on mobile; replace with touch-appropriate copy
- Make microphone button larger on empty state (48px+) with a subtle pulse
- Add brief label or tooltip for the two dropdowns on first use

---

## 2. Dashboard (01-dashboard-viewport.png)

### What works
- Clear hierarchy: Active Tasks section, then Projects section
- Task cards show useful info: status, title, project name, timing
- Execution step labels ("Starting AI agent...", "Finding a server...") are helpful
- Active/Idle indicators are a good touch

### Issues
- **Cards are too tall** — each active task card takes ~150px of vertical space. With 3 active tasks, the entire viewport is consumed before you see any projects. On a 812px screen with header, you see at most 3.5 task cards
- **Title truncation** — long titles like "Build comprehensive API rate limiting m..." get ellipsized, losing important context. The titles are the most important piece of information
- **Project cards are dense** — "SAM Platform  2 ws  5 sessions  raphaeltm/simple-agent-manager  5..." packs 4 pieces of metadata into one line that overflows
- **"Welcome, Demo User!"** — takes up 60px of vertical space for zero information value. This is precious real estate on mobile
- **No quick action** — tapping a task card navigates to chat, but there's no visual affordance suggesting it's tappable (no chevron, no "View" label)

### Recommendations
- Remove or collapse the welcome header on mobile
- Reduce task card height: put status badge + active indicator on one line with title below, compress time info
- Allow titles to wrap to 2 lines instead of truncating (the title IS the content)
- Add a subtle right-chevron to indicate tappability
- Consider making project cards more compact — just name + last activity time

---

## 3. Ideas Page (02-ideas-full.png, 03, 04)

### What works
- Status grouping (Exploring, Ready, Executing, Done, Parked) is logical
- Collapsible groups with Done/Parked collapsed by default is smart
- Search and status filter work well
- Status badges with color-coded icons are visually clear

### Issues
- **Cards are bloated** — each idea card takes ~170px of height. Title (2 lines) + description (2 lines) + footer with session count + 3 action buttons. On a 375px-wide screen, only 3 cards fit in the viewport
- **Action buttons are always visible on touch** — "Brainstorm", "Execute", and X are always shown (correct for touch), but they crowd the card footer. Three buttons + session count on a 340px-wide card is tight
- **"Brainstorm" button is unclear** — what does it do? The icon (chat bubble) helps, but "Brainstorm" as a verb is vague. Is it different from "Chat about this idea"?
- **"Execute" is scary** — a green "Execute" button next to every idea feels aggressive. Users may hesitate to click it because it sounds irreversible
- **Redundant status badges** — every card shows an "Exploring" badge, but they're already grouped under the "EXPLORING" header. This is visual noise
- **Search + filter take two full rows** — on mobile these stack vertically, consuming 120px before any content appears
- **"Ideas" as a concept** — this page is really a task backlog with friendlier naming. But it creates confusion: Is an "Idea" the same as a "Task"? The nav shows both "Ideas" and "Chat" — where do things actually happen?

### Recommendations
- Reduce card height: remove description preview (show on tap), combine session count with actions into one row
- Rename "Execute" to "Run" or "Start" — shorter and less intimidating
- Consider hiding the status badge on individual cards since the group header already shows it
- Combine search and filter onto one line (search left, filter dropdown right)
- Add swipe gestures on cards for quick actions instead of always-visible buttons
- Consider whether Ideas and Chat should be merged — if the focus is chat, maybe ideas appear as a section within the chat experience

---

## 4. Task Detail (06, 07 screenshots)

### What works
- Output section for completed tasks is well-structured (summary, branch, PR link)
- Error section for failed tasks has clear red border and readable error message
- Activity timeline with status transitions is useful
- TTS (text-to-speech) button for output summary is a nice touch

### Issues
- **Breadcrumbs overflow catastrophically** — "Home / Projects / SAM Platform / Tasks / Implement notification system with push support and batching" wraps to 5 lines and takes up 120px of precious mobile space
- **Sidebar renders below content on mobile** — the metadata sidebar (Priority, Created, Updated, Dependencies, Actions) is dumped below the main content as a full-width box. This means you have to scroll past the entire activity timeline to find the "Delete" button
- **"No description."** — shown in italic for tasks without descriptions. This just wastes space; omit the section entirely if empty
- **"Move to..." dropdown** — small and hard to tap accurately. The full-width select on the failed task is better
- **Title is a click-to-edit button** — no visual indicator that it's editable. Looks like plain text
- **Duplicate information** — the title appears in both the breadcrumb AND as the page heading. On mobile, this is 150px+ of just the same title repeated

### Recommendations
- Replace breadcrumbs with a simple back arrow + "Ideas" on mobile — breadcrumbs are a desktop pattern
- Move key actions (status transition, delete) to a sticky bottom bar on mobile
- Hide empty sections (description, output) entirely instead of showing "No description"
- Make the sidebar metadata collapsible or move it into a bottom sheet
- Remove the title from breadcrumbs (it's already the page heading)

---

## 5. Kanban Board (08-kanban-viewport.png)

### What works
- Column headers with count badges are clear
- Card layout is compact (title + status badge + priority)

### Issues
- **Fundamentally broken on mobile** — the kanban renders as a horizontally-scrolling grid with `minmax(200px, 1fr)` per column. On a 375px screen, you see exactly 1.5 columns. You must horizontal-scroll through 6+ columns to see all statuses
- **No scroll indicator** — there's no visual hint that more columns exist to the right
- **Cards clip at edges** — the "Ready" column's cards are cut off at the right edge with no affordance
- **Empty columns waste space** — "No tasks" placeholder boxes take up space in empty columns (Failed, Cancelled) that the user has to scroll through
- **Priority labels are tiny** — "P1", "P2" are barely readable at 12px

### Recommendations
- **Replace kanban with a vertical status list on mobile** — show statuses as collapsible sections (like the Ideas page already does). The kanban should be desktop-only
- Or: show a swimlane view — vertical scroll, one column at a time with horizontal swipe between statuses
- If keeping horizontal scroll, add snap-to-column behavior and dot indicators
- Hide empty columns on mobile

---

## 6. Navigation (10-mobile-nav-open.png, 11-project-nav-sidebar.png)

### What works
- Slide-out drawer is a standard mobile pattern
- User info at top with sign-out at bottom is correct
- Project-scoped nav switches to show project-specific links
- Icons are clear and well-chosen

### Issues
- **Too many navigation items** — the project nav shows: Chat, Ideas, Overview, Activity, Sessions, Settings. That's 6 items for what should be a 2-item app (Chat + Settings)
- **Chat is not the default or most prominent** — it's just another item in a list. Given the guiding principle of "focus on chat and voice," Chat should be the primary view, not one of six equal options
- **"Overview" and "Activity" are admin views** — most users don't need these. They clutter the navigation for the primary use case
- **"Sessions" is confusing** — it's separate from "Chat" but they're conceptually overlapping. Sessions are chat sessions. Why are they in two different places?
- **No bottom tab bar** — mobile apps universally use bottom tabs for primary navigation. The hamburger menu requires two taps to switch between Chat and Ideas
- **Global nav vs project nav** — switching between the two is confusing. Home, Projects, Settings, Admin, Infrastructure — that's a lot of top-level items

### Recommendations
- Add a bottom tab bar with 3 tabs: **Chat** (primary), **Ideas**, **Settings**
- Move Overview, Activity, Sessions into a "more" section or under Settings
- Make Chat the landing page when entering a project (already the case, but reinforce it)
- Reserve the hamburger menu for infrequently-used items (Admin, Infrastructure, Sign out)
- Consider removing the "Ideas" page entirely and integrating idea management into the chat experience (e.g., chat sidebar shows a list of ideas you can brainstorm about)

---

## 7. New Idea Dialog (05-new-idea-dialog.png)

### What works
- Clean, focused form with just title + description
- Good placeholder text ("What do you want to explore?")
- Cancel/Create buttons are clearly differentiated
- Description is marked as optional

### Issues
- **Not full-screen on mobile** — the dialog is a centered modal with the page visible behind it. On mobile, this should be a full-screen sheet sliding up from the bottom
- **Dialog partially covers important context** — you can see cards behind the dialog, but can't interact with them. It's visual noise
- **No voice input option** — given the voice-first principle, there should be a microphone button to dictate the idea

### Recommendations
- Convert to a full-screen bottom sheet on mobile
- Add microphone button for voice input
- Auto-focus the title field (already done, good)

---

## 8. Empty States (12-ideas-empty-search.png, 13-dashboard-empty.png)

### What works
- Good copy: "No active tasks — Submit a task from a project to get started"
- "Import your first project" empty state with clear CTA is good
- Lightbulb icon for no search results is appropriate

### Issues
- **Empty search state is too sparse** — just an icon + one line of text in a vast empty space. Could suggest alternative searches or show recently created ideas
- **Dashboard empty state has duplicate CTAs** — "Import Project" appears both in the section header AND as a button in the empty state card. Pick one
- **No onboarding** — new users see "No active tasks" and "Import your first project" but no explanation of what SAM does or how to get started

### Recommendations
- Add a brief onboarding card for first-time users explaining the workflow
- Reduce duplicate CTAs
- Add suggestions to empty search states

---

## 9. Overall Visual Design Issues

### Color and contrast
- **Monochrome green on dark** — the entire app is dark green/teal. While the dark theme is fine, there's very little color variation to create visual hierarchy. Everything blends together
- **Status badges are the only color pop** — green (active), blue (ready), red (failed). But the base green theme makes "active" badges hard to distinguish from the background
- **Text contrast is generally good** — primary text on dark background is readable

### Typography
- **Too many font sizes in close proximity** — card titles, descriptions, captions, badges, and timestamps all use different sizes within a 170px card. This creates visual noise
- **Section headings are large** — "Active Tasks", "Projects", "Ideas" take up more space than needed on mobile

### Spacing
- **Generous desktop spacing on mobile** — padding, gaps, and margins feel designed for desktop and only slightly reduced on mobile. The `px-4 py-3` mobile override from `px-6 py-4` isn't enough
- **Card gap of 12px** is fine but cards themselves are too tall

### Information density
- **Low information density** — paradoxically, despite showing lots of data per card, the overall information density is low because each card is so tall. You see 3-4 items per screen when you could see 6-8 with a more compact layout

---

## 10. Architectural Recommendations (Prioritized)

### P0 — Critical (Chat-first principle violations)

1. **Make Chat the hero experience** — when you open a project, the chat should dominate. Ideas/tasks should be a sidebar or secondary tab, not an equal peer
2. **Add bottom tab bar** — Chat, Ideas, Settings. Two taps to switch between views is too many
3. **Enlarge voice/microphone affordance** — if voice is a primary input, the mic button should be 48px+ and visually prominent

### P1 — High (Usability blockers)

4. **Kill the kanban on mobile** — replace with vertical status groups (like Ideas page already does)
5. **Fix breadcrumbs** — replace with back arrow + parent page name
6. **Compact all cards** — reduce height by 40-50% by hiding descriptions, compressing metadata, removing redundant badges
7. **Fix task detail sidebar** — move actions to sticky bottom bar; collapse metadata into expandable section

### P2 — Medium (Polish)

8. **Remove "Welcome" header** — zero information value on return visits
9. **Full-screen dialogs** — convert modals to bottom sheets on mobile
10. **Fix "Ctrl+Enter" hint** — show touch-appropriate copy on mobile
11. **Rename "Execute" to "Run"** — less intimidating, shorter
12. **Merge Sessions into Chat** — they're the same concept, shouldn't be separate nav items

### P3 — Low (Nice-to-have)

13. **Swipe gestures** on idea cards for quick actions
14. **Onboarding flow** for new users
15. **Voice input** in New Idea dialog
16. **Snap-to-column** if keeping kanban on mobile

---

## Appendix: Screenshot Index

| # | File | Description |
|---|------|-------------|
| 01 | `01-dashboard-viewport.png` | Dashboard with 3 active tasks + project cards |
| 01f | `01-dashboard-full.png` | Dashboard full scroll |
| 02 | `02-ideas-viewport.png` | Ideas page with 12 items across all statuses |
| 02f | `02-ideas-full.png` | Ideas page full scroll |
| 03 | `03-ideas-search-filtered.png` | Ideas filtered by search "auth" |
| 04 | `04-ideas-status-filter-executing.png` | Ideas filtered to "Executing" status |
| 05 | `05-new-idea-dialog.png` | New Idea creation dialog |
| 06 | `06-task-detail-completed-full.png` | Completed task with output summary + PR link |
| 07 | `07-task-detail-failed-full.png` | Failed task with error message |
| 08 | `08-kanban-viewport.png` | Kanban board (horizontal scroll) |
| 09 | `09-chat-viewport.png` | Chat page empty state |
| 10 | `10-mobile-nav-open.png` | Global nav drawer open |
| 11 | `11-project-nav-sidebar.png` | Project-scoped nav drawer |
| 12 | `12-ideas-empty-search.png` | Ideas empty search state |
| 13 | `13-dashboard-empty.png` | Dashboard with no tasks/projects |
