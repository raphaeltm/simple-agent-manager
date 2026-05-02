# SAM-Native Agent Harness: Integration Design

**Date:** 2026-05-02
**Status:** Design (Track D)
**Parent:** 01KQM8JT6CPHGS16Y91XJF67FS (SAM-native agent harness initiative)

## Overview

This document describes how the first-wave prototypes (Go harness, Sandbox SDK, AI Gateway multi-model) integrate into SAM's production architecture. It defines the runtime selection logic, data flow, feature flags, credential routing, model dispatch, tool execution, event streaming, and rollback procedures.

**Design principle:** Additive, not disruptive. No existing agent type (`claude-code`, `openai-codex`, `google-gemini`, `mistral-vibe`, `opencode`) is modified or removed. All new paths are behind explicit feature flags and admin gates.

---

## 1. Runtime Selection

SAM agents operate in three contexts. The harness deploys differently in each:

| Context | Runtime | Agent Loop | I/O Layer | Status |
|---------|---------|-----------|-----------|--------|
| **Workspace agents** (task execution) | Hetzner VM | Go harness binary (future) or external agent (current) | Direct filesystem via PTY | Existing: external agents. Future: Go harness as new `AgentType` |
| **Project-level agent** | CF Container via Sandbox SDK | TypeScript in ProjectAgent DO (Mastra) | `sandbox.exec()`, `sandbox.files.*` | First vertical slice (this design) |
| **Top-level SAM agent** | CF Container via Sandbox SDK | TypeScript in SamSession DO (Mastra) | `sandbox.exec()`, `sandbox.files.*` | Second slice (future) |
| **Local dev/testing** | Go harness CLI | Go harness binary | Direct filesystem | Prototype complete (`packages/harness/`) |

### Decision Logic (Runtime Resolution)

```
resolveRuntime(agentContext):
  if agentContext.type === 'workspace-task':
    → Use existing VM agent path (unchanged)
    → AgentType from profile/project/platform chain
    → Future: 'sam-harness' AgentType option

  if agentContext.type === 'project-agent':
    if SANDBOX_ENABLED !== 'true':
      → Fallback to GitHub API-only mode (current SamSession/ProjectAgent behavior)
    → Use Sandbox SDK for file/exec access
    → Agent loop stays in DO (Mastra + AI Gateway)

  if agentContext.type === 'sam-top-level':
    if SANDBOX_ENABLED !== 'true':
      → Fallback to GitHub API-only mode (current behavior)
    → Use Sandbox SDK for cross-project operations
    → Agent loop stays in DO (Mastra + AI Gateway)
```

**Code path:** Runtime resolution does not require a new function today — the existing `SamSession` and `ProjectAgent` DOs already have their own execution contexts. The Sandbox SDK is an *additional capability* injected into their tool implementations, not a separate runtime choice.

---

## 2. Data Flow

### Project Agent with Sandbox SDK (First Vertical Slice)

```
User message (project chat)
  → apps/api/src/routes/chat.ts
  → ProjectData DO: persistMessage()
  → ProjectAgent DO: handleMessage()
  │
  ├─ [Agent loop — Mastra in DO]
  │   1. Construct messages array (system prompt + history + user message)
  │   2. Call AI Gateway (model from project config or platform default)
  │   3. Receive tool_calls from model
  │   4. Execute tools:
  │       ├─ SAM MCP tools → existing MCP handler (knowledge, dispatch, etc.)
  │       └─ Coding tools (NEW) → Sandbox SDK
  │           ├─ sandbox.exec(command)        ← `apps/api/src/durable-objects/project-agent/tools/sandbox-exec.ts`
  │           ├─ sandbox.files.read(path)     ← `apps/api/src/durable-objects/project-agent/tools/sandbox-files.ts`
  │           ├─ sandbox.files.write(path, c) ← same
  │           └─ sandbox.exec('git', [...])   ← `apps/api/src/durable-objects/project-agent/tools/sandbox-git.ts`
  │   5. Feed tool results back to model
  │   6. Repeat until done or max turns
  │
  ├─ [Streaming output]
  │   → SSE to client via existing ProjectAgent streaming path
  │
  └─ [Sandbox lifecycle]
      → sandbox auto-sleeps after SANDBOX_SLEEP_AFTER (default: 10m)
      → Next request wakes it (warm start: ~48ms server / ~1s wall)
      → First request after long idle: cold start (~2.7s server / ~4.4s wall)
```

