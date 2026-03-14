# Research: SAM Agents — Repo-Based Agent Configuration

**Date:** 2026-03-14
**Status:** Research / Proposal
**Author:** AI (research task)

## Executive Summary

This document explores what it would take to let users define **SAM Agents** within a project — named agent configurations that specify the coding agent, system prompt, hardware requirements, and eventually devcontainer configuration. The key design question is whether this config should live in the git repository (`.sam/` directory) or in the control plane database, and the answer is: **both, with the repo as the source of truth and the control plane as cache/override layer**.

---

## 1. What is a SAM Agent?

A SAM Agent is a **named, reusable agent configuration** scoped to a project. Instead of choosing "claude-code" + "medium VM" + typing a system prompt every time you submit a task, you define an agent like:

```yaml
# .sam/agents/backend-reviewer.yaml
name: Backend Reviewer
agent: claude-code
model: claude-sonnet-4-6

prompt: |
  You are a senior backend engineer reviewing this codebase.
  Focus on API correctness, error handling, and performance.
  Always run tests before proposing changes.

hardware:
  size: medium  # or explicit: { cpu: 4, ram: 8 }

workspace:
  profile: full
```

Then when submitting a task, users pick "Backend Reviewer" from a dropdown instead of configuring everything from scratch.

### Why This Matters

1. **Repeatability** — Same agent config every time, no drift
2. **Team sharing** — Agent definitions travel with the repo
3. **Specialization** — Different agents for different tasks (review, implement, debug, test)
4. **Version control** — Agent config changes are tracked in git history
5. **Onboarding** — New team members get pre-configured agents immediately

---

## 2. Current Architecture (What Exists Today)

### Agent Type System

**File:** `packages/shared/src/agents.ts`

The system has a static `AGENT_CATALOG` with 4 agent types:
- `claude-code` — Anthropic's Claude Code
- `openai-codex` — OpenAI's Codex
- `google-gemini` — Google's Gemini CLI
- `mistral-vibe` — Mistral's Vibe

Each `AgentDefinition` specifies: ACP command, environment variable name, install command, OAuth support. These are **platform-level capabilities** (which binaries can SAM run?), not user-level configurations.

### Current Config Precedence (per task submission)

```
Task submit parameter → Project default (DB) → Env var default → Hardcoded fallback
```

| Field | Task param | Project DB | Env var | Fallback |
|-------|-----------|------------|---------|----------|
| Agent type | `agentType` | `defaultAgentType` | `DEFAULT_TASK_AGENT_TYPE` | `'claude-code'` |
| VM size | `vmSize` | `defaultVmSize` | `DEFAULT_VM_SIZE` | `'medium'` |
| Workspace profile | `workspaceProfile` | `defaultWorkspaceProfile` | — | `'full'` |

### What's Missing

- **No system prompt / custom instructions** — agents get a task description but no persistent personality/role
- **No named agent configurations** — you can't save "use claude-code with this prompt on a large VM" as a reusable profile
- **No repo-based config** — all config lives in the control plane DB
- **No devcontainer customization** — profile is just `full` vs `lightweight`, no custom `.devcontainer.json` support
- **No hardware requirements beyond t-shirt sizes** — can't specify "minimum 8GB RAM"

---

## 3. Proposed Design: `.sam/` Directory

### Directory Structure

```
.sam/
├── config.yaml          # Project-level SAM configuration
└── agents/
    ├── default.yaml     # Default agent (used when no agent specified)
    ├── reviewer.yaml    # Code review specialist
    ├── implementer.yaml # Feature implementation agent
    └── debugger.yaml    # Debugging specialist
```

### Config Schema: `config.yaml`

```yaml
# .sam/config.yaml
version: 1

# Project-level defaults (override SAM platform defaults)
defaults:
  agent: default          # Which .sam/agents/*.yaml to use by default
  hardware:
    size: medium          # small | medium | large
  workspace:
    profile: full         # full | lightweight

# Future: devcontainer defaults, branch naming patterns, etc.
```

### Config Schema: Agent Definition

