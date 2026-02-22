# Feature Specification: UI/UX Overhaul

**Feature Branch**: `019-ui-overhaul`
**Created**: 2026-02-22
**Status**: Draft
**Input**: Competitive analysis and user journey audit (docs/notes/2026-02-22-user-journey-audit.md)

## Background

A comprehensive user journey audit and competitive analysis identified systemic UI/UX issues across the platform. The audit compared SAM against seven comparable products (GitHub Codespaces, Gitpod, Coder, Railway, Vercel, Render, Linear) and evaluated the platform against Nielsen's 10 usability heuristics.

Key findings:
- **No persistent navigation**: Users must return to the Dashboard to navigate between sections. Every comparable product uses persistent navigation (top bar, sidebar, or both).
- **Visual clutter on entity lists**: Workspace and node cards show 2-4 visible action buttons each. All seven competitors use overflow menus (three-dot icon) for secondary actions.
- **Monolithic detail pages**: The project detail page combines 5+ concerns (stats, edit form, runtime config, sessions, activity) in a single scrollable view. Competitors use tabbed sub-routes.
- **Missing UI primitives**: The design system lacks DropdownMenu, ButtonGroup, SplitButton, Tabs, Breadcrumb, Tooltip, and EmptyState components that are standard in comparable products.
- **Flat typography and inconsistent spacing**: Page titles and section headings differ by only 0.25rem. Inline styles coexist with design tokens. Hardcoded colors bypass the token system.
- **Architecture-UI misalignment**: The codebase follows a project-first architecture, but the dashboard leads with workspaces and standalone workspace creation.
- **No onboarding guidance**: New users land on an empty dashboard with no setup checklist or progress indicators, despite a 3-step prerequisite setup process.

This spec addresses these issues in a phased approach: foundational primitives first, then navigation and page structure, then refinements.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Navigate Between Sections Without Backtracking (Priority: P1)

As a user managing projects, workspaces, and nodes, I want persistent navigation visible on every page so I can move between sections (Dashboard, Projects, Nodes, Settings) without returning to the Dashboard first.

**Why this priority**: Navigation is the foundation of the entire user experience. Every subsequent improvement builds on users being able to move freely between sections. Currently, navigating from Nodes to Projects requires two clicks (back to Dashboard, then click Projects). This is the single highest-friction pattern across the app.

**Independent Test**: Can be fully tested by navigating between all four main sections from any page and confirming zero intermediate pages are needed. Test on both mobile (< 768px) and desktop viewports.

**Acceptance Scenarios**:

1. **Given** a user is on any page in the application, **When** they look at the navigation area, **Then** they see links to Dashboard, Projects, Nodes, and Settings, with the current section visually highlighted.
2. **Given** a user is on the Node detail page, **When** they click the Projects link in the navigation, **Then** they navigate directly to the Projects list without passing through the Dashboard.
3. **Given** a user is on a mobile device (viewport < 768px), **When** they tap the navigation toggle, **Then** a navigation drawer or menu appears with the same section links.
4. **Given** persistent navigation is active, **When** the user is on the workspace detail page (the terminal/IDE experience), **Then** the persistent navigation is hidden to maximize workspace area, and the user can return via a back button or breadcrumb.

---

### User Story 2 - Scan Entity Lists Quickly With Reduced Visual Noise (Priority: P1)

As a user with multiple workspaces and nodes, I want entity lists that are scannable with minimal visual clutter so I can find and act on the right item quickly.

**Why this priority**: The dashboard and list pages are the most frequently visited surfaces. Reducing visual noise directly improves daily workflow efficiency. Currently, each workspace card shows 5-7 lines of content and 2-3 visible buttons, creating a "wall of text" when multiple workspaces exist.

**Independent Test**: Can be fully tested by comparing the visual density of workspace and node lists before and after the change. Verify that primary actions are still accessible within 2 clicks and that secondary actions are discoverable.

**Acceptance Scenarios**:

1. **Given** a list of workspaces, **When** the user views the list, **Then** each workspace displays as a compact row showing status indicator, name, repository, branch, and last active time — with secondary details hidden.
2. **Given** a workspace row in the list, **When** the user looks for actions, **Then** only the primary action (e.g., "Open" for a running workspace) is visible, and secondary actions (Stop, Restart, Delete, Rename) are behind a single overflow menu icon.
3. **Given** a workspace row, **When** the user clicks the overflow menu icon, **Then** a dropdown menu appears with all available actions for that workspace's current state.
4. **Given** a node in the nodes list, **When** the user views the node entry, **Then** it shows status, name, workspace count, and an overflow menu — with system metrics (CPU, memory, disk) accessible on the detail page rather than inline.

---

### User Story 3 - View Project Details Across Organized Sub-Sections (Priority: P2)

As a user managing a project, I want project details organized into distinct sub-sections (overview, tasks, sessions, settings, activity) so I can focus on one concern at a time without scrolling through unrelated content.

**Why this priority**: The project detail page is the most feature-dense page after the workspace IDE. Breaking it into sub-routes improves focus, enables URL sharing of specific sections, and reduces the cognitive load of a 450+ line single-scroll page. Depends on having a Tabs component from Phase 1 primitives.

**Independent Test**: Can be fully tested by navigating to each project sub-section via its own URL and confirming that content renders correctly and independently. Verify that tab/navigation state persists across page refresh.

**Acceptance Scenarios**:

1. **Given** a user navigates to a project, **When** the project detail page loads, **Then** a tab strip or sub-navigation shows Overview, Tasks, Sessions, Settings, and Activity as distinct sections.
2. **Given** a user clicks the "Tasks" tab, **When** the section loads, **Then** the URL updates to reflect the active section (e.g., `/projects/:id/tasks`) and only task-related content is displayed.
3. **Given** a user shares a link to `/projects/:id/sessions`, **When** another user (or the same user in a new tab) opens that link, **Then** the Sessions section is displayed directly without requiring additional navigation.
4. **Given** a user is on the project Settings section, **When** they edit runtime configuration (env vars, files), **Then** the editing experience has adequate spacing and does not compete visually with unrelated project information.

---

### User Story 4 - Access a Complete Set of UI Primitives (Priority: P2)

As a developer building UI features, I want a complete set of reusable primitives (DropdownMenu, ButtonGroup, Tabs, Breadcrumb, Tooltip, EmptyState) so that common patterns are consistent across the application rather than hand-coded per page.

**Why this priority**: Missing primitives cause the downstream problems identified in the audit: inline styles bypassing the design system, inconsistent button patterns, custom hover handlers, and repeated style objects across pages. Building these primitives is foundational work that enables all other UI improvements.

**Independent Test**: Can be fully tested by rendering each primitive in isolation with all documented variants, and verifying that they match the design token system and accessibility requirements.

**Acceptance Scenarios**:

1. **Given** a developer needs a dropdown menu for entity actions, **When** they use the DropdownMenu primitive, **Then** it renders a trigger element and a positioned menu of items, supports keyboard navigation (arrow keys, Enter, Escape), and dismisses on outside click.
2. **Given** a page has related action buttons (e.g., Stop and Delete for a node), **When** the developer uses ButtonGroup, **Then** the buttons render with shared border radius (first and last buttons get outer radii, inner buttons have no radius) and no gap between them.
3. **Given** a detail page has multiple sections, **When** the developer uses Tabs with route integration, **Then** each tab corresponds to a sub-route, the active tab is visually indicated, and keyboard navigation (arrow keys) moves between tabs.
4. **Given** a user hovers over a non-obvious UI element, **When** the Tooltip is triggered, **Then** explanatory text appears after a short delay, is positioned to avoid viewport overflow, and dismisses when the user moves away.
5. **Given** a list has no items, **When** the EmptyState primitive renders, **Then** it displays an icon, heading, description, and a primary action button in a centered layout.
6. **Given** a user is deep in the page hierarchy, **When** the Breadcrumb renders, **Then** it shows the navigation path (e.g., Dashboard > Projects > Project Name > Tasks) with each segment clickable.

---

### User Story 5 - Experience Consistent Typography and Visual Hierarchy (Priority: P2)

As a user, I want clear visual hierarchy across all pages so I can quickly distinguish page titles from section headings from body text from metadata.