### Sandbox Instance Addressing

Each project gets its own sandbox instance, addressed by project ID:

```typescript
// In ProjectAgent DO
const sandboxId = `project-${this.projectId}`;
const sandbox = getSandbox(this.env.SANDBOX, sandboxId);
```

This ensures:
- Per-project isolation (different users' code never shares a container)
- Warm sandbox reuse across multiple tool calls in a single conversation
- No cross-project data leakage

---

## 3. Feature Flags

| Flag | Default | Purpose | Gate Level |
|------|---------|---------|------------|
| `SANDBOX_ENABLED` | `"false"` | Kill switch for ALL sandbox functionality | Platform |
| `HARNESS_AGENT_ENABLED` | `"false"` | Future: enables `sam-harness` as a workspace AgentType | Platform |

### Flag Resolution

```typescript
// In any DO or route handler:
function isSandboxEnabled(env: Env): boolean {
  return env.SANDBOX_ENABLED === 'true' && !!env.SANDBOX;
}
```

When disabled:
- ProjectAgent/SamSession tools that require sandbox gracefully degrade to GitHub API-only mode
- Admin sandbox routes return 400 "Sandbox prototype is disabled"
- No container instances are created
- Zero cost impact

---

## 4. Auth and Credential Flow

### AI Gateway Credentials (for LLM calls from DO agent loop)

```
ProjectAgent DO
  → resolveUpstreamAuth(env, 'project-agent')
  ��
  ├─ Workers AI models (@cf/*):
  │   Auth: env.AI binding (Workers AI native)
  │   No external credential needed
  │
  ├─ Unified API models (anthropic/*, openai/*):
  │   Auth: cf-aig-authorization header
  │   Token: env.CF_AIG_TOKEN ?? env.CF_API_TOKEN
  │   Billing: Cloudflare Unified Billing
  │
  └─ Fallback:
      Direct provider key from credential resolution
      (project → user → platform chain via getDecryptedAgentKey())
```

**Key insight:** The DO agent loop calls AI Gateway directly — it does NOT go through the AI proxy routes. The proxy routes are for workspace agents calling from VMs. DO agents use the gateway URL and headers directly.

### MCP Token (for sandbox-based agents calling SAM tools)

Not needed for the first vertical slice. The ProjectAgent DO already has direct access to SAM's internal services (knowledge, dispatch, policies) via its own bindings and context. MCP tokens are only needed when an *external* agent (running in a VM or container binary) needs to call back to SAM.

When the Go harness runs in a VM (future Phase 2), it will receive an MCP token via the existing `generateMCPToken()` path in TaskRunner DO.

### GitHub Token (for git operations in sandbox)

```typescript
// Resolve GitHub token for the project's installation
const token = await getInstallationToken(env, project.installationId);
const repoUrl = `https://x-access-token:${token}@github.com/${project.owner}/${project.repo}`;
await sandbox.exec('git', ['clone', '--depth=1', repoUrl, '/workspace']);
```

The installation token is short-lived (1 hour) and scoped to the specific repository. It's injected as a URL credential for git operations — never persisted in the sandbox filesystem.

---

## 5. Model Routing

### Model Selection for Project Agent

```
Model resolution chain:
  1. Project-level AI model override (future: project settings)
  2. Platform default for project agents
  3. Hardcoded fallback: Workers AI Qwen 2.5 Coder 32B (free, good tool calling)
```

### Routing Logic (existing infrastructure)

The `PlatformAIModel.unifiedApiModelId` field determines the API path:

```typescript
function resolveGatewayPath(model: PlatformAIModel): { url: string; authHeader: string } {
  if (model.unifiedApiModelId === null) {
    // Workers AI — use dedicated path
    return {
      url: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/v1/chat/completions`,
      authHeader: 'Authorization',  // Bearer CF_API_TOKEN
    };
  }
  // External provider — use Unified API
  return {
    url: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat/chat/completions`,
    authHeader: 'cf-aig-authorization',  // Bearer CF_AIG_TOKEN
  };
}
```

### Workers AI Workarounds (applied at call site)

When routing to Workers AI models:
1. Replace `content: null` with `content: ""` in assistant messages with `tool_calls`
2. Use `tool_choice: "required"` when structured tool calls are expected
3. Filter to models with `toolCallSupport >= 'good'` for agent loop use

These workarounds are applied in the model-call layer, not in calling code.

---

## 6. Tool Execution (Sandbox SDK)

### Tool Registry for Project Agent

The ProjectAgent DO will expose coding tools ONLY when `SANDBOX_ENABLED === 'true'`:

| Tool | Sandbox SDK Method | Description |
|------|-------------------|-------------|
| `sandbox_exec` | `sandbox.exec(cmd, opts)` | Run shell command, return stdout/stderr/exitCode |
| `sandbox_read_file` | `sandbox.files.read(path)` | Read file contents |
| `sandbox_write_file` | `sandbox.files.write(path, content)` | Create/overwrite file |
| `sandbox_list_files` | `sandbox.files.list(path)` | List directory contents |
| `sandbox_git_clone` | `sandbox.exec('git', ['clone', ...])` | Clone repository (via exec, not gitCheckout — more reliable) |

**Why `sandbox.exec('git clone ...')` instead of `sandbox.gitCheckout()`?**
Staging testing showed `gitCheckout()` fails with Internal Error on warm sandboxes when the target dir has existing content. Using `exec('git clone ...')` is more reliable and supports custom flags.

### Tool Definitions (OpenAI format for AI Gateway Unified API)

```typescript
const SANDBOX_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'sandbox_exec',
      description: 'Execute a shell command in the project sandbox. Returns stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
        },
        required: ['command'],
      },
    },
  },
  // ... other tools follow same pattern
];
```

### Security Constraints

1. **Timeout enforcement:** All `sandbox.exec()` calls have a configurable timeout (`SANDBOX_EXEC_TIMEOUT_MS`, default: 30s)
2. **No network escalation:** Sandbox containers have HTTP-only networking — no raw TCP/UDP
3. **Per-project isolation:** Each project gets its own sandbox instance (no shared containers)
4. **Admin-only initially:** All sandbox-backed features gated behind `requireSuperadmin()` until stabilized
5. **No credential persistence:** GitHub tokens used for clone are URL-embedded, not written to disk

---

## 7. Event Streaming

### Existing Path (Unchanged)

ProjectAgent DO already streams responses to the client via the existing chat SSE mechanism. The sandbox tools are just new tool implementations within the existing agent loop — they don't require a separate streaming path.

```
ProjectAgent DO agent loop
  → tool_call: sandbox_exec
  → execute sandbox.exec()
  → tool_result: { stdout, stderr, exitCode }
  → feed back to model
  → model generates text response
  → stream text to client via existing SSE