```yaml
# .sam/agents/reviewer.yaml
version: 1

# Display metadata
name: Code Reviewer
description: Reviews PRs for correctness, security, and style

# Which coding agent binary to use (must be in AGENT_CATALOG)
agent: claude-code

# Model override (optional — uses agent default if omitted)
model: claude-sonnet-4-6

# System prompt — injected before the task description
prompt: |
  You are a senior code reviewer for this project.

  ## Your responsibilities:
  - Check for correctness, security vulnerabilities, and performance issues
  - Verify test coverage for changes
  - Ensure code follows project conventions

  ## Rules:
  - Always run existing tests before approving
  - Flag any TODO/FIXME additions without linked issues
  - Check for proper error handling at system boundaries

# Hardware requirements
hardware:
  size: medium
  # Future: explicit requirements
  # cpu: 4        # minimum vCPUs
  # ram: 8        # minimum GB RAM
  # storage: 50   # minimum GB disk

# Workspace configuration
workspace:
  profile: full
  # Future: devcontainer reference
  # devcontainer: .devcontainer/reviewer/devcontainer.json

# Environment variables to inject (non-secret, committed to repo)
env:
  REVIEW_MODE: strict
  MAX_FILE_CHANGES: "50"

# MCP servers to configure (future)
# mcp:
#   - name: linear
#     url: https://mcp.linear.app
```

### Why YAML?

- Human-readable and editable (agents will edit these too)
- Supports multi-line strings naturally (system prompts)
- Consistent with `.devcontainer/devcontainer.json` ecosystem conventions
- `.claude/` uses markdown; `.sam/` using YAML differentiates purpose
- YAML is the standard for infrastructure-as-code config (cloud-init, k8s, GitHub Actions)

### Alternative: JSON

```jsonc
// .sam/agents/reviewer.json
{
  "version": 1,
  "name": "Code Reviewer",
  "agent": "claude-code",
  "prompt": "You are a senior code reviewer...",
  "hardware": { "size": "medium" },
  "workspace": { "profile": "full" }
}
```

JSON is more precise but worse for multi-line prompts. Could support both formats with preference for YAML.

---

## 4. Config Precedence with Repo Config

The new precedence chain (highest to lowest priority):

```
1. Task submit parameters      (explicit override per task)
2. SAM Agent definition        (from .sam/agents/*.yaml in repo)
3. Project defaults            (from SAM UI / control plane DB)
4. Platform defaults           (env vars / hardcoded fallbacks)
```

### How It Works

1. User submits a task and selects "Code Reviewer" agent
2. SAM reads `.sam/agents/reviewer.yaml` from the repo (at the target branch HEAD)
3. Uses the agent definition's `agent`, `hardware`, `prompt`, etc.
4. Any explicit task submit overrides (e.g., `vmSize: large`) take precedence
5. Any fields not in the agent definition fall through to project/platform defaults

### The "System Prompt" Injection Point

Currently, the task runner constructs an initial prompt in `task-runner.ts:867`:

```typescript
const initialPrompt =
  `IMPORTANT: Before starting any work, you MUST call the \`get_instructions\` tool...` +
  `\n\n---\n\n${taskContent}`;