**Why this priority**: The current 0.25rem difference between page titles and section headings makes the hierarchy nearly invisible. Standardizing the typography scale is low effort with high visual impact and is foundational for all page restructuring work.

**Independent Test**: Can be fully tested by auditing all pages for consistent use of the typography scale tokens. Verify that page titles, section headings, card titles, body text, and captions are visually distinct at all viewport sizes.

**Acceptance Scenarios**:

1. **Given** any page in the application, **When** the user views the page title, **Then** it is visually distinct from section headings (at least 0.25rem larger and bolder weight).
2. **Given** any page, **When** section headings appear, **Then** they are visually distinct from body text (at least 0.25rem larger and/or bolder weight).
3. **Given** metadata text (timestamps, status labels, secondary information), **When** it renders, **Then** it uses a smaller, lighter style that visually recedes behind primary content.
4. **Given** the typography scale is updated, **When** existing pages render, **Then** no hardcoded font sizes remain — all text sizes reference design token values.

---

### User Story 6 - Access Settings in Organized Sub-Sections (Priority: P3)

As a user configuring the platform, I want settings organized into sub-sections (Cloud Provider, GitHub, Agent Keys, Agent Configuration) with their own routes so I can bookmark and share links to specific settings areas.

**Why this priority**: The current single-page settings layout works at the current scale (4 sections) but becomes unwieldy as settings grow. Routing settings into sub-pages follows the same pattern as project sub-routes and uses the same Tabs component.

**Independent Test**: Can be fully tested by navigating to each settings sub-route directly and confirming only the relevant section renders.

**Acceptance Scenarios**:

1. **Given** a user navigates to Settings, **When** the page loads, **Then** a tab strip or sidebar shows Cloud Provider, GitHub, Agent Keys, and Agent Configuration as distinct sections.
2. **Given** a user is on the Agent Keys settings section, **When** they share the URL, **Then** the recipient lands directly on the Agent Keys section.
3. **Given** a user completes changes in one settings section, **When** they switch to another section, **Then** unsaved changes are warned about before navigation.

---

### User Story 7 - Create Projects and Tasks via Dedicated Forms (Priority: P3)

As a user creating projects or tasks, I want dedicated creation flows (routes or modals) instead of inline toggle forms so the creation experience is focused and the URL reflects the current action.

**Why this priority**: Inline forms push content down, lose URL state, and compete visually with the list they're embedded in. Dedicated forms improve focus and enable direct linking to the creation flow.

**Independent Test**: Can be fully tested by navigating to the creation route/opening the modal, filling the form, and confirming the entity is created and the user is redirected to the new entity's detail page.

**Acceptance Scenarios**:

1. **Given** a user clicks "New Project" on the projects list, **When** the creation flow opens, **Then** it is either a dedicated route (e.g., `/projects/new`) or a modal, not an inline form that pushes the project list down.
2. **Given** a user is in the project creation flow, **When** they share the URL or refresh the page, **Then** the creation form state is preserved (for route-based) or the form resets cleanly (for modal-based).
3. **Given** a user clicks "New Task" on the tasks section, **When** the creation flow opens, **Then** it uses a consistent pattern (modal or slide-over panel) with adequate space for task description, priority selection, and dependency configuration.

---

### User Story 8 - See a Project-First Dashboard (Priority: P3)

As a returning user, I want the dashboard to lead with my projects and their active workspaces so the primary view matches the project-first architecture of the platform.

**Why this priority**: The current dashboard leads with "New Workspace" and quick-action buttons, but the platform's architecture and most user workflows are project-centric. Aligning the dashboard with the architecture reduces the conceptual mismatch identified as Structural Tension T2 in the audit.

**Independent Test**: Can be fully tested by logging in and confirming the dashboard shows projects prominently, with workspaces grouped by project. Verify that orphaned workspaces (not linked to any project) are shown separately.

**Acceptance Scenarios**:

1. **Given** a returning user with active projects, **When** they view the dashboard, **Then** projects are displayed prominently with their associated active workspaces grouped under each project.
2. **Given** workspaces that are not linked to any project, **When** the dashboard renders, **Then** orphaned workspaces are shown in a separate section with a suggestion to link them to a project.
3. **Given** the dashboard is redesigned, **When** the quick-action navigation buttons are removed (because persistent navigation exists), **Then** the dashboard has more space for project and workspace content.