```

### Sandbox Exec Streaming (Future Enhancement)

For long-running commands, `sandbox.execStream()` could be used to stream output in real-time. This is NOT in the first vertical slice but the infrastructure exists (tested in admin prototype at `GET /api/admin/sandbox/exec-stream`).

---

## 8. Rollback

### Kill Switch Behavior

Setting `SANDBOX_ENABLED = "false"` (or removing the var) immediately:
1. Disables all admin sandbox routes (return 400)
2. Disables sandbox-backed coding tools in ProjectAgent/SamSession
3. Agents fall back to GitHub API-only mode for code access
4. No container instances created, no cost
5. Zero impact on workspace agents (VM-based, completely separate path)

### Granular Disablement

If a specific sandbox operation causes issues:
- `SANDBOX_EXEC_TIMEOUT_MS` can be reduced to fail-fast on slow commands
- `max_instances = 3` cap in wrangler.toml prevents container sprawl
- Individual tool implementations can be disabled by removing them from the tool registry

### Rollback Procedure

1. Set `SANDBOX_ENABLED = "false"` in Cloudflare Worker secrets (takes effect immediately, no redeploy)
2. Verify via `GET /api/admin/sandbox/status` → `{ enabled: false }`
3. Existing containers will sleep after their idle timeout and incur no further cost

---

## 9. Backup/Restore Exclusion

### Why Backup/Restore Is Excluded

The Sandbox SDK's `createBackup()` and `restoreBackup()` APIs **failed with Internal Error** during staging testing (2026-05-02). This is a beta limitation of the Sandbox SDK — the feature exists in the API but is not reliable on the current infrastructure.

### Impact

Without backup/restore:
- Sandbox filesystem is ephemeral — data is lost when the container sleeps or restarts
- Git repos must be re-cloned on each cold start (~742ms-1.3s for typical projects)
- This is acceptable for the first vertical slice because:
  - Project agents are used for analysis/planning, not long-running development
  - Cold starts are infrequent (10-minute idle timeout keeps containers warm during active use)
  - Re-cloning is fast with shallow depth (`--depth=1`)

### When to Revisit

Re-evaluate backup/restore when:
1. Cloudflare stabilizes the API (check `@cloudflare/sandbox` release notes)
2. A use case emerges where clone latency on cold start is unacceptable
3. Stateful agent sessions (e.g., project agent maintaining work-in-progress across days) become a requirement

### Alternative Persistence Strategies (For Future Evaluation)

| Strategy | Tradeoff |
|----------|----------|
| R2 FUSE mount | Persistent but slower I/O than local filesystem |
| Git push on save | Durable but requires branch management |
| Shallow re-clone on wake | Fast (742ms) but loses uncommitted state |
| Tarball to R2 + restore on wake | Custom implementation, but under our control |

---

## 10. Centralized Agent/Model/Runtime Configuration

### Existing Configuration Registry

The model registry at `packages/shared/src/constants/ai-services.ts` (`PLATFORM_AI_MODELS`) is the single source of truth for model metadata. It already includes:
- `toolCallSupport` — agent loop suitability
- `intendedRole` — which SAM context the model is designed for
- `allowedScopes` — where users can select it
- `unifiedApiModelId` — routing path determination

### Configuration Resolution for Sandbox-Based Agents

```typescript
interface SandboxAgentConfig {
  /** Model to use for the agent loop. Resolved from project/platform config. */
  modelId: string;
  /** Sandbox instance addressing. Derived from project ID. */
  sandboxId: string;
  /** Maximum turns before the agent loop terminates. */
  maxTurns: number;
  /** Exec timeout per tool call. From SANDBOX_EXEC_TIMEOUT_MS. */
  execTimeoutMs: number;
  /** Git timeout. From SANDBOX_GIT_TIMEOUT_MS. */
  gitTimeoutMs: number;
  /** Repository URL for initial clone. Derived from project. */
  repoUrl: string;
  /** Branch to clone. From project.defaultBranch. */
  branch: string;
}