```

With SAM Agents, the prompt becomes:

```typescript
const initialPrompt = [
  samAgentSystemPrompt,           // From .sam/agents/*.yaml
  mcpInstructions,                // SAM MCP server instructions
  '---',
  taskContent,                    // User's task description
].filter(Boolean).join('\n\n');
```

The system prompt from the agent definition is **prepended** to the task, giving the agent persistent instructions/personality.

---

## 5. Reading Config from the Repo

### The Core Challenge

SAM needs to read `.sam/` files from the git repository **before** the workspace is created. The workspace creation flow is:

```
Task submit → Select node → Provision VM → Clone repo → Start agent
```

The repo is cloned **on the VM**, but agent selection and VM sizing happen **before** the VM exists.

### Approach A: GitHub API Read (Recommended for MVP)

Read `.sam/` files via GitHub's Contents API at task submission time:

```typescript
// At task submission, before workspace creation
const agentConfig = await readSamAgentFromRepo(
  githubToken,
  owner,
  repo,
  branch,
  agentName  // e.g., "reviewer"
);
```

**Pros:**
- Config available before VM provisioning (can influence VM size)
- No need to clone repo first
- Works with the existing GitHub App installation token
- Fast (single API call per file)

**Cons:**
- Requires GitHub API access (already available via installations)
- Rate limits (but SAM already makes GitHub API calls)
- File size limit (100KB via Contents API, 100MB via Blobs API — more than enough for config)

### Approach B: Cache in Control Plane (Recommended Addition)

Cache discovered agent definitions in the ProjectData DO after first read:

```
First task submit → Read from GitHub API → Cache in DO → Use cached
Subsequent submits → Use cached (with TTL or webhook invalidation)
```

**Invalidation strategies:**
1. **TTL-based** — Re-read from GitHub every N minutes (simple, slightly stale)
2. **Webhook-based** — GitHub push webhook triggers re-read (accurate, more complex)
3. **Manual refresh** — Button in UI to re-sync from repo (simple escape hatch)

A combination of TTL (5 min) + manual refresh is the simplest MVP.

### Approach C: VM Agent Reads at Clone Time (Deferred)

After the repo is cloned on the VM, the VM agent reads `.sam/` and reports config back. This is too late for VM sizing but could be used for runtime config (system prompt, env vars, MCP servers).

Could work as a **second pass** — VM agent reads `.sam/` after clone and adjusts the agent session configuration before starting the agent binary.

---

## 6. Complications & Design Decisions

### 6.1 When Does SAM Read the Config?

| Timing | Can influence VM size? | Can influence agent type? | Can influence prompt? | Complexity |
|--------|----------------------|--------------------------|----------------------|------------|
| At task submit (GitHub API) | Yes | Yes | Yes | Low |
| At workspace ready (VM agent) | No (VM already provisioned) | Risky (binary may not be installed) | Yes | Medium |
| Both (two-pass) | Yes (first pass) | Yes (first pass) | Yes (refined in second pass) | High |

**Recommendation:** GitHub API read at task submit time for MVP. This covers the most important use case (agent selection + VM sizing + system prompt) with minimal complexity.

### 6.2 Agent Type vs. Agent Config

Important distinction:
- **Agent type** (`claude-code`, `openai-codex`) = which binary to run. These come from `AGENT_CATALOG` and require platform support (install command, ACP command, etc.)
- **SAM Agent** (`reviewer`, `implementer`) = a named configuration that *references* an agent type plus prompt, hardware, etc.

A SAM Agent is NOT a new agent type — it's a **profile** that configures an existing agent type.

### 6.3 Secrets in `.sam/` Config

The `.sam/` directory is committed to git. It MUST NOT contain secrets. For secret env vars, users should continue using the existing Project Runtime Config (encrypted in DB):

```yaml
# .sam/agents/reviewer.yaml
env:
  REVIEW_MODE: strict      # OK — not a secret
  # NEVER put API keys here — use SAM Settings > Runtime Config
```

The UI should clearly separate "repo config" (non-secret, version-controlled) from "runtime secrets" (encrypted in DB).

### 6.4 Devcontainer Integration (Future)

The `workspace.devcontainer` field could reference a custom devcontainer config:

```yaml
workspace:
  devcontainer: .devcontainer/ml/devcontainer.json
```

This would let different agents use different development environments (e.g., a Python ML agent needs different tooling than a TypeScript API agent). This is a natural extension but adds significant complexity — defer to a later phase.

### 6.5 UI for Agent Management

Users need to:
1. **Browse** available SAM Agents (read from repo `.sam/agents/`)
2. **Select** an agent when submitting a task (dropdown replacing current agent type selector)
3. **Preview** agent config (view prompt, hardware, etc.)
4. **Override** specific fields per-task (e.g., "use reviewer but on a large VM")
5. **Create/edit** agents (could open a PR to add/modify `.sam/agents/*.yaml`)

The task submit form currently has `agentType` and `vmSize` dropdowns. With SAM Agents, this becomes:
- **Agent selector** dropdown showing named agents from `.sam/agents/`
- **Advanced overrides** (collapsed by default) for VM size, workspace profile, etc.

### 6.6 What If No `.sam/` Directory Exists?

Fall back to current behavior — project defaults from DB, then platform defaults. The `.sam/` directory is optional and additive.

### 6.7 Branch-Specific Configs

Different branches could have different `.sam/` configs. When reading config via GitHub API, read from the **target branch** of the task. This naturally supports experimental agent configs on feature branches.

---

## 7. Data Model Changes

### New Types (`packages/shared/src/types.ts`)

```typescript
/** A user-defined agent configuration from .sam/agents/*.yaml */
export interface SamAgent {
  /** Filename without extension (e.g., 'reviewer' from reviewer.yaml) */
  slug: string;
  /** Display name */
  name: string;
  /** Optional description */
  description?: string;
  /** Which agent binary to use (must be valid AgentType) */
  agentType: AgentType;
  /** Model override */
  model?: string;
  /** System prompt prepended to task descriptions */
  prompt?: string;
  /** Hardware requirements */
  hardware?: {
    size?: VMSize;
    // Future: cpu?: number; ram?: number;
  };
  /** Workspace configuration */
  workspace?: {
    profile?: WorkspaceProfile;
    // Future: devcontainer?: string;
  };
  /** Non-secret environment variables */
  env?: Record<string, string>;
}

