# Feature Specification: Project-First Architecture

**Feature Branch**: `018-project-first-architecture`  
**Created**: February 20, 2026  
**Status**: Draft  
**Input**: Transform SAM from a workspace-first model to a project-first model where projects (linked to GitHub repos by stable numeric ID) are the primary organizational unit. Workspaces become child entities of projects. Each project gets a Durable Object for high-throughput isolated data (chat sessions, event logs). The central D1 database remains for platform metadata. This enables chat history persistence beyond workspace lifecycle, project-scoped navigation, and unblocks dashboard chat features.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Navigate by Project as the Primary Unit (Priority: P1)

A user opens the platform and sees their projects as the primary landing view. Each project represents a GitHub repository and shows a summary of activity: active workspaces, recent chat sessions, and task status. The user selects a project to drill into its workspaces, sessions, and activity.

**Why this priority**: The entire project-first shift hinges on navigation. Without projects as the entry point, the platform remains workspace-first and cannot organize chat history, tasks, or workspaces coherently. This is the foundational UX change.

**Independent Test**: A user logs in, sees a list of their projects with summary cards, clicks into one, and sees its workspaces, recent sessions, and activity feed.

**Acceptance Scenarios**:

1. **Given** an authenticated user with at least one project, **When** they open the dashboard, **Then** they see a list of projects showing repository name, last activity timestamp, active workspace count, and task summary.
2. **Given** a user clicks on a project, **When** the project detail loads, **Then** they see active workspaces, recent chat sessions with topic summaries, and an activity feed.
3. **Given** a user has no projects, **When** they open the dashboard, **Then** they see an onboarding prompt to create their first project by selecting from their accessible GitHub repositories.
4. **Given** a project's linked GitHub repository has been renamed, **When** the user views the project, **Then** the project displays the updated repository name without manual intervention.

---

### User Story 2 - Create Workspaces Within a Project (Priority: P1)

A user creates a new workspace from within a project context. The project pre-fills the repository and branch, and the workspace is permanently associated with that project. Existing workspaces without a project association are migrated automatically.

**Why this priority**: Workspace-to-project binding is the structural change that enables chat persistence, scoped navigation, and all downstream features. Without it, workspaces remain orphaned.

**Independent Test**: A user opens a project, clicks "New Workspace," sees the repository/branch pre-filled, creates the workspace, and sees it appear under that project.

**Acceptance Scenarios**:

1. **Given** a user is viewing a project, **When** they create a new workspace, **Then** the repository and default branch are pre-filled from the project, and the workspace is saved with the project's identifier.
2. **Given** a user creates a workspace from a project, **When** they later view the project detail, **Then** the workspace appears in the project's workspace list.
3. **Given** existing workspaces created before this feature (no project link), **When** the system detects unlinked workspaces, **Then** it auto-creates or matches projects based on the workspace's repository and associates them.
4. **Given** a workspace belongs to a project, **When** the user views the workspace in any context (direct link, search, dashboard), **Then** the project association is visible and navigable.

---

### User Story 3 - Persist Chat Sessions Beyond Workspace Lifecycle (Priority: P1)

A user interacts with an AI agent in a workspace. When the workspace stops, all conversation history is preserved at the project level. The user can later view, search, and resume past sessions from the project dashboard without restarting the original workspace.

**Why this priority**: Chat persistence is the highest-value data gap in the current system. Agent conversations are the most valuable artifact of a coding session, and losing them on workspace stop is a critical UX failure. Every competitor (Claude Code, Cursor, Windsurf) persists sessions locally; SAM's cloud-first model must persist them server-side.

**Independent Test**: A user sends messages to an agent, stops the workspace, navigates to the project's session history, and sees the full conversation preserved with all messages and tool call metadata.

**Acceptance Scenarios**:

1. **Given** a user is in an active workspace chat session, **When** messages are exchanged with the agent, **Then** each message (user and assistant) is persisted in real time at the project level.
2. **Given** a workspace is stopped while a chat session is active, **When** the user navigates to the project's session list, **Then** the stopped session appears with its full message history, topic, and metadata.
3. **Given** a user opens a past chat session from the project dashboard, **When** the session loads, **Then** all messages, tool call summaries, and timestamps are displayed in order.
4. **Given** a user views a past session, **When** they choose to resume it, **Then** a new workspace starts with the session context loaded, allowing the conversation to continue.
5. **Given** tool calls were made during a session (file reads, edits, shell commands), **When** the session is reviewed later, **Then** tool call metadata (tool name, target, status) is visible, even though full tool output is not persisted.

---