---

### User Story 9 - Complete Initial Setup With Guided Onboarding (Priority: P3)

As a new user who just signed in, I want a guided onboarding experience that shows me what steps remain (Hetzner token, GitHub App, first workspace) so I can reach my first productive session without confusion.

**Why this priority**: The audit found the critical path to first value requires 3 external site visits and 2 credential entries with no guidance. An onboarding checklist reduces abandonment during setup. However, this is lower priority than structural improvements because it only affects new users, while navigation and layout issues affect all users on every session.

**Independent Test**: Can be fully tested by creating a new user account and confirming the checklist appears, progresses as setup steps are completed, and dismisses when all steps are done.

**Acceptance Scenarios**:

1. **Given** a new user who has not completed setup, **When** they view the dashboard, **Then** a checklist card shows the remaining setup steps: Connect Hetzner Cloud, Install GitHub App, Create First Workspace.
2. **Given** a user completes a setup step (e.g., saves their Hetzner token), **When** they return to the dashboard, **Then** that step is marked as complete in the checklist.
3. **Given** all setup steps are complete, **When** the user views the dashboard, **Then** the onboarding checklist is no longer displayed.
4. **Given** a user who has completed setup previously, **When** they view the dashboard on subsequent visits, **Then** the checklist never appears.

---

### Edge Cases

- What happens when the viewport is exactly at the mobile breakpoint (768px) during navigation toggle?
- How does the overflow menu behave when a workspace is in a transitional state (creating, stopping) where some actions are unavailable?
- What happens when a user navigates to a project sub-route that doesn't exist (e.g., `/projects/:id/nonexistent`)?
- How does the onboarding checklist behave if a user removes their Hetzner token after completing setup?
- What happens when the Tabs component is used on a page with more tabs than fit the viewport width?
- How does the persistent navigation behave during workspace terminal sessions where screen space is critical?
- What happens when a user with no projects views the project-first dashboard?

## Requirements *(mandatory)*

### Functional Requirements

**Navigation & Layout**

- **FR-001**: The application MUST display persistent navigation on all pages except the workspace detail (terminal/IDE) page.
- **FR-002**: The persistent navigation MUST include links to Dashboard, Projects, Nodes, and Settings, with the active section visually indicated.
- **FR-003**: On mobile viewports (< 768px), the persistent navigation MUST be accessible via a toggle (hamburger icon or similar) that opens a navigation drawer.
- **FR-004**: The workspace detail page MUST hide persistent navigation to maximize workspace area, and provide a clear way to return to the main application (back button or breadcrumb).

**Entity Lists & Actions**

- **FR-005**: Workspace list entries MUST show only the primary action visibly; all secondary actions MUST be accessible via an overflow menu (three-dot icon).
- **FR-006**: Node list entries MUST show status, name, and workspace count; system metrics MUST be on the detail page, not inline in the list.
- **FR-007**: The overflow menu MUST only show actions valid for the entity's current state (e.g., "Stop" only for running workspaces, "Start" only for stopped workspaces).

**Page Structure**

- **FR-008**: The project detail page MUST organize content into distinct routed sub-sections: Overview, Tasks, Sessions, Settings, and Activity.
- **FR-009**: Each project sub-section MUST have its own URL that can be shared and bookmarked.
- **FR-010**: The settings page MUST organize content into routed sub-sections: Cloud Provider, GitHub, Agent Keys, and Agent Configuration.
- **FR-011**: Project creation MUST use a dedicated route or modal — not an inline toggle form on the list page.
- **FR-012**: Task creation MUST use a modal or slide-over panel — not an inline toggle form.

**UI Primitives**

- **FR-013**: The design system MUST include a DropdownMenu component that supports keyboard navigation, outside-click dismissal, and positioned rendering.
- **FR-014**: The design system MUST include a ButtonGroup component that renders grouped buttons with shared border radius.
- **FR-015**: The design system MUST include a Tabs component that integrates with route-based navigation and supports keyboard navigation.
- **FR-016**: The design system MUST include Breadcrumb, Tooltip, and EmptyState components.
- **FR-017**: All new primitives MUST use the existing design token system (CSS variables) — no hardcoded colors, spacing, or typography values.