/** Project-level SAM configuration from .sam/config.yaml */
export interface SamProjectConfig {
  version: number;
  defaults?: {
    agent?: string;  // slug of default agent
    hardware?: { size?: VMSize };
    workspace?: { profile?: WorkspaceProfile };
  };
}
```

### Schema Changes

```typescript
// Add to SubmitTaskRequest
export interface SubmitTaskRequest {
  message: string;
  samAgent?: string;         // NEW: slug of .sam/agents/*.yaml to use
  vmSize?: VMSize;           // existing (becomes override)
  agentType?: string;        // existing (becomes override)
  workspaceProfile?: WorkspaceProfile; // existing (becomes override)
  // ...
}
```

### DO Storage (ProjectData)

Cache discovered SAM Agents in the ProjectData DO:

```sql
CREATE TABLE sam_agents (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  config_json TEXT NOT NULL,     -- Full parsed YAML as JSON
  source_branch TEXT NOT NULL,
  source_sha TEXT,               -- Git SHA when last read
  last_synced_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

---

## 8. Implementation Phases

### Phase 1: Core Infrastructure (MVP)
1. Define `SamAgent` and `SamProjectConfig` types in `packages/shared`
2. Add YAML parser dependency (e.g., `yaml` npm package — already used in cloud-init)
3. Build GitHub API reader for `.sam/` directory contents
4. Add `samAgent` field to `SubmitTaskRequest`
5. Modify task runner to resolve SAM Agent config and build initial prompt with system prompt
6. Cache SAM Agent definitions in ProjectData DO
7. Add API endpoint: `GET /api/projects/:id/sam-agents` (returns cached agent list)

### Phase 2: UI Integration
1. Agent selector dropdown in task submit form (replaces raw agent type picker)
2. Agent preview panel (shows prompt, hardware, etc.)
3. "Sync from repo" button to refresh cached agents
4. Advanced overrides section (VM size, agent type override, etc.)

### Phase 3: Agent Management
1. Create/edit agents from UI (opens PR to modify `.sam/agents/`)
2. Agent templates gallery (starter configs for common patterns)
3. Agent versioning awareness (show diff when repo config changes)

### Phase 4: Advanced Features
1. Custom devcontainer references per agent
2. Explicit hardware requirements (CPU/RAM minimums)
3. MCP server configuration per agent
4. Agent composition (one agent can extend another)
5. Workspace-scoped `.sam/` overrides (`.sam/agents/local-reviewer.yaml` not committed)

---

## 9. Analogous Systems (Prior Art)

| System | Config Location | Format | Notes |
|--------|----------------|--------|-------|
| GitHub Actions | `.github/workflows/` | YAML | Defines CI/CD pipelines in repo |
| Devcontainers | `.devcontainer/` | JSON | Defines dev environments in repo |
| Claude Code | `.claude/` | Markdown | Agent instructions in repo |
| Cursor | `.cursor/` | JSON/MD | Editor AI config in repo |
| Windsurf | `.windsurf/` | Various | AI config in repo |
| Terraform | `*.tf` | HCL | Infrastructure as code |
| Docker Compose | `docker-compose.yml` | YAML | Service definitions in repo |

The pattern of "configuration as code in the repo" is well-established. SAM Agents follow this pattern naturally.

---

## 10. Open Questions

1. **Should SAM Agents be scoped to a project or a repo?** Current design: scoped to the repo (`.sam/` lives in git). A project is 1:1 with a repo, so this is effectively the same thing today.

2. **Can users create SAM Agents from the UI without touching git?** Could support "control-plane-only" agents stored in the DB, but this defeats the repo-as-source-of-truth goal. Better to have the UI create PRs that add agent YAML files.

3. **What about private/user-specific agents?** Could support `.sam/agents/local/` (gitignored) for personal agent configs. Or store user-specific overrides in the control plane DB, keyed by `(userId, projectId, agentSlug)`.

4. **Should the system prompt be a separate file?** For very long prompts, could support:
   ```yaml
   prompt_file: .sam/prompts/reviewer.md  # Reference to separate file
   ```
   This keeps YAML files clean and lets prompts be full markdown documents.

5. **Validation strictness?** If `.sam/agents/foo.yaml` references `agent: claude-code` but the user has no Anthropic API key configured, should SAM:
   - (a) Reject at task submit time with a clear error
   - (b) Accept and fail at agent start time
   - Option (a) is better UX.

6. **How does this interact with agent settings (per-user)?** Current `agentSettings` table stores per-user, per-agent-type settings (model, permission mode, allowed tools). SAM Agent config could override some of these (model), while others remain user-scoped (permission mode, API keys).

---

## 11. Caching Strategy & Webhook Infrastructure

### Current Webhook State

The GitHub App is **already subscribed to `push` events** (`scripts/deploy/utils/github.ts:56`, `default_events: ['push', 'pull_request']`), and the webhook endpoint exists at `POST /api/github/webhook` (`apps/api/src/routes/github.ts:198`) with HMAC-SHA256 signature verification. However, the handler only processes `installation` and `repository` events today — push events arrive and are silently ignored.

**What's implemented:**
- Webhook endpoint with signature verification (`apps/api/src/services/github-app.ts:345-370`)
- `installation.created` / `installation.deleted` handlers
- `repository.renamed` / `repository.transferred` / `repository.deleted` handlers

**What's NOT implemented:**
- `push` event handler (subscribed but ignored)
- Any file-change detection logic

The infrastructure is ~80% there. Adding a push handler that checks for `.sam/` changes is straightforward.

### Caching Options

| Option | How it works | Pros | Cons |
|--------|-------------|------|------|
| **No cache (MVP)** | Read `.sam/agents/` from GitHub API on every task submit | Zero invalidation complexity; always fresh | ~200ms latency per submit; UI agent list needs separate fetch |
| **Short TTL + webhook** | Cache in DO with 5-10 min TTL; push webhook busts cache on `.sam/` changes | Fast UI; fresh on submit if webhook fires; bounded staleness | Moderate complexity; webhook could fail |
| **Aggressive cache + webhook only** | Cache until webhook says otherwise | Fastest reads | Stale if webhook fails or is delayed |

### Recommendation: Don't Cache the Critical Path

The cleanest approach for MVP:

1. **At task submit time** — always read fresh from GitHub API. It's a single API call (~200ms), users submit tasks infrequently, and correctness matters here. No cache invalidation needed on the critical path.

2. **For the UI agent list** (dropdown showing available agents) — cache in ProjectData DO with a short TTL (5-10 min). This makes the dropdown fast without stale data being a real problem.

3. **Add push webhook handler** as a fast-follow. When a push event arrives with changes in `.sam/`, invalidate the DO cache. The webhook plumbing exists — it's just adding a case to the existing handler:

```typescript
// In apps/api/src/routes/github.ts, add to webhook handler:
if (event === 'push') {
  const payload = body as PushEvent;
  const samFilesChanged = payload.commits.some(c =>
    [...c.added, ...c.modified, ...c.removed].some(f => f.startsWith('.sam/'))
  );
  if (samFilesChanged) {
    // Invalidate cached SAM agent definitions for the affected project
    const project = await findProjectByGithubRepoId(payload.repository.id);
    if (project) {
      await invalidateSamAgentCache(env, project.id);
    }
  }
}
```

This approach sidesteps the "cache invalidation is hard" problem entirely on the path that matters (task submission), while still giving good UX for the agent list dropdown.

---

## 12. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| GitHub API rate limits when reading config | Low | Medium | Cache in DO with TTL |
| Config parsing errors break task submission | Medium | High | Validate + fallback to defaults |
| Users put secrets in `.sam/` YAML | Medium | High | Warn in docs, lint in CI, never show raw config to other users |
| Config schema evolution / breaking changes | Low | Medium | Version field + migration logic |
| Complex precedence rules confuse users | Medium | Medium | Clear UI showing "effective config" with source attribution |

---

## 12. Recommendation

**Start with Phase 1** — the core infrastructure is straightforward and builds on existing patterns:

- The `AGENT_CATALOG` already defines what binaries SAM can run
- The task runner already has a config resolution chain
- GitHub API access is already available via installation tokens
- ProjectData DO already stores per-project data
- The initial prompt construction is a single code location (`task-runner.ts:867`)

The `.sam/` directory approach is the right call. It gives users version-controlled, repo-portable agent configurations while keeping the control plane as a cache/override layer. The complications (reading config before VM exists, secret handling, precedence rules) are all solvable with well-understood patterns.

The biggest value-add is the **system prompt** — letting users define persistent agent instructions that go beyond a single task description. This alone makes SAM Agents worth building.
