# SAM Orchestration Platform — Design Vision

> **Status**: Research & Design (Feb 2026)
> **Scope**: High-level architecture for evolving SAM from a workspace manager into an agent orchestration platform.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Architecture Recap](#current-architecture-recap)
3. [Vision: From Workspace Manager to Orchestration Platform](#vision-from-workspace-manager-to-orchestration-platform)
4. [Core Primitives](#core-primitives)
   - [Projects (GitHub Repos as First-Class Entities)](#1-projects-github-repos-as-first-class-entities)
   - [Tasks (Work Items with Dependency Graphs)](#2-tasks-work-items-with-dependency-graphs)
   - [Agent Profiles (Configurable Agent Types)](#3-agent-profiles-configurable-agent-types)
   - [Orchestration Runs (Coordinated Multi-Agent Execution)](#4-orchestration-runs-coordinated-multi-agent-execution)
5. [The SAM MCP Server](#the-sam-mcp-server)
6. [Inter-Agent Communication](#inter-agent-communication)
7. [Multi-Tenancy & Organizations](#multi-tenancy--organizations)
8. [Multi-Repo Projects](#multi-repo-projects)
9. [Data Model Evolution](#data-model-evolution)
10. [Infrastructure & Scheduling](#infrastructure--scheduling)
11. [Security Considerations](#security-considerations)
12. [Phased Rollout](#phased-rollout)
13. [Open Questions](#open-questions)
14. [Research Sources](#research-sources)

---

## Executive Summary

SAM currently manages the lifecycle of individual coding agent workspaces — provisioning VMs, running devcontainers, and connecting users to Claude Code via the browser. This document designs the evolution toward an **orchestration platform** where:

- **GitHub repos become top-tier primitives** ("Projects") with associated prompt libraries, task backlogs, agent configurations, and MCP tooling definitions.
- **Tasks are first-class entities** that can be delegated to agents, which autonomously provision workspaces on machines with capacity (or spin up new machines).
- **An MCP server injected into every workspace** enables inter-agent communication, cross-workspace coordination, and agent self-delegation.
- **Agent Profiles** let projects define specialized agent roles (planner, implementer, reviewer, etc.) with distinct permissions and models.
- **Multi-repo projects** allow grouping related repositories under a single project umbrella.
- **Organizations** introduce multi-tenancy with shared infrastructure, credentials, and RBAC.

The design preserves SAM's core strengths — BYOC model, Cloudflare-first deployment, devcontainer isolation, and zero ongoing cost when idle — while layering orchestration capabilities on top.

---

## Current Architecture Recap

```
User
 └── Node (Hetzner VM)
      └── Workspace (Docker devcontainer)
           └── Agent Session (Claude Code PTY + ACP)
```

**What exists today**:
- Users own Nodes (VMs) and Workspaces (devcontainers on those VMs)
- Each workspace clones a single git repo and runs a single agent type
- Agent sessions communicate via ACP (Agent Communication Protocol) over WebSocket
- Bootstrap tokens deliver encrypted credentials at VM boot time
- Heartbeat-driven health monitoring; explicit lifecycle control (no auto-scaling)
- Single-user ownership model (no sharing, no teams)

**Key limitations for orchestration**:
- No concept of "project" — repos are just a URL passed at workspace creation
- No task model — work is ad-hoc, driven by user prompts
- No inter-agent communication — agents in different workspaces are fully isolated
- No automated workspace provisioning based on demand
- No multi-tenancy — every resource is single-user

---

## Vision: From Workspace Manager to Orchestration Platform

The fundamental shift: **SAM evolves from "give me a workspace" to "give me an outcome."**

```
Organization
 └── Project (GitHub repo or repo group)
      ├── Task Backlog (structured work items)
      ├── Prompt Library (reusable prompts/playbooks)
      ├── Agent Profiles (specialized agent roles)
      ├── MCP Config (project-level tooling)
      └── Orchestration Runs
           ├── Lead Workspace (orchestrator agent)
           └── Worker Workspaces (delegated agents)
                └── Agent Sessions
```

A user can now:
1. Click into a **Project**, see a backlog of tasks
2. Select a task (or multiple) and click **"Delegate"**
3. SAM provisions workspaces on available Nodes (or creates new Nodes)
4. An orchestrator agent decomposes the task, spawns workers, coordinates execution
5. Workers report results; the orchestrator creates a PR
6. The user reviews the PR — not the individual agent sessions

---

## Core Primitives

### 1. Projects (GitHub Repos as First-Class Entities)

A **Project** is the top-level organizational unit that wraps one or more GitHub repositories.

#### What a Project Contains

| Component | Source | Description |
|-----------|--------|-------------|
| **Repository Config** | GitHub API + DB | Repo URL, default branch, installation ID |
| **Environment** | `.devcontainer/` in repo | Devcontainer definition, features, extensions |
| **Agent Instructions** | `CLAUDE.md` in repo | Project-specific agent context and rules |
| **MCP Config** | `.mcp.json` in repo | MCP servers available to agents in this project |
| **SAM Config** | `.sam/config.json` in repo | Orchestration settings (see below) |
| **Prompt Library** | DB (user-managed) | Reusable prompts for common tasks |
| **Task Backlog** | DB (user-managed) | Structured work items with priorities and dependencies |
| **Agent Profiles** | DB (user-managed) | Specialized agent role definitions |

#### `.sam/config.json` — Project-Level Orchestration Config

This file lives in the repo and is version-controlled. It defines defaults for how SAM runs agents against this project:

```jsonc
{
  "version": 1,
  "defaults": {
    "vmSize": "medium",
    "vmLocation": "nbg1",
    "agentModel": "claude-sonnet-4-5-20250929",
    "permissionMode": "acceptEdits"
  },
  "agentProfiles": {
    "implementer": {
      "model": "claude-sonnet-4-5-20250929",
      "permissionMode": "acceptEdits",
      "mcpServers": ["github", "linear"],
      "systemPromptAppend": "Focus on implementation. Write tests for all changes."
    },
    "reviewer": {
      "model": "claude-opus-4-6",
      "permissionMode": "plan",
      "systemPromptAppend": "Review code for correctness, security, and style."
    },
    "planner": {
      "model": "claude-opus-4-6",
      "permissionMode": "plan",
      "systemPromptAppend": "Decompose tasks. Do not write code directly."
    }
  },
  "orchestration": {
    "maxParallelWorkers": 5,
    "workerTimeoutMinutes": 60,
    "failurePolicy": "continue-on-failure"
  }
}
```

#### Project Data Model

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,           -- ULID
  org_id TEXT NOT NULL,          -- FK to organizations
  name TEXT NOT NULL,            -- Display name
  description TEXT,
  created_by TEXT NOT NULL,      -- FK to users
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_id, name)
);

CREATE TABLE project_repos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,      -- FK to projects
  repository TEXT NOT NULL,      -- owner/repo
  branch TEXT,                   -- default branch override
  installation_id INTEGER,       -- GitHub App installation
  is_primary INTEGER DEFAULT 1,  -- primary repo for the project
  created_at TEXT NOT NULL,
  UNIQUE(project_id, repository)
);
```

#### Project-Scoped Prompt Library

Users can save reusable prompts associated with a project:

```sql
CREATE TABLE project_prompts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  prompt_text TEXT NOT NULL,     -- The actual prompt template
  variables TEXT,                -- JSON: template variables (e.g., {{filename}})
  agent_profile TEXT,            -- Which agent profile to use
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
```

Example prompts a user might save:
- "Implement feature from GitHub issue" — `{{issue_url}}`
- "Add tests for module" — `{{module_path}}`
- "Review and refactor" — `{{file_paths}}`
- "Fix failing CI" — `{{workflow_run_url}}`

---

### 2. Tasks (Work Items with Dependency Graphs)

Tasks are the unit of delegatable work. They form a directed acyclic graph (DAG) that the orchestrator traverses.

#### Task Lifecycle

```
draft → ready → queued → delegated → in_progress → completed
                                                  → failed
                                                  → cancelled
```

- **draft**: User is still editing (incomplete)
- **ready**: Task is fully specified, waiting for delegation
- **queued**: Scheduled for execution but waiting for infrastructure
- **delegated**: Assigned to a workspace; agent has received the prompt
- **in_progress**: Agent is actively working
- **completed**: Agent finished successfully; output artifacts available
- **failed**: Agent encountered an unrecoverable error
- **cancelled**: User or orchestrator cancelled the task

#### Task Dependencies

Tasks can declare dependencies, forming a DAG:

```
Task A (no dependencies) ──→ can start immediately
Task B (depends on A)    ──→ waits for A to complete
Task C (no dependencies) ──→ can start immediately (parallel with A)
Task D (depends on B, C) ──→ waits for both B and C
```

This enables:
- **Parallel execution**: Independent tasks run on separate workspaces simultaneously
- **Sequential pipelines**: Dependent tasks wait for predecessors
- **Fan-out / fan-in**: One task decomposes into many, then results merge

#### Task Data Model

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,       -- FK to projects
  parent_task_id TEXT,            -- FK to tasks (for decomposed sub-tasks)
  orchestration_run_id TEXT,      -- FK to orchestration_runs (set when delegated)
  workspace_id TEXT,              -- FK to workspaces (set when assigned)

  title TEXT NOT NULL,
  description TEXT,               -- Detailed task description / prompt
  status TEXT NOT NULL DEFAULT 'draft',
  priority INTEGER DEFAULT 0,     -- Higher = more important

  agent_profile TEXT,             -- Which agent profile to use
  prompt_template_id TEXT,        -- FK to project_prompts (optional)

  -- Execution metadata
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,

  -- Output
  output_summary TEXT,            -- Agent's summary of what was done
  output_branch TEXT,             -- Git branch with changes
  output_pr_url TEXT,             -- PR URL if created

  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL,          -- FK to tasks
  depends_on_task_id TEXT NOT NULL, -- FK to tasks
  PRIMARY KEY (task_id, depends_on_task_id)
);
```

#### User Experience: The Task Board

The project view shows a Kanban-style board:

```
┌─────────────┬───────────────┬──────────────┬────────────┐
│   Backlog   │  In Progress  │   Review     │   Done     │
├─────────────┼───────────────┼──────────────┼────────────┤
│ Add auth    │ Fix login bug │ Update docs  │ Add tests  │
│ Refactor DB │               │              │ CI fix     │
│ New API     │               │              │            │
└─────────────┴───────────────┴──────────────┴────────────┘
                                    │
                         [Delegate Selected]
                                    │
                    ┌───────────────┴───────────────┐
                    │  SAM provisions workspaces    │
                    │  and assigns tasks to agents  │
                    └──────────────────────────────┘
```

When the user clicks "Delegate", SAM:
1. Resolves task dependencies (DAG)
2. Identifies available Nodes with capacity (or provisions new ones)
3. Creates Workspaces for each parallelizable task
4. Injects the task prompt + project context into each agent
5. Monitors execution and reports progress in real-time

---

### 3. Agent Profiles (Configurable Agent Types)

Agent Profiles define different "roles" that agents can play within a project.

#### Why Agent Profiles?

Different tasks benefit from different agent configurations:
- **Planning tasks**: Use a more capable model (Opus), restricted permissions (plan mode)
- **Implementation tasks**: Use a fast model (Sonnet), broader permissions (acceptEdits)
- **Review tasks**: Use a capable model, read-only access, different system prompt
- **Testing tasks**: Need specific MCP servers for test frameworks

#### Profile Definition

```sql
CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT,                -- FK to projects (NULL = org-global)
  org_id TEXT NOT NULL,           -- FK to organizations
  name TEXT NOT NULL,             -- e.g., "implementer", "reviewer"
  description TEXT,

  agent_type TEXT NOT NULL DEFAULT 'claude-code',
  model TEXT,                     -- LLM model identifier
  permission_mode TEXT,           -- default, acceptEdits, plan, etc.
  system_prompt_append TEXT,      -- Additional system prompt for this role
  mcp_servers TEXT,               -- JSON array of MCP server names to inject
  max_turns INTEGER,              -- Max agentic turns before stopping
  timeout_minutes INTEGER,        -- Hard timeout

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
```

#### Built-In Profiles

SAM ships with sensible defaults that users can override:

| Profile | Model | Mode | Purpose |
|---------|-------|------|---------|
| `default` | Sonnet 4.5 | acceptEdits | General-purpose coding |
| `planner` | Opus 4.6 | plan | Task decomposition, architecture |
| `implementer` | Sonnet 4.5 | acceptEdits | Feature implementation |
| `reviewer` | Opus 4.6 | plan | Code review, security audit |
| `tester` | Sonnet 4.5 | acceptEdits | Test writing, CI fixing |

---

### 4. Orchestration Runs (Coordinated Multi-Agent Execution)

An **Orchestration Run** is a single execution of a task graph. It coordinates multiple workspaces working toward a shared goal.

#### Run Lifecycle

```
pending → provisioning → running → completing → completed
                                              → partially_failed
                                              → failed
                                              → cancelled
```

#### Orchestration Patterns

SAM supports two orchestration modes:

**A) Direct Delegation (Simple)**

User selects tasks, SAM provisions workspaces, each agent works independently, results collected.

No orchestrator agent. Best for independent tasks (e.g., "implement these 5 unrelated features").

```
User → SAM Control Plane → Worker 1 (Task A)
                          → Worker 2 (Task B)
                          → Worker 3 (Task C)
```

**B) Orchestrator-Led (Complex)**

SAM provisions a "lead" workspace running an orchestrator agent. The orchestrator reads the task graph, decomposes further if needed, spawns worker workspaces via the SAM MCP server, and merges results.

```
User → SAM Control Plane → Lead Workspace (Orchestrator)
                               ├── spawns Worker 1 (via MCP)
                               ├── spawns Worker 2 (via MCP)
                               ├── monitors progress
                               ├── merges results
                               └── creates PR
```

This is the **supervisor pattern** from multi-agent orchestration research. The orchestrator has global context; workers have scoped context.

#### Run Data Model

```sql
CREATE TABLE orchestration_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  initiated_by TEXT NOT NULL,     -- FK to users

  mode TEXT NOT NULL,             -- 'direct' | 'orchestrated'
  status TEXT NOT NULL DEFAULT 'pending',

  -- Orchestrator workspace (only for 'orchestrated' mode)
  lead_workspace_id TEXT,

  -- Configuration
  config TEXT,                    -- JSON: max workers, failure policy, etc.

  -- Results
  output_summary TEXT,
  output_pr_url TEXT,

  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Links tasks to the run they're part of
CREATE TABLE run_tasks (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  execution_order INTEGER,       -- Resolved from dependency graph
  PRIMARY KEY (run_id, task_id)
);
```

---

## The SAM MCP Server

The centerpiece of inter-agent communication: an MCP server automatically injected into every workspace that gives agents the ability to interact with the SAM platform.

### Architecture

```
┌─────────────────────────────────────────────┐
│  Workspace (devcontainer)                    │
│                                              │
│  ┌──────────────┐    ┌───────────────────┐  │
│  │ Claude Code   │───│ SAM MCP Server    │  │
│  │ (agent)       │   │ (stdio transport) │  │
│  └──────────────┘    └────────┬──────────┘  │
│                               │              │
└───────────────────────────────┼──────────────┘
                                │ HTTP
                                ▼
                    ┌──────────────────────┐
                    │ SAM Control Plane    │
                    │ (api.${BASE_DOMAIN}) │
                    └──────────────────────┘
```

The MCP server runs as a local process inside the devcontainer, communicating with Claude Code via stdio (the standard MCP transport for local servers). It authenticates to the SAM API using the workspace's callback token.

### MCP Tools Exposed

#### Workspace Management

```typescript
// Spawn a new workspace for a specific task
sam_create_workspace({
  task_id: string,          // Task to assign
  agent_profile?: string,   // Agent profile to use
  node_id?: string,         // Specific node, or auto-select
})

// Check workspace status
sam_get_workspace({ workspace_id: string })

// List workspaces in this orchestration run
sam_list_run_workspaces({ run_id: string })
```

#### Task Management

```typescript
// Read the task backlog
sam_list_tasks({
  project_id: string,
  status?: string,
  limit?: number,
})

// Get task details
sam_get_task({ task_id: string })

// Update task status (the agent reports its own progress)
sam_update_task({
  task_id: string,
  status: 'in_progress' | 'completed' | 'failed',
  output_summary?: string,
  output_branch?: string,
})

// Create sub-tasks (decomposition)
sam_create_subtask({
  parent_task_id: string,
  title: string,
  description: string,
  agent_profile?: string,
  depends_on?: string[],
})

// Delegate a task (creates workspace and assigns)
sam_delegate_task({
  task_id: string,
  agent_profile?: string,
})
```

#### Inter-Agent Communication

```typescript
// Send a message to another agent's workspace
sam_send_message({
  target_workspace_id: string,
  message: string,
  priority?: 'normal' | 'urgent',
})

// Read messages sent to this workspace
sam_read_messages({
  since?: string,  // ISO timestamp
  limit?: number,
})

// Broadcast to all workspaces in this run
sam_broadcast({
  run_id: string,
  message: string,
})
```

#### Project Context

```typescript
// Get project information
sam_get_project({ project_id: string })

// Read a prompt template
sam_get_prompt({ prompt_id: string })

// Get the orchestration run status
sam_get_run({ run_id: string })
```

### Injection Mechanism

The SAM MCP server is injected into workspaces via the devcontainer lifecycle:

1. During workspace bootstrap, the VM Agent downloads the SAM MCP server binary (from R2, alongside the VM Agent binary itself)
2. The MCP server binary is placed at `/usr/local/bin/sam-mcp`
3. A `.mcp.json` is generated (or merged with existing) at the repo root:

```json
{
  "mcpServers": {
    "sam": {
      "command": "/usr/local/bin/sam-mcp",
      "args": ["--workspace-id", "${WORKSPACE_ID}", "--api-url", "${CONTROL_PLANE_URL}"],
      "env": {
        "SAM_AUTH_TOKEN": "${CALLBACK_TOKEN}"
      }
    }
  }
}
```

4. Claude Code automatically discovers and connects to the MCP server on startup

### Implementation Language Choice

**Option A: TypeScript** (recommended for Phase 3)
- Shares types with the control plane API
- Uses official `@modelcontextprotocol/sdk` for protocol compliance
- Node.js available in most devcontainers
- Faster iteration during development

**Option B: Go static binary** (consider for Phase 5)
- No runtime dependencies (like the VM Agent)
- Faster startup, smaller footprint
- Better for resource-constrained environments

Start with TypeScript; migrate to Go if binary distribution or startup time becomes a bottleneck.

---

## Inter-Agent Communication

Agents need to coordinate across workspaces. The SAM MCP server enables this, but we need to define the communication patterns.

### Communication Channels

#### 1. Message Passing (Async)

Agents send messages to each other through the control plane:

```
Agent A (Workspace 1) → SAM API → Message Store (D1) → Agent B (Workspace 2)
```

Messages are stored in D1 with a TTL. Each workspace polls for new messages via the MCP server's `sam_read_messages` tool.

```sql
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,           -- Scoped to orchestration run
  from_workspace_id TEXT NOT NULL,
  to_workspace_id TEXT,           -- NULL = broadcast to all run workspaces
  message TEXT NOT NULL,
  priority TEXT DEFAULT 'normal',
  read_at TEXT,                   -- NULL = unread
  created_at TEXT NOT NULL
);
```

#### 2. Shared Artifacts (via Git)

Agents working on the same repo coordinate via git:
- Each worker pushes to a task-specific feature branch
- The orchestrator (or a merge worker) combines branches
- Git is the natural coordination mechanism for code changes

#### 3. Task Status Events (Reactive)

When a task transitions state, the control plane updates the DB. Other agents poll for dependency completion:

```
Worker A completes Task 1
  → Control Plane updates task status to "completed"
  → Worker B (blocked on Task 1) polls sam_get_task, sees completion
  → Worker B begins its own Task 2
```

Polling initially (simple, reliable); upgrade path to SSE push if latency matters.

### Agent-Spawns-Agent Pattern

The most powerful capability: an orchestrator agent can use the SAM MCP server to spawn additional agents:

```
Orchestrator receives: "Refactor the authentication system"
  1. Reads codebase via standard tools
  2. Calls sam_create_subtask("Refactor auth middleware")
  3. Calls sam_create_subtask("Update auth tests")
  4. Calls sam_create_subtask("Update auth documentation")
  5. Calls sam_delegate_task for each sub-task
  6. Monitors via sam_get_task polling
  7. When all complete, merges branches and creates PR
  8. Calls sam_update_task(parent, "completed")
```

### Guardrails

Agent self-delegation needs strict limits:

| Guardrail | Default | Configurable Via |
|-----------|---------|-----------------|
| Max task depth | 3 levels | `.sam/config.json` |
| Max workers per run | 5 | `.sam/config.json` |
| Worker timeout | 60 minutes | `.sam/config.json` |
| Max sub-tasks per parent | 10 | `.sam/config.json` |
| Require human approval for delegation | No | `.sam/config.json` |
| Budget cap (total VM-minutes per run) | Unlimited | Org settings |

Additional protections:
- DAG cycle detection (a task cannot depend on itself or create cycles)
- Anomaly detection (flag if an agent creates > N sub-tasks)
- Human escalation path for failed tasks

---

## Multi-Tenancy & Organizations

### Organization Model

```sql
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,      -- URL-safe identifier
  owner_id TEXT NOT NULL,         -- FK to users (creator)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE org_members (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,              -- 'owner' | 'admin' | 'member' | 'viewer'
  invited_by TEXT,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
```

### RBAC Permissions

| Permission | Owner | Admin | Member | Viewer |
|------------|-------|-------|--------|--------|
| Manage org settings | Yes | Yes | - | - |
| Manage members | Yes | Yes | - | - |
| Manage credentials | Yes | Yes | - | - |
| Create/delete nodes | Yes | Yes | Yes | - |
| Create/manage projects | Yes | Yes | Yes | - |
| Create/delegate tasks | Yes | Yes | Yes | - |
| View projects & tasks | Yes | Yes | Yes | Yes |
| View workspaces | Yes | Yes | Yes | Yes |

### Resource Scoping

All resources move from user-scoped to org-scoped:

```
Before: User → Nodes, Workspaces, Credentials
After:  User → Org Memberships
        Org  → Nodes, Workspaces, Credentials, Projects, Tasks
```

This means:
- A team shares a pool of Nodes (VMs) and cloud credentials
- Any member can create workspaces on org Nodes (subject to RBAC)
- Projects, tasks, and prompt libraries are shared within the org

### Migration Path

1. **Phase 4a**: Every existing user gets a "personal" organization (auto-created, slug = username). All existing resources migrate to this org. Single-user behavior preserved.
2. **Phase 4b**: Users can create additional organizations and invite members.
3. **Phase 4c**: Enterprise features — SSO, audit logs, org-level billing.

### Cloudflare D1 Considerations

D1 databases are capped at 10 GB. Multi-tenancy strategies:

- **Self-serve tier**: Shared database with `org_id` column on all tables. Application-layer isolation via middleware that injects `WHERE org_id = ?` on every query.
- **Enterprise tier**: Database-per-org using Cloudflare Workers for Platforms. Full physical isolation, dedicated D1/KV/R2 per tenant.

Start with shared database (simpler, sufficient for early growth). Add database-per-org when enterprise customers need it.

### Tenant Context Middleware

```typescript
// Hono middleware that resolves org context from session
const orgContext = async (c: Context, next: Next) => {
  const session = c.get('session');
  const orgSlug = c.req.param('orgSlug') || c.req.header('X-Org-Slug');

  const membership = await db.query.orgMembers.findFirst({
    where: and(
      eq(orgMembers.userId, session.userId),
      eq(orgMembers.orgId, orgSlug)
    )
  });

  if (!membership) throw errors.forbidden('Not a member of this organization');

  c.set('org', { id: membership.orgId, role: membership.role });
  await next();
};
```

---

## Multi-Repo Projects

### Why Multi-Repo?

Real-world projects often span multiple repositories:
- Frontend + backend + shared libraries
- Microservices that need coordinated changes
- Infrastructure-as-code alongside application code

### How It Works

A Project can link multiple repos via `project_repos`:

```
Project: "E-Commerce Platform"
 ├── Repo: acme/frontend        (primary)
 ├── Repo: acme/api-gateway
 ├── Repo: acme/user-service
 └── Repo: acme/shared-types
```

When delegating a task:
- The **primary repo** determines the devcontainer environment
- Additional repos are cloned into subdirectories
- The agent receives context about all repos in the project

### Cross-Repo Task Coordination

An orchestration run can assign different repos to different workers:

```
Task: "Add user avatar feature"
  ├── Sub-task: "Add avatar type defs"  → shared-types repo (no dependencies)
  ├── Sub-task: "Add avatar upload API" → api-gateway repo  (depends on types)
  └── Sub-task: "Add avatar component"  → frontend repo     (depends on types)
```

The dependency graph ensures `shared-types` changes land first, then `api-gateway` and `frontend` can work in parallel on the updated types.

---

## Data Model Evolution

### Entity Relationship Overview

```
Organization ─┬── Members (Users with Roles)
               ├── Credentials (Hetzner tokens, API keys)
               ├── Nodes (VMs)
               │    └── Workspaces (devcontainers)
               │         └── Agent Sessions
               ├── Projects
               │    ├── Repos
               │    ├── Prompt Library
               │    ├── Agent Profiles
               │    └── Tasks
               │         └── Task Dependencies
               └── Orchestration Runs
                    └── Run Tasks
```

### New Tables Summary

| Table | Purpose | Phase |
|-------|---------|-------|
| `organizations` | Multi-tenant boundary | 4 |
| `org_members` | User-org membership with roles | 4 |
| `projects` | GitHub repo groupings | 1 |
| `project_repos` | Repos linked to projects | 1 |
| `project_prompts` | Reusable prompt templates | 1 |
| `agent_profiles` | Agent role definitions | 2 |
| `tasks` | Structured work items | 1 |
| `task_dependencies` | DAG edges between tasks | 1 |
| `orchestration_runs` | Coordinated multi-agent executions | 2 |
| `run_tasks` | Task-to-run assignment | 2 |
| `agent_messages` | Inter-agent communication | 3 |

### Schema Migration Strategy

Add new tables alongside existing ones. Existing tables (`nodes`, `workspaces`, `agent_sessions`, `credentials`) gain an `org_id` column when orgs are introduced in Phase 4. Migration:

1. Create `organizations` table
2. For each existing user, create a personal org
3. Add `org_id` to existing tables, backfill with personal org ID
4. Add foreign key constraints
5. Update all queries to include org context

---

## Infrastructure & Scheduling

### Workspace Scheduler

When a task is delegated, SAM needs to decide **where** to run it:

```
Scheduling Algorithm:
1. Get all running Nodes for this org
2. Filter by capacity (current workspaces < MAX_WORKSPACES_PER_NODE)
3. Filter by VM size compatibility (task may require minimum resources)
4. Sort by: running workspaces ASC (prefer emptier nodes for load balancing)
5. If no suitable Node exists → provision a new one using org credentials
6. Create Workspace on selected Node
```

### Auto-Scaling for Orchestration Runs

For runs that need many workers:

1. **Scale up**: When task count > available workspace slots, provision new Nodes automatically
2. **Scale down**: When a run completes, flag idle Nodes for cleanup (configurable: auto-delete vs. user prompt)
3. **Pre-warming** (optional): Org-level setting to keep N Nodes always running for low-latency delegation

### Node Pool Management

Nodes become a shared resource pool at the org level:

```
Org Node Pool:
  ├── Node A (nbg1, cx33, 3/10 workspaces) ← has capacity
  ├── Node B (fsn1, cx43, 8/10 workspaces) ← nearly full
  └── [Auto-provision Node C if needed]
```

---

## Security Considerations

### Agent Authority Boundaries

Agents spawning agents creates new trust boundaries:

| Concern | Mitigation |
|---------|------------|
| Credential leakage | Workers receive only task-scoped credentials (git access, not Hetzner token) |
| Permission escalation | Workers never get broader permissions than the orchestrator |
| Runaway resource consumption | Per-run worker count and VM-minute caps |
| Rogue agent behavior | Task-scoped git branches, no main branch access |
| Infinite delegation loops | DAG cycle detection, max depth limits |
| Audit trail | Every action logged with workspace ID, user ID, timestamp |

### MCP Server Security

The SAM MCP server is a privilege escalation vector. Mitigations:

1. **Scoped auth tokens**: Workspace callback tokens are scoped to the workspace's org and run
2. **Run isolation**: MCP tools enforce that agents can only operate within their orchestration run
3. **Human-in-the-loop**: Node creation always requires user confirmation via UI
4. **Rate limiting**: Per-workspace limits on MCP tool calls (configurable)
5. **No credential passthrough**: The MCP server authenticates on behalf of the workspace, never exposes raw credentials to the agent

### Prompt Injection Mitigation

Agents reading untrusted content (issue descriptions, PR comments, external files) could receive adversarial instructions:

1. **Input sanitization**: Task descriptions treated as data context, not instructions
2. **Agent isolation**: Each workspace is a separate devcontainer; no shared filesystem
3. **Output validation**: Orchestrator can review worker outputs before merging
4. **Anomaly detection**: Flag unusual patterns (agent creating excessive sub-tasks, unexpected API calls)

---

## Phased Rollout

### Phase 1: Projects & Tasks (Foundation)

**Goal**: GitHub repos become first-class entities with task management.

**New entities**: `projects`, `project_repos`, `project_prompts`, `tasks`, `task_dependencies`

**UI changes**:
- Project list page (replaces or augments current workspace-centric view)
- Project detail page with repo info, environment config, linked workspaces
- Task board (Kanban view) with drag-and-drop prioritization
- Task detail view with description, dependencies, status history

**API changes**:
- CRUD endpoints for projects, project repos, prompts, tasks
- Task dependency management endpoints

**No automation** — tasks are manually assigned to workspaces by the user. This phase validates the data model and UX before adding orchestration.

### Phase 2: Direct Delegation (Simple Orchestration)

**Goal**: Users can delegate tasks to agents with one click.

**New capabilities**:
- Workspace scheduler (auto-select Node or provision new one)
- "Delegate" button on tasks → provisions workspace, injects task as initial prompt
- Task status callbacks from workspace (agent reports progress)
- Agent profiles (built-in + custom)
- Orchestration runs (direct mode only)
- Prompt library integration

**API changes**:
- `POST /api/tasks/:id/delegate` — trigger delegation
- Agent profile CRUD
- Orchestration run CRUD and status endpoints
- Workspace bootstrap extended to include task context

### Phase 3: SAM MCP Server (Inter-Agent Communication)

**Goal**: Agents can communicate and coordinate.

**New capabilities**:
- SAM MCP server binary (TypeScript, stdio transport)
- Injected into all workspaces during bootstrap
- MCP tools for task management, messaging, workspace spawning
- Orchestrator-led runs (lead workspace + workers)
- Agent-spawns-agent via MCP tools
- Inter-agent messaging (async, via control plane)

**What changes**: Complex tasks can be decomposed and executed by multiple agents in parallel, coordinated by an orchestrator agent.

### Phase 4: Organizations (Multi-Tenancy)

**Goal**: Teams can share infrastructure and collaborate.

**New entities**: `organizations`, `org_members`

**Migration**: Auto-create personal orgs for existing users; migrate all resources.

**New capabilities**:
- Org creation, member invitation, RBAC
- Shared Node pools, credentials, projects
- Org-scoped billing and usage tracking
- Tenant context middleware on all API routes

### Phase 5: Multi-Repo & Advanced Orchestration

**Goal**: Full orchestration platform for complex, multi-repo projects.

**New capabilities**:
- Multi-repo project support
- Cross-repo task coordination and branch management
- Advanced scheduling (location affinity, pre-warming, priority queues)
- Orchestration templates (reusable multi-agent workflows / "playbooks")
- Run history, analytics, cost tracking dashboards
- External integrations (Linear, Slack, GitHub Issues sync)

---

## Open Questions

### Git Coordination
When multiple agents push to different branches of the same repo, how does merging work? Options:
- **(a) Orchestrator merges**: Lead workspace pulls all task branches, resolves conflicts, creates a single PR
- **(b) Stacked PRs**: Each task creates its own PR; CI validates them independently
- **(c) Trunk-based**: Workers commit to a shared branch with rebasing (risky with concurrent agents)

Recommendation: Start with **(a)** for orchestrated runs and **(b)** for direct delegation.

### Context Management
How much project context does each worker agent receive?
- Full `CLAUDE.md`? Task-specific subset? Only the task description?
- Minimizing context improves speed and cost but risks missing important constraints
- The orchestrator should decide per-task: "Here's what you need to know"

### Cost Model
How is compute billed in a multi-tenant org?
- Per-workspace-hour? Per-orchestration-run? Per-task?
- Need to track VM time attribution: org → project → run → task → workspace

### Failure Recovery
When a worker fails mid-task:
- Auto-retry on a new workspace? How many retries?
- Preserve partial work (the branch) for manual recovery?
- Configurable per-run failure policy: `fail-fast` vs. `continue-on-failure`

### Human-in-the-Loop Granularity
Which operations require user confirmation?
- Creating a workspace? (Probably not — it's the point of delegation)
- Creating a Node? (Yes — costs money)
- Merging to main? (Always yes)
- Delegation beyond N workers? (Configurable threshold)

### Agent Memory Persistence
Should agent memory persist across orchestration runs for the same project?
- Decisions, patterns, past failures — valuable for future runs
- Storage: in the repo (`.claude/memory/`), in the database, or agent-specific files
- Privacy: memory is org-scoped, not shared across orgs

### MCP Server Transport
Polling (simple) vs. SSE push (low latency) for inter-agent messaging?
- Polling adds 1-5 second latency; acceptable for most orchestration
- SSE requires the MCP server to maintain a persistent connection to the control plane
- Start with polling; add SSE if latency becomes a bottleneck

### Workspace Lifecycle for Orchestration
Should orchestration workspaces auto-delete when the run completes?
- Pro: Clean up resources, reduce cost
- Con: Lose debugging context
- Recommendation: Configurable per-run, default to keep for 1 hour then auto-delete

### External Integration Scope
Should the task system integrate with Linear, Jira, GitHub Issues, Slack?
- Two-way sync is complex and error-prone
- One-way import (GitHub Issue → SAM Task) is much simpler
- Start with GitHub Issues import; add others based on demand

---

## Research Sources

### MCP (Model Context Protocol)
- [MCP Specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25)
- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp)
- [MCP Server Concepts](https://modelcontextprotocol.io/docs/learn/server-concepts)
- [MCP vs A2A — Clarifai](https://www.clarifai.com/blog/mcp-vs-a2a-clearly-explained)
- [MCP, ACP, A2A — Camunda](https://camunda.com/blog/2025/05/mcp-acp-a2a-growing-world-inter-agent-communication/)

### Multi-Agent Orchestration
- [AI Agent Design Patterns — Microsoft](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)
- [Devin Enterprise Deployment](https://docs.devin.ai/enterprise/deployment/overview)
- [MultiDevin Manager-Worker](https://docs.devin.ai/working-with-teams/multidevin)
- [OpenHands SDK — arXiv](https://arxiv.org/html/2511.03690v1)
- [Claude Code Sub-Agents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Headless Mode](https://code.claude.com/docs/en/headless)
- [2026 Agentic Coding Trends Report — Anthropic](https://resources.anthropic.com/2026-agentic-coding-trends-report)

### Task Delegation & Coordination
- [Intelligent AI Delegation — arXiv Feb 2026](https://arxiv.org/html/2602.11865v1)
- [AgentOrchestra — arXiv](https://arxiv.org/html/2506.12508v1)
- [TDAG Framework — arXiv](https://arxiv.org/abs/2402.10178)
- [IETF Task Coordination Draft](https://datatracker.ietf.org/doc/draft-cui-ai-agent-task/)

### Multi-Tenancy
- [Developer's Guide to Multi-Tenant Architecture — WorkOS](https://workos.com/blog/developers-guide-saas-multi-tenant-architecture)
- [Multi-Tenant SaaS Architecture — Clerk](https://clerk.com/blog/how-to-design-multitenant-saas-architecture)
- [D1 Multi-Tenancy — Architecting on Cloudflare](https://architectingoncloudflare.com/chapter-12/)
- [Workers for Platforms — Cloudflare](https://workers.cloudflare.com/solutions/platforms/)

### GitHub & Developer Tools
- [Dev Container Specification](https://containers.dev/implementors/json_reference/)
- [GitHub Reusable Workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub Universe 2025](https://azure.microsoft.com/en-us/blog/github-universe-2025-where-developer-innovation-took-center-stage/)