### User Story 4 - View Project Activity Feed (Priority: P2)

A user opens a project and sees a chronological activity feed showing events like workspace creation/stop, chat sessions started/ended, tasks completed, and PRs opened. This gives a quick overview of what has happened in the project.

**Why this priority**: Activity feeds provide context and orientation. They help users understand what happened while they were away and are standard in every developer platform (Vercel, Railway, Linear). However, the core navigation and persistence features must land first.

**Independent Test**: A user creates a workspace, runs a chat session, stops the workspace, and sees all these events in the project's activity feed with timestamps and actor information.

**Acceptance Scenarios**:

1. **Given** a project exists, **When** a workspace is created under it, **Then** a "workspace created" event appears in the project activity feed with timestamp and workspace name.
2. **Given** a chat session starts in a project's workspace, **When** the user views the project activity feed, **Then** a "session started" event appears with the session topic and workspace reference.
3. **Given** multiple events have occurred, **When** the user scrolls through the activity feed, **Then** events are displayed in reverse chronological order with consistent formatting.
4. **Given** the activity feed grows over time, **When** old events exceed the retention window, **Then** they are automatically compacted or archived without user intervention.

---

### User Story 5 - Identify Projects by Stable GitHub Repository Link (Priority: P2)

A user's projects remain linked to the correct GitHub repository even after the repository is renamed, transferred to a different owner, or the organization is renamed. The project displays the current repository name at all times.

