# User Journey Map & UX Audit

**Date**: 2026-02-22
**Scope**: Complete platform audit — all user-facing surfaces
**Method**: Codebase analysis + heuristic evaluation (Nielsen's 10) + JTBD + progressive disclosure assessment
**Branch**: `audit/user-journey-map`

---

## Table of Contents

1. [User Journey Map](#1-user-journey-map)
2. [Heuristic Evaluation](#2-heuristic-evaluation-nielsens-10)
3. [Per-Journey Audit](#3-per-journey-audit)
4. [Priority Signal Analysis](#4-priority-signal-analysis)
5. [Structural Tensions](#5-structural-tensions)
6. [Gap Analysis](#6-gap-analysis)
7. [Sources & Methodology](#7-sources--methodology)
8. [Competitive UI/UX Analysis](#8-competitive-uiux-analysis)
9. [Component-Level UI Issues](#9-component-level-ui-issues)
10. [Recommended UI Improvements — Prioritized](#10-recommended-ui-improvements--prioritized)
11. [Implementation Priorities — Summary Matrix](#11-implementation-priorities--summary-matrix)
12. [Additional Sources (Competitive Research)](#12-additional-sources-competitive-research)

---

## 1. User Journey Map

### 1.1 Complete Journey Inventory

The platform surfaces **8 distinct user journeys**, each with its own entry points, flows, and completion criteria.

```
J1  First-Time Onboarding        Landing → OAuth → Dashboard → Settings → Credentials
J2  Project Management            Create project → Configure runtime → Manage tasks → View activity
J3  Node Management               Create node → Monitor health → Stop/restart/delete
J4  Workspace Creation            Prerequisites → Form → Provisioning → Ready
J5  Active Workspace Use          Terminal + Chat + Git + File browsing (the "IDE" experience)
J6  Agent Chat Sessions           Create session → Interact with Claude → View history
J7  Settings & Configuration      Hetzner token + GitHub App + Agent keys + Agent settings
J8  Task Management               Create tasks → Set dependencies → Delegate to workspace → Track
```

### 1.2 Journey Dependency Graph

```
J1 (Onboarding)
 ├─→ J7 (Settings)         ← Required before anything else works
 │    ├─→ Hetzner token    ← External: console.hetzner.cloud
 │    ├─→ GitHub App       ← External: github.com/apps/{slug}/installations/new
 │    └─→ Agent keys       ← External: console.anthropic.com (or claude setup-token)
 │
 ├─→ J2 (Projects)         ← Optional but recommended
 │    └─→ J8 (Tasks)       ← Nested within projects
 │
 ├─→ J3 (Nodes)            ← Can be implicit (auto-created with workspace)
 │
 └─→ J4 (Workspace Creation)
      └─→ J5 (Active Use)
           └─→ J6 (Chat Sessions)
```

**Critical path to first value**: J1 → J7 (Hetzner + GitHub App) → J4 → J5

This path requires 3 external site visits, 2 credential entries, 1 OAuth flow, and a 2-5 minute provisioning wait before the user gets any value from the product.

### 1.3 Page-Route Map

| Route | Page | Primary Journey |
|-------|------|-----------------|
| `/` | Landing | J1 |
| `/dashboard` | Dashboard | J1, J4 (entry) |
| `/settings` | Settings | J7 |
| `/projects` | Projects List | J2 |
| `/projects/:id` | Project Detail (tabs: Overview, Tasks) | J2, J8 |
| `/projects/:id/tasks/:taskId` | Task Detail | J8 |
| `/projects/:id/sessions/:sessionId` | Chat Session Viewer | J6 |
| `/nodes` | Nodes List | J3 |
| `/nodes/:id` | Node Detail | J3 |
| `/workspaces/new` | Create Workspace | J4 |
| `/workspaces/:id` | Workspace Detail (terminal, chat, git, files) | J5, J6 |

---

## 2. Heuristic Evaluation (Nielsen's 10)

Nielsen's usability heuristics are technology-agnostic principles focused on human cognitive behavior. They remain the gold standard for identifying UX issues across interfaces.

### H1: Visibility of System Status

**Rating: Strong**

The platform communicates state effectively in most places:

- Boot log streaming during workspace creation gives real-time feedback on a multi-minute provisioning process
- Status badges use consistent color coding (green=running, blue=creating, yellow=stopping, gray=stopped, red=error) across all entity types
- Polling strategies adapt to state: 5s during transitions, 30s during steady state — reduces API load while keeping the user informed
- Terminal connection indicators show connecting/connected/error states
- Node health badges (healthy/stale/unhealthy) with last heartbeat timestamps
- Git status polling with file counts in the toolbar
- Token usage tracking per chat session

**Where it falls short:**
- No progress percentage during provisioning (boot logs are sequential but there's no "step 3 of 7" indicator)
- Polling-based updates on dashboard mean up to 30s delay for non-transitional state changes
- No notification when a workspace finishes creating if the user navigated away
- No indication of how long provisioning typically takes

### H2: Match Between System and Real World

**Rating: Mixed**

- "Workspace" is an intuitive concept for developers — an environment where you work
- "Project" maps well to a GitHub repository with associated work items
- "Agent" and "chat session" are reasonably clear in the AI-assisted development context

**Where it falls short:**
- **"Node"** exposes infrastructure topology that most users don't need to think about. A node is a Hetzner VM that can host multiple workspaces. This is an implementation detail. Most cloud IDEs (Codespaces, Gitpod) abstract this away entirely. Users who aren't cloud infrastructure operators may find "Create Node" → "Select Size" → "Select Location" confusing
- **Three kinds of "sessions"**: agent sessions (in the API), chat sessions (in the DO), and terminal sessions (in the browser) — these are different concepts with overlapping names
- **"Bootstrap token"**: Used internally for VM-to-control-plane auth. Never surfaced to users, but referenced in API routes and schema

### H3: User Control and Freedom

**Rating: Strong**

- Stop, restart, rebuild, and delete are available for both workspaces and nodes
- Confirmation dialogs protect destructive actions (delete workspace, delete node, stop node)
- Optimistic updates with rollback on failure (dashboard workspace actions)
- Inline workspace renaming via PATCH
- URL-driven state on workspace detail page means browser back/forward preserves overlay state
- Multiple chat sessions can run concurrently — user isn't locked into one
- Worktree management allows multi-branch work without separate workspaces

**Where it falls short:**
- No "undo" for any action — once confirmed, stop/delete/rebuild are permanent
- No way to "pause" a workspace (only stop, which loses container state)
- Can't recover a deleted workspace (no soft-delete or grace period)
- No way to duplicate/clone a workspace configuration

### H4: Consistency and Standards

**Rating: Strong**

- Design system variables (`--sam-color-*`, `--sam-space-*`, `--sam-radius-*`) applied across all components
- Status badges use identical color mapping everywhere
- Card-based layout is consistent across dashboard, projects, nodes
- Form patterns are uniform: input → validation → save → toast feedback
- Error handling follows a consistent pattern: `AppError` → JSON response → UI alert
- Rate limiting headers are standard (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`)

**Where it falls short:**
- Inline styles coexist with CSS variables — some components use `style={{...}}` objects while others use class-based styles with `<style>` tags
- Some forms are inline (project creation, task creation) while others are full pages (workspace creation)
- The workspace detail page uses a fundamentally different layout pattern (toolbar + tabs + sidebar + overlays) from every other page (simple card layout with `PageLayout` wrapper)

### H5: Error Prevention

**Rating: Moderate**

- Prerequisites checking on workspace creation page prevents the most common failure: creating a workspace without Hetzner/GitHub credentials
- Hetzner token validation against the API before storage prevents invalid tokens
- Rate limiting prevents API abuse
- Max limits on entities (10 nodes, 10 workspaces per user) prevent runaway resource consumption
- Confirmation dialogs on destructive actions

**Where it falls short:**
- Model name field on agent settings is free text with no validation — a typo means silent failure at session start
- No cost estimation or warnings when creating VMs (different sizes have different Hetzner costs)
- No duplicate detection for workspaces — can create multiple workspaces for the same repo/branch combination
- No warning when approaching entity limits (e.g., "You have 9 of 10 allowed nodes")
- Branch selection falls back to a text input if API fetch fails — easy to typo a branch name

### H6: Recognition Rather Than Recall

**Rating: Moderate**

- Workspace cards show repository, branch, status, and last activity — enough to recognize which workspace is which
- Project cards show repository and description
- Breadcrumbs exist on some pages (Node Detail: Dashboard → Nodes → {name}) but not all

**Where it falls short:**
- No breadcrumbs on the workspace detail page — the most complex page in the app
- Task delegation requires the user to remember which workspaces are running and choose by name
- The relationship between projects, workspaces, and nodes isn't visualized — you have to hold the mental model
- No "recently used" or "favorites" for quick access to frequently used workspaces
- Settings page doesn't show which credentials are used by which workspaces

### H7: Flexibility and Efficiency of Use

**Rating: Bifurcated — Strong in workspace, weak everywhere else**

**Workspace detail page (strong):**
- 15+ keyboard shortcuts covering navigation, tab management, overlays, and workspace actions
- Command palette (`Cmd+K`) for searching tabs and files
- URL-driven state allows bookmarking specific views
- Multi-terminal with tab management
- Git overlays for quick status checks without leaving the terminal

**Rest of the application (weak):**
- No keyboard navigation on dashboard, projects, nodes pages
- No bulk operations (e.g., stop all workspaces, delete multiple nodes)
- No workspace templates or presets for common configurations
- No way to quickly clone a workspace configuration
- No global search across entities

### H8: Aesthetic and Minimalist Design

**Rating: Moderate**

- Dark theme is consistent and appropriate for a developer tool
- Cards provide visual grouping without excessive borders
- Quick actions grid on dashboard is space-efficient
- Settings page is well-organized with clear section headers and icons

**Where it falls short:**
- Workspace detail page is feature-dense: toolbar + tab strip + main content + sidebar + overlays + command palette + keyboard shortcuts help modal — a lot of surfaces competing for attention
- Inline styles create visual inconsistency in spacing and sizing
- No visual hierarchy between primary and secondary actions on node/workspace cards
- Project detail page's Overview tab combines 5 different sections (stats, edit form, runtime config, chat sessions, activity) in a single scrollable view

### H9: Help Users Recognize, Diagnose, and Recover from Errors

**Rating: Moderate**

- Boot logs during provisioning provide diagnostic information for failures
- Error states on workspace cards show the error message
- Rebuild option available for workspaces in error state
- Terminal auto-reconnect with 5 retries handles transient connection drops

**Where it falls short:**
- Error messages are often generic: "An error occurred" without actionable guidance
- The difference between "restart" and "rebuild" isn't explained — when should a user choose each?
- Provisioning failures don't suggest specific remediation (e.g., "Check if your Hetzner token has server creation permissions")
- No link from error states to documentation or troubleshooting guides
- Terminal reconnection failures show a generic error, not "Your token may have expired — try refreshing"

### H10: Help and Documentation

**Rating: Weak**

- Hetzner token field has a help link to the Hetzner console
- Agent key fields have links to provider consoles
- GitHub App section explains what installation does

**Where it falls short:**
- No in-app help system or documentation
- No tooltips explaining concepts (what is a "node"? what does "rebuild" do?)
- No getting-started guide or tutorial
- No contextual help on any page
- No "what's new" or changelog for returning users
- No FAQ or common-issues section
- The only "help" is the external CLAUDE.md file and docs/ directory, which are developer-facing, not user-facing

### Heuristic Summary

| Heuristic | Rating | Notes |
|-----------|--------|-------|
| H1: Visibility of System Status | Strong | Boot logs, status badges, adaptive polling |
| H2: Match System / Real World | Mixed | "Node" leaks infra, session naming overlaps |
| H3: User Control and Freedom | Strong | Full lifecycle control, URL state, confirmations |
| H4: Consistency and Standards | Strong | Design system, consistent patterns |
| H5: Error Prevention | Moderate | Prerequisites checking, but gaps in validation |
| H6: Recognition over Recall | Moderate | Cards helpful, but relationships not visualized |
| H7: Flexibility / Efficiency | Bifurcated | Workspace is power-user heaven; rest is basic |
| H8: Aesthetic / Minimalist | Moderate | Clean but dense in places |
| H9: Error Diagnosis / Recovery | Moderate | Boot logs help, but guidance is thin |
| H10: Help and Documentation | Weak | Minimal in-app help anywhere |

---

## 3. Per-Journey Audit

### J1: First-Time Onboarding

**The journey:**
1. User arrives at `/` (landing page)
2. Sees "Sign in with GitHub" button + feature highlights
3. Authenticates via GitHub OAuth (read:user, user:email scope)
4. Redirected to `/dashboard`
5. Sees empty dashboard with "No workspaces yet" and "Create your first workspace" button
6. Clicks create → redirected to `/workspaces/new`
7. Prerequisites check fails: no Hetzner token, no GitHub App
8. User must navigate to `/settings` to configure credentials
9. User visits external sites (Hetzner Console, GitHub) to obtain/install credentials
10. Returns to `/workspaces/new` — prerequisites now pass
11. Fills form, creates workspace
12. Waits 2-5 minutes for provisioning
13. Workspace ready — can open terminal and start agent

**What works:**
- GitHub OAuth is standard and quick
- Prerequisites checking on the workspace creation page is a clear blocker that prevents the confusing failure of trying to create without credentials
- Feature highlights on landing page set expectations

**What doesn't work:**
- The critical path to first value requires **3 external site visits** and **2 credential entries** before the user can do anything. This is a "cold start" problem that every cloud dev tool faces, but SAM doesn't provide any guidance through it
- After GitHub OAuth, the user lands on an empty dashboard. There's no onboarding checklist, no "setup wizard," no progress indicator showing "2 of 3 steps complete"
- The empty state is minimal: just text + a button. Per best practices, empty states should educate, inspire, and guide — this one does minimal guiding
- Settings page doesn't indicate which items are blocking workspace creation. You have to go back to `/workspaces/new` to see the prerequisites status
- No indication of how long provisioning takes — the boot log streams but there's no "this typically takes 2-3 minutes"
- No email or notification when the first workspace is ready if user navigates away

**JTBD lens:**
The user's core job is "get an AI coding agent running against my repo." The time-to-first-value is currently 10-20 minutes (including external site visits, credential setup, and provisioning). The emotional job is "feel confident this tool is worth the setup cost" — the empty dashboard and minimal guidance don't build this confidence.

### J2: Project Management

**The journey:**
1. Navigate to `/projects`
2. Toggle "New Project" form
3. Select GitHub installation, repository, branch
4. Add name and optional description
5. Submit → redirected to project detail
6. Configure runtime (env vars, files) in Overview tab
7. View activity feed, chat sessions
8. Create and manage tasks in Tasks tab

**What works:**
- Repository selector component auto-suggests repos from GitHub installations
- Branch dropdown auto-populates from repo (with fallback)
- Runtime configuration supports both env vars and files with secret encryption
- Activity feed aggregates workspace, session, and task events in one timeline
- Task management has a proper state machine with transition rules

**What doesn't work:**
- Project creation is an inline form toggle on the projects list page — not a dedicated page. For such an important entity, this feels underweight
- No project templates or "quick start" configurations
- No visual indication of project health (are tasks progressing? are workspaces active?)
- The Overview tab combines 5 disparate sections (stats, edit form, runtime config, sessions, activity) in a single scroll. There's no visual hierarchy indicating what's most important
- "Launch Workspace" button on project detail creates a workspace but doesn't explain what that means for the project's tasks
- Chat sessions listed on project page are view-only — can't navigate to the workspace where they happened

### J3: Node Management

**The journey:**
1. Navigate to `/nodes`
2. Click "Create Node" → auto-generates name like `node-20260222t123456z`
3. See node card in "creating" state, polling every 10s
4. Node transitions to "running" after Hetzner provisioning (1-2 min)
5. Click node → see detail page with system info, docker, software, workspaces, events
6. Can stop or delete node from detail page

**What works:**
- System info proxy gives real visibility into VM health (CPU, memory, disk, Docker containers, software versions)
- Node events section shows what's happening inside the VM
- Health status computed from heartbeat freshness is a good abstraction

**What doesn't work:**
- Auto-generated names (`node-20260222t123456z`) are not human-meaningful. Users can't tell nodes apart at a glance
- No way to rename a node after creation
- Node creation doesn't allow selecting a name — the name is auto-assigned
- Users must manage nodes as a separate concept from workspaces, but most users likely don't care about the infrastructure layer
- Stopping a node stops ALL workspaces on it — this cascading effect isn't prominently warned about
- No "scale" concept — can't add resources to an existing node
- Node metrics (CPU load, memory %) are shown as raw numbers without context about what's normal or concerning

### J4: Workspace Creation

**The journey:**
1. Navigate to `/workspaces/new` (from dashboard, node detail, or project detail)
2. Prerequisites check runs in parallel (Hetzner, GitHub, Nodes)
3. If prerequisites pass: form appears
4. Fill: name, repository, branch, node (optional), VM size/location (if creating new node)
5. Submit → POST to API → redirect to workspace detail
6. Watch boot logs stream during provisioning
7. Workspace transitions to "running"

**What works:**
- Prerequisites check is excellent UX — it prevents the most confusing failure mode
- Parallel prerequisite checking means the page loads fast
- Form adapts based on context: if navigated from a project, repo/branch are pre-filled and read-only
- Node selection offers "Create a new node automatically" as default — reduces cognitive load
- VM size selector uses clear labels (Small/Medium/Large with specs)

**What doesn't work:**
- No cost indication for VM sizes — users can't make informed decisions
- Location dropdown shows city names but no latency or region context
- Branch selection fails silently and falls back to a text input — should explain why
- No "advanced options" section for idle timeout, custom cloud-init, etc.
- Creating a workspace without a project means the workspace is "orphaned" — this isn't communicated
- The form doesn't save draft state — if you navigate away, you lose your inputs

### J5: Active Workspace Use (the "IDE" Experience)

**The journey:**
1. Workspace detail page loads with toolbar, tab strip, content area, sidebar
2. Terminal tab is default — WebSocket connection established with JWT token
3. User types commands in xterm.js terminal
4. Can create additional terminal tabs
5. Can create chat sessions (select agent, start conversation)
6. Can toggle git changes panel, file browser
7. Can use keyboard shortcuts and command palette
8. Activity throttling prevents API spam on every keystroke
9. Idle detection warns before auto-shutdown

**What works:**
- The workspace detail page is the most polished surface in the entire app
- Keyboard shortcuts cover all common workflows (`Cmd+K` for palette, `Cmd+P` for files, `Cmd+G` for git, `Cmd+N` for new chat, etc.)
- URL-driven state means overlay state survives navigation and can be bookmarked
- Multi-terminal with per-tab working directory tracking
- Proactive terminal token refresh prevents mid-session disconnects
- Git integration (status, staged/unstaged diffs, worktree management) is genuinely useful without leaving the browser
- Activity throttling (10s debounce) balances responsiveness with API load

**What doesn't work:**
- The page is complex. A new user has to discover: the tab strip, sidebar, overlay panels, command palette, and keyboard shortcuts. There's no guided tour or progressive disclosure
- Sidebar is desktop-only — mobile users lose workspace info, events, git status, and token usage
- Chat sessions render in an iframe (ACP client) which creates a separate scrolling context
- No way to split the view (e.g., terminal + chat side by side)
- File browser is read-only — can view but not edit files directly
- Git changes panel is display-only — can't stage/unstage/commit from the UI
- Orphaned session detection shows a banner but the recovery action ("Stop All") is aggressive — no option to reconnect individual sessions
- No persistent workspace configuration — if you rebuild, customizations (installed packages, shell config) are lost

### J6: Agent Chat Sessions

**The journey:**
1. Click "+" or `Cmd+N` on workspace tab strip
2. Select agent (Claude Code, OpenAI Codex, Gemini CLI)
3. Session created → view switches to conversation mode
4. Type message → agent processes → tool calls execute on VM → response rendered
5. Messages persisted to ProjectData DO (survives workspace restart)
6. View session history from project detail page

**What works:**
- Multiple concurrent sessions allow parallel workstreams
- Session persistence in Durable Objects means conversation history survives workspace restarts
- Token usage tracking gives cost visibility per session
- Agent selection per session supports different tools for different tasks
- Session labeling helps organize work

**What doesn't work:**
- No indication of which agent model is being used in the active session
- Can't search session history
- Can't export or share a session transcript
- Session viewer on the project page (route: `/projects/:id/sessions/:sessionId`) is read-only with basic styling — messages are pre-wrap text blocks with role badges, but no syntax highlighting, no collapsible tool calls
- No "resume previous session" workflow — stopped sessions are view-only, you always start fresh
- Token usage is shown per-session but no aggregate view across sessions or projects

### J7: Settings & Configuration

**The journey:**
1. Navigate to `/settings`
2. See 4 sections: Hetzner Cloud, GitHub App, Agent API Keys, Agent Settings
3. Each section has its own form/controls
4. Back button returns to dashboard

**What works:**
- Clean four-section layout with icons and descriptions
- Each section is self-contained with its own load/save/error handling
- Hetzner token validation against the API before saving prevents invalid credentials
- Agent key section supports dual credential types (API key vs OAuth token) with clear labeling
- Agent settings support model selection and permission modes with descriptions
- Credential masking (`...last4`) for security

**What doesn't work:**
- No indication of which settings are required vs optional for core functionality
- No setup progress indicator ("2 of 3 required steps complete")
- GitHub App installation requires leaving the site and returning — no in-page flow
- Agent settings model field is free text — a dropdown of known models would be better
- Permission mode descriptions are terse — "Bypass all permission checks" doesn't explain the implications
- No "test connection" button for agent API keys (Hetzner has validation, agents don't)
- Settings aren't linked to their downstream effects — doesn't show which workspaces use which credentials
- No import/export of settings for backup or migration

### J8: Task Management

**The journey:**
1. Navigate to project detail → Tasks tab
2. Create task with title, description, priority
3. Set dependencies between tasks
4. Filter and sort task list
5. Transition task status (draft → ready → queued → delegated → in_progress → completed)
6. Delegate task to running workspace
7. View task detail with output (summary, branch, PR URL)
8. View task activity log (status transitions)

**What works:**
- Complete state machine with well-defined transition rules
- Dependency management with blocking detection
- Task delegation to workspaces connects planning to execution
- Task output captures artifacts (branch, PR URL, summary)
- Priority system for ordering work
- "Needs Attention" section surfaces blocked/failed tasks

**What doesn't work:**
- Task creation is an inline form — for a primary workflow, this feels too lightweight
- No drag-and-drop for priority ordering
- No Kanban/board view — only a filterable list
- Delegation dialog shows workspace names but no context about what's running on them
- No automatic task creation from chat sessions (agent can't propose tasks)
- No due dates or time estimates
- No assignment to people (single-user, but no "assign to agent" concept either)
- Task status transitions are manual — no automation (e.g., auto-complete when PR merged)

---

## 4. Priority Signal Analysis

### What the Investment Pattern Reveals

By examining code volume, feature depth, and polish level, we can infer what has been prioritized:

### Tier 1: Heavily Invested (Core Experience)

| Area | Evidence | Investment Level |
|------|----------|-----------------|
| **Workspace detail page** | 15+ keyboard shortcuts, command palette, 6+ URL params, multi-terminal, git integration, file browser, overlays, worktree management | Very High |
| **Security & encryption** | AES-256-GCM per-credential, BYOC model, JWT with JWKS, rate limiting, token refresh, bootstrap tokens | Very High |
| **API architecture** | 80+ endpoints, cursor pagination, configurable limits, rate limiting, error taxonomy, Durable Objects, hybrid storage | Very High |
| **Agent session infrastructure** | Multiple concurrent sessions, persistence across restarts, token tracking, orphan detection, session lifecycle management | High |
| **Project-first architecture** | Hybrid D1+DO storage, activity feeds, runtime config, task state machine, dependency graphs | High |

### Tier 2: Moderately Invested (Functional but Basic)

| Area | Evidence | Investment Level |
|------|----------|-----------------|
| **Dashboard** | Quick actions grid, workspace cards with optimistic updates, project summary, polling | Moderate |
| **Settings page** | 4 sections, credential management, agent settings, form validation | Moderate |
| **Node management** | CRUD + monitoring, system info proxy, health status, events | Moderate |
| **Git integration** | Status polling, staged/unstaged diffs, worktree management, file browser | Moderate |

### Tier 3: Under-Invested (Gaps)

| Area | Evidence | Investment Level |
|------|----------|-----------------|
| **First-time onboarding** | Landing page with one button, empty dashboard state, no setup wizard | Low |
| **Empty states** | "No workspaces yet" with a button — no education, no visuals, no guidance | Low |
| **Error recovery guidance** | Generic error messages, no contextual help, no troubleshooting links | Low |
| **Mobile experience** | MobileNavDrawer exists, but workspace page is desktop-only (sidebar, overlays, shortcuts) | Low |
| **In-app help** | No tooltips, no getting-started guide, no contextual help | Very Low |
| **Search & discoverability** | No global search, no filtering on dashboard | Very Low |
| **Notifications** | No out-of-app notifications for state changes | None |
| **Collaboration** | No sharing, no team features, no multi-user | None |

### What This Says

The investment pattern reveals a **power-user-first, infrastructure-forward** development philosophy:

1. **The core loop (workspace + terminal + chat) is deeply built out.** This is where the team expects users to spend most of their time, and it shows. The workspace detail page could pass as a standalone product.

2. **Backend architecture is production-grade.** The API is well-designed, security is thorough, and the hybrid storage pattern (D1 for queries, DOs for write-heavy data) is a sophisticated architectural choice. The engineering rigor is high.

3. **Infrastructure management is exposed rather than abstracted.** Users manage nodes directly — they see VM sizes, locations, heartbeat health, Docker containers, and system metrics. This is unusual for a workspace product and suggests the target user is comfortable with infrastructure concepts. Competing products (Codespaces, Gitpod) abstract this entirely.

4. **The "getting started" experience is a known gap.** The prerequisites system on the workspace creation page is a clever acknowledgment that setup is complex, but it's a guardrail, not a guide. There's no investment in making the first 10 minutes feel smooth.

5. **Task management is architecturally complete but UX-thin.** The state machine, dependency graph, and delegation system are well-engineered. But the UI is a basic list with inline forms. This suggests it was built API-first for agent consumption, with human UI as a secondary concern.

---

## 5. Structural Tensions

These are architectural or conceptual tensions — not bugs, but design choices that create friction between different user needs.

### T1: Power vs. Simplicity

The workspace page has 15+ keyboard shortcuts, a command palette, URL-driven overlays, and multi-terminal support. Creating your first workspace requires visiting 3 external sites and configuring 2 credentials.

The advanced user experience is polished. The newcomer experience is fragmented. These two audiences need different things, and the product currently optimizes for one while acknowledging the other with a basic prerequisites check.

**Progressive disclosure theory** (Nielsen Norman Group) says: "Initially show users only a few of the most important options. Offer a larger set of specialized options upon request." The workspace page does the opposite — all features are surface-level visible from the start.

### T2: Project-First Architecture vs. Workspace-First UI

The codebase is organized around a "project-first architecture" — the CLAUDE.md, specs, and ADRs all describe projects as the primary organizational unit. Projects have DOs, activity feeds, task management, and runtime config.

But the dashboard leads with workspaces. The primary CTA is "New Workspace," not "New Project." Quick actions give equal weight to Nodes, Projects, and Settings. And you can create workspaces without projects (orphaned workspaces).

This creates two parallel workflows:
- **Project-centric**: Create project → Configure → Launch workspace from project → Delegate tasks
- **Workspace-centric**: Create workspace directly → Work in terminal/chat → No project context

The codebase invests heavily in the project-centric path, but the UI's default flow is workspace-centric.

### T3: Infrastructure Exposure vs. Abstraction

Users directly manage nodes — choosing VM sizes, locations, monitoring CPU/memory/disk, viewing Docker containers and software versions. The node detail page is essentially a lightweight server management dashboard.

Most competing products abstract this layer entirely. In GitHub Codespaces, you choose a "machine type" and the infrastructure is invisible. In Gitpod, you configure a `.gitpod.yml` and workspaces auto-scale.

SAM's approach gives power users more control and aligns with the BYOC (Bring Your Own Cloud) model where users manage their own Hetzner accounts. But it also means every user, including those who just want "a place to run Claude on my repo," must understand node topology.

### T4: Chat Persistence vs. Workspace Ephemerality

Chat sessions persist in Durable Objects across workspace restarts. If you stop and restart a workspace, your conversation history is intact (viewable from the project page).

But the workspace itself is ephemeral. Terminal history, installed packages, shell configuration, and working state are lost on restart. Git worktrees created during a session are recreated from the repo.

This creates an asymmetry: your conversation with Claude about what you were doing survives, but the context it was operating in doesn't. A user might read a chat session saying "I installed package X and modified file Y" but the current workspace state doesn't reflect that.

### T5: Depth of Feature vs. Breadth of Coverage

The git integration is deep: worktree management, staged/unstaged diff viewing, file browsing, status polling. These are features you'd expect from a full IDE.

But there's no search across workspaces, no way to compare workspace configurations, no templates, no presets, no saved configurations. The depth is in one direction (the workspace IDE experience) while breadth across the platform is thin.

Similarly, task management has a complete state machine with 8 states, dependency graphs, and delegation flows. But the UI has no board view, no drag-and-drop, no timeline, no automation.

---

## 6. Gap Analysis

### 6.1 Onboarding & First-Run Experience

| Gap | Severity | Best Practice Reference |
|-----|----------|------------------------|
| No setup wizard or onboarding checklist | High | Userpilot: "Checklists guide users through important actions in a structured way and provide the satisfaction of completing tasks" |
| Empty states are minimal — text + button only | High | Pencil & Paper: "Two parts instruction, one part delight. A little personality is great, but not at the cost of clarity" |
| No progress indicator for setup steps | Medium | Formbricks: "Showing progress (e.g., '3 of 5 steps done') encourages completion" |
| No time-to-value estimation during provisioning | Medium | Evil Martians: "For heavy operations, design for perceived speed" |
| No return-user re-engagement | Low | Not applicable at current stage, but will be needed |

### 6.2 Error Handling & Recovery

| Gap | Severity | Best Practice Reference |
|-----|----------|------------------------|
| Generic error messages without actionable guidance | High | Smashing Magazine: "Error messages should be constructive so customers know what needs to be done" |
| No distinction between "restart" and "rebuild" for users | Medium | User Journeys: "Guide them intuitively by designing the interface so it's easy to do the right thing" |
| No link from error states to troubleshooting docs | Medium | Carbon Design System: "Include a link to documentation for more details" |
| Agent settings model field is free text with no validation | Low | Nielsen: "Prevent errors before they occur — disable irrelevant options, validate input" |

### 6.3 Discoverability & Navigation

| Gap | Severity | Best Practice Reference |
|-----|----------|------------------------|
| No breadcrumbs on workspace detail page | Medium | Nielsen: "Recognition rather than recall — display needed information" |
| No global search across entities | Medium | Evil Martians: "Discoverability is the core navigation system for everything" |
| No guided discovery of workspace features | Medium | IxDF: "Progressive disclosure — reduce cognitive load by gradually revealing complexity" |
| No "recently used" or favorites | Low | Competing products all offer quick-access patterns |

### 6.4 Mobile & Responsive Design

| Gap | Severity | Best Practice Reference |
|-----|----------|------------------------|
| Workspace detail page is desktop-only (sidebar, overlays, command palette) | High | Evil Martians: "Consider using responsive layout even if not targeting mobile" |
| Terminal on mobile is likely unusable (keyboard shortcuts, command palette) | Medium | This may be an acceptable trade-off for a developer tool |
| Dashboard responsive but workspace is not | Medium | Inconsistent experience across the app |

### 6.5 Help & Documentation

| Gap | Severity | Best Practice Reference |
|-----|----------|------------------------|
| No in-app help or tooltips | High | Nielsen H10: "Help and documentation — help should be easy to search, focused on the user's task" |
| No getting-started guide | High | Userpilot: "Including an image of the space populated with data may help trigger interest and usage" |
| No contextual help per page | Medium | Shopify: "Progressive disclosure minimizes cognitive load" |
| No "what's new" for returning users | Low | Good for retention but not critical at this stage |

### 6.6 Workflow Completeness

| Gap | Severity | Best Practice Reference |
|-----|----------|------------------------|
| Git integration is read-only (can't stage/commit from UI) | Medium | Competing IDEs allow full git workflows |
| File browser is read-only (can't edit files) | Medium | Reduces utility as a standalone workspace |
| No workspace templates/presets | Medium | Coder/Gitpod both offer template-based creation |
| Task management has no board/Kanban view | Low | Standard for project management tools |
| No automation for task status (e.g., auto-complete on PR merge) | Low | Would complete the "agent autonomy" vision |

---

## 7. Sources & Methodology

### Methodology

This audit was conducted through:

1. **Codebase analysis**: Systematic reading of all route definitions, page components, API endpoints, middleware, services, and shared types across `apps/web/`, `apps/api/`, `packages/shared/`, and `packages/terminal/`
2. **Heuristic evaluation**: Each user journey evaluated against Jakob Nielsen's 10 Usability Heuristics (1994, revised)
3. **JTBD analysis**: User goals analyzed through the Jobs to Be Done lens — functional, emotional, and social dimensions
4. **Progressive disclosure assessment**: Each page evaluated for how complexity is managed and revealed
5. **Comparative analysis**: Feature set compared against known competitors (GitHub Codespaces, Gitpod, Coder)
6. **Best practice research**: UX patterns evaluated against current industry research and standards

### UX Research Sources

- [Evil Martians: 6 Things Developer Tools Must Have](https://evilmartians.com/chronicles/six-things-developer-tools-must-have-to-earn-trust-and-adoption) — Developer tool UX requirements for 2025-2026
- [Evil Martians: Devs in Mind — How to Design Interfaces for Developer Tools](https://evilmartians.com/chronicles/devs-in-mind-how-to-design-interfaces-for-developer-tools) — Developer-specific design patterns
- [Nielsen Norman Group: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) — Complexity management framework
- [Nielsen Norman Group: 7 Ways to Analyze a Customer Journey Map](https://www.nngroup.com/articles/analyze-customer-journey-map/) — Journey map evaluation methodology
- [Interaction Design Foundation: Progressive Disclosure](https://www.interaction-design.org/literature/topics/progressive-disclosure) — Progressive disclosure patterns and theory
- [Userpilot: Empty State UX Examples](https://userpilot.com/blog/progressive-disclosure-examples/) — SaaS empty state best practices
- [Pencil & Paper: Empty States](https://www.pencilandpaper.io/articles/empty-states) — Empty state design rules
- [Smashing Magazine: Designing Better Error Messages](https://www.smashingmagazine.com/2022/08/error-messages-ux-design/) — Error handling UX patterns
- [Pencil & Paper: Error Message UX](https://www.pencilandpaper.io/articles/ux-pattern-analysis-error-feedback) — Error feedback analysis
- [ProductPlan: Jobs-to-Be-Done Framework](https://www.productplan.com/glossary/jobs-to-be-done-framework/) — JTBD theory and application
- [Toptal: Jobs to Be Done Framework](https://www.toptal.com/designers/ux/jobs-to-be-done-framework) — JTBD in practice
- [Gartner: Cloud Development Environments Reviews 2026](https://www.gartner.com/reviews/market/cloud-development-environments) — Market landscape
- [HubSpot: How to Conduct a UX Audit](https://blog.hubspot.com/website/ux-audit) — UX audit methodology
- [Formbricks: User Onboarding Best Practices](https://formbricks.com/blog/user-onboarding-best-practices) — Onboarding patterns for 2026

### Files Analyzed

**Web Application** (`apps/web/src/`):
- Router configuration, all page components, all shared components
- Auth provider, protected routes, hooks
- API client functions, state management patterns
- Layout components, navigation, mobile drawer

**API** (`apps/api/src/`):
- All route files (auth, credentials, github, nodes, workspaces, projects, tasks, sessions, agents, terminal, bootstrap, transcription, client-errors, ui-governance, agent-settings)
- All middleware (auth, rate-limit, error, cors, proxy)
- All services (encryption, validation, hetzner, github-app, jwt)
- Database schema, Durable Object (ProjectData)
- Index/Env configuration

**Shared Packages** (`packages/`):
- `shared/src/` — types, constants, agents
- `terminal/src/` — terminal component, WebSocket handling
- `ui/src/` — design system components (Button, Card, StatusBadge, PageLayout, etc.)

---

## 8. Competitive UI/UX Analysis

This section compares SAM's UI patterns against comparable cloud development environment and developer platform products.

### 8.1 GitHub Codespaces

**Dashboard pattern:** Flat list at `github.com/codespaces`. Each codespace is a single row showing repository name, branch, machine type, status, and last used time. A three-dot overflow menu (ellipsis icon) on each row contains: Open in... (browser/VS Code/JetBrains), Rename, Change machine type, Stop codespace, Export changes to a branch, Auto-delete toggle, Delete.

**Key patterns SAM should adopt:**
- **Overflow menu instead of visible buttons.** Codespaces shows zero visible action buttons per row — everything lives behind a single `...` menu. This keeps the list scannable and removes the visual clutter of 2-4 buttons per card.
- **Machine type is a detail, not a management surface.** Users pick a machine type at creation time, and can change it later, but there's no "machine dashboard" or "VM detail page." Infrastructure is invisible.
- **Status is a single pill badge** — not two badges (status + health) like SAM's nodes.
- **Filtering:** Codespaces provides filters by repository, branch, and status at the top of the list.

**What SAM does better:** Boot log streaming, real-time status polling during transitions, project-level organization.

### 8.2 Gitpod

**Dashboard pattern:** Workspace list with status indicators, repository/branch context, and a primary "New Workspace" button. Workspaces show elapsed time and can be filtered by status.

**Key patterns:**
- **One-click workspace creation from any repo.** Gitpod's signature UX is `gitpod.io/#https://github.com/org/repo` — prepend the URL and you're in. No prerequisite setup, no forms.
- **Workspace presets via `.gitpod.yml`.** Configuration lives in the repo, not in a platform UI. This eliminates the "configure runtime" step entirely.
- **Timeout-based lifecycle.** Workspaces auto-stop after inactivity. No "node management" — all abstracted.
- **Context URL.** Shows the original trigger (PR, branch, issue) prominently on each workspace card.

**What SAM does better:** Multi-terminal tabs, command palette, chat session persistence, task management.

### 8.3 Coder

**Dashboard pattern:** Template-based workspace creation. The primary abstraction is "Templates" — reusable workspace definitions that declare VM resources, Docker images, IDE preferences, and startup scripts.

**Key patterns:**
- **Template gallery as the primary creation flow.** Instead of filling a form, users browse and select from pre-defined templates. This is a strong progressive disclosure pattern — the complexity lives in the template definition, not the creation UI.
- **Workspace list is a simple table** with name, template, status, and last used. Actions are behind an overflow menu.
- **Agent-based architecture** with transparent resource display (CPU/memory) shown as compact inline badges on workspace rows, not a separate detail page.
- **Settings organized by concern** — not all on one page. Account, SSH keys, tokens, appearance each get their own route.

**What SAM does better:** Project-level organization, activity feeds, chat session management.

### 8.4 Railway

**Dashboard pattern:** Project-centric. The dashboard shows projects as cards. Each project opens to a canvas-style service graph showing services, databases, and their connections visually.

**Key patterns:**
- **Canvas/graph view for infrastructure.** Instead of listing nodes and workspaces separately, Railway shows them as connected nodes on a canvas. This makes the relationship between services immediately visible.
- **Service detail uses tabbed navigation:** Overview, Deployments, Logs, Metrics, Settings, Variables. Each tab is a distinct route (`/project/:id/service/:id/settings`).
- **Compact deployment cards** with commit message, branch, status badge, and timing — all in a single scannable row.
- **Environment selector** as a top-level dropdown that filters the entire project view. Production, staging, development environments are first-class.
- **Split button pattern:** The primary deploy button has a dropdown for "Deploy from branch," "Deploy from commit," etc.

**What SAM should adopt:**
- **Tab-based service detail** instead of putting everything on one scrollable page.
- **Environment variables as a first-class tab**, not nested inside an "Overview" scroll.
- **Breadcrumbs are always present** and clickable, showing the full path: Workspace > Project > Service.

### 8.5 Vercel

**Dashboard pattern:** Project cards in a grid. Each card shows the project name, linked repository, latest deployment status, production URL, and last updated time. Cards are compact — approximately 3 lines of information.

**Key patterns:**
- **Deployment list is the project's primary view.** When you click a project, you see recent deployments (not a settings page). Each deployment row shows: commit message, branch, status, timing, and a "Visit" link.
- **Three environments (Production, Preview, Development)** shown as tabs or filters.
- **Filter dropdowns** for branch, status, and environment — compact horizontal bar above the deployment list.
- **Settings are deeply routed:** `/project/:name/settings`, `/project/:name/settings/environment-variables`, `/project/:name/settings/domains`, etc. Each concern has its own page.
- **Project cards are clickable without any visible buttons.** The entire card is the click target. Actions (settings, domains, etc.) live inside the project detail.
- **Production URL** shown prominently — the most important output of the system.

**What SAM should adopt:**
- **Cards as clickable surfaces** without embedded action buttons. Navigate first, act second.
- **Deeply routed settings** instead of everything on one page.
- **Show the "output" prominently** — for SAM this means the workspace URL or active session count, not just metadata.

### 8.6 Render

**Dashboard pattern:** Left-side navigation menu that adapts to context. At the workspace level, the sidebar shows services grouped by type. At the service level, the sidebar shows Logs, Metrics, Events, Settings.

**Key patterns:**
- **Contextual left sidebar.** The sidebar content changes based on what you're viewing. This is a strong navigation pattern for multi-level hierarchies.
- **Breadcrumb header** showing exactly where you are: Workspace > Project > Service. Clickable to jump between levels.
- **Service detail tabs:** Events, Logs, Metrics, Settings — each as a separate route, not inline sections.
- **Event timeline** with deploy events, instance failures, and scaling events overlaid on metric graphs. Events are filterable by type.
- **Themes:** Light and dark modes with high-contrast variants.

**What SAM should adopt:**
- **Contextual sidebar navigation** — SAM already has this on the workspace detail page but nowhere else.
- **Event filtering** on activity feeds.
- **Metric-event overlay** — showing events on top of node metrics graphs.

### 8.7 Linear (Task Management Patterns)

**Key patterns:**
- **Ultra-compact task rows:** Title, status icon, priority icon, assignee avatar, due date — all in one horizontally dense row. No card chrome, no borders between items — just a list with hover highlighting.
- **Keyboard-first interaction.** `c` to create, `e` to edit, `j/k` to navigate, space to select, `x` to close. Every action has a single-key shortcut.
- **Multi-view:** List, Board (Kanban), and Timeline views toggled with a single click. Same data, different layouts.
- **Inline editing.** Click any field to edit it in place — title, status, priority, assignee. No modal, no separate page for simple edits.
- **Command palette** (`Cmd+K`) for everything — create, search, navigate, bulk operations.
- **Bulk selection** with checkboxes and batch actions bar.
- **Sub-issues and dependencies** shown inline with expand/collapse.
- **Filter bar** with composable filters: status, priority, assignee, label, due date. Filters are saveable as "views."

**What SAM should adopt for task management:**
- **Compact rows instead of cards** for task lists.
- **Inline status/priority editing** without navigating to task detail.
- **Keyboard shortcuts** for the task view (currently only the workspace page has shortcuts).
- **Board/Kanban view** as an alternative to the list.

### 8.8 Competitive Summary

| Pattern | Codespaces | Gitpod | Coder | Railway | Vercel | Render | Linear | **SAM** |
|---------|-----------|--------|-------|---------|--------|--------|--------|---------|
| Overflow menus (vs visible buttons) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | **No** |
| Button groups / split buttons | No | No | No | Yes | No | No | No | **No** |
| Tabbed detail pages | N/A | N/A | Yes | Yes | Yes | Yes | N/A | **Partial** |
| Deeply routed settings | N/A | Yes | Yes | Yes | Yes | Yes | Yes | **No** |
| Breadcrumbs on all pages | Yes | Yes | Yes | Yes | Yes | Yes | N/A | **Partial** |
| Contextual sidebar nav | N/A | N/A | No | No | No | Yes | Yes | **Workspace only** |
| Command palette | N/A | N/A | No | No | No | No | Yes | **Workspace only** |
| Keyboard shortcuts outside IDE | No | No | No | No | No | No | Yes | **No** |
| Compact entity rows | Yes | Yes | Yes | Yes | Yes | Yes | Yes | **No (cards)** |
| Infrastructure abstraction | Full | Full | Partial | Full | Full | Full | N/A | **None** |
| Template/preset creation | No | Yes | Yes | Yes | No | No | N/A | **No** |

---

## 9. Component-Level UI Issues

This section catalogs specific, code-level UI problems identified through codebase analysis of `apps/web/src/` and `packages/ui/src/`.

### 9.1 Button Patterns

**Problem: Dashboard quick actions use oversized buttons for navigation.**

The dashboard renders 4 navigation buttons as `size="lg"` (56px height, full width on mobile), plus an info card in a 5-column grid. These are navigation links, not primary CTAs — they don't need to be 56px tall.

```
Current: 5 equally-weighted lg buttons in a grid
Better:  Compact nav links/pills, with "New Workspace" as the sole prominent CTA
```

**Problem: WorkspaceCard uses custom inline button styling instead of the Button component.**

`WorkspaceCard.tsx` defines its own `actionButtonStyle` object (`padding: '4px 12px', fontSize: '0.75rem'`) and manually implements hover with `onMouseEnter`/`onMouseLeave`. This bypasses the shared `Button` component entirely. On mobile, these custom buttons are conditionally resized to `minHeight: '56px'` via the `isMobile` hook.

```
Current: 6+ inline-styled <button> elements with manual hover logic per card
Better:  Button component with size="sm" variant, hover handled by CSS
```

**Problem: Node detail page uses inline style overrides for the delete button.**

`Node.tsx` renders the delete button as `variant="secondary"` with inline `style={{ borderColor: 'var(--sam-color-danger)', color: 'var(--sam-color-danger)' }}` instead of using `variant="danger"`. This creates visual inconsistency — the danger variant exists but isn't used.

**Problem: Project detail page has three full-sized action buttons on the header.**

"Launch Workspace", "Edit project", and "Delete project" are all rendered as standard `md` size buttons (44px) in a horizontal row. There's no visual separation between the primary action (Launch) and the destructive action (Delete). On narrow viewports, these three buttons wrap and dominate the header.

```
Current: [Launch Workspace] [Edit project] [Delete project]
Better:  [Launch Workspace]  ...overflow menu containing Edit and Delete
```

### 9.2 Missing UI Primitives

The `packages/ui/` component library has: Button, Card, StatusBadge, Alert, Input, Select, Spinner, Skeleton, Dialog, Toast, PageLayout, Container, Typography.

**Missing primitives needed for the improvements below:**

| Component | Use Case | Industry Precedent |
|-----------|----------|-------------------|
| **ButtonGroup** | Group related actions with shared border radius | Material UI, Atlassian, shadcn/ui |
| **DropdownMenu / OverflowMenu** | Three-dot menu for secondary actions | Every product surveyed uses this |
| **SplitButton** | Primary action + dropdown for variants | Railway deploy button, Atlassian |
| **Tabs** | Routed tab navigation | Railway, Render, Vercel service detail |
| **Breadcrumb** | Hierarchical navigation trail | Render, Railway, Vercel |
| **Sidebar / NavMenu** | Contextual left navigation | Render, Linear |
| **ActionBar / Toolbar** | Consistent header with filters + actions | Linear, Vercel filter bar |
| **Badge / Tag** | Compact metadata display | All products |
| **Tooltip** | Hover explanations for icons/terms | All products |
| **EmptyState** | Structured empty state with icon, text, action | Codespaces, Gitpod, Vercel |

### 9.3 Layout and Routing Issues

**Problem: No persistent navigation.**

The app has no global sidebar or top navigation bar. Each page renders its own `PageLayout` with a back button and title. Navigation between sections (Dashboard, Projects, Nodes, Settings) requires going back to the dashboard and clicking the right quick-action button. This is flat, not hierarchical.

```
Current: PageLayout with back arrow → Dashboard → quick action buttons → page
Better:  Persistent sidebar or top nav with: Dashboard, Projects, Nodes, Settings
```

**Problem: Project detail page combines too many concerns in one scroll.**

`Project.tsx` is 450+ lines and renders 2 tabs (Overview, Tasks). The Overview tab contains 5 inline sections: summary stats, edit form (toggleable), runtime config (env vars + files), chat sessions, and activity feed. These should be separate sub-routes or collapsible panels.

```
Current: /projects/:id  →  one long scroll with Overview/Tasks tabs
Better:  /projects/:id/overview, /projects/:id/tasks, /projects/:id/settings, /projects/:id/sessions, /projects/:id/activity
```

**Problem: Settings page puts everything on one page.**

Four sections (Hetzner, GitHub App, Agent Keys, Agent Settings) are all vertically stacked on `/settings`. Render and Vercel both route settings into sub-pages. As more settings are added, this page will become unwieldy.

```
Current: /settings  →  4 vertical sections
Better:  /settings/cloud, /settings/github, /settings/agent-keys, /settings/agent-config
         with a left sidebar or tab strip for navigation
```

**Problem: Inline forms instead of modals or routes.**

Project creation (`Projects.tsx`), task creation (`Project.tsx`), and project editing are all inline toggle sections that push content down. This loses URL state (can't link to "create project"), and the form competes visually with the list it's embedded in.

```
Current: Click "New Project" → inline form appears above list
Better:  Click "New Project" → navigate to /projects/new (or open a modal)
```

### 9.4 Card and Entity Display

**Problem: Workspace cards are visually heavy.**

Each `WorkspaceCard` shows: name, status badge, repository, branch, VM size, location, node ID, optional error message, last activity timestamp, and 2-3 action buttons. This is 5-7 lines of content per card. In a 3-column grid, the dashboard becomes a wall of text.

Competing products use a single-row table layout (Codespaces, Coder) or ultra-compact cards (Vercel) with secondary information hidden behind click or hover.

```
Current: Card with name + badge + repo + branch·vmSize·location·nodeId + error + timestamp + buttons
Better:  Compact row: [Status] Name — repo@branch — last active — [...] menu
```

**Problem: Node list items show too much inline metadata.**

Each node row shows: name, status badge, health badge, heartbeat timestamp, and 3 metric badges (LOAD, MEM, DISK). This is the right information but presented too densely.

```
Current: [Running] [Healthy] node-name — Heartbeat: ... — [LOAD 0.5] [MEM 45%] [DISK 23%]
Better:  [Running] node-name — 3 workspaces — [...] menu (metrics on detail page)
```

**Problem: Project list items use `<button>` styled as cards instead of the Card component.**

`Projects.tsx` renders each project as a `<button>` with inline styles mimicking a card. This bypasses the shared `Card` component and creates inconsistency with `WorkspaceCard` and `ProjectSummaryCard`.

### 9.5 Spacing and Visual Hierarchy

**Problem: Inconsistent section spacing.**

Dashboard uses `marginBottom: 'var(--sam-space-8)'` (32px) between major sections. Project detail uses `gap: 'var(--sam-space-4)'` (16px). Node detail uses `gap: 'var(--sam-space-6)'` (24px). There's no standard for "space between page sections."

**Problem: Typography scale is too flat.**

Page titles use `clamp(1.125rem, 2vw, 1.375rem)` via PageLayout. Section headings use `1.125rem`. Card titles use `0.875rem`. The difference between a page title and a section heading is 0-0.25rem — barely distinguishable.

```
Suggested scale:
  Page title:       1.5rem, weight 700
  Section heading:  1.125rem, weight 600
  Card title:       0.9375rem, weight 500
  Body text:        0.875rem, weight 400
  Caption/meta:     0.75rem, weight 400
```

**Problem: Form fields are too tightly spaced.**

Runtime config forms in `Project.tsx` use `gap: 'var(--sam-space-2)'` (8px) between fields. This is cramped. Industry standard for form field spacing is 16-24px.

### 9.6 Inline Styles vs. CSS

**Problem: Repetitive inline style objects across pages.**

The pattern `{ border: '1px solid var(--sam-color-border-default)', borderRadius: 'var(--sam-radius-md)', background: 'var(--sam-color-bg-surface)', padding: 'var(--sam-space-4)' }` appears in Projects.tsx, Project.tsx, Node.tsx, and many component files. This should be a shared component (the `Card` component exists but isn't consistently used).

**Problem: Responsive styles use inline `<style>` tags.**

Dashboard, Project, and other pages inject `<style>` blocks for responsive grid definitions (e.g., `.sam-quick-actions { grid-template-columns: 1fr; }`). This mixes concerns and makes it hard to find all responsive rules.

**Problem: Hardcoded colors alongside CSS variables.**

WorkspaceCard uses hardcoded `'rgba(239, 68, 68, 0.1)'` for hover backgrounds and `'#f87171'` for error text. Settings page uses `'rgba(168, 85, 247, 0.15)'` for icon backgrounds. These should be derived from the token system.

---

## 10. Recommended UI Improvements — Prioritized

Based on the competitive analysis, component audit, and gap analysis, here are concrete improvements ranked by impact and feasibility.

### Tier 1: High Impact, Moderate Effort (Do First)

#### R1: Add persistent top navigation

**Problem:** No way to navigate between Dashboard, Projects, Nodes, Settings without going back to the Dashboard first.

**Solution:** Add a compact top navigation bar to `PageLayout` with links to the four main sections. The dashboard quick-action buttons then become redundant and can be removed or repurposed as content (e.g., stats/summary cards).

**Precedent:** Vercel, Railway, Render, Gitpod all have persistent nav.

**Impact:** Reduces navigation clicks by 1-2 per task. Makes the app feel like a cohesive product instead of a collection of pages.

#### R2: Replace visible card buttons with overflow menus

**Problem:** WorkspaceCard shows 2-3 visible action buttons (Open, Stop, Delete, Restart). Node list shows status + health + metrics inline. This creates visual clutter.

**Solution:** Add a `DropdownMenu` component to `packages/ui/`. Replace visible action buttons on cards/rows with a single `...` overflow menu. Keep only the primary action visible (e.g., "Open" for running workspaces).

**Precedent:** GitHub Codespaces, Gitpod, Coder, Vercel — all use overflow menus on entity lists.

**Impact:** Dramatically reduces visual noise on dashboard and list pages. Makes cards scannable.

#### R3: Route project detail into sub-pages

**Problem:** Project detail page is a 450+ line single component with 2 tabs and 5+ inline sections on the Overview tab.

**Solution:** Break into sub-routes:
- `/projects/:id` → Overview (summary + recent activity)
- `/projects/:id/tasks` → Task list with filters
- `/projects/:id/sessions` → Chat session list
- `/projects/:id/settings` → Runtime config + project edit
- `/projects/:id/activity` → Full activity feed

Use a tab strip or sidebar for navigation between sub-routes.

**Precedent:** Railway (service tabs), Vercel (project tabs), Render (service sidebar).

**Impact:** Reduces page complexity, improves URL shareability, makes each concern independently accessible.

#### R4: Create compact entity rows as an alternative to cards

**Problem:** Workspace and node cards are visually heavy with 5-7 lines of content each.

**Solution:** For list views, offer a compact row format: `[StatusDot] Name — repo@branch — last active — [...]`. Cards can remain for the dashboard summary or grid view.

**Precedent:** GitHub Codespaces (table rows), Linear (compact rows), Coder (table rows).

**Impact:** Users with many workspaces/nodes can scan the list much faster.

### Tier 2: High Impact, Higher Effort

#### R5: Add persistent sidebar navigation

**Problem:** Navigation is flat — each page is independent with no hierarchy.

**Solution:** Add an optional collapsible sidebar that shows:
- Dashboard (home)
- Projects (expandable to show each project)
- Nodes
- Settings

The sidebar adapts to context: when viewing a project, it shows that project's sub-navigation (Overview, Tasks, Sessions, Settings, Activity).

**Precedent:** Render (contextual sidebar), Linear (sidebar with projects).

**Impact:** Provides hierarchical navigation, makes entity relationships visible, reduces back-and-forward navigation.

#### R6: Build a Tabs component and use it consistently

**Problem:** Project detail uses custom tab styling via `<style>` tags. No reusable tab component exists.

**Solution:** Create a `Tabs` component in `packages/ui/` that:
- Renders a horizontal tab strip with underline indicator
- Integrates with React Router for route-based tabs
- Supports URL search param-based tabs for simpler cases
- Handles keyboard navigation (arrow keys)

Use it in: Project detail, Node detail (overview / resources / events), Settings.

**Precedent:** Every product surveyed uses tabs for detail page sections.

#### R7: Implement an onboarding checklist

**Problem:** New users land on an empty dashboard with no guidance through the 3-step setup process.

**Solution:** Show a checklist card on the dashboard for users who haven't completed setup:
1. Connect Hetzner Cloud (link to settings)
2. Install GitHub App (link to settings)
3. Create your first workspace (link to create)

Each step shows a completion indicator. The checklist auto-dismisses when all steps are done.

**Precedent:** Formbricks, Userpilot patterns. Gitpod's "connect repo" flow. Vercel's project import wizard.

**Impact:** Guides new users through the critical path. Reduces the "now what?" moment after first login.

### Tier 3: Medium Impact, Moderate Effort

#### R8: Route settings into sub-pages

**Problem:** All settings on one vertically stacked page. Will become unwieldy as settings grow.

**Solution:** Route into: `/settings/cloud`, `/settings/github`, `/settings/agent-keys`, `/settings/agent-config`. Add a left sidebar or tab strip for navigation.

**Precedent:** Coder, Vercel, Render all use routed settings.

#### R9: Make Dashboard project-first

**Problem:** Dashboard leads with "New Workspace" but the architecture is project-first. This creates a tension (Structural Tension T2 from the audit).

**Solution:** Restructure the dashboard to lead with projects:
- Recent projects section (top)
- Active workspaces section (grouped by project)
- Quick actions reduced to a compact bar: [+ New Project] [Settings]
- Orphaned workspaces (not linked to a project) shown separately

**Precedent:** Railway (project-centric dashboard), Vercel (project cards as primary).

#### R10: Replace inline forms with modals or routes

**Problem:** Project creation, task creation, and project editing use inline toggle forms that push content down and lose URL state.

**Solution:**
- Project creation → `/projects/new` route (or modal)
- Task creation → Modal or slide-over panel
- Project editing → `/projects/:id/settings` route

**Precedent:** Vercel (import project page), Linear (modal for new issue, `c` shortcut).

#### R11: Add a ButtonGroup and SplitButton to the design system

**Problem:** No way to visually group related buttons. Node detail shows "Create Workspace," "Stop Node," "Delete Node" as three equal-weight standalone buttons.

**Solution:** Create `ButtonGroup` (shared border radius, no gap) and `SplitButton` (primary action + dropdown) components.

Use cases:
- Node detail: `[Create Workspace]` primary + `[Stop | Delete ▾]` split
- Workspace card: `[Open ▾]` split (Open in browser / Open in VS Code)
- Task actions: `[Ready ▾]` split for status transitions

**Precedent:** Material UI ButtonGroup, Atlassian SplitButton, shadcn/ui ButtonGroup.

#### R12: Standardize the typography scale

**Problem:** 0.25rem difference between page titles and section headings. Card titles at 0.875rem are the same size as body text.

**Solution:** Define and enforce a typography scale in `packages/ui/`:
```
--sam-font-size-xs:    0.75rem    (captions, timestamps)
--sam-font-size-sm:    0.8125rem  (secondary text, metadata)
--sam-font-size-base:  0.875rem   (body text)
--sam-font-size-md:    0.9375rem  (card titles, labels)
--sam-font-size-lg:    1.125rem   (section headings)
--sam-font-size-xl:    1.375rem   (page titles)
--sam-font-size-2xl:   1.75rem    (dashboard welcome)
```

### Tier 4: Lower Priority but Valuable

#### R13: Add keyboard shortcuts to non-workspace pages

Workspace detail has 15+ shortcuts. The rest of the app has zero. Adding even basic shortcuts (`n` for new, `/` for search, `j/k` for navigation) would bring consistency.

**Precedent:** Linear (keyboard shortcuts everywhere), GitHub (keyboard shortcuts on all pages).

#### R14: Add a global command palette

Extend the workspace's command palette to work globally across the app. `Cmd+K` anywhere should search across projects, workspaces, nodes, and settings.

**Precedent:** Linear, Vercel, Raycast-style command palettes.

#### R15: Add tooltip component for contextual help

Many UI elements would benefit from hover explanations: "What is a node?", "What does rebuild do vs. restart?", "Why is my workspace in recovery?"

**Precedent:** Every product surveyed has tooltips on non-obvious elements.

#### R16: Add Breadcrumb component and use everywhere

Create a reusable `Breadcrumb` component. Currently Node detail has hand-coded breadcrumbs, Project detail has a partial breadcrumb, Workspace detail has none.

**Precedent:** Render, Railway, Vercel all use consistent breadcrumbs.

---

## 11. Implementation Priorities — Summary Matrix

| # | Recommendation | Impact | Effort | Dependencies |
|---|---------------|--------|--------|-------------|
| R1 | Persistent top navigation | High | Medium | None |
| R2 | Overflow menus on cards | High | Medium | DropdownMenu component |
| R3 | Route project detail sub-pages | High | Medium | Tabs component (R6) |
| R4 | Compact entity rows | High | Low | None |
| R5 | Persistent sidebar navigation | High | High | R1 (replaces top nav at scale) |
| R6 | Tabs component | High | Medium | None |
| R7 | Onboarding checklist | High | Medium | None |
| R8 | Route settings sub-pages | Medium | Medium | Tabs component (R6) |
| R9 | Project-first dashboard | Medium | Medium | R1 or R5 |
| R10 | Replace inline forms | Medium | Medium | None |
| R11 | ButtonGroup / SplitButton | Medium | Low | None |
| R12 | Typography scale | Medium | Low | None |
| R13 | Global keyboard shortcuts | Low | Medium | None |
| R14 | Global command palette | Low | High | R13 |
| R15 | Tooltip component | Low | Low | None |
| R16 | Breadcrumb component | Low | Low | None |

**Suggested implementation order:**

**Phase 1 (Foundation):** R12 (typography), R11 (ButtonGroup/SplitButton), R16 (Breadcrumb), R15 (Tooltip) — build the missing primitives.

**Phase 2 (Navigation):** R1 (persistent nav), R6 (Tabs component), R2 (overflow menus) — fix the navigation model and reduce visual clutter.

**Phase 3 (Page Structure):** R3 (project sub-routes), R8 (settings sub-routes), R10 (replace inline forms), R4 (compact rows) — restructure the information architecture.

**Phase 4 (Refinement):** R7 (onboarding), R9 (project-first dashboard), R5 (sidebar), R13/R14 (keyboard shortcuts).

---

## 12. Additional Sources (Competitive Research)

- [GitHub Codespaces Documentation](https://docs.github.com/en/codespaces) — Workspace management, three-dot menu patterns
- [GitHub Codespaces Overview](https://github.com/features/codespaces) — Feature overview and machine type selection
- [Gitpod Documentation](https://www.gitpod.io/docs) — Workspace presets, `.gitpod.yml` configuration
- [Coder Documentation](https://coder.com/docs) — Template-based workspace creation, agent architecture
- [Railway Documentation](https://docs.railway.com) — Project canvas, service tabs, deployment patterns
- [Vercel Deployments Documentation](https://vercel.com/docs/deployments) — Project cards, deployment filtering, environment selector
- [Vercel Project Settings](https://vercel.com/docs/project-configuration/project-settings) — Deeply routed settings pattern
- [Render Dashboard Documentation](https://render.com/docs/render-dashboard) — Contextual sidebar, breadcrumb navigation
- [Render Blog: New CLI and Refreshed Dashboard](https://render.com/blog/introducing-renders-new-cli-and-refreshed-dashboard) — Dashboard redesign principles
- [Render Service Metrics](https://render.com/docs/service-metrics) — Metric-event overlay patterns
- [Linear Method](https://linear.app/method) — Keyboard-first design, compact rows, multi-view patterns
- [Nielsen Norman Group: Split Buttons](https://www.nngroup.com/articles/split-buttons/) — Split button UX patterns and discoverability
- [Atlassian Design System: Split Button](https://atlassian.design/components/button/split-button/) — Split button implementation reference
- [shadcn/ui: Split Button with Dropdown](https://www.shadcn.io/patterns/button-group-advanced-1) — React implementation of split button pattern
- [Material UI: React Button Group](https://mui.com/material-ui/react-button-group/) — ButtonGroup component reference
- [Andrew Coyle: Drop-Down Button vs. Split Button](https://coyleandrew.medium.com/drop-down-button-vs-split-button-f8e539fc0b78) — Pattern selection guidance