function resolveSandboxAgentConfig(env: Env, project: Project): SandboxAgentConfig {
  return {
    modelId: project.defaultAiModel || env.SANDBOX_DEFAULT_MODEL || '@cf/qwen/qwen2.5-coder-32b-instruct',
    sandboxId: `project-${project.id}`,
    maxTurns: parseInt(env.SANDBOX_AGENT_MAX_TURNS || '20', 10),
    execTimeoutMs: parseInt(env.SANDBOX_EXEC_TIMEOUT_MS || '30000', 10),
    gitTimeoutMs: parseInt(env.SANDBOX_GIT_TIMEOUT_MS || '120000', 10),
    repoUrl: `https://github.com/${project.owner}/${project.repo}`,
    branch: project.defaultBranch || 'main',
  };
}
```

All configuration is centralized in env vars with sensible defaults — no scattered provider/model fields.

---

## 11. Relationship to Existing Architecture

### What This Design Does NOT Change

| Component | Impact |
|-----------|--------|
| `packages/vm-agent/` | Zero changes. VM agents continue working as-is |
| `AgentType` union | Not extended in this slice. `sam-harness` is future work |
| TaskRunner DO | No changes. Task execution uses existing VM path |
| ACP protocol | Not involved. Sandbox agents don't use ACP |
| Credential resolution | Not changed. Sandbox agents use AI Gateway directly |
| Agent profiles | Not changed. Profile → model resolution is future work |
| User-facing UI | No changes in this slice (admin-only) |

### What This Design Adds

| Component | Addition |
|-----------|----------|
| `ProjectAgent` DO | New sandbox-backed tool implementations (gated) |
| `docs/architecture/` | This design document |
| `packages/shared/` | `SandboxAgentConfig` type, utility for model capability filtering |
| Environment | `HARNESS_AGENT_ENABLED`, `SANDBOX_DEFAULT_MODEL`, `SANDBOX_AGENT_MAX_TURNS` env vars |

---

## 12. First Vertical Slice Definition

**Scope:** ProjectAgent DO gains sandbox-backed coding tools behind `SANDBOX_ENABLED`.

**What ships:**
1. This integration design document
2. `filterModelsForAgentLoop()` utility in shared package (filters by `toolCallSupport >= 'good'`)
3. `SandboxAgentConfig` interface in shared types

**What does NOT ship yet:**
- Actual sandbox tool implementations in ProjectAgent DO (Phase 2 of rollout)
- Go harness as VM agent type (Phase 2 of action plan)
- UI for model selection (future)
- SamSession sandbox integration (Phase 3)

**Why this scope:** The design document is the critical output for Track E's go/no-go decision. The utility function validates a non-trivial piece of model routing logic and proves the model registry metadata is usable. Actual tool wiring requires more work and should be a separate tracked task.

---

## 13. Configurable Environment Variables (New)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SANDBOX_ENABLED` | `"false"` | Kill switch for all sandbox functionality |
| `SANDBOX_EXEC_TIMEOUT_MS` | `30000` | Per-command execution timeout |
| `SANDBOX_GIT_TIMEOUT_MS` | `120000` | Git clone timeout |
| `SANDBOX_SLEEP_AFTER` | `"10m"` | Container idle timeout before sleep |
| `SANDBOX_DEFAULT_MODEL` | `"@cf/qwen/qwen2.5-coder-32b-instruct"` | Default LLM for sandbox agent loops |
| `SANDBOX_AGENT_MAX_TURNS` | `20` | Max think→act→observe cycles per invocation |
| `HARNESS_AGENT_ENABLED` | `"false"` | Future: enables `sam-harness` workspace AgentType |