**Typography & Visual Hierarchy**

- **FR-018**: The design system MUST define a typography scale with at least 6 distinct sizes (caption, secondary, body, card title, section heading, page title).
- **FR-019**: All existing pages MUST be updated to use the standardized typography tokens — no inline font-size declarations.
- **FR-020**: The design system MUST define standard section spacing (vertical gap between major page sections) as a token.

**Dashboard & Onboarding**

- **FR-021**: The dashboard MUST display projects as the primary content, with associated workspaces grouped under their project.
- **FR-022**: Workspaces not linked to a project MUST be displayed in a separate "Unlinked Workspaces" section.
- **FR-023**: For users who have not completed setup, the dashboard MUST show an onboarding checklist with progress tracking for: Hetzner token, GitHub App installation, and first workspace creation.
- **FR-024**: The onboarding checklist MUST not appear for users who have completed all setup steps.

**Cleanup**

- **FR-025**: All inline style objects that duplicate design token patterns (border, borderRadius, background, padding) MUST be replaced with shared component usage or CSS classes.
- **FR-026**: All hardcoded color values (hex, rgba) MUST be replaced with design token CSS variables.
- **FR-027**: Custom hover handlers (onMouseEnter/onMouseLeave) that replicate CSS :hover behavior MUST be replaced with CSS-based hover states.

### Key Entities

- **Navigation**: The persistent navigation structure (top bar or sidebar) showing main application sections.
- **DropdownMenu**: A positioned, dismissible menu of action items triggered by a button or icon.
- **Tabs**: A horizontal tab strip linking to route-based sub-sections within a detail page.
- **Typography Scale**: A set of named size/weight tokens defining the visual hierarchy of text across the application.
- **Onboarding Checklist**: A dashboard component tracking new user setup progress across prerequisite configuration steps.

## Assumptions

- The existing design token system (`--sam-color-*`, `--sam-space-*`, `--sam-radius-*`) is the foundation and will be extended, not replaced.
- The workspace detail page (terminal/IDE experience) is out of scope for navigation changes — its current layout is the most polished surface and should not be disrupted.
- The `packages/ui/` shared component library is the correct location for new primitives, maintaining cross-surface reusability.
- Mobile-first responsive behavior remains the standard — new components are designed for mobile viewports first and enhanced for desktop.
- The existing React Router setup supports nested routes without significant refactoring.
- Phase 1 primitives (typography, ButtonGroup, Breadcrumb, Tooltip) can be built and shipped independently before navigation and page restructuring begins.

## Dependencies

- Spec 009 (UI System Standards) defines the design token system and compliance checklist that new primitives must conform to.
- The project-first architecture (spec 018) defines the project-centric data model that the dashboard redesign aligns with.
- The existing `packages/ui/` component library provides the extension point for new primitives.
- The audit document (`docs/notes/2026-02-22-user-journey-audit.md`) provides the competitive analysis data and detailed component-level findings that inform each requirement.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can navigate from any page to any other main section (Dashboard, Projects, Nodes, Settings) in exactly 1 click, down from the current 2-3 clicks.
- **SC-002**: Workspace and node list entries display at most 1 visible action button per item, with all other actions accessible within 2 clicks via an overflow menu.
- **SC-003**: The project detail page has 5 independently addressable sub-routes, each with a unique URL that loads correctly when accessed directly.
- **SC-004**: 100% of text sizes across the application reference design token typography variables — zero inline font-size declarations remain.
- **SC-005**: 100% of color values across the application reference design token CSS variables — zero hardcoded hex or rgba values remain in component code.
- **SC-006**: New users who have not completed setup see an onboarding checklist on the dashboard that accurately reflects their setup progress.
- **SC-007**: All new UI primitives (DropdownMenu, ButtonGroup, Tabs, Breadcrumb, Tooltip, EmptyState) pass keyboard navigation testing and use only design token values.
- **SC-008**: The dashboard prominently features projects with grouped workspaces, aligning with the project-first architecture.