**Why this priority**: Repository renames and transfers are common. If the project link breaks on rename, users must manually re-link, creating friction and potential data loss. Using stable identifiers (GitHub's numeric repo ID) prevents this class of failures entirely.

**Independent Test**: A user creates a project for "user/repo-a", renames the repo to "user/repo-b" on GitHub, and sees the project automatically reflect the new name.

**Acceptance Scenarios**:

1. **Given** a project is linked to a GitHub repository, **When** the repository is renamed on GitHub, **Then** the project's displayed repository name updates automatically (via webhook or next access).
2. **Given** a project is linked to a GitHub repository, **When** the repository is transferred to a different owner, **Then** the project link remains intact because it uses the stable numeric repository ID.
3. **Given** a project's linked repository is deleted on GitHub, **When** the user views the project, **Then** they see a clear "repository detached" indicator with preserved project data (sessions, tasks, activity).
4. **Given** a user creates a project, **When** the system stores the repository reference, **Then** both the stable numeric ID and the human-readable full name are persisted.

---

### User Story 6 - Isolated High-Throughput Data per Project (Priority: P3)

The platform handles high-throughput data operations (chat messages, activity events) for each project independently without bottlenecking other projects. Each project's real-time data is isolated and can handle concurrent read/write operations without affecting platform-wide performance.

**Why this priority**: This is the architectural underpinning for stories 3 and 4. Per-project data isolation via Durable Objects ensures that a chatty project doesn't degrade the platform for other users. However, users don't directly interact with this — it manifests as consistent performance.

**Independent Test**: Two projects simultaneously receive high-throughput chat messages (many messages per minute), and both maintain consistent response times without cross-project interference.

**Acceptance Scenarios**:

1. **Given** multiple active projects with concurrent chat sessions, **When** messages are persisted simultaneously, **Then** each project's data operations complete independently without queuing behind other projects.
2. **Given** a project with a large message history, **When** a user queries past sessions, **Then** the response time remains consistent regardless of other projects' activity levels.
3. **Given** the platform central database handles metadata queries, **When** project-scoped data operations occur, **Then** they do not increase load on the central database.
4. **Given** a new project is created, **When** its data isolation layer initializes, **Then** it is ready for use without manual provisioning steps.

---

### Edge Cases

- User creates a workspace outside of any project context (e.g., via direct API call) — system should either reject or auto-create a project.
- Project's GitHub App installation is revoked — project should remain accessible with a degraded state indicator; new workspace creation blocked.
- Chat session produces extremely large messages (full file contents in tool results) — system should persist metadata and truncate/offload oversized payloads.
- Multiple workspaces in the same project have simultaneous active chat sessions — all sessions persist independently.
- User deletes a project — all associated workspaces should stop, chat history should follow the platform's data retention policy (soft-delete, then hard-delete).
- A workspace is reassigned to a different project (if supported) — session history should remain with the original project since sessions are project-scoped.
- GitHub webhook delivery failure for repository rename — system should gracefully handle stale names and update on next access.
- Durable Object schema migration occurs while active sessions are writing — migration must be atomic and not lose in-flight messages.

## Requirements *(mandatory)*

**Definitions**:
- "Project" means a user-owned organizational entity linked to a GitHub repository by its stable numeric ID.
- "Workspace" means an ephemeral VM-based development environment that belongs to exactly one project.
- "Chat session" means a persisted sequence of messages between a user and an AI agent, scoped to a project.
- "Activity event" means a timestamped record of a significant action within a project (workspace lifecycle, session events, task updates).
- "Project data store" means the per-project isolated storage layer for high-throughput, project-scoped data (chat sessions, activity events).

### Functional Requirements

#### Project as Primary Navigation Unit

- **FR-001**: System MUST display projects as the primary landing page for authenticated users, replacing the current workspace-centric view.
- **FR-002**: System MUST allow users to create projects by selecting from their accessible GitHub repositories (via installed GitHub App).
- **FR-003**: System MUST display project summary cards showing: repository name, last activity timestamp, count of active workspaces, and task status summary.
- **FR-004**: System MUST provide a project detail view showing: associated workspaces, recent chat sessions, activity feed, and task board.
- **FR-005**: System MUST provide project-scoped breadcrumb navigation: Dashboard > Project > Workspace > Session.
- **FR-006**: System MUST enforce single-user ownership — users see only their own projects.

#### Workspace-Project Binding

- **FR-007**: System MUST require every new workspace to belong to exactly one project.
- **FR-008**: System MUST pre-fill repository and branch from the project context when creating a workspace within a project.
- **FR-009**: System MUST migrate existing workspaces without a project association by auto-creating or matching projects based on the workspace's repository field.
- **FR-010**: System MUST display the project association on every workspace view and make it navigable.
- **FR-011**: System MUST prevent workspace creation without a valid project reference.

#### Chat Session Persistence

- **FR-012**: System MUST persist every chat message (user, assistant, system, tool) in real time as messages are exchanged, storing them in the project's data store.
- **FR-013**: System MUST persist chat session metadata including: session identifier, workspace identifier, topic (auto-captured from first user message), status (active, stopped, error), start time, end time, and message count.
- **FR-014**: System MUST preserve full chat history when a workspace stops — sessions transition to "stopped" status with all messages intact.
- **FR-015**: System MUST allow users to view past sessions from the project detail page, showing session list sorted by recency with topic, duration, and message count.
- **FR-016**: System MUST allow users to view the full message history of any past session, including tool call metadata (tool name, target, status indicator).
- **FR-017**: System MUST allow users to resume a past session by starting a new workspace with the session's conversation context loaded.
- **FR-018**: System MUST persist tool call metadata (tool name, file/resource target, success/failure status) but MAY omit full tool output content to manage storage.

#### Activity Feed

- **FR-019**: System MUST record project-scoped activity events for: workspace creation, workspace stop, chat session start, chat session end, task status changes, and other significant project actions.
- **FR-020**: System MUST display activity events in reverse chronological order on the project detail page.
- **FR-021**: System MUST apply a configurable retention policy to activity events, automatically compacting or archiving events older than the retention window.

#### Stable GitHub Repository Identity

- **FR-022**: System MUST store the GitHub numeric repository ID as the primary, immutable link between a project and its GitHub repository.
- **FR-023**: System MUST cache the human-readable repository full name (owner/repo) for display purposes and update it when changes are detected.
- **FR-024**: System MUST handle repository rename and transfer events (via webhook or next-access detection) by updating the cached display name without changing the project link.
- **FR-025**: System MUST handle repository deletion by marking the project as "detached" (preserving all data) and displaying a clear indicator to the user.
- **FR-026**: System MUST enforce uniqueness of projects per user per GitHub repository ID — one project per repository per user.

#### Per-Project Data Isolation

- **FR-027**: System MUST store chat sessions, messages, and activity events in a per-project isolated data store, separate from the central platform database.
- **FR-028**: System MUST ensure that data operations for one project do not block or degrade performance for other projects.
- **FR-029**: System MUST initialize per-project data stores automatically on first access without manual provisioning.
- **FR-030**: System MUST support schema evolution in per-project data stores via versioned lazy migration — checking and applying pending migrations on access.

#### Configuration and Constitution Alignment

- **FR-031**: System MUST make all operational limits configurable with documented defaults, including but not limited to: maximum projects per user, maximum stored sessions per project, message size thresholds, activity event retention period, and data compaction intervals.
- **FR-032**: System MUST derive all URLs from environment variables (e.g., `BASE_DOMAIN`) — no hardcoded URLs.
- **FR-033**: System MUST make all timeouts (session idle timeout, data store initialization timeout, webhook processing timeout) configurable via environment variables with sensible defaults.
- **FR-034**: System MUST return all API errors in the project-standard format `{ error, message }`.

### Key Entities

- **Project**: User-owned organizational unit representing a GitHub repository. Key attributes: unique identifier, user identifier, GitHub numeric repository ID, cached repository full name, project name, description, default branch, status (active, detached), audit timestamps. One project per repository per user.
- **Workspace**: Ephemeral VM development environment belonging to exactly one project. Extends existing entity with: project identifier (required). Inherits all existing attributes (node, status, display name, repository, branch).
- **Chat Session**: A conversation between a user and an AI agent, scoped to a project and optionally linked to the workspace that ran it. Key attributes: unique identifier, project identifier, workspace identifier, topic, status (active, stopped, error), start time, end time, message count.
- **Chat Message**: An individual message within a chat session. Key attributes: unique identifier, session identifier, role (user, assistant, system, tool), content, timestamp, tool call metadata (optional JSON).
- **Activity Event**: A timestamped record of a project-scoped action. Key attributes: unique identifier, project identifier, event type, actor (user or system), workspace identifier (optional), payload (structured metadata), timestamp.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users navigate to a specific project's detail page within 2 clicks from the dashboard landing page.
- **SC-002**: At least 95% of workspace creation flows start from a project context (not orphaned).
- **SC-003**: 100% of chat messages exchanged during active sessions are persisted and retrievable after workspace stop.
- **SC-004**: Users can view the full history of any past chat session within 3 seconds of requesting it, regardless of session length (up to the configured maximum).
- **SC-005**: Chat message persistence adds no more than 100 milliseconds of user-perceived latency to the message exchange flow.
- **SC-006**: Project-scoped data operations for one project do not measurably degrade response times for other projects under concurrent load.
- **SC-007**: Repository renames and transfers are reflected in the project display name within the configured detection window (webhook delivery or next user access), with zero data loss.
- **SC-008**: 100% of operational limits and timeouts introduced by this feature are configurable via environment variables with documented defaults.
- **SC-009**: Existing workspaces without project association are automatically migrated on first platform access after deployment.

## Assumptions

- Spec 016 (Projects and Tasks Foundation MVP) is implemented first, providing the base projects table and task system in D1. This spec extends that foundation with per-project isolated data stores and the workspace-project binding.
- The existing ACP message pipeline (VM Agent -> WebSocket -> Browser) can be extended to also forward messages to the project data store without major protocol changes.
- GitHub App webhooks for repository lifecycle events (rename, transfer, delete) are subscribed to and will be delivered with reasonable reliability.
- Single-user ownership remains the scope — no organization or team sharing of projects in this feature.
- The existing workspace creation API consumers (UI, any scripts) will be updated to require project context in the same release.

## Scope Boundaries

### In Scope

- Project as primary navigation unit (dashboard, detail page, breadcrumbs).
- Workspace-to-project binding (required FK, pre-filled creation, migration of existing workspaces).
- Chat session and message persistence in per-project isolated data stores.
- Session listing, viewing, and resume from project context.
- Activity event recording and display per project.
- Stable GitHub repository identity (numeric ID, webhook handling for rename/transfer/delete).
- Per-project data store initialization, schema migration, and retention policies.
- Configurable limits, timeouts, and retention windows.

### Out of Scope

- Automated orchestration and task scheduling (remains manual delegation per spec 016).
- Full-text search across chat sessions (deferred to a search-specific feature).
- Session forking (creating a new session from a specific point in an existing session).
- Auto-summarization and cross-session memory.
- Organization/team sharing of projects and multi-user access.
- Monorepo support (multiple projects per repository).
- Real-time collaborative viewing of the same chat session by multiple users.
- Bi-directional sync with external trackers (GitHub Issues/Projects, Linear, Jira).
- Dashboard chat navigation UI details (deferred to spec 017, which this spec unblocks).

## Prior Art and Best-Practice Inputs

### Developer Platform Project Models

Every successful developer platform converges on projects as the primary organizational unit:

- **Vercel**: Team > Project > Deployment hierarchy. Projects are linked to Git repositories and serve as the central unit for deployments, environment variables, domains, and analytics. Monorepo support allows multiple projects per repository.
- **Railway**: Workspace > Project > Service > Deployment. Projects group related services into a deployable application stack with shared environment variables and networking.
- **Render**: Workspace > Project > Environment > Service. Projects group services for organizational purposes with environment-level isolation for staging/production.
- **Gitpod/Ona**: Shifting from repository-first to project-first. Workspaces (environments) are ephemeral and created within project context, similar to SAM's model.
- **GitHub Codespaces**: Repository IS the project (1:1 mapping). Codespaces are ephemeral environments scoped to a repository.

**Key takeaway**: SAM's proposed 1:1 project-repository model with projects as the landing page is the industry-standard approach.

### AI Tool Session Persistence

The competitive landscape reveals a clear gap that SAM can fill with cloud-native persistence:

- **Claude Code**: Sessions stored as local JSON files in `~/.claude/projects/`. Each session is a JSONL file with full conversation history. Sessions can be resumed by ID. Context compressed at limits. No cloud sync — local-only.
- **Cursor**: Dual-layer SQLite storage. Workspace-specific history in `workspaceStorage/<hash>/state.vscdb` and global state in `globalStorage/`. JSON blobs in key-value tables. No cross-session memory — each session starts fresh. Community "Memory Bank" projects fill the gap.
- **Windsurf/Cascade**: Built-in memory system with both automatic and user-defined memories. Memories persist across sessions and provide context continuity. Uses `.windsurfrules` for persistent project rules. Most advanced memory model among competitors.
- **GitHub Copilot Chat**: No reliable persistence. Web conversations auto-delete after 30 days. VS Code local storage is buggy (conversations frequently lost). Most-requested community feature is persistent history.

**Key takeaway**: No current AI coding tool offers cloud-native, project-scoped session persistence that survives across machines and environments. SAM's approach of persisting sessions at the project level in Durable Objects is differentiated.

### Cloudflare Hybrid Storage Architecture

Cloudflare's own reference architectures recommend a hybrid approach for multi-tenant SaaS:

- **D1 (central relational database)**: Best for platform-wide metadata that needs cross-entity queries — users, projects index, nodes, workspaces. Single-writer model with read replicas. Good for low-to-medium write throughput.
- **Durable Objects with SQLite**: Best for per-tenant high-throughput data with co-located compute. Each DO gets its own SQLite database (up to 10 GB). Eliminates network hops between compute and storage. Native WebSocket support via Hibernatable WebSockets (cost-efficient idle connections). Automatic geographic placement near first user.
- **KV**: Best for ephemeral, high-throughput read-heavy data — bootstrap tokens, rate limits, cached configuration.
- **R2**: Best for large binary objects — agent binaries, large message payloads that exceed storage thresholds.

**Key takeaway**: The proposed hybrid D1 + Durable Objects + KV + R2 architecture aligns with Cloudflare's recommended patterns for multi-tenant SaaS with mixed workload characteristics.

### GitHub Repository Identity

GitHub's REST and GraphQL APIs expose three identifiers per repository:
- **Numeric `id`** (e.g., `515187740`): Stable across renames, transfers, and organization renames. Available in all API responses and webhook payloads. Recommended as primary key for external references.
- **`node_id`** (Base64 string): Stable, used for GraphQL API. Can be decoded to retrieve the numeric ID.
- **`full_name`** (e.g., `owner/repo-name`): Human-readable but mutable on rename, transfer, or org rename.

GitHub App webhooks include `repository.renamed`, `repository.transferred`, and `repository.deleted` events, all of which include both the numeric `id` and the new/old `full_name`, enabling reliable update-on-event patterns.

**Key takeaway**: Using `github_repo_id` (numeric) as the stable link and `github_repo_full_name` as a cached display name is the established best practice.

### Reference Sources

- [Cloudflare D1 Documentation](https://developers.cloudflare.com/d1/)
- [Cloudflare Durable Objects Documentation](https://developers.cloudflare.com/durable-objects/)
- [SQLite in Durable Objects (Cloudflare Blog)](https://blog.cloudflare.com/sqlite-in-durable-objects/)
- [DO Control/Data Plane Pattern](https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/)
- [Cloudflare Storage Options Comparison](https://developers.cloudflare.com/workers/platform/storage-options/)
- [Vercel Projects & Deployments](https://vercel.com/docs/getting-started-with-vercel/projects-deployments)
- [Railway Basics](https://docs.railway.com/overview/the-basics)
- [Render Projects & Environments](https://render.com/docs/projects)
- [Claude Code Session Management](https://code.claude.com/docs/en/how-claude-code-works)
- [Cursor Chat Architecture & Storage](https://dasarpai.com/dsblog/cursor-chat-architecture-data-flow-storage/)
- [Windsurf Cascade Memories](https://docs.windsurf.com/windsurf/cascade/memories)
- [GitHub Repository Webhooks](https://docs.github.com/en/webhooks/webhook-events-and-payloads#repository)
- [GitHub Global Node IDs](https://docs.github.com/en/graphql/guides/using-global-node-ids)