All follow Constitution Principle XI (no hardcoded values).

---

## Mermaid: High-Level Architecture

```mermaid
graph TB
    subgraph "User Interface"
        PC[Project Chat]
    end

    subgraph "Cloudflare Workers"
        API[API Worker]
        PA[ProjectAgent DO]
        SS[SamSession DO]
    end

    subgraph "Cloudflare Containers"
        SB1[Sandbox: project-abc]
        SB2[Sandbox: project-xyz]
    end

    subgraph "AI Gateway"
        UAP[Unified API Path]
        WAI[Workers AI Path]
    end

    subgraph "Existing VM Infrastructure"
        VM[Hetzner VM + VM Agent]
        CC[Claude Code / Codex / etc.]
    end

    PC --> API --> PA
    PA -->|"sandbox.exec()"| SB1
    PA -->|"sandbox.files.*"| SB1
    PA -->|"LLM call"| UAP
    PA -->|"LLM call"| WAI

    SS -->|"sandbox.exec()"| SB2
    SS -->|"LLM call"| UAP

    API -->|"Task execution (unchanged)"| VM --> CC

    style SB1 fill:#e1f5fe
    style SB2 fill:#e1f5fe
    style VM fill:#f3e5f5
```

---

## Next Steps (For Track E Go/No-Go)

1. **Evaluate this design** against SAM's roadmap and priorities
2. **Decide Phase 2 scope:** Wire sandbox tools into ProjectAgent DO
3. **Decide model selection:** Keep Workers AI default or configure Unified Billing for frontier models
4. **Monitor Sandbox SDK stability:** Watch for backup/restore fixes in SDK releases
5. **Plan Go harness VM integration:** Separate track, can run in parallel
